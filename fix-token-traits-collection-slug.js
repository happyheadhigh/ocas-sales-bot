/**
 * Fixes /traitfind reporting "no trait data found for on-chain-all-stars"
 * on production. Confirmed via diag-check-token-traits.js: all 74,872 rows
 * in token_traits have collection_slug = NULL -- the real trait data is
 * entirely there, just predates when this column was added. token_traits
 * is architecturally OCAS-only (non-OCAS collections use a completely
 * separate table, collection_traits, per /db/trait-index's own branching
 * logic), so every NULL row here is safely known to be OCAS data.
 *
 * Only touches rows where collection_slug IS NULL -- any row that already
 * has a value (shouldn't exist today, but harmless if it ever does) is
 * left untouched.
 *
 * Defaults to a dry run (shows the count that would be updated, changes
 * nothing). Set WRITE=true to actually apply it.
 *
 * USAGE
 *   node fix-token-traits-collection-slug.js                  (dry run)
 *   WRITE=true node fix-token-traits-collection-slug.js        (applies it)
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const OCAS_SLUG = 'on-chain-all-stars';
const WRITE = process.env.WRITE === 'true';

async function main() {
  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM token_traits WHERE collection_slug IS NULL`);
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
    `UPDATE token_traits SET collection_slug = $1 WHERE collection_slug IS NULL`,
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
