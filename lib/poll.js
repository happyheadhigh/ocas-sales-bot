'use strict';

let _client = null;
function setClient(client){ _client = client; }

// jv: "the bot needs to recognize if a wallet has sold/bought or
// transferred an nft in or out of that wallet" -- for trait/role-gated
// channels, waiting for the once-daily bulk role sync (bot.js's
// runDailyTraitSync) means someone who just sold could keep gated access
// for up to 24 hours. syncTraitRoles itself lives in bot.js (it needs
// pgPool, getConfig, and several other bot.js-scoped helpers), so this is
// injected the same way setClient above already is, rather than trying
// to import bot.js from here or duplicate its logic.
let _syncTraitRolesFn = null;
function setSyncTraitRolesFn(fn){ _syncTraitRolesFn = fn; }

// jv raised a real scaling concern: could a re-sync per sale add up to a
// lot of API calls if many servers end up verifying wallets? syncTraitRoles
// itself makes one OpenSea call per configured collection per wallet, so a
// user who happens to sell/buy several times in quick succession (or is
// verified in multiple servers watching the same busy collection) could
// otherwise trigger several near-duplicate syncs back to back for no real
// benefit -- the first one already caught the change. This coalesces
// repeats within the window below into a single sync per (user, guild)
// rather than skipping the immediate sync altogether, so the actual
// problem (24h staleness) still gets fixed without the redundant cost.
const _recentRoleSyncs = new Map(); // "discordId:guildId" -> last sync timestamp
const ROLE_SYNC_DEBOUNCE_MS = 60 * 1000;
function _shouldSyncRolesNow(discordId, guildId){
  const key = `${discordId}:${guildId}`;
  const last = _recentRoleSyncs.get(key) || 0;
  const now = Date.now();
  if(now - last < ROLE_SYNC_DEBOUNCE_MS) return false;
  _recentRoleSyncs.set(key, now);
  // Bound memory growth -- an unbounded Map keyed by every user who's ever
  // triggered this would otherwise grow forever over the bot's lifetime.
  if(_recentRoleSyncs.size > 5000){
    const cutoff = now - ROLE_SYNC_DEBOUNCE_MS;
    for(const [k, ts] of _recentRoleSyncs) if(ts < cutoff) _recentRoleSyncs.delete(k);
  }
  return true;
}

const fetch = require('node-fetch');
const https  = require('https');

// ── Shared HTTPS agent for OpenSea API polling ────────────────────────────────
// Prevents Railway TCP proxy silent drops ('socket hang up') by sending
// keepalive probes every 10s and recycling sockets after 25 min.
const osAgent = new https.Agent({
  keepAlive:      true,
  keepAliveMsecs: 10_000,
  timeout:        25 * 60 * 1000,
  maxSockets:     16, // raised from 4 — 5 collections x 2 poll types (sales+listings)
                       // were queuing/competing for sockets, causing "Premature close"
                       // errors when requests waited too long for a free socket
});
const { EmbedBuilder } = require('discord.js');
const { COLORS, OPENSEA_KEY, osHeaders, getRailwayApiUrl, getRankTierColor } = require('./constants');
const { pgPool, getConfig, getUserAlerts, setUserAlerts, getAllConfigs, dbLoad, dbSave, recordSkippedListings } = require('./db');
const { sendErrorWebhook } = require('./error');
const { alertedEventIds, dedupeChannelPost } = require('./cache');
const { buildSaleEmbed, buildListingEmbed, osRankBadge, titleTokenId, traitObjectToArray, fetchTokenMetaFromDb, resolveOnChainImage } = require('./embeds');
const { sendEmbed, resolveImage, extractPngFromSvg } = require('./images');
const { matchesFilters, formatEth, formatListingEth, shortAddr, isDiscordOk, verifyImageIsRaster } = require('../utils/format');
const { checkArbitrageOpportunity, buildArbitrageEmbed } = require('./arbitrage');
const { realTraitCount, realWornTraitCount } = require('./rpc');
const { traitDisplayLines } = require('./burn-poller');

// ── Command search helpers ───────────────────────────────────────────────────
function traitGroupsLabel(groups, fallback){
  const parts = (groups || []).map(group => {
    const first = group && group[0];
    return first ? `${first.trait_name}: ${first.trait_value}` : null;
  }).filter(Boolean);
  return parts.length ? parts.join(' + ') : String(fallback || '').trim();
}

async function fetchBotApiJson(url, label){
  let r;
  try{
    r = await fetch(url);
  }catch(e){
    throw new Error(`${label} unavailable: ${e.message}`);
  }
  if(!r.ok){
    let detail = '';
    try{ detail = (await r.text()).slice(0, 180).replace(/\s+/g, ' ').trim(); }catch(_){}
    throw new Error(`${label} returned HTTP ${r.status}${detail ? ` (${detail})` : ''}`);
  }
  const j = await r.json();
  if(!j.ok) throw new Error(`${label} error: ${j.error || 'unknown error'}`);
  return j;
}

