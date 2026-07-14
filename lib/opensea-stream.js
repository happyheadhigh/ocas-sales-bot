'use strict';

// ── OpenSea Stream API connector ─────────────────────────────────────────────
// Pushes item_listed / item_sold events over WebSocket instead of polling.
// Streaming events do not count toward the OpenSea REST rate limit at all,
// per OpenSea's own docs — this is the fix for the shared-bucket contention
// already observed between the rank backfill and cost-basis restore scripts.
//
// IMPORTANT — first-cut scope, deliberately narrow:
//   - Covers item_listed and item_sold only: instant post to the configured
//     listings/sales channel, using the SAME buildListingEmbed/buildSaleEmbed
//     as the REST poller, so embeds render identically either way.
//   - Does NOT (yet) port: OS Rank alerts, price/floor alerts, personal DM
//     alerts, or sweep-sale grouping. Those stay on the existing pollSales/
//     pollListings loop in lib/poll.js, which keeps running unchanged
//     alongside this for now. Porting those is real additional work and
//     is deliberately left for a follow-up rather than guessed at here.
//   - listingFilters (trait-based filtering) ARE enforced here, but via a
//     local token_traits DB lookup rather than Stream's payload, which
//     doesn't include full trait objects. If a collection has no local
//     trait data (never backfilled) and filters are configured, this SKIPS
//     posting via Stream for that guild/channel rather than risk posting
//     something that should've been filtered out — the REST poller (which
//     has real trait data from OpenSea) still covers it.
//
// FIELD MAPPING — verified against the actual @opensea/stream-js v0.4.0
// TypeScript definitions (installed and inspected directly), not just the
// docs snippets, since getting this wrong would silently produce wrong
// prices with no error thrown:
//   item_listed payload:  base_price   (wei string)
//   item_sold   payload:  sale_price   (wei string) — NOT base_price, despite
//                         docs examples for item_listed/item_cancelled using
//                         base_price; item_sold's own type definition uses a
//                         different field name.
//
// Reconnect behavior: the underlying SDK auto-reconnects (calling any
// onItemListed/onItemSold subscribe method internally calls socket.connect(),
// which is safe to call again if already connected), but delivery itself is
// best-effort — dropped events during any disconnect are NOT retried by
// OpenSea. The existing REST poller running alongside this is the safety
// net for that gap; do not reduce its polling frequency until this has been
// validated running for a real stretch of time.

const { OpenSeaStreamClient } = require('@opensea/stream-js');
const { WebSocket } = require('ws');
const { LocalStorage } = require('node-localstorage');

const { OPENSEA_KEY } = require('./constants');
const { pgPool, getAllConfigs } = require('./db');
const { buildPollContexts } = require('./poll');
const { buildListingEmbed, buildSaleEmbed } = require('./embeds');
const { sendEmbed } = require('./images');
const { dedupeChannelPost, dedupeChannelPostPersistent } = require('./cache');
const { matchesFilters } = require('../utils/format');

let _client = null;      // Discord client
let _stream = null;      // OpenSeaStreamClient instance
const _subscriptions = new Map(); // slug -> { unsubListed, unsubSold }

let _rawLogCount = { listed: 0, sold: 0 };
const RAW_PAYLOAD_LOG_LIMIT = 5; // print the first few raw payloads per event type, then stop

function setDiscordClient(client){ _client = client; }

// "ethereum/0xCONTRACT/12345" -> { chain, contract, tokenId }
function parseNftId(nftId){
  if(!nftId) return null;
  const parts = String(nftId).split('/');
  if(parts.length < 3) return null;
  return { chain: parts[0], contract: parts[1], tokenId: parts[2] };
}

// Look up local trait data for filter-matching. Returns null if this
// collection has no trait rows locally (never backfilled) rather than an
// empty array, so callers can tell "no traits" apart from "unknown."
async function fetchLocalTraitsForFilter(tokenId, slug){
  try{
    const res = await pgPool.query(
      `SELECT trait_name, trait_value FROM token_traits WHERE token_id = $1 AND collection_slug = $2`,
      [parseInt(tokenId, 10), slug]
    );
    if(!res.rows.length) return null;
    return res.rows.map(r => ({ trait_type: r.trait_name, value: r.trait_value }));
  }catch(e){
    console.error('[Stream][traits lookup]', slug, tokenId, e.message);
    return null;
  }
}

