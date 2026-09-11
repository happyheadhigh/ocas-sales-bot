'use strict';

// ── Live sale feedback ───────────────────────────────────────────────────────
// jv asked for TraitView's grid to update instantly when a token sells,
// specifically confirming OpenSea's Stream API over polling since streamed
// events don't count against the regular REST API rate limits at all
// (confirmed directly from OpenSea's own docs: "Streamed events do not count
// toward your API rate limits").
//
// Architecture: this backend service holds ONE persistent Stream connection
// per collection (the API key can never be exposed to the browser -- that's
// explicit in OpenSea's own SDK docs), subscribes to item_sold events for
// each, and relays them to any number of connected TraitView clients over
// Server-Sent Events (SSE) -- one-directional server->browser push, which is
// all this needs, and far simpler to run behind Railway than a second
// WebSocket server would be.

const { OpenSeaStreamClient } = require('@opensea/sdk/stream');
const { WebSocket } = require('ws');
const { pgPool } = require('./db');
const { osHeaders } = require('./constants');

// slug -> Set of Express response objects currently subscribed via SSE
const _sseClients = new Map();
// slug -> unsubscribe function returned by client.onItemSold(), so a
// collection's stream subscription isn't duplicated if this ever gets
// called twice for the same slug
const _subscribed = new Map();

let _client = null;

function _getClient(){
  if(_client) return _client;
  // osHeaders() already centralizes how this bot reads its OpenSea key from
  // the environment everywhere else -- reusing that instead of a second,
  // separate env lookup, so there's exactly one place this can be misconfigured.
  const apiKey = osHeaders()['X-API-KEY'];
  if(!apiKey){
    console.warn('[SaleStream] No OpenSea API key configured -- live sale feed disabled.');
    return null;
  }
  _client = new OpenSeaStreamClient({
    apiKey,
    // Node's own global WebSocket only exists on 22+; this bot's own
    // package.json still declares support back to 18, so supply ws
    // explicitly rather than assume the deployed Node version.
    connectOptions: { transport: WebSocket },
    onError: (err) => console.warn('[SaleStream] Stream client error:', err?.message || err),
  });
  return _client;
}

function _broadcast(slug, data){
  const clients = _sseClients.get(slug);
  if(!clients || !clients.size) return;
  const line = `data: ${JSON.stringify(data)}\n\n`;
  for(const res of clients){
    try{ res.write(line); }catch(e){ /* client likely already gone; cleaned up on 'close' */ }
  }
}

// wei string -> ETH number. payment_token carries which token was actually
// used (WETH, ETH, etc all share 18 decimals in practice here) -- kept
// generic on decimals rather than assuming 18, in case that ever isn't true.
function _weiToEth(wei, decimals){
  try{
    const d = Number.isFinite(decimals) ? decimals : 18;
    return Number(BigInt(wei)) / Math.pow(10, d);
  }catch{ return null; }
}

// OpenSea's nft_id comes as "chain/contract/tokenId" -- only the trailing
// numeric id matters to the frontend grid.
function _tokenIdFromNftId(nftId){
  if(!nftId) return null;
  const parts = String(nftId).split('/');
  const last = parts[parts.length - 1];
  const n = parseInt(last, 10);
  return Number.isFinite(n) ? n : null;
}

function subscribeToCollection(slug){
  if(_subscribed.has(slug)) return; // already streaming this collection
  const client = _getClient();
  if(!client) return;
  const unsubscribe = client.onItemSold(slug, (event) => {
    const p = event?.payload;
    if(!p) return;
    const tokenId = _tokenIdFromNftId(p.item?.nft_id);
    if(tokenId == null) return;
    const priceEth = _weiToEth(p.sale_price, p.payment_token?.decimals);
    _broadcast(slug, {
      type: 'sale',
      tokenId,
      priceEth,
      currency: p.payment_token?.symbol || null,
      timestamp: p.event_timestamp || event.sent_at || null,
    });
    console.log(`[SaleStream] ${slug} #${tokenId} sold for ${priceEth} ${p.payment_token?.symbol || ''}`);
  });
  _subscribed.set(slug, unsubscribe);
  console.log(`[SaleStream] Subscribed to item_sold events for ${slug}`);
}

// Called once at startup -- subscribes to every fully-onboarded collection
// so the stream is already live before any TraitView client ever connects,
// rather than lazily subscribing on first SSE request (which would miss any
// sale that happened in the gap before the first viewer showed up).
async function subscribeToAllReadyCollections(){
  try{
    const result = await pgPool.query(`SELECT slug FROM collections WHERE status = 'ready'`);
    for(const row of result.rows) subscribeToCollection(row.slug);
  }catch(e){
    console.warn('[SaleStream] Failed to load collections for subscription:', e.message);
  }
}

// Express route handler for GET /db/sales-stream?slug=X -- an SSE endpoint.
// Kept as a plain handler (not wired into the main auth() middleware chain
// by this file itself) so api.js decides where in its own routing this
// gets mounted, same as every other endpoint in that file.
function handleSseRequest(req, res){
  const slug = String(req.query.slug || '').trim();
  if(!slug){ res.status(400).json({ ok: false, error: 'slug required' }); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // Needed since TraitView is served from a different origin (Cloudflare
    // Pages) than this API (Railway) -- every other endpoint in this file
    // already relies on CORS being handled at the app level for the same
    // reason, so no separate header needed here beyond what's already global.
  });
  res.write(':ok\n\n'); // comment ping so the connection opens immediately

  if(!_sseClients.has(slug)) _sseClients.set(slug, new Set());
  _sseClients.get(slug).add(res);
  subscribeToCollection(slug); // no-op if already subscribed

  // Keep the connection alive through proxies/load balancers that would
  // otherwise time out an idle HTTP connection.
  const keepAlive = setInterval(() => {
    try{ res.write(':ping\n\n'); }catch{ clearInterval(keepAlive); }
  }, 20_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const clients = _sseClients.get(slug);
    if(clients) clients.delete(res);
  });
}

module.exports = {
  subscribeToCollection,
  subscribeToAllReadyCollections,
  handleSseRequest,
};
