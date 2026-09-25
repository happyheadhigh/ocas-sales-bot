'use strict';

const fetch = require('node-fetch');
const { OCAS_CONTRACT, OCAS_SLUG, RANK_SYNC_DELAY_MS, osHeaders } = require('./constants');
const { pgPool } = require('./db');

// Confirmed live, end to end: this module was hardcoded to OCAS_CONTRACT/
// OCAS_SLUG throughout, so the rolling sync only ever refreshed OCAS's own
// os_rank column -- Argonauts' values were set once at backfill and never
// touched again. First generalized to round-robin across every 'ready'
// collection one token at a time; THEN jv shared research pointing at
// OpenSea's real batch endpoint (POST /api/v2/nfts/batch, SDK v10.5.0) as a
// faster alternative to the one-call-per-token approach. Tested it directly
// (several iterations -- OpenSea's actual field names turned out to differ
// from every published example: top-level `identifiers`, not `nfts`; each
// entry needs `contract_address` + `token_id`, not `address` + `identifier`)
// and confirmed:
//   - the response DOES carry a full rarity object per token
//     ({strategy_id:"openrarity", strategy_version:"1.0", rank:N})
//   - the real accepted maximum is 30 identifiers per call (OpenSea's own
//     error message at 50: "identifiers must not exceed 30 items" -- the
//     bulk "NFTs by collection" endpoint tested earlier this session has no
//     rarity field at all, so this batch endpoint is the only viable fast
//     path found)
// 30 tokens/call instead of 1 means a full ~10,000-token collection sync
// drops from ~9,999 calls to ~334 -- keeping the same call cadence
// (RANK_SYNC_INTERVAL, unchanged) but now moving 30x as many tokens through
// it per tick.

const RANK_SYNC_BATCH_SIZE = 30; // OpenSea's confirmed real max for POST /nfts/batch

const rankSyncQueue = new Set(); // bare token ids (OCAS -- including burn-poller.js's own direct rankSyncQueue.add(id) call site) or {id, slug, contract} entries queued for near-immediate sync (post-burn)
const _cursors = new Map();      // slug -> next token id to check
let _collectionsCache = null;    // [{slug, contract}], refreshed periodically
let _collectionsCacheAt = 0;
let _roundRobinIdx = 0;
const COLLECTIONS_CACHE_TTL_MS = 5 * 60_000; // collections list changes rarely; no need to hit the DB every tick

async function getReadyCollections(){
  const now = Date.now();
  if(_collectionsCache && (now - _collectionsCacheAt) < COLLECTIONS_CACHE_TTL_MS) return _collectionsCache;
  try{
    const result = await pgPool.query(`SELECT slug, contract FROM collections WHERE status = 'ready'`);
    _collectionsCache = result.rows;
    _collectionsCacheAt = now;
  }catch(e){
    console.warn('[RankSync] failed to load ready collections:', e.message);
    if(!_collectionsCache) _collectionsCache = [{ slug: OCAS_SLUG, contract: OCAS_CONTRACT }]; // safe fallback so sync never fully stops
  }
  return _collectionsCache;
}

// entries: array of {id, contract, slug}, max 30 (OpenSea's confirmed cap --
// caller is responsible for chunking anything larger than that).
// Identifiers from different collections/contracts can be freely mixed in
// one call, since each entry carries its own contract_address -- used by
// drainRankSyncQueue() below to drain the whole queue in one batch
// regardless of which collection each queued token belongs to.
async function fetchAndStoreOsRanksBatch(entries){
  if(!entries.length) return;
  try{
    const identifiers = entries.map(e => ({ chain: 'ethereum', contract_address: e.contract, token_id: String(e.id) }));
    const r = await fetch('https://api.opensea.io/api/v2/nfts/batch', {
      method: 'POST',
      headers: { ...osHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers })
    });
    if(r.status === 429){ console.warn(`[RankSync] 429 on a batch of ${entries.length} — will retry next cycle`); return; }
    if(!r.ok){ console.warn(`[RankSync] batch call failed: HTTP ${r.status}`); return; }
    const j = await r.json();
    const nfts = j?.nfts || [];
    // Match each returned NFT back to the collection it came from by
    // contract address (the response doesn't carry our own slug at all,
    // only OpenSea's own `collection` slug, which is a different namespace
    // than our own collections.slug in general).
    const byContract = new Map(entries.map(e => [e.contract.toLowerCase(), e.slug]));
    let updated = 0;
    for(const nft of nfts){
      const id = parseInt(nft.identifier);
      const rank = nft?.rarity?.rank ? parseInt(nft.rarity.rank) : null;
      const slug = byContract.get((nft.contract || '').toLowerCase());
      if(!id || !rank || !slug) continue;
      await pgPool.query('UPDATE tokens SET os_rank=$1 WHERE id=$2 AND collection_slug=$3', [rank, id, slug]).catch(() => {});
      updated++;
    }
    console.log(`[RankSync] batch of ${entries.length} → ${updated} os_rank values updated`);
  }catch(e){
    console.warn('[RankSync] batch failed:', e.message);
  }
}

