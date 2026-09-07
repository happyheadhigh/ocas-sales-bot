'use strict';

// ── EIP-4906 metadata-update poller ─────────────────────────────────────────
// Confirmed live (2026-09-05): argonauts genuinely declares EIP-4906 support
// via supportsInterface(0x49064906) — verified via a direct eth_call, not
// just an event with a matching name. Confirmed separately that Alchemy's
// bulk getNFTsForContract never refreshes this specific contract's cached
// metadata regardless of refreshCache=true (byte-identical responses,
// identical timeLastUpdated, across both settings) — very likely tied to
// Alchemy having classified this contract isSpam:true, though that specific
// causation was never proven, only observed to correlate.
//
// This exists specifically to avoid the tradeoff explicitly rejected
// earlier tonight: switching the whole backfill to per-token eth_calls would
// have cost 10-70x the current ~2 minute bulk-backfill time for a
// 9,999-token collection. Instead: the fast bulk backfill stays completely
// untouched, and this does exactly one thing — watch for the contract's own
// signal that something changed, then refresh only the specific token(s)
// that did, via the same on-chain read /download already uses successfully.
//
// Deliberately narrow in scope for its first version: no BatchMetadataUpdate
// range cap tuning, no backoff/retry beyond what burnRpc already provides,
// no attempt to backfill EIP-4906 events that happened before this poller
// existed (a collection's own bulk backfill is the source of truth for
// initial state; this only watches for changes from here forward). Add
// those refinements if real usage shows they're needed, rather than
// building them speculatively now.

const { pgPool } = require('./db');
const { burnRpc, burnRpcUrl, rpcHostForLog, fetchTokenUri, loadJsonFromUri } = require('./rpc');
const { SUPPORTED_CHAINS, mapWithConcurrency } = require('./collection-backfill');
const { upsertTokenTraitRows, tokenMetaCache } = require('./embeds');
const { extractPngFromSvg } = require('./images');
const { clearCachedImage } = require('./cache');
const { isDiscordOk, verifyImageIsRaster } = require('../utils/format');
const { sendErrorWebhook } = require('./error');

// Confirmed live tonight: the "10-block eth_getLogs cap" was specifically
// observed on Robinhood Chain (Stackers/OCAS work) via a live error —
// generalizing that as a universal constant across every chain was wrong.
// Just confirmed directly: this same Alchemy account handles 10,000-block
// ranges on Ethereum with zero errors (raw-logs-check's own default window
// size, used successfully against argonauts). Only widening the default for
// chains with direct, confirmed evidence — Robinhood Chain and anything
// unconfirmed stay at the safe, proven-conservative default rather than
// assuming a wider limit that hasn't actually been tested there.
const CHAIN_BLOCK_CHUNK_DEFAULTS = { ethereum: 10000, robinhood: 10 };
function blockChunkForChain(chain){
  if(process.env.METADATA_UPDATE_BLOCK_CHUNK) return Math.max(1, parseInt(process.env.METADATA_UPDATE_BLOCK_CHUNK, 10));
  return CHAIN_BLOCK_CHUNK_DEFAULTS[chain] || 10;
}
const POLL_INTERVAL_MS = Math.max(60_000, parseInt(process.env.METADATA_UPDATE_POLL_MS || '300000', 10)); // 5 min default — this is a low-frequency signal, not a real-time feed
const BACKFILL_LOOKBACK_BLOCKS = Math.max(1, parseInt(process.env.METADATA_UPDATE_INITIAL_LOOKBACK || '10', 10)); // first run per collection: only look back a small window, not from genesis — this poller is for going forward, not backfilling history
const MAX_BATCH_RANGE_TOKENS = Math.max(1, parseInt(process.env.METADATA_UPDATE_MAX_BATCH_TOKENS || '500', 10)); // safety cap so one huge BatchMetadataUpdate range can't stall the whole poll cycle

let TOPIC_METADATA_UPDATE = null;
let TOPIC_BATCH_METADATA_UPDATE = null;
function computeTopics(){
  if(TOPIC_METADATA_UPDATE && TOPIC_BATCH_METADATA_UPDATE) return;
  const { id: ethersId } = require('ethers'); // ethers v6 — id() is keccak256(toUtf8Bytes(sig)) in one call
  TOPIC_METADATA_UPDATE = ethersId('MetadataUpdate(uint256)');
  TOPIC_BATCH_METADATA_UPDATE = ethersId('BatchMetadataUpdate(uint256,uint256)');
}

let _polling = false;

