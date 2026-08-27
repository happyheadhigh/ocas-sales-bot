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
const { sendErrorWebhook, sendActivityWebhook } = require('./error');
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
      timeout: 15000,
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

// Confirmed live: some argonauts tokens showed no thumbnail at all in /me's
// wallet view, while others worked fine — traced to a real gap between two
// checks that were never kept aligned. The 4 isSvgImage checks below (now
// unified into this one shared function) only caught raw <svg markup, a
// data:image/svg URI, or a URL containing the literal substring
// "image/svg" — never a plain URL that simply ENDS in .svg (e.g. an
// ipfs://.../123.svg reference, which toDisplayableImageUrl correctly
// rewrites to a working https://w3s.link/ipfs/.../123.svg URL, extension
// preserved). Meanwhile isDiscordOk (utils/format.js) explicitly REJECTS
// exactly that shape at display time — Discord can't render a raw .svg URL
// directly, only Alchemy's own CDN links that happen to keep an .svg
// extension despite actually serving a pre-rendered raster image. Tokens
// whose image fell into that gap were never cached to token_svg_cache
// during backfill (isSvgImage missed them) AND got silently rejected from
// tokens.image_url at display time (isDiscordOk rejected them) — no
// thumbnail from either path. This function is the logical mirror of
// isDiscordOk's own SVG-rejection rule, so anything Discord can't render
// directly is exactly what gets treated as needing a render/cache instead.
function needsSvgRender(imageUrl){
  if(!imageUrl) return false;
  if(imageUrl.startsWith('<svg')) return true;
  if(imageUrl.startsWith('data:image/svg')) return true;
  if(imageUrl.includes('image/svg')) return true;
  const lower = imageUrl.toLowerCase();
  if(lower.endsWith('.svg')){
    if(lower.includes('nft2-cdn.alchemy.com') || lower.includes('nft3-cdn.alchemy.com')) return false;
    return true;
  }
  return false;
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
  // tokenUriTimeoutInMs=0 tells Alchemy to return whatever's already cached
  // and NOT wait on a live tokenURI fetch for cache misses — exactly what a
  // fast bulk onboarding pass wants. Confirmed real/documented. Anything
  // this leaves incomplete gets queued for the separate repair tier instead
  // of blocking this page on a slow live fetch.
  url.searchParams.set('tokenUriTimeoutInMs', '0');
  url.searchParams.set('refreshCache', 'false');
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
    timeout: 15000,
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

// Replaces the old one-request-per-token-ID approach with genuine bulk
// fetching: getNFTsForContract already supports startToken-based range
// pagination (confirmed real/documented — "users can specify the offset
// themselves... to fetch multiple token ranges in parallel"), so a 100-token
// range is now ONE HTTP request instead of 100. tokenUriTimeoutInMs=0 means
// this returns instantly with whatever Alchemy already has cached; anything
// missing gets queued for repair rather than fetched live here.
async function fetchTokenRangeBulk(alchemyKey, contract, startId, count, alchemySubdomain){
  try{
    const url = new URL(`https://${alchemySubdomain}.g.alchemy.com/nft/v3/${alchemyKey}/getNFTsForContract`);
    url.searchParams.set('contractAddress', contract);
    url.searchParams.set('withMetadata', 'true');
    url.searchParams.set('limit', String(count));
    url.searchParams.set('startToken', String(startId));
    url.searchParams.set('tokenUriTimeoutInMs', '0');
    url.searchParams.set('refreshCache', 'false');
    const r = await fetch(url.toString(), { timeout: 20000 });
    if(!r.ok){
      console.warn(`[backfill] fetchTokenRangeBulk HTTP ${r.status} for range ${startId}-${startId + count - 1}`);
      return [];
    }
    const j = await r.json();
    return j.nfts || [];
  }catch(e){
    console.warn(`[backfill] fetchTokenRangeBulk failed for range ${startId}-${startId + count - 1}:`, e.message);
    return [];
  }
}

// Fetches several ranges CONCURRENTLY (e.g. 1-100, 101-200, 201-300... at
// once) rather than one range at a time — this is the "parallel range
// fetching" Alchemy's own docs explicitly call out as supported. Modest
// concurrency (4) since these are large, cheap-per-request bulk calls, not
// the many small per-token requests the old approach made.
async function fetchTokenRangesBulk(alchemyKey, contract, startIds, count, alchemySubdomain){
  const results = await mapWithConcurrency(startIds, 4, (startId) =>
    fetchTokenRangeBulk(alchemyKey, contract, startId, count, alchemySubdomain)
  );
  return results.flat();
}

// ── Tier 2: OpenSea bulk collection listing ───────────────────────────────────
// Secondary bulk source, used only when Alchemy's cache left a meaningful
// chunk of the collection incomplete. Paginated at up to 200 NFTs per page
// (OpenSea's own documented max for this endpoint) — still bulk, not
// per-token, just a different provider's cache.
async function fetchOpenSeaCollectionPage(slug, chain, next){
  const url = new URL(`https://api.opensea.io/api/v2/collection/${slug}/nfts`);
  url.searchParams.set('limit', '200');
  if(next) url.searchParams.set('next', next);
  const r = await fetch(url.toString(), { headers: osHeaders(), timeout: 15000 });
  if(!r.ok) throw new Error(`OpenSea collection listing HTTP ${r.status}`);
  const j = await r.json();
  return { nfts: j.nfts || [], next: j.next || null };
}

// Pages through OpenSea's entire collection listing, returning a map of
// tokenId -> nft for quick lookup. Capped at a generous number of pages as a
// safety backstop (200 pages x 200/page = 40,000 tokens) — collections
// larger than that are rare, and this is a secondary/supplementary source,
// not the primary path.
async function fetchOpenSeaCollectionAll(slug, chain){
  const byTokenId = new Map();
  let next = null;
  let pages = 0;
  const MAX_PAGES = 200;
  do{
    let page;
    try{
      page = await fetchOpenSeaCollectionPage(slug, chain, next);
    }catch(e){
      console.warn(`[backfill] ${slug} OpenSea collection listing failed on page ${pages + 1}:`, e.message);
      break;
    }
    for(const nft of page.nfts){
      const tid = parseInt(nft.identifier);
      if(!isNaN(tid)) byTokenId.set(tid, nft);
    }
    next = page.next;
    pages++;
  }while(next && pages < MAX_PAGES);
  return byTokenId;
}

// ── Tier 3: URI pattern learning ──────────────────────────────────────────────
// Confirmed live on robinhood-chimps: every token's tokenURI was the exact
// same IPFS folder CID with the token ID appended (ipfs://CID/1, CID/2,
// CID/3...). Doing an eth_call per token to rediscover an already-established
// pattern is pure waste. This probes a small handful of token IDs, checks
// whether their URIs share an identical prefix once the numeric token ID
// suffix is stripped, and if so, returns a template that lets the rest of
// the collection's URIs be generated locally with zero further RPC calls.
// Deliberately conservative: only recognizes simple concatenation
// (prefix + tokenId), matching exactly what's been observed. Anything that
// doesn't fit this shape returns null and falls through to the existing
// per-token eth_call path unchanged — never a regression, only an
// opportunistic speedup when the pattern is unambiguous.
async function learnUriTemplate(contract, sampleTokenIds, alchemyKey, alchemySubdomain){
  const uris = [];
  for(const tokenId of sampleTokenIds){
    try{
      const uri = await fetchRawTokenUri(contract, tokenId, alchemyKey, alchemySubdomain);
      uris.push({ tokenId, uri });
    }catch(e){
      // One sample failing doesn't rule out a pattern from the others —
      // just skip it and keep checking what did resolve.
    }
  }
  if(uris.length < 2) return null;
  const prefixes = uris.map(({ tokenId, uri }) => {
    const suffix = String(tokenId);
    if(!uri.endsWith(suffix)) return null;
    return uri.slice(0, uri.length - suffix.length);
  });
  if(prefixes.some(p => p === null)) return null;
  const allSame = prefixes.every(p => p === prefixes[0]);
  if(!allSame) return null;
  console.log(`[backfill] URI template learned from ${uris.length} samples: "${prefixes[0]}{tokenId}" — skipping eth_call for remaining tokens`);
  return prefixes[0];
}

// ── Bulk DB insert helper ─────────────────────────────────────────────────────
// Building one multi-row INSERT (or a few, chunked) instead of hundreds/
// thousands of individual single-row statements per page. Chunked well
// under Postgres's ~65535 parameter limit to stay safe regardless of how
// many columns a given call uses.
async function bulkInsert(client, table, columns, rows, conflictClause){
  if(!rows.length) return;
  const CHUNK_SIZE = 500;
  for(let i = 0; i < rows.length; i += CHUNK_SIZE){
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const values = [];
    const placeholders = chunk.map((row, rowIdx) => {
      const base = rowIdx * columns.length;
      values.push(...row);
      return `(${columns.map((_, colIdx) => `$${base + colIdx + 1}`).join(',')})`;
    }).join(',');
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders} ${conflictClause || ''}`;
    await client.query(sql, values);
  }
}

// Rewritten as the Tier 1 fast bulk pass: extracts ONLY from data the
// provider already has cached (Alchemy's bulk response, tokenUriTimeoutInMs=0
// means nothing here waits on a live fetch) — no per-token network calls at
// all. Anything missing/incomplete gets queued into metadata_repair_jobs
// instead of blocking this page on a slow individual resolution; a separate,
// non-blocking worker (runMetadataRepairQueue, Tier 4) drains that queue
// afterward using the full gateway-race/retry machinery. This is the core
// change behind the tiered rewrite: a collection add no longer waits on its
// own slowest few percent of tokens.
async function writePage(pgPool, slug, nfts, contract, alchemyKey, alchemySubdomain, chain){
  if(!nfts.length) return { written: 0, skipped: 0, queued: 0 };

  const extracted = nfts.map(nft => {
    const tokenId = parseInt(nft.tokenId);
    if(!tokenId && tokenId !== 0) return { tokenId: null };

    const rawAttrs = nft.raw?.metadata?.attributes
      || nft.raw?.metadata?.traits
      || nft.contract?.openSeaMetadata?.attributes
      || nft.raw?.metadata?.properties?.attributes
      || nft.raw?.metadata?.properties;
    const attrs = extractTraits(rawAttrs);

    const rawImage = nft.display_image_url || nft.image?.cachedUrl || nft.image?.originalUrl
      || nft.image?.thumbnailUrl || nft.raw?.metadata?.image || nft.raw?.metadata?.image_url || null;
    const imageUrl = toDisplayableImageUrl(rawImage);

    const isSvgImage = needsSvgRender(imageUrl);
    const discordImageUrl = isSvgImage ? null : imageUrl;

    return { tokenId, attrs, imageUrl, isSvgImage, discordImageUrl };
  }).filter(item => item.tokenId !== null);

  // Sanity check: if 3+ tokens in this SAME bulk batch share the exact same
  // non-null image, that's the "same collection-level placeholder for every
  // token" pattern confirmed on onchainhoodies — Alchemy's cache can be
  // wrong even when traits are right, so don't trust a suspiciously
  // repeated image; queue those tokens for on-chain verification instead of
  // writing a likely-wrong image as if it were real data.
  const imageCounts = new Map();
  for(const item of extracted){
    if(item.discordImageUrl) imageCounts.set(item.discordImageUrl, (imageCounts.get(item.discordImageUrl) || 0) + 1);
  }
  const suspiciousImages = new Set([...imageCounts.entries()].filter(([, count]) => count >= 3).map(([img]) => img));

  const complete = [];
  const needsRepair = [];
  for(const item of extracted){
    const imageSuspicious = item.discordImageUrl && suspiciousImages.has(item.discordImageUrl);
    const finalItem = imageSuspicious ? { ...item, imageUrl: null, discordImageUrl: null, isSvgImage: false } : item;
    if(finalItem.attrs.length > 0 && finalItem.discordImageUrl && !imageSuspicious){
      complete.push(finalItem);
    }else{
      needsRepair.push(finalItem);
    }
  }

  const allToWrite = [...complete, ...needsRepair];
  const client = await pgPool.connect();
  try{
    await client.query('BEGIN');

    if(allToWrite.length){
      const ids = allToWrite.map(i => i.tokenId);
      await client.query(`DELETE FROM token_traits WHERE collection_slug=$1 AND token_id = ANY($2::int[])`, [slug, ids]);
    }

    const tokenRows = allToWrite.map(i => [i.tokenId, slug, i.attrs.length, i.discordImageUrl]);
    await bulkInsert(
      client, 'tokens', ['id', 'collection_slug', 'trait_count', 'image_url'], tokenRows,
      `ON CONFLICT (id, collection_slug) DO UPDATE SET trait_count=EXCLUDED.trait_count, image_url=COALESCE(EXCLUDED.image_url, tokens.image_url)`
    );

    const traitRows = [];
    for(const item of allToWrite){
      item.attrs.forEach((t, idx) => traitRows.push([item.tokenId, t.trait_type, t.value, idx, slug]));
    }
    await bulkInsert(client, 'token_traits', ['token_id', 'trait_name', 'trait_value', 'trait_index', 'collection_slug'], traitRows);

    // SVG images (on-chain-rendered art) — non-OCAS only, same as before
    const svgRows = allToWrite.filter(i => i.isSvgImage && slug !== 'on-chain-all-stars').map(i => [i.tokenId, slug, i.imageUrl]);
    if(svgRows.length){
      await bulkInsert(
        client, 'token_svg_cache', ['token_id', 'collection_slug', 'image_data'], svgRows,
        `ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=EXCLUDED.image_data`
      ).catch(e => console.warn(`[backfill] ${slug} bulk token_svg_cache insert failed: ${e.message}`));
    }

    await client.query('COMMIT');
  }catch(e){
    await client.query('ROLLBACK');
    throw e;
  }finally{
    client.release();
  }

  // Queue repair jobs outside the main transaction — a failure here
  // shouldn't roll back real data that already wrote successfully.
  if(needsRepair.length){
    try{
      const repairClient = await pgPool.connect();
      try{
        const rows = needsRepair.map(i => [slug, i.tokenId, contract, chain || 'ethereum']);
        await bulkInsert(
          repairClient, 'metadata_repair_jobs', ['collection_slug', 'token_id', 'contract', 'chain'], rows,
          `ON CONFLICT (collection_slug, token_id) DO NOTHING`
        );
      }finally{
        repairClient.release();
      }
    }catch(e){
      console.warn(`[backfill] ${slug} failed to queue ${needsRepair.length} repair jobs:`, e.message);
    }
  }

  return { written: complete.length, skipped: needsRepair.length, queued: needsRepair.length };
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

// ── Tier 4: deep repair queue ──────────────────────────────────────────────────
// Runs AFTER the collection is already usable — every job here is one that
// Tier 1 (bulk cache) and Tier 2 (OpenSea bulk) couldn't resolve. This is
// where all of the gateway-race/retry/429-cooldown machinery built earlier
// tonight actually gets used now — demoted from "runs for every single
// token, blocking the whole collection" to "runs only for the genuine
// stragglers, after the collection is already live." uriTemplate (Tier 3),
// when available, lets a job skip its own eth_call and jump straight to
// fetching the templated URI.
async function processOneRepairJob(job, uriTemplate){
  const { id, token_id: tokenId, contract, chain } = job;
  const alchemySubdomain = SUPPORTED_CHAINS[chain] || 'eth-mainnet';
  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  try{
    let onChainMeta = null;
    if(uriTemplate){
      const uri = `${uriTemplate}${tokenId}`;
      onChainMeta = await resolveUri(uri, ALCHEMY_KEY, alchemySubdomain, tokenId);
    }
    if(!onChainMeta){
      onChainMeta = await fetchTokenUriMetadata(contract, tokenId, ALCHEMY_KEY, alchemySubdomain, chain);
    }
    if(!onChainMeta) throw new Error('all metadata sources exhausted (OpenSea + on-chain tokenURI + every IPFS gateway)');

    const attrs = extractTraits(onChainMeta.attributes || onChainMeta.traits || onChainMeta.properties?.attributes || onChainMeta.properties || []);
    const rawImage = onChainMeta.image_url || onChainMeta.image || onChainMeta.image_data || null;
    const imageUrl = toDisplayableImageUrl(rawImage);
    const isSvgImage = needsSvgRender(imageUrl);
    const discordImageUrl = isSvgImage ? null : imageUrl;

    if(!attrs.length && !discordImageUrl) throw new Error('resolved metadata JSON but it had neither usable traits nor an image');

    return { id, tokenId, attrs, imageUrl, isSvgImage, discordImageUrl, success: true };
  }catch(e){
    return { id, tokenId, error: e.message, success: false };
  }
}

async function runMetadataRepairQueue(pgPool, slug, { limit = 100, uriTemplate = null } = {}){
  const jobsRes = await pgPool.query(
    `SELECT id, token_id, contract, chain FROM metadata_repair_jobs WHERE collection_slug=$1 AND status='pending' ORDER BY id ASC LIMIT $2`,
    [slug, limit]
  );
  const jobs = jobsRes.rows;
  if(!jobs.length) return { processed: 0, resolved: 0, failed: 0 };

  // Concurrency here is intentionally the same modest level as the rest of
  // tonight's gateway-facing work (mapWithConcurrency + the IPFS semaphore
  // inside resolveUri already caps the actual gateway load further) — this
  // tier runs in the background with no user waiting on it, so there's no
  // reason to push concurrency harder and risk more 429s.
  const results = await mapWithConcurrency(jobs, 5, (job) => processOneRepairJob(job, uriTemplate));

  // Bulk-write now instead of one query per token — this table only ever
  // sees stragglers (a handful to a few dozen typically), so the per-row
  // writes here were never the actual bottleneck, but there's no reason to
  // leave it inconsistent with the same bulkInsert machinery writePage
  // already uses, especially for a genuinely ugly collection with
  // thousands of misses.
  const MAX_ATTEMPTS = 5;
  const success = results.filter(r => r.success);
  const failedResults = results.filter(r => !r.success);
  let resolved = 0, failed = 0;

  const client = await pgPool.connect();
  try{
    await client.query('BEGIN');

    if(success.length){
      const ids = success.map(r => r.tokenId);
      await client.query(`DELETE FROM token_traits WHERE collection_slug=$1 AND token_id = ANY($2::int[])`, [slug, ids]);

      const tokenRows = success.map(r => [r.tokenId, slug, r.attrs.length, r.discordImageUrl]);
      await bulkInsert(
        client, 'tokens', ['id', 'collection_slug', 'trait_count', 'image_url'], tokenRows,
        `ON CONFLICT (id, collection_slug) DO UPDATE SET trait_count=EXCLUDED.trait_count, image_url=COALESCE(EXCLUDED.image_url, tokens.image_url)`
      );

      const traitRows = [];
      for(const r of success) r.attrs.forEach((t, idx) => traitRows.push([r.tokenId, t.trait_type, t.value, idx, slug]));
      await bulkInsert(client, 'token_traits', ['token_id', 'trait_name', 'trait_value', 'trait_index', 'collection_slug'], traitRows);

      const svgRows = success.filter(r => r.isSvgImage && slug !== 'on-chain-all-stars').map(r => [r.tokenId, slug, r.imageUrl]);
      if(svgRows.length){
        await bulkInsert(
          client, 'token_svg_cache', ['token_id', 'collection_slug', 'image_data'], svgRows,
          `ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=EXCLUDED.image_data`
        ).catch(()=>{});
      }

      const doneIds = success.map(r => r.id);
      await client.query(`UPDATE metadata_repair_jobs SET status='done', attempts=attempts+1, last_attempt_at=NOW() WHERE id = ANY($1::int[])`, [doneIds]);
      resolved = success.length;
    }

    if(failedResults.length){
      // One bulk UPDATE ... FROM (VALUES ...) so each job still gets its own
      // specific error message, instead of a separate query per failure.
      const failValues = [];
      const placeholders = failedResults.map((r, i) => {
        const base = i * 2;
        failValues.push(r.id, r.error);
        return `($${base + 1}::int, $${base + 2}::text)`;
      }).join(',');
      const updRes = await client.query(
        `UPDATE metadata_repair_jobs AS m
         SET attempts = m.attempts + 1, last_attempt_at = NOW(), last_error = v.error
         FROM (VALUES ${placeholders}) AS v(id, error)
         WHERE m.id = v.id
         RETURNING m.id, m.attempts`,
        failValues
      );
      const toFail = updRes.rows.filter(row => row.attempts >= MAX_ATTEMPTS).map(row => row.id);
      if(toFail.length){
        await client.query(`UPDATE metadata_repair_jobs SET status='permanently_failed' WHERE id = ANY($1::int[])`, [toFail]);
      }
      failed = failedResults.length;
    }

    await client.query('COMMIT');
  }catch(e){
    await client.query('ROLLBACK');
    throw e;
  }finally{
    client.release();
  }

  return { processed: jobs.length, resolved, failed };
}

// Drains the ENTIRE pending repair queue for a collection, batch by batch,
// with a short pause between batches to avoid immediately re-hammering
// whatever gateway just got a round of 429s. This is what actually runs as
// the fire-and-forget background tier after backfillCollectionTraits
// returns — never awaited by the caller.
async function drainMetadataRepairQueue(pgPool, slug, uriTemplate){
  let totalResolved = 0, totalFailed = 0, round = 0;
  while(true){
    let batch;
    try{
      batch = await runMetadataRepairQueue(pgPool, slug, { limit: 100, uriTemplate });
    }catch(e){
      console.error(`[backfill] ${slug} repair queue round ${round + 1} threw, stopping drain:`, e.message);
      break;
    }
    if(!batch.processed) break;
    totalResolved += batch.resolved;
    totalFailed += batch.failed;
    round++;
    console.log(`[backfill] ${slug} repair queue round ${round}: ${batch.resolved} resolved, ${batch.failed} failed this batch (${totalResolved} total resolved so far)`);
    await sleep(500);
  }
  console.log(`[backfill] ${slug} repair queue drained — ${totalResolved} resolved, ${totalFailed} failed/permanently-failed across ${round} round(s)`);

  // Report genuinely stuck tokens (exhausted every tier + every retry
  // attempt) to the bot owner's own error webhook — server admins never see
  // this, it's purely so problems with a specific collection's metadata
  // (bad/unpinned IPFS content, a genuinely broken tokenURI, etc.) surface
  // automatically without needing anyone to notice or report it.
  try{
    const stuckRes = await pgPool.query(
      `SELECT token_id, last_error FROM metadata_repair_jobs WHERE collection_slug=$1 AND status='permanently_failed' ORDER BY token_id ASC LIMIT 10`,
      [slug]
    );
    if(stuckRes.rows.length){
      const totalStuckRes = await pgPool.query(
        `SELECT COUNT(*)::int AS n FROM metadata_repair_jobs WHERE collection_slug=$1 AND status='permanently_failed'`,
        [slug]
      );
      const totalStuck = totalStuckRes.rows[0]?.n || stuckRes.rows.length;
      const sample = stuckRes.rows.map(r => `#${r.token_id}: ${(r.last_error || 'unknown error').slice(0, 150)}`).join('\n');
      await sendErrorWebhook(
        `Backfill: ${totalStuck} token(s) permanently failed for "${slug}"`,
        new Error(`${totalStuck} token(s) exhausted every metadata source (OpenSea + on-chain tokenURI + every IPFS gateway) after 5 attempts each`),
        sample
      );
    }
  }catch(e){
    console.warn(`[backfill] ${slug} failed to check/report permanently-failed tokens:`, e.message);
  }

  return { totalResolved, totalFailed, rounds: round };
}