// Every (guildId, ctx) pair currently tracking a given slug — a collection
// can be configured in more than one guild, each with its own channel/filters.
function contextsForSlug(slug){
  const out = [];
  for(const [guildId, config] of getAllConfigs()){
    for(const ctx of buildPollContexts(guildId, config)){
      if(ctx.slug === slug && !ctx.paused) out.push(ctx);
    }
  }
  return out;
}

async function handleItemListed(slug, event){
  try{
    if(_rawLogCount.listed < RAW_PAYLOAD_LOG_LIMIT){
      _rawLogCount.listed++;
      console.log('[Stream][raw item_listed]', JSON.stringify(event));
    }

    const parsed = parseNftId(event?.item?.nft_id);
    if(!parsed || !parsed.tokenId) return;
    const tokenId = parsed.tokenId;

    for(const ctx of contextsForSlug(slug)){
      if(!ctx.listingsChannelId) continue;
      const channel = _client?.channels.cache.get(ctx.listingsChannelId);
      if(!channel) continue;

      if(ctx.listingFilters && Object.keys(ctx.listingFilters).length){
        const localTraits = await fetchLocalTraitsForFilter(tokenId, slug);
        if(localTraits === null){
          console.log(`[Stream][listing] #${tokenId} skipped — filters configured but no local trait data for ${slug}, leaving to REST poller`);
          continue;
        }
        if(!matchesFilters(localTraits, ctx.listingFilters)) continue;
      }

      // Two-layer dedupe: in-memory first (the SAME store the REST poller
      // checks, in the same process) catches Stream-vs-poll races; this was
      // missing entirely, which is why every listing double-posted — Stream
      // only ever recorded itself in the new persistent table below, which
      // the REST poller has no knowledge of. Persistent second, for surviving
      // a restart.
      if(!dedupeChannelPost(channel.id, tokenId)) continue;
      const posted = await dedupeChannelPostPersistent(pgPool, channel.id, tokenId, 'listing');
      if(!posted) continue; // already posted (skip silently)

      const normalized = {
        asset: {
          token_id: tokenId,
          identifier: tokenId,
          name: event?.item?.metadata?.name || null,
          image_url: event?.item?.metadata?.image_url || null,
          traits: [],
        },
        criteria: {
          contract: { address: parsed.contract },
        },
        maker: event?.maker?.address || null,
        payment: {
          quantity: event?.base_price,
          decimals: event?.payment_token?.decimals ?? 18,
          symbol: event?.payment_token?.symbol,
        },
      };

      try{
        const embed = await buildListingEmbed(normalized, ctx);
        await sendEmbed(channel, embed);
        console.log(`[Stream][listing] #${tokenId} posted to ${slug} listings channel`);
      }catch(e){
        console.error('[Stream][listing post]', slug, tokenId, e.message);
      }
    }
  }catch(e){
    console.error('[Stream][item_listed handler]', slug, e.message);
  }
}

