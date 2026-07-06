/**
 * Backfill tokens.image_url for burn survivors that were burned BEFORE the
 * 2026-07-02 fix (lib/burn-poller.js line ~838) started keeping this column
 * live. Confirmed via check-live-metadata-gaps.js: 29 tokens, all burned
 * between May 22-26 2026, still have image_url=NULL despite having correct
 * (already-updated) traits — so TraitView's grid shows the right traits but
 * the WRONG (stale, pre-burn) thumbnail for these specific 29 tokens.
 *
 * Deliberately narrow: writes ONLY tokens.image_url. Does not touch
 * token_traits or token_image_snapshots — those are already correct for
 * these tokens (traits display fine today), so there's no reason to re-write
 * them and no reason to risk it.
 *
 * Mirrors the exact fetch pattern burn-poller.js already uses for new burns:
 * fetchTokenUriFromContract() for current on-chain state, getTraitImageSource()
 * to pull the image out of it, UPDATE tokens SET image_url=... WHERE id=... .
 *
 * ENV REQUIRED
 * - DATABASE_URL
 * - Whatever burnRpcUrl() needs (see lib/rpc.js) — same as burn-poller.js
 *
 * USAGE
 *   Dry run first (default):
 *     node backfill-missing-survivor-images.js
 *   Actually write:
 *     WRITE=true node backfill-missing-survivor-images.js
 *   Optional: target specific IDs instead of re-querying for the gap:
 *     IDS=1042,614,993 node backfill-missing-survivor-images.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const { fetchTokenUriFromContract, getTraitImageSource } = require('./lib/rpc');

const OCAS_SLUG = 'on-chain-all-stars';
const WRITE = String(process.env.WRITE || 'false').toLowerCase() === 'true';

async function getGapIds(pool) {
  if (process.env.IDS) {
    return process.env.IDS.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
  }
  const r = await pool.query(`
    SELECT DISTINCT be.survivor_token_id AS token_id
    FROM burn_events be
    LEFT JOIN tokens t ON t.id = be.survivor_token_id AND t.collection_slug = $1
    WHERE t.image_url IS NULL
    ORDER BY token_id ASC
  `, [OCAS_SLUG]);
  return r.rows.map(row => parseInt(row.token_id, 10));
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ids = await getGapIds(pool);

  console.log(`${WRITE ? 'WRITE MODE' : 'DRY RUN'} — ${ids.length} token(s) to process`);
  if (!ids.length) { await pool.end(); return; }

  let fetched = 0, wrote = 0, failed = 0;
  for (const id of ids) {
    const traits = await fetchTokenUriFromContract(id).catch(() => null);
    const img = traits ? getTraitImageSource(traits) : null;
    if (!img) {
      console.warn(`  #${id}: could not fetch current image from contract — skipped`);
      failed++;
      continue;
    }
    fetched++;
    console.log(`  #${id}: fetched image (${img.slice(0, 60)}${img.length > 60 ? '...' : ''})`);
    if (WRITE) {
      try {
        await pool.query(`UPDATE tokens SET image_url=$1 WHERE id=$2 AND collection_slug=$3`, [img, id, OCAS_SLUG]);
        wrote++;
      } catch (e) {
        console.warn(`  #${id}: DB write failed —`, e.message);
        failed++;
      }
    }
    // Light rate limit, same spirit as the burn-lottery/rank-sync scripts
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone. fetched=${fetched} wrote=${wrote} failed=${failed}${WRITE ? '' : ' (dry run — nothing written, re-run with WRITE=true)'}`);
  await pool.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
