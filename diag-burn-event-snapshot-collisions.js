/**
 * Diagnostic only -- no writes. New hypothesis: the "Burned" row's image
 * selection logic traces correctly on paper for #1271's real block numbers
 * (confirmed by hand against diag-token-burn-history.js's output), so the
 * bug may actually be in the SURVIVOR slot instead -- specifically, whether
 * burn_state_snapshots ever has more than one row per burn_event_id (for
 * DIFFERENT token_ids). If so, /db/wallet/:address/burn-stats' survivorSnapMap
 * (keyed only by burn_event_id, no token_id filter) could silently grab
 * whichever row happens to be last in the result set -- the wrong token's
 * image entirely, not just the wrong point in time.
 *
 * USAGE
 *   node diag-burn-event-snapshot-collisions.js [eventId1] [eventId2] ...
 *   (no args = scan the whole table for any burn_event_id with >1 row)
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const specificIds = process.argv.slice(2).map(n => parseInt(n, 10)).filter(Number.isFinite);

  if (specificIds.length) {
    console.log(`\n=== Rows in burn_state_snapshots for specific event(s): ${specificIds.join(', ')} ===\n`);
    const res = await pool.query(
      `SELECT burn_event_id, token_id, image_data IS NOT NULL AS has_image, LENGTH(image_data) AS image_len
       FROM burn_state_snapshots WHERE burn_event_id = ANY($1::int[]) ORDER BY burn_event_id, token_id`,
      [specificIds]
    );
    for (const r of res.rows) {
      console.log(`  burn_event_id=${r.burn_event_id}  token_id=${r.token_id}  has_image=${r.has_image}  image_len=${r.image_len}`);
    }
    const counts = {};
    for (const r of res.rows) counts[r.burn_event_id] = (counts[r.burn_event_id] || 0) + 1;
    console.log('\n--- Row count per event ---');
    for (const [id, count] of Object.entries(counts)) {
      console.log(`  burn_event_id=${id}: ${count} row(s)${count > 1 ? '  <-- MULTIPLE ROWS, this is the bug if so' : ''}`);
    }
  } else {
    console.log('\n=== Scanning entire burn_state_snapshots table for any burn_event_id with >1 row ===\n');
    const res = await pool.query(
      `SELECT burn_event_id, COUNT(*) AS row_count, array_agg(DISTINCT token_id) AS token_ids
       FROM burn_state_snapshots GROUP BY burn_event_id HAVING COUNT(*) > 1 ORDER BY burn_event_id LIMIT 50`
    );
    if (!res.rows.length) {
      console.log('No burn_event_id has more than one row -- this hypothesis is ruled out.');
    } else {
      console.log(`Found ${res.rows.length} burn_event_id(s) with multiple rows (showing up to 50):\n`);
      for (const r of res.rows) {
        console.log(`  burn_event_id=${r.burn_event_id}  row_count=${r.row_count}  token_ids=${r.token_ids.join(',')}`);
      }
    }
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
