/**
 * Diagnostic only -- no writes. Scope check found 9,128 rows (44% of the
 * whole sales table) where a single tx_hash is shared across many token_ids
 * -- and suspiciously, many of the worst cases land at EXACTLY 50 distinct
 * tokens, repeated across many different transactions. A round, repeated
 * number like that points to a page-size bug in the original backfill
 * script (50 is a very common API page size), not organic Seaport bundle
 * purchases.
 *
 * This checks one specific cluster in full detail: if the price_eth and
 * sale_ts values genuinely differ across all 50 rows (each looking like a
 * real, distinct sale) while only tx_hash is identical, that confirms the
 * theory that just ONE field (tx_hash) got stuck/reused across a batch
 * during backfill -- meaning the actual sale data is likely still usable,
 * and the fix might be much narrower than re-deriving everything from
 * scratch.
 *
 * USAGE
 *   node diag-inspect-shared-tx-cluster.js <tx_hash>
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const txHash = (process.argv[2] || '').trim();
if (!txHash) {
  console.log('Usage: node diag-inspect-shared-tx-cluster.js <tx_hash>');
  process.exit(1);
}

async function main() {
  console.log(`\n=== Every row sharing tx_hash=${txHash} ===\n`);
  const res = await pool.query(
    `SELECT id, token_id, price_eth, currency, buyer, seller, sale_ts
     FROM sales WHERE tx_hash=$1 ORDER BY sale_ts ASC`,
    [txHash]
  );
  console.log(`Found ${res.rows.length} row(s)\n`);
  for (const r of res.rows) {
    console.log(`  token_id=${r.token_id}  price=${r.price_eth} ${r.currency}  buyer=${r.buyer}  seller=${r.seller}  sale_ts=${r.sale_ts}`);
  }

  const distinctPrices = new Set(res.rows.map(r => r.price_eth));
  const distinctTimestamps = new Set(res.rows.map(r => new Date(r.sale_ts).getTime()));
  const distinctBuyers = new Set(res.rows.map(r => r.buyer));
  const distinctSellers = new Set(res.rows.map(r => r.seller));

  console.log('\n=== Field-by-field variation check ===');
  console.log(`  distinct price_eth values: ${distinctPrices.size} (out of ${res.rows.length} rows)`);
  console.log(`  distinct sale_ts values:   ${distinctTimestamps.size} (out of ${res.rows.length} rows)`);
  console.log(`  distinct buyer values:     ${distinctBuyers.size} (out of ${res.rows.length} rows)`);
  console.log(`  distinct seller values:    ${distinctSellers.size} (out of ${res.rows.length} rows)`);

  console.log('\n=== Verdict ===');
  if (distinctPrices.size > 1 && distinctTimestamps.size > 1) {
    console.log('Price and timestamp genuinely vary across these rows -- these look like REAL,');
    console.log('DISTINCT sales that each have their own correct data, with only tx_hash being');
    console.log('wrong/reused. This supports a narrow fix: the sale records themselves are likely');
    console.log('fine, just missing (or having wrong) transaction hash linkage.');
  } else {
    console.log('Price and/or timestamp do NOT vary -- these rows may be genuine duplicates of');
    console.log('the same underlying data, not just a shared tx_hash on otherwise-distinct sales.');
    console.log('This would need a different repair approach than just fixing tx_hash.');
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
