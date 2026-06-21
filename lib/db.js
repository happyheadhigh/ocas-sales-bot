'use strict';

const { Pool } = require('pg');
const fs       = require('fs');
const {
  SERVER_FILE, ALERTS_FILE,
  ERROR_WEBHOOK_URL, BOT_ENV,
} = require('./constants');

// ── PostgreSQL pool ───────────────────────────────────────────────────────────
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
  max: 5,                           // fewer slots — prevents burn poller starving commands
  idleTimeoutMillis: 30000,          // 30s — keeps connections alive through Railway proxy idle drops
  connectionTimeoutMillis: 4000,    // fail fast if pool is exhausted — don't hold Discord open
  // Per-context timeouts used instead (pgQueryCommand/pgQueryPoller)
  keepAlive: true,                  // TCP keepalive — prevents Railway proxy from silently dropping
  keepAliveInitialDelayMillis: 10000,
});

pgPool.on('error', e => {
  console.error('[PG bot]', e.message);
  // sendErrorWebhook imported lazily to avoid circular dep
  try{ require('./error').sendErrorWebhook('DB Pool Error', e); }catch(_){}
});


// Discord command queries — must finish within 3s or interaction expires
async function pgQueryCommand(sql, params){
  return pgPool.query({ text: sql, values: params, query_timeout: 3000 });
}

// Burn poller queries — longer window, not Discord time-critical
async function pgQueryPoller(sql, params){
  return pgPool.query({ text: sql, values: params, query_timeout: 20000 });
}

