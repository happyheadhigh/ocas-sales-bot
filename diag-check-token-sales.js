/**
 * Diagnostic only -- no writes. The /db/token-sales endpoint's query itself
 * filters correctly (WHERE token_id = $1), so if a token that was reportedly
 * "only minted, never sold" shows 22 sale rows, the actual stored DATA is
 * suspect, not the query. Given the sales table's own history (backfilled
 * via a complex multi-page OpenSea events pagination process, per earlier
 * notes), a pagination-cursor bug misattributing some rows to the wrong
 * token_id is plausible. This dumps the raw rows to check.
 *
 * USAGE
 *   node diag-check-token-sales.js <tokenId>
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const tokenId = parseInt(process.argv[2], 10);
if (!Number.isFinite(tokenId)) {
  console.log('Usage: node diag-check-token-sales.js <tokenId>');
  process.exit(1);
}

async function main() {
  console.log(`\n=== Raw sales rows for token #${tokenId} ===\n`);
  const res = await pool.query(
    `SELECT id, token_id, price_eth, currency, buyer, seller, tx_hash, sale_ts
     FROM sales WHERE token_id=$1 ORDER BY sale_ts ASC`,
    [tokenId]
  );
  console.log(`Found ${res.rows.length} row(s)\n`);
  for (const r of res.rows) {
    console.log(`  id=${r.id}  price=${r.price_eth} ${r.currency}  tx=${r.tx_hash}  sale_ts=${r.sale_ts}`);
  }

  if (res.rows.length > 1) {
    console.log('\n=== Checking for duplicate/reused tx_hash across these rows ===');
    const txCounts = {};
    for (const r of res.rows) txCounts[r.tx_hash] = (txCounts[r.tx_hash] || 0) + 1;
    const dupes = Object.entries(txCounts).filter(([, c]) => c > 1);
    if (dupes.length) {
      console.log('DUPLICATE tx_hash values found (same transaction counted more than once):');
      for (const [tx, c] of dupes) console.log(`  ${tx}: ${c} rows`);
    } else {
      console.log('No duplicate tx_hash values -- each row is a genuinely distinct transaction.');
    }

    console.log('\n=== Checking whether OTHER tokens share these same tx_hash values ===');
    const txHashes = res.rows.map(r => r.tx_hash).filter(Boolean);
    if (txHashes.length) {
      const crossRes = await pool.query(
        `SELECT tx_hash, array_agg(DISTINCT token_id) AS token_ids FROM sales WHERE tx_hash = ANY($1) GROUP BY tx_hash`,
        [txHashes]
      );
      for (const r of crossRes.rows) {
        const ids = r.token_ids.map(Number);
        if (ids.length > 1 || !ids.includes(tokenId)) {
          console.log(`  tx_hash=${r.tx_hash}  appears under token_ids=[${ids.join(',')}]  <-- SUSPECT if token ${tokenId} isn't the only one, or isn't present at all`);
        }
      }
    }
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
