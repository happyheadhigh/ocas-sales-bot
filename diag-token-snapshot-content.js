/**
 * Diagnostic only -- no writes. Follow-up to diag-token-burn-history.js:
 * every burn_state_snapshots row (and the mint-time fallback) for token
 * #1271 had the identical image_len=5430 across 6 separate burn events
 * spanning May 24 - June 5. That's suspicious enough to be a real data
 * problem rather than coincidence, but same LENGTH doesn't strictly prove
 * identical CONTENT -- this hashes the actual image_data for each row to
 * confirm definitively one way or the other before concluding anything.
 *
 * USAGE
 *   node diag-token-snapshot-content.js <tokenId>
 */

require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const tokenId = parseInt(process.argv[2], 10);
if (!Number.isFinite(tokenId)) {
  console.log('Usage: node diag-token-snapshot-content.js <tokenId>');
  process.exit(1);
}

function hash(s) {
  return crypto.createHash('sha256').update(s || '').digest('hex').slice(0, 12);
}

async function main() {
  console.log(`\n=== Token #${tokenId} — actual content comparison ===\n`);

  const snapRes = await pool.query(
    `SELECT bss.burn_event_id, be.block_number, bss.image_data
     FROM burn_state_snapshots bss
     JOIN burn_events be ON be.id = bss.burn_event_id
     WHERE bss.token_id=$1
     ORDER BY be.block_number ASC`,
    [tokenId]
  );

  const origRes = await pool.query(
    `SELECT image_data FROM token_image_snapshots WHERE token_id=$1`,
    [tokenId]
  );

  console.log('--- Mint-time (token_image_snapshots) ---');
  const origHash = origRes.rows[0] ? hash(origRes.rows[0].image_data) : null;
  console.log(`  hash=${origHash}`);

  console.log('\n--- burn_state_snapshots, in chronological order ---');
  const hashes = [];
  for (const r of snapRes.rows) {
    const h = hash(r.image_data);
    hashes.push(h);
    const matchesMint = h === origHash ? '  <-- IDENTICAL to mint-time image' : '';
    console.log(`  burn_event_id=${r.burn_event_id}  block=${r.block_number}  hash=${h}${matchesMint}`);
  }

  const allSame = hashes.every(h => h === hashes[0]) && hashes[0] === origHash;
  const allSameAmongThemselves = hashes.every(h => h === hashes[0]);

  console.log('\n=== Verdict ===');
  if (allSame) {
    console.log('CONFIRMED: every burn_state_snapshots row AND the mint-time image are byte-');
    console.log('identical. This token\'s stored "after burn N" images are not real point-in-');
    console.log('time captures at all -- something is writing the same (likely mint-time)');
    console.log('image into every burn_state_snapshots row instead of capturing what the');
    console.log('token actually looked like at each specific burn.');
  } else if (allSameAmongThemselves) {
    console.log('All burn_state_snapshots rows are identical to EACH OTHER, but differ from');
    console.log('the mint-time image. So something IS being captured, but the same wrong (or');
    console.log('stale) value is being reused for every single burn instead of a fresh one');
    console.log('each time.');
  } else {
    console.log('Snapshots are NOT all identical -- at least some genuine variation exists.');
    console.log('The earlier same-length finding may have been coincidental for this specific');
    console.log('token, or only some of the writes were affected. Worth checking a few more');
    console.log('multi-burn tokens the same way before concluding this is (or isn\'t) systemic.');
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