async function buildTokenSearchEmbed(token, config, footerLabel){
  const tokenId = token.token_id ?? token.id ?? token.identifier;
  const id = String(tokenId || '');
  const contract = config.contract || '';
  const chain = config.chain || 'ethereum';
  const slug = config.slug || '';
  const dbMeta = token._dbToken || (id ? await fetchTokenMetaFromDb(id, slug || undefined) : null);
  const osRank = dbMeta?.os_rank || token.os_rank || null;
  const rankPart = osRankBadge(osRank);
  const osUrl = id ? `https://opensea.io/assets/${chain}/${contract}/${id}` : `https://opensea.io/collection/${slug}`;
  // Same fix as embeds.js's buildSaleEmbed/buildListingEmbed -- needs
  // &collection= or it silently lands on the default (OCAS) collection.
  const tvUrl = id ? `https://traitview.com/?jump=${id}&collection=${slug}` : `https://traitview.com/?collection=${slug}`;
  const embed = new EmbedBuilder()
    .setTitle(`${titleTokenId(id)}${rankPart ? ' '+rankPart : ''}`)
    .setColor(getRankTierColor(osRank) ?? COLORS.OCAS_BG)
    .setURL(osUrl)
    .setFooter({ text: footerLabel || 'Trait Search' })
    .setTimestamp();

  const traits = dbMeta?.traits ? traitObjectToArray(dbMeta.traits) : [];
  const stats = [];
  // Same fix as embeds.js/images.js's fetchTokenMetaFromDb -- realTraitCount()
  // is the raw, uncorrected count; realWornTraitCount(slug, ...) applies the
  // per-collection exclusion (Bones/Palette/Print/Fate for Argonauts).
  const wornCount = realWornTraitCount(slug, dbMeta?.traits);
  if(wornCount || dbMeta?.trait_count || token.trait_count) stats.push(`Traits: ${wornCount || dbMeta?.trait_count || token.trait_count}`);
  if(stats.length) embed.addFields({ name:'Stats', value:stats.join('\n'), inline:false });

  // Same per-server toggle as buildSaleEmbed/buildListingEmbed — this
  // function is only ever used for /traitfind's plain token search, a
  // command result, so it always checks the "commands" context.
  const showTraits = config.embedShowTraits?.commands !== false;
  embed._imageLarge = !showTraits;

  if(showTraits && traits.length){
    const traitLines = traitDisplayLines(traits, 12);
    const half = Math.ceil(traitLines.length / 2);
    embed.addFields(
      { name:'Traits', value:traitLines.slice(0, half).join('\n'), inline:true },
      { name:'\u200b', value:traitLines.slice(half).join('\n') || '\u200b', inline:true },
    );
  }
  embed.addFields({ name:'Links', value:`[OpenSea](${osUrl}) - [TraitView](${tvUrl})`, inline:false });
  try{
    // Prefer whatever the backfill already fetched and cached in
    // tokens.image_url over a live gateway race — this was the same
    // architectural gap /token had (fixed earlier tonight): a live
    // multi-gateway race on EVERY single traitfind result for a
    // non-Ethereum collection, instead of the one DB read that already
    // has the real answer. Confirmed live via robinhood-chimps: /traitfind
    // token search showed no images at all while listings/sales (which
    // already read dbMeta.image_url via buildListingEmbed/buildSaleEmbed)
    // worked fine.
    let dbUrlIsRaster = false;
    if(dbMeta?.image_url && isDiscordOk(dbMeta.image_url)){
      dbUrlIsRaster = await verifyImageIsRaster(dbMeta.image_url);
    }
    if(dbUrlIsRaster){
      embed._imageResult = { type:'url', url: dbMeta.image_url };
    } else if(dbMeta?.image_url){
      // isDiscordOk alone isn't reliable — confirmed live that Alchemy's
      // own CDN can serve genuine SVG content through a URL with zero
      // textual indication of that. Render it directly rather than
      // falling through to a live race that would just find the same
      // non-raster URL again.
      let svgCacheImage = null;
      if(id && slug){
        const svgRes = await pgPool.query(
          `SELECT image_data FROM token_svg_cache WHERE token_id=$1 AND collection_slug=$2 LIMIT 1`,
          [id, slug]
        ).catch(() => ({ rows: [] }));
        const svgData = svgRes.rows[0]?.image_data || null;
        if(svgData){
          const buf = await extractPngFromSvg(svgData).catch(() => null);
          if(buf) svgCacheImage = { type:'buffer', buffer: buf, filename: `token-${id}.png` };
        }
      }
      if(!svgCacheImage){
        const buf = await extractPngFromSvg(dbMeta.image_url).catch(() => null);
        if(buf) svgCacheImage = { type:'buffer', buffer: buf, filename: `token-${id}.png` };
      }
      if(svgCacheImage){
        embed._imageResult = svgCacheImage;
      } else {
        const onChainImage = dbMeta?.chain ? await resolveOnChainImage(dbMeta.contract || contract, id, dbMeta.chain).catch(() => null) : null;
        embed._imageResult = onChainImage || (id ? await resolveImage({ identifier:id }, contract, chain) : null);
      }
    } else {
      const onChainImage = dbMeta?.chain ? await resolveOnChainImage(dbMeta.contract || contract, id, dbMeta.chain).catch(() => null) : null;
      embed._imageResult = onChainImage || (id ? await resolveImage({ identifier:id }, contract, chain) : null);
    }
  }catch(_){}
  return embed;
}


// ── Build poll contexts from guild config (supports multi-collection) ─────────
async function buildPollContexts(guildId, config){
  const contexts = [];
  // Primary collection (existing single-collection config)
  if(config.slug){
    contexts.push({
      guildId,
      slug:             config.slug,
      contract:         config.contract,
      channelId:        config.channelId,
      listingsChannelId:config.listingsChannelId,
      arbitrageChannelId:config.arbitrageChannelId,
      listingFilters:   config.listingFilters,
      salesFilters:     config.salesFilters || {},
      rankAlert:        config.rankAlert,
      paused:           config.paused,
      embedShowTraits:  config.embedShowTraits,
      _key:             guildId + ':col:' + config.slug, // scoped by slug like extras below — bare guildId meant a guild switching its primary collection inherited a stale cursor from whatever was there before, which never matches the new collection's real IDs and caused everything fetched to look "new"
    });
  }
  // Extra collections from /config multi-collection
  if(Array.isArray(config.collections)){
    for(const col of config.collections){
      if(!col.slug) continue;
      contexts.push({
        guildId,
        slug:             col.slug,
        contract:         col.contract,
        channelId:        col.salesChannel,
        listingsChannelId:col.listingsChannel,
        // arbitrageChannelId is guild-wide, not per-collection (same design
        // as embedShowTraits below) -- a single channel for arbitrage
        // alerts across every collection this server tracks, rather than a
        // separate one per collection. Copied from the top-level config
        // into every context, primary and extra alike.
        arbitrageChannelId:config.arbitrageChannelId,
        listingFilters:   col.listingFilters || [],
        salesFilters:     col.salesFilters || {},
        rankAlert:        col.rankAlert || null,
        paused:           col.paused || false,
        embedShowTraits:  config.embedShowTraits,
        _key:             guildId + ':col:' + col.slug,
      });
    }
  }

  // chain was never included here at all — config.chain was always
  // undefined for every context this function ever produced, meaning
  // buildSaleEmbed/buildListingEmbed's chain=config.chain||'ethereum'
  // silently defaulted to ethereum for every automatic alert, regardless
  // of a collection's real chain. This is the actual root cause of wrong
  // links on live sales/listings posts specifically — earlier fixes this
  // session touched other files, never this one. One batch query for every
  // slug found above, same pattern used elsewhere tonight.
  if(contexts.length && pgPool){
    try{
      const chainRes = await pgPool.query(
        `SELECT slug, chain FROM collections WHERE slug = ANY($1)`,
        [contexts.map(c => c.slug)]
      );
      const chainMap = {};
      for(const row of chainRes.rows) chainMap[row.slug] = row.chain;
      for(const c of contexts) c.chain = chainMap[c.slug] || 'ethereum';
    }catch(e){
      console.warn('[poll] buildPollContexts chain lookup failed (defaulting to ethereum):', e.message);
      for(const c of contexts) c.chain = 'ethereum';
    }
  }

  return contexts;
}

