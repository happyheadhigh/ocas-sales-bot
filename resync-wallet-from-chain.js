/**
 * Root cause of the remaining gap (wallet 0x6456c1...: showing 14 held,
 * should be 22): confirmed via diag-simulate-derive-order.js that this
 * wallet has multiple tokens with ZERO nft_transfers rows at all -- not
 * a derivation bug, an incomplete original backfill. deriveIntervals()
 * can only work with what's in nft_transfers; if a receive/mint event was
 * never captured there in the first place, no amount of re-deriving fixes
 * it.
 *
 * This does exactly what the bot's own /me -> Wallet -> Sync button does
 * (see syncWalletForUser in lib/wallet-backfill.js: delete existing rows
 * for this wallet+collection, then backfillWallet() re-fetches the full
 * transfer history fresh from Alchemy) -- just as a standalone script for
 * one wallet, so we don't have to force a resync of all 82 affected
 * wallets to fix this one.
 *
 * backfillWallet() itself calls deriveIntervals() at the end, so
 * wallet_token_intervals gets rebuilt automatically once the real
 * transfer history is back.
 *
 * USAGE
 *   node resync-wallet-from-chain.js <wallet_address>
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { backfillWallet } = require('./lib/wallet-backfill');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const OCAS_SLUG = 'on-chain-all-stars';

const wallet = (process.argv[2] || '').toLowerCase();
if (!wallet || !wallet.startsWith('0x')) {
  console.error('Usage: node resync-wallet-from-chain.js <wallet_address>');
  process.exit(1);
}

async function main() {
  if (!process.env.ALCHEMY_API_KEY) {
    console.error('ALCHEMY_API_KEY not set in env -- cannot fetch from chain.');
    process.exit(1);
  }

  const before = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM nft_transfers WHERE (to_address=$1 OR from_address=$1) AND collection_slug=$2`,
    [wallet, OCAS_SLUG]
  );
  console.log(`Existing nft_transfers rows for ${wallet}: ${before.rows[0].cnt}`);

  console.log(`Deleting existing rows so backfillWallet() will re-fetch fresh (it skips wallets it thinks are already done)...`);
  const del = await pool.query(
    `DELETE FROM nft_transfers WHERE (to_address=$1 OR from_address=$1) AND collection_slug=$2`,
    [wallet, OCAS_SLUG]
  );
  console.log(`Deleted ${del.rowCount} row(s).\n`);

  console.log(`Re-fetching full transfer history from Alchemy for ${wallet}...`);
  const result = await backfillWallet(wallet, pool, process.env.ALCHEMY_API_KEY, OCAS_CONTRACT, OCAS_SLUG);
  console.log('\nFinal result (from deriveIntervals, run automatically inside backfillWallet):', result);
}

main().then(() => pool.end()).catch(e => { console.error('Fatal error:', e.message); pool.end(); process.exit(1); });
