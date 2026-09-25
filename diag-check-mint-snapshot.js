/**
 * Diagnostic only -- no writes. Checking a specific hypothesis: for token
 * #901, event 146's resolveInputImage() correctly determined there's no
 * PRIOR burn_state_snapshot (901's first-ever burn appearance) and fell
 * back to the mint-time image -- but what's actually rendered is 901's
 * CURRENT (post-burn, evolved) look instead of its true mint state. That
 * only makes sense if the mint-time fallback itself is silently missing/
 * null, causing the whole resolveInputImage() call to return null overall,
 * which the frontend then falls through to a live/current lookup for
 * (burnsTokenChip's behavior when passed a null override).
 *
 * USAGE
 *   node diag-check-mint-snapshot.js <tokenId>
 */

require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const tokenId = parseInt(process.argv[2], 10);
if (!Number.isFinite(tokenId)) {
  console.log('Usage: node diag-check-mint-snapshot.js <tokenId>');
  process.exit(1);
}

function hash(s) { return s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) : null; }

async function main() {
  console.log(`\n=== Token #${tokenId} — mint-time snapshot check ===\n`);

  const rawRes = await pool.query(
    `SELECT token_id, image_data IS NULL AS image_is_null, LENGTH(image_data) AS image_len
     FROM token_image_snapshots WHERE token_id=$1`,
    [tokenId]
  );
  if (!rawRes.rows.length) {
    console.log('NO ROW AT ALL in token_image_snapshots for this token_id.');
    console.log('This confirms the hypothesis: fetchInputSnapshots() would return nothing for');
    console.log('this token, resolveInputImage() returns null overall, and the frontend falls');
    console.log('through to a live/current image lookup instead of showing "no snapshot available".');
  } else {
    const row = rawRes.rows[0];
    console.log(`Row exists. image_data IS NULL: ${row.image_is_null}   length: ${row.image_len}`);
    if (row.image_is_null) {
      console.log('\nCONFIRMED: a row exists but image_data is NULL. fetchInputSnapshots() filters');
      console.log('with "AND image_data IS NOT NULL", so this row is silently excluded from its');
      console.log('results -- same end effect as no row at all. This is the bug.');
    } else {
      console.log('\nRow exists WITH a real image. Hypothesis does not hold for this token --');
      console.log('need to check exactly what fetchInputSnapshots()/resolveInputImage() actually');
      console.log('does with this data instead, since the fallback data itself looks fine.');
    }
  }

  // Also check: is there a burn_state_snapshots row for this token from
  // this token's OWN first burn appearance that could be getting mixed up?
  const bssRes = await pool.query(
    `SELECT bss.burn_event_id, be.block_number, LENGTH(bss.image_data) AS image_len
     FROM burn_state_snapshots bss JOIN burn_events be ON be.id = bss.burn_event_id
     WHERE bss.token_id=$1 ORDER BY be.block_number ASC`,
    [tokenId]
  );
  console.log(`\n--- burn_state_snapshots rows for this token (${bssRes.rows.length}) ---`);
  for (const r of bssRes.rows) {
    console.log(`  burn_event_id=${r.burn_event_id}  block=${r.block_number}  image_len=${r.image_len}`);
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
