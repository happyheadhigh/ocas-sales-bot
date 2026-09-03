'use strict';

const fetch  = require('node-fetch');
const https  = require('https');
const { ALCHEMY_KEY, OCAS_CONTRACT } = require('./constants');

// ── Shared HTTPS agent for all RPC calls ──────────────────────────────────────
// keepAlive: true   — reuse TCP connections across requests (efficient)
// keepAliveMsecs    — send TCP keepalive probes every 10s so Railway's proxy
//                     knows the connection is active (prevents silent drops)
// timeout           — destroy idle sockets after 25 min, safely below Railway's
//                     ~50 min drop threshold (prevents "socket hang up" errors)
// maxSockets        — cap concurrent connections (respects Alchemy free tier limits)
const rpcAgent = new https.Agent({
  keepAlive:      true,
  keepAliveMsecs: 10_000,
  timeout:        25 * 60 * 1000,
  maxSockets:     4,
});

// ── RPC helpers ───────────────────────────────────────────────────────────────
function normalizeRpcUrl(url){
  const raw = String(url || '').trim();
  if(!raw) return '';

  // Let one Railway var support either websocket or HTTP RPC.
  // wss://mainnet.infura.io/ws/v3/KEY -> https://mainnet.infura.io/v3/KEY
  if(/^wss:\/\/mainnet\.infura\.io\/ws\/v3\//i.test(raw)){
    return raw.replace(/^wss:\/\/mainnet\.infura\.io\/ws\/v3\//i, 'https://mainnet.infura.io/v3/');
  }

  return raw
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://');
}

function burnRpcUrl(allowOverride = true){
  const key = process.env.ALCHEMY_API_KEY;
  // BURN_RPC_OVERRIDE: set temporarily in Railway to use Infura (or any RPC)
  // for fast catch-up (e.g. 5000 chunk size). Delete when caught up.
  return normalizeRpcUrl(
    (allowOverride && process.env.BURN_RPC_OVERRIDE) ||
    process.env.ETH_RPC_URL ||
    process.env.ALCHEMY_RPC_URL ||
    (key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : '')
  );
}

function rpcHostForLog(rpcUrl){
  try{ return new URL(rpcUrl).host; }
  catch(_){ return rpcUrl ? 'invalid-url' : 'missing'; }
}

// Masked key fingerprint for logging — enough to confirm whether two
// deployments (e.g. production vs staging) are hitting this error using the
// SAME underlying Alchemy key (pointing at an account-level cause) or
// different keys (pointing at something per-deployment instead), without
// ever writing the actual secret into logs.
function rpcKeyFingerprintForLog(rpcUrl){
  try{
    const u = new URL(rpcUrl);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    if(seg.length < 6) return seg ? '***' : 'none';
    return '...' + seg.slice(-6);
  }catch(_){ return 'invalid-url'; }
}

// Pulls a short, useful summary out of eth_getLogs params specifically (the
// block range actually requested) for error logging -- confirms directly
// whether a given failure happened on a range that exceeds this account's
// known limits, rather than inferring it from reading the calling code.
function paramsSummaryForLog(method, params){
  try{
    if(method === 'eth_getLogs' && params?.[0]){
      const p = params[0];
      const from = p.fromBlock ? parseInt(p.fromBlock, 16) : null;
      const to = p.toBlock ? parseInt(p.toBlock, 16) : null;
      const span = (from != null && to != null) ? (to - from + 1) : null;
      return ` fromBlock=${p.fromBlock} toBlock=${p.toBlock}${span != null ? ` span=${span}blocks` : ''}`;
    }
  }catch(_){}
  return '';
}

// Grabs response headers that commonly carry rate-limit or CDN/WAF
// diagnostic info even on a blocked request with an empty body -- helps
// distinguish "Alchemy's own application layer rejected this" (would
// usually still return a JSON error body) from "a CDN/WAF in front of it
// blocked the request before it got there" (often a bare empty-body
// status code with no explanation at all).
function relevantHeadersForLog(headers){
  const keys = ['cf-ray', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'x-request-id', 'server'];
  const found = {};
  for(const k of keys){
    const v = headers.get(k);
    if(v) found[k] = v;
  }
  return Object.keys(found).length ? JSON.stringify(found) : 'none';
}

async function burnRpc(rpcUrl, method, params){
  const url = normalizeRpcUrl(rpcUrl);
  if(!url) throw new Error(`${method} error: no RPC URL configured`);

  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc:'2.0', id:Date.now(), method, params }),
    agent:   rpcAgent,
  });

  const text = await r.text();
  let j;
  try{
    j = JSON.parse(text);
  }catch(_){
    throw new Error(`${method} HTTP ${r.status}: non-JSON RPC response from ${rpcHostForLog(url)} key=${rpcKeyFingerprintForLog(url)}${paramsSummaryForLog(method, params)} headers=${relevantHeadersForLog(r.headers)} (${text.slice(0,120).replace(/\s+/g,' ')})`);
  }

  if(!r.ok){
    throw new Error(`${method} HTTP ${r.status} from ${rpcHostForLog(url)} key=${rpcKeyFingerprintForLog(url)}${paramsSummaryForLog(method, params)}: ${JSON.stringify(j).slice(0,240)}`);
  }
  if(j.error){
    throw new Error(`${method} RPC error from ${rpcHostForLog(url)} key=${rpcKeyFingerprintForLog(url)}${paramsSummaryForLog(method, params)}: ${JSON.stringify(j.error)}`);
  }
  if(j.result == null){
    throw new Error(`${method} empty RPC result from ${rpcHostForLog(url)}: ${JSON.stringify(j).slice(0,240)}`);
  }

  return j.result;
}

