/**
 * Diagnostic only -- no writes. /traitfind runs without erroring now (the
 * buildCtx fix from last night), but selecting a value reports no matching
 * tokens. Traced the query: /db/multi-trait-tokens's default (non-listed)
 * path queries FROM tokens t WHERE t.collection_slug = $slug -- a
 * completely different table than the token_traits/listings/sales tables
 * fixed last night. Checking whether `tokens` has the same "predates
 * multi-collection support, collection_slug never populated" issue before
 * assuming anything.
 *
 * USAGE
 *   node diag-check-tokens-table.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== tokens table row counts ===\n');
  const totalRes = await pool.query(`SELECT COUNT(*) AS total FROM tokens`);
  console.log(`  Total rows in tokens: ${totalRes.rows[0].total}`);

  const bySlugRes = await pool.query(`
    SELECT collection_slug, COUNT(*)::int AS row_count
    FROM tokens
    GROUP BY collection_slug
    ORDER BY row_count DESC
  `);
  console.log('\n  Breakdown by collection_slug value:');
  for (const r of bySlugRes.rows) {
    console.log(`    ${r.collection_slug === null ? '(NULL)' : `"${r.collection_slug}"`}: ${r.row_count} rows`);
  }

  console.log('\n=== Sample rows (first 3) ===\n');
  const sampleRes = await pool.query(`SELECT id, os_rank, collection_slug FROM tokens LIMIT 3`);
  for (const r of sampleRes.rows) {
    console.log(`  id=${r.id} os_rank=${r.os_rank} collection_slug=${r.collection_slug === null ? '(NULL)' : r.collection_slug}`);
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
