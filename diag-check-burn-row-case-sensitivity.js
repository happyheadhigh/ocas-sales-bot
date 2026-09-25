/**
 * Diagnostic only -- no writes. Investigating why re-running deriveIntervals()
 * (fix-rederive-wallet-intervals.js) still left burned tokens showing as
 * "held" for wallets that DO have trulyBurnedIds populated from
 * burn_event_inputs (e.g. 0x6456c1...: 32 truly burned token IDs found,
 * but only 2 ended up counted as burned -- 27 held instead of the
 * expected ~22-ish).
 *
 * Hypothesis: fix-missing-nft-transfers-burn-rows.js inserted synthesized
 * burn rows using `r.burner_wallet` directly from burn_events as
 * from_address -- WITHOUT lowercasing it. deriveIntervals()'s main query
 * does an exact-match `WHERE (to_address=$1 OR from_address=$1)` against
 * the lowercased wallet param, with no LOWER() on the column side. If
 * burn_events.burner_wallet is stored checksummed/mixed-case, the newly
 * inserted nft_transfers rows would have mixed-case from_address and
 * silently never match deriveIntervals()'s query -- meaning the burn
 * rows exist in the table but are invisible to the derivation, so those
 * tokens stay "open" (held) forever.
 *
 * This checks that directly: for a given wallet, do any nft_transfers
 * rows exist where from_address matches case-INsensitively but not
 * case-sensitively?
 *
 * USAGE
 *   node diag-check-burn-row-case-sensitivity.js 0x6456c11151f4ada09dadb1ebc729d3ef5f38ad41
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const wallet = (process.argv[2] || '0x6456c11151f4ada09dadb1ebc729d3ef5f38ad41').toLowerCase();

async function main() {
  console.log(`=== Checking case-sensitivity gap for wallet ${wallet} ===\n`);

  // 1. burn_events.burner_wallet casing for this wallet
  const burnerCasing = await pool.query(
    `SELECT DISTINCT be.burner_wallet
     FROM burn_events be
     WHERE LOWER(be.burner_wallet) = $1`,
    [wallet]
  );
  console.log('burn_events.burner_wallet casing found:', burnerCasing.rows.map(r => r.burner_wallet));

  // 2. nft_transfers rows that match case-insensitively but NOT case-sensitively (from_address)
  const mismatch = await pool.query(
    `SELECT id, token_id, from_address, to_address, event_type, tx_hash
     FROM nft_transfers
     WHERE LOWER(from_address) = $1 AND from_address != $1
     ORDER BY id`,
    [wallet]
  );
  console.log(`\nnft_transfers rows where from_address matches case-insensitively but NOT exactly (i.e. invisible to deriveIntervals' exact-match query): ${mismatch.rows.length}`);
  for (const r of mismatch.rows.slice(0, 15)) {
    console.log(`  id=${r.id} token_id=${r.token_id} from=${r.from_address} to=${r.to_address} event_type=${r.event_type} tx=${r.tx_hash}`);
  }
  if (mismatch.rows.length > 15) console.log(`  ...and ${mismatch.rows.length - 15} more`);

  // 3. Same check but database-wide (all wallets), to see how big this is
  const wideRes = await pool.query(`
    SELECT COUNT(*)::int AS total
    FROM nft_transfers
    WHERE from_address != LOWER(from_address) AND event_type = 'burn'
  `);
  console.log(`\nDatabase-wide: nft_transfers rows with event_type='burn' where from_address is NOT already lowercase: ${wideRes.rows[0].total}`);

  const wideResTo = await pool.query(`
    SELECT COUNT(*)::int AS total
    FROM nft_transfers
    WHERE to_address != LOWER(to_address)
  `);
  console.log(`Database-wide: nft_transfers rows where to_address is NOT already lowercase: ${wideResTo.rows[0].total}`);
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
