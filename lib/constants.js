'use strict';
require('dotenv').config();

const path = require('path');

// ── Discord token + API keys ──────────────────────────────────────────────────
const DISCORD_TOKEN         = process.env.DISCORD_TOKEN;
const OPENSEA_KEY           = process.env.OPENSEA_KEY || '';
const ALCHEMY_KEY           = process.env.ALCHEMY_API_KEY || '';
const API_SECRET            = process.env.API_SECRET || '';
const ERROR_WEBHOOK_URL     = process.env.ERROR_WEBHOOK_URL || '';
// Optional, separate webhook for successful-backfill activity reports —
// falls back to ERROR_WEBHOOK_URL if not set, so this works with zero new
// setup, but can be split into its own channel later if desired.
const ACTIVITY_WEBHOOK_URL  = process.env.ACTIVITY_WEBHOOK_URL || '';
const BOT_ENV               = process.env.BOT_ENV || 'staging';
const POLL_MS               = parseInt(process.env.POLL_MS || '30000', 10);
const SERVER_FILE           = path.join(__dirname, '../../server-configs.json');
const ALERTS_FILE           = path.join(__dirname, '../../user-alerts.json');

// Resolved once at startup
const RAILWAY_API_URL_CACHED = String(
  process.env.RAILWAY_API_URL ||
  process.env.TRAITVIEW_API_URL ||
  process.env.RAILWAY_URL ||
  process.env.API_URL ||
  process.env.BOT_API_URL ||
  ''
).trim().replace(/\/+$/, '');

function getRailwayApiUrl(){ return RAILWAY_API_URL_CACHED; }

// ── Brand colors ──────────────────────────────────────────────────────────────
const COLORS = {
  OCAS_BG:       0x4C6464,
  OCAS_GREEN:    0x1CFFAF,
  OPENSEA_BLUE:  0x0786FF,
  RANK_TOP_100:  0xF59E0B,
  RANK_TOP_1000: 0xC758FF,
  WETH_ROSE:     0xF43F5E,
};

// ── OCAS collection ───────────────────────────────────────────────────────────
const OCAS_CONTRACT  = '0x078be86f3104a32313a47815792230a3808642cc';
const OCAS_SLUG      = 'on-chain-all-stars'; // OpenSea collection slug; matches migrations/003's backfill value
const BURN_CONTRACT  = '0x1095c73C337CC5e03f9E1D426c524CC3e32a50f6';
const BURN_START_BLOCK = parseInt(process.env.BURN_START_BLOCK || '0', 10);

// ── Burn machine ──────────────────────────────────────────────────────────────
const TOPIC_BURN_STARTED   = '0x9b30fe8b84a7b16c3d3a03b4ce8fb74516c11b37b8f53b8c2e78f53c09462a1b'.toLowerCase();
const TOPIC_BURN_FINALIZED = '0x1d7e3a05ac4c5d3e2a6e7c48b1b1b2c8b6d5a1e4f3c2a7b9d8e1f2c3d4e5f6'.toLowerCase();
const BURN_LAG_ALERT_BLOCKS = 50;
const BURN_BLOCK_CHUNK      = Math.max(1, parseInt(process.env.BURN_BLOCK_CHUNK || '10', 10)); // Alchemy free tier max; set BURN_BLOCK_CHUNK=2000 when using Infura via ALCHEMY_WEBSOCKET_URL

// ── Rank sync ─────────────────────────────────────────────────────────────────
const RANK_SYNC_DELAY_MS = 45_000;
const RANK_SYNC_BATCH    = 200;
const RANK_SYNC_INTERVAL = 3600_000 / RANK_SYNC_BATCH;

// ── Cache limits ──────────────────────────────────────────────────────────────
const IMAGE_CACHE_TTL   = 60 * 60 * 1000; // 1 hour
const IMAGE_CACHE_MAX   = 2000;
const IMAGE_CACHE_EVICT = 200;
const OCAS_TRAITS_CACHE_MAX = 1000;
const TOKEN_META_CACHE_MAX   = 3000; // keyed by slug:tokenId, so higher than single-collection caches
const TOKEN_META_CACHE_EVICT = 300;

// ── Lottery ───────────────────────────────────────────────────────────────────
const PENDING_DRAW_SEED_PREFIX  = '__PENDING_DRAW_SEED__';
const DEFAULT_LOTTERY_TIMEZONE  = 'Europe/London';

// ── Bot owner override ────────────────────────────────────────────────────────
// Discord user IDs that bypass paid-tier gating everywhere, regardless of which
// server or collection they're in. Used so the bot's own creator can test any
// command/feature on any collection without needing to flag it as paid-tier.
const OWNER_DISCORD_IDS = new Set(['268159238855983109']);

// ── OpenSea helpers ───────────────────────────────────────────────────────────
function osHeaders(){
  return OPENSEA_KEY
    ? { 'X-API-KEY': OPENSEA_KEY, 'Accept': 'application/json' }
    : { 'Accept': 'application/json' };
}

function getRankTierColor(osRank){
  const n = Number(osRank);
  if(!n || !Number.isFinite(n)) return null;
  if(n >= 1   && n <= 100)  return COLORS.RANK_TOP_100;
  if(n >= 101 && n <= 1000) return COLORS.RANK_TOP_1000;
  return null;
}

module.exports = {
  DISCORD_TOKEN, OPENSEA_KEY, ALCHEMY_KEY, API_SECRET, ERROR_WEBHOOK_URL, ACTIVITY_WEBHOOK_URL,
  BOT_ENV, POLL_MS, SERVER_FILE, ALERTS_FILE,
  RAILWAY_API_URL_CACHED, getRailwayApiUrl,
  COLORS, OCAS_CONTRACT, OCAS_SLUG, BURN_CONTRACT, BURN_START_BLOCK,
  TOPIC_BURN_STARTED, TOPIC_BURN_FINALIZED,
  BURN_LAG_ALERT_BLOCKS, BURN_BLOCK_CHUNK,
  RANK_SYNC_DELAY_MS, RANK_SYNC_BATCH, RANK_SYNC_INTERVAL,
  IMAGE_CACHE_TTL, IMAGE_CACHE_MAX, IMAGE_CACHE_EVICT, OCAS_TRAITS_CACHE_MAX,
  TOKEN_META_CACHE_MAX, TOKEN_META_CACHE_EVICT,
  PENDING_DRAW_SEED_PREFIX, DEFAULT_LOTTERY_TIMEZONE, OWNER_DISCORD_IDS,
  osHeaders, getRankTierColor,
};
