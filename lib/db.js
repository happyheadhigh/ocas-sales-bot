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
  max: 8,                            // slightly more slots for wallet backfill
  idleTimeoutMillis: 60000,          // 60s idle timeout
  connectionTimeoutMillis: 10000,   // 10s — longer timeout for backfill operations
  // Per-context timeouts used instead (pgQueryCommand/pgQueryPoller)
  keepAlive: true,                  // TCP keepalive — prevents Railway proxy from silently dropping
  keepAliveInitialDelayMillis: 10000,
});

// Heartbeat query every 4 minutes to prevent Railway proxy from dropping idle connections
setInterval(async () => {
  try{ await pgPool.query('SELECT 1'); }
  catch(e){ console.warn('[DB Heartbeat] failed:', e.message); }
}, 4 * 60 * 1000);

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

  // Global registry of collections TraitView knows about, independent of any
  // Discord guild's server_configs. Previously collections only existed as
  // entries buried in per-guild JSON — this is the first standalone source
  // of truth, needed so TraitView can onboard a collection nobody's Discord
  // config references. status drives the on-demand onboarding flow:
  // pending -> backfilling_traits -> backfilling_market -> ready
  //                                                      -> failed (any stage)
  await q(`CREATE TABLE IF NOT EXISTS collections (
    slug             TEXT PRIMARY KEY,
    contract         TEXT NOT NULL,
    chain            TEXT NOT NULL DEFAULT 'ethereum',
    name             TEXT,
    status           TEXT NOT NULL DEFAULT 'pending',
    token_standard   TEXT,
    total_supply     INT,
    is_animated      BOOLEAN DEFAULT false,
    has_svg_images   BOOLEAN DEFAULT false,
    error_message    TEXT,
    requested_by     TEXT,
    traits_synced_at TIMESTAMPTZ,
    market_synced_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
  )`);
  // Seed OCAS itself as 'ready' so the registry is a complete picture from day one
  await q(`INSERT INTO collections (slug, contract, name, status, traits_synced_at, market_synced_at)
    VALUES ('on-chain-all-stars', '0x078be86f3104a32313a47815792230a3808642cc', 'On-Chain All Stars', 'ready', NOW(), NOW())
    ON CONFLICT (slug) DO NOTHING`).catch(()=>{});

  // Stackers analytics — one row per periodic snapshot (see
  // lib/stackers-analytics.js). Computed by iterating every Stacker token
  // and aggregating, since none of the three Stackers contracts expose
  // collection-wide totals directly. JSONB for the per-tier/per-asset
  // breakdowns since those shapes can grow (more tiers or assets added
  // later) without needing a schema change. The "at today's rate" feature
  // needs at least two snapshots to compute a real delta — there is no way
  // around needing real elapsed time for that specific number.
  //
  // tokens_processed vs total_tokens: the job now checkpoints its progress
  // periodically rather than only writing once at the very end. A restart
  // mid-run (which happens often in this environment — any redeploy kills
  // whatever's in flight) previously meant losing all progress and writing
  // nothing at all. tokens_processed < total_tokens means this row is a
  // checkpoint from an interrupted run, not a complete picture — callers
  // must check this and label accordingly, never present it as complete.
  await q(`CREATE TABLE IF NOT EXISTS stackers_snapshots (
    id                 SERIAL PRIMARY KEY,
    snapshot_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_tokens       INT NOT NULL,
    tokens_processed   INT NOT NULL DEFAULT 0,
    active_tokens      INT NOT NULL,
    total_weight       NUMERIC,
    tier_distribution  JSONB NOT NULL,
    asset_popularity   JSONB NOT NULL,
    vault_totals       JSONB NOT NULL,
    created_at         TIMESTAMPTZ DEFAULT NOW()
  )`);
  await q(`ALTER TABLE stackers_snapshots ADD COLUMN IF NOT EXISTS tokens_processed INT NOT NULL DEFAULT 0`).catch(()=>{});
  await q(`CREATE INDEX IF NOT EXISTS idx_stackers_snapshots_at ON stackers_snapshots (snapshot_at DESC)`);

  // Stackers image cache — resolved image bytes per token, so /download can
  // serve straight from Postgres instead of a live on-chain + IPFS fetch on
  // every request. NOT a backfill-once-trust-forever cache: Stackers' art
  // can change (fusion reassigns artwork), so this is kept fresh by the
  // fusion poller re-caching a token's image the moment it detects that
  // token was involved in a fusion (see lib/stackers-fusion-poller.js).
  await q(`CREATE TABLE IF NOT EXISTS stackers_image_cache (
    token_id      INT PRIMARY KEY,
    image_data    BYTEA NOT NULL,
    is_svg        BOOLEAN NOT NULL DEFAULT FALSE,
    content_type  TEXT,
    cached_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`ALTER TABLE stackers_image_cache ADD COLUMN IF NOT EXISTS is_svg BOOLEAN NOT NULL DEFAULT FALSE`).catch(()=>{});

  // Stackers listed-with-unclaimed-vault-value cache — only currently
  // listed tokens with a non-empty vault, refreshed periodically by
  // walking the (much smaller) listed subset rather than the whole
  // collection. Rows removed once a token is no longer listed, so this
  // table always represents "currently listed AND has real vault value,"
  // not a historical record.
  await q(`CREATE TABLE IF NOT EXISTS stackers_vault_listings (
    token_id        INT PRIMARY KEY,
    vault_balances  JSONB NOT NULL,
    checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Stackers per-token status cache — tier, active status, split, and vault
  // balance, kept genuinely current via a live listener watching dedicated
  // on-chain events (Activated, Deactivated, TierUpgraded, SplitSet,
  // Credited, Claimed) rather than needing a slow periodic sweep.
  // vault_balances added once Credited/Claimed were confirmed real events
  // on the verified vault contract, matching our existing ABI exactly.
  await q(`CREATE TABLE IF NOT EXISTS stackers_token_status (
    token_id        INT PRIMARY KEY,
    tier_index      INT,
    is_active       BOOLEAN,
    split           JSONB,
    vault_balances  JSONB,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`ALTER TABLE stackers_token_status ADD COLUMN IF NOT EXISTS vault_balances JSONB`).catch(()=>{});

  // Lightweight vault-totals snapshot — a pure aggregation of the already-
  // live stackers_token_status data (no on-chain reads at all), not
  // stackers_snapshots' full sweep. Cheap enough to run frequently, giving
  // the accrual comparison meaningful data within roughly an hour instead
  // of needing up to 48h for the old design's first two full sweeps.
  await q(`CREATE TABLE IF NOT EXISTS stackers_vault_snapshots (
    id           SERIAL PRIMARY KEY,
    vault_totals JSONB NOT NULL,
    snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_stackers_vault_snapshots_at ON stackers_vault_snapshots (snapshot_at DESC)`);

  // Real, ground-truth pot size and total collection weight from each
  // hourly RoundSettled event -- the foundation for grounding earnings
  // estimates in actual recent data rather than a guessed formula. pot
  // and total_weight stored as TEXT (native BigInt from ethers.js,
  // genuinely too large for a standard integer column in the general
  // case, and precision matters more here than arithmetic convenience).
  await q(`CREATE TABLE IF NOT EXISTS stackers_round_history (
    round_number BIGINT PRIMARY KEY,
    pot_wei      TEXT NOT NULL,
    total_weight TEXT NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_stackers_round_history_at ON stackers_round_history (recorded_at DESC)`);

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

  // TraitView↔Discord verification
  await q(`CREATE TABLE IF NOT EXISTS tv_verify_codes (
    code        TEXT PRIMARY KEY,
    discord_id  TEXT NOT NULL,
    guild_id    TEXT NOT NULL,
    wallet      TEXT NOT NULL,
    direction   TEXT NOT NULL DEFAULT 'discord', -- 'discord' = generated by bot, 'traitview' = generated by TV
    expires_at  TIMESTAMPTZ NOT NULL,
    claimed_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS tv_verify_discord_idx ON tv_verify_codes(discord_id)`);

  await q(`CREATE TABLE IF NOT EXISTS traitview_links (
    discord_id  TEXT NOT NULL,
    guild_id    TEXT NOT NULL,
    wallet      TEXT NOT NULL,
    linked_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (discord_id, guild_id)
  )`);
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
  await q(`CREATE TABLE IF NOT EXISTS listings (token_id INT, price_eth NUMERIC, list_ts TIMESTAMPTZ, order_hash TEXT, collection_slug TEXT, url TEXT, updated_at TIMESTAMPTZ, UNIQUE(token_id, collection_slug))`);
  await q(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS collection_slug TEXT DEFAULT 'on-chain-all-stars'`);
  await q(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_eth NUMERIC`).catch(()=>{});
  await q(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS url TEXT`).catch(()=>{});
  await q(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`).catch(()=>{});
  await q(`UPDATE listings SET collection_slug = 'on-chain-all-stars' WHERE collection_slug IS NULL`).catch(()=>{});
  await q(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await q(`CREATE TABLE IF NOT EXISTS burn_events (id SERIAL PRIMARY KEY, tx_hash TEXT UNIQUE, block_number BIGINT, burned_token_id INT, survivor_token_id INT, burn_type TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`ALTER TABLE burn_events ADD COLUMN IF NOT EXISTS survivor_token_id INT`);
  await q(`ALTER TABLE burn_events ADD COLUMN IF NOT EXISTS burn_type TEXT`);
  await q(`ALTER TABLE burn_events DROP CONSTRAINT IF EXISTS burn_events_tx_hash_key`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS burn_events_tx_hash_idx ON burn_events(tx_hash)`);
  await q(`CREATE INDEX IF NOT EXISTS burn_events_burner_wallet_idx ON burn_events(LOWER(burner_wallet))`).catch(()=>{});
  await q(`CREATE TABLE IF NOT EXISTS burn_event_inputs (id SERIAL PRIMARY KEY, burn_event_id INT REFERENCES burn_events(id), burned_token_id INT, UNIQUE(burn_event_id,burned_token_id))`);
  // burn_started_events/burn_started_inputs were previously only ever created
  // by the one-off burn-backfill-repair.js script, not by this regular
  // migration path -- meaning any fresh environment that never had that
  // script run against it (e.g. a new API/bot service) would be missing
  // these tables entirely. Adding them here so they self-heal like
  // everything else runMigrations() covers. Schema matches burn-backfill-
  // repair.js exactly.
  await q(`CREATE TABLE IF NOT EXISTS burn_started_events (
    id SERIAL PRIMARY KEY, tx_hash TEXT NOT NULL, block_number BIGINT NOT NULL,
    log_index INT NOT NULL, owner_wallet TEXT NOT NULL, survivor_token_id INT NOT NULL,
    points_used INT, result_body_type INT, result_is_angel BOOLEAN DEFAULT FALSE,
    boost_chance INT, reveal_block BIGINT, selection_hash TEXT, started_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS burn_started_tx_log_idx ON burn_started_events(tx_hash, log_index)`);
  await q(`CREATE INDEX IF NOT EXISTS burn_started_survivor_idx ON burn_started_events(survivor_token_id)`);
  await q(`CREATE TABLE IF NOT EXISTS burn_started_inputs (
    id SERIAL PRIMARY KEY,
    burn_started_id INT NOT NULL REFERENCES burn_started_events(id) ON DELETE CASCADE,
    burned_token_id INT NOT NULL
  )`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS burn_started_inputs_event_token_idx ON burn_started_inputs(burn_started_id, burned_token_id)`);
  // Fix for the pendingBurns race condition (2026-07-06): a survivor burned
  // more than once in quick succession could have its BurnFinalized events
  // matched to the WRONG BurnStarted record (whichever was most recently
  // cached/queried, not the one that actually paired with that finalize),
  // corrupting burn_event_inputs with duplicated fuel-token lists. This
  // column marks a start event as consumed once matched, so both the
  // in-memory FIFO queue and the DB fallback in loadBurnStartFromDB() can
  // never re-select an already-used start for a later finalize.
  await q(`ALTER TABLE burn_started_events ADD COLUMN IF NOT EXISTS matched_burn_event_id INT`).catch(()=>{});
  await q(`CREATE INDEX IF NOT EXISTS burn_started_events_unmatched_idx ON burn_started_events(survivor_token_id, block_number) WHERE matched_burn_event_id IS NULL`).catch(()=>{});
  await q(`CREATE TABLE IF NOT EXISTS burn_alert_posts (id SERIAL PRIMARY KEY, tx_hash TEXT, log_index INT, channel_id TEXT, posted_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(tx_hash,log_index,channel_id))`);
  await q(`CREATE TABLE IF NOT EXISTS token_traits (token_id INT NOT NULL, trait_name TEXT NOT NULL, trait_value TEXT, trait_index INT NOT NULL DEFAULT 0, source TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY(token_id,trait_index), UNIQUE(token_id,trait_index))`);
  await q(`ALTER TABLE token_traits ADD COLUMN IF NOT EXISTS collection_slug TEXT`).catch(()=>{});
  await q(`CREATE INDEX IF NOT EXISTS token_traits_slug_idx ON token_traits(token_id, collection_slug)`).catch(()=>{});
  await q(`CREATE TABLE IF NOT EXISTS token_image_snapshots (token_id INT PRIMARY KEY, image_url TEXT, image_source TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS token_original_snapshots (token_id INT PRIMARY KEY, image_url TEXT, image_source TEXT, captured_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS burn_state_snapshots (id SERIAL PRIMARY KEY, burn_event_id INT REFERENCES burn_events(id), snapshot_type TEXT, token_id INT, image_url TEXT, image_source TEXT, metadata JSONB, captured_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS burn_lotteries (id SERIAL PRIMARY KEY, guild_id TEXT, channel_id TEXT, created_by TEXT, title TEXT, prize TEXT, mode TEXT DEFAULT 'wallet', start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, seed TEXT, status TEXT DEFAULT 'active', winner_wallet TEXT, qualified_wallets INT, total_burns INT, result_json JSONB, timezone TEXT, completed_at TIMESTAMPTZ, message_id TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS generic_lotteries (id SERIAL PRIMARY KEY, guild_id TEXT, channel_id TEXT, created_by TEXT, title TEXT, type TEXT DEFAULT 'giveaway', start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, seed TEXT, status TEXT DEFAULT 'active', winner_display TEXT, min_number INT, max_number INT, winning_number INT, result_json JSONB, timezone TEXT, completed_at TIMESTAMPTZ, message_id TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS generic_lottery_entries (id SERIAL PRIMARY KEY, lottery_id INT REFERENCES generic_lotteries(id), user_id TEXT, username TEXT, guess_number INT, entered_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(lottery_id,user_id))`);
  await q(`ALTER TABLE generic_lotteries ADD COLUMN IF NOT EXISTS message_id TEXT`);
  await q(`CREATE TABLE IF NOT EXISTS tokens (id INT PRIMARY KEY, os_rank INT, tv_rank INT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS collection_slug TEXT`).catch(()=>{});
  await q(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS image_url TEXT`).catch(()=>{});
  // obs_rank/rarity_score/trait_count/os_score: legacy columns that existed
  // on the original database with no tracked migration file anywhere adding
  // them -- migrations 005/006 only ever adjust obs_rank/rarity_score's
  // nullability, never create them. Added here so any fresh database (this
  // bot's own new deployment included) gets the full schema automatically,
  // rather than silently missing columns that /sweep, /rankfind, and other
  // rank-aware commands all expect to exist.
  await q(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS obs_rank INTEGER`).catch(()=>{});
  await q(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS rarity_score NUMERIC(18,6)`).catch(()=>{});
  await q(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS trait_count INTEGER`).catch(()=>{});
  await q(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS os_score NUMERIC(18,6)`).catch(()=>{});
  await q(`CREATE TABLE IF NOT EXISTS token_svg_cache (
    token_id INT NOT NULL,
    collection_slug TEXT NOT NULL,
    image_data TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (token_id, collection_slug)
  )`).catch(()=>{});

  // Price alerts — user watching specific tokens
  await q(`CREATE TABLE IF NOT EXISTS user_price_alerts (
    id          SERIAL PRIMARY KEY,
    discord_id  TEXT NOT NULL,
    slug        TEXT NOT NULL,
    token_id    INT NOT NULL,
    threshold_eth NUMERIC(18,8) NOT NULL,
    alert_once  BOOLEAN DEFAULT true,
    repeat_alert BOOLEAN DEFAULT false,
    triggered_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`);
  await q(`ALTER TABLE user_price_alerts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
  await q(`CREATE INDEX IF NOT EXISTS user_price_alerts_token_idx ON user_price_alerts(slug, token_id)`);
  await q(`CREATE INDEX IF NOT EXISTS user_price_alerts_user_idx ON user_price_alerts(discord_id)`);

  // Floor alerts — user watching collection floor
  await q(`CREATE TABLE IF NOT EXISTS user_floor_alerts (
    id              SERIAL PRIMARY KEY,
    discord_id      TEXT NOT NULL,
    slug            TEXT NOT NULL,
    threshold_eth   NUMERIC(18,8) NOT NULL,
    repeat_alert    BOOLEAN DEFAULT true,
    cooldown_minutes INT DEFAULT 60,
    direction       TEXT DEFAULT 'below',
    last_alerted_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(discord_id, slug)
  )`);
  await q(`ALTER TABLE user_floor_alerts ADD COLUMN IF NOT EXISTS cooldown_minutes INT DEFAULT 60`);
  await q(`ALTER TABLE user_floor_alerts ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT 'below'`);
  await q(`ALTER TABLE user_floor_alerts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
  await q(`CREATE INDEX IF NOT EXISTS user_floor_alerts_slug_idx ON user_floor_alerts(slug)`);

  // Wallet sync status — tracks per-user per-collection sync progress
  await q(`CREATE TABLE IF NOT EXISTS wallet_sync_status (
    id           SERIAL PRIMARY KEY,
    discord_id   TEXT NOT NULL,
    wallet       TEXT NOT NULL,
    slug         TEXT NOT NULL,
    status       TEXT DEFAULT 'pending',
    token_count  INT DEFAULT 0,
    started_at   TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE(discord_id, wallet, slug)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS wss_discord_idx ON wallet_sync_status(discord_id)`);
  // nft_transfers — explicit ALTERs required for existing DBs
  await q(`CREATE TABLE IF NOT EXISTS nft_transfers (
    id              SERIAL PRIMARY KEY,
    token_id        INT,
    from_address    TEXT,
    to_address      TEXT,
    value_eth       NUMERIC(18,8) DEFAULT 0,
    block_number    INT,
    transferred_at  TIMESTAMPTZ,
    tx_hash         TEXT,
    collection_slug TEXT DEFAULT 'on-chain-all-stars'
  )`).catch(()=>{});
  await q(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS token_id INT`).catch(()=>{});
  await q(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS from_address TEXT`).catch(()=>{});
  await q(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS to_address TEXT`).catch(()=>{});
  await q(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS value_eth NUMERIC(18,8) DEFAULT 0`).catch(()=>{});
  await q(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS block_number INT`).catch(()=>{});
  await q(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ`).catch(()=>{});
  await q(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS tx_hash TEXT`).catch(()=>{});
  await q(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS collection_slug TEXT DEFAULT 'on-chain-all-stars'`).catch(()=>{});
  await q(`UPDATE nft_transfers SET collection_slug='on-chain-all-stars' WHERE collection_slug IS NULL`).catch(()=>{});
  await q(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS contract TEXT`).catch(()=>{});
  await q(`UPDATE nft_transfers SET contract='0x078be86f3104a32313a47815792230a3808642cc' WHERE contract IS NULL`).catch(()=>{});
  await q(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS log_index INT DEFAULT 0`).catch(()=>{});
  await q(`UPDATE nft_transfers SET log_index=0 WHERE log_index IS NULL`).catch(()=>{});
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS nft_transfers_tx_token_slug_idx ON nft_transfers(tx_hash, token_id, collection_slug) WHERE tx_hash IS NOT NULL`).catch(()=>{});
  await q(`CREATE INDEX IF NOT EXISTS nft_transfers_to_idx ON nft_transfers(to_address, collection_slug)`).catch(()=>{});
  await q(`CREATE INDEX IF NOT EXISTS nft_transfers_from_idx ON nft_transfers(from_address, collection_slug)`).catch(()=>{});

  // wallet_token_intervals — explicit ALTERs for existing DBs
  await q(`CREATE TABLE IF NOT EXISTS wallet_token_intervals (
    id              SERIAL PRIMARY KEY,
    wallet_address  TEXT,
    token_id        INT,
    acquired_at     TIMESTAMPTZ,
    disposed_at     TIMESTAMPTZ,
    cost_eth        NUMERIC(18,8) DEFAULT 0,
    sale_eth        NUMERIC(18,8),
    collection_slug TEXT DEFAULT 'on-chain-all-stars'
  )`).catch(()=>{});
  await q(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS wallet_address TEXT`).catch(()=>{});
  await q(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS token_id INT`).catch(()=>{});
  await q(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS acquired_at TIMESTAMPTZ`).catch(()=>{});
  await q(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS disposed_at TIMESTAMPTZ`).catch(()=>{});
  await q(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS cost_eth NUMERIC(18,8) DEFAULT 0`).catch(()=>{});
  await q(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS sale_eth NUMERIC(18,8)`).catch(()=>{});
  await q(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS collection_slug TEXT DEFAULT 'on-chain-all-stars'`).catch(()=>{});
  await q(`UPDATE wallet_token_intervals SET collection_slug='on-chain-all-stars' WHERE collection_slug IS NULL`).catch(()=>{});
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS wallet_token_intervals_unique ON wallet_token_intervals(wallet_address, token_id, acquired_at, collection_slug) WHERE acquired_at IS NOT NULL`).catch(()=>{});
  await q(`CREATE INDEX IF NOT EXISTS wti_wallet_idx ON wallet_token_intervals(wallet_address, collection_slug)`).catch(()=>{});

  await q(`CREATE TABLE IF NOT EXISTS skipped_listing_batches (
    id              SERIAL PRIMARY KEY,
    guild_id        TEXT,
    collection_slug TEXT,
    listing_count   INT,
    token_ids       JSONB,
    reset_cursor_to TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS wallet_favorites (
    wallet_address  TEXT NOT NULL,
    collection_slug TEXT NOT NULL,
    token_ids       JSONB NOT NULL DEFAULT '[]',
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (wallet_address, collection_slug)
  )`);

  console.log('[DB] Migrations complete');
}

// ── Persistence helpers (bot_state table) ────────────────────────────────────
// Only these two keys have a real on-disk JSON file equivalent to fall back to.
// Every other key (sale_cursors, listing_cursors, burn_config, etc.) has no file
// backing it — the fallback must NOT silently substitute unrelated data for them.
const FILE_FALLBACKS = {
  server_configs: () => SERVER_FILE,
  user_alerts:    () => ALERTS_FILE,
};

async function dbLoad(key){
  try{
    const r = await pgPool.query('SELECT value FROM bot_state WHERE key=$1', [key]);
    if(r.rows.length) return JSON.parse(r.rows[0].value);
  }catch(e){ console.error(`[dbLoad] ${key} failed:`, e.message); }
  // Fallback to JSON file — only for keys that actually have one.
  const fileFor = FILE_FALLBACKS[key];
  if(fileFor){
    try{
      const file = fileFor();
      if(fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    }catch(e){ console.error(`[dbLoad] ${key} file fallback failed:`, e.message); }
  }
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

// ── Skipped-listing tracking ──────────────────────────────────────────────────
// Records a batch of listings that pollListings() detected but did NOT post,
// because the backlog exceeded the 50-listing startup-catchup cap (see
// lib/poll.js). Non-blocking / best-effort — this is diagnostic data, it must
// never affect the poll loop itself.
async function recordSkippedListings({ guildId, slug, tokenIds, resetCursorTo }){
  try{
    await pgPool.query(
      `INSERT INTO skipped_listing_batches (guild_id, collection_slug, listing_count, token_ids, reset_cursor_to)
       VALUES ($1,$2,$3,$4,$5)`,
      [guildId, slug, tokenIds.length, JSON.stringify(tokenIds), resetCursorTo]
    );
  }catch(e){
    console.warn('[recordSkippedListings]', e.message);
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
      // Special case: collections array — if incoming cfg has it, use it exactly (no merge)
      // This prevents deleted collections from being restored from DB state
      const incomingCollections = cfg.collections; // save before spread
      cfg = { ...dbCfg, ...cfg };
      if(incomingCollections !== undefined) cfg.collections = incomingCollections;
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

// getConfig() reads only from the in-memory _serverConfigs cache, never the
// DB directly -- deleting the DB row alone would leave the bot still
// behaving as if the old config existed until a restart repopulated the
// cache. This clears both together.
async function deleteConfig(guildId){
  delete _serverConfigs[guildId];
  try{
    await pgPool.query(`DELETE FROM server_configs WHERE guild_id=$1`, [guildId]);
  }catch(e){
    console.warn('[deleteConfig]', e.message);
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

// ── Collection trait cache (OpenSea → collection_traits table) ────────────────
// Single source of truth — used by config.js, setup.js, any future call site.
// Skips the OS API call entirely if collection_traits already has rows for
// this slug (dedup check). Force-refetch can be added later if needed.
//
// Returns a result object so callers that actually need to know what happened
// (e.g. the /db/collections/:slug/sync-trait-index diagnostic endpoint) can
// report it — fire-and-forget callers elsewhere (.catch(()=>{})) are
// unaffected since they already ignored the return value.
async function fetchAndStoreCollectionTraits(slug, pgPool){
  if(!slug) return { ok:false, reason:'no slug provided' };
  try{
    // Dedup: if we already have trait rows for this slug, skip the OS call.
    const existing = await pgPool.query(
      `SELECT 1 FROM collection_traits WHERE slug=$1 LIMIT 1`, [slug]
    ).catch(()=>null);
    if(existing?.rows?.length){
      console.log(`[TraitCache] ${slug} already cached — skipping OS fetch`);
      return { ok:true, skipped:true, reason:'already cached' };
    }
    const { osHeaders } = require('./constants');
    const fetch = require('node-fetch');
    const res = await fetch(
      `https://api.opensea.io/api/v2/traits/${slug}`,
      { headers: osHeaders() }
    );
    if(!res.ok){
      const bodyText = await res.text().catch(()=>'');
      console.warn('[TraitCache] OS traits fetch failed:', res.status, slug, bodyText.slice(0,200));
      return { ok:false, reason:`OpenSea returned HTTP ${res.status}`, status: res.status, body: bodyText.slice(0,200) };
    }
    const data = await res.json();
    const counts = data.counts || {};
    let count = 0;
    for(const [traitName, valueCounts] of Object.entries(counts)){
      if(typeof valueCounts !== 'object' || Array.isArray(valueCounts)) continue;
      for(const [val, cnt] of Object.entries(valueCounts)){
        await pgPool.query(
          `INSERT INTO collection_traits (slug, trait_name, trait_value, token_count)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (slug, trait_name, trait_value) DO UPDATE SET token_count=$4`,
          [slug, traitName, val, cnt]
        ).catch(()=>{});
        count++;
      }
    }
    console.log(`[TraitCache] Stored ${count} trait values for ${slug}`);
    if(!count) return { ok:false, reason:'OpenSea returned 0 traits for this slug — check the slug is exactly right', rawKeys: Object.keys(data||{}) };
    return { ok:true, count };
  }catch(e){
    console.warn('[TraitCache] Error fetching traits for', slug, ':', e.message);
    return { ok:false, reason: e.message };
  }
}

module.exports = {
  pgPool, pgQueryCommand, pgQueryPoller,
  runMigrations,
  dbLoad, dbSave,
  loadAllConfigs, getConfig, setConfig, deleteConfig, getAllConfigs,
  getUserAlerts, setUserAlerts,
  loadSaleCursor, saveSaleCursor, getSaleCursor,
  fetchAndStoreCollectionTraits,
  recordSkippedListings,
};