// ── Single-token refresh — the actual payoff of this whole file ────────────
// Reuses the exact same on-chain read path /download already uses
// successfully (fetchTokenUri + loadJsonFromUri, extracted to lib/rpc.js
// earlier tonight specifically so this file and download.js share one
// implementation instead of two).
async function refreshSingleTokenMetadata({ contract, tokenId, chain, slug }){
  const id = parseInt(tokenId);
  if(!id) return { ok: false, error: 'invalid tokenId' };
  try{
    const uri = await fetchTokenUri(contract, id, chain);
    const meta = await loadJsonFromUri(uri);
    const attrs = Array.isArray(meta.attributes) ? meta.attributes : (Array.isArray(meta.traits) ? meta.traits : []);

    if(attrs.length){
      // Scoped by collection_slug — see upsertTokenTraitRows' own comment on
      // why that matters once more than one collection shares this DB.
      // Passing no image via this path (traits.__image not set) — this
      // collection's image handling is entirely separate (tokens.image_url /
      // token_svg_cache, not token_image_snapshots, which is OCAS-specific).
      await upsertTokenTraitRows(id, attrs, 'eip4906-refresh', slug);
    }

    const imgSrc = meta.image || meta.image_data || meta.image_url || null;
    let imageActuallyUpdated = false; // only true once a DB write actually succeeds — imgSrc existing just means there was something to try
    if(imgSrc){
      const isSvgSource = String(imgSrc).trim().toLowerCase().startsWith('data:image/svg')
        || String(imgSrc).trim().toLowerCase().startsWith('<svg')
        || String(imgSrc).toLowerCase().includes('image/svg');
      if(isSvgSource){
        const buf = await extractPngFromSvg(imgSrc).catch(e => {
          console.warn(`[metadata-update] extractPngFromSvg failed for ${slug}#${id}:`, e.message);
          return null;
        });
        if(buf){
          await pgPool.query(
            `INSERT INTO token_svg_cache (token_id, collection_slug, image_data)
             VALUES ($1, $2, $3)
             ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=EXCLUDED.image_data`,
            [id, slug, imgSrc]
          );
          // Raw metadata's own image can genuinely be SVG source even when a
          // separately-stored tokens.image_url exists from an earlier
          // backfill — clear it so the SVG cache (now fresher) is what
          // display code actually reaches for next.
          await pgPool.query(`UPDATE tokens SET image_url=NULL WHERE id=$1 AND collection_slug=$2`, [id, slug]).catch(()=>{});
          imageActuallyUpdated = true;
        }
      } else if(String(imgSrc).startsWith('http') && isDiscordOk(imgSrc)){
        const isRaster = await verifyImageIsRaster(imgSrc);
        if(isRaster){
          await pgPool.query(`UPDATE tokens SET image_url=$1 WHERE id=$2 AND collection_slug=$3`, [imgSrc, id, slug]).catch(()=>{});
          imageActuallyUpdated = true;
        } else {
          const buf = await extractPngFromSvg(imgSrc).catch(() => null);
          if(buf){
            await pgPool.query(
              `INSERT INTO token_svg_cache (token_id, collection_slug, image_data)
               VALUES ($1, $2, $3)
               ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=EXCLUDED.image_data`,
              [id, slug, imgSrc]
            );
            imageActuallyUpdated = true;
          }
        }
      }
    }

    // Clear in-memory caches so the very next read picks up what was just
    // written, rather than waiting out tokenMetaCache's 5-minute TTL or an
    // imageCache entry that has no TTL at all.
    tokenMetaCache.delete(`${slug}:${id}`);
    clearCachedImage(`${contract}:${id}`);

    console.log(`[metadata-update] refreshed ${slug}#${id}: ${attrs.length} trait(s)${imageActuallyUpdated ? ', image updated' : (imgSrc ? ', image update attempted but failed (see warning above)' : '')}`);
    return { ok: true, traitsUpdated: attrs.length, imageUpdated: imageActuallyUpdated };
  }catch(e){
    console.warn(`[metadata-update] refresh failed for ${slug}#${id}:`, e.message);
    return { ok: false, error: e.message };
  }
}

