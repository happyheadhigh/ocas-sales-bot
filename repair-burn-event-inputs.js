/**
 * Repairs burn_event_inputs for finalized burns whose fuel-token list was
 * attributed to the WRONG BurnStarted record, due to a race condition in the
 * old pendingBurns matching logic (fixed in lib/burn-poller.js, 2026-07-06 --
 * see that file's queuePendingBurn/takeNextPendingBurn/markBurnStartMatched).
 *
 * THE UNDERLYING DATA ISN'T LOST. burn_started_events + burn_started_inputs
 * still hold each start's true, correct fuel-token list, untouched by the
 * bug -- the bug was purely in PAIRING (which start got attributed to which
 * finalize), not in the recorded fuel lists themselves. This script
 * re-derives the correct pairing by processing each survivor's starts and
 * finalizes in chronological (block_number, log_index) order and matching
 * them 1:1 in sequence (FIFO) -- exactly the rule the live code now follows
 * going forward for new burns.
 *
 * For each survivor:
 *   - Load all burn_started_events (+ their burn_started_inputs), oldest first
 *   - Load all burn_events (finalized), oldest first
 *   - Pair them index-for-index: start[0]<->finalize[0], start[1]<->finalize[1], ...
 *   - If the counts don't match, SKIP that survivor and report it separately
 *     for manual review -- do not guess at a pairing when the counts don't
 *     line up (e.g. an abandoned start that never finalized, or a very old
 *     finalize that predates burn_started_events tracking entirely).
 *   - For each pair, compare the correct token list (from the paired start,
 *     including the survivor's own id if present -- burn_event_inputs has
 *     historically stored the full selected-token list, matching
 *     storeBurnFinalized's existing write behavior; downstream consumers
 *     already filter out the survivor's own id where needed) against what's
 *     CURRENTLY stored in burn_event_inputs for that finalize. Only rows
 *     that actually differ get touched.
 *
 * USAGE
 *   Dry run (default):       node repair-burn-event-inputs.js
 *   Actually write:           WRITE=true node repair-burn-event-inputs.js
 *   Single survivor only:     SURVIVOR=2007 node repair-burn-event-inputs.js
 *   Single survivor + write:  SURVIVOR=2007 WRITE=true node repair-burn-event-inputs.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const WRITE = String(process.env.WRITE || 'false').toLowerCase() === 'true';

async function getSurvivorIds(pool) {
  if (process.env.SURVIVOR) return [parseInt(process.env.SURVIVOR, 10)];
  const r = await pool.query(`SELECT DISTINCT survivor_token_id FROM burn_events ORDER BY survivor_token_id`);
  return r.rows.map(row => parseInt(row.survivor_token_id, 10));
}

async function getStarts(pool, survivorId) {
  const r = await pool.query(`
    SELECT bse.id, bse.block_number, bse.log_index,
           array_agg(bsi.burned_token_id ORDER BY bsi.burned_token_id) FILTER (WHERE bsi.burned_token_id IS NOT NULL) AS token_ids
    FROM burn_started_events bse
    LEFT JOIN burn_started_inputs bsi ON bsi.burn_started_id = bse.id
    WHERE bse.survivor_token_id = $1
    GROUP BY bse.id
    ORDER BY bse.block_number ASC, bse.log_index ASC
  `, [survivorId]);
  return r.rows.map(row => ({
    id: row.id,
    tokenIds: (row.token_ids || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b),
  }));
}

async function getFinalizes(pool, survivorId) {
  const r = await pool.query(`
    SELECT id, tx_hash, block_number, log_index
    FROM burn_events
    WHERE survivor_token_id = $1
    ORDER BY block_number ASC, log_index ASC
  `, [survivorId]);
  return r.rows;
}

async function getCurrentInputs(pool, burnEventId) {
  const r = await pool.query(
    `SELECT burned_token_id FROM burn_event_inputs WHERE burn_event_id=$1 ORDER BY burned_token_id`,
    [burnEventId]
  );
  return r.rows.map(row => Number(row.burned_token_id)).sort((a, b) => a - b);
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const survivorIds = await getSurvivorIds(pool);

  console.log(`${WRITE ? 'WRITE MODE' : 'DRY RUN'} — checking ${survivorIds.length} survivor(s)`);

  let checked = 0, correct = 0, fixed = 0, skippedMismatch = 0;
  const mismatchedSurvivors = [];

  for (const survivorId of survivorIds) {
    const starts = await getStarts(pool, survivorId);
    const finalizes = await getFinalizes(pool, survivorId);

    if (starts.length !== finalizes.length) {
      skippedMismatch++;
      mismatchedSurvivors.push({ survivorId, starts: starts.length, finalizes: finalizes.length });
      continue;
    }

    for (let i = 0; i < finalizes.length; i++) {
      checked++;
      const finalize = finalizes[i];
      const correctTokenIds = starts[i].tokenIds;
      const currentTokenIds = await getCurrentInputs(pool, finalize.id);

      if (arraysEqual(correctTokenIds, currentTokenIds)) {
        correct++;
        continue;
      }

      fixed++;
      console.log(`\n  Survivor #${survivorId}, burn_event #${finalize.id} (tx ${finalize.tx_hash}):`);
      console.log(`    current (wrong):  [${currentTokenIds.join(',')}]`);
      console.log(`    correct:          [${correctTokenIds.join(',')}]`);

      if (WRITE) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`DELETE FROM burn_event_inputs WHERE burn_event_id=$1`, [finalize.id]);
          for (const tokenId of correctTokenIds) {
            await client.query(
              `INSERT INTO burn_event_inputs (burn_event_id, burned_token_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [finalize.id, tokenId]
            );
          }
          // Keep matched_burn_event_id consistent with the live fix so future
          // runs of this script (or the bot's own fallback logic) don't get
          // confused about which starts are already accounted for.
          await client.query(
            `UPDATE burn_started_events SET matched_burn_event_id=$1 WHERE id=$2`,
            [finalize.id, starts[i].id]
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          console.warn(`    DB write failed for burn_event #${finalize.id}:`, e.message);
        } finally {
          client.release();
        }
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Checked: ${checked} finalize/start pairs across ${survivorIds.length - skippedMismatch} survivor(s)`);
  console.log(`Already correct: ${correct}`);
  console.log(`${WRITE ? 'Fixed' : 'Would fix'}: ${fixed}`);
  console.log(`Skipped (start/finalize count mismatch, needs manual review): ${skippedMismatch}`);
  if (mismatchedSurvivors.length) {
    console.log(`\nSurvivors with mismatched counts (not touched):`);
    for (const m of mismatchedSurvivors) {
      console.log(`  #${m.survivorId}: ${m.starts} start(s) vs ${m.finalizes} finalize(s)`);
    }
  }
  if (!WRITE && fixed > 0) {
    console.log(`\nRe-run with WRITE=true to apply these ${fixed} fix(es).`);
  }

  await pool.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
