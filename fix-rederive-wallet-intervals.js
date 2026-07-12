/**
 * Fixes TraitView's "Owned Tokens" still showing already-burned tokens as
 * owned, even after fixing the missing nft_transfers burn rows. Root
 * cause: wallet_token_intervals (the table "Owned Tokens" is actually
 * driven by, via /db/wallet/:address/summary) is a DERIVED, pre-computed
 * table -- deriveIntervals() rebuilds it from nft_transfers, but only when
 * explicitly called. Fixing nft_transfers alone doesn't automatically
 * refresh wallet_token_intervals; the derivation needs to actually re-run.
 *
 * Confirmed no re-fetch/Alchemy call is needed: deriveIntervals() purely
 * reads nft_transfers (already correct now) and does a delete-then-
 * reinsert into wallet_token_intervals. This finds every distinct wallet
 * that had at least one missing burn row fixed earlier tonight, and
 * re-runs deriveIntervals() for each of them -- fixing this comprehensively
 * for everyone affected, not just one wallet.
 *
 * USAGE
 *   node fix-rederive-wallet-intervals.js
 *   (no dry-run flag -- deriveIntervals() itself is a safe, idempotent
 *   recomputation from already-trusted data, same as re-running any other
 *   derived-data refresh; nothing here is destructive in a way that isn't
 *   immediately correct)
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { deriveIntervals } = require('./lib/wallet-backfill');

const OCAS_SLUG = 'on-chain-all-stars';

async function main() {
  const walletsRes = await pool.query(`
    SELECT DISTINCT LOWER(be.burner_wallet) AS wallet
    FROM burn_event_inputs bei
    JOIN burn_events be ON be.id = bei.burn_event_id
    WHERE bei.burned_token_id != be.survivor_token_id
  `);
  const wallets = walletsRes.rows.map(r => r.wallet);
  console.log(`Re-deriving wallet_token_intervals for ${wallets.length} wallet(s) that have ever burned a token...\n`);

  let done = 0, failed = 0;
  for (const wallet of wallets) {
    try {
      await deriveIntervals(wallet, OCAS_SLUG, pool);
      done++;
    } catch (e) {
      console.warn(`  [failed] ${wallet}: ${e.message}`);
      failed++;
    }
    if (done % 25 === 0) console.log(`  ...progress: ${done}/${wallets.length}`);
  }

  console.log(`\nDone. ${done} wallet(s) re-derived successfully, ${failed} failed.`);
}

main().then(() => pool.end()).catch(e => { console.error('Fatal error:', e.message); pool.end(); process.exit(1); });
