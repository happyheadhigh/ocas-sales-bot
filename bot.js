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

// ── Brand colors ──────────────────────────────────────────────────────────────
const COLORS = {
  OCAS_BG:       0x4C6464,
  OCAS_GREEN:    0x1CFFAF,
  OPENSEA_BLUE:  0x0786FF,
  RANK_TOP_100:  0xF59E0B,
  RANK_TOP_1000: 0xC758FF,
  WETH_ROSE:     0xF43F5E,
};

function getRankTierColor(osRank){
  const n = Number(osRank);
  if(!n || !Number.isFinite(n)) return null;
  if(n >= 1 && n <= 100)  return COLORS.RANK_TOP_100;
  if(n >= 101 && n <= 1000) return COLORS.RANK_TOP_1000;
  return null;
}

// ── Burn Machine ──────────────────────────────────────────────────────────────
const BURN_CONTRACT = '0x1095c73C337CC5e03f9E1D426c524CC3e32a50f6';
const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const BURN_START_BLOCK = process.env.BURN_START_BLOCK ? parseInt(process.env.BURN_START_BLOCK, 10) : null;
const BURN_BACKFILL_ALERTS = String(process.env.BURN_BACKFILL_ALERTS || 'false').toLowerCase() === 'true';
const BURN_BLOCK_CHUNK = Math.max(1, parseInt(process.env.BURN_BLOCK_CHUNK || '2000', 10));
const BURN_COLORS = {
  FIRE:        0xFF6B00, // default burn embed
  RADIOACTIVE: 0x39FF14, // radioactive type
  ZOMBIE:      0x7CFC00, // zombie type
  SKELETON:    0xC0C0C0, // skeleton type
  HUMAN:       0xFF6B00, // human type (same as fire)
  ANGEL:       0xFFD700, // angel variant
};
// E_1_Type enum — confirmed from on-chain events and contract source
// 0=Human, 1=Zombie, 2=Skeleton, 3=Radioactive (angel variants overlap)
const E1_TYPE_NAMES = { 0:'Human', 1:'Zombie', 2:'Skeleton', 3:'Radioactive', 4:'Angel' };
function burnTypeLabel(bodyType, isAngel){
  const base = E1_TYPE_NAMES[bodyType] || ('Type '+bodyType);
  return isAngel ? base+' Angel' : base;
}
function burnTypeColor(bodyType, isAngel){
  if(isAngel) return BURN_COLORS.ANGEL;
  switch(Number(bodyType)){
    case 3: return BURN_COLORS.RADIOACTIVE;
    case 2: return BURN_COLORS.SKELETON;
    case 1: return BURN_COLORS.ZOMBIE;
    default: return BURN_COLORS.HUMAN;
  }
}
function burnTypeEmoji(bodyType, isAngel){
  if(isAngel) return '😇';
  switch(Number(bodyType)){
    case 3: return '☢️';
    case 2: return '💀';
    case 1: return '🧟';
    default: return '🔥';
  }
}
function normAddr(addr){
  const s = String(addr || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : '';
}

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
    // Burn events tables
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS burn_events (
        id               SERIAL PRIMARY KEY,
        tx_hash          TEXT NOT NULL,
        block_number     BIGINT NOT NULL,
        log_index        INT NOT NULL,
        burner_wallet    TEXT NOT NULL,
        survivor_token_id INT NOT NULL,
        result_body_type  INT,
        result_is_angel   BOOLEAN DEFAULT FALSE,
        points_used       INT,
        boost_chance      INT,
        burn_seed         TEXT,
        burned_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgPool.query(`ALTER TABLE burn_events DROP CONSTRAINT IF EXISTS burn_events_tx_hash_key`);
    await pgPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS burn_events_tx_log_idx ON burn_events(tx_hash, log_index)
    `);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS burn_event_inputs (
        id              SERIAL PRIMARY KEY,
        burn_event_id   INT NOT NULL REFERENCES burn_events(id) ON DELETE CASCADE,
        burned_token_id INT NOT NULL
      )
    `);
    await pgPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS burn_event_inputs_event_token_idx
      ON burn_event_inputs(burn_event_id, burned_token_id)
    `);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS burn_started_events (
        id                SERIAL PRIMARY KEY,
        tx_hash           TEXT NOT NULL,
        block_number      BIGINT NOT NULL,
        log_index         INT NOT NULL,
        owner_wallet      TEXT NOT NULL,
        survivor_token_id INT NOT NULL,
        points_used       INT,
        result_body_type  INT,
        result_is_angel   BOOLEAN DEFAULT FALSE,
        boost_chance      INT,
        reveal_block      BIGINT,
        selection_hash    TEXT,
        started_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS burn_started_tx_log_idx ON burn_started_events(tx_hash, log_index)
    `);
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS burn_started_survivor_idx ON burn_started_events(survivor_token_id)
    `);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS burn_started_inputs (
        id              SERIAL PRIMARY KEY,
        burn_started_id INT NOT NULL REFERENCES burn_started_events(id) ON DELETE CASCADE,
        burned_token_id INT NOT NULL
      )
    `);
    await pgPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS burn_started_inputs_event_token_idx
      ON burn_started_inputs(burn_started_id, burned_token_id)
    `);
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS burn_events_burner_idx ON burn_events(burner_wallet)
    `);
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS burn_events_survivor_idx ON burn_events(survivor_token_id)
    `);
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS burn_inputs_token_idx ON burn_event_inputs(burned_token_id)
    `);
    console.log('[DB] burn tables ready');
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
const recentChannelPosts = new Map(); // dedup: channelId+tokenId → timestamp, prevents double-posting
function isRecentChannelPost(channelId, tokenId, windowMs=180000){
  const key = channelId + ':' + tokenId;
  const last = recentChannelPosts.get(key);
  if(last && Date.now() - last < windowMs) return true;
  recentChannelPosts.set(key, Date.now());
  // Prune old entries every 500 posts
  if(recentChannelPosts.size > 500){ const cutoff=Date.now()-windowMs; for(const [k,v] of recentChannelPosts) if(v<cutoff) recentChannelPosts.delete(k); }
  return false;
}
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
const ocasTraitsCache = new Map(); // tokenId → {traits, expires}

// ── Hoisted trait parser helpers (shared by /ocas and /sweep) ───────────────
const sweepSessions = new Map(); // sessionId → { listings, page }

// ── Burn machine config (stored per-guild via bot_state) ─────────────────────
// burnConfig: { channelId, lastBlock }
let burnConfig = {}; // guildId → { channelId }
async function loadBurnConfig(){
  const db = await dbLoad('burn_config');
  if(db){ burnConfig = db; console.log('[Burn] Config loaded'); }
}
async function saveBurnConfig(){
  await dbSave('burn_config', burnConfig);
}
function getBurnConfig(guildId){ return burnConfig[guildId] || null; }

function normalizePhrase(s){
  return String(s||"").toLowerCase().replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}

async function getTraitIndex(RAILWAY_URL, API_SECRET){
  const now = Date.now();
  if(global.__ocasTraitIndexCache && now - global.__ocasTraitIndexCache.ts < 60*60*1000)
    return global.__ocasTraitIndexCache.items;
  if(!RAILWAY_URL) return [];
  const qs = new URLSearchParams({ key: API_SECRET||"" });
  const r = await fetch(`${RAILWAY_URL}/db/trait-index?${qs}`);
  if(!r.ok) throw new Error(`trait-index API HTTP ${r.status}`);
  const j = await r.json();
  if(!j.ok) throw new Error(j.error||"trait-index API error");
  const items = (j.traits||[])
    .map(t => ({ trait_name:t.trait_name, trait_value:t.trait_value, token_count:Number(t.token_count||0), norm:normalizePhrase(t.trait_value) }))
    .filter(t => t.norm)
    .sort((a,b) => {
      const aw=a.norm.split(" ").length, bw=b.norm.split(" ").length;
      if(bw!==aw) return bw-aw;
      if(b.norm.length!==a.norm.length) return b.norm.length-a.norm.length;
      return (b.token_count||0)-(a.token_count||0);
    });
  global.__ocasTraitIndexCache = { ts:now, items };
  return items;
}

function chooseTraitGroupsFromQuery(search, traitIndex){
  let remaining = ` ${normalizePhrase(search)} `;
  const groups=[], unmatched=[], seenNorms=new Set();
  const byNorm = new Map();
  for(const item of traitIndex){
    if(!byNorm.has(item.norm)) byNorm.set(item.norm,[]);
    byNorm.get(item.norm).push(item);
  }
  const phrases = [...byNorm.keys()].sort((a,b)=>{
    const aw=a.split(" ").length, bw=b.split(" ").length;
    if(bw!==aw) return bw-aw;
    return b.length-a.length;
  });
  for(const phrase of phrases){
    if(seenNorms.has(phrase)) continue;
    const re = new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\\]\\]/g,"\\$&")}(?=\\s|$)`,"i");
    if(re.test(remaining)){
      const alts = byNorm.get(phrase).sort((a,b)=>(b.token_count||0)-(a.token_count||0)).map(x=>({trait_name:x.trait_name,trait_value:x.trait_value}));
      groups.push(alts);
      seenNorms.add(phrase);
      remaining = remaining.replace(re," ").replace(/\s+/g," ");
    }
  }
  let leftover = normalizePhrase(remaining).split(" ").filter(Boolean).filter(w=>!["and","with","plus"].includes(w));
  for(const word of leftover.slice()){
    if(word.length<3) continue;
    const re = new RegExp(`(^|\\s)${word.replace(/[.*+?^${}()|[\\]\\]/g,"\\$&")}(?=\\s|$)`,"i");
    const alts = traitIndex.filter(x=>re.test(x.norm)).slice(0,25);
    if(alts.length && alts.length<=12){
      groups.push(alts.map(x=>({trait_name:x.trait_name,trait_value:x.trait_value})));
      leftover = leftover.filter(w=>w!==word);
    }
  }
  unmatched.push(...leftover);
  return { groups, unmatched };
}

function getSweepTokenId(item){
  return item?.token_id ?? item?.id ?? item?.identifier ?? item?.tokenId ?? item?.tokenID ?? null;
}

function normalizeSweepListing(item){
  const tokenId = getSweepTokenId(item);
  return {
    token_id: tokenId ? parseInt(tokenId) : null,
    price_eth: item?.price_eth != null ? parseFloat(item.price_eth) : null,
    url: item?.url || null,
    os_rank: item?.os_rank ? parseInt(item.os_rank) : null,
    obs_rank: item?.obs_rank ? parseInt(item.obs_rank) : null,
    trait_count: item?.trait_count ? parseInt(item.trait_count) : null
  };
}

function sweepTokenUrl(item){
  const tokenId = getSweepTokenId(item);
  const contract = '0x078be86f3104a32313a47815792230a3808642cc';
  return tokenId ? ('https://opensea.io/assets/ethereum/' + contract + '/' + tokenId) : 'https://opensea.io/collection/on-chain-all-stars';
}

function formatSweepTokenLine(item){
  const tokenId = getSweepTokenId(item);
  const rank = item?.os_rank ? ('⬥' + Number(item.os_rank).toLocaleString()) : (item?.obs_rank ? ('⬥' + Number(item.obs_rank).toLocaleString()) : null);
  const tokenLink = '[#' + tokenId + '](' + sweepTokenUrl(item) + ')';
  const price = 'Ξ ' + parseFloat(item.price_eth).toFixed(4);
  return [tokenLink, rank, price].filter(Boolean).join(' · ');
}


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

let cachedOpenSeaItems = { value: null, expires: 0 };
async function fetchOpenSeaItemCount(slug='on-chain-all-stars') {
  if(cachedOpenSeaItems.expires > Date.now()) return cachedOpenSeaItems.value;
  try {
    const r = await fetch(
      `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`,
      { headers: osHeaders() }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const value = j?.total?.supply ?? j?.total?.count ?? j?.total?.items
      ?? j?.stats?.total_supply ?? j?.stats?.count ?? j?.stats?.num_items ?? null;
    const n = value == null ? null : parseInt(value, 10);
    cachedOpenSeaItems = { value: Number.isFinite(n) ? n : null, expires: Date.now() + 10 * 60 * 1000 };
    return cachedOpenSeaItems.value;
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

// ── Burn Machine poller ──────────────────────────────────────────────────────
// Uses Alchemy JSON-RPC to poll for BurnFinalized + BurnStarted events.
// BurnStarted: stores burned token IDs + owner (commit phase)
// BurnFinalized: cross-references BurnStarted, posts embed (reveal phase)

const BURN_STARTED_TOPIC   = '0x' + require('crypto').createHash('sha256').update('').digest('hex').slice(0,0)
  || null; // computed at runtime below

// Event topic signatures (keccak256 of event signature)
// BurnStarted(address,uint256,uint256,uint256[],uint16,uint8,bool,uint8,uint64,bytes32)
// BurnFinalized(uint256,uint256,uint256,uint16,uint8,bool,uint8)
// We compute these inline using ethers-style manual topic matching via log.topics[0]
const BURN_STARTED_SIG   = 'BurnStarted(address,uint256,uint256,uint256[],uint16,uint8,bool,uint8,uint64,bytes32)';
const BURN_FINALIZED_SIG = 'BurnFinalized(uint256,uint256,uint256,uint16,uint8,bool,uint8)';

// Correct keccak256 topic hashes — computed from actual event signatures
// BurnStarted(address,uint256,uint256,uint256[],uint16,uint8,bool,uint8,uint64,bytes32)
const TOPIC_BURN_STARTED   = '0x4dd367d2c410889fbff76f34abdefdceb947ad0c58baaf327ead8ac9d6a38c22';
// BurnFinalized(uint256,uint256,uint256,uint16,uint8,bool,uint8)
const TOPIC_BURN_FINALIZED = '0x4c7b2090df533e8b1f7bd4ab01aadb95fedf5006f15ff4300c1709b97c4c6d5e';

// ABI fragments for decoding
const BURN_STARTED_ABI = [
  'event BurnStarted(address indexed owner, uint256 indexed survivorTokenId, uint256 indexed survivorTokenIdSeed, uint256[] tokenIds, uint16 points, uint8 resultBodyType, bool resultIsAngel, uint8 boostChance, uint64 revealBlock, bytes32 selectionHash)'
];
const BURN_FINALIZED_ABI = [
  'event BurnFinalized(uint256 indexed survivorTokenId, uint256 indexed survivorTokenIdSeed, uint256 burnSeed, uint16 points, uint8 resultBodyType, bool resultIsAngel, uint8 boostChance)'
];

async function getBurnAlertChannel(){
  // Find first guild with burn channel configured
  for(const guildId of Object.keys(burnConfig)){
    const bc = burnConfig[guildId];
    if(bc?.channelId){
      const ch = client.channels.cache.get(bc.channelId);
      if(ch) return ch;
    }
  }
  return null;
}

async function buildBurnEmbed(finalEvent, startEvent){
  const survivorId   = finalEvent.survivorTokenId;
  const bodyType     = finalEvent.resultBodyType;
  const isAngel      = finalEvent.resultIsAngel;
  const points       = finalEvent.points;
  const burnerWallet = startEvent?.owner || 'unknown';
  const burnedIds    = startEvent?.tokenIds || [];
  const txHash       = finalEvent.txHash || '';

  const burnTierLabel = burnTypeLabel(bodyType, isAngel);
  const color     = burnTypeColor(bodyType, isAngel);

  const contract  = OCAS_CONTRACT;
  const osUrl     = `https://opensea.io/assets/ethereum/${contract}/${survivorId}`;
  const tvUrl     = `https://traitview.com/?token=${survivorId}`;
  const etherscan = txHash ? `https://etherscan.io/tx/${txHash}` : null;
  const burnerLink = burnerWallet !== 'unknown'
    ? `[${shortAddr(burnerWallet)}](https://opensea.io/${burnerWallet})`
    : 'unknown';

  const burnedStr = burnedIds.length
    ? burnedIds.slice(0,20).map(id => `#${id}`).join(', ') + (burnedIds.length > 20 ? ` +${burnedIds.length-20} more` : '')
    : 'unknown';

  // Fetch DB metadata for the created token — traits + OS rank
  const dbMeta = await fetchCreatedTokenMeta(survivorId).catch(()=>null);
  const osRank = dbMeta?.os_rank ? Number(dbMeta.os_rank) : null;
  const rankBadge = osRank ? ` #${osRank.toLocaleString()}` : '';
  const actualType = dbMeta?.traits?.Type || dbMeta?.traits?.type || null;

  // Fetch created token image
  let imgResult = getCachedImage(`${contract}:${survivorId}`);
  if(!imgResult){
    try{
      imgResult = await resolveImage({identifier:String(survivorId)}, contract, 'ethereum');
      if(imgResult) setCachedImage(`${contract}:${survivorId}`, imgResult);
    }catch(e){ console.warn('[Burn embed image]', e.message); }
  }

  const embed = new EmbedBuilder()
    .setTitle('OCAS Burn')
    .setColor(color)
    .setURL(osUrl)
    .setDescription(`#${survivorId} was created from ${burnedIds.length || '?'} burned OCAS.`)
    .addFields(
      { name:'Created Token', value:`[#${survivorId}${rankBadge}](${osUrl})`, inline:true },
      { name:'Result Type',   value:actualType || 'Traits updating - check again shortly', inline:true },
      { name:'Points Used',   value:String(points || 0),                       inline:true },
      { name:'Burn Tier',     value:burnTierLabel,                              inline:true },
      { name:'Burner',        value:burnerLink,                                 inline:true },
      { name:'Tokens Burned', value:String(burnedIds.length || '?'),           inline:true },
      { name:'Burned IDs',    value:burnedStr,                                  inline:false },
    );

  // Add traits of the created token if available
  if(dbMeta?.traits && Object.keys(dbMeta.traits).length){
    const traitLines = Object.entries(dbMeta.traits).slice(0,12).map(([k,v])=>`**${k}:** ${v}`);
    const half = Math.ceil(traitLines.length/2);
    embed.addFields(
      { name:'Traits', value:traitLines.slice(0,half).join('\n'),    inline:true },
      { name:'More Traits', value:traitLines.slice(half).join('\n')||' ', inline:true },
    );
  } else {
    embed.addFields({ name:'Traits', value:'Traits updating - check TraitView/OpenSea shortly.', inline:false });
  }

  const linkParts = [`[OpenSea](${osUrl})`, `[TraitView](${tvUrl})`];
  if(etherscan) linkParts.push(`[Etherscan](${etherscan})`);
  embed.addFields({ name:'Links', value:linkParts.join(' | '), inline:false });
  embed.setFooter({ text:'OCAS Burn Machine' }).setTimestamp();

  embed._imageResult = imgResult || null;
  return embed;
}

