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
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pgPool.on('error', e => {
  console.error('[PG bot]', e.message);
  // sendErrorWebhook imported lazily to avoid circular dep
  try{ require('./error').sendErrorWebhook('DB Pool Error', e); }catch(_){}
});

// ── Schema migrations (run on boot) ──────────────────────────────────────────
async function runMigrations(){
  const q = sql => pgPool.query(sql).catch(() => {});

  await q(`CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS server_configs (guild_id TEXT PRIMARY KEY, config JSONB NOT NULL DEFAULT '{}')`);
  await q(`CREATE TABLE IF NOT EXISTS user_alert_configs (user_id TEXT NOT NULL, guild_id TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}', PRIMARY KEY(user_id,guild_id))`);
  await q(`CREATE TABLE IF NOT EXISTS sales (id SERIAL PRIMARY KEY, token_id INT, sale_price NUMERIC, sale_ts TIMESTAMPTZ, tx_hash TEXT, buyer TEXT, seller TEXT, collection_slug TEXT, UNIQUE(tx_hash, token_id))`);
  await q(`CREATE TABLE IF NOT EXISTS listings (token_id INT, list_price NUMERIC, list_ts TIMESTAMPTZ, order_hash TEXT, collection_slug TEXT, UNIQUE(token_id, collection_slug))`);
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
    if(r.rows.length) return r.rows[0].value;
  }catch(_){}
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
  let db = await dbLoad('server_configs');
  if(db){
    try{ _serverConfigs = JSON.parse(db); }catch(_){}
  }
  let ua = await dbLoad('user_alerts');
  if(ua){
    try{ _userAlerts = JSON.parse(ua); }catch(_){}
  }
}

function getConfig(guildId){ return _serverConfigs[guildId] || {}; }

async function setConfig(guildId, cfg){
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
  pgPool,
  runMigrations,
  dbLoad, dbSave,
  loadAllConfigs, getConfig, setConfig,
  getUserAlerts, setUserAlerts,
  loadSaleCursor, saveSaleCursor, getSaleCursor,
};