// ── Write newly-detected sales to the sales table ──────────────────────────────
// Mirrors sync-listings.js's syncSales() field mapping and ON CONFLICT shape
// exactly, so this near-real-time path and the periodic backstop sync are
// always compatible and never produce duplicate or conflicting rows.
const MAX_PLAUSIBLE_TOKEN_ID = 10_000_000;
const MAX_PLAUSIBLE_PRICE_ETH = 100_000;

async function writeSalesToDb(rawSales, slug){
  const rows = [];
  for(const ev of rawSales){
    const rawId = ev?.nft?.identifier || ev?.asset?.token_id;
    if(!rawId) continue;
    const token_id = parseInt(rawId, 10);
    if(isNaN(token_id) || token_id < 0 || token_id > MAX_PLAUSIBLE_TOKEN_ID) continue;

    const priceWei = ev?.payment?.quantity || ev?.total_price;
    if(!priceWei) continue;
    const price_eth = parseFloat(priceWei) / 1e18;
    if(isNaN(price_eth) || price_eth <= 0 || price_eth > MAX_PLAUSIBLE_PRICE_ETH) continue;

    const currency = ev?.payment?.symbol || 'ETH';
    const buyer  = ev?.buyer  || ev?.winner_account?.address || null;
    const seller = ev?.seller || ev?.from_account?.address   || null;
    const sale_ts = ev?.closing_date
      ? new Date(ev.closing_date * 1000).toISOString()
      : ev?.event_timestamp || new Date().toISOString();
    const tx_hash = ev?.transaction || null;

    rows.push({ token_id, price_eth, currency, buyer, seller, sale_ts, tx_hash });
  }
  if(!rows.length) return;

  const client = await pgPool.connect();
  try{
    await client.query('BEGIN');
    const vals = rows.map((_, j) =>
      `($${j*8+1},$${j*8+2},$${j*8+3},$${j*8+4},$${j*8+5},$${j*8+6},$${j*8+7},$${j*8+8})`
    ).join(', ');
    const params = rows.flatMap(s => [
      s.token_id, s.price_eth, s.currency, s.buyer, s.seller, s.sale_ts, s.tx_hash, slug
    ]);
    await client.query(`
      INSERT INTO sales (token_id, price_eth, currency, buyer, seller, sale_ts, tx_hash, collection_slug)
      VALUES ${vals}
      ON CONFLICT DO NOTHING
    `, params);
    await client.query('COMMIT');
    console.log(`[Poll sales][DB write] [${slug}] ✓ wrote ${rows.length} sale(s)`);
  }catch(e){
    await client.query('ROLLBACK');
    throw e;
  }finally{
    client.release();
  }
}