async function runMigrations(){
  const q = sql => pgPool.query(sql).catch(() => {});
  await q(`CREATE TABLE IF NOT EXISTS user_registrations (
    discord_id   TEXT NOT NULL,
    guild_id     TEXT NOT NULL DEFAULT 'global',
    wallet       TEXT,
    verified     BOOLEAN DEFAULT false,
    verified_at  TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (discord_id, guild_id)
  )`);
  // Migrate old single-column PK to composite PK if needed
  await q(`ALTER TABLE user_registrations ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT 'global'`).catch(()=>{});
  await q(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='user_registrations' AND constraint_type='PRIMARY KEY'
          AND constraint_name='user_registrations_pkey'
      ) THEN
        ALTER TABLE user_registrations DROP CONSTRAINT IF EXISTS user_registrations_pkey;
        ALTER TABLE user_registrations ADD PRIMARY KEY (discord_id, guild_id);
      END IF;
    END $$`).catch(()=>{});
  // Only recreate PK if it doesn't already cover both columns
  await q(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'user_registrations'::regclass AND i.indisprimary
          AND a.attname = 'guild_id'
      ) THEN
        ALTER TABLE user_registrations DROP CONSTRAINT IF EXISTS user_registrations_pkey;
        ALTER TABLE user_registrations ADD CONSTRAINT user_registrations_pkey PRIMARY KEY (discord_id, guild_id);
      END IF;
    END $$`).catch(()=>{});
  // Drop stale wallet unique constraint if it exists — wallet is not globally unique (same wallet can appear in multiple guild rows)
  await q(`ALTER TABLE user_registrations DROP CONSTRAINT IF EXISTS user_registrations_wallet_key`).catch(()=>{});

  await q(`CREATE TABLE IF NOT EXISTS collection_traits (
    slug         TEXT NOT NULL,
    trait_name   TEXT NOT NULL,
    trait_value  TEXT NOT NULL,
    token_count  INTEGER DEFAULT 0,
    PRIMARY KEY (slug, trait_name, trait_value)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS verification_codes (
    discord_id  TEXT NOT NULL,
    guild_id    TEXT NOT NULL DEFAULT 'global',
    wallet      TEXT,
    code        TEXT,
    expires_at  TIMESTAMPTZ,
    PRIMARY KEY (discord_id, guild_id)
  )`);
  await q(`ALTER TABLE user_registrations ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT 'global'`);

  await q(`CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS server_configs (guild_id TEXT PRIMARY KEY, config JSONB NOT NULL DEFAULT '{}')`);
  await q(`CREATE TABLE IF NOT EXISTS user_alert_configs (user_id TEXT NOT NULL, guild_id TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}', PRIMARY KEY(user_id,guild_id))`);
  await q(`CREATE TABLE IF NOT EXISTS verification_panels (
    guild_id     TEXT PRIMARY KEY,
    channel_id   TEXT,
    role_id      TEXT,
    holder_role_id TEXT,
    min_tokens   INTEGER DEFAULT 0,
    message_id   TEXT,
    welcome_text TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  `);
  await q(`ALTER TABLE verification_panels ADD COLUMN IF NOT EXISTS holder_role_id TEXT`);
  await q(`CREATE TABLE IF NOT EXISTS trait_roles (
    id             SERIAL PRIMARY KEY,
    guild_id       TEXT NOT NULL,
    trait_type     TEXT NOT NULL,
    trait_value    TEXT,
    role_id        TEXT NOT NULL,
    minimum_count  INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ DEFAULT NOW()
  )`);
  // Make trait_value nullable if it was NOT NULL before
  await q(`ALTER TABLE trait_roles ALTER COLUMN trait_value DROP NOT NULL`).catch(()=>{});
  // Drop old unique constraint and recreate with COALESCE-friendly version
  await q(`ALTER TABLE trait_roles DROP CONSTRAINT IF EXISTS trait_roles_guild_id_trait_type_trait_value_role_id_minimu_key`).catch(()=>{});
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS trait_roles_unique ON trait_roles (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count)`).catch(()=>{});
  await q(`ALTER TABLE trait_roles ADD COLUMN IF NOT EXISTS minimum_count INTEGER NOT NULL DEFAULT 1`);
  // collection_slug scopes a rule to a specific collection; NULL means it applies to the guild's primary collection
  await q(`ALTER TABLE trait_roles ADD COLUMN IF NOT EXISTS collection_slug TEXT`);
  // Migrate old verification_codes to guild_id format if needed
  await q(`ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT 'global'`);
  // Migrate primary key from (discord_id) to (discord_id, guild_id) if needed
  await q(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='verification_codes' AND constraint_type='PRIMARY KEY'
        AND constraint_name NOT LIKE '%discord_id%guild_id%'
      ) THEN
        ALTER TABLE verification_codes DROP CONSTRAINT IF EXISTS verification_codes_pkey;
        ALTER TABLE verification_codes ADD PRIMARY KEY (discord_id, guild_id);
      END IF;
    END $$`).catch(()=>{});
  // Ensure PK covers both columns regardless
  await q(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'verification_codes'::regclass AND i.indisprimary
          AND a.attname = 'guild_id'
      ) THEN
        ALTER TABLE verification_codes DROP CONSTRAINT IF EXISTS verification_codes_pkey;
        ALTER TABLE verification_codes ADD CONSTRAINT verification_codes_pkey PRIMARY KEY (discord_id, guild_id);
      END IF;
    END $$`).catch(()=>{});
  await q(`CREATE TABLE IF NOT EXISTS sales (id SERIAL PRIMARY KEY, token_id INT, sale_price NUMERIC, sale_ts TIMESTAMPTZ, tx_hash TEXT, buyer TEXT, seller TEXT, collection_slug TEXT, UNIQUE(tx_hash, token_id))`);
  // CREATE TABLE IF NOT EXISTS above silently does nothing for the
  // collection_slug column on a table that already existed in an older
  // shape — that's exactly what happened here in production (discovered
  // via migrations/004). Explicit ALTER below ensures it actually gets
  // added on any deploy where the table predates this column.
  await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS collection_slug TEXT DEFAULT 'on-chain-all-stars'`);
  await q(`UPDATE sales SET collection_slug = 'on-chain-all-stars' WHERE collection_slug IS NULL`).catch(()=>{});
  await q(`CREATE TABLE IF NOT EXISTS listings (token_id INT, list_price NUMERIC, list_ts TIMESTAMPTZ, order_hash TEXT, collection_slug TEXT, UNIQUE(token_id, collection_slug))`);
  await q(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS collection_slug TEXT DEFAULT 'on-chain-all-stars'`);
  await q(`UPDATE listings SET collection_slug = 'on-chain-all-stars' WHERE collection_slug IS NULL`).catch(()=>{});
  await q(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await q(`CREATE TABLE IF NOT EXISTS burn_events (id SERIAL PRIMARY KEY, tx_hash TEXT UNIQUE, block_number BIGINT, burned_token_id INT, survivor_token_id INT, burn_type TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`ALTER TABLE burn_events ADD COLUMN IF NOT EXISTS survivor_token_id INT`);
  await q(`ALTER TABLE burn_events ADD COLUMN IF NOT EXISTS burn_type TEXT`);
  await q(`ALTER TABLE burn_events DROP CONSTRAINT IF EXISTS burn_events_tx_hash_key`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS burn_events_tx_hash_idx ON burn_events(tx_hash)`);
  await q(`CREATE TABLE IF NOT EXISTS burn_event_inputs (id SERIAL PRIMARY KEY, burn_event_id INT REFERENCES burn_events(id), burned_token_id INT, UNIQUE(burn_event_id,burned_token_id))`);
  await q(`CREATE TABLE IF NOT EXISTS burn_alert_posts (id SERIAL PRIMARY KEY, tx_hash TEXT, log_index INT, channel_id TEXT, posted_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(tx_hash,log_index,channel_id))`);
  await q(`CREATE TABLE IF NOT EXISTS token_traits (token_id INT NOT NULL, trait_name TEXT NOT NULL, trait_value TEXT, trait_index INT NOT NULL DEFAULT 0, source TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY(token_id,trait_index), UNIQUE(token_id,trait_index))`);
  await q(`CREATE TABLE IF NOT EXISTS token_image_snapshots (token_id INT PRIMARY KEY, image_url TEXT, image_source TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS token_original_snapshots (token_id INT PRIMARY KEY, image_url TEXT, image_source TEXT, captured_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS burn_state_snapshots (id SERIAL PRIMARY KEY, burn_event_id INT REFERENCES burn_events(id), snapshot_type TEXT, token_id INT, image_url TEXT, image_source TEXT, metadata JSONB, captured_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS burn_lotteries (id SERIAL PRIMARY KEY, guild_id TEXT, channel_id TEXT, created_by TEXT, title TEXT, prize TEXT, mode TEXT DEFAULT 'wallet', start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, seed TEXT, status TEXT DEFAULT 'active', winner_wallet TEXT, qualified_wallets INT, total_burns INT, result_json JSONB, timezone TEXT, completed_at TIMESTAMPTZ, message_id TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS generic_lotteries (id SERIAL PRIMARY KEY, guild_id TEXT, channel_id TEXT, created_by TEXT, title TEXT, type TEXT DEFAULT 'giveaway', start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, seed TEXT, status TEXT DEFAULT 'active', winner_display TEXT, min_number INT, max_number INT, winning_number INT, result_json JSONB, timezone TEXT, completed_at TIMESTAMPTZ, message_id TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS generic_lottery_entries (id SERIAL PRIMARY KEY, lottery_id INT REFERENCES generic_lotteries(id), user_id TEXT, username TEXT, guess_number INT, entered_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(lottery_id,user_id))`);
  await q(`ALTER TABLE generic_lotteries ADD COLUMN IF NOT EXISTS message_id TEXT`);
  await q(`CREATE TABLE IF NOT EXISTS tokens (id INT PRIMARY KEY, os_rank INT, tv_rank INT, updated_at TIMESTAMPTZ DEFAULT NOW())`);

  console.log('[DB] Migrations complete');
}

// ── Persistence helpers (bot_state table) ────────────────────────────────────
async function dbLoad(key){
  try{
    const r = await pgPool.query('SELECT value FROM bot_state WHERE key=$1', [key]);
    if(r.rows.length) return JSON.parse(r.rows[0].value);
  }catch(e){ console.error(`[dbLoad] ${key} failed:`, e.message); }
  // Fallback to JSON file
  try{
    const file = key === 'server_configs' ? SERVER_FILE : ALERTS_FILE;
    if(fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }catch(_){}
  return null;
}

async function dbSave(key, value){
  try{
    await pgPool.query(
      `INSERT INTO bot_state(key,value) VALUES($1,$2)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
      [key, typeof value === 'string' ? value : JSON.stringify(value)]
    );
  }catch(e){
    console.warn('[dbSave]', e.message);
  }
}

// ── Config helpers ────────────────────────────────────────────────────────────
let _serverConfigs = {};
let _userAlerts    = {};

async function loadAllConfigs(){
  // Load server configs from server_configs table (primary source)
  try{
    const rows = await pgPool.query('SELECT guild_id, config FROM server_configs');
    for(const row of rows.rows){
      _serverConfigs[row.guild_id] = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    }
  }catch(e){
    console.warn('[loadAllConfigs] DB read failed, falling back to bot_state:', e.message);
    let db = await dbLoad('server_configs');
    if(db) _serverConfigs = (typeof db === 'string') ? JSON.parse(db) : db;
  }
  // Load user alerts from bot_state
  let ua = await dbLoad('user_alerts');
  if(ua){
    _userAlerts = (typeof ua === 'string') ? JSON.parse(ua) : ua;
  }
}

function getConfig(guildId){ return _serverConfigs[guildId] || {}; }

function getAllConfigs(){ return Object.entries(_serverConfigs); }

async function setConfig(guildId, cfg){
  // Always merge with existing DB config to prevent partial overwrites
  // This protects against memory loading incomplete config then saving it
  try{
    const existing = await pgPool.query({
      text: 'SELECT config FROM server_configs WHERE guild_id=$1',
      values: [guildId],
      query_timeout: 3000
    });
    if(existing.rows.length){
      const dbCfg = typeof existing.rows[0].config === 'string'
        ? JSON.parse(existing.rows[0].config)
        : (existing.rows[0].config || {});
      // Merge: incoming cfg takes priority but preserves DB keys not in cfg
      cfg = { ...dbCfg, ...cfg };
    }
  }catch(e){ console.warn('[setConfig] merge fetch failed:', e.message); }

  _serverConfigs[guildId] = cfg;
  // Persist to DB
  try{
    await pgPool.query(
      `INSERT INTO server_configs(guild_id,config) VALUES($1,$2)
       ON CONFLICT(guild_id) DO UPDATE SET config=EXCLUDED.config`,
      [guildId, JSON.stringify(cfg)]
    );
  }catch(e){
    console.warn('[setConfig]', e.message);
    await dbSave('server_configs', _serverConfigs);
  }
}

function getUserAlerts(){ return _userAlerts; }

async function setUserAlerts(alerts){
  _userAlerts = alerts;
  await dbSave('user_alerts', alerts);
}

// ── Sale cursor ───────────────────────────────────────────────────────────────
let _saleCursor = null;

async function loadSaleCursor(){
  const v = await dbLoad('last_sale_ts');
  _saleCursor = v || null;
  return _saleCursor;
}

async function saveSaleCursor(ts){
  _saleCursor = ts;
  await dbSave('last_sale_ts', ts);
}

function getSaleCursor(){ return _saleCursor; }

module.exports = {
  pgPool, pgQueryCommand, pgQueryPoller,
  runMigrations,
  dbLoad, dbSave,
  loadAllConfigs, getConfig, setConfig, getAllConfigs,
  getUserAlerts, setUserAlerts,
  loadSaleCursor, saveSaleCursor, getSaleCursor,
};








