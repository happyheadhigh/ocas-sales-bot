/**
 * Derive wallet_token_intervals from nft_transfers.
 *
 * Standalone, idempotent script. It rebuilds only the derived interval table
 * from append-only transfer history. It does not modify bot tables.
 */

require('dotenv').config();
const { Pool } = require('pg');

const ZERO = '0x0000000000000000000000000000000000000000';
const DEFAULT_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const CONTRACT = String(process.env.OCAS_CONTRACT || DEFAULT_CONTRACT).toLowerCase();
const DATABASE_URL = process.env.DATABASE_URL;
const LOCK_KEY_1 = 842026;
const LOCK_KEY_2 = 2;

if (!DATABASE_URL) {
  console.error('[wallet-derive] Missing DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

function normalizeAddress(addr) {
  const s = String(addr || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
}

async function ensureIntervalsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS wallet_token_intervals (
      wallet_address VARCHAR(42) NOT NULL,
      token_id INTEGER NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL,
      disposed_at TIMESTAMPTZ,
      acquired_tx VARCHAR(66),
      disposed_tx VARCHAR(66),
      PRIMARY KEY (wallet_address, token_id, acquired_at)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS wallet_token_intervals_wallet_idx
      ON wallet_token_intervals (wallet_address, acquired_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS wallet_token_intervals_current_wallet_idx
      ON wallet_token_intervals (wallet_address, token_id)
      WHERE disposed_at IS NULL
  `);
}

async function insertIntervals(client, intervals) {
  if (!intervals.length) return 0;
  let inserted = 0;
  for (let i = 0; i < intervals.length; i += 500) {
    const batch = intervals.slice(i, i + 500);
    const values = batch.map((_, j) =>
      `($${j * 6 + 1},$${j * 6 + 2},$${j * 6 + 3},$${j * 6 + 4},$${j * 6 + 5},$${j * 6 + 6})`
    ).join(',');
    const params = batch.flatMap(x => [
      x.wallet_address, x.token_id, x.acquired_at, x.disposed_at, x.acquired_tx, x.disposed_tx,
    ]);
    const r = await client.query(`
      INSERT INTO wallet_token_intervals
        (wallet_address, token_id, acquired_at, disposed_at, acquired_tx, disposed_tx)
      VALUES ${values}
      ON CONFLICT (wallet_address, token_id, acquired_at)
      DO UPDATE SET disposed_at = EXCLUDED.disposed_at, disposed_tx = EXCLUDED.disposed_tx
    `, params);
    inserted += r.rowCount;
  }
  return inserted;
}

async function main() {
  const client = await pool.connect();
  try {
    await ensureIntervalsTable(client);
    const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [LOCK_KEY_1, LOCK_KEY_2]);
    if (!lock.rows[0]?.locked) {
      console.log('[wallet-derive] Another derive job is already running; exiting.');
      return;
    }

    console.log(`[wallet-derive] Loading transfers for ${CONTRACT}`);
    const transfers = await client.query(`
      SELECT token_id, from_address, to_address, tx_hash, block_ts, block_number, log_index
      FROM nft_transfers
      WHERE contract = $1
      ORDER BY block_number ASC, log_index ASC
    `, [CONTRACT]);

    const openByToken = new Map();
    const intervals = [];
    let skipped = 0;

    for (const t of transfers.rows) {
      const tokenId = parseInt(t.token_id);
      const from = normalizeAddress(t.from_address);
      const to = normalizeAddress(t.to_address);
      const ts = t.block_ts || new Date(0).toISOString();
      const current = openByToken.get(tokenId);

      if (from && from !== ZERO) {
        if (current && current.wallet_address === from) {
          current.disposed_at = ts;
          current.disposed_tx = t.tx_hash;
          intervals.push(current);
          openByToken.delete(tokenId);
        } else {
          skipped++;
        }
      }

      if (to && to !== ZERO) {
        openByToken.set(tokenId, {
          wallet_address: to,
          token_id: tokenId,
          acquired_at: ts,
          disposed_at: null,
          acquired_tx: t.tx_hash,
          disposed_tx: null,
        });
      }
    }

    for (const interval of openByToken.values()) intervals.push(interval);

    // V1/backfill uses a full rebuild because it is simple and idempotent.
    // If this runs frequently in production, replace it with an incremental
    // derive step keyed by synced block ranges.
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM wallet_token_intervals');
      const inserted = await insertIntervals(client, intervals);
      await client.query('COMMIT');
      console.log(`[wallet-derive] done transfers=${transfers.rowCount} intervals=${inserted} open=${openByToken.size} skipped=${skipped}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]); } catch (_) {}
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('[wallet-derive] failed:', e.message);
  process.exit(1);
});