// Tier 2 in practice: resolves as many PENDING repair-queue jobs as possible
// directly from OpenSea's bulk collection listing, before falling to
// per-token Tier 3/4 repair. Only worth doing when there's a meaningful
// number of pending jobs — for a handful of stragglers, a full paginated
// crawl of OpenSea's listing costs more than just repairing them
// individually.
async function runOpenSeaBulkRepair(pgPool, slug, chain){
  const MIN_JOBS_TO_BOTHER = 20;
  const pendingRes = await pgPool.query(
    `SELECT id, token_id FROM metadata_repair_jobs WHERE collection_slug=$1 AND status='pending'`,
    [slug]
  );
  const pending = pendingRes.rows;
  if(pending.length < MIN_JOBS_TO_BOTHER){
    return { attempted: false, resolved: 0, pendingBefore: pending.length };
  }

  console.log(`[backfill] ${slug} ${pending.length} tokens still pending after bulk cache — trying OpenSea's bulk collection listing before per-token repair`);
  const openSeaData = await fetchOpenSeaCollectionAll(slug, chain);
  if(!openSeaData.size){
    return { attempted: true, resolved: 0, pendingBefore: pending.length };
  }

  const resolvedRows = [];
  const resolvedJobIds = [];
  for(const job of pending){
    const nft = openSeaData.get(job.token_id);
    if(!nft) continue;
    const attrs = extractTraits(nft.traits || nft.attributes || []);
    const rawImage = nft.image_url || nft.display_image_url || null;
    const imageUrl = toDisplayableImageUrl(rawImage);
    const isSvgImage = needsSvgRender(imageUrl);
    const discordImageUrl = isSvgImage ? null : imageUrl;
    if(!attrs.length && !discordImageUrl) continue; // OpenSea had it listed but no usable data either — leave pending for Tier 4
    resolvedRows.push({ tokenId: job.token_id, attrs, imageUrl, isSvgImage, discordImageUrl });
    resolvedJobIds.push(job.id);
  }

  if(!resolvedRows.length){
    return { attempted: true, resolved: 0, pendingBefore: pending.length };
  }

  const client = await pgPool.connect();
  try{
    await client.query('BEGIN');
    const ids = resolvedRows.map(r => r.tokenId);
    await client.query(`DELETE FROM token_traits WHERE collection_slug=$1 AND token_id = ANY($2::int[])`, [slug, ids]);

    const tokenRows = resolvedRows.map(r => [r.tokenId, slug, r.attrs.length, r.discordImageUrl]);
    await bulkInsert(
      client, 'tokens', ['id', 'collection_slug', 'trait_count', 'image_url'], tokenRows,
      `ON CONFLICT (id, collection_slug) DO UPDATE SET trait_count=EXCLUDED.trait_count, image_url=COALESCE(EXCLUDED.image_url, tokens.image_url)`
    );

    const traitRows = [];
    for(const r of resolvedRows) r.attrs.forEach((t, idx) => traitRows.push([r.tokenId, t.trait_type, t.value, idx, slug]));
    await bulkInsert(client, 'token_traits', ['token_id', 'trait_name', 'trait_value', 'trait_index', 'collection_slug'], traitRows);

    const svgRows = resolvedRows.filter(r => r.isSvgImage && slug !== 'on-chain-all-stars').map(r => [r.tokenId, slug, r.imageUrl]);
    if(svgRows.length){
      await bulkInsert(
        client, 'token_svg_cache', ['token_id', 'collection_slug', 'image_data'], svgRows,
        `ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=EXCLUDED.image_data`
      ).catch(()=>{});
    }

    await client.query(`UPDATE metadata_repair_jobs SET status='done', attempts=attempts+1, last_attempt_at=NOW() WHERE id = ANY($1::int[])`, [resolvedJobIds]);
    await client.query('COMMIT');
  }catch(e){
    await client.query('ROLLBACK');
    console.warn(`[backfill] ${slug} OpenSea bulk repair write failed, leaving those jobs pending for Tier 4: ${e.message}`);
    return { attempted: true, resolved: 0, pendingBefore: pending.length };
  }finally{
    client.release();
  }

  console.log(`[backfill] ${slug} OpenSea bulk listing resolved ${resolvedRows.length}/${pending.length} still-pending tokens directly`);
  return { attempted: true, resolved: resolvedRows.length, pendingBefore: pending.length };
}

