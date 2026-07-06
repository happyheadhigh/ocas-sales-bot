/**
 * Diagnostic only — no writes. Investigating a reported bug: the bot's
 * "Before Burn N" slideshow (bot.js ~line 1890-1945) is showing #2007's
 * CURRENT appearance for "Before Burn 2" instead of its actual state right
 * after Burn 1. That slideshow reads burn_state_snapshots keyed by
 * burn_event_id + token_id, and token_original_snapshots for burn 1's
 * pre-state. Neither the image backfill (backfill-missing-survivor-images.js)
 * nor the burn_event_inputs repair (repair-burn-event-inputs.js) touched
 * burn_state_snapshots directly, so this checks what's actually stored there
 * rather than assuming a connection.
 *
 * USAGE
 *   SURVIVOR=2007 node check-burn-state-snapshots.js
 */

require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const survivorId = parseInt(process.env.SURVIVOR || '2007', 10);

  console.log(`=== burn_events for survivor #${survivorId} (chronological) ===`);
  const events = await pool.query(
    `SELECT id, tx_hash, burned_at FROM burn_events WHERE survivor_token_id=$1 ORDER BY burned_at ASC`,
    [survivorId]
  );
  events.rows.forEach((r, i) => console.log(`  Burn ${i + 1}: burn_event_id=${r.id} tx=${r.tx_hash} at=${r.burned_at}`));

  console.log(`\n=== token_original_snapshots for #${survivorId} (used as Burn 1's "before" state) ===`);
  const mint = await pool.query(
    `SELECT token_id, image_data IS NOT NULL AS has_image, traits_json, updated_at
     FROM token_original_snapshots WHERE token_id=$1`,
    [survivorId]
  ).catch(e => ({ rows: [], error: e.message }));
  if (mint.error) console.log(`  Query failed: ${mint.error} (column names may differ — check actual schema)`);
  else if (!mint.rows.length) console.log('  No row found.');
  else console.log(`  has_image=${mint.rows[0].has_image} traits=${JSON.stringify(mint.rows[0].traits_json)} updated_at=${mint.rows[0].updated_at}`);

  console.log(`\n=== burn_state_snapshots for #${survivorId} (one per burn_event, in theory) ===`);
  const states = await pool.query(
    `SELECT burn_event_id, image_data IS NOT NULL AS has_image, traits_json, created_at
     FROM burn_state_snapshots WHERE token_id=$1 ORDER BY created_at ASC`,
    [survivorId]
  );
  if (!states.rows.length) console.log('  No rows found at all — "Before Burn 2+" would show no image, not current data.');
  for (const r of states.rows) {
    console.log(`  burn_event_id=${r.burn_event_id} has_image=${r.has_image} traits=${JSON.stringify(r.traits_json)} created_at=${r.created_at}`);
  }

  const eventIds = events.rows.map(r => r.id);
  const snapEventIds = states.rows.map(r => r.burn_event_id);
  console.log(`\n=== Coverage check ===`);
  console.log(`burn_events ids (chronological): [${eventIds.join(',')}]`);
  console.log(`burn_state_snapshots cover these burn_event_ids: [${snapEventIds.join(',')}]`);
  const missing = eventIds.slice(0, -1).filter(id => !snapEventIds.includes(id)); // last event's "after" state isn't needed for this slideshow
  if (missing.length) {
    console.log(`  Missing a state snapshot for burn_event_id(s): [${missing.join(',')}] — any "Before Burn N" that`);
    console.log(`  depends on one of these would currently show NO image per the code's own logic (snap stays null).`);
  } else {
    console.log('  Every burn (except possibly the last) has a state snapshot on file.');
  }
  const dupes = snapEventIds.filter((id, i) => snapEventIds.indexOf(id) !== i);
  if (dupes.length) {
    console.log(`\n  DUPLICATE burn_event_id(s) in burn_state_snapshots: [${[...new Set(dupes)].join(',')}]`);
    console.log('  If a burn_event_id has more than one row, stateSnapMap[burn_event_id] in bot.js only keeps');
    console.log('  the LAST one iterated (object key overwrite) — worth checking which one that ends up being.');
  }

  await pool.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
