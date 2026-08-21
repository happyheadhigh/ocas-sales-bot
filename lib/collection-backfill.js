/**
 * lib/collection-backfill.js
 * ─────────────────────────────────────────────────────────────────
 * Reusable core of the collection trait backfill (originally
 * backfill-collection-traits.js, a CLI-only script). Extracted so the
 * bot can trigger this automatically — see runCollectionBackfill()
 * below — without spawning a child process or duplicating logic.
 *
 * The CLI script (backfill-collection-traits.js) still exists for
 * manual/resumable runs with checkpoint files, debug dumps, and
 * --dry-run — this module intentionally does NOT replace it, it's
 * the shared engine underneath both call sites.
 *
 * Same OCAS guard, same rate-limit strategy, same DB write pattern as
 * the original script — see backfill-collection-traits.js for the
 * full rationale comments on each of those.
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

const fetch = require('node-fetch');
const { osHeaders } = require('./constants');
// burnRpc/burnRpcUrl removed — tokenURI now uses Alchemy RPC directly

const PAGE_SIZE = 100;
const DELAY_MS  = 100;
const MAX_CONSECUTIVE_FAILS = 5; // getNFTsForContract failures before giving up and switching to range mode

// ── Global IPFS gateway throttle ──────────────────────────────────────────────
// Confirmed live: public IPFS gateways (ipfs.io, Pinata, dweb.link, w3s.link)
// CAN serve robinhood-chimps' metadata — Pinata succeeded for tokens 1 and 5
// in one run — but under the full 8-way page concurrency, several
// simultaneous requests to the same gateway/CID would time out while others
// succeeded. That's a classic per-IP rate-limit/connection-cap symptom on
// free public gateways, not unavailable content. Re-running the whole
// backfill repeatedly and hoping for better luck each time isn't
// acceptable — a collection add needs to be one-and-done. This semaphore
// caps how many IPFS gateway races can be in flight AT ONCE, globally
// across the entire run (not just within one page's batch), independent of
// the broader 8-way concurrency used for everything else in writePage.
class Semaphore {
  constructor(limit){ this.limit = limit; this.active = 0; this.queue = []; }
  async acquire(){
    if(this.active < this.limit){ this.active++; return; }
    await new Promise(resolve => this.queue.push(resolve));
    this.active++;
  }
  release(){
    this.active--;
    const next = this.queue.shift();
    if(next) next();
  }
}
const ipfsGatewaySemaphore = new Semaphore(3);

// ── Per-gateway cooldown on rate-limiting ─────────────────────────────────────
// Confirmed live: Pinata's public gateway — the one most reliably winning the
// race — started returning HTTP 429 after roughly 500+ tokens' worth of
// cumulative requests in one run. That's a rate-limit-over-time symptom, not
// a concurrency problem — the semaphore above already caps concurrent
// requests correctly, but doesn't prevent exceeding a "requests per minute"
// ceiling from sustained volume. Continuing to hit an already-429'd gateway
// wastes a full retry cycle for nothing and risks extending the penalty, so
// any gateway that 429s gets skipped entirely for a cooldown period instead
// of being retried immediately.
const gatewayCooldownUntil = {};
const GATEWAY_COOLDOWN_MS = 90 * 1000;
function isGatewayCoolingDown(name){ return (gatewayCooldownUntil[name] || 0) > Date.now(); }
function startGatewayCooldown(name){
  // Confirmed live: with several tokens racing concurrently, multiple ones
  // can independently hit the same 429 within milliseconds of each other,
  // each logging the identical message before any of them observe the
  // cooldown the others just set — 30+ duplicate lines for one real event.
  // Still refreshes the cooldown timer each time (reasonable — if 429s keep
  // arriving, keep waiting), just only logs once per cooldown window.
  const alreadyCoolingDown = isGatewayCoolingDown(name);
  gatewayCooldownUntil[name] = Date.now() + GATEWAY_COOLDOWN_MS;
  if(!alreadyCoolingDown){
    console.warn(`[backfill] Gateway "${name}" rate-limited (429) — pausing use of it for ${GATEWAY_COOLDOWN_MS/1000}s`);
  }
}

// ── Supported chains ──────────────────────────────────────────────────────────
// Alchemy subdomain per chain, confirmed directly against Alchemy's own docs
// for each (not guessed) — same discipline as the Stream API field mapping.
// Adding a new EVM chain here is legitimately cheap; adding a non-EVM chain
// (Solana, Tezos, etc.) is NOT — those need an entirely different data model
// (no contract+tokenId+tokenURI concept) and don't belong in this registry.
const SUPPORTED_CHAINS = {
  ethereum:  'eth-mainnet',
  base:      'base-mainnet',
  polygon:   'polygon-mainnet',
  robinhood: 'robinhood-mainnet',
};

// ── tokenURI fallback for collections with missing Alchemy metadata ───────────
// Calls eth_call tokenURI(uint256) on the given contract, fetches the resulting
// URI (IPFS, HTTP, or data:), and extracts attributes + image from the JSON.
// Returns { attrs: [{trait_type, value}], imageUrl: string|null } or null.

const TOKEN_URI_SELECTOR = '0xc87b56dd'; // keccak256("tokenURI(uint256)")[:4]

function decodeAbiString(hex){
  // ABI-encoded string: 32-byte offset + 32-byte length + utf8 bytes
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if(data.length < 128) return null;
  const byteLen = parseInt(data.slice(64, 128), 16);
  if(!byteLen) return null;
  return Buffer.from(data.slice(128, 128 + byteLen * 2), 'hex').toString('utf-8');
}

async function resolveUri(uri, alchemyKey, alchemySubdomain, tokenId){
  if(!uri) return null;
  const verbose = tokenId != null && tokenId <= 5;
  try{
    // data URI — decode inline
    if(uri.startsWith('data:application/json;base64,')){
      return JSON.parse(Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf-8'));
    }
    if(uri.startsWith('data:application/json,')){
      return JSON.parse(decodeURIComponent(uri.slice('data:application/json,'.length)));
    }
    // IPFS — race Alchemy's gateway and several public gateways concurrently,
    // taking whichever responds first, instead of trying them one at a time.
    // Confirmed live on robinhood-chimps: Alchemy's ipfsGateway proxy 404s
    // outright for CIDs with a folder-style subpath appended
    // (ipfs://<cid>/<tokenId>, as opposed to a bare per-token CID) — it
    // simply doesn't support that URI shape. A single sequential ipfs.io
    // fallback wasn't enough either: confirmed live it can time out (not
    // just error fast) on cold/unpinned content, and trying gateways one
    // after another with their own timeouts means a bad run stacks every
    // gateway's full timeout on top of the last — exactly what made a
    // backfill that used to take ~30s/page take ~2min/page instead, with
    // nothing to show for the extra time. Racing them bounds the worst case
    // to one timeout window total, no matter how many gateways are tried.
    // cloudflare-ipfs.com was in this list briefly — confirmed decommissioned
    // since August 2024 (DNS doesn't even resolve), so it was dead weight,
    // not a real fallback. nftstorage.link was also dropped after confirming
    // live it just redirects to ipfs.io's own backend, so it wasn't a
    // genuinely independent attempt either. Pinata and web3.storage's w3s.link
    // are included instead since they often have their own cached/pinned
    // copies of NFT metadata specifically, which generic public gateways may
    // not — w3s.link in particular is itself a caching layer that races
    // multiple underlying gateways on its own end.
    if(uri.startsWith('ipfs://')){
      const cid = uri.slice(7);
      const allCandidates = [];
      if(alchemyKey) allCandidates.push({ name: 'alchemy', url: `https://${alchemySubdomain}.g.alchemy.com/nft/v3/${alchemyKey}/ipfsGateway/${cid}` });
      allCandidates.push(
        { name: 'ipfs.io', url: `https://ipfs.io/ipfs/${cid}` },
        { name: 'pinata', url: `https://gateway.pinata.cloud/ipfs/${cid}` },
        { name: 'w3s.link', url: `https://w3s.link/ipfs/${cid}` },
        { name: 'dweb.link', url: `https://dweb.link/ipfs/${cid}` },
      );
      const GATEWAY_TIMEOUT_MS = 12000;
      // Retry the WHOLE race automatically within this same run — confirmed
      // live that Pinata (and presumably others) genuinely CAN serve this
      // content, but under heavy simultaneous load some requests time out
      // while others succeed. That's a rate-limit/connection-cap symptom,
      // not unavailable content, so a transient failure deserves a real
      // second (and third, and fourth) chance automatically — a collection
      // add needs to be one-and-done, not "run it a few times and hope".
      // Combined with the semaphore above (caps concurrent races globally,
      // not just within one page's batch), this should make most tokens
      // succeed on the first attempt and catch the rest via retry, without
      // ever requiring the person to manually re-trigger anything.
      const MAX_RETRIES = 4;
      const RETRY_BACKOFF_MS = [2000, 4000, 8000];
      for(let attempt = 1; attempt <= MAX_RETRIES; attempt++){
        // Skip any gateway currently in a 429 cooldown rather than wasting a
        // request on it — Alchemy is exempt since it's our own paid account,
        // not a shared public rate limit, so it never gets a cooldown set.
        const candidates = allCandidates.filter(c => !isGatewayCoolingDown(c.name));
        if(!candidates.length){
          if(verbose) console.warn(`[backfill] token ${tokenId} all IPFS gateways currently on cooldown for ${cid}, waiting before retrying`);
          await sleep(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]);
          continue;
        }
        await ipfsGatewaySemaphore.acquire();
        let aggregateErr;
        try{
          const attempts = candidates.map(({ name, url }) =>
            fetch(url, { timeout: GATEWAY_TIMEOUT_MS }).then(r => {
              if(r.status === 429){ startGatewayCooldown(name); throw new Error(`HTTP 429 from ${url}`); }
              if(!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
              return r.json();
            })
          );
          return await Promise.any(attempts);
        }catch(e){
          aggregateErr = e;
        }finally{
          ipfsGatewaySemaphore.release();
        }
        const reasons = (aggregateErr.errors || []).map(e => e.message).join(' | ');
        if(attempt < MAX_RETRIES){
          if(verbose) console.warn(`[backfill] token ${tokenId} IPFS attempt ${attempt}/${MAX_RETRIES} failed for ${cid}, retrying in ${RETRY_BACKOFF_MS[attempt-1]}ms: ${reasons}`);
          await sleep(RETRY_BACKOFF_MS[attempt - 1]);
        } else {
          console.warn(`[backfill] token ${tokenId} IPFS gateways failed after ${MAX_RETRIES} attempts for ${cid}: ${reasons}`);
        }
      }
      return null;
    }
    const r = await fetch(uri, { timeout: 10000 });
    if(!r.ok){
      if(verbose) console.warn(`[backfill] token ${tokenId} resolveUri HTTP ${r.status} for ${uri.slice(0,120)}`);
      return null;
    }
    return await r.json();
  }catch(e){
    if(verbose) console.warn(`[backfill] token ${tokenId} resolveUri failed for ${uri.slice(0,120)}: ${e.message}`);
    return null;
  }
}

// OpenSea already resolves and caches images on their own CDN for any
// actively-indexed collection — confirmed live that OpenSea officially
// supports Robinhood Chain and that robinhood-chimps specifically has a
// real, actively-traded collection page there. That means this doesn't need
// to touch IPFS/Pinata/rate-limits AT ALL for tokens OpenSea already knows
// about — it's the exact same lookup the bot's own /token command already
// uses for live image display, just never wired into the backfill before.
async function fetchOpenSeaMetadata(contract, tokenId, chain){
  const r = await fetch(`https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}/nfts/${tokenId}`, { headers: osHeaders(), timeout: 12000 });
  if(!r.ok) throw new Error(`OpenSea HTTP ${r.status}`);
  const j = await r.json();
  if(!j.nft) throw new Error('OpenSea response missing nft field');
  if(tokenId <= 5) console.log(`[backfill] token ${tokenId} OpenSea metadata fetch succeeded`);
  return j.nft;
}

async function fetchTokenUriMetadata(contract, tokenId, alchemyKey, alchemySubdomain, chain){
  if(!alchemyKey) return null;
  // Race OpenSea's own cached metadata (fast, no shared public rate limits)
  // against the on-chain tokenURI -> IPFS gateway path, taking whichever
  // succeeds first. Every real backfill run this session has shown IPFS
  // gateways are the actual bottleneck (timeouts, 429s) — OpenSea sidesteps
  // all of that for any collection it's already indexed. Every failure path
  // below THROWS rather than returning null — Promise.any treats a
  // resolved `null` as a win, which would short-circuit the race the moment
  // either path hit its first soft failure instead of waiting for the
  // other candidate to actually succeed.
  const candidates = [];
  if(chain) candidates.push(fetchOpenSeaMetadata(contract, tokenId, chain));
  candidates.push((async () => {
    const paddedId = parseInt(tokenId).toString(16).padStart(64, '0');
    const rpcUrl = `https://${alchemySubdomain}.g.alchemy.com/v2/${alchemyKey}`;
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: contract, data: TOKEN_URI_SELECTOR + paddedId }, 'latest']
      })
    });
    if(!r.ok){
      if(tokenId <= 5) console.warn(`[backfill] token ${tokenId} eth_call HTTP ${r.status} on ${alchemySubdomain}`);
      throw new Error(`eth_call HTTP ${r.status}`);
    }
    const j = await r.json();
    // JSON-RPC errors often come back with HTTP 200 but an error field
    // instead of result — the old code silently treated this identically to
    // "no result", with zero visibility into the actual rejection reason.
    if(j.error){
      if(tokenId <= 5) console.warn(`[backfill] token ${tokenId} eth_call RPC error on ${alchemySubdomain}: ${JSON.stringify(j.error)}`);
      throw new Error(`eth_call RPC error: ${JSON.stringify(j.error)}`);
    }
    const result = j.result;
    if(!result || result === '0x'){
      if(tokenId <= 5) console.warn(`[backfill] token ${tokenId} eth_call returned empty result on ${alchemySubdomain} (contract may not implement tokenURI, or token doesn't exist)`);
      throw new Error('eth_call returned empty result');
    }
    const uri = decodeAbiString(result);
    if(!uri){
      if(tokenId <= 5) console.warn(`[backfill] token ${tokenId} eth_call result could not be decoded as a string: ${result.slice(0, 100)}`);
      throw new Error('eth_call result could not be decoded as a string');
    }
    if(tokenId <= 5) console.log(`[backfill] token ${tokenId} tokenURI resolved: ${uri.slice(0, 120)}`);
    const resolved = await resolveUri(uri, alchemyKey, alchemySubdomain, tokenId);
    if(tokenId <= 5) console.log(`[backfill] token ${tokenId} resolveUri result: ${resolved ? JSON.stringify(resolved).slice(0, 300) : 'null'}`);
    if(!resolved) throw new Error('resolveUri exhausted all IPFS gateways');
    return resolved;
  })());

  try{
    return await Promise.any(candidates);
  }catch(aggregateErr){
    if(tokenId <= 5){
      const reasons = (aggregateErr.errors || []).map(e => e.message).join(' | ');
      console.warn(`[backfill] token ${tokenId} both OpenSea and on-chain/IPFS paths failed: ${reasons}`);
    }
    return null;
  }
}

const OCAS_SLUG_LOWER     = 'on-chain-all-stars';
const OCAS_CONTRACT_LOWER = '0x078be86f3104a32313a47815792230a3808642cc';

// The metadata JSON fetch (resolveUri, above) already races multiple
// gateways + OpenSea + retries + 429 cooldowns. But once that JSON is in
// hand, its own `image`/`image_url` FIELD can still be a raw ipfs:// URI
// that needs its own rewrite to something Discord/a browser can actually
// load — and every place that did this rewrite hardcoded ipfs.io
// specifically, the one gateway confirmed to reliably time out for this
// collection's content. This meant even a fully successful metadata
// resolution could still end up with an unreachable stored image URL.
// w3s.link confirmed fast and reliable in every live test this session
// (100-120ms), so it's used here instead. Prefers an already-valid
// http(s) URL as-is (e.g. OpenSea's own resolved CDN link) over rewriting
// anything unnecessarily.
function toDisplayableImageUrl(rawField){
  if(!rawField) return null;
  if(rawField.startsWith('http://') || rawField.startsWith('https://')) return rawField;
  if(rawField.startsWith('ipfs://')) return `https://w3s.link/ipfs/${rawField.slice(7)}`;
  return rawField; // data: URIs, inline SVG, etc. — handled by isSvgImage checks downstream
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Runs fn(item) over items with at most `limit` in flight at once, preserving
// input order in the returned array. Used to replace fully-serial
// one-request-at-a-time loops (fetchTokensByRange, writePage's per-token
// on-chain/IPFS enrichment) that were the actual bottleneck in backfill
// runtime — a 100-token page previously made ~100-200 sequential network
// round trips one at a time; this runs them CONCURRENCY at a time instead.
// Kept deliberately modest (default 8) to stay well under typical Alchemy
// rate limits rather than risk a 429 storm.
async function mapWithConcurrency(items, limit, fn){
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker(){
    while(true){
      const i = nextIndex++;
      if(i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function normalizeTraitAttribute(t){
  if(!t || typeof t !== 'object') return null;
  const trait_type = t.trait_type || t.traitType || t.type || t.name;
  const value = t.value;
  if(!trait_type || value == null) return null;
  return { trait_type: String(trait_type), value: String(value) };
}

// Handles two shapes: the standard array ([{trait_type, value}]) that
// almost every collection uses, and an object keyed by trait category
// ({category: value} or {category: {value, state, ...}}) — seen on
// OnChainHoodies' own API, which returns traits this second way. This is a
// best-evidence guess at the raw on-chain tokenURI shape based on that API's
// response (not independently confirmed against the raw tokenURI directly,
// since that's not reachable from where this was written) — worth
// double-checking against real results once this actually runs.
function extractTraits(rawAttrs){
  if(Array.isArray(rawAttrs)){
    return rawAttrs.map(normalizeTraitAttribute).filter(Boolean);
  }
  if(rawAttrs && typeof rawAttrs === 'object'){
    const out = [];
    for(const [category, val] of Object.entries(rawAttrs)){
      if(val == null) continue;
      if(typeof val === 'object'){
        // {category: {value: "...", state: "present"/"absent", ...}}
        if(val.state && String(val.state).toLowerCase() === 'absent') continue;
        if(val.value != null) out.push({ trait_type: String(category), value: String(val.value) });
      } else {
        // {category: "value"}
        out.push({ trait_type: String(category), value: String(val) });
      }
    }
    return out;
  }
  return [];
}

async function fetchPage(alchemyKey, contract, pageKey, alchemySubdomain, retries = 0){
  const url = new URL(`https://${alchemySubdomain}.g.alchemy.com/nft/v3/${alchemyKey}/getNFTsForContract`);
  url.searchParams.set('contractAddress', contract);
  url.searchParams.set('withMetadata', 'true');
  url.searchParams.set('limit', String(PAGE_SIZE));
  if(pageKey) url.searchParams.set('startToken', pageKey);

  try{
    const r = await fetch(url.toString(), { timeout: 15000 });
    if(r.status === 429){
      const wait = Math.min(2000 * Math.pow(2, retries), 60000);
      await sleep(wait);
      return fetchPage(alchemyKey, contract, pageKey, alchemySubdomain, Math.min(retries + 1, 5));
    }
    if(!r.ok){
      if(retries < 3){ await sleep(3000 * (retries + 1)); return fetchPage(alchemyKey, contract, pageKey, alchemySubdomain, retries + 1); }
      return { error: `HTTP ${r.status}` };
    }
    const j = await r.json();
    return { nfts: j.nfts || [], pageKey: j.pageKey || null, totalCount: j.totalCount || null };
  }catch(e){
    if(retries < 3){ await sleep(3000 * (retries + 1)); return fetchPage(alchemyKey, contract, pageKey, alchemySubdomain, retries + 1); }
    return { error: e.message };
  }
}

// Fallback: fetch a single token via tokenURI when Alchemy pagination is broken
// ── Diagnostics-only helpers ─────────────────────────────────────────────────
// Extracted so a single token/CID can be checked directly via an API
// endpoint, without running any part of a real backfill (no DB writes, no
// page loop, no 8-way concurrency) — useful for figuring out where an
// image/metadata actually lives before committing to a multi-minute
// collection-wide run.

// Same eth_call as fetchTokenUriMetadata, but stops after decoding the raw
// URI string instead of also resolving it — lets a diagnostic endpoint
// report the on-chain tokenURI even if every gateway below fails.
async function fetchRawTokenUri(contract, tokenId, alchemyKey, alchemySubdomain){
  const paddedId = parseInt(tokenId).toString(16).padStart(64, '0');
  const rpcUrl = `https://${alchemySubdomain}.g.alchemy.com/v2/${alchemyKey}`;
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: contract, data: TOKEN_URI_SELECTOR + paddedId }, 'latest']
    })
  });
  if(!r.ok) throw new Error(`eth_call HTTP ${r.status}`);
  const j = await r.json();
  if(j.error) throw new Error(`eth_call RPC error: ${JSON.stringify(j.error)}`);
  if(!j.result || j.result === '0x') throw new Error('eth_call returned empty result (contract may not implement tokenURI, or token does not exist)');
  const uri = decodeAbiString(j.result);
  if(!uri) throw new Error(`eth_call result could not be decoded as a string: ${j.result.slice(0,100)}`);
  return uri;
}

// Tests every gateway candidate INDIVIDUALLY (not racing to first success)
// and reports each one's own outcome + timing — this is what actually
// answers "which gateway works" instead of just "did any gateway work".
// Mirrors the exact same candidate list resolveUri() races, so results here
// predict what a real backfill would do for this same URI.
async function diagnoseIpfsGateways(uri, alchemyKey, alchemySubdomain){
  if(!uri.startsWith('ipfs://')) return { error: `Not an ipfs:// URI: ${uri.slice(0,120)}` };
  const cid = uri.slice(7);
  const candidates = [];
  if(alchemyKey) candidates.push({ name: 'alchemy', url: `https://${alchemySubdomain}.g.alchemy.com/nft/v3/${alchemyKey}/ipfsGateway/${cid}` });
  candidates.push(
    { name: 'ipfs.io', url: `https://ipfs.io/ipfs/${cid}` },
    { name: 'pinata', url: `https://gateway.pinata.cloud/ipfs/${cid}` },
    { name: 'w3s.link', url: `https://w3s.link/ipfs/${cid}` },
    { name: 'dweb.link', url: `https://dweb.link/ipfs/${cid}` },
  );
  const GATEWAY_TIMEOUT_MS = 15000;
  const results = await Promise.all(candidates.map(async ({ name, url }) => {
    const started = Date.now();
    try{
      const r = await fetch(url, { timeout: GATEWAY_TIMEOUT_MS });
      const ms = Date.now() - started;
      if(!r.ok) return { gateway: name, url, ok: false, status: r.status, ms };
      const body = await r.text();
      let json = null;
      try{ json = JSON.parse(body); }catch(_){}
      return { gateway: name, url, ok: true, status: r.status, ms, isJson: !!json, sample: json ? undefined : body.slice(0,200) };
    }catch(e){
      return { gateway: name, url, ok: false, error: e.message, ms: Date.now() - started };
    }
  }));
  return { cid, results };
}

async function fetchTokensByRange(alchemyKey, contract, startId, count, alchemySubdomain){
  const ids = Array.from({ length: count }, (_, i) => startId + i);
  const results = await mapWithConcurrency(ids, 8, async (i) => {
    try{
      const url = new URL(`https://${alchemySubdomain}.g.alchemy.com/nft/v3/${alchemyKey}/getNFTMetadata`);
      url.searchParams.set('contractAddress', contract);
      url.searchParams.set('tokenId', String(i));
      url.searchParams.set('refreshCache', 'false');
      const r = await fetch(url.toString(), { timeout: 15000 });
      if(r.ok) return await r.json();
    }catch(e){
      console.warn(`[backfill] fetchTokensByRange failed for token ${i}:`, e.message);
    }
    return null;
  });
  return results.filter(Boolean);
}

async function writePage(pgPool, slug, nfts, contract, alchemyKey, alchemySubdomain, chain){
  if(!nfts.length) return { written: 0, skipped: 0 };

  // ── Phase 1: concurrent network enrichment ─────────────────────────────────
  // This used to be the same fully-serial for-loop as the DB write pass below
  // — every token's tokenURI eth_call + IPFS resolve happened one at a time,
  // awaited in sequence, even though none of it depends on any other token's
  // result. Moved to its own concurrency-bounded pass so the network-bound
  // work (the actual bottleneck) runs in parallel; the DB write pass after it
  // stays fully sequential inside one transaction, unchanged.
  const isNonEthereum = alchemySubdomain && alchemySubdomain !== 'eth-mainnet';
  const enriched = await mapWithConcurrency(nfts, 8, async (nft) => {
    const tokenId = parseInt(nft.tokenId);
    if(!tokenId && tokenId !== 0) return { tokenId: null };

    let rawAttrs = nft.raw?.metadata?.attributes
      || nft.raw?.metadata?.traits
      || nft.contract?.openSeaMetadata?.attributes
      || nft.raw?.metadata?.properties?.attributes
      || nft.raw?.metadata?.properties;
    let attrs = extractTraits(rawAttrs);

    // Extract image URL — prefer display_image_url (animated for collections like Portraits)
    // then cachedUrl (CDN), then originalUrl — store even if no traits
    let imageUrl = nft.display_image_url || nft.image?.cachedUrl || nft.image?.originalUrl || nft.image?.thumbnailUrl || null;

    // ── tokenURI fallback ──────────────────────────────────────────────────
    // Alchemy returns {} raw metadata for some collections (e.g. Fluxeto).
    // If we got no traits and have a contract address, fetch directly from
    // the on-chain tokenURI and extract attributes + image from that JSON.
    let onChainMeta = null;
    if(!attrs.length && contract){
      if(tokenId <= 5){
        console.log(`[backfill] token ${tokenId} Alchemy raw empty, falling back to tokenURI`);
      }
      onChainMeta = await fetchTokenUriMetadata(contract, tokenId, alchemyKey, alchemySubdomain, chain);
      if(onChainMeta){
        const fallbackAttrs = onChainMeta.attributes || onChainMeta.traits || onChainMeta.properties?.attributes || onChainMeta.properties || [];
        attrs = extractTraits(fallbackAttrs);
        // Prefer Alchemy image if already set, otherwise use tokenURI image
        if(!imageUrl){
          imageUrl = toDisplayableImageUrl(onChainMeta.image_url || onChainMeta.image || onChainMeta.image_data);
        }
      }
    }

    // ── non-Ethereum image verification ─────────────────────────────────────
    // Confirmed on onchainhoodies: Alchemy's own cached image field can be
    // flat-out wrong (served the same collection-level placeholder for
    // every token) even when its traits for that same token were indexed
    // correctly — so "traits were present" isn't a reliable signal that
    // the image can be trusted too. For non-Ethereum chains specifically,
    // always verify the image against the real on-chain tokenURI rather
    // than only falling back to it when traits are missing.
    if(isNonEthereum && contract){
      if(!onChainMeta) onChainMeta = await fetchTokenUriMetadata(contract, tokenId, alchemyKey, alchemySubdomain, chain);
      const verifiedImage = onChainMeta?.image_url || onChainMeta?.image || onChainMeta?.image_data || null;
      if(verifiedImage){
        imageUrl = toDisplayableImageUrl(verifiedImage);
      }
    }

    // Detect SVG image — store in token_svg_cache, not in tokens.image_url
    const isSvgImage = imageUrl && (
      imageUrl.startsWith('<svg') ||
      imageUrl.startsWith('data:image/svg') ||
      imageUrl.includes('image/svg')
    );
    const discordImageUrl = isSvgImage ? null : imageUrl;

    return { tokenId, attrs, imageUrl, isSvgImage, discordImageUrl };
  });

  // ── Phase 2: sequential DB writes, exactly as before ────────────────────────
  const client = await pgPool.connect();
  let written = 0, skipped = 0;
  try{
    await client.query('BEGIN');
    for(const item of enriched){
      const { tokenId, attrs, imageUrl, isSvgImage, discordImageUrl } = item;
      if(tokenId === null){ skipped++; continue; }

      if(!attrs.length){
        // No traits but still store image_url if available
        if(discordImageUrl){
          await client.query(
            `INSERT INTO tokens (id, collection_slug, trait_count, image_url)
             VALUES ($1,$2,0,$3)
             ON CONFLICT (id, collection_slug) DO UPDATE SET image_url=COALESCE($3, tokens.image_url)`,
            [tokenId, slug, discordImageUrl]
          );
        }
        // Store SVG data for on-chain SVG collections (non-OCAS)
        if(isSvgImage && slug !== 'on-chain-all-stars'){
          await client.query(
            `INSERT INTO token_svg_cache (token_id, collection_slug, image_data)
             VALUES ($1,$2,$3)
             ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=$3`,
            [tokenId, slug, imageUrl]
          ).catch(e => console.warn(`[backfill] token_svg_cache insert failed for ${slug}#${tokenId}: ${e.message}`));
        }
        skipped++; continue;
      }

      await client.query('DELETE FROM token_traits WHERE token_id=$1 AND collection_slug=$2', [tokenId, slug]);
      for(let i = 0; i < attrs.length; i++){
        const t = attrs[i];
        await client.query(
          `INSERT INTO token_traits (token_id, trait_name, trait_value, trait_index, collection_slug)
           VALUES ($1,$2,$3,$4,$5)`,
          [tokenId, t.trait_type, t.value, i, slug]
        );
      }
      await client.query(
        `INSERT INTO tokens (id, collection_slug, trait_count, image_url)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id, collection_slug) DO UPDATE SET trait_count=$3, image_url=COALESCE($4, tokens.image_url)`,
        [tokenId, slug, attrs.length, discordImageUrl]
      );
      // Store SVG data for on-chain SVG collections (non-OCAS)
      if(isSvgImage && slug !== 'on-chain-all-stars'){
        await client.query(
          `INSERT INTO token_svg_cache (token_id, collection_slug, image_data)
           VALUES ($1,$2,$3)
           ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=$3`,
          [tokenId, slug, imageUrl]
        ).catch(e => console.warn(`[backfill] token_svg_cache insert failed for ${slug}#${tokenId}: ${e.message}`));
      }
      written++;
    }
    await client.query('COMMIT');
  }catch(e){
    await client.query('ROLLBACK');
    throw e;
  }finally{
    client.release();
  }
  return { written, skipped };
}

/**
 * Runs a full collection trait backfill against an already-open pg pool.
 * Returns a stats object on success; throws on hard failure (caller
 * decides how to handle/log — see runCollectionBackfill for the
 * bot-facing wrapper with status tracking).
 *
 * Refuses to run against OCAS under any circumstances — same guard as
 * the CLI script, no override flag exists here since this is meant to
 * be called automatically/unattended, unlike the CLI's manual override.
 */
