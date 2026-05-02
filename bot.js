/**
 * NFT Sales + Listings Bot — Multi-Server Public Edition
 * ─────────────────────────────────────────────────────────────
 * Posts NFT sales AND listings to separate channels.
 * Supports personal DM alerts per user with their own filters.
 *
 * SERVER ADMIN COMMANDS (Manage Server required):
 *   /setup         — Configure sales channel + collection
 *   /setlistings   — Set the listings channel
 *   /setchannel    — Change sales channel
 *   /setcollection — Change collection
 *   /salesfilter   — Filter auto-posted sales by trait
 *   /listingfilter — Filter auto-posted listings by trait
 *   /clearfilters  — Clear all server-level filters
 *   /pause /resume — Pause/resume all auto-posts
 *   /status        — Show server config
 *
 * PUBLIC COMMANDS (anyone):
 *   /lastsale            — Most recent sale
 *   /recentsales         — Last N sales
 *   /sale token:1234     — Specific token's last sale
 *   /traitfind           — Search sales history by trait
 *   /listings            — Show current active listings
 *   /myalert             — Set personal DM alert (sales + listings)
 *   /myalertclear        — Remove your personal DM alert
 *   /myalertstatus       — See your current alert settings
 *   /help
 *   /rankfilter       — Show listed tokens by OS/TraitView rank range
 *
 * SERVER ADMIN COMMANDS (continued):
 *   /setrankalert     — Alert when a top-rank token gets listed
 *   /clearrankalert   — Remove rank alert
 */

require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, AttachmentBuilder, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const fetch = require('node-fetch');
const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENSEA_KEY   = process.env.OPENSEA_KEY || '';
const POLL_MS       = parseInt(process.env.POLL_MS || '30000', 10);
const SERVER_FILE   = path.join(__dirname, 'server-configs.json');
const ALERTS_FILE   = path.join(__dirname, 'user-alerts.json');

// ── Railway Postgres pool (same DB as api.js) ─────────────────────────────────
const { Pool } = require('pg');
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pgPool.on('error', e => console.error('[PG bot]', e.message));

// ── Create bot_state table if it doesn't exist ───────────────────────────────
async function ensureBotStateTable(){
  try{
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('[DB] bot_state table ready');
  }catch(e){ console.error('[DB] ensureBotStateTable error:', e.message); }
}

// ── Persistence helpers ───────────────────────────────────────────────────────
function loadJson(file){ try{ return JSON.parse(fs.readFileSync(file,'utf8')); }catch{ return {}; } }
function saveJson(file, data){ try{ fs.writeFileSync(file, JSON.stringify(data,null,2)); }catch{} }

async function dbLoad(key){
  try{
    const r = await pgPool.query('SELECT value FROM bot_state WHERE key=$1', [key]);
    if(!r.rows.length) return null;
    return JSON.parse(r.rows[0].value);
  }catch(e){ console.warn('[DB] load error', key, e.message); return null; }
}

async function dbSave(key, value){
  try{
    await pgPool.query(
      `INSERT INTO bot_state(key,value,updated_at) VALUES($1,$2,NOW())
       ON CONFLICT(key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [key, JSON.stringify(value)]
    );
  }catch(e){ console.warn('[DB] save error', key, e.message); }
}

// ── Config helpers ────────────────────────────────────────────────────────────
async function loadAllConfigs(){
  // Try Railway Postgres first, then Supabase fallback, then local file
  let db = await dbLoad('server_configs');
  if(db){ serverConfigs = db; console.log('[Config] Loaded '+Object.keys(db).length+' server(s) from Railway DB'); return; }
  // Supabase fallback — migrate data to Railway DB on first load
  if(process.env.SUPABASE_URL && process.env.SUPABASE_KEY){
    try{
      const { createClient } = require('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
      const {data} = await sb.from('bot_config').select('value').eq('key','server_configs').single();
      if(data?.value){
        const parsed = typeof data.value==='string' ? JSON.parse(data.value) : data.value;
        serverConfigs = parsed;
        await dbSave('server_configs', serverConfigs); // migrate to Railway DB
        console.log('[Config] Migrated '+Object.keys(parsed).length+' server(s) from Supabase → Railway DB');
        return;
      }
    }catch(e){ console.warn('[Config] Supabase fallback failed:', e.message); }
  }
  serverConfigs = loadJson(SERVER_FILE);
  console.log('[Config] Loaded from local file ('+Object.keys(serverConfigs).length+' servers)');
}

async function saveAllConfigs(){
  saveJson(SERVER_FILE, serverConfigs);
  await dbSave('server_configs', serverConfigs);
}

async function loadAllAlerts(){
  let db = await dbLoad('user_alerts');
  if(db){ userAlerts = db; console.log('[Alerts] Loaded from Railway DB'); return; }
  if(process.env.SUPABASE_URL && process.env.SUPABASE_KEY){
    try{
      const { createClient } = require('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
      const {data} = await sb.from('bot_config').select('value').eq('key','user_alerts').single();
      if(data?.value){
        const parsed = typeof data.value==='string' ? JSON.parse(data.value) : data.value;
        userAlerts = parsed;
        await dbSave('user_alerts', userAlerts);
        console.log('[Alerts] Migrated from Supabase → Railway DB');
        return;
      }
    }catch(e){ console.warn('[Alerts] Supabase fallback failed:', e.message); }
  }
  userAlerts = loadJson(ALERTS_FILE);
}

async function saveAllAlerts(){
  saveJson(ALERTS_FILE, userAlerts);
  await dbSave('user_alerts', userAlerts);
}

// ── Sale cursor persistence — survives restarts ───────────────────────────────
async function loadSaleCursors(){
  const db = await dbLoad('sale_cursors');
  if(db){ for(const [k,v] of Object.entries(db)) lastSaleIds.set(k,v); console.log('[Cursors] Loaded sale cursors from Railway DB'); }
}
async function loadListingCursors(){
  const db = await dbLoad('listing_cursors');
  if(db){ for(const [k,v] of Object.entries(db)) lastListingIds.set(k,v); console.log('[Cursors] Loaded listing cursors from Railway DB'); }
}
async function saveSaleCursors(){
  await dbSave('sale_cursors', Object.fromEntries(lastSaleIds));
}
async function saveListingCursors(){
  await dbSave('listing_cursors', Object.fromEntries(lastListingIds));
}

let serverConfigs = {}; // loaded from Supabase or local file on startup
let userAlerts    = {}; // loaded from Supabase or local file on startup

function getConfig(guildId){ return serverConfigs[guildId] || {}; }
function setConfig(guildId, updates){ serverConfigs[guildId] = { ...getConfig(guildId), ...updates }; saveAllConfigs(); }
function getAlert(userId){ return userAlerts[userId] || null; }
function setAlert(userId, updates){ userAlerts[userId] = { ...(userAlerts[userId]||{}), ...updates }; saveAllAlerts(); }
function deleteAlert(userId){ delete userAlerts[userId]; saveAllAlerts(); }

// ── Cursors (not persisted) ───────────────────────────────────────────────────
const lastSaleIds     = new Map(); // guildId → last sale id
const lastListingIds  = new Map(); // guildId → last listing id
const alertedEventIds = new Set(); // dedup personal DM alerts across multiple servers
const imageCache      = new Map(); // "contract:tokenId" → {result, ts}
const IMAGE_CACHE_TTL = 60 * 60 * 1000; // 1 hour TTL

function getCachedImage(key){
  const entry = imageCache.get(key);
  if(!entry) return null;
  if(Date.now() - entry.ts > IMAGE_CACHE_TTL){ imageCache.delete(key); return null; }
  return entry.result;
}
function setCachedImage(key, result){
  imageCache.set(key, { result, ts: Date.now() });
}

// ── Slideshow sessions ────────────────────────────────────────────────────────
// Stores paginated embed sessions keyed by message ID.
// Each session: { embeds: [], index: 0, userId, expiresAt }
const slideshowSessions = new Map();

// Clean up expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for(const [id, s] of slideshowSessions) {
    if(s.expiresAt < now) slideshowSessions.delete(id);
  }
}, 5 * 60 * 1000);

// Build navigation row
function buildNavRow(index, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('slide_prev')
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index === 0),
    new ButtonBuilder()
      .setCustomId('slide_pos')
      .setLabel(`${index + 1} / ${total}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('slide_next')
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index === total - 1)
  );
}

// Post a slideshow or individual embeds depending on count
async function postEmbeds(interaction, embeds, headerText) {
  if(embeds.length === 0) return;

  if(embeds.length <= 5) {
    // 5 or fewer — post all individually
    await interaction.editReply(headerText);
    for(const embed of embeds) {
      if(!embed) continue;
      await sendEmbed(interaction.channel, embed);
      await new Promise(r => setTimeout(r, 600));
    }
  } else {
    // 6+ — post first 5 individually, then a "Show More" button for the rest
    await interaction.editReply(headerText);
    const first5 = embeds.slice(0, 5);
    const remaining = embeds.slice(5);

    for(const embed of first5) {
      if(!embed) continue;
      await sendEmbed(interaction.channel, embed);
      await new Promise(r => setTimeout(r, 600));
    }

    // Post "Show More" button for remaining results
    const showMoreRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('show_more')
        .setLabel(`Show More (${remaining.length} remaining)`)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('▶️')
    );
    const moreMsg = await interaction.channel.send({
      content: `_${remaining.length} more result${remaining.length===1?'':'s'} — click to browse:_`,
      components: [showMoreRow]
    });

    // Store remaining embeds as a slideshow session keyed to this message
    slideshowSessions.set(moreMsg.id, {
      embeds: remaining,
      index: 0,
      userId: interaction.user.id,
      expiresAt: Date.now() + 15 * 60 * 1000,
      isShowMore: true  // flag so we know to open slideshow on first click
    });
  }
}

// ── Sweep detection ───────────────────────────────────────────────────────────
// Groups sales by buyer + tx hash within a poll batch.
// When a group hits 5+ tokens, marks each sale with _isSweep=true and fires
// a summary embed after the last sale in the sweep is posted.

const cachedFloors = new Map(); // guildId → floor ETH at start of poll cycle

