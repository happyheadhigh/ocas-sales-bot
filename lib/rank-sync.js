'use strict';

const fetch = require('node-fetch');
const { OCAS_CONTRACT, OCAS_SLUG, RANK_SYNC_DELAY_MS, osHeaders } = require('./constants');
const { pgPool } = require('./db');

// Confirmed live: this whole module was hardcoded to OCAS_CONTRACT/OCAS_SLUG
// everywhere -- the rolling sync only ever refreshed OCAS's own os_rank
// values. Argonauts' (and any future collection's) os_rank was set once at
// backfill and never touched again. Generalized below to cycle through every
// 'ready' collection, one token per tick, round-robin -- same total OpenSea
// call rate as before (RANK_SYNC_INTERVAL is unchanged), just spread across
// collections instead of always OCAS, so no collection's onboarding gets a
// bigger slice of the shared rate budget just by being added later.
//
// Confirmed the single-token OpenSea endpoint used below DOES carry rarity
// (`nft.rarity.rank`) -- the bulk "NFTs by collection" endpoint does NOT
// (tested directly against Argonauts: no `rarity` field on any returned
// NFT object at all), which is why this stays a slow, one-call-per-token
// rolling sync rather than switching to a handful of bulk calls.

const rankSyncQueue = new Set(); // bare token ids (OCAS) or {id, slug, contract} entries queued for near-immediate sync (post-burn)
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

async function fetchAndStoreOsRank(tokenId, contract = OCAS_CONTRACT, slug = OCAS_SLUG){
  const id = parseInt(tokenId);
  if(!id) return;
  try{
    const r = await fetch(
      `https://api.opensea.io/api/v2/chain/ethereum/contract/${contract}/nfts/${id}`,
      { headers: osHeaders() }
    );
    if(r.status === 429){ console.warn(`[RankSync] 429 on ${slug}#${id} — will retry next cycle`); return; }
    if(!r.ok) return;
    const j = await r.json();
    const rank = j?.nft?.rarity?.rank ? parseInt(j.nft.rarity.rank) : null;
    if(!rank) return;
    // Scoped by collection_slug -- tokens.id alone is no longer unique
    // post migrations/003 (every collection has its own #1, #2, etc.).
    await pgPool.query('UPDATE tokens SET os_rank=$1 WHERE id=$2 AND collection_slug=$3', [rank, id, slug]).catch(() => {});
    console.log(`[RankSync] ${slug}#${id} os_rank updated → ${rank}`);
  }catch(e){
    console.warn(`[RankSync] ${slug}#${id} failed:`, e.message);
  }
}

async function rollingRankSync(){
  if(rankSyncQueue.size) return; // let burn-queued syncs run first
  const collections = await getReadyCollections();
  if(!collections.length) return;
  // Round-robin across collections, one token per tick -- keeps the total
  // OpenSea call rate identical to the pre-multi-collection version (still
  // one call per RANK_SYNC_INTERVAL), just distributed across whichever
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
         ) ORDER BY id ASC LIMIT 1`
      : `SELECT id FROM tokens WHERE id >= $1 AND collection_slug = $2 ORDER BY id ASC LIMIT 1`;
    const result = await pgPool.query(query, [cursor, slug]);
    if(!result.rows.length){
      console.log(`[RankSync] ${slug}: completed a full pass through all tokens — restarting from #1`);
      _cursors.set(slug, 1);
      return;
    }
    const tokenId = result.rows[0].id;
    _cursors.set(slug, tokenId + 1);
    await fetchAndStoreOsRank(tokenId, contract, slug);
  }catch(e){
    console.warn(`[RankSync] rolling sync error (${slug}):`, e.message);
  }
}

async function drainRankSyncQueue(){
  if(!rankSyncQueue.size) return;
  const entry = rankSyncQueue.values().next().value;
  rankSyncQueue.delete(entry);
  // Entries queued via burn-poller.js (only ever OCAS survivors) are bare
  // numbers, not {id, slug, contract} objects -- handle both so nothing
  // calling the old shape breaks.
  if(typeof entry === 'object' && entry !== null){
    await fetchAndStoreOsRank(entry.id, entry.contract || OCAS_CONTRACT, entry.slug || OCAS_SLUG);
  } else {
    await fetchAndStoreOsRank(entry, OCAS_CONTRACT, OCAS_SLUG);
  }
}

function queueRankSync(survivorId, slug = OCAS_SLUG, contract = OCAS_CONTRACT){
  setTimeout(() => {
    rankSyncQueue.add(slug === OCAS_SLUG ? parseInt(survivorId) : { id: parseInt(survivorId), slug, contract });
    console.log(`[BurnMeta] OS rank update queued for ${slug}#${survivorId} in ${RANK_SYNC_DELAY_MS/1000}s`);
  }, RANK_SYNC_DELAY_MS);
}

module.exports = {
  rankSyncQueue, fetchAndStoreOsRank,
  rollingRankSync, drainRankSyncQueue, queueRankSync,
};