// Detect if a collection uses animated images by comparing display_image_url vs image_url
// on the first NFT. If they differ and display_image_url looks animated, return true.
function detectAnimated(nfts){
  if(!nfts?.length) return false;
  const nft = nfts[0];
  const displayUrl = nft.display_image_url || '';
  const staticUrl  = nft.image?.cachedUrl || nft.image?.originalUrl || '';
  if(!displayUrl) return false;
  // Different URLs = OpenSea is serving a different (likely animated) version
  if(displayUrl !== staticUrl){
    // Confirm it looks like an animated format
    const lower = displayUrl.toLowerCase();
    if(lower.includes('.gif') || lower.includes('.mp4') || lower.includes('video') || lower.includes('animation')){
      return true;
    }
    // display_image_url exists and differs — likely animated even without explicit extension
    return true;
  }
  return false;
}

async function backfillCollectionTraits(pgPool, { contract, slug, chain = 'ethereum', totalSupply = null }){
  if(!contract || !slug) throw new Error('contract and slug are required');
  const lcSlug = slug.toLowerCase();
  const lcContract = contract.toLowerCase();
  if(lcSlug === OCAS_SLUG_LOWER || lcContract === OCAS_CONTRACT_LOWER){
    throw new Error('Refusing to run collection backfill against OCAS — already has correct burn-aware trait data.');
  }

  const alchemySubdomain = SUPPORTED_CHAINS[chain];
  if(!alchemySubdomain){
    throw new Error(`Unsupported chain "${chain}" — currently supported: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`);
  }

  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  if(!ALCHEMY_KEY) throw new Error('Missing ALCHEMY_API_KEY/ALCHEMY_KEY env var');

  console.log(`[backfill] Starting ${slug} (${contract}) on ${chain} (${alchemySubdomain})`);
  const stats = { written: 0, skipped: 0, pages: 0, failed: 0, animated: false };
  let pageKey = null;
  let consecutiveFails = 0;
  let hasMore = true;
  let animationDetected = false;
  let paginationBroken = false;
  let rpcOnlyMode = false;
  const supplyCeiling = totalSupply ? totalSupply + 10 : 100000; // small buffer past known supply; generous fixed ceiling if supply wasn't provided (raised from 20,000 — the empty-batch stop is the real primary defense either way, this is only the backstop)
  let rangeStart = 0;
  let totalFetched = 0;
  let attemptNum = 0; // every loop iteration, success or fail — was previously logged as "page N" using stats.pages+1, which stayed stuck at the same number through repeated write failures and made it look like the exact same page was being retried forever
  let consecutiveWriteFails = 0;
  const MAX_CONSECUTIVE_WRITE_FAILS = 5; // a broken schema/constraint fails identically on every page — no amount of retrying fixes that, so stop and surface it as a real error instead of quietly finishing with written:0

  while(hasMore){
    let page;

    if(rpcOnlyMode){
      // No Alchemy NFT-API call at all here — just enumerate token IDs and
      // let writePage's existing tokenURI/eth_call fallback do the actual
      // fetching per token, below.
      const batch = [];
      for(let i = rangeStart; i < rangeStart + PAGE_SIZE && i < supplyCeiling; i++) batch.push({ tokenId: i });
      if(!batch.length){ hasMore = false; break; }
      page = { nfts: batch, pageKey: null };
      rangeStart += PAGE_SIZE;
      if(rangeStart >= supplyCeiling) hasMore = false;
    } else if(paginationBroken){
      // Alchemy pagination broken for this contract — fetch by token ID range
      if(rangeStart >= supplyCeiling){ hasMore = false; break; }
      const batchNfts = await fetchTokensByRange(ALCHEMY_KEY, contract, rangeStart, PAGE_SIZE, alchemySubdomain);
      if(!batchNfts.length){ hasMore = false; break; }
      page = { nfts: batchNfts, pageKey: null };
      rangeStart += PAGE_SIZE;
      if(batchNfts.length < PAGE_SIZE || rangeStart >= supplyCeiling) hasMore = false;
    } else {
      page = await fetchPage(ALCHEMY_KEY, contract, pageKey, alchemySubdomain);
      if(page.error){
        stats.failed++;
        consecutiveFails++;
        console.warn(`[backfill] ${slug} getNFTsForContract failed (${consecutiveFails} consecutive): ${page.error}`);
        if(consecutiveFails >= MAX_CONSECUTIVE_FAILS){
          // getNFTsForContract isn't working for this contract/chain at all —
          // likely not indexed yet (seen on brand-new chains). Switch to pure
          // RPC mode: bare {tokenId} stubs straight into writePage, which
          // already falls back to a raw eth_call tokenURI() read per token
          // whenever attrs come back empty (built for the Fluxeto gap case).
          // Deliberately NOT falling back to fetchTokensByRange/getNFTMetadata
          // here — that's the same Alchemy NFT-API indexing layer as
          // getNFTsForContract and would likely fail for the identical
          // reason, just slower (one call per token instead of paginated).
          console.warn(`[backfill] ${slug} getNFTsForContract failed ${consecutiveFails} times in a row on ${alchemySubdomain} — switching to RPC-only mode (raw tokenURI via eth_call, bypassing Alchemy's NFT API indexing entirely) instead of retrying indefinitely.`);
          rpcOnlyMode = true;
          rangeStart = 0; // no page has succeeded yet via the normal path
          hasMore = true;
          consecutiveFails = 0;
          continue;
        }
        await sleep(DELAY_MS);
        continue;
      }
      consecutiveFails = 0;
    }

    // Detect animation on first page only
    if(!animationDetected && page.nfts?.length){
      animationDetected = detectAnimated(page.nfts);
      stats.animated = animationDetected;
    }

    totalFetched += page.nfts?.length || 0;
    attemptNum++;
    console.log(`[backfill] ${slug} fetched page (attempt ${attemptNum}): ${page.nfts?.length} nfts, nextPageKey=${!!page.pageKey}${rpcOnlyMode ? ' (rpc-only mode)' : paginationBroken ? ' (range mode)' : ''}`);

    // Detect broken Alchemy pagination: full page returned but no continuation key
    if(!rpcOnlyMode && !paginationBroken && !page.pageKey && page.nfts?.length === PAGE_SIZE){
      const totalCount = page.totalCount;
      if(!totalCount || totalCount > totalFetched){
        console.warn(`[backfill] ${slug} Alchemy pagination broken (no pageKey after full page, totalCount=${totalCount}). Switching to token ID range mode.`);
        paginationBroken = true;
        rangeStart = PAGE_SIZE; // page 1 (tokens 0-99) already fetched
        hasMore = true;
      }
    }

    let result;
    try{
      result = await writePage(pgPool, slug, page.nfts, contract, ALCHEMY_KEY, alchemySubdomain, chain);
    }catch(pageErr){
      console.error(`[backfill] ${slug} page (attempt ${attemptNum}) error: ${pageErr.message}`);
      stats.failed++;
      consecutiveWriteFails++;
      if(consecutiveWriteFails >= MAX_CONSECUTIVE_WRITE_FAILS){
        // Same failure every time (e.g. a schema/constraint mismatch) means
        // more retries won't help — previously this just kept absorbing every
        // page's error via stats.failed++ and finished "successfully" with
        // written:0, which looked identical to a real empty collection and
        // burned real debugging time chasing the wrong cause more than once.
        throw new Error(`${consecutiveWriteFails} consecutive page-write failures, giving up. Last error: ${pageErr.message}`);
      }
      if(!paginationBroken && !rpcOnlyMode){ pageKey = page.pageKey; hasMore = !!pageKey; }
      if(hasMore) await sleep(DELAY_MS);
      continue;
    }
    consecutiveWriteFails = 0;
    stats.written += result.written;
    stats.skipped += result.skipped;
    stats.pages++;
    console.log(`[backfill] ${slug} page ${stats.pages} (attempt ${attemptNum}): written=${result.written} skipped=${result.skipped} hasMore=${hasMore}`);

    if(!paginationBroken && !rpcOnlyMode){
      pageKey = page.pageKey;
      hasMore = !!pageKey;
    }
    if(hasMore) await sleep(DELAY_MS);
  }

  return stats;
}

