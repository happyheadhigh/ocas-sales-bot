/**
 * Restores wallet_token_intervals.cost_eth for every wallet touched by
 * fix-rederive-wallet-intervals.js tonight (the burn-derivation fix,
 * run twice). deriveIntervals() always does a full DELETE + re-INSERT of
 * wallet_token_intervals from nft_transfers.value_eth alone -- which is
 * usually 0 for OCAS, since a mint's real ETH payment isn't captured on
 * the transfer row itself (that's exactly why enrichCostBasis() exists,
 * with its OpenSea/sales-table lookup and mint-tx-value fallback via
 * eth_getTransactionByHash). backfillWallet() normally calls
 * deriveIntervals() immediately followed by enrichCostBasis(), but
 * fix-rederive-wallet-intervals.js only called deriveIntervals() directly
 * -- so every wallet it touched had its real cost_eth silently wiped back
 * to 0, which is why /me's Portfolio embed started showing "Spent: Ξ0.0000"
 * and dropped the Avg. cost / Unrealized lines entirely (both gated on
 * avg_cost > 0).
 *
 * This re-runs enrichCostBasis() (now exported from lib/wallet-backfill.js)
 * for the same wallet list, restoring real cost basis from the sales-table
 * cache first (free, no API call for tokens with a recorded sale) and the
 * OpenSea/mint-tx-value fallback otherwise -- same logic backfillWallet()
 * already uses, just without re-doing the (already-correct) Alchemy
 * transfer fetch.
 *
 * USAGE
 *   node fix-restore-cost-basis.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { enrichCostBasis } = require('./lib/wallet-backfill');

const OCAS_SLUG = 'on-chain-all-stars';

async function main() {
  const walletsRes = await pool.query(`
    SELECT DISTINCT LOWER(be.burner_wallet) AS wallet
    FROM burn_event_inputs bei
    JOIN burn_events be ON be.id = bei.burn_event_id
    WHERE bei.burned_token_id != be.survivor_token_id
  `);
  const wallets = walletsRes.rows.map(r => r.wallet);
  console.log(`Restoring cost basis for ${wallets.length} wallet(s)...\n`);

  let done = 0, failed = 0;
  for (const wallet of wallets) {
    try {
      await enrichCostBasis(wallet, OCAS_SLUG, pool, process.env.OPENSEA_KEY, process.env.ALCHEMY_API_KEY);
      done++;
    } catch (e) {
      console.warn(`  [failed] ${wallet}: ${e.message}`);
      failed++;
    }
    if (done % 10 === 0) console.log(`  ...progress: ${done}/${wallets.length}`);
  }

  console.log(`\nDone. ${done} wallet(s) processed, ${failed} failed.`);
}

main().then(() => pool.end()).catch(e => { console.error('Fatal error:', e.message); pool.end(); process.exit(1); });
