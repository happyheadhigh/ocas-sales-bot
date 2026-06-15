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
  maxSockets:     4,
});
const { EmbedBuilder } = require('discord.js');
const { COLORS, OPENSEA_KEY, osHeaders, getRailwayApiUrl, getRankTierColor } = require('./constants');
const { pgPool, getConfig, getUserAlerts, setUserAlerts, getAllConfigs, dbLoad, dbSave } = require('./db');
const { sendErrorWebhook } = require('./error');
const { alertedEventIds, dedupeChannelPost } = require('./cache');
const { buildSaleEmbed, buildListingEmbed, osRankBadge, titleTokenId, traitObjectToArray, fetchTokenMetaFromDb } = require('./embeds');
const { sendEmbed, resolveImage } = require('./images');
const { matchesFilters } = require('../utils/format');
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
  const dbMeta = token._dbToken || (id ? await fetchTokenMetaFromDb(id) : null);
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
  if(osRank) stats.push(`OS Rank: ${Number(osRank).toLocaleString()}`);
  if(token.obs_rank) stats.push(`TraitView Rank: ${Number(token.obs_rank).toLocaleString()}`);
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

// ── Poll sales ────────────────────────────────────────────────────────────────
async function pollSales(){
  for(const [guildId,config] of getAllConfigs()){
    if(!config.channelId||!config.slug||config.paused) continue;
    try{
      const lastId=lastSaleIds.get(guildId);
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
          lastSaleIds.set(guildId,String(sales[0].id||sales[0].event_timestamp));
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
      lastSaleIds.set(guildId,String(newSales[0].id||newSales[0].event_timestamp));
      saveSaleCursors().catch(()=>{});

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
  }
}

// ── Poll listings ─────────────────────────────────────────────────────────────
async function pollListings(){
  for(const [guildId,config] of getAllConfigs()){
    if(!config.listingsChannelId||!config.slug||config.paused) continue;
    try{
      const lastId=lastListingIds.get(guildId);
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
          lastListingIds.set(guildId,String(listings[0].id||listings[0].event_timestamp));
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
      lastListingIds.set(guildId,String(newListings[0].id||newListings[0].event_timestamp));
      saveListingCursors().catch(()=>{});

      const channel=_client.channels.cache.get(config.listingsChannelId);
      if(!channel) continue;

      console.log('['+config.slug+'] Posting '+newListings.length+' new listing(s)');

      const toPost=newListings.reverse();
      const toPostListings = toPost.filter(l=>matchesFilters((l.asset&&l.asset.traits)||[],config.listingFilters));
      const embeds=await Promise.all(
        toPostListings
          .map(l=>buildListingEmbed(l,config).catch(e=>{console.error('[Build listing]',e.message);return null;}))
      );

      for(let i=0;i<embeds.length;i++){
        const embed=embeds[i]; if(!embed) continue;
        const lid=toPostListings[i]; const tokenId=String(lid?.asset?.token_id||lid?.asset?.identifier||lid?.criteria?.encoded_token_ids||lid?.token_id||'');
        if(tokenId && isRecentChannelPost(channel.id, tokenId)) { console.log('[Listing dedup] skipping #'+tokenId+' already posted to channel'); continue; }
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
              const dbMeta = await fetchTokenMetaFromDb(id);
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
                if(isRecentChannelPost(alertChannel.id, String(id))){
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

    }catch(e){ console.error('[Poll listings]',guildId,e.message); sendErrorWebhook('Poll Listings Error', e, `guild=${guildId}`); }
  }
}

// ── Personal DM alerts ────────────────────────────────────────────────────────
async function sendPersonalAlerts(event, type, config){
  // Dedup: same event can come through multiple guild configs — only DM once per event
  const eventKey = `placeholder:${type}:${event.id||event.event_timestamp}`;
  for(const [userId, alert] of Object.entries(_userAlerts)){
    try{
      if(alert.slug && alert.slug !== config.slug) continue;
      if(type==='sale'&&!alert.alertSales) continue;
      if(type==='listing'&&!alert.alertListings) continue;
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

module.exports = {
  pollSales, pollListings, sendPersonalAlerts, setClient,
  traitGroupsLabel, buildTokenSearchEmbed,
  getAlert, setAlert, deleteAlert,
  loadAllAlerts, loadSaleCursors, loadListingCursors,
  saveSaleCursors, saveListingCursors,
};