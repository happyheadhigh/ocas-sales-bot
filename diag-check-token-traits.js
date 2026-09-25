/**
 * Diagnostic only -- no writes. /traitfind reports "no trait data found for
 * on-chain-all-stars" on production. /db/trait-index's OCAS-specific branch
 * queries token_traits WHERE collection_slug = 'on-chain-all-stars' -- given
 * the pattern seen repeatedly tonight (production's tables predating
 * multi-collection support, missing the collection_slug values the new
 * multi-collection-aware code expects), checking whether token_traits
 * actually has real data, just with collection_slug NULL/missing on the
 * existing rows, before assuming the table is genuinely empty.
 *
 * USAGE
 *   node diag-check-token-traits.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== token_traits row counts ===\n');
  const totalRes = await pool.query(`SELECT COUNT(*) AS total FROM token_traits`);
  console.log(`  Total rows in token_traits: ${totalRes.rows[0].total}`);

  const bySlugRes = await pool.query(`
    SELECT collection_slug, COUNT(*)::int AS row_count
    FROM token_traits
    GROUP BY collection_slug
    ORDER BY row_count DESC
  `);
  console.log('\n  Breakdown by collection_slug value:');
  for (const r of bySlugRes.rows) {
    console.log(`    ${r.collection_slug === null ? '(NULL)' : `"${r.collection_slug}"`}: ${r.row_count} rows`);
  }

  console.log('\n=== Sample rows (first 3, regardless of collection_slug) ===\n');
  const sampleRes = await pool.query(`SELECT token_id, trait_name, trait_value, collection_slug FROM token_traits LIMIT 3`);
  for (const r of sampleRes.rows) {
    console.log(`  token_id=${r.token_id} trait_name=${r.trait_name} trait_value=${r.trait_value} collection_slug=${r.collection_slug === null ? '(NULL)' : r.collection_slug}`);
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
