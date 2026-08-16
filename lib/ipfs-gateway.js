'use strict';

// ── Shared IPFS gateway fallback ──────────────────────────────────────────────
// Extracted from commands/download.js so this logic has one home instead of
// being duplicated across every place that needs to fetch IPFS content
// reliably (originally just /download; now also the Stackers image cache).

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

// Tries each gateway candidate in sequence with a real timeout (node-fetch
// v2 has none by default). Moves to the next candidate on a transient 5xx
// specifically (a genuine gateway-side problem, worth trying elsewhere for)
// or on a hard failure like a timeout — but not on a 404 or other non-5xx
// error, where a different gateway serving the exact same content wouldn't
// help.
async function fetchWithGatewayFallback(url, fetchOptions = {}){
  const candidates = ipfsToHttpCandidates(url);
  let lastErr = null;
  for(let i = 0; i < candidates.length; i++){
    const candidateUrl = candidates[i];
    try{
      console.log(`[IpfsGateway] Fetching (gateway ${i+1}/${candidates.length}):`, candidateUrl);
      const r = await fetch(candidateUrl, { timeout: 15000, ...fetchOptions });
      console.log('[IpfsGateway] Fetch status:', r.status);
      if(r.ok) return r;
      if([502,503,504].includes(r.status) && i < candidates.length - 1){
        lastErr = new Error(`HTTP ${r.status}`);
        continue;
      }
      throw new Error(`HTTP ${r.status}`);
    }catch(e){
      lastErr = e;
      if(i === candidates.length - 1) throw lastErr;
      console.log(`[IpfsGateway] Gateway ${i+1} failed (${e.message}), trying next`);
    }
  }
  throw lastErr;
}

module.exports = { ipfsToHttpCandidates, ipfsToHttp, fetchWithGatewayFallback };