// Pending burn map: survivorTokenId → { owner, tokenIds, points, resultBodyType, resultIsAngel, boostChance, blockNumber, txHash }
function shortenBurnedIds(ids, max=6){
  const clean = (ids || []).filter(Boolean).map(id => `#${id}`);
  if(clean.length <= max) return clean.join(', ') || 'unknown';
  return clean.slice(0, max).join(', ') + ` +${clean.length - max} more`;
}

async function formatRecentBurnLine(row, index){
  const tokenId = parseInt(row.survivor_token_id);
  const burnedIds = (row.burned_ids || []).filter(Boolean);
  const dbMeta = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
  const actualType = dbMeta?.traits?.Type || dbMeta?.traits?.type || 'traits updating';
  const burnTier = row.result_body_type != null ? burnTypeLabel(row.result_body_type, row.result_is_angel) : 'unknown';
  const ago = row.burned_at ? timeSince(Math.floor(new Date(row.burned_at).getTime()/1000)) : '?';
  const osUrl = `https://opensea.io/assets/ethereum/${OCAS_CONTRACT}/${tokenId}`;
  const tvUrl = `https://traitview.com/?token=${tokenId}`;
  const txUrl = row.tx_hash ? `https://etherscan.io/tx/${row.tx_hash}` : null;
  const links = [`[TraitView](${tvUrl})`];
  if(txUrl) links.push(`[Tx](${txUrl})`);
  return [
    `**${index}. [#${tokenId}](${osUrl})** - ${actualType}`,
    `Burn Tier: ${burnTier} | Burned: ${burnedIds.length || '?'} | Burner: ${shortAddr(row.burner_wallet)}`,
    `Burned IDs: ${shortenBurnedIds(burnedIds)}`,
    `${links.join(' | ')} | ${ago}`,
  ].join('\n');
}

async function buildRecentBurnsEmbed(rows, startIndex=1, title='Recent OCAS Burns'){
  const lines = [];
  for(let i=0;i<rows.length;i++) lines.push(await formatRecentBurnLine(rows[i], startIndex + i));
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(BURN_COLORS.FIRE)
    .setDescription(lines.join('\n\n') || 'No burn events recorded yet.')
    .setFooter({ text:'OCAS Burn Machine' })
    .setTimestamp();
}

const pendingBurns = new Map();

async function storeBurnStarted(event){
  try{
    // Cache in memory for cross-referencing with BurnFinalized
    pendingBurns.set(String(event.survivorTokenId), {
      owner:         event.owner,
      tokenIds:      event.tokenIds.map(Number),
      points:        event.points,
      resultBodyType: event.resultBodyType,
      resultIsAngel: event.resultIsAngel,
      boostChance:   event.boostChance,
      blockNumber:   event.blockNumber,
      logIndex:       event.logIndex,
      txHash:        event.txHash,
    });
    const r = await pgPool.query(
      `INSERT INTO burn_started_events
         (tx_hash, block_number, log_index, owner_wallet, survivor_token_id,
          points_used, result_body_type, result_is_angel, boost_chance, reveal_block, selection_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tx_hash, log_index) DO UPDATE SET
          owner_wallet=EXCLUDED.owner_wallet,
          survivor_token_id=EXCLUDED.survivor_token_id,
          points_used=EXCLUDED.points_used,
          result_body_type=EXCLUDED.result_body_type,
          result_is_angel=EXCLUDED.result_is_angel,
          boost_chance=EXCLUDED.boost_chance,
          reveal_block=EXCLUDED.reveal_block,
          selection_hash=EXCLUDED.selection_hash
       RETURNING id`,
      [
        event.txHash || '', event.blockNumber || 0, event.logIndex || 0,
        normAddr(event.owner) || event.owner || '', event.survivorTokenId,
        event.points, event.resultBodyType, event.resultIsAngel,
        event.boostChance, event.revealBlock || null, event.selectionHash || null,
      ]
    );
    const burnStartedId = r.rows[0]?.id;
    if(burnStartedId){
      for(const tokenId of event.tokenIds || []){
        await pgPool.query(
          `INSERT INTO burn_started_inputs (burn_started_id, burned_token_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [burnStartedId, tokenId]
        ).catch(()=>{});
      }
    }
  }catch(e){ console.warn('[Burn] storeBurnStarted error:', e.message); }
}

async function storeBurnFinalized(finalEvent, startEvent){
  try{
    const burnedIds = startEvent?.tokenIds || [];
    const r = await pgPool.query(
      `INSERT INTO burn_events
         (tx_hash, block_number, log_index, burner_wallet, survivor_token_id,
          result_body_type, result_is_angel, points_used, boost_chance, burn_seed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tx_hash, log_index) DO UPDATE SET
          block_number=EXCLUDED.block_number,
          burner_wallet=EXCLUDED.burner_wallet,
          survivor_token_id=EXCLUDED.survivor_token_id,
          result_body_type=EXCLUDED.result_body_type,
          result_is_angel=EXCLUDED.result_is_angel,
          points_used=EXCLUDED.points_used,
          boost_chance=EXCLUDED.boost_chance,
          burn_seed=EXCLUDED.burn_seed
       RETURNING id`,
      [
        finalEvent.txHash || '', finalEvent.blockNumber || 0, finalEvent.logIndex || 0,
        startEvent?.owner || '', finalEvent.survivorTokenId,
        finalEvent.resultBodyType, finalEvent.resultIsAngel,
        finalEvent.points, finalEvent.boostChance,
        String(finalEvent.burnSeed || ''),
      ]
    );
    if(r.rows.length && burnedIds.length){
      const burnEventId = r.rows[0].id;
      for(const tokenId of burnedIds){
        await pgPool.query(
          `INSERT INTO burn_event_inputs (burn_event_id, burned_token_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [burnEventId, tokenId]
        ).catch(()=>{});
      }
    }
  }catch(e){ console.warn('[Burn] storeBurnFinalized DB error:', e.message); }
}

async function pollBurnEventsLegacy(){
  if(!process.env.ALCHEMY_API_KEY && !process.env.ALCHEMY_WEBSOCKET_URL) return;
  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
  const rpcUrl = process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://','https://') ||
    `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

  try{
    const lastBlockRaw = await dbLoad('burn_last_block');
    let fromBlock = lastBlockRaw ? parseInt(lastBlockRaw) + 1 : null;

    if(!fromBlock){
      const r = await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]})});
      const j = await r.json();
      fromBlock = Math.max(0, parseInt(j.result,16) - 2000);
      console.log('[Burn] First run, starting from block', fromBlock);
    }

    const r2 = await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]})});
    const j2 = await r2.json();
    const toBlock = parseInt(j2.result,16);
    if(fromBlock >= toBlock) return;

    const logsRes = await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_getLogs',params:[{
        address: BURN_CONTRACT,
        fromBlock: '0x'+fromBlock.toString(16),
        toBlock:   '0x'+toBlock.toString(16),
        // Filter for only our two event topics
        topics: [[TOPIC_BURN_STARTED, TOPIC_BURN_FINALIZED]],
      }]})});
    const logsJson = await logsRes.json();
    const logs = logsJson.result || [];
    if(logsJson.error) throw new Error('eth_getLogs error: ' + JSON.stringify(logsJson.error));

    if(logs.length) console.log(`[Burn] ${logs.length} log(s) in blocks ${fromBlock}→${toBlock}`);

    // ── Pass 1: process BurnStarted — store pending burns ─────────────────
    for(const log of logs){
      if(log.topics[0]?.toLowerCase() !== TOPIC_BURN_STARTED) continue;
      // BurnStarted topics: [topic0, owner(indexed), survivorTokenId(indexed), survivorTokenIdSeed(indexed)]
      // data: tokenIds[], points, resultBodyType, resultIsAngel, boostChance, revealBlock, selectionHash
      try{
        const owner           = '0x' + log.topics[1].slice(26);
        const survivorTokenId = parseInt(log.topics[2], 16);
        const txHash          = log.transactionHash;
        const blockNum        = parseInt(log.blockNumber, 16);
        const data            = log.data.slice(2);
        const words           = [];
        for(let i=0;i<data.length;i+=64) words.push(data.slice(i,i+64));

        // ABI: data starts with offset to tokenIds[] dynamic array
        // word[0] = offset (bytes) to start of tokenIds array = 0xe0 = 224 = 7*32
        // word[1..6] = 6 static params (points, bodyType, isAngel, boostChance, revealBlock, selectionHash)
        // BUT: dynamic array comes FIRST in data for this event
        // Actual layout: offset_to_array | points | bodyType | isAngel | boostChance | revealBlock | selectionHash | array_len | array_items...
        const offset   = parseInt(words[0]||'0', 16); // byte offset = 0xe0 = 224 → word index 7
        const arrWord  = offset / 32;                 // = 7
        const arrLen   = parseInt(words[arrWord]||'0', 16);
        const tokenIds = [];
        for(let i=0;i<arrLen;i++) tokenIds.push(parseInt(words[arrWord+1+i]||'0',16));

        // Static params are words 1..6 (before the array)
        const points      = parseInt(words[1]||'0',16);
        const bodyType    = parseInt(words[2]||'0',16);
        const isAngel     = parseInt(words[3]||'0',16) === 1;
        const boostChance = parseInt(words[4]||'0',16);

        await storeBurnStarted({ owner, survivorTokenId, tokenIds, points,
          resultBodyType: bodyType, resultIsAngel: isAngel, boostChance, blockNumber: blockNum, txHash });
        console.log(`[Burn] BurnStarted: #${survivorTokenId} ← [${tokenIds.join(',')}] by ${shortAddr(owner)} pts=${points} type=${bodyType}`);
      }catch(e){ console.warn('[Burn] BurnStarted decode error:', e.message, 'topics:', log.topics, 'data:', log.data?.slice(0,130)); }
    }

    // ── Pass 2: process BurnFinalized — post embeds ────────────────────────
    for(const log of logs){
      if(log.topics[0]?.toLowerCase() !== TOPIC_BURN_FINALIZED) continue;
      // BurnFinalized topics: [topic0, survivorTokenId(indexed), survivorTokenIdSeed(indexed)]
      // data: burnSeed, points, resultBodyType, resultIsAngel, boostChance
      try{
        const survivorTokenId = parseInt(log.topics[1], 16);
        const txHash          = log.transactionHash;
        const blockNum        = parseInt(log.blockNumber, 16);
        const logIndex        = parseInt(log.logIndex, 16);
        const data            = log.data.slice(2);
        const words           = [];
        for(let i=0;i<data.length;i+=64) words.push(data.slice(i,i+64));

        // data layout: burnSeed | points | resultBodyType | resultIsAngel | boostChance
        const burnSeed    = words[0] || '';
        const points      = parseInt(words[1]||'0',16);
        const bodyType    = parseInt(words[2]||'0',16);
        const isAngel     = parseInt(words[3]||'0',16) === 1;
        const boostChance = parseInt(words[4]||'0',16);

        console.log(`[Burn] BurnFinalized raw: #${survivorTokenId} bodyType=${bodyType} isAngel=${isAngel} points=${points}`);

        // Check duplicate
        const existing = await pgPool.query(
          'SELECT id FROM burn_events WHERE tx_hash=$1 AND log_index=$2', [txHash, logIndex]
        );
        if(existing.rows.length){ console.log(`[Burn] Already stored tx ${txHash.slice(0,10)} log=${logIndex}`); continue; }

        // Cross-reference with BurnStarted data
        const startEvent = pendingBurns.get(String(survivorTokenId)) ||
          await loadBurnStartFromDB(survivorTokenId);

        if(!startEvent) console.warn(`[Burn] No BurnStarted found for survivor #${survivorTokenId} — embed will show unknown burner/burned IDs`);

        const finalEvent = { survivorTokenId, burnSeed, points, resultBodyType: bodyType,
          resultIsAngel: isAngel, boostChance, txHash, blockNumber: blockNum, logIndex };

        await storeBurnFinalized(finalEvent, startEvent);
        console.log(`[Burn] BurnFinalized: #${survivorTokenId} → ${burnTypeLabel(bodyType,isAngel)} burned=[${startEvent?.tokenIds?.join(',')||'?'}]`);

        const burnChannel = await getBurnAlertChannel();
        if(burnChannel){
          const embed = await buildBurnEmbed(finalEvent, startEvent);
          await sendEmbed(burnChannel, embed);
        }
        pendingBurns.delete(String(survivorTokenId));
      }catch(e){ console.warn('[Burn] BurnFinalized error:', e.message); }
    }

    await dbSave('burn_last_block', String(toBlock));
  }catch(e){ console.error('[Burn poller]', e.message); }
}