// ── Poll sales ────────────────────────────────────────────────────────────────
async function pollSales(){
  for(const [guildId,config] of getAllConfigs()){
    for(const ctx of await buildPollContexts(guildId, config)){
    // Same class of bug as pollListings' own guard, fixed the same way --
    // a personal sales DM alert needs no channel at all, so this must not
    // skip a context just because no public sales channel is configured.
    const hasPersonalSaleAlert = Object.values(_userAlerts).some(a =>
      a.alertSales && !a.paused && (!a.slug || a.slug === ctx.slug)
    );
    if((!ctx.channelId && !hasPersonalSaleAlert)||!ctx.slug||ctx.paused) continue;
    const config = ctx; // alias so rest of function works unchanged
    try{
      const lastId=lastSaleIds.get(ctx._key||guildId);
      const newSales=[];
      let cursor=null;
      let pages=0;
      const MAX_PAGES=5; // catch up on up to 500 missed sales

      // Paginate until we find the last seen sale or run out of pages
      outer: while(pages<MAX_PAGES){
        const qs=new URLSearchParams({event_type:'sale',limit:'100'});
        if(cursor) qs.set('next',cursor);
        const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(config.slug)}?${qs}`,{headers:osHeaders(), agent:osAgent});
        if(!r.ok) break;
        const j=await r.json();
        const sales=j.asset_events||[];
        if(!sales.length) break;

        // First run — just set cursor, don't post
        if(!lastId){
          lastSaleIds.set(ctx._key||guildId,String(sales[0].id||sales[0].event_timestamp));
          console.log('['+config.slug+'] Watching from sale '+lastSaleIds.get(guildId));
          break;
        }

        for(const s of sales){
          const sid=String(s.id||s.event_timestamp);
          if(sid===lastId) break outer; // caught up
          newSales.push(s);
        }

        cursor=j.next||null;
        if(!cursor) break;
        pages++;
      }

      if(!newSales.length) continue;
      lastSaleIds.set(ctx._key||guildId,String(newSales[0].id||newSales[0].event_timestamp));
      saveSaleCursors().catch(()=>{});

      // ── Write every detected sale to the sales table, regardless of any
      // per-guild alert filters below — filters control what gets POSTED to
      // Discord, not what gets RECORDED for search/commands. Same field
      // mapping and ON CONFLICT shape as sync-listings.js's syncSales(), so
      // this and the 15-min backstop sync can never produce conflicting rows.
      writeSalesToDb(newSales, config.slug).catch(e =>
        console.error('[Poll sales][DB write]', config.slug, e.message)
      );

      const channel=_client.channels.cache.get(config.channelId);
      if(!channel) continue;

      console.log('['+config.slug+'] Posting '+newSales.length+' new sale(s)');

      // Build all embeds — oldest first
      const toPost = newSales.reverse();

      // ── Sweep detection: count buyer+tx combos across this batch ─────────
      // WETH sales = accepted offers, not floor sweeps — exclude them entirely.
      const WETH_CONTRACT = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      const isWethSale = s => {
        const sym  = (s.payment?.symbol || s.currency || '').toUpperCase();
        const addr = (s.payment?.token_address || '').toLowerCase();
        return sym === 'WETH' || addr === WETH_CONTRACT;
      };
      const sweepCounts = new Map();
      for(const sale of toPost){
        if(isWethSale(sale)) continue; // accepted offers don't count as sweeps
        const buyer  = sale.buyer || '';
        const txHash = sale.transaction || sale.order_hash || sale.id || '';
        if(!buyer || buyer === 'unknown') continue;
        const key = txHash
          ? `${buyer}:${txHash}`
          : `${buyer}:${Math.floor((sale.event_timestamp||Date.now()/1000)/5)}`;
        sweepCounts.set(key, (sweepCounts.get(key)||0) + 1);
      }
      // Mark sweep sales before building embeds so 🧹 appears in title
      for(const sale of toPost){
        if(isWethSale(sale)) continue; // never mark WETH sales as sweeps
        const buyer  = sale.buyer || '';
        const txHash = sale.transaction || sale.order_hash || sale.id || '';
        const key    = txHash
          ? `${buyer}:${txHash}`
          : `${buyer}:${Math.floor((sale.event_timestamp||Date.now()/1000)/5)}`;
        if((sweepCounts.get(key)||0) >= 5) sale._isSweep = true;
      }

      // ── Build embeds (image fetching runs in parallel) ────────────────────
      const filteredSales = toPost.filter(sale => matchesFilters(sale.nft?.traits, config.salesFilters));
      const builtEmbeds   = await Promise.all(
        filteredSales.map(sale => buildSaleEmbed(sale, config).catch(e => { console.error('[Build sale]', e.message); return null; }))
      );

      // ── Post embeds, fire sweep summary after last sweep token ────────────
      const sweepPosted = new Set();
      for(let i = 0; i < builtEmbeds.length; i++){
        const embed = builtEmbeds[i];
        const sale  = filteredSales[i];
        if(!embed) continue;
        try{ await sendEmbed(channel, embed); }catch(e){ console.error('[Sale post]', e.message); }
        await new Promise(r => setTimeout(r, 300));

        if(sale._isSweep){
          const buyer  = sale.buyer || '';
          const txHash = sale.transaction || sale.order_hash || sale.id || '';
          const key    = txHash
            ? `${buyer}:${txHash}`
            : `${buyer}:${Math.floor((sale.event_timestamp||Date.now()/1000)/5)}`;
          const sweepSales    = filteredSales.filter(s => s._isSweep && s.buyer === buyer &&
            (s.transaction||s.order_hash||s.id||'') === txHash);
          const lastSweepSale = sweepSales[sweepSales.length - 1];
          if(sale === lastSweepSale && !sweepPosted.has(key)){
            sweepPosted.add(key);
            await fireSweepAlert({ sales: sweepSales, config }, channel);
          }
        }
      }

      // Personal DM alerts
      for(const sale of toPost) await sendPersonalAlerts(sale, 'sale', config);

      // jv: real-time role accuracy for trait/role-gated channels -- a
      // sale changes ownership immediately, so anyone verified as the
      // buyer or seller gets their roles re-synced right now rather than
      // waiting for the once-daily bulk sync (which could otherwise leave
      // someone who just sold keeping gated access for up to 24h, or
      // someone who just bought waiting that long to gain it).
      if(_syncTraitRolesFn && pgPool){
        const involvedWallets = [...new Set(
          toPost.flatMap(s => [s.buyer, s.seller]).filter(Boolean).map(w => String(w).toLowerCase())
        )];
        if(involvedWallets.length){
          try{
            const affected = await pgPool.query(
              `SELECT discord_id, array_agg(wallet) AS wallets
               FROM linked_wallets
               WHERE guild_id=$1 AND verified=true AND wallet = ANY($2::text[])
               GROUP BY discord_id`,
              [guildId, involvedWallets]
            );
            const guildObj = _client?.guilds?.cache?.get(guildId);
            if(guildObj){
              for(const row of affected.rows){
                if(!_shouldSyncRolesNow(row.discord_id, guildId)) continue;
                _syncTraitRolesFn(guildObj, row.discord_id, row.wallets).catch(e =>
                  console.warn('[Poll sales] Immediate role re-sync failed for', row.discord_id, ':', e.message)
                );
              }
            }
          }catch(e){
            console.warn('[Poll sales] Immediate role re-sync lookup failed:', e.message);
          }
        }
      }

    }catch(e){ console.error('[Poll sales]',guildId,e.message); sendErrorWebhook('Poll Sales Error', e, `guild=${guildId}`); }
    } // end ctx loop
  }
}


// ── Poll listings ─────────────────────────────────────────────────────────────
async function pollListings(){
  // jv confirmed live with actual timestamped evidence (an OpenSea
  // listing shown "5m ago" vs. the DM alert's own send time, ~2-3
  // minutes apart) -- POLL_MS itself defaults to 30 seconds, nowhere
  // near enough on its own to explain a multi-minute delay. This is a
  // multi-tenant platform (TV Bot) where this same loop processes every
  // configured guild/collection sequentially within one invocation
  // before the next setInterval tick even starts -- if that full pass
  // takes long enough (OpenSea calls per guild, pagination, rate-limit
  // retries), a collection processed late in the loop could see a real
  // multi-minute delay despite the nominal 30s interval, without any
  // single step being individually broken. Logging overall cycle time
  // and per-guild time here to see where it's actually going, rather
  // than guessing which of several plausible contributors it is.
  const _cycleStart = Date.now();
  let _guildCount = 0;
  for(const [guildId,config] of getAllConfigs()){
    const _guildStart = Date.now();
    _guildCount++;
    for(const ctx of await buildPollContexts(guildId, config)){
    // jv confirmed live: still not getting DM alerts for a listing alert
    // (Cloak = Ivory OR Death, argonauts) even after the earlier
    // case-sensitivity fix to matchesFilters. Root cause, found by
    // reading the actual deployment logs jv shared -- no [DM alert debug]
    // output anywhere, meaning the check inside sendPersonalAlerts never
    // even ran. Traced upstream to this guard: it used to skip this
    // entire context -- including the personal-alert check further down,
    // which is a DM and needs no channel at all -- whenever a server
    // hadn't configured a public listings or arbitrage channel. A user
    // can set up a personal listing alert without ever configuring
    // either channel, and this guard silently threw the whole poll away
    // before ever reaching their alert, with no error or log to explain
    // why. Now also checks whether ANY user has an active (non-paused)
    // listing alert scoped to this slug (or scoped to no slug at all,
    // meaning "every collection") before deciding there's truly nothing
    // to do here.
    const hasPersonalListingAlert = Object.values(_userAlerts).some(a =>
      a.alertListings && !a.paused && (!a.slug || a.slug === ctx.slug)
    );
    if((!ctx.listingsChannelId && !ctx.arbitrageChannelId && !hasPersonalListingAlert)||!ctx.slug||ctx.paused) continue;
    const config = ctx; // alias so rest of function works unchanged
    try{
      const lastId=lastListingIds.get(ctx._key||guildId);
      const newListings=[];
      let cursor=null;
      let pages=0;
      const MAX_PAGES=5;

      outer: while(pages<MAX_PAGES){
        const qs=new URLSearchParams({event_type:'listing',limit:'100'});
        if(cursor) qs.set('next',cursor);
        const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(config.slug)}?${qs}`,{headers:osHeaders(), agent:osAgent});
        if(!r.ok) break;
        const j=await r.json();
        const listings=j.asset_events||[];
        if(!listings.length) break;

        if(!lastId){
          lastListingIds.set(ctx._key||guildId,String(listings[0].id||listings[0].event_timestamp));
          break;
        }

        for(const l of listings){
          const lid=String(l.id||l.event_timestamp);
          if(lid===lastId) break outer;
          newListings.push(l);
        }

        cursor=j.next||null;
        if(!cursor) break;
        pages++;
      }

      if(!newListings.length) continue;
      lastListingIds.set(ctx._key||guildId,String(newListings[0].id||newListings[0].event_timestamp));
      saveListingCursors().catch(()=>{});

      // If more than 50 new listings detected, the bot just restarted and is
      // catching up on stale listings. Skip posting to avoid a Sharp memory spike.
      // Reset cursor to the very latest listing so next poll only sees new ones.
      if(newListings.length > 50){
        const latestId = String(newListings[0].id || newListings[0].event_timestamp);
        lastListingIds.set(ctx._key||guildId, latestId);
        await saveListingCursors().catch(()=>{});
        console.log('['+config.slug+'] Skipping '+newListings.length+' stale listings on startup (cursor reset to '+latestId+')');
        // Persist which listings were dropped — same token-id extraction used
        // when actually posting, so the two paths can never disagree on shape.
        const skippedTokenIds = newListings.map(l =>
          String(l?.asset?.token_id || l?.asset?.identifier || l?.criteria?.encoded_token_ids || l?.token_id || '')
        ).filter(Boolean);
        recordSkippedListings({
          guildId, slug: config.slug, tokenIds: skippedTokenIds, resetCursorTo: latestId,
        }).catch(()=>{});
        break; // break out of guild loop entirely, don't process more configs
      }

      const listingsChannel   = ctx.listingsChannelId   ? _client.channels.cache.get(ctx.listingsChannelId)   : null;
      const arbitrageChannel  = ctx.arbitrageChannelId  ? _client.channels.cache.get(ctx.arbitrageChannelId)  : null;
      // jv confirmed live (still no DMs after the first guard fix): this
      // exact same bug existed a second time in this same function, just
      // further down. Fixing the entry guard let execution reach this
      // point, but this guard independently `continue`d past everything
      // below it -- including sendPersonalAlerts, at the very bottom of
      // this function -- whenever neither channel existed, with no
      // knowledge of hasPersonalListingAlert (computed above, still in
      // scope here).
      if(!listingsChannel && !arbitrageChannel && !hasPersonalListingAlert) continue; // nothing configured to actually post to and no personal alert waiting either

      const toPost=newListings.reverse();

      // Arbitrage check — deliberately runs over every new listing
      // regardless of whether a regular Listings channel is even configured
      // or a listing passes listingFilters. Confirmed live: those filters
      // exist specifically to reduce the regular listings feed's volume
      // (the exact reason a server might not have that channel set at all)
      // and shouldn't also silently suppress arbitrage alerts, which are a
      // deliberately independent feature -- a server can now enable
      // arbitrage alerts on their own without turning on the full listings
      // feed at all.
      if(arbitrageChannel){
        for(const lid of toPost){
          const tokenId=String(lid?.asset?.token_id||lid?.asset?.identifier||lid?.criteria?.encoded_token_ids||lid?.token_id||'');
          if(!tokenId) continue;
          const listingPriceEth = formatListingEth(lid);
          if(!listingPriceEth) continue;
          // Fire-and-forget — never blocks or slows down the regular
          // listing posting loop below, and a failure here never affects
          // the listing alert itself.
          checkArbitrageOpportunity(config.slug, tokenId, parseFloat(listingPriceEth))
            .then(async (result) => {
              if(!result) return;
              const arbEmbed = buildArbitrageEmbed({ ...result, contract: config.contract, chain: config.chain || 'ethereum', name: lid?.asset?.name });
              await sendEmbed(arbitrageChannel, arbEmbed).catch(e => console.error('[Arbitrage post]', e.message));
            })
            .catch(e => console.error(`[Arbitrage check] ${config.slug}#${tokenId}:`, e.message));
        }
      }

      // jv confirmed live: same class of bug as the guard fixed just
      // above, a third time in this same function -- this used to
      // `continue` (skipping the rank-alert and sendPersonalAlerts logic
      // further below too) whenever no regular listings channel was
      // configured, even if an arbitrage channel or a personal alert
      // still needed everything past this point to run. Restructured as
      // a positive condition instead of an early exit, specifically so
      // nothing added after this block in the future can be silently
      // skipped by it again the way sendPersonalAlerts already was twice.
      if(listingsChannel){
      const channel = listingsChannel;

      console.log('['+config.slug+'] Posting '+newListings.length+' new listing(s)');

      const toPostListings = toPost.filter(l=>matchesFilters((l.asset&&l.asset.traits)||[],config.listingFilters));
      // Build embeds in batches of 10 to avoid concurrent Sharp memory spikes
      const EMBED_BATCH = 10;
      const embeds = [];
      for(let b = 0; b < toPostListings.length; b += EMBED_BATCH){
        const batch = toPostListings.slice(b, b + EMBED_BATCH);
        const results = await Promise.all(
          batch.map(l => buildListingEmbed(l, config).catch(e => { console.error('[Build listing]', e.message); return null; }))
        );
        embeds.push(...results);
        if(b + EMBED_BATCH < toPostListings.length) await new Promise(r => setTimeout(r, 200));
      }

      for(let i=0;i<embeds.length;i++){
        const embed=embeds[i]; if(!embed) continue;
        const lid=toPostListings[i]; const tokenId=String(lid?.asset?.token_id||lid?.asset?.identifier||lid?.criteria?.encoded_token_ids||lid?.token_id||'');
        if(tokenId && !dedupeChannelPost(channel.id, tokenId)) { console.log('[Listing dedup] skipping #'+tokenId+' already posted to channel'); continue; }
        try{ await sendEmbed(channel,embed); }catch(e){ console.error('[Listing post]',e.message); }
        await new Promise(r=>setTimeout(r,300));
      }
      } // end if(listingsChannel)

      // ── OS Rank listing alert ─────────────────────────────────────────────
      // Rank alerts intentionally check ALL new listings, not just the ones that
      // passed trait listing filters. Bot uses OS rank only.
      const rankAlertCfg = config.rankAlert;
      if(rankAlertCfg?.min && rankAlertCfg?.max){
        const RAILWAY_URL = getRailwayApiUrl();
        if(RAILWAY_URL){
          for(const listing of toPost){
            const id = parseInt(
              (listing.asset?.token_id) ||
              (listing.asset?.identifier) ||
              (listing.criteria?.encoded_token_ids) ||
              (listing.nft?.identifier) || 0
            );
            if(!id) continue;
            try{
              const dbMeta = await fetchTokenMetaFromDb(id, config.slug);
              const osRank = dbMeta?.os_rank;
              if(!osRank) continue;
              if(osRank >= rankAlertCfg.min && osRank <= rankAlertCfg.max){
                const alertChannel = _client.channels.cache.get(
                  rankAlertCfg.channelId || config.listingsChannelId || config.channelId
                );
                if(!alertChannel) continue;
                const alertEmbed = await buildListingEmbed(
                  { ...listing, _dbToken: dbMeta },
                  { ...config, _rankAlert: true }
                );
                if(!dedupeChannelPost(alertChannel.id, String(id))){
                  console.log(`[Rank Alert] #${id} deduped — already posted to channel recently`);
                } else {
                  try{ await sendEmbed(alertChannel, alertEmbed); }
                  catch(e){ console.error('[Rank alert post]', e.message); }
                  console.log(`[Rank Alert] #${id} OS Rank #${osRank} listed`);
                }
              }
            }catch(e){ console.warn('[Rank alert]', e.message); }
          }
        }
      }

      for(const l of toPost) await sendPersonalAlerts(l,'listing',config);

      // ── Price alerts — check new listings against user thresholds ───────────
      if(pgPool) await checkPriceAlerts(toPost, config.slug, pgPool).catch(()=>{});

    }catch(e){ console.error('[Poll listings]',guildId,e.message); sendErrorWebhook('Poll Listings Error', e, `guild=${guildId}`); }
    } // end ctx loop

    // ── Floor alerts — check current floor per slug ──────────────────────────
    try {
      const slugsSeen = new Set([...(await buildPollContexts(guildId, config)).map(c => c.slug).filter(Boolean)]);
      for(const slug of slugsSeen){
        const floorRes = await pgPool.query(
          `SELECT MIN(price_eth) AS floor_eth FROM listings WHERE collection_slug=$1`,
          [slug]
        ).catch(()=>null);
        const floorEth = floorRes?.rows[0]?.floor_eth ? parseFloat(floorRes.rows[0].floor_eth) : null;
        if(floorEth) await checkFloorAlerts(slug, floorEth, pgPool).catch(()=>{});
      }
    } catch(e){ console.warn('[Floor alert check]', e.message); }
    const _guildElapsed = Date.now() - _guildStart;
    if(_guildElapsed > 2000) console.log(`[PollTiming] guild=${guildId} slug=${config.slug||'?'} took ${_guildElapsed}ms`);
  }
  const _cycleElapsed = Date.now() - _cycleStart;
  console.log(`[PollTiming] Full pollListings cycle: ${_guildCount} guild(s), ${_cycleElapsed}ms total`);
}