async function backfillCollectionTraits(pgPool, { contract, slug, chain = 'ethereum', totalSupply = null, guildId = null, guildName = null }){
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
  const stats = { written: 0, skipped: 0, pages: 0, failed: 0, animated: false, queuedForRepair: 0 };
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
      // Alchemy pagination broken for this contract — fetch by token ID
      // range, now genuinely in bulk: several ranges of 100 fetched
      // CONCURRENTLY (Alchemy's own docs confirm startToken supports
      // parallel range fetching) instead of the old one-request-per-token
      // approach. RANGES_PER_ROUND=4 means up to 400 tokens per iteration
      // from 4 HTTP requests, not 400.
      if(rangeStart >= supplyCeiling){ hasMore = false; break; }
      const RANGES_PER_ROUND = 4;
      const starts = [];
      for(let k = 0; k < RANGES_PER_ROUND; k++){
        const s = rangeStart + k * PAGE_SIZE;
        if(s < supplyCeiling) starts.push(s);
      }
      const batchNfts = await fetchTokenRangesBulk(ALCHEMY_KEY, contract, starts, PAGE_SIZE, alchemySubdomain);
      if(!batchNfts.length){ hasMore = false; break; }
      page = { nfts: batchNfts, pageKey: null };
      rangeStart += starts.length * PAGE_SIZE;
      if(batchNfts.length < starts.length * PAGE_SIZE || rangeStart >= supplyCeiling) hasMore = false;
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
        // Report to the owner's error webhook before throwing — this is a
        // genuine systemic failure (not a per-token straggler, which the
        // repair queue already reports on its own), so it's worth knowing
        // about immediately rather than only via whichever caller's own
        // error handling happens to log it.
        sendErrorWebhook(
          `Backfill: "${slug}" aborted — ${consecutiveWriteFails} consecutive page-write failures`,
          pageErr,
          `Collection: ${slug} (${contract}) on ${chain}. This means every page is failing identically — likely a schema/constraint mismatch, not a transient issue retries would fix.`
        ).catch(()=>{});
        throw new Error(`${consecutiveWriteFails} consecutive page-write failures, giving up. Last error: ${pageErr.message}`);
      }
      if(!paginationBroken && !rpcOnlyMode){ pageKey = page.pageKey; hasMore = !!pageKey; }
      if(hasMore) await sleep(DELAY_MS);
      continue;
    }
    consecutiveWriteFails = 0;
    stats.written += result.written;
    stats.skipped += result.skipped;
    stats.queuedForRepair += result.queued || 0;
    stats.pages++;
    console.log(`[backfill] ${slug} page ${stats.pages} (attempt ${attemptNum}): written=${result.written} skipped=${result.skipped} queued=${result.queued || 0} hasMore=${hasMore}`);

    if(!paginationBroken && !rpcOnlyMode){
      pageKey = page.pageKey;
      hasMore = !!pageKey;
    }
    if(hasMore) await sleep(DELAY_MS);
  }

  // ── Tiers 2-4: resolve the leftover stragglers WITHOUT blocking the
  // caller ────────────────────────────────────────────────────────────────
  // The collection is already usable at this point — everything Tier 1
  // could resolve from bulk cache is written. What's left is queued in
  // metadata_repair_jobs. Try OpenSea's bulk listing first (still bulk, not
  // per-token) for whatever's left, learn a URI template from a couple of
  // samples if one exists, then hand the genuine stragglers to Tier 4 as a
  // detached background task — never awaited, so this function returns
  // control (and lets the Discord command respond) right away instead of
  // making a whole collection add wait on its own worst few percent.
  if(stats.queuedForRepair > 0){
    try{
      const openSeaResult = await runOpenSeaBulkRepair(pgPool, slug, chain);
      if(openSeaResult.resolved > 0){
        console.log(`[backfill] ${slug} OpenSea bulk pass resolved ${openSeaResult.resolved} more tokens directly — reducing what Tier 4 needs to handle individually`);
      }
    }catch(e){
      console.warn(`[backfill] ${slug} OpenSea bulk repair pass failed (non-fatal, Tier 4 will handle these individually):`, e.message);
    }

    let uriTemplate = null;
    try{
      const stillPendingRes = await pgPool.query(
        `SELECT token_id FROM metadata_repair_jobs WHERE collection_slug=$1 AND status='pending' ORDER BY token_id ASC LIMIT 5`,
        [slug]
      );
      const sampleIds = stillPendingRes.rows.map(r => r.token_id);
      if(sampleIds.length >= 2){
        uriTemplate = await learnUriTemplate(contract, sampleIds, ALCHEMY_KEY, alchemySubdomain);
      }
    }catch(e){
      console.warn(`[backfill] ${slug} URI template learning failed (non-fatal, Tier 4 falls back to per-token eth_call):`, e.message);
    }

    // Fire-and-forget — deliberately not awaited. Errors are caught inside
    // drainMetadataRepairQueue itself; this .catch is just a last-resort net
    // so an unexpected throw can't become an unhandled rejection.
    drainMetadataRepairQueue(pgPool, slug, uriTemplate).catch(e => {
      console.error(`[backfill] ${slug} background repair drain crashed:`, e.message);
    });
    console.log(`[backfill] ${slug} bulk pass complete — ${stats.written} written directly, ${stats.queuedForRepair} still queued for background repair (not blocking)`);
  }

  // Activity report — every successful backfill, not just failures, so
  // there's visibility into who's actually using the bot across every
  // server, not just when something breaks.
  const guildLabel = guildName ? `${guildName} (${guildId})` : (guildId || 'unknown guild');
  sendActivityWebhook(
    `✅ Backfill complete: "${slug}"`,
    `Guild: ${guildLabel}\nContract: ${contract}\nChain: ${chain}\nTokens written: ${stats.written}${stats.queuedForRepair ? `\nQueued for background repair: ${stats.queuedForRepair}` : ''}\nPages: ${stats.pages}`
  ).catch(()=>{});

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

  // Was fully serial (one token fully awaited before starting the next) —
  // this is a maintenance path, not part of normal onboarding, so it never
  // blocked the 2-minute backfill result, but there's no reason to leave a
  // large correction run taking hours when the same mapWithConcurrency +
  // bulk-write pattern already used everywhere else in this file applies
  // just as well here. Processed in chunks so a very large collection
  // doesn't try to hold thousands of in-flight requests/rows at once.
  let fixed = 0, unchanged = 0, failed = 0;
  const CHUNK_SIZE = 500;
  for(let i = 0; i < rows.length; i += CHUNK_SIZE){
    const chunk = rows.slice(i, i + CHUNK_SIZE);

    const results = await mapWithConcurrency(chunk, 8, async ({ id: tokenId }) => {
      try{
        const onChainMeta = await fetchTokenUriMetadata(contract, tokenId, alchemyKey, alchemySubdomain, chain);
        const verifiedImage = onChainMeta?.image_url || onChainMeta?.image || onChainMeta?.image_data || null;
        if(!verifiedImage) return { tokenId, unchanged: true };
        const resolvedImage = toDisplayableImageUrl(verifiedImage);
        const isSvgImage = needsSvgRender(resolvedImage);
        return { tokenId, resolvedImage, isSvgImage, success: true };
      }catch(e){
        console.warn(`[fix-images] ${slug}#${tokenId} failed:`, e.message);
        return { tokenId, failed: true };
      }
    });

    const toUpdate = results.filter(r => r.success);
    const svgRows = toUpdate.filter(r => r.isSvgImage);
    const plainRows = toUpdate.filter(r => !r.isSvgImage);

    const client = await pgPool.connect();
    try{
      await client.query('BEGIN');

      if(svgRows.length){
        const svgValues = svgRows.map(r => [r.tokenId, slug, r.resolvedImage]);
        await bulkInsert(
          client, 'token_svg_cache', ['token_id', 'collection_slug', 'image_data'], svgValues,
          `ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=EXCLUDED.image_data`
        );
        const svgIds = svgRows.map(r => r.tokenId);
        await client.query(`UPDATE tokens SET image_url=NULL WHERE collection_slug=$1 AND id = ANY($2::int[])`, [slug, svgIds]);
      }

      if(plainRows.length){
        // Bulk UPDATE via a VALUES join — each row needs its own distinct
        // image URL, so a plain ANY($ids) update won't work here.
        const values = [];
        const placeholders = plainRows.map((r, idx) => {
          const base = idx * 2;
          values.push(r.tokenId, r.resolvedImage);
          return `($${base + 1}::int, $${base + 2}::text)`;
        }).join(',');
        await client.query(
          `UPDATE tokens AS t SET image_url = v.image_url
           FROM (VALUES ${placeholders}) AS v(id, image_url)
           WHERE t.id = v.id AND t.collection_slug = $${plainRows.length * 2 + 1}`,
          [...values, slug]
        );
      }

      await client.query('COMMIT');
    }catch(e){
      await client.query('ROLLBACK');
      throw e;
    }finally{
      client.release();
    }

    fixed += toUpdate.length;
    unchanged += results.filter(r => r.unchanged).length;
    failed += results.filter(r => r.failed).length;
    console.log(`[fix-images] ${slug}: ${fixed} fixed, ${unchanged} unchanged, ${failed} failed so far (${Math.min(i + CHUNK_SIZE, rows.length)}/${rows.length} processed)`);
  }

  console.log(`[fix-images] ${slug}: done — ${fixed} fixed, ${unchanged} unchanged, ${failed} failed`);
  return { fixed, unchanged, failed, total: rows.length };
}

module.exports = {
  backfillCollectionTraits, SUPPORTED_CHAINS, fetchTokenUriMetadata, fixCollectionImages,
  fetchRawTokenUri, diagnoseIpfsGateways,
  runMetadataRepairQueue, drainMetadataRepairQueue, learnUriTemplate,
  fetchOpenSeaCollectionAll, runOpenSeaBulkRepair,
};