// ── ETH block hash seed ───────────────────────────────────────────────────────
async function fetchEthBlockHashSeed(targetBlock){
  const rpcUrl = burnRpcUrl();
  const block  = await burnRpc(rpcUrl, 'eth_getBlockByNumber', ['0x' + targetBlock.toString(16), false]);
  if(!block || !block.hash) throw new Error(`Block #${targetBlock} not found or has no hash`);
  return { hash: block.hash, blockNumber: targetBlock };
}

async function waitForEthBlock(targetBlock){
  const rpcUrl   = burnRpcUrl();
  const deadline = Date.now() + 3 * 60 * 1000;
  while(Date.now() < deadline){
    try{
      const latest = parseInt(await burnRpc(rpcUrl, 'eth_blockNumber', []), 16);
      if(latest >= targetBlock) return true;
    }catch(_){}
    await new Promise(r => setTimeout(r, 12000));
  }
  return false;
}

// Block timestamp cache
const burnBlockTimestampCache = new Map();

async function getBurnBlockTimestamp(blockNumber){
  const n = Number(blockNumber);
  if(!Number.isFinite(n) || n <= 0) return null;
  if(burnBlockTimestampCache.has(n)) return burnBlockTimestampCache.get(n);
  const rpcUrl = burnRpcUrl();
  if(!rpcUrl) return null;
  try{
    const block = await burnRpc(rpcUrl, 'eth_getBlockByNumber', ['0x' + n.toString(16), false]);
    const ts = parseInt(block?.timestamp || '0x0', 16);
    if(ts > 0){
      burnBlockTimestampCache.set(n, new Date(ts * 1000));
      if(burnBlockTimestampCache.size > 500) burnBlockTimestampCache.delete(burnBlockTimestampCache.keys().next().value);
    }
    return ts > 0 ? new Date(ts * 1000) : null;
  }catch(_){
    return null;
  }
}



function normalizeTraitAttribute(t){
  if(!t || typeof t !== 'object') return null;
  const trait_type = t.trait_type || t.traitType || t.type || t.name;
  const value = t.value;
  if(!trait_type || value == null) return null;
  return { trait_type:String(trait_type), value:String(value) };
}

