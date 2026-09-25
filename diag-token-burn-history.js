/**
 * Diagnostic only -- no writes. Traces every burn_events/burn_event_inputs/
 * burn_state_snapshots row touching a specific token, in chronological order,
 * to see exactly what data exists for it. Built because the wallet burn-stats
 * "Burned" row is reportedly still showing the wrong (current-looking) image
 * for a token that's been both a survivor and a later input -- despite a
 * fix already built for this exact scenario (resolveInputImage in
 * /db/wallet/:address/burn-stats). Need to see the real rows rather than
 * guess a second time why it's not working.
 *
 * USAGE
 *   node diag-token-burn-history.js <tokenId>
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const tokenId = parseInt(process.argv[2], 10);
if (!Number.isFinite(tokenId)) {
  console.log('Usage: node diag-token-burn-history.js <tokenId>');
  process.exit(1);
}

async function main() {
  console.log(`\n=== Token #${tokenId} — every place it appears in burn history ===\n`);

  const survivorRes = await pool.query(
    `SELECT id, block_number, burned_at, burner_wallet FROM burn_events WHERE survivor_token_id=$1 ORDER BY block_number ASC`,
    [tokenId]
  );
  console.log(`--- As SURVIVOR (${survivorRes.rows.length} event(s)) ---`);
  for (const r of survivorRes.rows) {
    console.log(`  burn_event_id=${r.id}  block=${r.block_number}  burned_at=${r.burned_at}  by=${r.burner_wallet}`);
  }

  const inputRes = await pool.query(
    `SELECT bei.burn_event_id, be.block_number, be.burned_at, be.survivor_token_id, be.burner_wallet
     FROM burn_event_inputs bei
     JOIN burn_events be ON be.id = bei.burn_event_id
     WHERE bei.burned_token_id=$1
     ORDER BY be.block_number ASC`,
    [tokenId]
  );
  console.log(`\n--- As INPUT (fed into a burn) (${inputRes.rows.length} event(s)) ---`);
  for (const r of inputRes.rows) {
    console.log(`  burn_event_id=${r.burn_event_id}  block=${r.block_number}  burned_at=${r.burned_at}  survivor_of_THIS_event=${r.survivor_token_id}  by=${r.burner_wallet}`);
  }

  const snapRes = await pool.query(
    `SELECT bss.burn_event_id, be.block_number, bss.image_data IS NOT NULL AS has_image, LENGTH(bss.image_data) AS image_len
     FROM burn_state_snapshots bss
     JOIN burn_events be ON be.id = bss.burn_event_id
     WHERE bss.token_id=$1
     ORDER BY be.block_number ASC`,
    [tokenId]
  );
  console.log(`\n--- burn_state_snapshots rows for this token_id (${snapRes.rows.length} row(s)) ---`);
  for (const r of snapRes.rows) {
    console.log(`  burn_event_id=${r.burn_event_id}  block=${r.block_number}  has_image=${r.has_image}  image_len=${r.image_len}`);
  }

  const origRes = await pool.query(
    `SELECT image_data IS NOT NULL AS has_image, LENGTH(image_data) AS image_len FROM token_image_snapshots WHERE token_id=$1`,
    [tokenId]
  );
  console.log(`\n--- token_image_snapshots (mint-time fallback) ---`);
  if (origRes.rows.length) {
    console.log(`  has_image=${origRes.rows[0].has_image}  image_len=${origRes.rows[0].image_len}`);
  } else {
    console.log('  (no row at all)');
  }

  console.log('\n=== How to read this ===');
  console.log('For each "As INPUT" row above, the correct image is whichever "As SURVIVOR"');
  console.log('row has the LARGEST block_number that is still LESS than that input row\'s');
  console.log('block_number -- i.e. what this token looked like the last time it became a');
  console.log('survivor, strictly before being fed into that particular burn. If no such');
  console.log('survivor row exists before a given input row, the mint-time fallback should');
  console.log('be used instead. Compare the block numbers above to see whether the actual');
  console.log('logic should be picking a different snapshot than it appears to be showing.');
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
