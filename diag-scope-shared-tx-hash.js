/**
 * Diagnostic only -- no writes. Confirmed via diag-check-token-sales.js: for
 * token #3876, every one of its 22 "sale" rows shares its tx_hash with 14-28
 * OTHER token_ids simultaneously -- a real transaction doesn't sell that
 * many unrelated tokens under normal circumstances. Working theory: OpenSea
 * Seaport bundle/sweep purchases (buying many listed tokens in one
 * transaction) got misattributed during the original sales backfill,
 * assigning the whole bundle transaction to every token involved instead of
 * splitting it apart correctly.
 *
 * This checks the SCALE of the problem across the whole table: how many
 * tx_hash values are shared across an unusually large number of token_ids,
 * and how many total sales rows that touches -- needed before deciding on
 * any repair approach.
 *
 * USAGE
 *   node diag-scope-shared-tx-hash.js [minTokenCount]
 *   (minTokenCount defaults to 5 -- a tx_hash touching 5+ different token_ids
 *   is treated as suspicious; a real bundle sale of 2-3 tokens might be
 *   legitimate, so this starts a bit above that to focus on the clearly-
 *   wrong cases first)
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const minTokenCount = parseInt(process.argv[2], 10) || 5;

async function main() {
  console.log(`\n=== Scanning the sales table for tx_hash values shared across ${minTokenCount}+ token_ids ===\n`);

  const res = await pool.query(
    `SELECT tx_hash, COUNT(DISTINCT token_id) AS token_count, COUNT(*) AS row_count
     FROM sales
     WHERE tx_hash IS NOT NULL
     GROUP BY tx_hash
     HAVING COUNT(DISTINCT token_id) >= $1
     ORDER BY token_count DESC
     LIMIT 30`,
    [minTokenCount]
  );

  console.log(`Found ${res.rows.length} tx_hash value(s) touching ${minTokenCount}+ token_ids (showing up to 30, worst first):\n`);
  let totalAffectedRows = 0;
  for (const r of res.rows) {
    console.log(`  tx_hash=${r.tx_hash}  distinct_tokens=${r.token_count}  total_rows=${r.row_count}`);
    totalAffectedRows += parseInt(r.row_count);
  }

  const totalRes = await pool.query(
    `SELECT COUNT(*) AS total_suspect_rows, COUNT(DISTINCT token_id) AS total_distinct_tokens
     FROM sales
     WHERE tx_hash IN (
       SELECT tx_hash FROM sales WHERE tx_hash IS NOT NULL
       GROUP BY tx_hash HAVING COUNT(DISTINCT token_id) >= $1
     )`,
    [minTokenCount]
  );
  const grandTotalRes = await pool.query(`SELECT COUNT(*) AS grand_total FROM sales`);

  console.log('\n=== Overall scope ===');
  console.log(`  Total sales rows affected (any tx_hash with ${minTokenCount}+ distinct tokens): ${totalRes.rows[0].total_suspect_rows}`);
  console.log(`  Total distinct tokens touched by this pattern: ${totalRes.rows[0].total_distinct_tokens}`);
  console.log(`  Total rows in the whole sales table: ${grandTotalRes.rows[0].grand_total}`);
  const pct = (parseInt(totalRes.rows[0].total_suspect_rows) / parseInt(grandTotalRes.rows[0].grand_total) * 100).toFixed(1);
  console.log(`  That's ${pct}% of all sales rows in the table.`);
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
