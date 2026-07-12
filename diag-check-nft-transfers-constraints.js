/**
 * Diagnostic only -- no writes. Checking whether nft_transfers has a
 * unique constraint (e.g. tx_hash + log_index) before writing a repair
 * script that will insert synthetic rows for missing burn events -- need
 * to know what log_index values are safe to use so a new row for a
 * multi-token burn transaction doesn't collide with a sibling row for a
 * different token in the same tx.
 *
 * USAGE
 *   node diag-check-nft-transfers-constraints.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
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
    WHERE t.relname = 'nft_transfers' AND (ix.indisunique OR ix.indisprimary)
    GROUP BY i.relname, ix.indisunique, ix.indisprimary
  `);
  console.log('=== Unique constraints/indexes on nft_transfers ===\n');
  if (!res.rows.length) {
    console.log('  None found beyond a plain primary key (if any) -- check output above for the id column.');
  }
  for (const r of res.rows) {
    console.log(`  ${r.index_name}  unique=${r.is_unique}  primary=${r.is_primary}  columns=(${r.columns.join(', ')})`);
  }

  console.log('\n=== Example: a real tx_hash with multiple token_ids (if any) ===\n');
  const multiRes = await pool.query(`
    SELECT tx_hash, array_agg(token_id ORDER BY log_index) AS token_ids, array_agg(log_index ORDER BY log_index) AS log_indexes
    FROM nft_transfers
    WHERE event_type = 'burn'
    GROUP BY tx_hash
    HAVING COUNT(*) > 1
    LIMIT 3
  `);
  for (const r of multiRes.rows) {
    console.log(`  tx_hash=${r.tx_hash}  token_ids=[${r.token_ids.join(',')}]  log_indexes=[${r.log_indexes.join(',')}]`);
  }
  if (!multiRes.rows.length) console.log('  No existing multi-token burn transactions found in current data.');
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
