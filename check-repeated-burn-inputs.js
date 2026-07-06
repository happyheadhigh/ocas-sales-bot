/**
 * Diagnostic only — no writes. Investigates a pattern noticed in the
 * "survivors later destroyed" list from check-live-metadata-gaps.js: some
 * token IDs (e.g. #4244) show up as a destroyed input across MULTIPLE
 * different burn_events rows, sometimes within minutes of each other.
 * A physical NFT can only be burned/destroyed once, so before building
 * anything display-related on top of this, we need to know which of these
 * is true:
 *
 *   (a) Real: the token survived several earlier burns (kept winning as
 *       lowest-ID survivor) before finally losing and being consumed for
 *       real in its last appearance — expected under a "lowest ID wins"
 *       mechanic, nothing wrong.
 *   (b) Bot-side duplication: the same real destruction got logged as
 *       multiple separate burn_events rows (block_number/log_index would
 *       reveal this — if several "different" tx_hashes actually share the
 *       same block or resolve to the same real transaction, that points to
 *       a logging bug, not a real repeated burn).
 *   (c) Something about the burn queue/BurnStarted flow allowing the same
 *       token to be provisionally queued into more than one burn attempt
 *       before the first one finalizes.
 *
 * USAGE
 *   DATABASE_URL=... node check-repeated-burn-inputs.js
 */

require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  console.log('=== Tokens appearing as a destroyed input more than once ===');
  const repeats = await pool.query(`
    SELECT bei.burned_token_id AS token_id,
           be.tx_hash, be.block_number, be.log_index, be.burned_at,
           be.survivor_token_id
    FROM burn_event_inputs bei
    JOIN burn_events be ON be.id = bei.burn_event_id
    WHERE bei.burned_token_id != be.survivor_token_id
      AND bei.burned_token_id IN (
        SELECT bei2.burned_token_id
        FROM burn_event_inputs bei2
        JOIN burn_events be2 ON be2.id = bei2.burn_event_id
        WHERE bei2.burned_token_id != be2.survivor_token_id
        GROUP BY bei2.burned_token_id
        HAVING COUNT(*) > 1
      )
    ORDER BY bei.burned_token_id, be.block_number, be.log_index
  `);

  if (!repeats.rows.length) {
    console.log('  None found.');
  } else {
    let lastId = null;
    for (const r of repeats.rows) {
      if (r.token_id !== lastId) { console.log(`\n  Token #${r.token_id}:`); lastId = r.token_id; }
      console.log(`    block=${r.block_number} log_index=${r.log_index} tx=${r.tx_hash} survivor_that_event=${r.survivor_token_id} at=${r.burned_at}`);
    }
    console.log('\n  If any token shows the SAME block_number across multiple rows, that is');
    console.log('  a strong signal of duplicate/bugged logging (one real event, several rows).');
    console.log('  If block_numbers are genuinely different and increasing over time, these');
    console.log('  are very likely separate real on-chain transactions -- worth spot-checking');
    console.log('  one tx_hash on Etherscan directly to see what it actually did.');
  }

  await pool.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