async function burnRpc(rpcUrl, method, params){
  const r = await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:Date.now(),method,params})});
  const j = await r.json();
  if(j.error) throw new Error(`${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function processBurnLogs(logs, shouldAlert){
  if(logs.length) console.log(`[Burn] processing ${logs.length} log(s), alerts=${shouldAlert ? 'on' : 'off'}`);

  for(const log of logs){
    if(log.topics[0]?.toLowerCase() !== TOPIC_BURN_STARTED) continue;
    try{
      const owner           = normAddr('0x' + log.topics[1].slice(26));
      const survivorTokenId = parseInt(log.topics[2], 16);
      const txHash          = String(log.transactionHash || '').toLowerCase();
      const blockNum        = parseInt(log.blockNumber, 16);
      const logIndex        = parseInt(log.logIndex, 16);
      const data            = log.data.slice(2);
      const words           = [];
      for(let i=0;i<data.length;i+=64) words.push(data.slice(i,i+64));

      const offset   = parseInt(words[0]||'0', 16);
      const arrWord  = offset / 32;
      const arrLen   = parseInt(words[arrWord]||'0', 16);
      const tokenIds = [];
      for(let i=0;i<arrLen;i++) tokenIds.push(parseInt(words[arrWord+1+i]||'0',16));

      const points        = parseInt(words[1]||'0',16);
      const bodyType      = parseInt(words[2]||'0',16);
      const isAngel       = parseInt(words[3]||'0',16) === 1;
      const boostChance   = parseInt(words[4]||'0',16);
      const revealBlock   = parseInt(words[5]||'0',16);
      const selectionHash = words[6] ? '0x' + words[6] : null;

      await storeBurnStarted({ owner, survivorTokenId, tokenIds, points,
        resultBodyType: bodyType, resultIsAngel: isAngel, boostChance,
        revealBlock, selectionHash, blockNumber: blockNum, logIndex, txHash });
      console.log(`[Burn] BurnStarted: #${survivorTokenId} <- [${tokenIds.join(',')}] by ${shortAddr(owner)} pts=${points} tier=${bodyType}`);
    }catch(e){ console.warn('[Burn] BurnStarted decode error:', e.message, 'topics:', log.topics, 'data:', log.data?.slice(0,130)); }
  }

  for(const log of logs){
    if(log.topics[0]?.toLowerCase() !== TOPIC_BURN_FINALIZED) continue;
    try{
      const survivorTokenId = parseInt(log.topics[1], 16);
      const txHash          = String(log.transactionHash || '').toLowerCase();
      const blockNum        = parseInt(log.blockNumber, 16);
      const logIndex        = parseInt(log.logIndex, 16);
      const data            = log.data.slice(2);
      const words           = [];
      for(let i=0;i<data.length;i+=64) words.push(data.slice(i,i+64));

      const burnSeed    = words[0] || '';
      const points      = parseInt(words[1]||'0',16);
      const bodyType    = parseInt(words[2]||'0',16);
      const isAngel     = parseInt(words[3]||'0',16) === 1;
      const boostChance = parseInt(words[4]||'0',16);

      const existing = await pgPool.query(
        'SELECT id FROM burn_events WHERE tx_hash=$1 AND log_index=$2', [txHash, logIndex]
      );
      if(existing.rows.length){ console.log(`[Burn] Already stored tx ${txHash.slice(0,10)} log=${logIndex}`); continue; }

      const startEvent = pendingBurns.get(String(survivorTokenId)) ||
        await loadBurnStartFromDB(survivorTokenId);
      if(!startEvent) console.warn(`[Burn] No BurnStarted found for survivor #${survivorTokenId} - embed will show unknown burner/burned IDs`);

      const finalEvent = { survivorTokenId, burnSeed, points, resultBodyType: bodyType,
        resultIsAngel: isAngel, boostChance, txHash, blockNumber: blockNum, logIndex };

      await storeBurnFinalized(finalEvent, startEvent);
      console.log(`[Burn] BurnFinalized: #${survivorTokenId} tier=${burnTypeLabel(bodyType,isAngel)} burned=[${startEvent?.tokenIds?.join(',')||'?'}]`);

      if(shouldAlert){
        const burnChannel = await getBurnAlertChannel();
        if(burnChannel){
          const embed = await buildBurnEmbed(finalEvent, startEvent);
          await sendEmbed(burnChannel, embed);
        }
      }
      pendingBurns.delete(String(survivorTokenId));
    }catch(e){ console.warn('[Burn] BurnFinalized error:', e.message); }
  }
}

async function pollBurnEvents(){
  if(!process.env.ALCHEMY_API_KEY && !process.env.ALCHEMY_WEBSOCKET_URL) return;
  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
  const rpcUrl = process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://','https://') ||
    `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

  try{
    const lastBlockRaw = await dbLoad('burn_last_block');
    const latest = parseInt(await burnRpc(rpcUrl, 'eth_blockNumber', []), 16);
    let fromBlock = lastBlockRaw ? parseInt(lastBlockRaw, 10) + 1 : null;
    let historicalBackfill = false;

    if(!fromBlock){
      if(Number.isFinite(BURN_START_BLOCK) && BURN_START_BLOCK >= 0){
        fromBlock = BURN_START_BLOCK;
        historicalBackfill = true;
        console.log(`[Burn] No burn_last_block; starting historical backfill from BURN_START_BLOCK=${fromBlock}`);
      } else {
        fromBlock = Math.max(0, latest - 2000);
        historicalBackfill = true;
        console.warn(`[Burn] BURN_START_BLOCK missing; safe fallback starts at latest-2000 (${fromBlock}). Set BURN_START_BLOCK for full historical backfill.`);
      }
    }

    if(fromBlock > latest) return;

    let cursor = fromBlock;
    while(cursor <= latest){
      const chunkTo = Math.min(latest, cursor + BURN_BLOCK_CHUNK - 1);
      const logs = await burnRpc(rpcUrl, 'eth_getLogs', [{
        address: BURN_CONTRACT,
        fromBlock: '0x'+cursor.toString(16),
        toBlock:   '0x'+chunkTo.toString(16),
        topics: [[TOPIC_BURN_STARTED, TOPIC_BURN_FINALIZED]],
      }]);
      const shouldAlert = !historicalBackfill || BURN_BACKFILL_ALERTS;
      if(logs?.length) console.log(`[Burn] ${logs.length} log(s) in blocks ${cursor}-${chunkTo}`);
      await processBurnLogs(logs || [], shouldAlert);
      await dbSave('burn_last_block', String(chunkTo));
      cursor = chunkTo + 1;
    }
  }catch(e){ console.error('[Burn poller]', e.message); }
}

async function loadBurnStartFromDB(survivorTokenId){
  // Prefer the persisted BurnStarted event so backfills/restarts can still
  // attach burned input IDs to the later BurnFinalized event.
  try{
    const r = await pgPool.query(
      `SELECT bse.owner_wallet, bse.points_used, bse.result_body_type, bse.result_is_angel,
              bse.boost_chance, array_agg(bsi.burned_token_id ORDER BY bsi.burned_token_id) AS token_ids
       FROM burn_started_events bse
       LEFT JOIN burn_started_inputs bsi ON bsi.burn_started_id = bse.id
       WHERE bse.survivor_token_id = $1
       GROUP BY bse.id
       ORDER BY bse.block_number DESC, bse.log_index DESC
       LIMIT 1`,
      [survivorTokenId]
    );
    if(r.rows.length){
      return {
        owner: r.rows[0].owner_wallet,
        tokenIds: (r.rows[0].token_ids||[]).filter(Boolean),
        points: r.rows[0].points_used,
        resultBodyType: r.rows[0].result_body_type,
        resultIsAngel: r.rows[0].result_is_angel,
        boostChance: r.rows[0].boost_chance,
      };
    }
  }catch(e){}
  try{
    const r = await pgPool.query(
      `SELECT be.burner_wallet, array_agg(bei.burned_token_id) AS token_ids
       FROM burn_events be
       LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
       WHERE be.survivor_token_id = $1
       GROUP BY be.burner_wallet LIMIT 1`,
      [survivorTokenId]
    );
    if(r.rows.length) return { owner: r.rows[0].burner_wallet, tokenIds: (r.rows[0].token_ids||[]).filter(Boolean) };
  }catch(e){}
  return null;
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

  // Render the original SVG directly so pixel-banded backgrounds are preserved
  // exactly as authored — no gradient reconstruction. Previously the background
  // rect bands were discarded and rebuilt as a smooth linearGradient, causing
  // the blurry gradient look vs OpenSea's sharp pixel bands.
  let bgBuf;
  try{
    bgBuf=await sharp(Buffer.from(svgText))
      .resize(SIZE,SIZE,{kernel:'nearest',fit:'fill'})
      .png()
      .toBuffer();
  }catch(e){ throw new Error('SVG render failed: '+e.message); }

  // Extract the embedded character PNG and re-composite at full size with
  // nearest-neighbor upscaling so character pixels stay crisp.
  const pngMatch=svgText.match(/src=["']data:image\/png;base64,([A-Za-z0-9+/=\s]+)["']/);
  if(pngMatch){
    try{
      const rawPng=Buffer.from(pngMatch[1].replace(/\s/g,''),'base64');
      const charBuf=await sharp(rawPng).resize(SIZE,SIZE,{kernel:'nearest'}).png().toBuffer();
      return sharp(bgBuf).composite([{input:charBuf,blend:'over'}]).png().toBuffer();
    }catch(e){ console.warn('[extractPngFromSvg] char composite failed, using full SVG render:',e.message); }
  }

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
  return target.send(buildEmbedPayload(embed));
}

function buildEmbedPayload(embed){
  const ir=embed._imageResult; delete embed._imageResult;
  if(ir?.type==='buffer'){ const att=new AttachmentBuilder(ir.buffer,{name:ir.filename}); embed.setThumbnail(`attachment://${ir.filename}`); return {embeds:[embed],files:[att]}; }
  if(ir?.type==='url') embed.setThumbnail(ir.url);
  return {embeds:[embed]};
}


