'use strict';

const fetch = require('node-fetch');
const { ALCHEMY_KEY } = require('./constants');

// ── RPC helpers ───────────────────────────────────────────────────────────────
function burnRpcUrl(){
  const key = process.env.ALCHEMY_API_KEY;
  return process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://', 'https://') ||
    (key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : '');
}

async function burnRpc(rpcUrl, method, params){
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const j = await r.json();
  if(j.error) throw new Error(`${method} error: ${JSON.stringify(j.error)}`);
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
      burnBlockTimestampCache.set(n, ts * 1000);
      if(burnBlockTimestampCache.size > 500) burnBlockTimestampCache.delete(burnBlockTimestampCache.keys().next().value);
    }
    return ts > 0 ? ts * 1000 : null;
  }catch(_){
    return null;
  }
}

module.exports = {
  burnRpcUrl, burnRpc,
  fetchEthBlockHashSeed, waitForEthBlock,
  getBurnBlockTimestamp, burnBlockTimestampCache,
};