function traitsArrayFromInput(input){
  if(!input) return [];
  if(Array.isArray(input)) return input.map(normalizeTraitAttribute).filter(Boolean);
  if(input.__attributes && Array.isArray(input.__attributes))
    return input.__attributes.map(normalizeTraitAttribute).filter(Boolean);
  const embedded = Object.entries(input).filter(([k])=>k!=='__image'&&k!=='__attributes').map(([trait_type,value])=>({trait_type,value}));
  const arr = embedded.map(normalizeTraitAttribute).filter(Boolean);
  return arr;
}

function traitsObjectFromArray(attrs, image=null){
  const clean = traitsArrayFromInput(attrs);
  const obj = {};
  for(const t of clean){
    // Compatibility object lookup for old code. Duplicate trait names are preserved
    // in __attributes even though this object key will contain the last value.
    obj[t.trait_type] = t.value;
  }
  if(clean.length) obj.__attributes = clean;
  if(image) obj.__image = image;
  return obj;
}

function realTraitCount(traits){
  return traitsArrayFromInput(traits).length;
}

function traitValue(traits, name){
  const wanted = String(name || '').toLowerCase();
  const attrs = traitsArrayFromInput(traits);
  const found = attrs.find(t => String(t.trait_type || '').toLowerCase() === wanted);
  if(found) return found.value;
  return traits && typeof traits === 'object' ? (traits[name] || traits[String(name).toLowerCase()]) : null;
}

// ── Fetch metadata directly from the OCAS contract via tokenURI(uint256) ────
// Uses Alchemy eth_call — ~2 CUs, 100-300ms, always returns current on-chain data.
// Returns traits object or null on failure.
async function fetchTokenUriFromContract(tokenId){
  const id = parseInt(tokenId);
  if(!id) return null;
  const rpcUrl = burnRpcUrl();
if(!rpcUrl) return null;
  try{
    // Function selector: keccak256("tokenURI(uint256)") = 0xc87b56dd
    const paddedId = id.toString(16).padStart(64, '0');
    const result = await burnRpc(rpcUrl, 'eth_call', [{
      to: OCAS_CONTRACT,
      data: '0xc87b56dd' + paddedId,
    }, 'latest']);
    if(!result || result === '0x') return null;
    // Decode ABI-encoded string: offset(32) + length(32) + utf8 data
    const hex = result.slice(2);
    const lengthWords = parseInt(hex.slice(64, 128), 16);
    let uri = Buffer.from(hex.slice(128, 128 + lengthWords * 2), 'hex').toString('utf-8');
    if(uri.startsWith('data:application/json;base64,'))
      uri = Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf-8');
    else if(uri.startsWith('data:application/json,'))
      uri = decodeURIComponent(uri.slice('data:application/json,'.length));
    const meta = JSON.parse(uri);
    const rawAttrs = Array.isArray(meta.attributes) ? meta.attributes : (Array.isArray(meta.traits) ? meta.traits : []);
    const traits = traitsObjectFromArray(rawAttrs, meta.image || meta.image_data || meta.image_url || null);
    if(realTraitCount(traits)){
      console.log(`[Contract] tokenURI #${id} → Type=${traitValue(traits,'Type')||'?'} (${realTraitCount(traits)} traits)`);
      return traits;
    }
    return null;
  }catch(e){
    console.warn(`[Contract] tokenURI fetch failed for #${id}:`, e.message);
    return null;
  }
}

function getTraitImageSource(traits){
  return traits && typeof traits === 'object' ? traits.__image : null;
}

module.exports = {
  getTraitImageSource,
  burnRpcUrl, burnRpc, normalizeRpcUrl, rpcHostForLog,
  fetchEthBlockHashSeed, waitForEthBlock,
  getBurnBlockTimestamp, burnBlockTimestampCache,
  fetchTokenUriFromContract,
  normalizeTraitAttribute, traitsArrayFromInput, traitsObjectFromArray, realTraitCount, traitValue,
};