// ── Token DB metadata helper — OS rank + traits for listing/sale cards ──────
const tokenMetaCache = new Map(); // tokenId → { meta, expires }
async function fetchTokenMetaFromDb(tokenId){
  const id = parseInt(tokenId);
  if(!id) return null;
  const cached = tokenMetaCache.get(id);
  if(cached && Date.now() < cached.expires) return cached.meta;

  const RAILWAY_URL = process.env.RAILWAY_API_URL;
  const API_SECRET  = process.env.API_SECRET;
  if(!RAILWAY_URL) return null;

  try{
    const qs = new URLSearchParams({ key: API_SECRET || '' });
    const r = await fetch(`${RAILWAY_URL}/db/token/${id}?${qs}`);
    if(!r.ok) return null;
    const j = await r.json();
    if(!j.ok || !j.token) return null;
    const meta = {
      os_rank: j.token.os_rank ? parseInt(j.token.os_rank) : null,
      traits:  j.token.traits || null,
      trait_count: j.token.trait_count ? parseInt(j.token.trait_count) : null,
    };
    tokenMetaCache.set(id, { meta, expires: Date.now() + 5 * 60 * 1000 });
    return meta;
  }catch(e){
    console.warn('[Token meta]', id, e.message);
    return null;
  }
}

async function fetchTokenMetaFromOpenSea(tokenId){
  const id = parseInt(tokenId);
  if(!id) return null;
  const cacheKey = `os:${id}`;
  const cached = tokenMetaCache.get(cacheKey);
  if(cached && Date.now() < cached.expires) return cached.meta;
  try{
    const r = await fetch(`https://api.opensea.io/api/v2/chain/ethereum/contract/${OCAS_CONTRACT}/nfts/${id}`, { headers: osHeaders() });
    if(!r.ok) return null;
    const j = await r.json();
    const n = j.nft || j;
    const rawTraits = Array.isArray(n.traits) ? n.traits : (Array.isArray(n.attributes) ? n.attributes : []);
    const traits = {};
    for(const t of rawTraits){
      const name = t.trait_type || t.traitType || t.type || t.name;
      const value = t.value;
      if(name && value != null) traits[String(name)] = String(value);
    }
    const meta = {
      os_rank: null,
      traits: Object.keys(traits).length ? traits : null,
      trait_count: Object.keys(traits).length || null,
    };
    tokenMetaCache.set(cacheKey, { meta, expires: Date.now() + 2 * 60 * 1000 });
    return meta;
  }catch(e){
    console.warn('[Token meta OpenSea]', id, e.message);
    return null;
  }
}

async function fetchCreatedTokenMeta(tokenId){
  const dbMeta = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
  if(dbMeta?.traits && Object.keys(dbMeta.traits).length) return dbMeta;
  const osMeta = await fetchTokenMetaFromOpenSea(tokenId).catch(()=>null);
  return osMeta?.traits ? { ...(dbMeta || {}), ...osMeta } : dbMeta;
}

function traitObjectToArray(traitsObj){
  if(!traitsObj || typeof traitsObj !== 'object') return [];
  return Object.entries(traitsObj).map(([trait_type, value]) => ({ trait_type, value }));
}

function osRankBadge(osRank){
  return osRank ? `⬥${Number(osRank).toLocaleString()}` : '';
}

