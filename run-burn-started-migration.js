/**
 * Standalone migration -- creates ONLY what the repair/diagnostic scripts
 * need (burn_started_events, burn_started_inputs, matched_burn_event_id).
 * Deliberately decoupled from the full bot-modular -> main merge: this does
 * NOT touch bot.js, api.js, or lib/burn-poller.js's actual runtime behavior
 * at all. It's the same schema already added to bot-modular's
 * lib/db.js runMigrations() this session, extracted so it can run against
 * production standalone, before the real merge happens, without deploying
 * any of the behavior changes (pendingBurns FIFO fix, input_snapshots API
 * endpoint, etc.) early.
 *
 * Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
 * throughout). Does not touch any existing data.
 *
 * USAGE
 *   node run-burn-started-migration.js
 */

require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  console.log('Creating burn_started_events (if not exists)...');
  await pool.query(`CREATE TABLE IF NOT EXISTS burn_started_events (
    id SERIAL PRIMARY KEY, tx_hash TEXT NOT NULL, block_number BIGINT NOT NULL,
    log_index INT NOT NULL, owner_wallet TEXT NOT NULL, survivor_token_id INT NOT NULL,
    points_used INT, result_body_type INT, result_is_angel BOOLEAN DEFAULT FALSE,
    boost_chance INT, reveal_block BIGINT, selection_hash TEXT, started_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS burn_started_tx_log_idx ON burn_started_events(tx_hash, log_index)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS burn_started_survivor_idx ON burn_started_events(survivor_token_id)`);

  console.log('Creating burn_started_inputs (if not exists)...');
  await pool.query(`CREATE TABLE IF NOT EXISTS burn_started_inputs (
    id SERIAL PRIMARY KEY,
    burn_started_id INT NOT NULL REFERENCES burn_started_events(id) ON DELETE CASCADE,
    burned_token_id INT NOT NULL
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS burn_started_inputs_event_token_idx ON burn_started_inputs(burn_started_id, burned_token_id)`);

  console.log('Adding matched_burn_event_id column (if not exists)...');
  await pool.query(`ALTER TABLE burn_started_events ADD COLUMN IF NOT EXISTS matched_burn_event_id INT`).catch(e => console.warn('  ', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS burn_started_events_unmatched_idx ON burn_started_events(survivor_token_id, block_number) WHERE matched_burn_event_id IS NULL`).catch(e => console.warn('  ', e.message));

  // Report current state so it's obvious whether these tables were already
  // populated (e.g. from an earlier one-off manual run of
  // burn-backfill-repair.js) or are freshly empty.
  const startedCount = await pool.query(`SELECT COUNT(*)::int AS n FROM burn_started_events`);
  const inputsCount = await pool.query(`SELECT COUNT(*)::int AS n FROM burn_started_inputs`);
  console.log(`\nDone. burn_started_events has ${startedCount.rows[0].n} row(s), burn_started_inputs has ${inputsCount.rows[0].n} row(s).`);
  if (startedCount.rows[0].n === 0) {
    console.log('These tables are empty -- repair-burn-event-inputs.js and repair-burn-state-snapshots.js');
    console.log('need real BurnStarted history in here to work. If production never had');
    console.log('burn-backfill-repair.js run against it historically, these will need that historical');
    console.log('backfill run first (a separate, bigger step) before the repair scripts have anything to work with.');
  }

  await pool.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
