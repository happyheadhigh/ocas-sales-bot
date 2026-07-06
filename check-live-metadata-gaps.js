/**
 * Diagnostic only — makes no writes. Run against staging or production to
 * answer two open questions from the 2026-07-05/06 TraitView metadata review:
 *
 * 1. What are the REAL columns on token_image_snapshots? lib/db.js's CREATE
 *    TABLE stub says (token_id, image_url, image_source, updated_at), but
 *    every real read/write site (lib/images.js, lib/embeds.js) uses
 *    (token_id, image_data, traits_json, source, updated_at). This confirms
 *    which one is actually true on this database before anything in api.js
 *    that reads image_data/source goes live.
 *
 * 2. Are there burn survivors whose tokens.image_url is still NULL despite
 *    having gone through a finalized burn? tokens.image_url only started
 *    being written by lib/burn-poller.js "since the 2026-07-02 fix" per the
 *    comment in api.js's /db/all-traits — this checks whether anything
 *    burned BEFORE that fix ever got backfilled, or is still silently
 *    showing a stale/original image in the main grid despite having
 *    correct (already-updated) traits.
 *
 * USAGE
 *   DATABASE_URL=... node check-live-metadata-gaps.js
 *
 * Safe to run repeatedly; only SELECTs, never writes.
 */

require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  console.log('=== 1. token_image_snapshots actual columns ===');
  const cols = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'token_image_snapshots'
    ORDER BY ordinal_position
  `);
  if (!cols.rows.length) {
    console.log('  Table not found (or no permission) — check table name / connection.');
  } else {
    for (const r of cols.rows) console.log(`  ${r.column_name} (${r.data_type})`);
  }

  console.log('\n=== 2. Burn survivors with NULL tokens.image_url ===');
  // A survivor is any token_id that appears as be.survivor_token_id at least
  // once. If tokens.image_url is still null for one of these, the main grid
  // is falling back to the static original-mint image for a token whose
  // appearance has actually changed — a real display mismatch versus its
  // (correctly updated) traits.
  const gap = await pool.query(`
    SELECT DISTINCT be.survivor_token_id AS token_id,
           t.image_url,
           MIN(be.burned_at) AS first_burn_at,
           MAX(be.burned_at) AS last_burn_at,
           COUNT(be.id)::int AS burn_count
    FROM burn_events be
    LEFT JOIN tokens t ON t.id = be.survivor_token_id AND t.collection_slug = 'on-chain-all-stars'
    WHERE t.image_url IS NULL
    GROUP BY be.survivor_token_id, t.image_url
    ORDER BY first_burn_at ASC
  `);
  if (!gap.rows.length) {
    console.log('  None found — every burn survivor has an image_url on file. No gap.');
  } else {
    console.log(`  ${gap.rows.length} survivor token(s) with NULL image_url despite being burn survivors:`);
    for (const r of gap.rows) {
      console.log(`    #${r.token_id} — burned ${r.burn_count}x, first ${r.first_burn_at}, last ${r.last_burn_at}`);
    }
    console.log('\n  These will show their static original-mint image in TraitView\'s grid');
    console.log('  (correct traits, wrong thumbnail) until tokens.image_url is backfilled for them.');
  }

  await pool.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
