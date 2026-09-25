/**
 * NFT Sales + Listings Bot — Multi-Server Public Edition
 * Entry point — wires together all modules.
 *
 * Architecture:
 *   lib/constants.js    — shared constants and env vars
 *   lib/db.js           — pgPool, migrations, config helpers
 *   lib/error.js        — error webhook, startup checks
 *   lib/cache.js        — imageCache, ocasTraitsCache, sessions, dedup
 *   lib/rpc.js          — Ethereum RPC helpers
 *   lib/rank-sync.js    — background OS rank sync
 *   utils/format.js     — formatting helpers
 *   utils/lottery.js    — lottery crypto and window helpers
 *   commands/admin.js   — server configuration commands
 *   commands/market.js  — market/NFT lookup commands
 *   commands/ocas.js    — OCAS-specific commands
 *   commands/burn.js    — burn machine commands
 *   commands/lottery.js — lottery commands
 *   commands/misc.js    — /help and other misc commands
 */

require('dotenv').config();

// ── Discord.js ────────────────────────────────────────────────────────────────
const {
  Client, GatewayIntentBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, AttachmentBuilder, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const fetch = require('node-fetch');
const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

// ── Lib modules ───────────────────────────────────────────────────────────────
const {
  DISCORD_TOKEN, OPENSEA_KEY, ALCHEMY_KEY, API_SECRET,
  COLORS, OCAS_CONTRACT, BURN_CONTRACT,
  POLL_MS, RANK_SYNC_INTERVAL, BOT_ENV,
  osHeaders, getRailwayApiUrl, getRankTierColor,
  PENDING_DRAW_SEED_PREFIX,
} = require('./lib/constants');

const {
  pgPool, runMigrations, dbLoad, dbSave,
  loadAllConfigs, getConfig, setConfig,
  getUserAlerts, setUserAlerts,
  loadSaleCursor, saveSaleCursor, getSaleCursor,
} = require('./lib/db');

const { sendErrorWebhook, checkStartupEnvVars } = require('./lib/error');

const {
  imageCache, getCachedImage, setCachedImage,
  ocasTraitsCache, getCachedTraits, setCachedTraits,
  sweepSessions, slideshowSessions,
  recentChannelPosts, alertedEventIds,
  checkCooldown, dedupeChannelPost,
} = require('./lib/cache');

const { burnRpc, burnRpcUrl, fetchEthBlockHashSeed, waitForEthBlock, getBurnBlockTimestamp } = require('./lib/rpc');
const { rankSyncQueue, rollingRankSync, drainRankSyncQueue, queueRankSync } = require('./lib/rank-sync');

// ── Utils ─────────────────────────────────────────────────────────────────────
const {
  normAddr, shortAddr, formatEth, formatListingEth,
  timeSince, lotteryTime, formatBurnLotteryWindow,
  isSvg, isDiscordOk, matchesFilters,
} = require('./utils/format');

const {
  lotteryHash, lotteryPick, randomLotterySeed,
  pendingDrawSeed, isPendingDrawSeed,
  parseLotteryDate, normalizeLotteryTimezone, resolveLotteryWindow,
} = require('./utils/lottery');

// ── Command modules ───────────────────────────────────────────────────────────
const { handleAdminCommand, ADMIN_COMMANDS }   = require('./commands/admin');
const { handleMarketCommand, MARKET_COMMANDS } = require('./commands/market');
const { handleOcasCommand, OCAS_COMMANDS }     = require('./commands/ocas');
const { handleBurnCommand, BURN_COMMANDS }     = require('./commands/burn');
const { handleLotteryCommand, LOTTERY_COMMANDS } = require('./commands/lottery');
const { handleMiscCommand, MISC_COMMANDS }     = require('./commands/misc');

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── The rest of the original bot.js (everything between client creation and commands) ──
// NOTE: This section will be progressively extracted in future sessions.
// For now, all non-command logic (burn poller, embeds, helpers, etc.) remains
// in this file and is imported/referenced by the command modules via ctx.

