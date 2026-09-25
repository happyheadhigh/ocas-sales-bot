/**
 * Fixes the deployment error on ocas-production-api's first post-merge
 * deploy: "there is no unique or exclusion constraint matching the ON
 * CONFLICT specification" on both listings sync and sales sync.
 *
 * Confirmed via diag-check-conflict-constraints.js: production's listings
 * table only has a primary key on (token_id) alone, and sales only has a
 * unique constraint on (token_id, sale_ts) -- both missing collection_slug.
 * This is leftover from before multi-collection support existed; production
 * has only ever tracked one collection (OCAS), so every existing row
 * already trivially satisfies the new, wider constraints.
 *
 * ADDITIVE ONLY -- does not drop or modify either existing constraint
 * (listings_pkey, sales_pkey, sales_token_sale_uniq all stay exactly as
 * they are). Just adds the two new constraints the merged code's ON
 * CONFLICT clauses actually need:
 *   - listings: UNIQUE (token_id, collection_slug)
 *   - sales:    UNIQUE (token_id, sale_ts, collection_slug)
 *
 * Idempotent -- checks whether each constraint already exists before
 * adding it, safe to run more than once.
 *
 * USAGE
 *   node fix-listings-sales-conflict-constraints.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function constraintExists(constraintName) {
  const res = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1`,
    [constraintName]
  );
  return res.rows.length > 0;
}

async function main() {
  console.log('=== listings: adding UNIQUE (token_id, collection_slug) ===');
  if (await constraintExists('listings_token_collection_uniq')) {
    console.log('  Already exists, skipping.');
  } else {
    await pool.query(`ALTER TABLE listings ADD CONSTRAINT listings_token_collection_uniq UNIQUE (token_id, collection_slug)`);
    console.log('  Added.');
  }

  console.log('\n=== sales: adding UNIQUE (token_id, sale_ts, collection_slug) ===');
  if (await constraintExists('sales_token_sale_collection_uniq')) {
    console.log('  Already exists, skipping.');
  } else {
    await pool.query(`ALTER TABLE sales ADD CONSTRAINT sales_token_sale_collection_uniq UNIQUE (token_id, sale_ts, collection_slug)`);
    console.log('  Added.');
  }

  console.log('\nDone. Existing constraints (listings_pkey, sales_pkey, sales_token_sale_uniq) were not touched.');
}

main().then(() => pool.end()).catch(e => {
  console.error('Failed:', e.message);
  console.error('\nIf this failed with a duplicate-key/uniqueness violation, that means some');
  console.error('existing rows genuinely collide on the new constraint -- a real data issue');
  console.error('to look at, not something to force through.');
  pool.end();
  process.exit(1);
});
