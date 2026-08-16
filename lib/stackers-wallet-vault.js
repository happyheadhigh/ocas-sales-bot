'use strict';

// ── Stackers wallet vault summary ─────────────────────────────────────────────
// Sums live, unclaimed vault balance across every Stacker a wallet
// currently holds. Public, on-chain data — works for any wallet, no
// verification/connection required at all; that's only useful as a
// shortcut for resolving "my own wallet" without typing it every time,
// handled by the caller, not this module.

const { getStackerInfo, STACKERS_SLUG } = require('./stackers');

const READ_DELAY_MS = 100; // gentle pacing between tokens — lighter than the background jobs, since this is a small, on-demand, user-initiated read for typically a handful of held tokens, not a bulk sweep

async function getWalletVaultSummary(wallet, pgPool){
  wallet = wallet.toLowerCase();

  const heldRes = await pgPool.query(
    `SELECT token_id FROM wallet_token_intervals
     WHERE wallet_address = $1 AND collection_slug = $2 AND disposed_at IS NULL
     ORDER BY token_id`,
    [wallet, STACKERS_SLUG]
  );
  const tokenIds = heldRes.rows.map(r => r.token_id);

  if(!tokenIds.length){
    return { tokenCount: 0, totals: [], failed: 0 };
  }

  const totalsMap = new Map(); // symbol -> running total
  let failed = 0;

  for(const tokenId of tokenIds){
    try{
      const info = await getStackerInfo(tokenId);
      for(const b of info.balances){
        const current = totalsMap.get(b.symbol) || 0;
        totalsMap.set(b.symbol, current + parseFloat(b.amountFormatted));
      }
    }catch(e){
      failed++;
    }
    if(tokenIds.length > 5){
      await new Promise(r => setTimeout(r, READ_DELAY_MS));
    }
  }

  const totals = Array.from(totalsMap.entries())
    .map(([symbol, amount]) => ({ symbol, amount }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  return { tokenCount: tokenIds.length, totals, failed };
}

module.exports = { getWalletVaultSummary };
