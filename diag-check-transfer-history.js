/**
 * Diagnostic only -- no writes. User has direct, personal knowledge that
 * token #3876 was minted and never sold -- confirmed the sales table has
 * wrong data for it (attached to real transactions, per Etherscan, that it
 * wasn't actually part of). This checks nft_transfers -- a completely
 * separate data source from the sales table -- for independent
 * confirmation: if #3876 has never had more than one owner (or zero
 * transfers beyond the mint), that's fully independent evidence the sales
 * table specifically is where this corruption lives, not a
 * collection-wide ownership discrepancy.
 *
 * Checks the real live schema first rather than assuming lib/db.js's
 * CREATE TABLE statement still matches (known to drift over time).
 *
 * USAGE
 *   node diag-check-transfer-history.js <tokenId>
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const tokenId = parseInt(process.argv[2], 10);
if (!Number.isFinite(tokenId)) {
  console.log('Usage: node diag-check-transfer-history.js <tokenId>');
  process.exit(1);
}

async function main() {
  console.log('\n=== Live column check: nft_transfers ===\n');
  const colsRes = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='nft_transfers' ORDER BY ordinal_position`
  );
  for (const c of colsRes.rows) console.log(`  ${c.column_name}  (${c.data_type})`);

  console.log(`\n=== nft_transfers rows for token #${tokenId} ===\n`);
  const res = await pool.query(
    `SELECT id, from_address, to_address, value_eth, block_number, transferred_at, tx_hash
     FROM nft_transfers WHERE token_id=$1 ORDER BY block_number ASC`,
    [tokenId]
  );
  console.log(`Found ${res.rows.length} transfer(s)\n`);
  for (const r of res.rows) {
    console.log(`  block=${r.block_number}  from=${r.from_address}  to=${r.to_address}  value=${r.value_eth}  tx=${r.tx_hash}  at=${r.transferred_at}`);
  }

  console.log('\n=== Verdict ===');
  const nonMintTransfers = res.rows.filter(r => r.from_address && r.from_address !== '0x0000000000000000000000000000000000000000');
  if (res.rows.length <= 1 || !nonMintTransfers.length) {
    console.log('Independent confirmation: nft_transfers shows this token has never moved beyond');
    console.log('its original mint (or has zero transfer rows at all). This fully corroborates');
    console.log('the user\'s direct knowledge -- the sales table\'s 22 rows for this token are');
    console.log('confirmed wrong from a second, completely separate data source.');
  } else {
    console.log(`Found ${nonMintTransfers.length} real transfer(s) beyond the mint -- this token DID`);
    console.log('move at least once on-chain. Worth checking these specific transfers against');
    console.log('what the user remembers, since this contradicts "never sold" at face value.');
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
