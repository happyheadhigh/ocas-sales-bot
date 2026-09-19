/* jv: "There are actually trades happening on Gondi as well. Is there
   anyway to catch those in traitview?"

   Gondi (gondi.xyz) is a real, separate NFT marketplace with its own
   order book -- confirmed via their own public docs (docs.gondi.xyz)
   that it supports direct buy/sell trading (including a permissionless
   peer-to-peer "Trades" feature open to any collection, not gated by
   their lending whitelist) in addition to its better-known lending
   side. They publish an official SDK (npm: "gondi") with documented,
   read-accessible methods for this.

   IMPORTANT CAVEAT, confirmed by reading the SDK's full method list
   directly rather than assuming: there is no dedicated "completed
   trades" or "sales history" method anywhere in it. What it exposes is
   current state -- listings() (active sell listings), offers() (active
   bid/loan offers), loans() (active/historical loans) -- and actions
   to create/cancel orders. This module tracks the piece that's
   actually there: active Gondi listings for a collection. Detecting
   that a listing actually SOLD (as opposed to being cancelled or
   expired) is a natural next step once this side is confirmed working
   against real data -- most likely by noticing a listing disappear
   from here and cross-checking whether the token's on-chain owner
   actually changed, using the wallet/ownership tracking this bot
   already has for other purposes.

   The SDK's own README requires a real wallet object to even
   instantiate the client, even for pure reads -- generating a fresh,
   empty throwaway keypair for this specifically (regenerated on every
   restart, never persisted, never used to sign or submit anything)
   rather than manage a real secret for a read-only integration. */

const { pgPool } = require('./db');

const ARGONAUTS_SLUG = 'argonauts';
const ARGONAUTS_CONTRACT = '0x387C41B0B2F1128dE44dB1Bcf8baad085f26392C';

let _gondi = null;
let _collectionIdCache = {}; // slug -> gondi collectionId (number)

async function getGondiClient(){
  if(_gondi) return _gondi;
  // jv: "require() of ES Module /app/node_modules/gondi/dist/index.mjs
  // not supported." Confirmed the actual cause via a version
  // difference, not a packaging bug: gondi ships as ESM-only, and
  // recent Node versions (20.19+/22+) added support for synchronously
  // require()-ing a pure ESM package, but Railway's deployed Node
  // (18.20.8, per its own engine-mismatch warnings elsewhere in this
  // same log) doesn't have that support at all -- hence the hard
  // error there specifically. A dynamic import() works correctly
  // regardless of Node version, unlike require(), so using that
  // specifically for this one package rather than for viem (which
  // already has real, working CommonJS support and doesn't need this).
  const { Gondi } = await import('gondi');
  const { createWalletClient, http } = require('viem');
  const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
  const { mainnet } = require('viem/chains');

  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  if(!ALCHEMY_KEY){
    console.warn('[gondi-sync] No ALCHEMY_API_KEY set -- Gondi sync disabled (needs an RPC transport for the SDK client)');
    return null;
  }
  // Fresh, empty, throwaway keypair -- never persisted, never used to
  // sign or submit a real transaction. Purely to satisfy the SDK's
  // constructor requirement for read-only calls.
  const throwawayKey = generatePrivateKey();
  const wallet = createWalletClient({
    account: privateKeyToAccount(throwawayKey),
    transport: http(`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`),
    chain: mainnet,
  });
  _gondi = new Gondi({ wallet });
  return _gondi;
}

async function resolveGondiCollectionId(slug, contractAddress){
  if(_collectionIdCache[slug] != null) return _collectionIdCache[slug];
  const gondi = await getGondiClient();
  if(!gondi) return null;
  try{
    const ids = await gondi.collectionId({ contractAddress });
    // Documented as an array since some contracts map to multiple
    // Gondi collections (e.g. Art Blocks); taking the first is the
    // SDK's own documented pattern for the common case.
    const id = Array.isArray(ids) ? ids[0] : ids;
    if(id == null){
      console.warn(`[gondi-sync] ${slug}: collectionId lookup returned nothing for ${contractAddress} -- likely never indexed by Gondi at all`);
      return null;
    }
    _collectionIdCache[slug] = id;
    console.log(`[gondi-sync] ${slug}: resolved Gondi collectionId=${id} for contract ${contractAddress}`);
    return id;
  }catch(e){
    console.warn(`[gondi-sync] ${slug}: collectionId lookup failed:`, e.message);
    return null;
  }
}