// ── Price & floor alert checks ───────────────────────────────────────────────
async function checkPriceAlerts(newListings, slug, pool){
  if(!newListings.length || !pool) return;
  try {
    const tokenIds = newListings.map(l => parseInt(
      l.asset?.token_id || l.asset?.identifier || l.nft?.identifier || 0
    )).filter(Boolean);
    if(!tokenIds.length) return;

    // Fetch all price alerts for tokens in this batch
    const res = await pool.query(
      `SELECT * FROM user_price_alerts WHERE slug=$1 AND token_id = ANY($2) AND is_active=true AND (triggered_at IS NULL OR repeat_alert=true)`,
      [slug, tokenIds]
    );
    if(!res.rows.length) return;

    for(const alert of res.rows){
      // Find the listing for this token
      const listing = newListings.find(l => {
        const lid = parseInt(l.asset?.token_id || l.asset?.identifier || l.nft?.identifier || 0);
        return lid === alert.token_id;
      });
      if(!listing) continue;

      const priceEth = parseFloat(listing.payment?.quantity || 0) / 1e18;
      if(priceEth > parseFloat(alert.threshold_eth)) continue;

      // Trigger — send DM
      try {
        const user = await _client.users.fetch(alert.discord_id).catch(()=>null);
        if(!user) continue;
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        const embed = new EmbedBuilder()
          .setTitle(`🔔 Price Alert — #${alert.token_id}`)
          .setColor(0x57F287)
          .setDescription([
            `**${slug}** token **#${alert.token_id}** is listed at **Ξ ${priceEth.toFixed(4)}**`,
            `Your threshold: **Ξ ${parseFloat(alert.threshold_eth).toFixed(4)}**`,
            listing.asset?.permalink ? `\n[View on OpenSea](${listing.asset.permalink})` : '',
          ].join('\n'))
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`pa_pause:${alert.id}`).setLabel('⏸️ Pause').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`pa_stop:${alert.id}`).setLabel('🗑️ Stop').setStyle(ButtonStyle.Danger),
        );
        await user.send({ embeds: [embed], components: [row] }).catch(()=>{});

        // Mark triggered if alert_once
        if(alert.alert_once){
          await pool.query(
            `UPDATE user_price_alerts SET triggered_at=NOW() WHERE id=$1`,
            [alert.id]
          ).catch(()=>{});
        }
        console.log(`[Price Alert] Sent to ${alert.discord_id} for #${alert.token_id} at Ξ${priceEth.toFixed(4)}`);
      } catch(e){ console.warn('[Price Alert DM]', e.message); }
    }
  } catch(e){ console.warn('[checkPriceAlerts]', e.message); }
}

