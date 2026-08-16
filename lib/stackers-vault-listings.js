'use strict';

// ── Stackers listed-with-unclaimed-vault-value cache ──────────────────────────
// Finds currently listed Stackers that have real, unclaimed value sitting in
// their vault — value a buyer gets on top of the token itself, since vault
// balance travels with the NFT on sale. Only checks the (much smaller)
// listed subset, not the whole collection, and only keeps tokens with a
// genuinely non-empty vault. Rows for tokens no longer listed get removed
// on each refresh, so this table always reflects "currently listed AND has
// real vault value right now," not stale history.

const { getStackerInfo, STACKERS_SLUG } = require('./stackers');

const REFRESH_DELAY_MS = 150; // same gentle pacing as the other Stackers background jobs tonight, same reasoning

// Refreshes the cache for one specific token — used both by the full
// periodic refresh below and by the fusion poller (a fusion can add vault
// value to the survivor from the absorbed token's vault merging in, which
// matters here if that survivor happens to be listed). No-op if the token
// isn't currently listed at all; removes any existing cache row if the
// vault is empty.
async function refreshOneVaultListing(pgPool, tokenId){
  const listedRes = await pgPool.query(
    `SELECT 1 FROM listings WHERE token_id = $1 AND collection_slug = $2`,
    [tokenId, STACKERS_SLUG]
  );
  if(!listedRes.rows.length){
    await pgPool.query(`DELETE FROM stackers_vault_listings WHERE token_id = $1`, [tokenId]).catch(()=>{});
    return;
  }

  const info = await getStackerInfo(tokenId);
  if(!info.balances.length){
    await pgPool.query(`DELETE FROM stackers_vault_listings WHERE token_id = $1`, [tokenId]).catch(()=>{});
    return;
  }

  // getStackerInfo's balance objects include amountRaw (a native BigInt
  // from ethers.js) — JSON.stringify cannot serialize BigInt at all and
  // throws outright, so only the display-relevant fields are kept here.
  // Nothing downstream needs the raw value, only amountFormatted.
  const displayBalances = info.balances.map(b => ({ symbol: b.symbol, amountFormatted: b.amountFormatted }));

  await pgPool.query(
    `INSERT INTO stackers_vault_listings (token_id, vault_balances, checked_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (token_id) DO UPDATE SET vault_balances=$2, checked_at=NOW()`,
    [tokenId, JSON.stringify(displayBalances)]
  );
}

// Full periodic refresh — walks every currently listed Stacker (not the
// whole collection), checks vault balance for each, caches the ones with
// real value, and removes cache rows for anything no longer listed at all.
async function refreshVaultListingsCache(pgPool){
  const listingsRes = await pgPool.query(
    `SELECT token_id FROM listings WHERE collection_slug = $1 ORDER BY token_id`,
    [STACKERS_SLUG]
  );
  const listedIds = listingsRes.rows.map(r => r.token_id);
  console.log(`[StackersVaultListings] Starting refresh for ${listedIds.length} currently listed tokens`);

  // Drop cache rows for anything no longer listed at all, before
  // rechecking what's still listed — cheap, and keeps the table honest
  // even if this run gets interrupted partway through.
  if(listedIds.length){
    await pgPool.query(
      `DELETE FROM stackers_vault_listings WHERE token_id != ALL($1)`,
      [listedIds]
    ).catch(()=>{});
  } else {
    await pgPool.query(`DELETE FROM stackers_vault_listings`).catch(()=>{});
  }

  let withValue = 0, empty = 0, failed = 0;
  for(const tokenId of listedIds){
    try{
      const info = await getStackerInfo(tokenId);
      if(info.balances.length){
        // Same BigInt-stripping as refreshOneVaultListing above — amountRaw
        // cannot be JSON.stringify'd, and nothing downstream needs it.
        const displayBalances = info.balances.map(b => ({ symbol: b.symbol, amountFormatted: b.amountFormatted }));
        await pgPool.query(
          `INSERT INTO stackers_vault_listings (token_id, vault_balances, checked_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (token_id) DO UPDATE SET vault_balances=$2, checked_at=NOW()`,
          [tokenId, JSON.stringify(displayBalances)]
        );
        withValue++;
      } else {
        empty++;
      }
    }catch(e){
      failed++;
      if(failed <= 5) console.warn(`[StackersVaultListings] Token ${tokenId} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, REFRESH_DELAY_MS));
  }

  console.log(`[StackersVaultListings] Refresh complete: ${withValue} listed with unclaimed value, ${empty} empty, ${failed} failed`);
  return { total: listedIds.length, withValue, empty, failed };
}

// Reads the current cache, joined against live listings for price + URL —
// live for "is it still listed and what's the price," cached for "what's
// in the vault," same reasoning as the image cache's speed/freshness split.
async function getVaultListings(pgPool, limit = 15){
  const res = await pgPool.query(
    `SELECT v.token_id, v.vault_balances, v.checked_at, l.price_eth, l.url
     FROM stackers_vault_listings v
     JOIN listings l ON l.token_id = v.token_id AND l.collection_slug = $1
     ORDER BY l.price_eth ASC
     LIMIT $2`,
    [STACKERS_SLUG, limit]
  );
  return res.rows;
}

module.exports = { refreshOneVaultListing, refreshVaultListingsCache, getVaultListings };