async function handleItemSold(slug, event){
  try{
    if(_rawLogCount.sold < RAW_PAYLOAD_LOG_LIMIT){
      _rawLogCount.sold++;
      console.log('[Stream][raw item_sold]', JSON.stringify(event));
    }

    const parsed = parseNftId(event?.item?.nft_id);
    if(!parsed || !parsed.tokenId) return;
    const tokenId = parsed.tokenId;

    for(const ctx of contextsForSlug(slug)){
      if(!ctx.channelId) continue;
      const channel = _client?.channels.cache.get(ctx.channelId);
      if(!channel) continue;

      // Sale filters mirror the listing ones — same local-trait-lookup
      // caveat applies (see fetchLocalTraitsForFilter above).
      if(ctx.salesFilters && Object.keys(ctx.salesFilters).length){
        const localTraits = await fetchLocalTraitsForFilter(tokenId, slug);
        if(localTraits === null){
          console.log(`[Stream][sale] #${tokenId} skipped — filters configured but no local trait data for ${slug}, leaving to REST poller`);
          continue;
        }
        if(!matchesFilters(localTraits, ctx.salesFilters)) continue;
      }

      if(!dedupeChannelPost(channel.id, tokenId)) continue;
      const posted = await dedupeChannelPostPersistent(pgPool, channel.id, tokenId, 'sale');
      if(!posted) continue;

      // buildSaleEmbed's timeSince() expects Unix seconds, but Stream's
      // event_timestamp is an ISO8601 string — passing it through unconverted
      // silently produced "NaNy ago" in the posted embed (NaN from
      // Date.now()/1000 - "2026-...Z", a string, not a number).
      const timestampSeconds = event?.event_timestamp
        ? Math.floor(new Date(event.event_timestamp).getTime() / 1000)
        : null;

      const normalized = {
        nft: {
          identifier: tokenId,
          name: event?.item?.metadata?.name || null,
          traits: [],
        },
        event_timestamp: timestampSeconds,
        buyer: event?.taker?.address || null,
        seller: event?.maker?.address || null,
        payment: {
          quantity: event?.sale_price,
          decimals: event?.payment_token?.decimals ?? 18,
          symbol: event?.payment_token?.symbol,
          token_address: event?.payment_token?.address,
        },
      };

      try{
        const embed = await buildSaleEmbed(normalized, ctx);
        await sendEmbed(channel, embed);
        console.log(`[Stream][sale] #${tokenId} posted to ${slug} sales channel`);
      }catch(e){
        console.error('[Stream][sale post]', slug, tokenId, e.message);
      }
    }
  }catch(e){
    console.error('[Stream][item_sold handler]', slug, e.message);
  }
}

function subscribeToSlug(slug){
  if(_subscriptions.has(slug) || !_stream) return;
  try{
    const unsubListed = _stream.onItemListed(slug, (event) => handleItemListed(slug, event?.payload || event));
    const unsubSold   = _stream.onItemSold(slug, (event) => handleItemSold(slug, event?.payload || event));
    _subscriptions.set(slug, { unsubListed, unsubSold });
    console.log(`[Stream] Subscribed to ${slug}`);
  }catch(e){
    console.error('[Stream][subscribe]', slug, e.message);
  }
}

function unsubscribeFromSlug(slug){
  const sub = _subscriptions.get(slug);
  if(!sub) return;
  try{ sub.unsubListed?.(); }catch(_){}
  try{ sub.unsubSold?.(); }catch(_){}
  _subscriptions.delete(slug);
  console.log(`[Stream] Unsubscribed from ${slug}`);
}

// Re-scan configured collections and subscribe to anything new (e.g. added
// via /config since startup or since the last scan). Does not require a
// bot restart to pick up a newly-added collection.
function rescanSubscriptions(){
  const currentSlugs = new Set();
  for(const [guildId, config] of getAllConfigs()){
    for(const ctx of buildPollContexts(guildId, config)){
      if(ctx.slug && !ctx.paused) currentSlugs.add(ctx.slug);
    }
  }
  for(const slug of currentSlugs) subscribeToSlug(slug);
  for(const slug of _subscriptions.keys()) if(!currentSlugs.has(slug)) unsubscribeFromSlug(slug);
}

// posted_market_events only needs to prevent duplicate posts across a
// restart shortly after the fact — trim anything older than 7 days so the
// table doesn't grow forever.
async function cleanupOldDedupeRows(){
  try{
    await pgPool.query(`DELETE FROM posted_market_events WHERE posted_at < NOW() - INTERVAL '7 days'`);
  }catch(e){
    console.error('[Stream][dedupe cleanup]', e.message);
  }
}

function initOpenSeaStream(discordClient){
  setDiscordClient(discordClient);

  if(!OPENSEA_KEY){
    console.log('[Stream] No OPENSEA_KEY set — Stream connector disabled, REST polling only');
    return;
  }

  _stream = new OpenSeaStreamClient({
    token: OPENSEA_KEY,
    connectOptions: {
      transport: WebSocket,
      sessionStorage: LocalStorage,
    },
  });

  rescanSubscriptions();
  setInterval(rescanSubscriptions, 5 * 60 * 1000);
  setInterval(cleanupOldDedupeRows, 24 * 60 * 60 * 1000);

  console.log('[Stream] OpenSea Stream connector started — REST polling continues running alongside it for now (safety net + not-yet-ported alert types)');
}

module.exports = { initOpenSeaStream, setDiscordClient };