async function checkFloorAlerts(slug, floorEth, pool){
  if(!pool || !floorEth) return;
  try {
    // Fetch all alerts for this slug that are past their repeat interval,
    // then filter by direction in JS (avoids complex SQL branching).
    const res = await pool.query(
      `SELECT * FROM user_floor_alerts
       WHERE slug=$1
       AND is_active = true
       AND (last_alerted_at IS NULL OR last_alerted_at < NOW() - (cooldown_minutes || ' minutes')::interval)`,
      [slug]
    );
    if(!res.rows.length) return;

    const { EmbedBuilder } = require('discord.js');
    for(const alert of res.rows){
      try {
        const threshold = parseFloat(alert.threshold_eth);
        const direction = alert.direction || 'below';
        const triggered =
          (direction === 'below'  && floorEth <= threshold) ||
          (direction === 'above'  && floorEth >= threshold) ||
          (direction === 'either' && (floorEth <= threshold || floorEth >= threshold));
        if(!triggered) continue;

        const user = await _client.users.fetch(alert.discord_id).catch(()=>null);
        if(!user) continue;

        const isAbove = floorEth >= threshold && direction !== 'below';
        const embed = new EmbedBuilder()
          .setTitle(`${isAbove ? '📈' : '📉'} Floor Alert — ${slug}`)
          .setColor(isAbove ? 0x57F287 : 0xED4245)
          .setDescription([
            `The floor for **${slug}** has ${isAbove ? 'risen to' : 'dropped to'} **Ξ ${parseFloat(floorEth).toFixed(4)}**`,
            `Your threshold: **Ξ ${threshold.toFixed(4)}** (${direction})`,
          ].join('\n'))
          .setTimestamp();
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`fa_pause:${alert.id}`).setLabel('⏸️ Pause').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`fa_stop:${alert.id}`).setLabel('🗑️ Stop').setStyle(ButtonStyle.Danger),
        );
        await user.send({ embeds: [embed], components: [row] }).catch(()=>{});
        await pool.query(
          `UPDATE user_floor_alerts SET last_alerted_at=NOW() WHERE id=$1`,
          [alert.id]
        ).catch(()=>{});
        console.log(`[Floor Alert] Sent to ${alert.discord_id} for ${slug} at Ξ${parseFloat(floorEth).toFixed(4)} (${direction})`);
      } catch(e){ console.warn('[Floor Alert DM]', e.message); }
    }
  } catch(e){ console.warn('[checkFloorAlerts]', e.message); }
}

