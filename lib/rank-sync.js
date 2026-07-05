'use strict';

const fetch = require('node-fetch');
const { OCAS_CONTRACT, OCAS_SLUG, RANK_SYNC_DELAY_MS, osHeaders } = require('./constants');
const { pgPool } = require('./db');

const rankSyncQueue = new Set();
let _rankSyncCursor = 1;

async function fetchAndStoreOsRank(tokenId){
  const id = parseInt(tokenId);
  if(!id) return;
  try{
    const r = await fetch(
      `https://api.opensea.io/api/v2/chain/ethereum/contract/${OCAS_CONTRACT}/nfts/${id}`,
      { headers: osHeaders() }
    );
    if(r.status === 429){ console.warn(`[RankSync] 429 on #${id} — will retry next cycle`); return; }
    if(!r.ok) return;
    const j = await r.json();
    const rank = j?.nft?.rarity?.rank ? parseInt(j.nft.rarity.rank) : null;
    if(!rank) return;
    // Scoped to OCAS specifically — this function only ever queries OCAS_CONTRACT
    // above, so it must never touch another collection's row for the same id
    // (tokens.id alone is no longer unique post migrations/003).
    await pgPool.query('UPDATE tokens SET os_rank=$1 WHERE id=$2 AND collection_slug=$3', [rank, id, OCAS_SLUG]).catch(() => {});
    console.log(`[RankSync] #${id} os_rank updated → ${rank}`);
  }catch(e){
    console.warn(`[RankSync] #${id} failed:`, e.message);
  }
}

async function rollingRankSync(){
  if(rankSyncQueue.size) return; // let burn-queued syncs run first
  try{
    const result = await pgPool.query(
      `SELECT id FROM tokens WHERE id >= $1 AND collection_slug = $2 AND id NOT IN (
         SELECT DISTINCT bei.burned_token_id FROM burn_event_inputs bei
         JOIN burn_events be ON be.id = bei.burn_event_id
         WHERE bei.burned_token_id != be.survivor_token_id
       ) ORDER BY id ASC LIMIT 1`,
      [_rankSyncCursor, OCAS_SLUG]
    );
    if(!result.rows.length){ _rankSyncCursor = 1; return; }
    const tokenId = result.rows[0].id;
    _rankSyncCursor = tokenId + 1;
    await fetchAndStoreOsRank(tokenId);
  }catch(e){
    console.warn('[RankSync] rolling sync error:', e.message);
  }
}

async function drainRankSyncQueue(){
  if(!rankSyncQueue.size) return;
  const id = rankSyncQueue.values().next().value;
  rankSyncQueue.delete(id);
  await fetchAndStoreOsRank(id);
}

function queueRankSync(survivorId){
  setTimeout(() => {
    rankSyncQueue.add(parseInt(survivorId));
    console.log(`[BurnMeta] OS rank update queued for #${survivorId} in ${RANK_SYNC_DELAY_MS/1000}s`);
  }, RANK_SYNC_DELAY_MS);
}

module.exports = {
  rankSyncQueue, fetchAndStoreOsRank,
  rollingRankSync, drainRankSyncQueue, queueRankSync,
};