async function fetchFloorEth(slug) {
  try {
    const r = await fetch(
      `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`,
      { headers: osHeaders() }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j?.total?.floor_price ?? j?.stats?.floor_price ?? null;
  } catch { return null; }
}

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
    .setTitle(`🧹 Sweep Alert`)
    .setColor(0xf59e0b)
    .addFields(
      { name: 'Buyer',       value: buyerLink,           inline: true },
      { name: 'Swept',       value: `${count} OCAS`,     inline: true },
      { name: '​',      value: '​',             inline: true },
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

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Helpers ───────────────────────────────────────────────────────────────────
function osHeaders(){ const h={accept:'application/json'}; if(OPENSEA_KEY) h['x-api-key']=OPENSEA_KEY; return h; }

function trimEth(eth){
  // Strip trailing zeros: 0.00700 → 0.007, 1.2300 → 1.23, 0.00570 → 0.0057
  if(eth >= 1)    return parseFloat(eth.toFixed(4)).toString();
  if(eth >= 0.1)  return parseFloat(eth.toFixed(4)).toString();
  if(eth >= 0.01) return parseFloat(eth.toFixed(4)).toString();
  return parseFloat(eth.toFixed(5)).toString();
}

function formatEth(event){
  try{
    const qty = BigInt(event.payment?.quantity||'0');
    const dec = event.payment?.decimals??18;
    const eth = Number(qty)/Math.pow(10,dec);
    if(!isFinite(eth)||eth<=0) return null;
    return trimEth(eth);
  }catch{ return null; }
}

function formatListingEth(listing){
  try{
    const qty = listing.payment?.quantity;
    if(!qty) return null;
    const dec = listing.payment?.decimals ?? 18;
    const eth = Number(qty) / Math.pow(10, dec);
    if(!isFinite(eth)||eth<=0) return null;
    return trimEth(eth);
  }catch{ return null; }
}

function shortAddr(addr){ if(!addr||addr.length<10) return addr||'unknown'; return addr.slice(0,6)+'...'+addr.slice(-4); }
function timeSince(ts){
  const s=Math.floor(Date.now()/1000-ts);
  if(s<60)   return s+'s ago';
  if(s<3600) return Math.floor(s/60)+'m ago';
  // Anything older than 1 hour: show readable date + time
  const d=new Date(ts*1000);
  const date=d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const time=d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true});
  return date+' at '+time;
}
function isSvg(url){ if(!url) return false; const s=String(url).trim(); return s.startsWith('<svg')||s.startsWith('data:image/svg')||s.toLowerCase().endsWith('.svg')||s.includes('image/svg'); }
function isDiscordOk(url){ if(!url||isSvg(url)) return false; const s=url.toLowerCase(); return (s.startsWith('http://')||s.startsWith('https://'))&&!s.startsWith('data:'); }

function matchesFilters(traits, filters){
  if(!filters||Object.keys(filters).length===0) return true;
  const lookup={};
  for(const t of (traits||[])) lookup[t.trait_type?.toLowerCase()]=String(t.value).toLowerCase();
  // OR logic across all filter keys:
  // A token matches if it satisfies ANY of the filter conditions.
  // Within a single key, multiple values are also OR (e.g. type=zombie OR ape).
  for(const [k,v] of Object.entries(filters)){
    const allowed = Array.isArray(v) ? v : [v];
    if(allowed.includes(lookup[k])) return true;
  }
  return false;
}