// ── Per-collection poll ─────────────────────────────────────────────────────
async function pollOneCollection(col){
  const { slug, contract, chain } = col;
  const alchemySubdomain = SUPPORTED_CHAINS[chain] || SUPPORTED_CHAINS.ethereum;
  const rpcUrl = process.env.ALCHEMY_API_KEY && alchemySubdomain
    ? `https://${alchemySubdomain}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    : burnRpcUrl();
  if(!rpcUrl){
    console.warn(`[metadata-update] no RPC configured, skipping ${slug}`);
    return;
  }

  const latestHex = await burnRpc(rpcUrl, 'eth_blockNumber', []).catch(e => {
    console.warn(`[metadata-update] eth_blockNumber failed for ${slug}:`, e.message);
    return null;
  });
  if(!latestHex) return;
  const latestBlock = parseInt(latestHex, 16);

  let fromBlock = col.metadata_update_last_block != null
    ? parseInt(col.metadata_update_last_block) + 1
    : Math.max(0, latestBlock - BACKFILL_LOOKBACK_BLOCKS);
  if(fromBlock > latestBlock) return; // already caught up

  let cursor = fromBlock;
  const blockChunk = blockChunkForChain(chain);
  const refreshedTokenIds = new Set(); // avoid refreshing the same token twice in one cycle (e.g. a MetadataUpdate followed by a BatchMetadataUpdate covering it)

  while(cursor <= latestBlock){
    const chunkTo = Math.min(cursor + blockChunk - 1, latestBlock);
    let logs;
    try{
      logs = await burnRpc(rpcUrl, 'eth_getLogs', [{
        address: contract,
        fromBlock: '0x' + cursor.toString(16),
        toBlock: '0x' + chunkTo.toString(16),
        topics: [[TOPIC_METADATA_UPDATE, TOPIC_BATCH_METADATA_UPDATE]],
      }]);
    }catch(e){
      console.warn(`[metadata-update] eth_getLogs failed for ${slug} blocks ${cursor}-${chunkTo}:`, e.message);
      // Don't advance the cursor past a chunk that failed — retry it next cycle.
      break;
    }

    for(const log of logs){
      const topic0 = (log.topics[0] || '').toLowerCase();
      const data = (log.data || '0x').slice(2);
      try{
        if(topic0 === TOPIC_METADATA_UPDATE.toLowerCase()){
          const tokenId = parseInt(data.slice(0, 64), 16);
          if(!refreshedTokenIds.has(tokenId)){
            refreshedTokenIds.add(tokenId);
            await refreshSingleTokenMetadata({ contract, tokenId, chain, slug });
          }
        } else if(topic0 === TOPIC_BATCH_METADATA_UPDATE.toLowerCase()){
          const fromId = parseInt(data.slice(0, 64), 16);
          const toId = parseInt(data.slice(64, 128), 16);
          if(!isFinite(fromId) || !isFinite(toId) || toId < fromId) continue;
          const rangeSize = toId - fromId + 1;
          if(rangeSize > MAX_BATCH_RANGE_TOKENS){
            console.warn(`[metadata-update] ${slug} BatchMetadataUpdate range ${fromId}-${toId} (${rangeSize} tokens) exceeds cap of ${MAX_BATCH_RANGE_TOKENS} — refreshing first ${MAX_BATCH_RANGE_TOKENS} only this cycle`);
          }
          const cappedToId = Math.min(toId, fromId + MAX_BATCH_RANGE_TOKENS - 1);
          for(let tid = fromId; tid <= cappedToId; tid++){
            if(refreshedTokenIds.has(tid)) continue;
            refreshedTokenIds.add(tid);
            await refreshSingleTokenMetadata({ contract, tokenId: tid, chain, slug });
          }
        }
      }catch(e){
        console.warn(`[metadata-update] error processing log for ${slug}:`, e.message);
      }
    }

    cursor = chunkTo + 1;
  }

  // Persist however far we actually got, even if we stopped early due to an
  // eth_getLogs failure partway through — always forward progress, never
  // silently stuck at the original starting point.
  const newLastBlock = cursor - 1;
  if(newLastBlock >= fromBlock){
    await pgPool.query(`UPDATE collections SET metadata_update_last_block=$1 WHERE slug=$2`, [newLastBlock, slug]).catch(e => {
      console.warn(`[metadata-update] failed to persist cursor for ${slug}:`, e.message);
    });
  }

  if(refreshedTokenIds.size){
    console.log(`[metadata-update] ${slug}: refreshed ${refreshedTokenIds.size} token(s) from blocks ${fromBlock}-${newLastBlock}`);
  }
}

// ── Main poll cycle — every EIP-4906-supporting collection, one at a time ──
async function pollMetadataUpdates(){
  if(_polling) return; // don't overlap cycles if one run is still in flight
  _polling = true;
  try{
    computeTopics();
    const res = await pgPool.query(
      `SELECT slug, contract, chain, metadata_update_last_block FROM collections WHERE metadata_updates_supported = true`
    ).catch(e => { console.error('[metadata-update] failed to load collections:', e.message); return { rows: [] }; });

    for(const col of res.rows){
      try{
        await pollOneCollection(col);
      }catch(e){
        // One collection's failure should never block the others.
        console.error(`[metadata-update] poll failed for ${col.slug}:`, e.message);
        await sendErrorWebhook('Metadata Update Poller Error', e, `Collection: ${col.slug}`).catch(()=>{});
      }
    }
  }finally{
    _polling = false;
  }
}

function startMetadataUpdatePoller(){
  pollMetadataUpdates().catch(e => console.error('[metadata-update] initial poll failed:', e.message));
  setInterval(() => {
    pollMetadataUpdates().catch(e => console.error('[metadata-update] poll cycle failed:', e.message));
  }, POLL_INTERVAL_MS);
  console.log(`[metadata-update] poller started (interval=${POLL_INTERVAL_MS}ms, block chunk per chain: ${JSON.stringify(CHAIN_BLOCK_CHUNK_DEFAULTS)})`);
}

// ── One-time catch-up scan ───────────────────────────────────────────────────
// The regular poller above deliberately only watches forward from a small
// lookback window on first run — it was never meant to backfill history.
// Confirmed live: tokens that already changed before this poller existed
// (e.g. argonauts #4210's updated glasses trait) don't get picked up by the
// regular cycle at all, since nothing "new" happens to them going forward
// unless the project pushes another change to that same token. This exists
// specifically to catch up on whatever already happened once, as an
// explicitly-triggered operation — not part of the regular polling loop,
// since scanning a large historical range is a real, one-off cost that
// shouldn't repeat every 5 minutes forever.
//
// Callers should determine a sane fromBlock themselves first (e.g. via the
// /db/stackers/raw-logs-check diagnostic endpoint's fromBlock= param, which
// can find exactly how far back a contract's first MetadataUpdate/
// BatchMetadataUpdate event actually goes) rather than defaulting this to 0
// and scanning a contract's entire history unconditionally, which could be
// a very large number of chunked eth_getLogs calls for an old contract.
async function catchUpMetadataHistory({ slug, contract, chain, fromBlock }){
  computeTopics();
  const alchemySubdomain = SUPPORTED_CHAINS[chain] || SUPPORTED_CHAINS.ethereum;
  const rpcUrl = process.env.ALCHEMY_API_KEY && alchemySubdomain
    ? `https://${alchemySubdomain}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    : burnRpcUrl();
  if(!rpcUrl) throw new Error('No RPC configured');

  const latestHex = await burnRpc(rpcUrl, 'eth_blockNumber', []);
  const latestBlock = parseInt(latestHex, 16);
  if(fromBlock > latestBlock) return { ok: true, tokensRefreshed: 0, chunksScanned: 0, note: 'fromBlock is already past latest block' };

  let cursor = fromBlock;
  let chunksScanned = 0;
  const blockChunk = blockChunkForChain(chain);
  const refreshedTokenIds = new Set();
  const startedAt = Date.now();

  while(cursor <= latestBlock){
    const chunkTo = Math.min(cursor + blockChunk - 1, latestBlock);
    const logs = await burnRpc(rpcUrl, 'eth_getLogs', [{
      address: contract,
      fromBlock: '0x' + cursor.toString(16),
      toBlock: '0x' + chunkTo.toString(16),
      topics: [[TOPIC_METADATA_UPDATE, TOPIC_BATCH_METADATA_UPDATE]],
    }]);
    chunksScanned++;

    for(const log of logs){
      const topic0 = (log.topics[0] || '').toLowerCase();
      const data = (log.data || '0x').slice(2);
      if(topic0 === TOPIC_METADATA_UPDATE.toLowerCase()){
        const tokenId = parseInt(data.slice(0, 64), 16);
        if(!refreshedTokenIds.has(tokenId)){
          refreshedTokenIds.add(tokenId);
          await refreshSingleTokenMetadata({ contract, tokenId, chain, slug });
        }
      } else if(topic0 === TOPIC_BATCH_METADATA_UPDATE.toLowerCase()){
        const fromId = parseInt(data.slice(0, 64), 16);
        const toId = parseInt(data.slice(64, 128), 16);
        if(!isFinite(fromId) || !isFinite(toId) || toId < fromId) continue;
        const cappedToId = Math.min(toId, fromId + MAX_BATCH_RANGE_TOKENS - 1);
        for(let tid = fromId; tid <= cappedToId; tid++){
          if(refreshedTokenIds.has(tid)) continue;
          refreshedTokenIds.add(tid);
          await refreshSingleTokenMetadata({ contract, tokenId: tid, chain, slug });
        }
      }
    }

    cursor = chunkTo + 1;
    // Log progress periodically for a scan that might genuinely take a
    // while — a silent, long-running operation with no visibility is
    // indistinguishable from a hung one.
    if(chunksScanned % 50 === 0){
      console.log(`[metadata-update] catch-up ${slug}: ${chunksScanned} chunks scanned, ${refreshedTokenIds.size} token(s) refreshed so far, at block ${cursor}/${latestBlock}`);
    }
  }

  // Hand off to the regular poller from here forward — no need to ever
  // re-scan this same history again.
  await pgPool.query(`UPDATE collections SET metadata_update_last_block=$1 WHERE slug=$2`, [latestBlock, slug]).catch(e => {
    console.warn(`[metadata-update] catch-up: failed to persist cursor for ${slug}:`, e.message);
  });

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[metadata-update] catch-up complete for ${slug}: ${refreshedTokenIds.size} token(s) refreshed across ${chunksScanned} chunks (blocks ${fromBlock}-${latestBlock}) in ${elapsedSec}s`);
  return { ok: true, tokensRefreshed: refreshedTokenIds.size, chunksScanned, fromBlock, toBlock: latestBlock, elapsedSec };
}

// ── Full-collection direct verification — bypasses events entirely ─────────
// Confirmed live: this contract's own MetadataUpdate/BatchMetadataUpdate
// signal is not reliable at scale -- the full historical catch-up scan
// (covering the entire range from deployment to now) and the ongoing
// 5-minute poller together still missed what the user estimates as
// "hundreds to maybe thousands" of tokens whose traits changed prior to
// tonight's work. No amount of event-listening can catch changes the
// contract itself never announced, at any scale -- the event mechanism
// stays valuable as the fast path for genuinely new changes going forward
// (confirmed working correctly for 502 tokens), but can no longer be
// trusted as the SOLE source of truth for this collection's existing
// history. This checks every token directly against the chain instead,
// with no dependency on the contract announcing anything at all.
//
// A real, substantial one-time cost: one on-chain read per token, so
// ~9,999 tokens at reasonable concurrency realistically takes several
// minutes, not seconds. Runs with bounded concurrency (not sequential, not
// unbounded) to keep this from either taking an excessive amount of time or
// overwhelming the RPC provider / this service's own Sharp rendering
// (already capped at concurrency 2 in lib/svg-render.js) with too many
// requests in flight simultaneously.
let _fullVerificationRunning = new Set(); // tracks in-progress slugs — prevents an accidental double-trigger (the endpoint returns immediately, so it's not obvious from the response alone that one is already running) from doubling RPC/DB load for no benefit, since both runs would just process the same tokens
async function fullCollectionVerification({ slug, contract, chain, concurrency = 10 }){
  if(_fullVerificationRunning.has(slug)){
    console.log(`[metadata-update] full verification for ${slug} already in progress — skipping duplicate trigger`);
    return { ok: false, error: `Full verification for "${slug}" is already running — check logs for its progress instead of starting another one` };
  }
  _fullVerificationRunning.add(slug);
  try{
    const tokensRes = await pgPool.query(
      `SELECT id FROM tokens WHERE collection_slug=$1 ORDER BY id`,
      [slug]
    );
    const tokenIds = tokensRes.rows.map(r => r.id);
    console.log(`[metadata-update] full verification starting for ${slug}: ${tokenIds.length} token(s) to check, concurrency=${concurrency}`);

    const startedAt = Date.now();
    let completed = 0;
    let succeeded = 0;
    let failed = 0;

    await mapWithConcurrency(tokenIds, concurrency, async (tokenId) => {
      const result = await refreshSingleTokenMetadata({ contract, tokenId, chain, slug });
      completed++;
      if(result.ok) succeeded++; else failed++;
      if(completed % 250 === 0 || completed === tokenIds.length){
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[metadata-update] full verification ${slug}: ${completed}/${tokenIds.length} checked (${succeeded} ok, ${failed} failed) in ${elapsedSec}s`);
      }
    });

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[metadata-update] full verification complete for ${slug}: ${tokenIds.length} token(s) checked, ${succeeded} ok, ${failed} failed, in ${elapsedSec}s`);
    return { ok: true, totalTokens: tokenIds.length, succeeded, failed, elapsedSec };
  }finally{
    _fullVerificationRunning.delete(slug);
  }
}

module.exports = {
  startMetadataUpdatePoller,
  pollMetadataUpdates,
  refreshSingleTokenMetadata,
  catchUpMetadataHistory,
  fullCollectionVerification,
};
