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
  // once. BUT a token that survived one burn can later be fed as INPUT into
  // a completely different burn (re-burned by its owner down the line) --
  // at that point it's truly destroyed, not just "missing an image update".
  // The first version of this script didn't account for that and mis-flagged
  // those as live-survivor gaps (confirmed empirically: backfill-missing-
  // survivor-images.js got "execution reverted: URI query for nonexistent
  // token" from the contract for several of them). This version excludes
  // any token_id that shows up as a LATER burned_token_id anywhere, so what's
  // left is only genuinely-still-alive survivors.
  const gap = await pool.query(`
    SELECT DISTINCT be.survivor_token_id AS token_id,
           t.image_url,
           MIN(be.burned_at) AS first_burn_at,
           MAX(be.burned_at) AS last_burn_at,
           COUNT(be.id)::int AS burn_count
    FROM burn_events be
    LEFT JOIN tokens t ON t.id = be.survivor_token_id AND t.collection_slug = 'on-chain-all-stars'
    WHERE t.image_url IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM burn_event_inputs bei2
        JOIN burn_events be2 ON be2.id = bei2.burn_event_id
        WHERE bei2.burned_token_id = be.survivor_token_id
          AND bei2.burned_token_id != be2.survivor_token_id
      )
    GROUP BY be.survivor_token_id, t.image_url
    ORDER BY first_burn_at ASC
  `);
  if (!gap.rows.length) {
    console.log('  None found — every currently-alive burn survivor has an image_url on file. No gap.');
  } else {
    console.log(`  ${gap.rows.length} genuinely-alive survivor token(s) with NULL image_url:`);
    for (const r of gap.rows) {
      console.log(`    #${r.token_id} — burned ${r.burn_count}x, first ${r.first_burn_at}, last ${r.last_burn_at}`);
    }
    console.log('\n  These will show their static original-mint image in TraitView\'s grid');
    console.log('  (correct traits, wrong thumbnail) until tokens.image_url is backfilled for them.');
  }

  console.log('\n=== 3. Survivors later destroyed (re-burned as input elsewhere) ===');
  // These are the ones excluded from #2 above -- confirming they're real and
  // showing where. Their image_url being NULL is expected/harmless for the
  // main grid (BURNED_EXCL already hides them), but they're worth knowing
  // about for Burns analytics' "Best Survivors" display, which currently
  // shows their live/current image with no override -- meaningless for a
  // token that no longer has a "current" state.
  const laterDestroyed = await pool.query(`
    SELECT DISTINCT be.survivor_token_id AS token_id,
           be2.tx_hash AS destroyed_in_tx, be2.burned_at AS destroyed_at
    FROM burn_events be
    JOIN burn_event_inputs bei2 ON bei2.burned_token_id = be.survivor_token_id
    JOIN burn_events be2 ON be2.id = bei2.burn_event_id AND bei2.burned_token_id != be2.survivor_token_id
    ORDER BY destroyed_at ASC
  `);
  if (!laterDestroyed.rows.length) {
    console.log('  None found.');
  } else {
    for (const r of laterDestroyed.rows) {
      console.log(`    #${r.token_id} — later destroyed in tx ${r.destroyed_in_tx} at ${r.destroyed_at}`);
    }
  }

  await pool.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
