'use strict';

// ── Stackers wallet vault summary ─────────────────────────────────────────────
// Sums live, unclaimed vault balance across every Stacker a wallet
// currently holds. Public, on-chain data — works for any wallet, no
// verification/connection required at all; that's only useful as a
// shortcut for resolving "my own wallet" without typing it every time,
// handled by the caller, not this module.
//
// Holdings are resolved live from OpenSea, not our own wallet_token_intervals
// table. That table is only populated for wallets that have gone through
// OUR OWN backfill process (verified Discord users, or wallets someone
// explicitly synced) — it is not a complete ownership registry. Confirmed
// live: a genuine top-holder wallet that had never interacted with the bot
// returned zero results from that table despite clearly holding dozens of
// Stackers on OpenSea. The whole point of this feature is checking any
// wallet, including ones nobody has ever connected — so this needs the
// real, current, on-chain-backed answer regardless of our own tracking.

const { getStackerInfo, STACKERS_SLUG } = require('./stackers');

const READ_DELAY_MS = 100; // gentle pacing between vault reads — lighter than the background jobs, since this is a small, on-demand, user-initiated read for typically a handful of held tokens, not a bulk sweep

async function getHeldTokenIds(wallet){
  const openSeaKey = process.env.OPENSEA_KEY;
  const tokenIds = [];
  let cursor = null;
  let pageCount = 0;
  const MAX_PAGES = 10; // sane bound even for a genuine whale

  do {
    const qs = new URLSearchParams({
      collection: STACKERS_SLUG,
      limit: '200',
      ...(cursor ? { next: cursor } : {}),
    }).toString();
    const res = await fetch(`https://api.opensea.io/api/v2/chain/robinhood/account/${wallet}/nfts?${qs}`, {
      headers: { 'X-API-KEY': openSeaKey || '', 'Accept': 'application/json' },
    });
    if(!res.ok) break;
    const data = await res.json();
    for(const nft of (data?.nfts || [])){
      const tid = parseInt(nft.identifier);
      if(tid) tokenIds.push(tid);
    }
    cursor = data?.next || null;
    pageCount++;
  } while(cursor && pageCount < MAX_PAGES);

  return tokenIds;
}

async function getWalletVaultSummary(wallet){
  wallet = wallet.toLowerCase();

  const tokenIds = await getHeldTokenIds(wallet);

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

module.exports = { getWalletVaultSummary, getHeldTokenIds };