// ── SVG → PNG (OCAS on-chain SVG with embedded PNG + gradient background) ────
async function extractPngFromSvg(svgSource){
  let svgText;
  if(svgSource.startsWith('data:image/svg')){
    const b64=svgSource.split(',')[1]; if(!b64) throw new Error('Empty SVG');
    svgText=Buffer.from(b64,'base64').toString('utf-8');
  } else {
    const r=await fetch(svgSource); if(!r.ok) throw new Error('SVG fetch '+r.status);
    svgText=await r.text();
  }
  const SIZE=500;
  const pngMatch=svgText.match(/src=["']data:image\/png;base64,([A-Za-z0-9+/=\s]+)["']/);
  let charBuf=null;
  if(pngMatch){
    const rawPng=Buffer.from(pngMatch[1].replace(/\s/g,''),'base64');
    charBuf=await sharp(rawPng).resize(SIZE,SIZE,{kernel:'nearest'}).png().toBuffer();
  }
  const stopMatches=[...svgText.matchAll(/stop-color=["'](#[0-9a-fA-F]{6,8})["']/g)];
  const stops=stopMatches.map(m=>m[1].slice(0,7));
  const unique=stops.filter((c,i)=>c!==stops[i-1]);
  const gd=svgText.match(/linearGradient[^>]+x1=["']([\d.]+)["'][^>]+y1=["']([\d.]+)["'][^>]+x2=["']([\d.]+)["'][^>]+y2=["']([\d.]+)["']/);
  const [gx1,gy1,gx2,gy2]=gd?[gd[1],gd[2],gd[3],gd[4]]:['0','0','0','1'];
  let gradStops;
  if(unique.length<=1){ const c=unique[0]||'#1a1a2e'; gradStops=`<stop offset="0%" stop-color="${c}"/><stop offset="100%" stop-color="${c}"/>`; }
  else { gradStops=unique.map((c,i)=>`<stop offset="${Math.round(i/(unique.length-1)*100)}%" stop-color="${c}"/>`).join(''); }
  const bgSvg=`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><defs><linearGradient id="bg" x1="${gx1}" y1="${gy1}" x2="${gx2}" y2="${gy2}">${gradStops}</linearGradient></defs><rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/></svg>`;
  const bgBuf=await sharp(Buffer.from(bgSvg)).resize(SIZE,SIZE).png().toBuffer();
  if(charBuf) return sharp(bgBuf).composite([{input:charBuf,blend:'over'}]).png().toBuffer();
  return bgBuf;
}

// ── Image resolver ────────────────────────────────────────────────────────────
async function resolveImage(nft, contract, chain){
  const id=nft?.identifier||nft?.token_id;
  const key=`${contract}:${id}`;
  if(id&&imageCache.has(key)) return imageCache.get(key);
  const candidates=[nft?.display_image_url,nft?.image_url,nft?.image_preview_url];
  for(const url of candidates){ if(isDiscordOk(url)){ const r={type:'url',url}; if(id) imageCache.set(key,r); return r; } }
  if(id){
    try{
      const chainForImg=chain||'ethereum';
      const r=await fetch(`https://api.opensea.io/api/v2/chain/${chainForImg}/contract/${contract}/nfts/${id}`,{headers:osHeaders()});
      if(r.ok){
        const j=await r.json(); const n=j.nft||j;
        const deep=[n.display_image_url,n.image_url,n.image_preview_url,n.image_thumbnail_url];
        for(const url of deep){ if(isDiscordOk(url)){ const res={type:'url',url}; imageCache.set(key,res); return res; } }
        const svgSrc=deep.find(u=>u&&!u.startsWith('<svg')&&!u.startsWith('data:')&&isSvg(u))||candidates.find(u=>u&&isSvg(u));
        if(svgSrc){ const buf=await extractPngFromSvg(svgSrc); const res={type:'buffer',buffer:buf,filename:`token-${id}.png`}; imageCache.set(key,res); return res; }
      }
    }catch(e){ console.warn('[Image]',id,e.message); }
  }
  return null;
}

// ── Send embed (handles buffer attachment vs URL) ─────────────────────────────
async function sendEmbed(target, embed){
  const ir=embed._imageResult; delete embed._imageResult;
  if(ir?.type==='buffer'){ const att=new AttachmentBuilder(ir.buffer,{name:ir.filename}); embed.setThumbnail(`attachment://${ir.filename}`); return target.send({embeds:[embed],files:[att]}); }
  if(ir?.type==='url') embed.setThumbnail(ir.url);
  return target.send({embeds:[embed]});
}

// ── Build SALE embed ──────────────────────────────────────────────────────────
async function buildSaleEmbed(sale, config){
  const id=sale.nft?.identifier;
  const name=sale.nft?.name||`#${id}`;
  const eth=formatEth(sale);
  const contract=config.contract||'';
  const slug=config.slug||'';
  const chain=config.chain||'ethereum';
  const osUrl=contract?`https://opensea.io/assets/${chain}/${contract}/${id}`:`https://opensea.io/assets/${chain}/${id}`;
  const tvUrl=`https://traitview.com/?jump=${id}`;
  const timeStr=sale.event_timestamp?timeSince(sale.event_timestamp):'';
  const buyerLink=sale.buyer&&sale.buyer!=='unknown'?`[${shortAddr(sale.buyer)}](https://opensea.io/${sale.buyer})`:'unknown';
  const sellerLink=sale.seller&&sale.seller!=='unknown'?`[${shortAddr(sale.seller)}](https://opensea.io/${sale.seller})`:'unknown';

  // Detect ETH vs WETH and sale type
  const paymentToken = sale.payment?.symbol || '';
  const paymentAddr  = (sale.payment?.token_address||'').toLowerCase();
  const WETH_ADDR    = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const isWeth       = paymentAddr === WETH_ADDR || paymentToken.toLowerCase() === 'weth';
  const currencySymbol = isWeth ? 'WETH' : 'ETH';
  const saleType     = sale.event_type === 'offer_accepted' ? 'Offer Accepted' : 'Listed Sale';

  const sweepPrefix = sale._isSweep ? '🧹 ' : '';
  const embed=new EmbedBuilder()
    .setTitle(`${sweepPrefix}${eth?eth+' '+currencySymbol:'--'} — ${name} sold`)
    .setColor(isWeth ? 0x9b59b6 : 0x2dd4bf)  // purple for WETH, teal for ETH
    .setURL(osUrl)
    .setFooter({text:`Sales Bot - ${slug}${timeStr?' - '+timeStr:''}`})
    .setTimestamp();

  embed._imageResult=await resolveImage(sale.nft,contract,config.chain||'ethereum');

  // Buyer + Seller on same row (inline), then Traits full-width, then Links
  // This eliminates dead space that was caused by tall Traits column next to thumbnail
  embed.addFields(
    {name:'Buyer',  value:buyerLink,  inline:true},
    {name:'Seller', value:sellerLink, inline:true},
    {name:'​',   value:'​',        inline:true}, // blank field to complete the 3-col row
  );
  const traits=sale.nft?.traits||[];
  if(traits.length>0){
    // Two columns of traits side by side
    const traitLines = traits.slice(0,12).map(t=>`**${t.trait_type}**: ${t.value}`);
    const half = Math.ceil(traitLines.length/2);
    const col1 = traitLines.slice(0,half).join('\n');
    const col2 = traitLines.slice(half).join('\n');
    embed.addFields(
      {name:'Traits', value:col1, inline:true},
      {name:'​',  value:col2||'​', inline:true},
    );
  }
  embed.addFields({name:'Links',value:`[OpenSea](${osUrl}) - [TraitView](${tvUrl})`,inline:false});
  return embed;
}

// ── Build LISTING embed ───────────────────────────────────────────────────────
// OpenSea listing events (event_type:"order") real structure from debug:
//   listing.asset        → NFT data (token_id, name, image_url, traits)
//   listing.payment      → { quantity (wei), decimals, symbol }
//   listing.maker        → seller address (string)
//   listing.criteria     → trait filter if collection offer
async function buildListingEmbed(listing, config){
  // OpenSea listing event structure (confirmed via /debuglisting):
  //   asset = null for some collections (OCAS)
  //   criteria.encoded_token_ids = token ID when asset is null
  //   criteria.contract.address = contract address
  //   payment.quantity = price in wei
  //   maker = seller address string
  const asset      = listing.asset || {};
  const criteria   = listing.criteria || {};
  const eth        = formatListingEth(listing);
  const slug       = config.slug || '';
  const chain      = config.chain || 'ethereum';

  // Token ID: from asset first, then criteria
  const id = String(
    asset.token_id ||
    asset.identifier ||
    criteria.encoded_token_ids ||
    ''
  );

  // Contract: from config first, then asset, then criteria
  const contract = config.contract ||
    (asset.asset_contract && asset.asset_contract.address) ||
    (criteria.contract && criteria.contract.address) ||
    '';

  const name   = asset.name || (id ? '#'+id : 'Unknown');
  const osUrl  = (contract && id) ? 'https://opensea.io/assets/'+chain+'/'+contract+'/'+id : 'https://opensea.io/collection/'+slug;
  const tvUrl  = id ? 'https://traitview.com/?jump='+id : '';

  const sellerAddr = (typeof listing.maker === 'string' ? listing.maker : (listing.maker && listing.maker.address)) || '';
  const sellerLink = sellerAddr ? '['+shortAddr(sellerAddr)+'](https://opensea.io/'+sellerAddr+')' : 'unknown';

  const embed = new EmbedBuilder()
    .setTitle(`${eth ? eth+' ETH' : '--'} — ${name} listed`)
    .setColor(0x7aa2ff)
    .setURL(osUrl)
    .setFooter({text:'Listings Bot - '+slug})
    .setTimestamp();

  // resolveImage fetches from OpenSea NFT endpoint using the token ID
  // This handles the case where asset is null - it goes direct to the NFT endpoint
  const nftLike = {
    identifier:        id,
    image_url:         asset.image_url || null,
    display_image_url: asset.display_image_url || null,
    image_preview_url: asset.image_preview_url || null,
  };
  embed._imageResult = id ? await resolveImage(nftLike, contract, chain) : null;

  embed.addFields(
    {name:'Seller',  value: sellerLink,             inline:true},
    {name:'Buy Now', value: '[OpenSea]('+osUrl+')', inline:true},
  );

  const traits = asset.traits || [];
  if(traits.length > 0){
    embed.addFields({name:'Traits', value:traits.slice(0,12).map(function(t){return '**'+t.trait_type+'**: '+t.value;}).join('\n'), inline:true});
  }

  const linkParts = ['[OpenSea]('+osUrl+')'];
  if(tvUrl) linkParts.push('[TraitView]('+tvUrl+')');
  embed.addFields({name:'Links', value:linkParts.join(' - '), inline:false});
  return embed;
}

// ── Poll sales ────────────────────────────────────────────────────────────────
async function pollSales(){
  for(const [guildId,config] of Object.entries(serverConfigs)){
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
        const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(config.slug)}?${qs}`,{headers:osHeaders()});
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

      const channel=client.channels.cache.get(config.channelId);
      if(!channel) continue;

      console.log('['+config.slug+'] Posting '+newSales.length+' new sale(s)');

      // Build all embeds — oldest first
      const toPost = newSales.reverse();

      // ── Sweep detection: count buyer+tx combos across this batch ─────────
      const sweepCounts = new Map();
      for(const sale of toPost){
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

    }catch(e){ console.error('[Poll sales]',guildId,e.message); }
  }
}

// ── Poll listings ─────────────────────────────────────────────────────────────
async function pollListings(){
  for(const [guildId,config] of Object.entries(serverConfigs)){
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
        const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(config.slug)}?${qs}`,{headers:osHeaders()});
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

      const channel=client.channels.cache.get(config.listingsChannelId);
      if(!channel) continue;

      console.log('['+config.slug+'] Posting '+newListings.length+' new listing(s)');

      const toPost=newListings.reverse();
      const toPostListings = toPost.filter(l=>matchesFilters((l.asset&&l.asset.traits)||[],config.listingFilters));
      const embeds=await Promise.all(
        toPostListings
          .map(l=>buildListingEmbed(l,config).catch(e=>{console.error('[Build listing]',e.message);return null;}))
      );

      for(const embed of embeds){
        if(!embed) continue;
        try{ await sendEmbed(channel,embed); }catch(e){ console.error('[Listing post]',e.message); }
        await new Promise(r=>setTimeout(r,300));
      }

      // ── Rank listing alert ────────────────────────────────────────────────
      const rankAlertCfg = config.rankAlert;
      if(rankAlertCfg?.min && rankAlertCfg?.max){
        const RAILWAY_URL = process.env.RAILWAY_API_URL;
        const API_SECRET  = process.env.API_SECRET;
        if(RAILWAY_URL){
          for(const listing of toPostListings){
            const id = parseInt(
              (listing.asset?.token_id) ||
              (listing.asset?.identifier) ||
              (listing.criteria?.encoded_token_ids) ||
              (listing.nft?.identifier) || 0
            );
            if(!id) continue;
            try{
              const tqs = new URLSearchParams({ key: API_SECRET||'' });
              const tr = await fetch(`${RAILWAY_URL}/db/token/${id}?${tqs}`);
              if(!tr.ok) continue;
              const tj = await tr.json();
              if(!tj.ok) continue;
              const osRank = tj.token?.os_rank;
              if(!osRank) continue;
              if(osRank >= rankAlertCfg.min && osRank <= rankAlertCfg.max){
                const alertChannel = client.channels.cache.get(
                  rankAlertCfg.channelId || config.listingsChannelId || config.channelId
                );
                if(!alertChannel) continue;
                const eth = formatListingEth(listing);
                const priceStr = eth ? `Ξ ${eth}` : '—';
                const contract = config.contract || '0x078be86f3104a32313a47815792230a3808642cc';
                const osUrl = `https://opensea.io/assets/ethereum/${contract}/${id}`;
                const tvUrl = `https://traitview.com/?token=${id}`;
                const alertEmbed = new EmbedBuilder()
                  .setTitle(`🏆 Rank Alert — #${id} listed`)
                  .setColor(0xf59e0b)
                  .setDescription(`**◆ OS Rank #${osRank}** token just listed for **${priceStr}**

[OpenSea](${osUrl}) · [TraitView](${tvUrl})`)
                  .setFooter({ text: `on-chain-all-stars · rank alert #${rankAlertCfg.min}–#${rankAlertCfg.max}` })
                  .setTimestamp();
                try{
                  const imgResult = await resolveImage({ identifier: String(id) }, contract, 'ethereum');
                  if(imgResult?.type === 'buffer'){
                    const att = new AttachmentBuilder(imgResult.buffer, {name: imgResult.filename});
                    alertEmbed.setThumbnail(`attachment://${imgResult.filename}`);
                    await alertChannel.send({ embeds:[alertEmbed], files:[att] });
                  } else {
                    if(imgResult?.type === 'url') alertEmbed.setThumbnail(imgResult.url);
                    await alertChannel.send({ embeds:[alertEmbed] });
                  }
                }catch(e){ await alertChannel.send({ embeds:[alertEmbed] }); }
                console.log(`[Rank Alert] #${id} OS Rank #${osRank} listed at ${priceStr}`);
              }
            }catch(e){ console.warn('[Rank alert]', e.message); }
          }
        }
      }

      for(const l of toPost) await sendPersonalAlerts(l,'listing',config);

    }catch(e){ console.error('[Poll listings]',guildId,e.message); }
  }
}

// ── Personal DM alerts ────────────────────────────────────────────────────────
async function sendPersonalAlerts(event, type, config){
  // Dedup: same event can come through multiple guild configs — only DM once per event
  const eventKey = `placeholder:${type}:${event.id||event.event_timestamp}`;
  for(const [userId, alert] of Object.entries(userAlerts)){
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
      // Keep set from growing forever — trim if over 5000 entries
      if(alertedEventIds.size > 5000){
        const first = alertedEventIds.values().next().value;
        alertedEventIds.delete(first);
      }
      const user=await client.users.fetch(userId).catch(()=>null);
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
client.on('interactionCreate', async (interaction)=>{
  // ── Slideshow button handler ───────────────────────────────────────────────
  // ── Show More button — opens slideshow of remaining results ──────────────
  if(interaction.isButton() && interaction.customId === 'show_more'){
    const session = slideshowSessions.get(interaction.message.id);
    if(!session){ await interaction.reply({content:'Session expired.', flags: MessageFlags.Ephemeral}); return; }
    // Convert show_more button to full slideshow navigation
    const embed = session.embeds[0];
    const ir = embed._imageResult;
    const row = buildNavRow(0, session.embeds.length);
    try{
      if(ir?.type === 'buffer'){
        const att = new AttachmentBuilder(ir.buffer, {name: ir.filename});
        embed.setThumbnail(`attachment://${ir.filename}`);
        await interaction.update({ content: null, embeds: [embed], components: [row], files: [att] });
      } else {
        if(ir?.type === 'url') embed.setThumbnail(ir.url);
        await interaction.update({ content: null, embeds: [embed], components: [row], files: [] });
      }
      // Re-key session to same message (already stored)
      session.isShowMore = false;
    }catch(e){ console.error('[ShowMore]', e.message); }
    return;
  }

  if(interaction.isButton() && ['slide_prev','slide_next'].includes(interaction.customId)){
    const session = slideshowSessions.get(interaction.message.id);
    if(!session){ await interaction.reply({content:'Session expired.', flags: MessageFlags.Ephemeral}); return; }
    if(interaction.customId === 'slide_prev') session.index = Math.max(0, session.index - 1);
    if(interaction.customId === 'slide_next') session.index = Math.min(session.embeds.length - 1, session.index + 1);
    const embed = session.embeds[session.index];
    const ir = embed._imageResult;
    const row = buildNavRow(session.index, session.embeds.length);
    try{
      if(ir?.type === 'buffer'){
        const att = new AttachmentBuilder(ir.buffer, {name: ir.filename});
        embed.setThumbnail(`attachment://${ir.filename}`);
        await interaction.update({ embeds: [embed], components: [row], files: [att] });
      } else {
        if(ir?.type === 'url') embed.setThumbnail(ir.url);
        await interaction.update({ embeds: [embed], components: [row], files: [] });
      }
    }catch(e){ console.error('[Slideshow]', e.message); }
    return;
  }

  if(!interaction.isChatInputCommand()) return;
  const {commandName,guildId}=interaction;
  const config=getConfig(guildId);
  const isAdmin=interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

  // /setup
  if(commandName==='setup'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const channel=interaction.options.getChannel('channel');
    const slug=interaction.options.getString('collection');
    const contract=(interaction.options.getString('contract')||'').toLowerCase().trim();
    const chain=(interaction.options.getString('chain')||'ethereum').toLowerCase().trim();
    setConfig(guildId,{channelId:channel.id,slug:slug.toLowerCase().trim(),contract,chain,salesFilters:{},listingFilters:{},paused:false});
    await interaction.reply({embeds:[new EmbedBuilder().setTitle('Sales Bot Configured!').setColor(0x2dd4bf)
      .addFields({name:'Sales Channel',value:`<#${channel.id}>`,inline:true},{name:'Collection',value:slug,inline:true},{name:'Contract',value:contract||'not set',inline:true})
      .setDescription('Sales will post automatically. Use `/setlistings` to also enable listing alerts.')]});
    return;
  }

  // /setuphere — mobile-friendly setup, uses the CURRENT channel automatically
  if(commandName==='setuphere'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const slug=interaction.options.getString('collection');
    const contract=(interaction.options.getString('contract')||'').toLowerCase().trim();
    const chain=(interaction.options.getString('chain')||'ethereum').toLowerCase().trim();
    const channelId=interaction.channelId; // use the channel this command was run in
    setConfig(guildId,{channelId,slug:slug.toLowerCase().trim(),contract,chain,salesFilters:{},listingFilters:{},paused:false});
    await interaction.reply({embeds:[new EmbedBuilder().setTitle('Sales Bot Configured!')
      .setColor(0x2dd4bf)
      .addFields(
        {name:'Sales Channel',value:`<#${channelId}> (this channel)`,inline:true},
        {name:'Collection',   value:slug,                              inline:true},
        {name:'Contract',     value:contract||'not set',              inline:true},
      )
      .setDescription('Sales will post to **this channel** automatically.\nRun `/setlistingshere` in your listings channel to enable listing alerts.')
    ]});
    return;
  }

  // /setlistingshere — mobile-friendly listings setup, uses current channel
  if(commandName==='setlistingshere'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const channelId=interaction.channelId;
    setConfig(guildId,{listingsChannelId:channelId});
    await interaction.reply({content:`Listings channel set to this channel <#${channelId}>. New listings will post here automatically.`});
    return;
  }

  // /setlistings
  if(commandName==='setlistings'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const channel=interaction.options.getChannel('channel');
    setConfig(guildId,{listingsChannelId:channel.id});
    await interaction.reply({content:`Listings channel set to <#${channel.id}>. New listings will post there automatically.`});
    return;
  }

  // /setchannel
  if(commandName==='setchannel'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const channel=interaction.options.getChannel('channel');
    setConfig(guildId,{channelId:channel.id});
    await interaction.reply({content:`Sales channel updated to <#${channel.id}>`, flags: MessageFlags.Ephemeral});
    return;
  }

  // /setcollection
  if(commandName==='setcollection'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const slug=interaction.options.getString('slug').toLowerCase().trim();
    const contract=(interaction.options.getString('contract')||'').toLowerCase().trim();
    setConfig(guildId,{slug,contract,salesFilters:{},listingFilters:{}});
    await interaction.reply({content:`Collection set to **${slug}**`, flags: MessageFlags.Ephemeral});
    return;
  }

  // /salesfilter
  if(commandName==='salesfilter'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const trait=interaction.options.getString('trait').toLowerCase().trim();
    const value=interaction.options.getString('value').toLowerCase().trim();
    const existing=config.salesFilters||{};
    const current=existing[trait];
    // Stack multiple values for same trait into an array (OR logic)
    let newVal;
    if(!current) newVal=value;
    else if(Array.isArray(current)) newVal=current.includes(value)?current:[...current,value];
    else newVal=current===value?current:[current,value];
    const filters={...existing,[trait]:newVal};
    setConfig(guildId,{salesFilters:filters});
    const display=Array.isArray(newVal)?newVal.join(' OR '):newVal;
    await interaction.reply({content:`Sales filter updated: **${trait}** = ${display}\nUse \`/clearfilters\` to remove all.`, flags: MessageFlags.Ephemeral});
    return;
  }

  // /listingfilter
  if(commandName==='traitlistingfilter'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const trait=interaction.options.getString('trait').toLowerCase().trim();
    const value=interaction.options.getString('value').toLowerCase().trim();
    const existing=config.listingFilters||{};
    const current=existing[trait];
    let newVal;
    if(!current) newVal=value;
    else if(Array.isArray(current)) newVal=current.includes(value)?current:[...current,value];
    else newVal=current===value?current:[current,value];
    const filters={...existing,[trait]:newVal};
    setConfig(guildId,{listingFilters:filters});
    const display=Array.isArray(newVal)?newVal.join(' OR '):newVal;
    await interaction.reply({content:`Listing filter updated: **${trait}** = ${display}\nUse \`/clearfilters\` to remove all.`, flags: MessageFlags.Ephemeral});
    return;
  }

  // /clearfilters
  // /setrankalert — configure rank-based listing alerts (admin)
  if(commandName==='ranklistingfilter'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const rankMin  = interaction.options.getInteger('min') ?? 1;
    const rankMax  = interaction.options.getInteger('max') ?? 100;
    const rankType = interaction.options.getString('rank_type') || 'os';
    const channel  = interaction.options.getChannel('channel');
    setConfig(guildId, { rankAlert: {
      min: rankMin, max: rankMax,
      rankType,
      channelId: channel?.id || null
    }});
    const rankLabel = rankType === 'obs' ? 'TraitView' : 'OpenSea';
    await interaction.reply({
      embeds:[new EmbedBuilder()
        .setTitle('🏆 Rank Alert Set')
        .setColor(0xf59e0b)
        .setDescription(`Will alert when a token with **${rankLabel} rank #${rankMin}–#${rankMax}** gets listed.`)
        .addFields(
          { name:'Rank Range', value:`#${rankMin} – #${rankMax}`, inline:true },
          { name:'Rank System', value:rankLabel, inline:true },
          { name:'Alert Channel', value: channel ? `<#${channel.id}>` : 'Same as listings', inline:true }
        )]
    });
    return;
  }

  // /clearrankalert — remove rank alert config
  if(commandName==='removerankfilter'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    setConfig(guildId, { rankAlert: null });
    await interaction.reply({ content:'Rank alert cleared.', flags: MessageFlags.Ephemeral });
    return;
  }

    if(commandName==='clearallfilters'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    setConfig(guildId,{salesFilters:{}, listingFilters:{}, rankAlert: null});
    await interaction.reply({content:'All filters cleared (trait filters + rank alert).', flags:MessageFlags.Ephemeral});
    return;
  }

  // /removefilter — remove a single value from an existing filter
  if(commandName==='removetraitfilter'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const filterType=interaction.options.getString('type'); // 'sales' or 'listings'
    const trait=interaction.options.getString('trait').toLowerCase().trim();
    const value=interaction.options.getString('value').toLowerCase().trim();
    const key=filterType==='sales'?'salesFilters':'listingFilters';
    const existing={...(config[key]||{})};
    if(!existing[trait]){
      await interaction.reply({content:`No filter found for **${trait}**.`, flags: MessageFlags.Ephemeral}); return;
    }
    const current=existing[trait];
    if(Array.isArray(current)){
      const updated=current.filter(v=>v!==value);
      if(updated.length===0) delete existing[trait];
      else if(updated.length===1) existing[trait]=updated[0];
      else existing[trait]=updated;
    } else {
      delete existing[trait];
    }
    setConfig(guildId,{[key]:existing});
    const remaining=Object.keys(existing).length===0?'none':Object.entries(existing).map(([k,v])=>`${k}=${Array.isArray(v)?v.join(' OR '):v}`).join(', ');
    await interaction.reply({content:`Removed **${value}** from ${filterType} filter for **${trait}**.
Remaining ${filterType} filters: ${remaining}`, flags: MessageFlags.Ephemeral});
    return;
  }

  // /pause
  if(commandName==='pause'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    setConfig(guildId,{paused:true});
    await interaction.reply({content:'Paused. Use `/resume` to restart.', flags: MessageFlags.Ephemeral});
    return;
  }

  // /resume
  if(commandName==='resume'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    setConfig(guildId,{paused:false});
    await interaction.reply({content:'Resumed!', flags: MessageFlags.Ephemeral});
    return;
  }

  // /status
  if(commandName==='status'){
    const fmtFilter=f=>Object.keys(f||{}).length===0?'none':Object.entries(f).map(([k,v])=>`${k}=${Array.isArray(v)?v.join(' OR '):v}`).join(', ');
    const sf  = fmtFilter(config.salesFilters);
    const lf  = fmtFilter(config.listingFilters);
    const ra  = config.rankAlert
      ? `◆ OS Rank #${config.rankAlert.min}–#${config.rankAlert.max}${config.rankAlert.channelId ? ` → <#${config.rankAlert.channelId}>` : ''}`
      : 'none';
    await interaction.reply({embeds:[new EmbedBuilder().setTitle('Bot Status').setColor(0x7aa2ff)
      .addFields(
        {name:'Collection',        value:config.slug||'not set',                                            inline:true},
        {name:'Paused',            value:config.paused?'Yes':'No',                                          inline:true},
        {name:'​',            value:'​',                                                           inline:true},
        {name:'Sales Channel',     value:config.channelId?`<#${config.channelId}>`:'not set',               inline:true},
        {name:'Listings Channel',  value:config.listingsChannelId?`<#${config.listingsChannelId}>`:'not set', inline:true},
        {name:'​',            value:'​',                                                           inline:true},
        {name:'Sales Filters',     value:sf,                                                                 inline:true},
        {name:'Listing Filters',   value:lf,                                                                 inline:true},
        {name:'Rank Alert',        value:ra,                                                                 inline:true},
      )], flags: MessageFlags.Ephemeral});
    return;
  }

  // /lastsale
  if(commandName==='lastsale'){
    const slug=interaction.options.getString('collection')||config.slug;
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=1`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply('No sales found.');return;}
      const embed=await buildSaleEmbed(sales[0],{...config,slug});
      const ir=embed._imageResult;delete embed._imageResult;
      if(ir?.type==='buffer'){const att=new AttachmentBuilder(ir.buffer,{name:ir.filename});embed.setThumbnail(`attachment://${ir.filename}`);await interaction.editReply({embeds:[embed],files:[att]});}
      else{if(ir?.type==='url')embed.setThumbnail(ir.url);await interaction.editReply({embeds:[embed]});}
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /recentsales
  if(commandName==='recentsales'){
    const slug=interaction.options.getString('collection')||config.slug;
    const count=Math.min(interaction.options.getInteger('count')||5,20);
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=${count}`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply('No sales found.');return;}
      const cfg={...config,slug};
      const embeds=await Promise.all(sales.reverse().map(s=>buildSaleEmbed(s,cfg).catch(()=>null)));
      await postEmbeds(interaction, embeds.filter(Boolean), `Last ${sales.length} sales for **${slug}**:`);
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /sale token:ID
  if(commandName==='sale'){
    const tokenId=interaction.options.getString('token').replace('#','');
    const slug=interaction.options.getString('collection')||config.slug;
    const contract=config.contract||'';
    if(!slug) return interaction.reply({content:'Run `/setup` first.', flags: MessageFlags.Ephemeral});
    if(!contract) return interaction.reply({content:'Set a contract with `/setcollection`.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const chainForSale=config.chain||'ethereum';
      const r=await fetch(`https://api.opensea.io/api/v2/events/chain/${chainForSale}/contract/${contract}/nfts/${tokenId}?event_type=sale&limit=1`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply(`No sales found for #${tokenId}.`);return;}
      const embed=await buildSaleEmbed(sales[0],config);
      const ir=embed._imageResult;delete embed._imageResult;
      if(ir?.type==='buffer'){const att=new AttachmentBuilder(ir.buffer,{name:ir.filename});embed.setThumbnail(`attachment://${ir.filename}`);await interaction.editReply({embeds:[embed],files:[att]});}
      else{if(ir?.type==='url')embed.setThumbnail(ir.url);await interaction.editReply({embeds:[embed]});}
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /traitfind — search sales history by trait. Tries Railway DB first (full history),
  // falls back to OpenSea pagination (capped ~1500 sales) if DB not configured.
  if(commandName==='traitfind'){
    const slug  = interaction.options.getString('collection') || config.slug;
    const trait = interaction.options.getString('trait').trim();
    const value = interaction.options.getString('value').trim();
    const want  = Math.min(interaction.options.getInteger('count') || 5, 25);
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();

    const RAILWAY_URL = process.env.RAILWAY_API_URL;
    const API_SECRET  = process.env.API_SECRET;

    try{
      // ── Path A: Railway DB (full 15k+ sale history, instant) ──────────────
      if(RAILWAY_URL){
        await interaction.editReply(`🔍 Searching **${trait}: ${value}** in full sales history...`);
        const qs = new URLSearchParams({ trait, value, limit: String(Math.min(want, 200)), sort: 'desc' });
        if(API_SECRET) qs.set('key', API_SECRET);
        const r = await fetch(`${RAILWAY_URL}/db/trait-sales?${qs}`);
        if(r.ok){
          const j = await r.json();
          if(!j.ok) throw new Error(j.error || 'DB error');
          const sales = j.sales || [];
          if(!sales.length){
            await interaction.editReply(`No sales found in DB for **${trait}: ${value}** (searched ${j.count ?? 'all'} records).`);
            return;
          }
          // Build synthetic sale objects and embeds
          const cfg = {...config, slug};
          const toShow = sales.slice(0, want);
          const traitfindEmbeds = await Promise.all(toShow.map(async sale => {
            let tokenTraits = [];
            try{
              const tqs = new URLSearchParams({ key: API_SECRET||'' });
              const tr = await fetch(`${RAILWAY_URL}/db/token/${sale.token_id}?${tqs}`);
              if(tr.ok){ const tj = await tr.json(); if(tj.ok && tj.token?.traits) tokenTraits = Object.entries(tj.token.traits).map(([k,v])=>({ trait_type:k, value:v })); }
            }catch(e){}
            const syntheticSale = {
              nft: { identifier: String(sale.token_id), name: `#${sale.token_id}`, traits: tokenTraits },
              buyer: sale.buyer || 'unknown', seller: sale.seller || 'unknown',
              payment: { symbol: (sale.currency||'ETH'), token_address: (sale.currency||'ETH').toUpperCase()==='WETH' ? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' : '', quantity: sale.price_eth != null ? String(BigInt(Math.round(sale.price_eth * 1e18))) : '0', decimals: 18 },
              event_timestamp: sale.sale_ts ? Math.floor(new Date(sale.sale_ts).getTime()/1000) : null,
            };
            return buildSaleEmbed(syntheticSale, cfg).catch(()=>null);
          }));
          const totalNote = j.count > want ? ` (showing ${want} of ${j.count} total)` : '';
          await postEmbeds(interaction, traitfindEmbeds.filter(Boolean),
            `Found **${j.count}** sale${j.count===1?'':'s'} with **${trait}: ${value}**${totalNote}:`);
          return;
        }
        // DB call failed — fall through to OpenSea
        console.warn('[traitfind] Railway DB call failed, falling back to OpenSea');
      }

      // ── Path B: OpenSea pagination fallback (capped ~1500 sales) ──────────
      await interaction.editReply(`🔍 Searching OpenSea sales for **${trait}: ${value}**...`);
      const traitLow = trait.toLowerCase();
      const valueLow = value.toLowerCase();
      const matched=[];let cursor=null;let pages=0;
      while(matched.length<want&&pages<15){
        const qs=new URLSearchParams({event_type:'sale',limit:'100'});
        if(cursor) qs.set('next',cursor);
        const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?${qs}`,{headers:osHeaders()});
        if(!r.ok) break;
        const j=await r.json();const sales=j.asset_events||[];if(!sales.length) break;
        for(const sale of sales){
          if(matched.length>=want) break;
          const lookup={};
          for(const t of (sale.nft?.traits||[])) lookup[t.trait_type?.toLowerCase()]=String(t.value).toLowerCase();
          if(lookup[traitLow]===valueLow) matched.push(sale);
        }
        cursor=j.next||null;if(!cursor) break;pages++;
      }
      if(!matched.length){
        await interaction.editReply(`No sales found with **${trait}: ${value}** in the last ~${pages*100} sales.
_Tip: Add \`RAILWAY_API_URL\` env var to search full history._`);
        return;
      }
      await interaction.editReply(`Found **${matched.length}** sale${matched.length===1?'':'s'} with **${trait}: ${value}** (OpenSea, last ~${pages*100}):`);
      const cfg={...config,slug};
      for(const sale of matched){const embed=await buildSaleEmbed(sale,cfg);await sendEmbed(interaction.channel,embed);await new Promise(r=>setTimeout(r,800));}
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /listings
  if(commandName==='listings'){
    const slug=interaction.options.getString('collection')||config.slug;
    const count=Math.min(interaction.options.getInteger('count')||5,20);
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=listing&limit=${count}`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const listings=(await r.json()).asset_events||[];
      if(!listings.length){await interaction.editReply('No listings found.');return;}
      const cfg={...config,slug};
      const embeds=await Promise.all(listings.reverse().map(l=>buildListingEmbed(l,cfg).catch(()=>null)));
      await postEmbeds(interaction, embeds.filter(Boolean), `${listings.length} recent listings for **${slug}**:`);
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /debuglisting — show raw listing event to diagnose parsing issues
  if(commandName==='debuglisting'){
    const slug=interaction.options.getString('collection')||config.slug;
    if(!slug) return interaction.reply({content:'Provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply({ephemeral:true});
    try{
      const r=await fetch('https://api.opensea.io/api/v2/events/collection/'+encodeURIComponent(slug)+'?event_type=listing&limit=1',{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const j=await r.json();
      const events=j.asset_events||[];
      if(!events.length){await interaction.editReply('No listings found.');return;}
      const ev=events[0];
      const lines=[];
      lines.push('**Top-level keys:** '+JSON.stringify(Object.keys(ev)));
      lines.push('**event_type:** '+ev.event_type);
      lines.push('**nft keys:** '+(ev.nft?JSON.stringify(Object.keys(ev.nft)):'null'));
      lines.push('**nft.identifier:** '+(ev.nft?.identifier||'null'));
      lines.push('**nft.name:** '+(ev.nft?.name||'null'));
      lines.push('**nft.image_url:** '+(ev.nft?.image_url||'null'));
      lines.push('**price:** '+JSON.stringify(ev.price||null));
      lines.push('**payment:** '+JSON.stringify(ev.payment||null));
      lines.push('**base_price:** '+(ev.base_price||'null'));
      lines.push('**maker:** '+JSON.stringify(ev.maker||null));
      lines.push('**seller:** '+(ev.seller||'null'));
      lines.push('**item keys:** '+(ev.item?JSON.stringify(Object.keys(ev.item)):'null'));
      await interaction.editReply(lines.join('\n').slice(0,1900));
    }catch(err){await interaction.editReply('Error: '+err.message);}
    return;
  }

    // /myalert — personal DM alert setup
  if(commandName==='myalert'){
    const trait=interaction.options.getString('trait')?.toLowerCase().trim();
    const value=interaction.options.getString('value')?.toLowerCase().trim();
    const alertSales=interaction.options.getBoolean('sales')??true;
    const alertListings=interaction.options.getBoolean('listings')??true;
    const slug=interaction.options.getString('collection')||config.slug;
    if(!slug) return interaction.reply({content:'Provide a collection or run `/setup` in a configured server first.', flags: MessageFlags.Ephemeral});

    const existing=getAlert(interaction.user.id)||{};
    const filters={...(existing.traitFilters||{})};

    // Stack multiple values for same trait (OR logic) — same as server filters
    if(trait&&value){
      const current=filters[trait];
      if(!current) filters[trait]=value;
      else if(Array.isArray(current)) filters[trait]=current.includes(value)?current:[...current,value];
      else filters[trait]=current===value?current:[current,value];
    }

    setAlert(interaction.user.id,{slug,traitFilters:filters,alertSales,alertListings});

    const fmtF=f=>Object.keys(f||{}).length===0?'none (all)':Object.entries(f).map(([k,v])=>`**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join(', ');
    const filterStr=fmtF(filters);
    const lines=[
      `Personal alert set for **${slug}**!`,
      `Filters: ${filterStr}`,
      `Sales DMs: ${alertSales?'on':'off'}`,
      `Listing DMs: ${alertListings?'on':'off'}`,
      '',
      'You will receive DMs when matching events happen.',
      'Use `/myalert` again to add more trait filters.',
      'Use `/myalertclear` to remove your alert.'
    ].join('\n');

    await interaction.reply({content:lines, flags: MessageFlags.Ephemeral});
    return;
  }

  // /myalertclear
  if(commandName==='myalertclear'){
    const trait=interaction.options.getString('trait');
    const value=interaction.options.getString('value');
    if(trait){
      // Remove just one trait/value from the alert
      const alert=getAlert(interaction.user.id);
      if(!alert){ await interaction.reply({content:'You have no alert set.', flags: MessageFlags.Ephemeral}); return; }
      const filters={...(alert.traitFilters||{})};
      if(value&&filters[trait]){
        const current=filters[trait];
        if(Array.isArray(current)){
          const updated=current.filter(v=>v!==value.toLowerCase().trim());
          if(updated.length===0) delete filters[trait];
          else if(updated.length===1) filters[trait]=updated[0];
          else filters[trait]=updated;
        } else { delete filters[trait]; }
      } else { delete filters[trait]; }
      setAlert(interaction.user.id,{...alert,traitFilters:filters});
      const remaining=Object.keys(filters).length===0?'none':Object.entries(filters).map(([k,v])=>`**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join(', ');
      await interaction.reply({content:`Removed filter. Remaining: ${remaining}`, flags: MessageFlags.Ephemeral});
    } else {
      deleteAlert(interaction.user.id);
      await interaction.reply({content:'Your personal alert has been fully removed.', flags: MessageFlags.Ephemeral});
    }
    return;
  }

  // /myalertstatus
  if(commandName==='myalertstatus'){
    const alert=getAlert(interaction.user.id);
    if(!alert){await interaction.reply({content:'You have no personal alert set. Use `/myalert` to create one.', flags: MessageFlags.Ephemeral});return;}
    const filterStr=alert.traitFilters&&Object.keys(alert.traitFilters).length>0?Object.entries(alert.traitFilters).map(([k,v])=>`**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join('\n'):'none (all events)';
    const lines=[
      `Collection: **${alert.slug||'any'}**`,
      `Sales DMs: ${alert.alertSales?'on':'off'}`,
      `Listing DMs: ${alert.alertListings?'on':'off'}`,
      `Filters:\n${filterStr}`
    ].join('\n');
    await interaction.reply({content:lines, flags: MessageFlags.Ephemeral});
    return;
  }

  // /help
  // /rankfilter — show currently listed tokens filtered by OS rank range
  if(commandName==='rankfilter'){
    const rankMin    = interaction.options.getInteger('min') ?? 1;
    const rankMax    = interaction.options.getInteger('max') ?? 100;
    const sortBy     = interaction.options.getString('sort') || 'price'; // 'price' or 'rank'
    const RAILWAY_URL = process.env.RAILWAY_API_URL;
    const API_SECRET  = process.env.API_SECRET;

    if(!RAILWAY_URL) return interaction.reply({ content: 'RAILWAY_API_URL not configured.', flags: MessageFlags.Ephemeral });
    if(rankMin < 1 || rankMax > 10000 || rankMin > rankMax) return interaction.reply({ content: 'Invalid rank range.', flags: MessageFlags.Ephemeral });

    await interaction.deferReply();
    try{
      const qs = new URLSearchParams({ rank_min: rankMin, rank_max: rankMax, rank_type: 'os', limit: '20' });
      if(API_SECRET) qs.set('key', API_SECRET);
      const r = await fetch(`${RAILWAY_URL}/db/rank-listings?${qs}`);
      if(!r.ok) throw new Error(`API HTTP ${r.status}`);
      const j = await r.json();
      if(!j.ok) throw new Error(j.error || 'API error');

      let listings = j.listings || [];
      if(!listings.length){
        await interaction.editReply(`No listings found with OS rank **◆ #${rankMin}–#${rankMax}**.`);
        return;
      }

      // Sort by rank if requested
      if(sortBy === 'rank') listings.sort((a,b) => (a.os_rank??9999) - (b.os_rank??9999));

      // Build full embeds for each listing (same style as sale/listing embeds)
      const cfg = {...config};
      const rankEmbeds = await Promise.all(listings.map(async l => {
        // Fetch token data for traits + image
        let tokenTraits = []; let imageUrl = null;
        try{
          const tqs = new URLSearchParams({ key: API_SECRET||'' });
          const tr = await fetch(`${RAILWAY_URL}/db/token/${l.token_id}?${tqs}`);
          if(tr.ok){ const tj = await tr.json(); if(tj.ok && tj.token?.traits) tokenTraits = Object.entries(tj.token.traits).map(([k,v])=>({ trait_type:k, value:v })); }
        }catch(e){}
        const priceStr = l.price_eth >= 1 ? l.price_eth.toFixed(3) : l.price_eth.toFixed(4);
        const embed = new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle(`◆ OS #${l.os_rank ?? '?'} — #${l.token_id} listed for Ξ ${priceStr}`)
          .setURL(l.url)

          .setFooter({ text: `on-chain-all-stars · OS Rank #${rankMin}–#${rankMax} · sorted by ${sortBy}` })
          .setTimestamp();
        // Add traits + links
        const tvUrl = `https://traitview.com/?token=${l.token_id}`;
        const linkLine = `[OpenSea](${l.url}) · [TraitView](${tvUrl})`;
        if(tokenTraits.length){
          const traitStr = tokenTraits.slice(0,8).map(t=>`**${t.trait_type}:** ${t.value}`).join('\n');
          embed.setDescription(traitStr + '\n\n**Links**\n' + linkLine);
        } else {
          embed.setDescription('**Links**\n' + linkLine);
        }
        // Resolve image — pass nft object with identifier, use contract from config
        try{
          const contract = config.contract || '0x078be86f3104a32313a47815792230a3808642cc';
          const imgResult = await resolveImage({ identifier: String(l.token_id) }, contract, 'ethereum');
          embed._imageResult = imgResult;
        }catch(e){}
        return embed;
      }));

      const sortLabel = sortBy === 'rank' ? 'best rank first' : 'cheapest first';
      await postEmbeds(interaction, rankEmbeds.filter(Boolean),
        `🏆 **OS Rank ◆ #${rankMin}–#${rankMax}** — ${listings.length} listing${listings.length===1?'':'s'} (${sortLabel}):`);
    }catch(e){
      await interaction.editReply('Error: ' + e.message);
    }
    return;
  }

  // /ocas — show a random or specific OCAS token (art + links only)
  // Optional: trait filter to pull a random token with matching trait(s)


  // /traitfloor — show the floor price for a specific trait value or trait count
  if(commandName==='traitfloor'){
    const trait      = interaction.options.getString('trait')?.trim();
    const value      = interaction.options.getString('value')?.trim();
    const traitCount = interaction.options.getInteger('trait_count');
    const RAILWAY_URL = process.env.RAILWAY_API_URL;
    const API_SECRET  = process.env.API_SECRET;

    if(!RAILWAY_URL) return interaction.reply({ content: 'RAILWAY_API_URL not configured.', flags: MessageFlags.Ephemeral });
    if(!trait && !traitCount) return interaction.reply({ content: 'Provide a trait+value or a trait_count.', flags: MessageFlags.Ephemeral });
    if(trait && !value) return interaction.reply({ content: 'Please also provide a value for the trait.', flags: MessageFlags.Ephemeral });

    await interaction.deferReply();
    try{
      const contract = '0x078be86f3104a32313a47815792230a3808642cc';

      if(traitCount !== null && traitCount !== undefined){
        // ── Trait count floor — single DB query via dedicated endpoint ────────
        const qs = new URLSearchParams({ trait_count: String(traitCount), key: API_SECRET||'' });
        const r = await fetch(`${RAILWAY_URL}/db/trait-count-floor?${qs}`);
        if(!r.ok) throw new Error(`API HTTP ${r.status}`);
        const j = await r.json();
        if(!j.ok) throw new Error(j.error);
        if(!j.floor){
          await interaction.editReply(`No listed tokens found with **${traitCount} traits**.`);
          return;
        }
        const f = j.floor;
        const priceStr = f.price_eth >= 1 ? f.price_eth.toFixed(3) : f.price_eth.toFixed(4);
        const osUrl = f.url || `https://opensea.io/assets/ethereum/${contract}/${f.token_id}`;
        const tvUrl = `https://traitview.com/?token=${f.token_id}`;
        const embed = new EmbedBuilder()
          .setTitle(`Floor for ${traitCount}-trait OCAS — Ξ ${priceStr}`)
          .setColor(0x2dd4bf)
          .setDescription(`**Token:** #${f.token_id}\n**Traits:** ${traitCount}\n**Price:** Ξ ${priceStr}\n\n[OpenSea](${osUrl}) · [TraitView](${tvUrl})`)
          .setFooter({ text: 'on-chain-all-stars · trait count floor' })
          .setTimestamp();
        try{
          const imgResult = await resolveImage({ identifier: String(f.token_id) }, contract, 'ethereum');
          if(imgResult?.type === 'buffer'){ const att = new AttachmentBuilder(imgResult.buffer,{name:imgResult.filename}); embed.setThumbnail(`attachment://${imgResult.filename}`); await interaction.editReply({embeds:[embed],files:[att]}); }
          else { if(imgResult?.type==='url') embed.setThumbnail(imgResult.url); await interaction.editReply({embeds:[embed]}); }
        }catch(e){ await interaction.editReply({embeds:[embed]}); }

      } else {
        // ── Trait value floor — single DB query via /db/trait-floor ──────────
        // Try exact case then title case to handle user input like "zombie" or "Zombie"
        const fmtTrait = s => s.split(' ').map(w => w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
        let f = null;
        for(const [tn, tv] of [[trait, value], [fmtTrait(trait), fmtTrait(value)]]){
          const qs = new URLSearchParams({ trait_name: tn, trait_value: tv, key: API_SECRET||'' });
          const r = await fetch(`${RAILWAY_URL}/db/trait-floor?${qs}`);
          if(r.ok){ const j = await r.json(); if(j.ok && j.floor){ f = j.floor; break; } }
        }
        if(!f){
          await interaction.editReply(`No listings found for **${trait}: ${value}**. Check spelling.`);
          return;
        }
        const priceStr = f.price_eth >= 1 ? f.price_eth.toFixed(3) : f.price_eth.toFixed(4);
        const osUrl = f.url || `https://opensea.io/assets/ethereum/${contract}/${f.token_id}`;
        const tvUrl = `https://traitview.com/?token=${f.token_id}`;
        const embed = new EmbedBuilder()
          .setTitle(`Floor for ${trait}: ${value} — Ξ ${priceStr}`)
          .setColor(0x2dd4bf)
          .setDescription(`**Token:** #${f.token_id}\n**Price:** Ξ ${priceStr}\n\n[OpenSea](${osUrl}) · [TraitView](${tvUrl})`)
          .setFooter({ text: 'on-chain-all-stars · trait floor' })
          .setTimestamp();
        try{
          const imgResult = await resolveImage({ identifier: String(f.token_id) }, contract, 'ethereum');
          if(imgResult?.type === 'buffer'){ const att = new AttachmentBuilder(imgResult.buffer,{name:imgResult.filename}); embed.setThumbnail(`attachment://${imgResult.filename}`); await interaction.editReply({embeds:[embed],files:[att]}); }
          else { if(imgResult?.type==='url') embed.setThumbnail(imgResult.url); await interaction.editReply({embeds:[embed]}); }
        }catch(e){ await interaction.editReply({embeds:[embed]}); }
      }
    }catch(e){ await interaction.editReply('Error: ' + e.message); }
    return;
  }


  // /ocas — smart search for OCAS tokens
  // Supports: token ID, "zombie", "15 traits", "rank 1-100", random
  if(commandName==='ocas'){
    const tokenInput = interaction.options.getInteger('token');
    const rawSearch  = (interaction.options.getString('search') || '').trim();
    const contract   = config.contract || '0x078be86f3104a32313a47815792230a3808642cc';
    const RAILWAY_URL = process.env.RAILWAY_API_URL;
    const API_SECRET  = process.env.API_SECRET;

    await interaction.deferReply();
    try{
      const fmtTrait = s => s.split(' ').map(w => w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');

      // ── Parse search intent ──────────────────────────────────────────────
      let tokenId      = tokenInput || null;
      let traitCount   = null;
      let rankMin      = null, rankMax = null;
      let traitSearch  = null; // free-text trait value to search

      // Detect "floor" modifier anywhere in search
      const wantFloor = /floor/i.test(rawSearch);
      const cleanSearch = rawSearch.replace(/floor/gi, '').trim();

      if(!tokenId && cleanSearch){
        const s = cleanSearch.toLowerCase().trim();

        // 1. Pure number → token ID
        if(/^\d+$/.test(s) && parseInt(s) >= 1 && parseInt(s) <= 10000){
          tokenId = parseInt(s);

        // 2. Trait count patterns: "15 traits", "15 trait", "trait count 15", "traits: 15"
        } else if(/(?:trait\s*count\s*[:\-]?\s*(\d+)|(\d+)\s*traits?)/i.test(cleanSearch)){
          const m = cleanSearch.match(/(?:trait\s*count\s*[:\-]?\s*(\d+)|(\d+)\s*traits?)/i);
          traitCount = parseInt(m[1] || m[2]);

        // 3. Rank range: "rank 1-100", "rank 1 to 100", "top 100"
        } else if(/rank/i.test(s) || /top\s*\d+/i.test(s)){
          const rangeMatch = s.match(/(\d+)\s*[-–to]+\s*(\d+)/);
          const topMatch   = s.match(/top\s*(\d+)/i);
          if(rangeMatch){
            rankMin = parseInt(rangeMatch[1]);
            rankMax = parseInt(rangeMatch[2]);
          } else if(topMatch){
            rankMin = 1;
            rankMax = parseInt(topMatch[1]);
          }

        // 4. Free text → trait value search
        } else {
          traitSearch = cleanSearch;
        }
      }

      // ── Handle rank range ────────────────────────────────────────────────
      if(rankMin && rankMax && RAILWAY_URL){
        const qs = new URLSearchParams({ rank_min: rankMin, rank_max: rankMax, rank_type: 'os', limit: '100' });
        if(API_SECRET) qs.set('key', API_SECRET);
        const r = await fetch(`${RAILWAY_URL}/db/rank-listings?${qs}`);
        if(r.ok){
          const j = await r.json();
          const listings = j.listings || [];
          if(!listings.length){
            await interaction.editReply(`No listings found with OS rank **#${rankMin}–#${rankMax}**.`);
            return;
          }
          // floor = cheapest, otherwise random
          const pick = wantFloor
            ? listings.sort((a,b) => a.price_eth - b.price_eth)[0]
            : listings[Math.floor(Math.random() * listings.length)];
          tokenId = pick.token_id;
        }
      }

      // ── Handle trait value search ─────────────────────────────────────────
      if(!tokenId && traitSearch && RAILWAY_URL){
        // Search DB for tokens matching this value across ALL trait names
        // Use /db/tokens with a broad search — try title-cased value
        const tv = fmtTrait(traitSearch);
        // Query all trait names that have this value via a dedicated search
        // TODO: add /db/trait-search?value=X endpoint for efficiency
        // Fallback: try common trait names with this value
        const commonTraits = ['Type','Hair','Hat Hair','Eye Wear','Eyes','Clothes0','Clothes1',
          'Headwear','Facial Hair','Angel','Ape Teeth','Jewellery0','Jewellery1','Tattoos',
          'Teeth','Smoking','Special 1s'];
        let matchIds = [];
        let matchedTrait = null;
        // Try each trait name — stop at first match with results
        for(const tn of commonTraits){
          const qs = new URLSearchParams({ traits: JSON.stringify({ [tn]: [tv] }), limit: '10000' });
          if(API_SECRET) qs.set('key', API_SECRET);
          const r = await fetch(`${RAILWAY_URL}/db/tokens?${qs}`);
          if(r.ok){
            const j = await r.json();
            if(j.tokens?.length){
              matchIds = j.tokens.map(t => t.id);
              matchedTrait = tn;
              break;
            }
          }
        }
        if(!matchIds.length){
          await interaction.editReply(`No tokens found matching **"${traitSearch}"**. Try a specific trait value like "Zombie", "Skeleton", or "15 traits".`);
          return;
        }
        if(wantFloor && matchedTrait && RAILWAY_URL){
          // Floor = cheapest listed token with this trait
          const tv2 = fmtTrait(traitSearch);
          const fqs = new URLSearchParams({ trait_name: matchedTrait, trait_value: tv2, key: API_SECRET||'' });
          const fr = await fetch(`${RAILWAY_URL}/db/trait-floor?${fqs}`);
          if(fr.ok){
            const fj = await fr.json();
            if(fj.ok && fj.floor){ tokenId = fj.floor.token_id; }
            else { await interaction.editReply(`No listed **${traitSearch}** tokens found.`); return; }
          }
        } else {
          tokenId = matchIds[Math.floor(Math.random() * matchIds.length)];
        }
      }

      // ── Handle trait count ────────────────────────────────────────────────
      if(!tokenId && traitCount !== null && RAILWAY_URL){
        const qs = new URLSearchParams({ traits: JSON.stringify({}), limit: '10000' });
        if(API_SECRET) qs.set('key', API_SECRET);
        // Use /db/tokens — filter by trait_count client-side
        // TODO: add trait_count filter to /db/tokens endpoint for efficiency
        // For now query all and filter
        const r = await fetch(`${RAILWAY_URL}/db/tokens?${new URLSearchParams({limit:'10000', key: API_SECRET||''})}`);
        if(r.ok){
          const j = await r.json();
          // Note: /db/tokens doesn't return trait_count, so use /db/trait-count-floor just to get a valid token
          // Actually use trait-count-floor to get the floor token, then randomise from listings
          // TODO: add /db/tokens?trait_count=X for random (not just floor)
        }
        // Best available: get floor token for this trait count (accurate, fast)
        // trait-count-floor always returns cheapest listed — perfect for floor mode too
        const qs2 = new URLSearchParams({ trait_count: String(traitCount), key: API_SECRET||'' });
        const r2 = await fetch(`${RAILWAY_URL}/db/trait-count-floor?${qs2}`);
        if(r2.ok){
          const j2 = await r2.json();
          if(j2.ok && j2.floor){
            tokenId = j2.floor.token_id;
          } else {
            await interaction.editReply(`No ${wantFloor ? 'listed ' : ''}tokens found with **${traitCount} traits**.`);
            return;
          }
        }
      }

      // ── Fallback to random ────────────────────────────────────────────────
      if(!tokenId) tokenId = Math.floor(Math.random() * 10000) + 1;

      // ── Fetch and post image ──────────────────────────────────────────────
      const nftObj = { identifier: String(tokenId) };
      let imgResult = getCachedImage(`${contract}:${tokenId}`);
      if(!imgResult){
        imgResult = await resolveImage(nftObj, contract, 'ethereum');
        if(imgResult) setCachedImage(`${contract}:${tokenId}`, imgResult);
      }
      const osUrl = `https://opensea.io/assets/ethereum/${contract}/${tokenId}`;
      const tvUrl = `https://traitview.com/?token=${tokenId}`;
      const embed = new EmbedBuilder()
        .setTitle(`OCAS #${tokenId}`)
        .setColor(0x2dd4bf)
        .setDescription(`[OpenSea](${osUrl}) · [TraitView](${tvUrl})`);
      if(imgResult?.type === 'buffer'){
        const att = new AttachmentBuilder(imgResult.buffer, { name: imgResult.filename });
        embed.setImage(`attachment://${imgResult.filename}`);
        await interaction.editReply({ embeds:[embed], files:[att] });
      } else if(imgResult?.type === 'url'){
        embed.setImage(imgResult.url);
        await interaction.editReply({ embeds:[embed] });
      } else {
        embed.setDescription(`[OpenSea](${osUrl}) · [TraitView](${tvUrl})
_Image unavailable_`);
        await interaction.editReply({ embeds:[embed] });
      }
    }catch(e){ await interaction.editReply('Error: ' + e.message); }
    return;
  }

  if(commandName==='help'){
    const adminCmds=[
      '`/setup` - Configure sales channel + collection',
      '`/setlistings` - Set the listings channel',
      '`/setchannel` - Change sales channel',
      '`/setcollection` - Change collection',
      '`/salesfilter` - Filter auto-posted sales by trait',
      '`/listingfilter` - Filter auto-posted listings by trait',
      '`/clearfilters` - Clear all server filters',
      '`/pause` / `/resume` - Pause/resume auto-posts',
      '`/status` - Show server config'
    ].join('\n');
    const ocasGuide = [
      '`/ocas` - Random OCAS token',
      '`/ocas token:1234` - Specific token',
      '`/ocas search:zombie` - Random Zombie',
      '`/ocas search:zombie floor` - Cheapest listed Zombie',
      '`/ocas search:15 traits` - Random 15-trait token',
      '`/ocas search:15 traits floor` - Cheapest listed 15-trait token',
      '`/ocas search:rank 1-100` - Random listed top-100 ranked token',
      '`/ocas search:rank 1-100 floor` - Cheapest listed top-100 ranked token',
    ].join('\n');
    const publicCmds=[
      '`/lastsale` - Most recent sale',
      '`/recentsales count:10` - Last N sales',
      '`/sale token:1234` - Specific token last sale',
      '`/traitfind trait:Type value:Zombie` - Search sales by trait',
      '`/listings count:5` - Recent new listings',
      '`/rankfilter min:1 max:100` - Cheapest listed tokens by OS rank',
      '`/traitfloor trait:Type value:Zombie` - Floor price for a trait',
      '`/traitfloor trait_count:15` - Floor price for trait count',
      '`/myalert trait:Type value:Zombie` - Personal DM alerts',
      '`/myalertclear` - Remove your DM alert',
      '`/myalertstatus` - See your alert settings',
    ].join('\n');
    await interaction.reply({embeds:[new EmbedBuilder().setTitle('NFT Sales Bot - Commands').setColor(0x7aa2ff)
      .addFields(
        {name:'🎨 /ocas — Smart Search', value:ocasGuide, inline:false},
        {name:'Public Commands', value:publicCmds, inline:false},
        {name:'Admin Commands (Manage Server required)', value:adminCmds, inline:false},
      )], flags: MessageFlags.Ephemeral});
    return;
  }
});

// ── Welcome message on server join ────────────────────────────────────────────
client.on('guildCreate', async (guild)=>{
  try{
    // Send welcome DM to server owner only — keeps it private and targeted
    const owner = await guild.fetchOwner().catch(()=>null);
    const target = owner?.user || null;
    if(!target) return;

    const desc=[
      'I post NFT **sales** and **listings** alerts with token images, price, traits, buyer/seller links, and more.',
      '',
      'Works with **any OpenSea collection**. Each server configures independently.'
    ].join('\n');

    const setup=[
      '**Step 1 - Find your collection slug:**',
      'Go to your collection on OpenSea and look at the URL:',
      '`opensea.io/collection/` **your-slug-is-here**',
      'Copy exactly as shown - lowercase, dashes not spaces.',
      '',
      '**Step 2 - Sales channel (go to your sales channel and run):****',
      '`/setuphere collection:your-slug contract:0x...`',
      '',
      '**Step 3 - Listings channel (go to your listings channel and run):**',
      '`/setlistingshere`',
      '',
      '**Step 4 - Test it:**',
      '`/lastsale` and `/listings`',
      '',
      'Works on mobile and desktop!',
      'Tip: `/setup` also works on desktop if you prefer.'
    ].join('\n');

    const channelTip=[
      'Recommended 4-channel setup:',
      '',
      '**#all-sales** - auto-posts every sale (make read-only for members)',
      '**#all-listings** - auto-posts every listing (make read-only for members)',
      '**#sales-search** - members use `/traitfind`, `/recentsales`, `/sale`',
      '**#listings-search** - members use `/listings`',
      '',
      'To make a channel read-only: Channel Settings > Permissions > @everyone > disable Send Messages'
    ].join('\n');

    const personalAlerts=[
      'Anyone can set personal DM alerts with `/myalert`.',
      'They get a private DM when a matching sale or listing happens.',
      '',
      '`/myalert trait:Type value:Zombie sales:true listings:true`',
      '- DM me whenever a Zombie sells or gets listed',
      '',
      '`/myalert trait:Background value:Blue listings:true sales:false`',
      '- DM me only when a Blue Background token gets listed',
      '',
      '`/myalertclear` - Remove your alert',
      '`/myalertstatus` - See your current alert'
    ].join('\n');

    const serverFilters=[
      'Admins can filter what auto-posts to each channel:',
      '',
      '`/salesfilter trait:Type value:Zombie`',
      'Only post sales where Type = Zombie',
      '',
      '`/listingfilter trait:Background value:Blue`',
      'Only post listings where Background = Blue',
      '',
      '`/clearfilters` - Remove all server filters',
      '`/status` - See current configuration'
    ].join('\n');

    const embed = new EmbedBuilder()
      .setTitle('Thanks for adding the NFT Sales Bot!')
      .setColor(0x2dd4bf)
      .setDescription(desc)
      .addFields(
        {name:'Quick Setup (2 minutes)', value:setup, inline:false},
        {name:'Recommended Channel Layout', value:channelTip, inline:false},
        {name:'Personal DM Alerts (anyone can use)', value:personalAlerts, inline:false},
        {name:'Server-Wide Filters (admin only)', value:serverFilters, inline:false}
      )
      .setFooter({text:'Use /help anytime to see all commands'});

    // Try DM to owner first — if DMs are off, post in first available channel
    let sent = false;
    try{
      await target.send({embeds:[embed]});
      console.log('[Welcome] Sent setup DM to owner of '+guild.name);
      sent = true;
    }catch(dmErr){
      console.warn('[Welcome] DM blocked for '+guild.name+', trying channel...');
    }

    if(!sent){
      // Fall back to first channel bot can post in
      const fallbackChannel = guild.channels.cache
        .filter(c => c.type === 0 && c.permissionsFor(guild.members.me)?.has('SendMessages'))
        .sort((a,b) => a.position - b.position)
        .first();
      if(fallbackChannel){
        // Add a note so owner knows it posted publicly
        const publicNote = (embed.data.description||'') + '\n\n*(Setup guide posted here because server owner DMs are off)*';
        const publicEmbed = EmbedBuilder.from(embed).setDescription(publicNote);
        await fallbackChannel.send({embeds:[publicEmbed]});
        console.log('[Welcome] Posted in channel for '+guild.name);
      }
    }
  }catch(e){ console.warn('[Welcome]',guild.name,e.message); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
client.once('clientReady', async ()=>{
  console.log('Bot online as '+client.user.tag);
  console.log('OpenSea key: '+(OPENSEA_KEY?'set':'NOT SET'));
  // Init Railway DB table, then load all persisted state
  await ensureBotStateTable();
  await loadAllConfigs();
  await loadAllAlerts();
  await loadSaleCursors();
  await loadListingCursors();
  console.log('Servers configured: '+Object.keys(serverConfigs).length);
  pollSales();
  pollListings();
  setInterval(pollSales, POLL_MS);
  setInterval(pollListings, POLL_MS);
  // Persist cursors every 60s so restarts lose at most 1 min of cursor progress
  setInterval(saveSaleCursors, 60_000);
  setInterval(saveListingCursors, 60_000);
});

client.on('error',e=>console.error('[Discord]',e.message));
process.on('unhandledRejection',e=>console.error('[Bot]',e));
client.login(DISCORD_TOKEN);
