'use strict';

// ── Stackers live event listener ──────────────────────────────────────────────
// Uses a live WebSocket subscription (confirmed working on this Alchemy
// account via a direct test) to receive fusion/status events the instant
// they happen, rather than repeatedly polling small block ranges. This
// sidesteps the confirmed 10-block eth_getLogs range cap entirely — a live
// subscription isn't a block-range query at all, so there's nothing to be
// capped.
//
// This does NOT replace the existing cursor-based pollers
// (lib/stackers-fusion-poller.js, lib/stackers-status-poller.js) — they
// remain in place as a periodic safety net, now at a much lower frequency
// than before, since the live listener handles the primary path. The net
// catches genuinely rare edge cases: a disconnect that wasn't cleanly
// detected, a moment where the WebSocket silently stalls, etc. Separately,
// this does NOT retroactively fix the large historical backlog built up
// before tonight's fixes — that's what the manual catch-up endpoints
// (/db/stackers/catchup-fusion, /db/stackers/catchup-status) are for.
//
// A real, confirmed risk found while building this: an unhandled 'error'
// event on the underlying WebSocket crashes the entire Node process --
// reproduced directly in a local test before writing this code. An
// explicit error listener on provider.websocket is mandatory, not
// optional, and every listener below is wrapped so a single failed
// database write or Discord API call can never take down the connection
// itself.

const { ethers } = require('ethers');
const { NFT_ADDRESS, ENGINE_ADDRESS, VAULT_ADDRESS } = require('./stackers');
const NFT_ABI    = require('./stackers-abis/nft.json');
const ENGINE_ABI = require('./stackers-abis/engine.json');
const VAULT_ABI  = require('./stackers-abis/vault.json');
const { pollFusionEvents, handleFusionEvent } = require('./stackers-fusion-poller');
const { pollTokenStatusEvents, upsertActiveOnly, refreshFullStatus, refreshVaultBalance } = require('./stackers-status-poller');
const { recordRoundSettled } = require('./stackers-analytics');

// ── Paced processing queue ──────────────────────────────────────────────────
// Confirmed via real deployment logs: an hourly round settlement credits
// every active Stacker at once (potentially 1,000+ tokens), and each one
// firing an immediate, unbatched RPC call caused 3,336 failed event handles
// in roughly an hour -- all 429 rate-limit errors, directly explaining
// repeated collateral damage to the unrelated OCAS burn poller. Every
// listener below queues its work instead of firing immediately; a single
// worker drains the queue one item at a time with pacing between each.
// Deduped by key so multiple events for the same token (e.g. Credited
// firing again before the first refresh finishes) don't queue redundant
// work.
const QUEUE_PACING_MS = 300;
const _eventQueue = [];
const _queuedKeys = new Set();
let _queueRunning = false;

function enqueue(key, fn){
  if(_queuedKeys.has(key)) return; // already pending, no need to duplicate
  _queuedKeys.add(key);
  _eventQueue.push({ key, fn });
  drainQueue().catch(e => console.error('[StackersLive] Queue drain error:', e.message));
}

async function drainQueue(){
  if(_queueRunning) return;
  _queueRunning = true;
  while(_eventQueue.length){
    const { key, fn } = _eventQueue.shift();
    _queuedKeys.delete(key);
    try{
      await fn();
    }catch(e){
      console.error(`[StackersLive] Queued action failed (${key}):`, e.message);
    }
    await new Promise(r => setTimeout(r, QUEUE_PACING_MS));
  }
  _queueRunning = false;
}

let _pgPool = null;
let _wsProvider = null;
let _reconnectDelayMs = 5000;
const MAX_RECONNECT_DELAY_MS = 60_000;

// Safety-net poll — much lower frequency than the original 60s cadence,
// since the live listener now handles the primary path. This only needs
// to catch rare edge cases, not carry the main load.
const SAFETY_NET_INTERVAL_MS = 60 * 60 * 1000; // 1 hour -- reduced from 10 minutes after confirming via the Alchemy dashboard this account is genuinely strained. This poller is mostly redundant now: the WebSocket already triggers its own immediate catch-up on every reconnect, so this only matters for the rare case of a silent connection failure that neither errors nor closes cleanly -- not worth 10-minute-cadence RPC load as a permanent baseline.
let _safetyNetTimer = null;

function getWssUrl(){
  const key = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  if(!key) throw new Error('Missing ALCHEMY_API_KEY/ALCHEMY_KEY env var');
  return `wss://robinhood-mainnet.g.alchemy.com/v2/${key}`;
}

