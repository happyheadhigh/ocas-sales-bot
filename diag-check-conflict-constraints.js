/**
 * Diagnostic only -- no writes. ocas-production-api's first deployment after
 * the bot-modular merge threw "there is no unique or exclusion constraint
 * matching the ON CONFLICT specification" on both listings sync and sales
 * sync. sync-listings.js expects:
 *   - listings: ON CONFLICT (token_id, collection_slug)
 *   - sales:    ON CONFLICT (token_id, sale_ts, collection_slug)
 * This checks what unique constraints/indexes actually exist on production's
 * listings and sales tables right now, to find the exact gap rather than
 * guess at a migration.
 *
 * USAGE
 *   node diag-check-conflict-constraints.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function checkTable(tableName) {
  console.log(`\n=== Unique constraints/indexes on "${tableName}" ===\n`);
  const res = await pool.query(`
    SELECT
      i.relname AS index_name,
      ix.indisunique AS is_unique,
      ix.indisprimary AS is_primary,
      array_agg(a.attname::text ORDER BY array_position(ix.indkey, a.attnum)) AS columns
    FROM pg_class t
    JOIN pg_index ix ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE t.relname = $1 AND (ix.indisunique OR ix.indisprimary)
    GROUP BY i.relname, ix.indisunique, ix.indisprimary
  `, [tableName]);

  if (!res.rows.length) {
    console.log('  NO unique constraints or primary key found at all on this table.');
  } else {
    for (const r of res.rows) {
      console.log(`  ${r.index_name}  unique=${r.is_unique}  primary=${r.is_primary}  columns=(${r.columns.join(', ')})`);
    }
  }

  // Also show all columns so we can confirm the expected columns actually exist
  const colsRes = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
    [tableName]
  );
  console.log(`\n  Columns on "${tableName}":`);
  for (const c of colsRes.rows) console.log(`    ${c.column_name} (${c.data_type})`);
}

async function main() {
  await checkTable('listings');
  await checkTable('sales');
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
