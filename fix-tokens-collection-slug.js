/**
 * Fixes /traitfind reporting no matching tokens for any selected trait
 * value, even though the category/value lists themselves display
 * correctly. Confirmed via diag-check-tokens-table.js: all 10,000 rows in
 * `tokens` (exactly OCAS's total supply) have collection_slug = NULL,
 * predating multi-collection support -- same root cause and same fix
 * pattern as last night's token_traits/listings/sales repairs.
 * /db/multi-trait-tokens's default query path filters
 * WHERE t.collection_slug = 'on-chain-all-stars', which excludes every
 * row when this column is NULL, regardless of the actual trait match.
 *
 * Only touches rows where collection_slug IS NULL. Defaults to a dry run.
 * Set WRITE=true to actually apply it.
 *
 * USAGE
 *   node fix-tokens-collection-slug.js                  (dry run)
 *   WRITE=true node fix-tokens-collection-slug.js        (applies it)
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const OCAS_SLUG = 'on-chain-all-stars';
const WRITE = process.env.WRITE === 'true';

async function main() {
  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM tokens WHERE collection_slug IS NULL`);
  const total = parseInt(countRes.rows[0].total);
  console.log(`Rows with NULL collection_slug: ${total}`);

  if (!total) {
    console.log('Nothing to do.');
    return;
  }

  if (!WRITE) {
    console.log(`\nDRY RUN -- would set collection_slug = '${OCAS_SLUG}' on all ${total} rows above.`);
    console.log('Re-run with WRITE=true to actually apply it.');
    return;
  }

  console.log(`\nWRITE=true -- updating ${total} rows...`);
  const res = await pool.query(
    `UPDATE tokens SET collection_slug = $1 WHERE collection_slug IS NULL`,
    [OCAS_SLUG]
  );
  console.log(`Updated ${res.rowCount} row(s) (expected ${total}).`);
  if (res.rowCount !== total) {
    console.log('NOTE: actual updated count did not match expected -- worth double-checking manually.');
  } else {
    console.log('Counts match exactly. Repair complete.');
  }
}

main().then(() => pool.end()).catch(e => { console.error('Failed:', e.message); pool.end(); process.exit(1); });
