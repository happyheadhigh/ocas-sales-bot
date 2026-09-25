'use strict';

// ── Shared IPFS gateway fallback ──────────────────────────────────────────────
// Extracted from commands/download.js so this logic has one home instead of
// being duplicated across every place that needs to fetch IPFS content
// reliably.

const fetch = require('node-fetch');

// Returns an array of candidate HTTP URLs to try, in priority order. For
// ipfs:// URIs specifically, tries several gateways rather than a single
// hardcoded one — ipfs.io is a free, shared public gateway used across the
// entire web3 ecosystem, and is known to be one of the more congested ones.
// Cloudflare and dweb.link tend to be meaningfully faster in practice;
// ipfs.io kept as a last fallback rather than removed, since it's still a
// legitimate gateway, just not the best first choice. Non-IPFS URLs pass
// through unaffected, as a single-item array.
function ipfsToHttpCandidates(url){
  const s = String(url || '');
  if(s.startsWith('ipfs://')){
    const path = s.replace('ipfs://','').replace(/^ipfs\//,'');
    return [
      `https://cloudflare-ipfs.com/ipfs/${path}`,
      `https://dweb.link/ipfs/${path}`,
      `https://ipfs.io/ipfs/${path}`,
    ];
  }
  return [s];
}

// Backward-compatible single-URL helper, for callers that just need a
// display/link URL rather than an actual fetch — returns the first,
// fastest candidate.
function ipfsToHttp(url){
  return ipfsToHttpCandidates(url)[0];
}

// jv: nekoadz's retry run STILL failed 134/134. Confirmed via the logs
// that the retry-with-backoff mechanism itself is working exactly as
// built (attempt 2/3, attempt 3/3, the backoff waits all show up
// correctly) -- but every attempt still hit rate limits on all 3
// gateways. With fullCollectionVerification's concurrency=4, four
// tokens get checked in parallel, each independently hammering these
// same 3 shared public gateways at the same time -- a thundering
// herd, not a patience problem. A short, per-request backoff alone
// can't fix that: if all 4 workers get rate-limited around the same
// moment and all wait a similar ~1-2s before retrying, they likely
// retry in the same narrow window and get rate-limited again,
// together, every time.
//
// The actual fix is a global throttle: however many tokens are being
// checked in parallel, the real outgoing requests to these gateways
// are now serialized process-wide with a minimum spacing between
// them, so the gateways only ever see one request at a time from this
// bot regardless of concurrency. Backoff waits also now include
// random jitter and are longer, so workers that do still hit a rate
// limit together don't retry in lockstep a second time.
let _gatewayQueueTail = Promise.resolve();
const MIN_GATEWAY_INTERVAL_MS = 350; // ~2.8 req/s ceiling, shared across every concurrent caller in this process

function _throttledGatewayFetch(candidateUrl, fetchOptions){
  const run = _gatewayQueueTail.then(async () => {
    await new Promise(res => setTimeout(res, MIN_GATEWAY_INTERVAL_MS));
    return fetch(candidateUrl, { timeout: 15000, ...fetchOptions });
  });
  // Keep the queue moving even if this particular request throws --
  // otherwise one failure would wedge every request queued behind it.
  _gatewayQueueTail = run.catch(() => {});
  return run;
}

function _jitter(ms){
  return ms + Math.floor(Math.random() * ms * 0.5);
}

// Tries each gateway candidate in sequence with a real timeout (node-fetch
// v2 has none by default). Moves to the next candidate on a transient 5xx
// or a rate limit (429) specifically -- worth trying elsewhere for a 5xx
// (a genuine gateway-side problem), and a 429 on one gateway says nothing
// about whether a DIFFERENT gateway is also rate-limited right now. Doesn't
// retry on a 404 or other non-5xx/429 error, where a different gateway
// serving the exact same content wouldn't help.
async function fetchWithGatewayFallback(url, fetchOptions = {}, retries = 3){
  const candidates = ipfsToHttpCandidates(url);
  let lastErr = null;
  for(let attempt = 0; attempt <= retries; attempt++){
    let anyRateLimited = false;
    for(let i = 0; i < candidates.length; i++){
      const candidateUrl = candidates[i];
      try{
        console.log(`[IpfsGateway] Fetching (gateway ${i+1}/${candidates.length}, attempt ${attempt+1}/${retries+1}):`, candidateUrl);
        const r = await _throttledGatewayFetch(candidateUrl, fetchOptions);
        console.log('[IpfsGateway] Fetch status:', r.status);
        if(r.ok) return r;
        if(r.status === 429) anyRateLimited = true;
        if([429,502,503,504].includes(r.status) && i < candidates.length - 1){
          lastErr = new Error(`HTTP ${r.status}`);
          continue;
        }
        throw new Error(`HTTP ${r.status}`);
      }catch(e){
        lastErr = e;
        if(/^HTTP 429/.test(e.message)) anyRateLimited = true;
        if(i === candidates.length - 1) break; // every gateway exhausted this attempt
        console.log(`[IpfsGateway] Gateway ${i+1} failed (${e.message}), trying next`);
      }
    }
    // Every gateway failed this attempt. If at least one of them was
    // specifically a rate limit (not, say, every single one 404ing, which
    // no amount of waiting would fix) and there's a retry left, back off
    // (with jitter, so parallel workers don't retry in lockstep) and
    // cycle through all three gateways again rather than giving up.
    if(anyRateLimited && attempt < retries){
      const wait = _jitter(2000 * Math.pow(2, attempt)); // ~2-3s, ~4-6s, ~8-12s
      console.log(`[IpfsGateway] All ${candidates.length} gateway(s) rate-limited, waiting ~${wait}ms before retrying (attempt ${attempt+2}/${retries+1})`);
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

module.exports = { ipfsToHttpCandidates, ipfsToHttp, fetchWithGatewayFallback };