async function syncGondiListingsForCollection(slug, contractAddress){
  const gondi = await getGondiClient();
  if(!gondi) return;
  const collectionId = await resolveGondiCollectionId(slug, contractAddress);
  if(collectionId == null) return;

  const seenListingIds = new Set();
  let cursor = undefined;
  let pages = 0;
  const MAX_PAGES = 20; // generous cap; a real collection's live listing count should never need more

  try{
    do{
      // jv: the exact shape of filterBy isn't spelled out in the SDK's
      // published type docs beyond its name (ListListingsProps) --
      // this is the most natural reading of the documented pattern
      // (collectionId is how every other method in this SDK scopes to
      // a collection). Logging the raw response shape below so a
      // mismatch here is immediately visible in the logs rather than
      // silently returning nothing.
      const page = await gondi.listings({
        cursor,
        limit: 50,
        filterBy: { collectionIds: [collectionId] },
      });
      pages++;
      const listings = page?.listings || [];
      if(pages === 1){
        console.log(`[gondi-sync] ${slug}: first page returned ${listings.length} listing(s); sample keys=${listings[0] ? Object.keys(listings[0]).join(',') : 'n/a'}`);
      }
      for(const listing of listings){
        const tokenId = listing?.nft?.tokenId != null ? Number(listing.nft.tokenId) : null;
        if(tokenId == null || !Number.isFinite(tokenId)) continue;
        const gondiListingId = String(listing.id);
        seenListingIds.add(gondiListingId);
        // Defensive: price/currency fields aren't in the documented
        // return type at all -- reading a few plausible field names in
        // case the real response carries them under something the
        // abbreviated docs didn't show, but never assuming they exist.
        const priceWei = listing?.price ?? listing?.priceWei ?? listing?.amount ?? null;
        const currencyAddress = listing?.currency?.address ?? listing?.currencyAddress ?? null;
        await pgPool.query(
          `INSERT INTO gondi_listings (collection_slug, token_id, gondi_listing_id, marketplace_name, seller_wallet, price_wei, currency_address, gondi_created_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (collection_slug, gondi_listing_id) DO UPDATE SET
             last_seen_at = NOW(),
             price_wei = COALESCE(EXCLUDED.price_wei, gondi_listings.price_wei),
             currency_address = COALESCE(EXCLUDED.currency_address, gondi_listings.currency_address)`,
          [
            slug, tokenId, gondiListingId,
            listing?.marketplaceName || null,
            listing?.user?.walletAddress || null,
            priceWei != null ? String(priceWei) : null,
            currencyAddress,
            listing?.createdDate ? new Date(listing.createdDate) : null,
          ]
        ).catch(e => console.warn(`[gondi-sync] ${slug}: upsert failed for listing ${gondiListingId}:`, e.message));
      }
      cursor = page?.hasNextPage ? page.cursor : null;
    }while(cursor && pages < MAX_PAGES);

    // Anything not seen this cycle is no longer an active Gondi
    // listing -- sold, cancelled, or expired. Removing it here for
    // now; distinguishing "sold" from "cancelled/expired" (the actual
    // trade-catching part jv asked for) is the natural next phase once
    // this side is confirmed working against real data.
    const removeRes = await pgPool.query(
      `DELETE FROM gondi_listings WHERE collection_slug = $1 AND NOT (gondi_listing_id = ANY($2::text[])) RETURNING token_id`,
      [slug, [...seenListingIds]]
    );
    if(removeRes.rowCount > 0){
      console.log(`[gondi-sync] ${slug}: ${removeRes.rowCount} listing(s) no longer active (sold/cancelled/expired): tokens ${removeRes.rows.map(r=>r.token_id).join(', ')}`);
    }
    console.log(`[gondi-sync] ${slug}: synced ${seenListingIds.size} active Gondi listing(s) across ${pages} page(s)`);
  }catch(e){
    console.warn(`[gondi-sync] ${slug}: sync failed:`, e.message);
  }
}

async function syncAllGondiListings(){
  // jv: scoped to argonauts specifically for now (the collection this
  // was actually reported for, and the only contract address on hand).
  // Generalizing to every collection just needs each one's contract
  // address, same as everything else in this file.
  await syncGondiListingsForCollection(ARGONAUTS_SLUG, ARGONAUTS_CONTRACT);
}

const SYNC_INTERVAL_MS = 5 * 60_000; // Gondi listing volume is much lower than OpenSea's; no need to poll as aggressively

function startGondiSync(){
  syncAllGondiListings().catch(e => console.error('[gondi-sync] initial sync failed:', e.message));
  setInterval(() => {
    syncAllGondiListings().catch(e => console.error('[gondi-sync] sync cycle failed:', e.message));
  }, SYNC_INTERVAL_MS);
  console.log(`[gondi-sync] started (interval=${SYNC_INTERVAL_MS}ms)`);
}

module.exports = { startGondiSync, syncAllGondiListings, syncGondiListingsForCollection };