function scheduleReconnect(){
  if(_wsProvider){
    _wsProvider.destroy().catch(()=>{});
    _wsProvider = null;
  }
  console.log(`[StackersLive] Reconnecting in ${(_reconnectDelayMs / 1000).toFixed(0)}s...`);
  setTimeout(() => {
    connectAndListen(_pgPool).catch(e => console.error('[StackersLive] Reconnect attempt failed:', e.message));
  }, _reconnectDelayMs);
  _reconnectDelayMs = Math.min(_reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

async function connectAndListen(pgPool){
  _pgPool = pgPool;
  const wsProvider = new ethers.WebSocketProvider(getWssUrl());
  _wsProvider = wsProvider;

  // Mandatory — an unhandled 'error' event on the underlying WebSocket
  // crashes the entire process. Confirmed directly in a local test before
  // this code was written; this is not a defensive-programming nicety,
  // it's the difference between a graceful reconnect and a full outage.
  wsProvider.websocket.on('error', (e) => {
    console.error('[StackersLive] WebSocket error:', e.message);
    scheduleReconnect();
  });
  wsProvider.websocket.on('close', () => {
    console.warn('[StackersLive] WebSocket closed');
    scheduleReconnect();
  });

  const nft    = new ethers.Contract(NFT_ADDRESS, NFT_ABI, wsProvider);
  const engine = new ethers.Contract(ENGINE_ADDRESS, ENGINE_ABI, wsProvider);
  const vault  = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wsProvider);

  vault.on('Merged', async (...args) => {
    const event = args[args.length - 1];
    const survivorId = event.args.survivorId.toString();
    const absorbedId = event.args.absorbedId.toString();
    enqueue(`fusion:${survivorId}:${absorbedId}:${event.log?.blockNumber}`, async () => {
      await handleFusionEvent(survivorId, absorbedId, event.log?.blockNumber);
    });
  });

  nft.on('Activated', async (...args) => {
    try{
      const event = args[args.length - 1];
      const tokenId = event.args.tokenId.toString();
      await upsertActiveOnly(_pgPool, tokenId, true);
      console.log(`[StackersLive] Activated: #${tokenId}`);
    }catch(e){
      console.error('[StackersLive] Failed to handle live Activated event:', e.message);
    }
  });

  nft.on('Deactivated', async (...args) => {
    try{
      const event = args[args.length - 1];
      const tokenId = event.args.tokenId.toString();
      await upsertActiveOnly(_pgPool, tokenId, false);
      console.log(`[StackersLive] Deactivated: #${tokenId}`);
    }catch(e){
      console.error('[StackersLive] Failed to handle live Deactivated event:', e.message);
    }
  });

  nft.on('TierUpgraded', async (...args) => {
    const event = args[args.length - 1];
    const tokenId = event.args.tokenId.toString();
    enqueue(`status:${tokenId}`, async () => {
      await refreshFullStatus(_pgPool, tokenId);
      console.log(`[StackersLive] TierUpgraded: #${tokenId}`);
    });
  });

  engine.on('SplitSet', async (...args) => {
    const event = args[args.length - 1];
    const tokenId = event.args.tokenId.toString();
    enqueue(`status:${tokenId}`, async () => {
      await refreshFullStatus(_pgPool, tokenId);
      console.log(`[StackersLive] SplitSet: #${tokenId}`);
    });
  });

  // Credited fires when a token's vault balance increases (the hourly
  // round settling); Claimed fires when a holder withdraws. Both trigger
  // a real balance re-read via refreshVaultBalance rather than trusting
  // either event's own "amount" field directly — genuinely unconfirmed
  // whether that represents a delta or an absolute new total, and a live,
  // targeted read sidesteps that ambiguity entirely.
  vault.on('Credited', async (...args) => {
    const event = args[args.length - 1];
    const tokenId = event.args.tokenId.toString();
    enqueue(`vault:${tokenId}`, async () => {
      await refreshVaultBalance(_pgPool, tokenId);
      console.log(`[StackersLive] Credited: #${tokenId}`);
    });
  });

  vault.on('Claimed', async (...args) => {
    const event = args[args.length - 1];
    const tokenId = event.args.tokenId.toString();
    enqueue(`vault:${tokenId}`, async () => {
      await refreshVaultBalance(_pgPool, tokenId);
      console.log(`[StackersLive] Claimed: #${tokenId}`);
    });
  });

  // Records the actual pot size and total collection weight for each
  // hourly round -- the foundation for grounding earnings estimates in
  // real recent data rather than a guessed formula. Idempotent (see
  // recordRoundSettled), safe against potential duplicate delivery.
  engine.on('RoundSettled', async (...args) => {
    try{
      const event = args[args.length - 1];
      const round = event.args.round;
      const pot = event.args.pot;
      const totalWeight = event.args.totalWeight;
      await recordRoundSettled(_pgPool, round, pot, totalWeight);
      console.log(`[StackersLive] RoundSettled: round ${round}, pot ${pot.toString()} wei, totalWeight ${totalWeight.toString()}`);
    }catch(e){
      console.error('[StackersLive] Failed to handle live RoundSettled event:', e.message);
    }
  });

  console.log('[StackersLive] Connected and listening for live events');
  _reconnectDelayMs = 5000; // reset backoff after a successful connection

  // Close any gap immediately after connecting — covers both a genuine
  // reconnect after a disconnect, and the very first connection at
  // startup, which may follow a period where only the slower polling
  // backstop was running.
  await pollFusionEvents(200).catch(e => console.warn('[StackersLive] Post-connect fusion catch-up failed:', e.message));
  await pollTokenStatusEvents(_pgPool, 100).catch(e => console.warn('[StackersLive] Post-connect status catch-up failed:', e.message));
}

function startSafetyNetPolling(pgPool){
  if(_safetyNetTimer) return;
  _safetyNetTimer = setInterval(() => {
    pollFusionEvents(60).catch(e => console.warn('[StackersLive] Safety-net fusion poll failed:', e.message));
    pollTokenStatusEvents(pgPool, 30).catch(e => console.warn('[StackersLive] Safety-net status poll failed:', e.message));
  }, SAFETY_NET_INTERVAL_MS);
}

async function startLiveListeners(pgPool){
  await connectAndListen(pgPool);
  startSafetyNetPolling(pgPool);
}

module.exports = { startLiveListeners };