// ── Personal DM alerts ────────────────────────────────────────────────────────
async function sendPersonalAlerts(event, type, config){
  // Dedup: same event can come through multiple guild configs — only DM once per event
  const eventKey = `placeholder:${type}:${event.id||event.event_timestamp}`;
  for(const [userId, alert] of Object.entries(_userAlerts)){
    try{
      if(alert.paused) continue;
      if(alert.slug && alert.slug !== config.slug){
        if(type==='listing' && alert.alertListings) console.log(`[DM alert debug] user=${userId} skipped: alert.slug=${alert.slug} !== config.slug=${config.slug}`);
        continue;
      }
      if(type==='sale'&&!alert.alertSales) continue;
      if(type==='listing'&&!alert.alertListings) continue;
      // jv: "Does the bot support personal alerts for specific token #'s?
      // Or just traits?" -- it only supported traits until now. tokenIds
      // (a new, optional array on the alert object -- absent/empty for
      // every existing alert, so nothing already saved changes behavior)
      // lets a user watch one or more specific token IDs directly,
      // independent of trait filters. Checked before the trait-filter
      // requirement below, since a token-ID watch has no reason to also
      // require trait filters to be configured.
      const eventTokenId = type==='sale'
        ? parseInt(event.nft?.identifier ?? event.asset?.token_id ?? event.asset?.identifier)
        : parseInt(event.asset?.token_id ?? event.asset?.identifier ?? event.nft?.identifier);
      const tokenIdMatch = Array.isArray(alert.tokenIds) && alert.tokenIds.length > 0
        && Number.isFinite(eventTokenId) && alert.tokenIds.includes(eventTokenId);
      if(tokenIdMatch){
        // Falls through to the send logic below, skipping the trait-filter
        // requirement/check entirely -- a specific-token watch is its own
        // independent match condition, not an alternate way to satisfy a
        // trait filter.
      } else {
        const traits=type==='sale'?(event.nft?.traits||[]):(event.asset?.traits||event.item?.traits||event.nft?.traits||[]);
        // jv: "is there any way to set personal alerts for trait counts".
        // traitCountFilters (a new, optional array of exact integers on
        // the alert object -- absent/empty for every existing alert, so
        // nothing already saved changes behavior) works the same
        // independent-condition way tokenIds does above: watching "any
        // token with exactly N traits" has no reason to also require a
        // trait name/value filter to be configured. traits.length is the
        // event's own raw trait count straight from OpenSea's payload --
        // exactly what a trait-count alert means to match, no separate
        // DB lookup needed.
        const traitCountMatch = Array.isArray(alert.traitCountFilters) && alert.traitCountFilters.length > 0
          && alert.traitCountFilters.includes(traits.length);
        if(traitCountMatch){
          // Falls through the same way tokenIdMatch does above.
        } else {
          if(type==='listing' && (!alert.traitFilters || Object.keys(alert.traitFilters).length === 0)) continue;
          const traitMatch = matchesFilters(traits,alert.traitFilters);
          if(type==='listing') console.log(`[DM alert debug] user=${userId} slug=${config.slug} traitFilters=${JSON.stringify(alert.traitFilters)} traitsSeen=${JSON.stringify(traits)} match=${traitMatch}`);
          if(!traitMatch) continue;
        }
      }
      // Skip if already sent this event to this user
      const dedupKey = `${userId}:${type}:${event.id||event.event_timestamp}`;
      if(alertedEventIds.has(dedupKey)) continue;
      alertedEventIds.add(dedupKey);
      // Keep set from growing forever — trim oldest 500 when over 5000
      if(alertedEventIds.size > 5000){
        const toDelete = [...alertedEventIds].slice(0, 500);
        for(const k of toDelete) alertedEventIds.delete(k);
      }
      const user=await _client.users.fetch(userId).catch(()=>null);
      if(!user) continue;
      // Third positional arg used to be a stale, unused `false` (buildSaleEmbed/
      // buildListingEmbed only took 2 params at the time) -- now repurposed as
      // the trait-visibility context. This is a personal, automatic DM alert,
      // not a one-off command result, so it uses the same context as the
      // matching auto-alert (sales/listings), not "commands".
      const embed=type==='sale'
        ? await buildSaleEmbed(event,config)
        : await buildListingEmbed(event,config);
      embed.setFooter({text:`Your personal alert - ${config.slug}`});
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      embed._components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ta_pause').setLabel('⏸️ Pause').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ta_stop').setLabel('🗑️ Stop').setStyle(ButtonStyle.Danger),
      )];
      await sendEmbed(user,embed);
    }catch(e){ console.warn('[DM alert]',userId,e.message); }
  }
}