// Re-resolves and corrects tokens.image_url / token_svg_cache for an
// already-backfilled non-Ethereum collection, without touching traits.
// For collections onboarded before writePage started always verifying
// non-Ethereum images against the real on-chain source — Alchemy's own
// cached image was confirmed wrong for onchainhoodies specifically (same
// collection-level placeholder for every token), so anything backfilled
// before this fix existed needs a one-time correction pass.
async function fixCollectionImages(pgPool, { slug, contract, chain }){
  const alchemySubdomain = SUPPORTED_CHAINS[chain];
  if(!alchemySubdomain || alchemySubdomain === 'eth-mainnet'){
    throw new Error(`fixCollectionImages is only for non-Ethereum chains (got "${chain}")`);
  }
  const alchemyKey = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  if(!alchemyKey) throw new Error('Missing ALCHEMY_API_KEY/ALCHEMY_KEY env var');

  const { rows } = await pgPool.query(`SELECT id FROM tokens WHERE collection_slug = $1 ORDER BY id`, [slug]);
  console.log(`[fix-images] ${slug}: verifying images for ${rows.length} tokens on ${chain}`);

  let fixed = 0, unchanged = 0, failed = 0;
  for(const { id: tokenId } of rows){
    try{
      const onChainMeta = await fetchTokenUriMetadata(contract, tokenId, alchemyKey, alchemySubdomain, chain);
      const verifiedImage = onChainMeta?.image_url || onChainMeta?.image || onChainMeta?.image_data || null;
      if(!verifiedImage){ unchanged++; continue; }
      const resolvedImage = toDisplayableImageUrl(verifiedImage);
      const isSvgImage = resolvedImage.startsWith('<svg') || resolvedImage.startsWith('data:image/svg') || resolvedImage.includes('image/svg');

      if(isSvgImage){
        await pgPool.query(
          `INSERT INTO token_svg_cache (token_id, collection_slug, image_data)
           VALUES ($1,$2,$3)
           ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=$3`,
          [tokenId, slug, resolvedImage]
        );
        await pgPool.query(`UPDATE tokens SET image_url = NULL WHERE id=$1 AND collection_slug=$2`, [tokenId, slug]);
      } else {
        await pgPool.query(`UPDATE tokens SET image_url=$3 WHERE id=$1 AND collection_slug=$2`, [tokenId, slug, resolvedImage]);
      }
      fixed++;
      if(fixed % 100 === 0) console.log(`[fix-images] ${slug}: ${fixed} fixed, ${unchanged} unchanged, ${failed} failed so far`);
    }catch(e){
      failed++;
      console.warn(`[fix-images] ${slug}#${tokenId} failed:`, e.message);
    }
  }
  console.log(`[fix-images] ${slug}: done — ${fixed} fixed, ${unchanged} unchanged, ${failed} failed`);
  return { fixed, unchanged, failed, total: rows.length };
}

module.exports = { backfillCollectionTraits, SUPPORTED_CHAINS, fetchTokenUriMetadata, fixCollectionImages, fetchRawTokenUri, diagnoseIpfsGateways };
