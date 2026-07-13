'use strict';

let _client = null;
function setClient(client){ _client = client; }

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
const { buildSaleEmbed, buildListingEmbed, osRankBadge, titleTokenId, traitObjectToArray, fetchTokenMetaFromDb } = require('./embeds');
const { sendEmbed, resolveImage } = require('./images');
const { matchesFilters, formatEth, shortAddr } = require('../utils/format');
const { realTraitCount } = require('./rpc');
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
  const tvUrl = id ? `https://traitview.com/?jump=${id}` : 'https://traitview.com/';
  const embed = new EmbedBuilder()
    .setTitle(`${titleTokenId(id)}${rankPart ? ' '+rankPart : ''}`)
    .setColor(getRankTierColor(osRank) ?? COLORS.OCAS_BG)
    .setURL(osUrl)
    .setFooter({ text: footerLabel || 'Trait Search' })
    .setTimestamp();

  const traits = dbMeta?.traits ? traitObjectToArray(dbMeta.traits) : [];
  const stats = [];
  if(realTraitCount(dbMeta?.traits) || dbMeta?.trait_count || token.trait_count) stats.push(`Traits: ${realTraitCount(dbMeta?.traits) || dbMeta?.trait_count || token.trait_count}`);
  if(stats.length) embed.addFields({ name:'Stats', value:stats.join('\n'), inline:false });

  if(traits.length){
    const traitLines = traitDisplayLines(traits, 12);
    const half = Math.ceil(traitLines.length / 2);
    embed.addFields(
      { name:'Traits', value:traitLines.slice(0, half).join('\n'), inline:true },
      { name:'\u200b', value:traitLines.slice(half).join('\n') || '\u200b', inline:true },
    );
  }
  embed.addFields({ name:'Links', value:`[OpenSea](${osUrl}) - [TraitView](${tvUrl})`, inline:false });
  try{ embed._imageResult = id ? await resolveImage({ identifier:id }, contract, chain) : null; }catch(_){}
  return embed;
}


// ── Build poll contexts from guild config (supports multi-collection) ─────────
function buildPollContexts(guildId, config){
  const contexts = [];
  // Primary collection (existing single-collection config)
  if(config.slug){
    contexts.push({
      guildId,
      slug:             config.slug,
      contract:         config.contract,
      channelId:        config.channelId,
      listingsChannelId:config.listingsChannelId,
      listingFilters:   config.listingFilters,
      salesFilters:     config.salesFilters || {},
      rankAlert:        config.rankAlert,
      paused:           config.paused,
      _key:             guildId, // keep original key for cursor backward compat
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
        listingFilters:   col.listingFilters || [],
        salesFilters:     col.salesFilters || {},
        rankAlert:        col.rankAlert || null,
        paused:           col.paused || false,
        _key:             guildId + ':col:' + col.slug,
      });
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
      ON CONFLICT (token_id, sale_ts, collection_slug) DO NOTHING
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
    for(const ctx of buildPollContexts(guildId, config)){
    if(!ctx.channelId||!ctx.slug||ctx.paused) continue;
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

    }catch(e){ console.error('[Poll sales]',guildId,e.message); sendErrorWebhook('Poll Sales Error', e, `guild=${guildId}`); }
    } // end ctx loop
  }
}


// ── Poll listings ─────────────────────────────────────────────────────────────
async function pollListings(){
  for(const [guildId,config] of getAllConfigs()){
    for(const ctx of buildPollContexts(guildId, config)){
    if(!ctx.listingsChannelId||!ctx.slug||ctx.paused) continue;
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

      const channel=_client.channels.cache.get(config.listingsChannelId);
      if(!channel) continue;

      console.log('['+config.slug+'] Posting '+newListings.length+' new listing(s)');

      const toPost=newListings.reverse();
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
      const slugsSeen = new Set([...buildPollContexts(guildId, config).map(c => c.slug).filter(Boolean)]);
      for(const slug of slugsSeen){
        const floorRes = await pgPool.query(
          `SELECT MIN(price_eth) AS floor_eth FROM listings WHERE collection_slug=$1`,
          [slug]
        ).catch(()=>null);
        const floorEth = floorRes?.rows[0]?.floor_eth ? parseFloat(floorRes.rows[0].floor_eth) : null;
        if(floorEth) await checkFloorAlerts(slug, floorEth, pgPool).catch(()=>{});
      }
    } catch(e){ console.warn('[Floor alert check]', e.message); }
  }
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
      if(alert.slug && alert.slug !== config.slug) continue;
      if(type==='sale'&&!alert.alertSales) continue;
      if(type==='listing'&&!alert.alertListings) continue;
      if(type==='listing' && (!alert.traitFilters || Object.keys(alert.traitFilters).length === 0)) continue;
      const traits=type==='sale'?(event.nft?.traits||[]):(event.asset?.traits||event.item?.traits||event.nft?.traits||[]);
      if(!matchesFilters(traits,alert.traitFilters)) continue;
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
      const embed=type==='sale'
        ? await buildSaleEmbed(event,config,false)
        : await buildListingEmbed(event,config,false);
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
  pollSales, pollListings, sendPersonalAlerts, setClient,
  traitGroupsLabel, buildTokenSearchEmbed,
  getAlert, setAlert, deleteAlert,
  loadAllAlerts, loadSaleCursors, loadListingCursors,
  saveSaleCursors, saveListingCursors,
  lastSaleIds, lastListingIds,
};