function titleTokenId(tokenId, fallbackName){
  return tokenId ? `#${tokenId}` : (fallbackName || 'Unknown');
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

  const dbMeta = id ? await fetchTokenMetaFromDb(id) : null;
  const osRank = dbMeta?.os_rank || sale.nft?.os_rank || null;
  const rankPart = osRankBadge(osRank);
  const sweepPrefix = sale._isSweep ? '🧹 ' : '';
  const tokenLabel = titleTokenId(id, name);
  const embedTitle = `${sweepPrefix}${eth ? eth+' '+currencySymbol : '--'} • ${tokenLabel}${rankPart ? ' '+rankPart : ''} • Sold`;

  const footerBits = ['Sales Bot', slug];
  if(timeStr) footerBits.push(timeStr);

  // Sale color = payment type only. Rank is visible in the title (⬥) and
  // does not affect sidebar color — that would confuse ETH vs WETH signal.
  const saleColor = isWeth ? COLORS.WETH_ROSE : COLORS.OCAS_GREEN;

  const embed=new EmbedBuilder()
    .setTitle(embedTitle)
    .setColor(saleColor)
    .setURL(osUrl)
    .setFooter({text:footerBits.filter(Boolean).join(' • ')})
    .setTimestamp();

  embed._imageResult=await resolveImage(sale.nft,contract,config.chain||'ethereum');

  // Buyer + Seller on same row, then Traits stacked underneath.
  embed.addFields(
    {name:'Buyer',  value:buyerLink,  inline:true},
    {name:'Seller', value:sellerLink, inline:true},
    {name:'​',   value:'​',        inline:true},
  );
  let traits=sale.nft?.traits||[];
  if((!traits || traits.length===0) && dbMeta?.traits) traits = traitObjectToArray(dbMeta.traits);
  if(traits.length>0){
    const traitLines = traits.slice(0,12).map(t=>`**${t.trait_type}**: ${t.value}`);
    const half = Math.ceil(traitLines.length/2);
    const col1 = traitLines.slice(0,half).join('\n');
    const col2 = traitLines.slice(half).join('\n');
    embed.addFields(
      {name:'Traits', value:col1, inline:true},
      {name:'​',  value:col2||'​', inline:true},
    );
  }
  embed.addFields({name:'Links',value:`[OpenSea](${osUrl}) • [TraitView](${tvUrl})`,inline:false});
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
    listing.token_id ||
    listing.identifier ||
    ''
  );

  // Contract: from config first, then asset, then criteria
  const contract = config.contract ||
    (asset.asset_contract && asset.asset_contract.address) ||
    (criteria.contract && criteria.contract.address) ||
    '0x078be86f3104a32313a47815792230a3808642cc';

  const osUrl  = (contract && id) ? 'https://opensea.io/assets/'+chain+'/'+contract+'/'+id : 'https://opensea.io/collection/'+slug;
  const tvUrl  = id ? 'https://traitview.com/?jump='+id : '';

  const sellerAddr = (typeof listing.maker === 'string' ? listing.maker : (listing.maker && listing.maker.address)) || listing.seller || '';
  const sellerLink = sellerAddr ? '['+shortAddr(sellerAddr)+'](https://opensea.io/'+sellerAddr+')' : 'unknown';

  const dbMeta = listing._dbToken || (id ? await fetchTokenMetaFromDb(id) : null);
  const osRank = dbMeta?.os_rank || listing.os_rank || asset.os_rank || null;
  const rankPart = osRankBadge(osRank);
  const tokenLabel = titleTokenId(id, asset.name);
  const embedTitle = `${eth ? eth+' ETH' : '--'} • ${tokenLabel}${rankPart ? ' '+rankPart : ''} • Listed`;

  const footerBits = ['Listings Bot', slug];
  if(config._rankAlert) footerBits.push('Rank Alert');

  // Listing color: rank tier first, then OpenSea blue
  const rankTierColor = getRankTierColor(osRank);
  const listingColor = rankTierColor ?? COLORS.OPENSEA_BLUE;

  const embed = new EmbedBuilder()
    .setTitle(embedTitle)
    .setColor(listingColor)
    .setURL(osUrl)
    .setFooter({text:footerBits.filter(Boolean).join(' • ')})
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

  // Seller + Buy Now on same row, then Traits stacked underneath like sale cards.
  embed.addFields(
    {name:'Seller',  value: sellerLink,             inline:true},
    {name:'Buy Now', value: '[OpenSea]('+osUrl+')', inline:true},
    {name:'​',  value:'​', inline:true},
  );

  let traits = asset.traits || [];
  if((!traits || traits.length === 0) && dbMeta?.traits) traits = traitObjectToArray(dbMeta.traits);
  if(traits.length > 0){
    const traitLines = traits.slice(0,12).map(t=>`**${t.trait_type}**: ${t.value}`);
    const half = Math.ceil(traitLines.length/2);
    const col1 = traitLines.slice(0,half).join('\n');
    const col2 = traitLines.slice(half).join('\n');
    embed.addFields(
      {name:'Traits', value:col1, inline:true},
      {name:'​', value:col2||'​', inline:true},
    );
  }

  const linkParts = ['[OpenSea]('+osUrl+')'];
  if(tvUrl) linkParts.push('[TraitView]('+tvUrl+')');
  embed.addFields({name:'Links', value:linkParts.join(' • '), inline:false});
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
        const RAILWAY_URL = process.env.RAILWAY_API_URL;
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
                const alertChannel = client.channels.cache.get(
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

  // ── Sweep pagination buttons ─────────────────────────────────────────────
  if(interaction.isButton() && interaction.customId.startsWith('sweep:')){
    const parts = interaction.customId.split(':');
    const action = parts[1];
    const sessionId = parts[2];
    const session = sweepSessions.get(sessionId);
    if(!session){
      await interaction.reply({ content: 'Session expired. Run /sweep again.', flags: MessageFlags.Ephemeral });
      return;
    }
    if(action === 'showall'){
      session.page = 0;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      if(action === 'next') session.page++;
      if(action === 'prev') session.page--;
      await interaction.deferUpdate();
    }
    const PAGE_SIZE = 8;
    const listings = session.listings.map(normalizeSweepListing).filter(l => l.token_id && l.price_eth != null);
    const totalPages = Math.max(1, Math.ceil(listings.length / PAGE_SIZE));
    const page = Math.max(0, Math.min(session.page, totalPages - 1));
    session.page = page;
    const slice = listings.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const tokenLines = slice.map(formatSweepTokenLine);
    const navRow = new ActionRowBuilder();
    if(page > 0)            navRow.addComponents(new ButtonBuilder().setCustomId('sweep:prev:' + sessionId).setLabel('← Prev').setStyle(ButtonStyle.Secondary));
    if(page < totalPages-1) navRow.addComponents(new ButtonBuilder().setCustomId('sweep:next:' + sessionId).setLabel('Next →').setStyle(ButtonStyle.Secondary));
    const components = navRow.components.length ? [navRow] : [];
    const header = totalPages > 1
      ? ('Page ' + (page+1) + '/' + totalPages + ' · ' + listings.length + ' tokens')
      : (listings.length + ' tokens');
    const embed = new EmbedBuilder()
      .setTitle(header)
      .setColor(COLORS.OCAS_GREEN)
      .setDescription(tokenLines.join('\n') || 'No tokens found.');
    await interaction.editReply({ content: null, embeds: [embed], components });
    return;
  }

  // ── Show Traits button — ephemeral, only visible to clicker ─────────────
  if(interaction.isButton() && interaction.customId.startsWith('ocas_traits:')){
    const tokenId = parseInt(interaction.customId.split(':')[1]);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const RAILWAY_URL = process.env.RAILWAY_API_URL;
      const API_SECRET  = process.env.API_SECRET;
      let traits = null;
      const cached = ocasTraitsCache.get(tokenId);
      if(cached && Date.now() < cached.expires){
        traits = cached.traits;
      } else {
        const tqs = new URLSearchParams({ key: API_SECRET||'' });
        const tr = await fetch(`${RAILWAY_URL}/db/token/${tokenId}?${tqs}`);
        if(tr.ok){ const tj = await tr.json(); if(tj.ok && tj.token?.traits) traits = tj.token.traits; }
        if(traits) ocasTraitsCache.set(tokenId, { traits, expires: Date.now() + 5 * 60 * 1000 });
      }
      if(!traits){ await interaction.editReply({ content: 'Could not load traits.' }); return; }
      const traitLines = Object.entries(traits).map(([k,v]) => `**${k}:** ${v}`).join('\n');
      await interaction.editReply({ content: `**OCAS #${tokenId} Traits**\n${traitLines}` });
    } catch(e) {
      console.error('[ShowTraits]', e.message);
      try { await interaction.editReply({ content: 'Error loading traits.' }); } catch(_){}
    }
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

  // /setupburn — set burn alert channel (optional channel param, defaults to current)
  if(commandName==='setupburn'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.', flags: MessageFlags.Ephemeral});
    const channelOption = interaction.options.getChannel('channel');
    const channelId = channelOption ? channelOption.id : interaction.channelId;
    if(!burnConfig[guildId]) burnConfig[guildId] = {};
    burnConfig[guildId].channelId = channelId;
    await saveBurnConfig();
    await interaction.reply({embeds:[new EmbedBuilder()
      .setTitle('Burn Alerts Configured')
      .setColor(BURN_COLORS.FIRE)
      .setDescription(`Burn alerts will post to <#${channelId}>.\nThe bot will automatically detect OCAS Burn Machine events and post there.`)
    ], flags: MessageFlags.Ephemeral});
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
      ? `⬥ OS Rank #${config.rankAlert.min}–#${config.rankAlert.max}${config.rankAlert.channelId ? ` → <#${config.rankAlert.channelId}>` : ''}`
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
    const slug       = interaction.options.getString('collection') || config.slug;
    const rawSearch  = (interaction.options.getString('search') || '').trim();
    const RAILWAY_URL = process.env.RAILWAY_API_URL;
    const API_SECRET  = process.env.API_SECRET;

    // Detect mode: listings or sales (default)
    const wantListings = /\blistings?\b/i.test(rawSearch);
    const wantSales    = !wantListings; // sales is default
    let workingSearch = rawSearch.replace(/\b(listings?|sales?)\b/gi, ' ').trim();

    // Parse count: first standalone number (default 10, max 20)
    let want = 10;
    const numMatch = workingSearch.match(/(?:^|\s)(\d+)(?=\s|$)/);
    if(numMatch){ const n=parseInt(numMatch[1]); if(n>0&&n<=20){ want=n; workingSearch=workingSearch.replace(numMatch[0],' ').trim(); } }

    // Resolve trait name+value using phrase-aware parser
    let trait = '', value = '';
    if(workingSearch && RAILWAY_URL){
      try{
        const traitIndex = await getTraitIndex(RAILWAY_URL, API_SECRET);
        const resolved = chooseTraitGroupsFromQuery(workingSearch, traitIndex);
        if(resolved.groups.length){ trait = resolved.groups[0][0].trait_name; value = resolved.groups[0][0].trait_value; }
      }catch(e){ console.warn('[traitfind] parser error:', e.message); }
    }
    if(!trait && workingSearch){ trait=''; value=workingSearch; }

    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    if(!value) return interaction.reply({content:'Provide a trait to search. e.g. `/traitfind search:zombie` or `/traitfind search:gold chain listings`', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();

    try{
      // ── Listings mode ──────────────────────────────────────────────────────
      if(wantListings && RAILWAY_URL){
        await interaction.editReply(`🔍 Searching listed tokens with **${trait ? trait+': ' : ''}${value}**...`);
        // Use multi-trait-tokens with listed=1 — build a single-group filter
        const groups = [[{ trait_name: trait || '_any', trait_value: value }]];
        // For single known trait, use groups param; otherwise fall back to trait-sales endpoint
        const qs = new URLSearchParams({ listed:'1', limit: String(want), key: API_SECRET||'' });
        if(trait) qs.set('groups', JSON.stringify([[{ trait_name: trait, trait_value: value }]]));
        const r = await fetch(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`);
        if(r.ok){
          const j = await r.json();
          if(!j.ok) throw new Error(j.error || 'API error');
          const tokens = j.tokens || [];
          if(!tokens.length){ await interaction.editReply(`No listed tokens found with **${trait ? trait+': ' : ''}${value}**.`); return; }
          const contract = config.contract || '0x078be86f3104a32313a47815792230a3808642cc';
          const listEmbeds = await Promise.all(tokens.map(async t => {
            const tokenId = t.token_id ?? t.id ?? t.identifier;
            const dbMeta = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
            const priceWei = t.price_eth != null ? String(BigInt(Math.round(t.price_eth * 1e18))) : '0';
            const fakeListingObj = {
              token_id: tokenId,
              asset: { token_id: String(tokenId), identifier: String(tokenId), name: '#'+tokenId,
                       traits: dbMeta?.traits ? Object.entries(dbMeta.traits).map(([k,v])=>({trait_type:k,value:v})) : [] },
              payment: { quantity: priceWei, decimals: 18, symbol: 'ETH', token_address: '' },
              maker: t.seller || '',
              url: t.url || null,
              _dbToken: dbMeta,
            };
            return buildListingEmbed(fakeListingObj, {...config, slug}).catch(()=>null);
          }));
          await postEmbeds(interaction, listEmbeds.filter(Boolean),
            `Found **${tokens.length}** listing${tokens.length===1?'':'s'} with **${trait ? trait+': ' : ''}${value}** (cheapest first):`);
          return;
        }
      }

      // ── Sales mode (default) ───────────────────────────────────────────────
      if(RAILWAY_URL){
        await interaction.editReply(`🔍 Searching **${trait ? trait+': ' : ''}${value}** in full sales history...`);
        const qs = new URLSearchParams({ trait, value, limit: String(Math.min(want, 200)), sort: 'desc' });
        if(API_SECRET) qs.set('key', API_SECRET);
        const r = await fetch(`${RAILWAY_URL}/db/trait-sales?${qs}`);
        if(r.ok){
          const j = await r.json();
          if(!j.ok) throw new Error(j.error || 'DB error');
          const sales = j.sales || [];
          if(!sales.length){ await interaction.editReply(`No sales found for **${trait ? trait+': ' : ''}${value}** (searched ${j.count ?? 'all'} records).`); return; }
          const cfg = {...config, slug};
          const toShow = sales.slice(0, want);
          const saleEmbeds = await Promise.all(toShow.map(async sale => {
            const dbMeta = await fetchTokenMetaFromDb(sale.token_id).catch(()=>null);
            const tokenTraits = dbMeta?.traits ? Object.entries(dbMeta.traits).map(([k,v])=>({trait_type:k,value:v})) : [];
            const syntheticSale = {
              nft: { identifier: String(sale.token_id), name: `#${sale.token_id}`, traits: tokenTraits },
              buyer: sale.buyer||'unknown', seller: sale.seller||'unknown',
              payment: { symbol: (sale.currency||'ETH'), token_address: (sale.currency||'ETH').toUpperCase()==='WETH'?'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2':'', quantity: sale.price_eth!=null?String(BigInt(Math.round(sale.price_eth*1e18))):'0', decimals:18 },
              event_timestamp: sale.sale_ts ? Math.floor(new Date(sale.sale_ts).getTime()/1000) : null,
            };
            return buildSaleEmbed(syntheticSale, cfg).catch(()=>null);
          }));
          const totalNote = j.count > want ? ` (showing ${want} of ${j.count} total)` : '';
          await postEmbeds(interaction, saleEmbeds.filter(Boolean),
            `Found **${j.count}** sale${j.count===1?'':'s'} with **${trait ? trait+': ' : ''}${value}**${totalNote}:`);
          return;
        }
        console.warn('[traitfind] Railway DB call failed, falling back to OpenSea');
      }

      // ── OpenSea fallback (sales only) ──────────────────────────────────────
      await interaction.editReply(`🔍 Searching OpenSea sales for **${trait ? trait+': ' : ''}${value}**...`);
      const traitLow=trait.toLowerCase(), valueLow=value.toLowerCase();
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
      if(!matched.length){ await interaction.editReply(`No sales found with **${trait ? trait+': ' : ''}${value}** in the last ~${pages*100} sales.`); return; }
      const cfg={...config,slug};
      await interaction.editReply(`Found **${matched.length}** sale${matched.length===1?'':'s'} with **${trait ? trait+': ' : ''}${value}** (OpenSea, last ~${pages*100}):`);
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
  if(commandName==='rankfind'){
    const rawSearch  = (interaction.options.getString('search') || '').trim();
    const RAILWAY_URL = process.env.RAILWAY_API_URL;
    const API_SECRET  = process.env.API_SECRET;

    // Detect mode: sales or listings (default)
    const wantSales    = /\bsales?\b/i.test(rawSearch);
    const wantListings = !wantSales;
    let workingSearch = rawSearch.replace(/\b(listings?|sales?)\b/gi, ' ').trim();

    // Parse range: "1-100", "1 to 100"
    let rankMin = 1, rankMax = 100;
    const rangeMatch = workingSearch.match(/(\d+)\s*(?:-|to|–)\s*(\d+)/);
    if(rangeMatch){ rankMin = parseInt(rangeMatch[1]); rankMax = parseInt(rangeMatch[2]); }
    else { const numMatch = workingSearch.match(/(\d+)/); if(numMatch) rankMax = parseInt(numMatch[1]); }

    // Parse sort for listings mode: 'rank'/'best' or default 'price'/'cheapest'
    const sortBy = /\b(rank|best)\b/i.test(workingSearch) ? 'rank' : 'price';

    if(!RAILWAY_URL) return interaction.reply({ content: 'RAILWAY_API_URL not configured.', flags: MessageFlags.Ephemeral });
    if(rankMin < 1 || rankMax > 10000 || rankMin > rankMax) return interaction.reply({ content: 'Invalid rank range. Try: "1-100" or "1-500 rank"', flags: MessageFlags.Ephemeral });

    await interaction.deferReply();
    const contract = config.contract || '0x078be86f3104a32313a47815792230a3808642cc';
    try{

      // ── Sales mode ─────────────────────────────────────────────────────────
      if(wantSales){
        const qs = new URLSearchParams({ rank_min: rankMin, rank_max: rankMax, limit: '20', sort: 'desc' });
        if(API_SECRET) qs.set('key', API_SECRET);
        const r = await fetch(`${RAILWAY_URL}/db/rank-sales?${qs}`);
        if(!r.ok) throw new Error(`rank-sales API HTTP ${r.status}`);
        const j = await r.json();
        if(!j.ok) throw new Error(j.error || 'API error');
        const sales = j.sales || [];
        if(!sales.length){ await interaction.editReply(`No sales found for OS rank **⬥ #${rankMin}–#${rankMax}**.`); return; }
        const cfg = {...config};
        const saleEmbeds = await Promise.all(sales.map(async sale => {
          const tokenTraits = sale.traits && typeof sale.traits==='object'
            ? Object.entries(sale.traits).map(([k,v])=>({trait_type:k,value:v}))
            : [];
          const isWethSale = (sale.currency||'ETH').toUpperCase() === 'WETH';
          const syntheticSale = {
            nft: { identifier: String(sale.token_id), name: `#${sale.token_id}`, traits: tokenTraits, os_rank: sale.os_rank },
            buyer: sale.buyer||'unknown', seller: sale.seller||'unknown',
            payment: { symbol: (sale.currency||'ETH'), token_address: isWethSale?'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2':'', quantity: sale.price_eth!=null?String(BigInt(Math.round(sale.price_eth*1e18))):'0', decimals:18 },
            event_timestamp: sale.sale_ts ? Math.floor(new Date(sale.sale_ts).getTime()/1000) : null,
          };
          return buildSaleEmbed(syntheticSale, cfg).catch(()=>null);
        }));
        await postEmbeds(interaction, saleEmbeds.filter(Boolean),
          `📊 **OS Rank ⬥ #${rankMin}–#${rankMax}** — ${sales.length} recent sale${sales.length===1?'':'s'}:`);
        return;
      }

      // ── Listings mode (default) ────────────────────────────────────────────
      const qs = new URLSearchParams({ rank_min: rankMin, rank_max: rankMax, rank_type: 'os', limit: '20' });
      if(API_SECRET) qs.set('key', API_SECRET);
      const r = await fetch(`${RAILWAY_URL}/db/rank-listings?${qs}`);
      if(!r.ok) throw new Error(`API HTTP ${r.status}`);
      const j = await r.json();
      if(!j.ok) throw new Error(j.error || 'API error');
      let listings = j.listings || [];
      if(!listings.length){ await interaction.editReply(`No listings found with OS rank **⬥ #${rankMin}–#${rankMax}**.`); return; }
      if(sortBy === 'rank') listings.sort((a,b) => (a.os_rank??9999) - (b.os_rank??9999));
      const rankEmbeds = await Promise.all(listings.map(async l => {
        const tokenTraits = l.traits && typeof l.traits==='object' ? Object.entries(l.traits).map(([k,v])=>({trait_type:k,value:v})) : [];
        const priceStr = l.price_eth >= 1 ? l.price_eth.toFixed(3) : l.price_eth.toFixed(4);
        const rankBadge = l.os_rank ? ` ⬥${Number(l.os_rank).toLocaleString()}` : '';
        const tvUrl = `https://traitview.com/?token=${l.token_id}`;
        const rankColor = getRankTierColor(l.os_rank) ?? COLORS.OPENSEA_BLUE;
        const embed = new EmbedBuilder()
          .setColor(rankColor)
          .setTitle(`${priceStr} ETH • #${l.token_id}${rankBadge} • Listed`)
          .setURL(l.url)
          .setFooter({ text: `on-chain-all-stars · OS Rank #${rankMin}–#${rankMax} · ${sortBy==='rank'?'best rank first':'cheapest first'}` })
          .setTimestamp();
        const tvLink = `[OpenSea](${l.url}) · [TraitView](${tvUrl})`;
        if(tokenTraits.length){
          embed.setDescription(tokenTraits.slice(0,8).map(t=>`**${t.trait_type}:** ${t.value}`).join('\n') + '\n\n**Links**\n' + tvLink);
        } else { embed.setDescription('**Links**\n' + tvLink); }
        try{ embed._imageResult = await resolveImage({ identifier: String(l.token_id) }, contract, 'ethereum'); }catch(e){}
        return embed;
      }));
      const sortLabel = sortBy==='rank' ? 'best rank first' : 'cheapest first';
      await postEmbeds(interaction, rankEmbeds.filter(Boolean),
        `🏆 **OS Rank ⬥ #${rankMin}–#${rankMax}** — ${listings.length} listing${listings.length===1?'':'s'} (${sortLabel}):`);
    }catch(e){
      await interaction.editReply('Error: ' + e.message);
    }
    return;
  }


  // /ocas — smart search (random, token ID, rank, trait count, or phrase-aware trait combos)
  if(commandName==='ocas'){
    const tokenInput = interaction.options.getInteger('token');
    const rawSearch  = (interaction.options.getString('search') || '').trim();
    const contract   = config.contract || '0x078be86f3104a32313a47815792230a3808642cc';
    const RAILWAY_URL = process.env.RAILWAY_API_URL;
    const API_SECRET  = process.env.API_SECRET;

    await interaction.deferReply();
    try{
      // normalizePhrase / getTraitIndex / chooseTraitGroupsFromQuery
      // are hoisted to module scope — shared with /sweep.
      let tokenId    = tokenInput || null;
      let traitCount = null;
      let rankMin    = null, rankMax = null;
      let floorPrice  = null;
      let matchedGroups = [];
      let searchForTraits = '';

      // Detect floor anywhere: "zombie floor", "floor zombie", "gold chain floor"
      const wantFloor = /(?:^|\s)floor(?:\s|$)/i.test(rawSearch);
      let workingSearch = rawSearch.replace(/(?:^|\s)floor(?:\s|$)/gi, ' ').trim();

      // Extract trait count but keep any remaining trait words, e.g. "zombie 15 traits".
      const countMatch = workingSearch.match(/(?:trait\s*count\s*:?\s*(\d+)|(\d+)\s*traits?)/i);
      if(countMatch){
        traitCount = parseInt(countMatch[1] || countMatch[2]);
        workingSearch = workingSearch.replace(countMatch[0], ' ').trim();
      }

      // Extract rank range but keep any remaining trait words, e.g. "zombie hoodie rank 1-500".
      const lowerWorking = workingSearch.toLowerCase();
      const rangeMatch = lowerWorking.match(/rank\s*(\d+)\s*(?:-|–|to)\s*(\d+)/i) || lowerWorking.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s*rank/i);
      const topMatch = lowerWorking.match(/top\s*(\d+)/i);
      const singleRankMatch = lowerWorking.match(/rank\s*(\d+)/i);
      if(rangeMatch){
        rankMin = parseInt(rangeMatch[1]); rankMax = parseInt(rangeMatch[2]);
        workingSearch = workingSearch.replace(new RegExp(rangeMatch[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i'), ' ').trim();
      } else if(topMatch){
        rankMin = 1; rankMax = parseInt(topMatch[1]);
        workingSearch = workingSearch.replace(new RegExp(topMatch[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i'), ' ').trim();
      } else if(singleRankMatch){
        rankMin = 1; rankMax = parseInt(singleRankMatch[1]);
        workingSearch = workingSearch.replace(new RegExp(singleRankMatch[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i'), ' ').trim();
      }

      // Pure token ID, but only when no other filters were supplied.
      if(!tokenId && /^\d+$/.test(workingSearch.trim()) && +workingSearch >= 1 && +workingSearch <= 10000 && traitCount === null && !rankMin){
        tokenId = +workingSearch.trim();
        workingSearch = '';
      }

      searchForTraits = workingSearch
        .replace(/[,+]/g, ' ')
        .replace(/\b(and|with|plus)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Resolve phrase-aware multi-trait search. Longest trait values win:
      // "gold chain diamond choker" → "Gold Chain" + "Diamond Choker".
      if(!tokenId && searchForTraits && RAILWAY_URL){
        const traitIndex = await getTraitIndex(RAILWAY_URL, API_SECRET);
        const resolved = chooseTraitGroupsFromQuery(searchForTraits, traitIndex);
        matchedGroups = resolved.groups;

        if(!matchedGroups.length){
          await interaction.editReply(`I couldn't match **"${searchForTraits}"** to any known OCAS trait value. Try a more exact trait value like **Zombie**, **Gold Chain**, or **Diamond Choker**.`);
          return;
        }
        if(resolved.unmatched.length){
          await interaction.editReply(`I matched **${matchedLabel(matchedGroups)}**, but couldn't understand: **${resolved.unmatched.join(' ')}**. Try the exact trait phrase, like **gold chain diamond choker**.`);
          return;
        }
      }

      // ── Combined trait/rank/trait-count search through Railway/Postgres ───
      if(!tokenId && RAILWAY_URL && (matchedGroups.length || traitCount !== null || (rankMin && rankMax))){
        const qs = new URLSearchParams({ key: API_SECRET || '' });
        if(matchedGroups.length) qs.set('groups', JSON.stringify(matchedGroups));
        if(traitCount !== null) qs.set('trait_count', String(traitCount));
        if(rankMin && rankMax){ qs.set('rank_min', String(rankMin)); qs.set('rank_max', String(rankMax)); qs.set('rank_type', 'os'); }

        if(wantFloor){
          const r = await fetch(`${RAILWAY_URL}/db/multi-trait-floor?${qs}`);
          if(!r.ok) throw new Error(`multi-trait-floor API HTTP ${r.status}`);
          const j = await r.json();
          if(!j.ok) throw new Error(j.error || 'multi-trait-floor API error');
          if(!j.floor){
            const label = matchedGroups.length ? matchedLabel(matchedGroups) : `${traitCount} traits`;
            await interaction.editReply(`No listed OCAS found for **${label}**${traitCount !== null && matchedGroups.length ? ` + **${traitCount} traits**` : ''}${rankMin&&rankMax ? ` + **OS rank #${rankMin}–#${rankMax}**` : ''}.`);
            return;
          }
          tokenId = j.floor.token_id;
          floorPrice = j.floor.price_eth;
        } else {
          qs.set('limit', '10000');
          const r = await fetch(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`);
          if(!r.ok) throw new Error(`multi-trait-tokens API HTTP ${r.status}`);
          const j = await r.json();
          if(!j.ok) throw new Error(j.error || 'multi-trait-tokens API error');
          const tokens = j.tokens || [];
          if(!tokens.length){
            const label = matchedGroups.length ? matchedLabel(matchedGroups) : `${traitCount} traits`;
            await interaction.editReply(`No OCAS tokens found for **${label}**${traitCount !== null && matchedGroups.length ? ` + **${traitCount} traits**` : ''}${rankMin&&rankMax ? ` + **OS rank #${rankMin}–#${rankMax}**` : ''}.`);
            return;
          }
          const picked = tokens[Math.floor(Math.random() * tokens.length)];
          tokenId = picked.id;
        }
      }

      // ── Random fallback ───────────────────────────────────────────────────
      if(!tokenId) tokenId = Math.floor(Math.random()*10000)+1;

      // ── Fetch + post image ────────────────────────────────────────────────
      let imgResult = getCachedImage(`${contract}:${tokenId}`);
      if(!imgResult){
        imgResult = await resolveImage({identifier:String(tokenId)}, contract, 'ethereum');
        if(imgResult) setCachedImage(`${contract}:${tokenId}`, imgResult);
      }
      const osUrl = `https://opensea.io/assets/ethereum/${contract}/${tokenId}`;
      const tvUrl = `https://traitview.com/?token=${tokenId}`;

      // Description: trait values + count + rank only, no category labels
      const descParts = [];
      if(matchedGroups.length){
        const vals = matchedGroups.map(g => [...new Set(g.map(x => x.trait_value))][0]);
        descParts.push(vals.join(' · '));
      }
      if(traitCount !== null) descParts.push(`${traitCount} traits`);
      if(rankMin && rankMax) descParts.push(`rank #${rankMin}–#${rankMax}`);

      const priceLine   = (wantFloor && floorPrice != null) ? `**Floor:** Ξ ${floorPrice >= 1 ? floorPrice.toFixed(3) : floorPrice.toFixed(4)}\n` : '';
      const contextLine = descParts.length ? `${descParts.join(' · ')}\n` : '';

      // Fetch OS rank for title badge + rank-tier sidebar color
      const dbMeta  = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
      const osRank  = dbMeta?.os_rank ? Number(dbMeta.os_rank) : null;
      const rankBadge = osRank ? ` ⬥${osRank.toLocaleString()}` : '';
      const ocasColor = getRankTierColor(osRank) ?? COLORS.OCAS_BG;

      const traitsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ocas_traits:${tokenId}`)
          .setLabel('Show Traits')
          .setStyle(ButtonStyle.Secondary)
      );

      const embed = new EmbedBuilder()
        .setTitle(`OCAS #${tokenId}${rankBadge}`)
        .setColor(ocasColor)
        .setDescription(`${priceLine}${contextLine}[OpenSea](${osUrl}) · [TraitView](${tvUrl})`);

      if(imgResult?.type==='buffer'){
        const att=new AttachmentBuilder(imgResult.buffer,{name:imgResult.filename});
        embed.setImage(`attachment://${imgResult.filename}`);
        await interaction.editReply({embeds:[embed],files:[att],components:[traitsRow]});
      } else if(imgResult?.type==='url'){
        embed.setImage(imgResult.url);
        await interaction.editReply({embeds:[embed],components:[traitsRow]});
      } else {
        embed.setDescription(`${priceLine}${contextLine}[OpenSea](${osUrl}) · [TraitView](${tvUrl})\n_Image unavailable_`);
        await interaction.editReply({embeds:[embed],components:[traitsRow]});
      }
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // ── /sweep ──────────────────────────────────────────────────────────────
  if(commandName==='sweep'){
    const RAILWAY_URL = process.env.RAILWAY_API_URL;
    const API_SECRET  = process.env.API_SECRET;
    const rawSearch   = (interaction.options.getString('search')||'').trim();
    console.log('[/sweep] RAILWAY_URL set:', !!RAILWAY_URL, 'search:', rawSearch);
    await interaction.deferReply();
    try{

      // ── Parse sweep mode ──────────────────────────────────────────────────
      let sweepMode   = 'count';
      let sweepCount  = 10;
      let budget      = null;
      let targetFloor = null;
      let workingSearch = rawSearch;

      // Budget mode: "2eth", "1eth zombie", "0.5eth zombie hoodie"
      const budgetMatch = workingSearch.match(/(?:^|\s)([\d.]+)\s*eth(?=\s|$)/i);
      if(budgetMatch){
        sweepMode = 'budget';
        budget = parseFloat(budgetMatch[1]);
        workingSearch = workingSearch.replace(budgetMatch[0], ' ').trim();
      }

      // Target-floor mode: "0.05 floor", "0.1 floor zombie"
      if(sweepMode === 'count'){
        const floorNumMatch = workingSearch.match(/(?:^|\s)([\d.]+)\s+floor(?=\s|$)/i);
        if(floorNumMatch){
          sweepMode   = 'floor';
          targetFloor = parseFloat(floorNumMatch[1]);
          workingSearch = workingSearch.replace(floorNumMatch[0], ' ').trim();
        } else {
          // Strip stray "floor" keyword if no number preceded it
          workingSearch = workingSearch.replace(/(?:^|\s)floor(?=\s|$)/gi, ' ').trim();
        }
      }

      // Count mode: extract standalone integer
      if(sweepMode === 'count'){
        const numMatch = workingSearch.match(/(?:^|\s)(\d+)(?=\s|$)/);
        if(numMatch){
          const n = parseInt(numMatch[1]);
          if(n > 0 && n <= 500){ sweepCount = n; workingSearch = workingSearch.replace(numMatch[0], ' ').trim(); }
        }
      }

      // ── Extract trait count e.g. "15 traits" ──────────────────────────────
      let traitCount = null;
      const tcMatch = workingSearch.match(/(?:trait\s*count\s*:?\s*(\d+)|(\d+)\s*traits?)/i);
      if(tcMatch){
        traitCount = parseInt(tcMatch[1] || tcMatch[2]);
        workingSearch = workingSearch.replace(tcMatch[0], ' ').trim();
      }

      // ── Simple depluralize ────────────────────────────────────────────────
      const PLURAL_OVERRIDES = {
        zombies: 'zombie', hoodies: 'hoodie', skeletons: 'skeleton',
        apes: 'ape', aliens: 'alien', robots: 'robot'
      };
      const SKIP_DEPLURAL = new Set(['teeth','tattoos','traits','clothes','glasses']);
      workingSearch = workingSearch.split(' ').map(w => {
        const lw = w.toLowerCase();
        if(PLURAL_OVERRIDES[lw]) return PLURAL_OVERRIDES[lw];
        if(SKIP_DEPLURAL.has(lw)) return w;
        if(lw.endsWith('ies') && lw.length > 4) return w.slice(0,-3)+'y';
        if(lw.endsWith('s') && lw.length > 3) return w.slice(0,-1);
        return w;
      }).join(' ').trim();

      // ── Phrase-aware trait matching ────────────────────────────────────────
      let matchedGroups = [];
      workingSearch = workingSearch.replace(/[,+]/g,' ').replace(/\b(and|with|plus)\b/gi,' ').replace(/\s+/g,' ').trim();

      if(workingSearch && RAILWAY_URL){
        const traitIndex = await getTraitIndex(RAILWAY_URL, API_SECRET);
        const resolved = chooseTraitGroupsFromQuery(workingSearch, traitIndex);
        matchedGroups = resolved.groups;
        if(resolved.unmatched.length && !matchedGroups.length){
          await interaction.editReply(`I couldn't match **"${workingSearch}"** to any known trait. Try: "zombie", "gold chain", "15 traits".`);
          return;
        }
        if(resolved.unmatched.length){
          await interaction.editReply(`I matched some traits but couldn't understand: **${resolved.unmatched.join(' ')}**. Try exact trait phrases.`);
          return;
        }
      }

      // ── Build label + title ────────────────────────────────────────────────
      const labelParts = matchedGroups.map(g => [...new Set(g.map(x => x.trait_value))][0]);
      if(traitCount !== null) labelParts.push(traitCount + ' traits');
      const traitLabel = labelParts.length ? labelParts.join(' · ') : 'OCAS';

      let modeTitle;
      if(sweepMode === 'budget') modeTitle = `Budget Sweep Ξ${budget} · ${traitLabel}`;
      else if(sweepMode === 'floor') modeTitle = `Floor Sweep Ξ${targetFloor} · ${traitLabel}`;
      else modeTitle = `Sweep ${sweepCount} · ${traitLabel}`;

      // ── Determine fetch limit ──────────────────────────────────────────────
      const fetchLimit = (sweepMode === 'count') ? sweepCount + 1 : 1000;

      // ── Fetch listings from DB ─────────────────────────────────────────────
      let allFetched = [];
      if(!matchedGroups.length && traitCount === null){
        console.log('[/sweep] plain sweep from DB, mode:', sweepMode);
        const dbRes = await pgPool.query(
          `SELECT l.token_id, l.price_eth, l.url, t.os_rank, t.obs_rank, t.trait_count
           FROM listings l
           LEFT JOIN tokens t ON t.id = l.token_id
           ORDER BY l.price_eth ASC
           LIMIT $1`,
          [fetchLimit]
        );
        allFetched = dbRes.rows.map(r => ({
          token_id: parseInt(r.token_id),
          price_eth: parseFloat(r.price_eth),
          url: r.url,
          os_rank: r.os_rank ? parseInt(r.os_rank) : null,
          obs_rank: r.obs_rank ? parseInt(r.obs_rank) : null,
          trait_count: r.trait_count ? parseInt(r.trait_count) : null
        }));
        console.log('[/sweep] plain sweep tokens returned:', allFetched.length);
      } else {
        if(!RAILWAY_URL) throw new Error('RAILWAY_API_URL is required for trait/count sweeps.');
        const qs = new URLSearchParams({ listed:'1', limit: String(fetchLimit), key: API_SECRET||'' });
        if(matchedGroups.length) qs.set('groups', JSON.stringify(matchedGroups));
        if(traitCount !== null) qs.set('trait_count', String(traitCount));
        console.log('[/sweep] fetching multi-trait-tokens, mode:', sweepMode, 'groups:', matchedGroups.length, 'traitCount:', traitCount);
        const r = await fetch(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`);
        console.log('[/sweep] response status:', r.status);
        if(!r.ok){ const txt = await r.text(); throw new Error('multi-trait-tokens HTTP ' + r.status + ': ' + txt.slice(0,200)); }
        const j = await r.json();
        console.log('[/sweep] tokens returned:', j.tokens?.length);
        if(!j.ok) throw new Error(j.error||'API error');
        allFetched = (j.tokens||[]).map(normalizeSweepListing).filter(t => t.token_id && t.price_eth != null);
      }

      if(!allFetched.length){
        await interaction.editReply('No listed tokens found for **' + traitLabel + '**.');
        return;
      }

      // ── Apply mode logic ───────────────────────────────────────────────────
      let sweepListings = [];
      let postSweepToken = null;
      const fmt = n => n.toFixed(4);

      if(sweepMode === 'budget'){
        let running = 0;
        for(const t of allFetched){
          if(running + t.price_eth <= budget){ sweepListings.push(t); running += t.price_eth; }
          else { postSweepToken = postSweepToken || t; break; }
        }
        if(!sweepListings.length){
          await interaction.editReply(`No listings fit within that budget of **Ξ${budget}** for **${traitLabel}**.\nCheapest available: Ξ${fmt(allFetched[0].price_eth)}`);
          return;
        }
      } else if(sweepMode === 'floor'){
        for(const t of allFetched){
          if(t.price_eth < targetFloor) sweepListings.push(t);
          else { postSweepToken = postSweepToken || t; break; }
        }
        if(!sweepListings.length){
          await interaction.editReply(`No listings below target floor of **Ξ${targetFloor}** for **${traitLabel}**.\nCheapest available: Ξ${fmt(allFetched[0].price_eth)}`);
          return;
        }
      } else {
        sweepListings  = allFetched.slice(0, sweepCount);
        postSweepToken = allFetched[sweepCount] || null;
      }

      // ── Compute stats ──────────────────────────────────────────────────────
      const available  = sweepListings.length;
      const short      = sweepMode === 'count' && available < sweepCount;
      const prices     = sweepListings.map(t => parseFloat(t.price_eth));
      const totalEth   = prices.reduce((a,b)=>a+b,0);
      const avgEth     = totalEth / prices.length;
      const cheapest   = prices[0];
      const highest    = prices[prices.length-1];
      const floorAfter = postSweepToken ? parseFloat(postSweepToken.price_eth) : null;

      // ── Build embed description ────────────────────────────────────────────
      let desc = '';
      if(sweepMode === 'budget'){
        const remaining = budget - totalEth;
        desc += `**Budget:** Ξ ${fmt(budget)}\n`;
        desc += `**Tokens swept:** ${available}\n`;
        desc += `**Total ETH:** Ξ ${fmt(totalEth)}\n`;
        desc += `**ETH left:** Ξ ${fmt(remaining)}\n`;
        desc += `**Average price:** Ξ ${fmt(avgEth)}\n`;
        desc += `**Cheapest included:** Ξ ${fmt(cheapest)}\n`;
        desc += `**Highest included:** Ξ ${fmt(highest)}\n`;
        if(floorAfter) desc += `**New floor after sweep:** Ξ ${fmt(floorAfter)}\n`;
      } else if(sweepMode === 'floor'){
        desc += `**Target floor:** Ξ ${targetFloor.toFixed(4)}\n`;
        desc += `**Tokens swept:** ${available}\n`;
        desc += `**Total ETH:** Ξ ${fmt(totalEth)}\n`;
        desc += `**Average price:** Ξ ${fmt(avgEth)}\n`;
        desc += `**Cheapest included:** Ξ ${fmt(cheapest)}\n`;
        desc += `**Highest included:** Ξ ${fmt(highest)}\n`;
        if(floorAfter) desc += `**New floor after sweep:** Ξ ${fmt(floorAfter)}\n`;
      } else {
        if(short) desc += '⚠️ Only ' + available + ' listed\n\n';
        desc += '**Total:** Ξ ' + fmt(totalEth) + '\n';
        desc += '**Average:** Ξ ' + fmt(avgEth) + '\n';
        desc += '**Cheapest:** Ξ ' + fmt(cheapest) + '\n';
        desc += '**Highest included:** Ξ ' + fmt(highest) + '\n';
        if(floorAfter) desc += '**New floor after sweep:** Ξ ' + fmt(floorAfter) + '\n';
      }

      const embed = new EmbedBuilder()
        .setTitle(modeTitle)
        .setColor(COLORS.OCAS_GREEN)
        .setDescription(desc.slice(0, 4090));

      // ── All tokens behind private Show All Tokens button ──────────────────
      const components = [];
      const sessionId = interaction.id;
      const cleanSweepListings = sweepListings.map(normalizeSweepListing).filter(t => t.token_id && t.price_eth != null);
      sweepSessions.set(sessionId, { listings: cleanSweepListings, page: 0 });
      setTimeout(() => sweepSessions.delete(sessionId), 30 * 60 * 1000);
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sweep:showall:' + sessionId).setLabel('Show All Tokens').setStyle(ButtonStyle.Secondary)
      ));

      await interaction.editReply({ embeds: [embed], components });

    }catch(e){
      console.error('[/sweep] ERROR:', e.message, e.stack);
      try{ await interaction.editReply('Error: ' + e.message); }catch(_){}
    }
    return;
  }

  // /burnlatest
  if(commandName==='burnlatest'){
    await interaction.deferReply();
    try{
      const count = Math.max(1, Math.min(interaction.options.getInteger('count') || 1, 10));
      const r = await pgPool.query(`
        SELECT be.id, be.tx_hash, be.block_number, be.burner_wallet, be.survivor_token_id,
               be.result_body_type, be.result_is_angel, be.points_used, be.burned_at, be.log_index,
               array_agg(bei.burned_token_id ORDER BY bei.burned_token_id) AS burned_ids
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        GROUP BY be.id
        ORDER BY be.block_number DESC, be.log_index DESC
        LIMIT $1
      `, [count]);
      if(!r.rows.length){ await interaction.editReply('No burn events recorded yet.'); return; }
      const firstRows = count > 5 ? r.rows.slice(0, 5) : r.rows;
      const embed = await buildRecentBurnsEmbed(firstRows, 1);
      const payload = { embeds:[embed], components:[] };
      if(count > 5 && r.rows.length > 5){
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('show_more')
            .setLabel(`Show More (${r.rows.length - 5} remaining)`)
            .setStyle(ButtonStyle.Primary)
        );
        payload.components = [row];
      }
      await interaction.editReply(payload);
      if(count > 5 && r.rows.length > 5){
        const msg = await interaction.fetchReply();
        const remainingEmbed = await buildRecentBurnsEmbed(r.rows.slice(5), 6, 'Recent OCAS Burns');
        slideshowSessions.set(msg.id, {
          embeds: [remainingEmbed],
          index: 0,
          userId: interaction.user.id,
          expiresAt: Date.now() + 15 * 60 * 1000,
          isShowMore: true,
        });
      }
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // /burnstats
  if(commandName==='burnstats'){
    await interaction.deferReply();
    try{
      const [statsRes, latestRes, pausedRes] = await Promise.all([
        pgPool.query(`
          SELECT
            COUNT(DISTINCT be.id)::int AS total_burns,
            COUNT(bei.burned_token_id)::int AS total_burned,
            COUNT(DISTINCT be.id)::int AS total_created,
            COUNT(*) FILTER (WHERE input_counts.input_count IS NULL OR input_counts.input_count = 0)::int AS missing_input_burns
          FROM burn_events be
          LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
          LEFT JOIN (
            SELECT burn_event_id, COUNT(*)::int AS input_count
            FROM burn_event_inputs
            GROUP BY burn_event_id
          ) input_counts ON input_counts.burn_event_id = be.id
        `),
        pgPool.query(`
          SELECT be.survivor_token_id, be.result_body_type, be.result_is_angel,
                 be.points_used, be.burned_at, be.burner_wallet,
                 COUNT(bei.id)::int AS burned_count
          FROM burn_events be
          LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
          GROUP BY be.id ORDER BY be.burned_at DESC LIMIT 1
        `),
        pgPool.query(`SELECT COUNT(*)::int AS duplicate_inputs
                      FROM (
                        SELECT burn_event_id, burned_token_id
                        FROM burn_event_inputs
                        GROUP BY burn_event_id, burned_token_id
                        HAVING COUNT(*) > 1
                      ) d`),
      ]);
      const stats   = statsRes.rows[0];
      const latest  = latestRes.rows[0];
      const diagnostics = pausedRes.rows[0] || {};
      const burned  = stats.total_burned || 0;
      const created = stats.total_created || 0;
      const estimatedSupply = 10000 - burned + created;
      const openSeaItems = await fetchOpenSeaItemCount('on-chain-all-stars').catch(()=>null);

      const embed = new EmbedBuilder()
        .setTitle('OCAS Burn Machine Stats')
        .setColor(BURN_COLORS.FIRE)
        .addFields(
          { name:'Total Burns',       value:String(stats.total_burns||0),   inline:true },
          { name:'Tokens Burned',     value:String(burned),                  inline:true },
          { name:'Tokens Created',    value:String(created),                 inline:true },
          { name:'Net Supply Change', value:`-${burned - created}`,             inline:true },
          { name:'Est. Supply',       value:String(estimatedSupply),         inline:true },
          { name:'OpenSea Items',     value:openSeaItems == null ? 'unavailable' : String(openSeaItems), inline:true },
          { name:'Links',             value:`[Burn Machine](https://www.onchainallstars.xyz/burn-machine) | [TraitView](https://traitview.com/) | [Etherscan](https://etherscan.io/address/${BURN_CONTRACT})`, inline:false },
        );
      if(openSeaItems != null && openSeaItems !== estimatedSupply){
        embed.addFields({
          name:'Supply Check',
          value:`DB estimate differs from OpenSea by ${estimatedSupply - openSeaItems}. Missing input burns: ${stats.missing_input_burns || 0}. Duplicate inputs: ${diagnostics.duplicate_inputs || 0}. Backfill may be incomplete or OpenSea may lag.`,
          inline:false,
        });
      }
      if(latest){
        const ago       = latest.burned_at ? timeSince(Math.floor(new Date(latest.burned_at).getTime()/1000)) : '?';
        embed.addFields({ name:'Latest Burn',
          value:`[#${latest.survivor_token_id}](https://opensea.io/assets/ethereum/${OCAS_CONTRACT}/${latest.survivor_token_id}) - ${latest.burned_count || '?'} burned - ${ago}`,
          inline:false });
      }
      embed.setFooter({ text:'OCAS Burn Machine' }).setTimestamp();
      await interaction.editReply({ embeds:[embed] });
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // /burn token:ID
  if(commandName==='burn'){
    const tokenInput = interaction.options.getInteger('token');
    if(!tokenInput) return interaction.reply({ content:'Provide a token ID.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    try{
      const contract = OCAS_CONTRACT;
      // Check if token was burned (appears in burn_event_inputs)
      const burnedRes = await pgPool.query(`
        SELECT be.survivor_token_id, be.burner_wallet, be.burned_at, be.result_body_type, be.result_is_angel,
               be.points_used, array_agg(bei2.burned_token_id ORDER BY bei2.burned_token_id) AS burned_ids
        FROM burn_event_inputs bei
        JOIN burn_events be ON be.id = bei.burn_event_id
        LEFT JOIN burn_event_inputs bei2 ON bei2.burn_event_id = be.id
        WHERE bei.burned_token_id = $1
        GROUP BY be.id
        LIMIT 1
      `, [tokenInput]);
      // Check if token was created via burn (appears as survivor)
      const createdRes = await pgPool.query(`
        SELECT be.tx_hash, be.burner_wallet, be.burned_at, be.result_body_type, be.result_is_angel,
               be.points_used, array_agg(bei.burned_token_id) AS burned_ids
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        WHERE be.survivor_token_id = $1
        GROUP BY be.id LIMIT 1
      `, [tokenInput]);

      const osUrl = `https://opensea.io/assets/ethereum/${contract}/${tokenInput}`;
      const tvUrl = `https://traitview.com/?token=${tokenInput}`;
      const embed = new EmbedBuilder()
        .setColor(BURN_COLORS.FIRE)
        .setURL(osUrl)
        .setFooter({ text:'OCAS Burn Machine • on-chain-all-stars' });

      if(burnedRes.rows.length){
        const b = burnedRes.rows[0];
        const ago = b.burned_at ? timeSince(Math.floor(new Date(b.burned_at).getTime()/1000)) : '?';
        const survivorUrl = `https://opensea.io/assets/ethereum/${contract}/${b.survivor_token_id}`;
        const burnedIds = (b.burned_ids||[]).filter(Boolean);
        embed.setTitle(`#${tokenInput} Burn Status`)
          .setDescription(`This token was burned ${ago}.
It helped create [#${b.survivor_token_id}](${survivorUrl}).`)
          .addFields(
            { name:'Burner', value:`[${shortAddr(b.burner_wallet)}](https://opensea.io/${b.burner_wallet})`, inline:true },
            { name:'Created', value:`[#${b.survivor_token_id}](${survivorUrl})`, inline:true },
            { name:'Burn Tier', value:burnTypeLabel(b.result_body_type, b.result_is_angel), inline:true },
            { name:'Tokens Burned', value:String(burnedIds.length || '?'), inline:true },
            { name:'Points Used', value:String(b.points_used || 0), inline:true },
            { name:'Links', value:`[OpenSea](${osUrl}) | [TraitView](${tvUrl})`, inline:false },
          );
      } else if(createdRes.rows.length){
        const cr = createdRes.rows[0];
        const burnedIds = (cr.burned_ids||[]).filter(Boolean);
        const burnEmbed = await buildBurnEmbed(
          { survivorTokenId: tokenInput, resultBodyType: cr.result_body_type, resultIsAngel: cr.result_is_angel, points: cr.points_used, txHash: cr.tx_hash },
          { owner: cr.burner_wallet, tokenIds: burnedIds }
        );
        await interaction.editReply(buildEmbedPayload(burnEmbed));
        return;
      } else {
        embed.setTitle(`#${tokenInput} - No Burn Activity`)
          .setDescription(`This token has no recorded burn events.
It has not been burned and was not created via the burn machine.`)
          .addFields({ name:'Links', value:`[OpenSea](${osUrl}) | [TraitView](${tvUrl})`, inline:false });
      }
      await interaction.editReply({ embeds:[embed] });
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // /burnwallet wallet:ADDRESS
  if(commandName==='burnwallet'){
    const walletAddr = (interaction.options.getString('wallet')||'').trim().toLowerCase();
    if(!/^0x[a-f0-9]{40}$/.test(walletAddr))
      return interaction.reply({ content:'Invalid wallet address. Use format: 0x...', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    try{
      const contract = OCAS_CONTRACT;
      const r = await pgPool.query(`
        SELECT be.id, be.survivor_token_id, be.result_body_type, be.result_is_angel,
               be.points_used, be.burned_at,
               array_agg(bei.burned_token_id ORDER BY bei.burned_token_id) AS burned_ids
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        WHERE LOWER(be.burner_wallet) = $1
        GROUP BY be.id
        ORDER BY be.burned_at DESC
        LIMIT 10
      `, [walletAddr]);
      if(!r.rows.length){
        await interaction.editReply(`No burn activity found for \`${shortAddr(walletAddr)}\`.`);
        return;
      }
      const totalBurned  = r.rows.reduce((s,row)=>(s + (row.burned_ids||[]).filter(Boolean).length), 0);
      const totalCreated = r.rows.length;
      const totalPoints  = r.rows.reduce((s,row)=>s + (parseInt(row.points_used)||0), 0);
      // Best created token by type rarity: Radioactive > Zombie > Skeleton > Human
      const typeOrder = { 3:0, 1:1, 2:2, 0:3 };
      const best = r.rows.sort((a,b)=>(typeOrder[a.result_body_type]??4)-(typeOrder[b.result_body_type]??4))[0];
      const embed = new EmbedBuilder()
        .setTitle(`Burn History: ${shortAddr(walletAddr)}`)
        .setColor(BURN_COLORS.FIRE)
        .setURL(`https://opensea.io/${walletAddr}`)
        .addFields(
          { name:'Tokens Burned',   value:String(totalBurned),  inline:true },
          { name:'Tokens Created',  value:String(totalCreated), inline:true },
          { name:'Total Points',    value:String(totalPoints),  inline:true },
          { name:'Best Created',    value:`[#${best.survivor_token_id}](https://opensea.io/assets/ethereum/${contract}/${best.survivor_token_id}) - burn tier ${burnTypeLabel(best.result_body_type, best.result_is_angel)}`, inline:false },
        );
      const recentLines = r.rows.slice(0,5).map(row=>{
        const ids = (row.burned_ids||[]).filter(Boolean);
        const ago = row.burned_at ? timeSince(Math.floor(new Date(row.burned_at).getTime()/1000)) : '?';
        return `[#${row.survivor_token_id}](https://opensea.io/assets/ethereum/${contract}/${row.survivor_token_id}) - ${ids.length} burned - ${ago}`;
      });
      embed.addFields({ name:'Recent Burns (up to 5)', value:recentLines.join('\n'), inline:false });
      embed.setFooter({ text:'OCAS Burn Machine' }).setTimestamp();
      await interaction.editReply({ embeds:[embed] });
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // /burnleaderboard
  if(commandName==='burnleaderboard'){
    await interaction.deferReply();
    try{
      const contract = OCAS_CONTRACT;
      const r = await pgPool.query(`
        SELECT be.burner_wallet,
               COUNT(be.id)::int AS total_burns,
               SUM(array_length(ARRAY(SELECT bei2.burned_token_id FROM burn_event_inputs bei2 WHERE bei2.burn_event_id = be.id), 1))::int AS total_burned,
               SUM(be.points_used)::int AS total_points
        FROM burn_events be
        GROUP BY be.burner_wallet
        ORDER BY total_burned DESC
        LIMIT 10
      `);
      if(!r.rows.length){ await interaction.editReply('No burn data yet.'); return; }
      const lines = r.rows.map((row,i)=>{
        const wallet = `[${shortAddr(row.burner_wallet)}](https://opensea.io/${row.burner_wallet})`;
        return `**${i+1}.** ${wallet} - ${row.total_burned} burned - ${row.total_burns} burns - ${row.total_points||0} pts`;
      });
      const embed = new EmbedBuilder()
        .setTitle('OCAS Burn Leaderboard')
        .setColor(BURN_COLORS.FIRE)
        .setDescription(lines.join('\n'))
        .setFooter({ text:'Ranked by total tokens burned' })
        .setTimestamp();
      await interaction.editReply({ embeds:[embed] });
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  if(commandName==='help'){
    const marketCmds=[
      '`/ocas search:zombie hoodie` — Random or searched OCAS token',
      '`/ocas search:gold chain floor` — Cheapest listed with that trait',
      '`/sweep search:10` — Cost to sweep 10 cheapest listed',
      '`/sweep search:2eth zombie` — Budget sweep with trait filter',
      '`/sweep search:0.05 floor zombie` — Clear below target floor',
      '`/traitfind search:zombie` — Sales history for a trait',
      '`/traitfind search:zombie listings` — Currently listed with that trait',
      '`/rankfind search:1-100` — Listed tokens by OS rank range',
      '`/rankfind search:1-100 sales` — Sales history by OS rank range',
    ].join('\n');
    const salesCmds=[
      '`/lastsale` — Most recent sale',
      '`/recentsales count:10` — Last N sales',
      '`/sale token:1234` — Last sale for a specific token',
      '`/listings count:5` — Recent new listings',
    ].join('\n');
    const burnCmds=[
      '`/burnstats` — Total burned, created, estimated supply',
      '`/burnlatest` — Most recent finalized burn',
      '`/burn token:1234` — Token burn status and lineage',
      '`/burnwallet wallet:0x...` — Wallet burn history',
      '`/burnleaderboard` — Top burners by tokens burned',
    ].join('\n');
    const alertCmds=[
      '`/myalert trait:Type value:Zombie` — DM when a Zombie sells or lists',
      '`/myalertstatus` — See your current alert settings',
      '`/myalertclear` — Remove your DM alert',
    ].join('\n');
    const adminCmds=[
      '`/setuphere` — Set sales channel to this channel',
      '`/setlistingshere` — Set listings channel to this channel',
      '`/setupburn` — Set burn alerts channel to this channel',
      '`/salesfilter` — Filter auto-posted sales by trait',
      '`/traitlistingfilter` — Filter auto-posted listings by trait',
      '`/ranklistingfilter min:1 max:100` — Alert when top-rank token lists',
      '`/clearallfilters` — Clear all server filters',
      '`/pause` / `/resume` — Pause/resume auto-posts',
      '`/status` — Show server config',
    ].join('\n');
    await interaction.reply({embeds:[new EmbedBuilder()
      .setTitle('OCAS Sales Bot')
      .setColor(COLORS.OCAS_GREEN)
      .setDescription('Your OCAS market assistant — search tokens, track sales, sweep floors, monitor burns, and set personal alerts.')
      .addFields(
        {name:'🔍 Market & Search',         value:marketCmds, inline:false},
        {name:'📈 Sales & Listings',         value:salesCmds,  inline:false},
        {name:'🔥 Burn Machine',             value:burnCmds,   inline:false},
        {name:'🔔 Personal DM Alerts',       value:alertCmds,  inline:false},
        {name:'⚙️ Admin (Manage Server)',    value:adminCmds,  inline:false},
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
      '**#all-sales** — auto-posts every sale (make read-only for members)',
      '**#all-listings** — auto-posts every listing (make read-only for members)',
      '**#market** — members use `/ocas`, `/sweep`, `/traitfind`, `/rankfind`',
      '**#sales-history** — members use `/recentsales`, `/sale`, `/lastsale`',
      '',
      'To make a channel read-only: Channel Settings > Permissions > @everyone > disable Send Messages'
    ].join('\n');

    const personalAlerts=[
      'Anyone can set personal DM alerts with `/myalert`.',
      'You get a private DM when a matching sale or listing happens.',
      '',
      '`/myalert trait:Type value:Zombie` — DM when any Zombie sells or lists',
      '`/myalert rank_min:1 rank_max:100` — DM when a top-100 token gets listed',
      '',
      '`/myalertclear` — Remove your alert',
      '`/myalertstatus` — See your current alert'
    ].join('\n');

    const serverFilters=[
      'Admins can filter what auto-posts to each channel:',
      '',
      '`/salesfilter trait:Type value:Zombie` — Only post Zombie sales',
      '`/traitlistingfilter trait:Type value:Zombie` — Only post Zombie listings',
      '`/ranklistings min:1 max:100` — Auto-post when top-100 tokens list',
      '',
      '`/clearallfilters` — Remove all server filters',
      '`/status` — See current configuration'
    ].join('\n');

    const embed = new EmbedBuilder()
      .setTitle('Thanks for adding OCAS Sales Bot!')
      .setColor(COLORS.OCAS_GREEN)
      .setDescription(desc)
      .addFields(
        {name:'Quick Setup (2 minutes)', value:setup, inline:false},
        {name:'Recommended Channel Layout', value:channelTip, inline:false},
        {name:'Personal DM Alerts (anyone can use)', value:personalAlerts, inline:false},
        {name:'Server-Wide Filters (admin only)', value:serverFilters, inline:false}
      )
      .addFields({name:'🔥 Burn Machine Alerts (optional)',
        value:'Run `/setupburn` in the channel where you want burn events posted.\nTracks every OCAS burn finalization automatically.',
        inline:false})
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
  await loadBurnConfig();
  console.log('Servers configured: '+Object.keys(serverConfigs).length);
  pollSales();
  pollListings();
  setInterval(pollSales, POLL_MS);
  setInterval(pollListings, POLL_MS);
  // Persist cursors every 60s so restarts lose at most 1 min of cursor progress
  setInterval(saveSaleCursors, 60_000);
  setInterval(saveListingCursors, 60_000);
  // Poll burn events every 2 minutes (blocks ~12s apart, no need to rush)
  if(process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_WEBSOCKET_URL){
    console.log('[Burn] Starting burn poller');
    pollBurnEvents();
    setInterval(pollBurnEvents, 2 * 60 * 1000);
  } else {
    console.log('[Burn] No ALCHEMY_API_KEY set — burn poller disabled');
  }
});

client.on('error',e=>console.error('[Discord]',e.message));
process.on('unhandledRejection',e=>console.error('[Bot]',e));
client.login(DISCORD_TOKEN);
