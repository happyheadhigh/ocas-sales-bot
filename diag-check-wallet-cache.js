/**
 * Diagnostic only -- no writes. jv reports "Owned Tokens" in TraitView's
 * Wallet tab still shows already-burned tokens even after fixing the
 * underlying nft_transfers gap. Traced /db/wallet/:address/summary: it
 * checks wallet_analytics_cache FIRST and returns that directly without
 * recomputing if a cached row exists -- meaning a stale cache from before
 * tonight's fix could still be served indefinitely. Checking whether this
 * wallet actually has a cached row, and how old it is relative to the fix.
 *
 * USAGE
 *   node diag-check-wallet-cache.js <walletAddress>
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const wallet = (process.argv[2] || '').trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
  console.log('Usage: node diag-check-wallet-cache.js <walletAddress>');
  process.exit(1);
}

async function main() {
  const res = await pool.query(
    `SELECT updated_at, jsonb_array_length(summary_json->'top_tokens') AS token_count
     FROM wallet_analytics_cache WHERE wallet_address = $1`,
    [wallet]
  );
  if (!res.rows.length) {
    console.log('No cached row exists for this wallet at all -- the cache is not the issue.');
  } else {
    console.log(`Cached row found: updated_at=${res.rows[0].updated_at}, cached token_count=${res.rows[0].token_count}`);
    console.log('If this timestamp predates the nft_transfers repair, this stale cache is');
    console.log('exactly why "Owned Tokens" still shows the old, wrong count.');
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