async function rollingRankSync(){
  if(rankSyncQueue.size) return; // let burn-queued syncs run first
  const collections = await getReadyCollections();
  if(!collections.length) return;
  // Round-robin across collections, one batch per tick -- keeps the same
  // total call cadence as before multi-collection support (still one call
  // per RANK_SYNC_INTERVAL), just moving RANK_SYNC_BATCH_SIZE tokens through
  // it per call now instead of 1, and distributing calls across whichever
  // collections are actually onboarded rather than only ever OCAS.
  _roundRobinIdx = (_roundRobinIdx + 1) % collections.length;
  const { slug, contract } = collections[_roundRobinIdx];
  const cursor = _cursors.get(slug) || 1;
  try{
    // The burn-exclusion subquery only matters for OCAS (the only collection
    // with a burn mechanic at all -- burn_events has no collection_slug
    // column, so it can't be scoped per-collection without a schema change).
    // Applying it to any other collection would risk excluding a token id
    // that coincidentally matches an OCAS-burned id, even though that id was
    // never touched in that other collection at all.
    const query = slug === OCAS_SLUG
      ? `SELECT id FROM tokens WHERE id >= $1 AND collection_slug = $2 AND id NOT IN (
           SELECT DISTINCT bei.burned_token_id FROM burn_event_inputs bei
           JOIN burn_events be ON be.id = bei.burn_event_id
           WHERE bei.burned_token_id != be.survivor_token_id
         ) ORDER BY id ASC LIMIT $3`
      : `SELECT id FROM tokens WHERE id >= $1 AND collection_slug = $2 ORDER BY id ASC LIMIT $3`;
    const result = await pgPool.query(query, [cursor, slug, RANK_SYNC_BATCH_SIZE]);
    if(!result.rows.length){
      console.log(`[RankSync] ${slug}: completed a full pass through all tokens — restarting from #1`);
      _cursors.set(slug, 1);
      return;
    }
    const tokenIds = result.rows.map(r => r.id);
    _cursors.set(slug, tokenIds[tokenIds.length - 1] + 1);
    await fetchAndStoreOsRanksBatch(tokenIds.map(id => ({ id, contract, slug })));
  }catch(e){
    console.warn(`[RankSync] rolling sync error (${slug}):`, e.message);
  }
}

async function drainRankSyncQueue(){
  if(!rankSyncQueue.size) return;
  // Drain up to a full batch at once -- if several burns queued survivors
  // close together (or burn-poller.js's own direct rankSyncQueue.add(id)
  // call site fired more than once), this catches them all in one call
  // rather than one at a time. Safe to mix collections in a single call,
  // since each identifier carries its own contract address. Normalizes both
  // shapes that can land in this Set: a bare number (OCAS, including
  // burn-poller.js's direct .add(id) call, which bypasses queueRankSync()
  // entirely and predates multi-collection support) and a {id, slug,
  // contract} object (from queueRankSync() below, for any other collection).
  const drained = [...rankSyncQueue].slice(0, RANK_SYNC_BATCH_SIZE);
  drained.forEach(entry => rankSyncQueue.delete(entry));
  const entries = drained.map(entry =>
    (typeof entry === 'object' && entry !== null)
      ? entry
      : { id: entry, slug: OCAS_SLUG, contract: OCAS_CONTRACT }
  );
  await fetchAndStoreOsRanksBatch(entries);
}

function queueRankSync(survivorId, slug = OCAS_SLUG, contract = OCAS_CONTRACT){
  setTimeout(() => {
    rankSyncQueue.add(slug === OCAS_SLUG ? parseInt(survivorId) : { id: parseInt(survivorId), slug, contract });
    console.log(`[BurnMeta] OS rank update queued for ${slug}#${survivorId} in ${RANK_SYNC_DELAY_MS/1000}s`);
  }, RANK_SYNC_DELAY_MS);
}

module.exports = {
  rankSyncQueue, fetchAndStoreOsRanksBatch,
  rollingRankSync, drainRankSyncQueue, queueRankSync,
};