// ── Slash commands ────────────────────────────────────────────────────────────


// ── User alert helpers ────────────────────────────────────────────────────────
const _userAlerts = {};

function getAlert(userId){ return _userAlerts[userId] || null; }

function setAlert(userId, updates){
  _userAlerts[userId] = { ...(_userAlerts[userId] || {}), ...updates };
  dbSave('user_alerts', _userAlerts).catch(()=>{});
}

function deleteAlert(userId){
  delete _userAlerts[userId];
  dbSave('user_alerts', _userAlerts).catch(()=>{});
}

async function loadAllAlerts(){
  const db = await dbLoad('user_alerts');
  if(db) Object.assign(_userAlerts, db);
}

// ── Cursor persistence ────────────────────────────────────────────────────────
const lastSaleIds    = new Map();
const lastListingIds = new Map();

async function loadSaleCursors(){
  const db = await dbLoad('sale_cursors');
  if(db){ for(const [k,v] of Object.entries(db)) lastSaleIds.set(k,v); }
}

async function loadListingCursors(){
  const db = await dbLoad('listing_cursors');
  if(db){ for(const [k,v] of Object.entries(db)) lastListingIds.set(k,v); }
}

async function saveSaleCursors(){
  await dbSave('sale_cursors', Object.fromEntries(lastSaleIds));
}

async function saveListingCursors(){
  await dbSave('listing_cursors', Object.fromEntries(lastListingIds));
}

// ── Cursor reset on channel (re)configuration ─────────────────────────────────
// Confirmed live: setting a sales/listings channel for a collection that had
// one configured at some earlier point (even briefly, even if later cleared)
// resumes from whatever cursor position was last saved — not from "now" —
// and dumps every sale/listing that happened in the gap as if it were brand
// new. The cursor persists independently of channel configuration, so
// toggling a channel off and back on doesn't reset it. These are called
// whenever a channel gets (re-)set via /setup or /config, so the very next
// poll cycle always starts fresh from "now" (the existing "first run — just
// set cursor, don't post" logic already handles that silently and safely).
function resetSaleCursor(guildId, slug){
  const key = guildId + ':col:' + slug;
  if(lastSaleIds.delete(key)) saveSaleCursors().catch(()=>{});
}
function resetListingCursor(guildId, slug){
  const key = guildId + ':col:' + slug;
  if(lastListingIds.delete(key)) saveListingCursors().catch(()=>{});
}



// ── Sweep summary alert ───────────────────────────────────────────────────────
async function fireSweepAlert({ sales: sweepSales, config }, channel) {
  const buyer = sweepSales[0].buyer || 'unknown';
  const count = sweepSales.length;
  const total = sweepSales.reduce((sum, s) => sum + (parseFloat(formatEth(s)) || 0), 0);
  const avg   = total / count;

  const fmt = n => (n != null && n > 0) ? (n >= 1 ? n.toFixed(3) : n.toFixed(4)) : '—';
  const buyerLink = buyer !== 'unknown'
    ? `[${shortAddr(buyer)}](https://opensea.io/${buyer})`
    : 'unknown';

  const embed = new EmbedBuilder()
    .setTitle('🧹 Sweep Alert')
    .setColor(0xf59e0b)
    .addFields(
      { name: 'Buyer',       value: buyerLink,           inline: true },
      { name: 'Swept',       value: `${count} tokens`,   inline: true },
      { name: '\u200b',     value: '\u200b',            inline: true },
      { name: 'Total Spent', value: `${fmt(total)} ETH`, inline: true },
      { name: 'Avg Buy',     value: `${fmt(avg)} ETH`,   inline: true },
    )
    .setFooter({ text: `Sales Bot · ${config.slug}` })
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
    console.log(`[Sweep] ${count} tokens by ${shortAddr(buyer)} in ${config.slug}`);
  } catch(e) {
    console.error('[Sweep alert post]', e.message);
  }
}

module.exports = {
  pollSales, pollListings, sendPersonalAlerts, setClient, setSyncTraitRolesFn,
  shouldSyncRolesNow: _shouldSyncRolesNow,
  traitGroupsLabel, buildTokenSearchEmbed,
  getAlert, setAlert, deleteAlert,
  loadAllAlerts, loadSaleCursors, loadListingCursors,
  saveSaleCursors, saveListingCursors,
  resetSaleCursor, resetListingCursor,
  lastSaleIds, lastListingIds,
};







