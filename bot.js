/**
 * NFT Sales + Listings Bot — Modular Edition
 * Entry point — wires all modules together.
 */

require('dotenv').config();

const {
  Client, GatewayIntentBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, AttachmentBuilder, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const fetch = require('node-fetch');
const sharp = require('sharp');

// ── Lib ───────────────────────────────────────────────────────────────────────
const {
  DISCORD_TOKEN, OPENSEA_KEY, ALCHEMY_KEY, API_SECRET,
  COLORS, OCAS_CONTRACT, BURN_CONTRACT,
  POLL_MS, RANK_SYNC_INTERVAL, BOT_ENV,
  osHeaders, getRailwayApiUrl, getRankTierColor,
  PENDING_DRAW_SEED_PREFIX, DEFAULT_LOTTERY_TIMEZONE,
  } = require('./lib/constants');

const {
  pgPool, runMigrations, dbLoad, dbSave,
  loadAllConfigs, getConfig, setConfig, getAllConfigs,
} = require('./lib/db');

const { sendErrorWebhook, checkStartupEnvVars } = require('./lib/error');

const {
  getCachedImage, setCachedImage, clearCachedImage,
  getCachedTraits, setCachedTraits, OCAS_TRAITS_CACHE_MAX,
  sweepSessions, slideshowSessions,
  recentChannelPosts, alertedEventIds,
  checkCooldown, dedupeChannelPost, ocasTraitsCache,
} = require('./lib/cache');

const { burnRpc, burnRpcUrl, fetchEthBlockHashSeed, waitForEthBlock, realTraitCount } = require('./lib/rpc');
const { rollingRankSync, drainRankSyncQueue, queueRankSync, rankSyncQueue } = require('./lib/rank-sync');

const { BURN_COLORS, E1_TYPE_NAMES, normalizeOcasType, resolveOcasType, burnTypeLabel, burnTypeColor, burnTypeEmoji } = require('./lib/burn-constants');
const {
  burnConfig, loadBurnConfig, saveBurnConfig,
  getBurnConfig, getConfiguredBurnChannelId,
  checkCommandCooldown, fetchBotApiJson,
  buildNavRow, postEmbeds,
  getTraitIndex, chooseTraitGroupsFromQuery, normalizePhrase,
} = require('./lib/burn-config');

const {
  pollBurnEvents, processPendingBurnAlerts,
  buildBurnEmbed, triggerOsMetadataRefresh,
  setClient, traitDisplayLines, fetchTokenUriFromContract,
} = require('./lib/burn-poller');

const {
  buildBurnLotteryEmbed, buildActiveBurnLotteryComponents, buildBurnLotteryComponents,
  buildGenericLotteryStartEmbed, buildGenericLotteryResultEmbed,
  buildGenericLotteryComponents, getGenericLotteryEntryCount,
  drawGenericLottery, processDueGenericLotteries,
  getBurnLotteryEntries, drawAndPostBurnLottery, processDueBurnLotteries,
  findActiveGenericLottery, lotteryNumberFromSeed,
} = require('./lib/lottery-engine');

const { fetchTokenMetaFromDb, upsertTokenTraitRows, buildSaleEmbed, buildListingEmbed,
  traitObjectToArray, burnTypeBreakdown, fetchBurnDisplayTraits, fetchSnapshotImageForToken,
  osRankBadge, titleTokenId,
} = require('./lib/embeds');
const { resolveImage, sendEmbed, extractPngFromSvg, buildEmbedPayload } = require('./lib/images');

const {
  pollSales, pollListings,
  getAlert, setAlert, deleteAlert,
  loadAllAlerts, loadSaleCursors, loadListingCursors,
  saveSaleCursors, saveListingCursors,
  setClient: setPollClient,
  traitGroupsLabel, buildTokenSearchEmbed,
} = require('./lib/poll');

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
  LOTTERY_DURATION_RE,
} = require('./utils/lottery');

// ── Command modules ───────────────────────────────────────────────────────────
const { handleAdminCommand, ADMIN_COMMANDS }     = require('./commands/admin');
const { handleMarketCommand, MARKET_COMMANDS, handleTraitBrowseInteraction, handleMyAlertInteraction, showMaTraitPicker, handleMaClearInteraction, handleMeInteraction }   = require('./commands/market');
const { backfillWallet } = require('./lib/wallet-backfill');
const { handleOcasCommand, OCAS_COMMANDS }       = require('./commands/ocas');
const { handleTokenCommand, TOKEN_COMMANDS }     = require('./commands/token');
const { handleBurnCommand, BURN_COMMANDS }       = require('./commands/burn');
const { handleGiveawayCommand, handleGiveawayInteraction, GIVEAWAY_COMMANDS } = require('./commands/giveaway');
const { handleMiscCommand, MISC_COMMANDS }       = require('./commands/misc');
const { handleDownloadCommand, DOWNLOAD_COMMANDS } = require('./commands/download');
const { handleSetupCommand, handleSetupButton, handleSetupModal, SETUP_COMMANDS } = require('./commands/setup');
const { handleConfigCommand, handleConfigButton, handleConfigModal, CONFIG_COMMANDS } = require('./commands/config');
const { handleLotteriesCommand, handleLotteriesButton, LOTTERIES_COMMANDS } = require('./commands/lotteries');

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,  // needed for guildMemberRemove and members.fetch()
] });
setClient(client); // inject into burn-poller
setPollClient(client); // inject into poll

// ── resolveDiscordChannel — needs client, defined here ───────────────────────
// Inject client into burn-poller so it can resolve channels

async function resolveDiscordChannel(channelId){
  if(!channelId) return null;
  return client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(()=>null);
}

// ── Shared context builder ────────────────────────────────────────────────────
// Passed to every command handler so they have access to all shared state.
function buildCtx(interaction, guildId, config, isAdmin){
  return {
    interaction, guildId, config, isAdmin,
    // Constants
COLORS, OCAS_CONTRACT, BURN_CONTRACT, BURN_COLORS, E1_TYPE_NAMES, DEFAULT_LOTTERY_TIMEZONE,
    // Helpers
    osHeaders, getRailwayApiUrl, getRankTierColor, fetchBotApiJson, resolveDiscordChannel,
    checkCommandCooldown, normalizeOcasType, burnTypeLabel, burnTypeColor, burnTypeEmoji,
    API_SECRET, sendErrorWebhook,
    // DB
    pgPool, dbLoad, dbSave, getConfig, setConfig,
    // Cache
    getCachedImage, setCachedImage, clearCachedImage, getCachedTraits, setCachedTraits,
    sweepSessions, slideshowSessions, recentChannelPosts,
    // RPC
    burnRpc, burnRpcUrl, fetchEthBlockHashSeed, waitForEthBlock,
    // Embeds
    buildSaleEmbed, buildListingEmbed, sendEmbed, postEmbeds,
    resolveImage, extractPngFromSvg, fetchTokenMetaFromDb,
    buildBurnEmbed, buildBurnLotteryEmbed,
    buildActiveBurnLotteryComponents, buildBurnLotteryComponents,
    buildGenericLotteryStartEmbed, buildGenericLotteryResultEmbed,
    buildGenericLotteryComponents,
    // Burn
    burnConfig, saveBurnConfig, getBurnConfig, getConfiguredBurnChannelId,
    upsertTokenTraitRows, triggerOsMetadataRefresh,
    getBurnLotteryEntries, drawAndPostBurnLottery,
    processDueBurnLotteries,
    // Lottery
    drawGenericLottery, processDueGenericLotteries, getGenericLotteryEntryCount,
    // Crypto
    lotteryPick, lotteryHash, pendingDrawSeed, isPendingDrawSeed,
    randomLotterySeed, resolveLotteryWindow, LOTTERY_DURATION_RE,
    // Alerts
    getAlert, setAlert, deleteAlert,
    // Format
    resolveDiscordChannel,
    // Trait/search helpers
    getTraitIndex, chooseTraitGroupsFromQuery, normalizePhrase,
    traitGroupsLabel, buildTokenSearchEmbed,
    traitDisplayLines, traitObjectToArray, fetchTokenUriFromContract,
    burnTypeBreakdown, fetchBurnDisplayTraits, fetchSnapshotImageForToken,
    buildEmbedPayload, osRankBadge, titleTokenId,
    // Lottery extras
    findActiveGenericLottery, lotteryNumberFromSeed,
    // Cache
    ocasTraitsCache,
    normAddr, shortAddr, formatEth, timeSince, lotteryTime,
    formatBurnLotteryWindow, isSvg, isDiscordOk, matchesFilters,
    // Rank sync
    rankSyncQueue, queueRankSync,
    // Components
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder, AttachmentBuilder, MessageFlags, PermissionFlagsBits,
  };
}

// ── interactionCreate — button handlers + command dispatch ────────────────────


// ── Burn lottery proof helpers (migrated from main) ───────────────────────────
function formatZonedLotteryTime(d, timeZone){
  return new Intl.DateTimeFormat('en-US', {
    timeZone, month:'short', day:'numeric', year:'numeric',
    hour:'numeric', minute:'2-digit', timeZoneName:'short'
  }).format(new Date(d));
}

function formatLotteryHours(hours){
  const n = Number(hours);
  if(!Number.isFinite(n)) return 'unknown';
  if(n < 1){
    const mins = Math.round(n * 60);
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  return (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))) + ' hour' + (n === 1 ? '' : 's');
}

function burnLotteryWindowDurationHours(start, end){
  return (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
}

function burnLotteryWindowDetails(start, end, timeZone){
  const tz = normalizeLotteryTimezone(timeZone);
  return [
    `Timezone: ${tz}`,
    `Duration: ${formatLotteryHours(burnLotteryWindowDurationHours(start, end))}`
  ].join('\n');
}

function etherscanAddressLink(addr){
  const a = String(addr || '').toLowerCase();
  if(!/^0x[a-f0-9]{40}$/.test(a)) return String(addr || 'unknown');
  return `[${shortAddr(a)}](https://etherscan.io/address/${a})`;
}

// ── Burn lottery display helpers (migrated from main) ─────────────────────────
function burnLotteryParseErrorMessage(){
  return [
    'I could not parse that burn lottery window.',
    'Try:',
    '• 06-07-2026-3pm for MM-DD-YYYY',
    '• uk:06-07-2026-3pm for DD-MM-YYYY',
    '• uk:08-06-2026 15:00 for 24-hour time',
    '• Use window: now 10minutes or window: now 2h for a quick window'
  ].join('\n');
}

function burnLotteryModeNote(mode){
  return mode === 'burn'
    ? 'One entry per burn. Wallets may appear multiple times.'
    : 'One entry per wallet.';
}

function burnLotteryDisplayEntries(entries, wallets, mode){
  return mode === 'burn' ? entries : wallets;
}

function buildBurnLotteryEntryPageComponents(lotteryId, page, totalPages, live=false){
  if(!lotteryId || totalPages <= 1) return [];
  const prefix = live ? 'burnlottery_current_entries' : 'burnlottery_entries';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:${lotteryId}:${Math.max(0, page - 1)}`)
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:${lotteryId}:${Math.min(totalPages - 1, page + 1)}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  )];
}


// ── Recursive string search ─────────────────────────────────────────────────
function collectStringsDeep(obj, out=[]){
  if(obj == null) return out;
  if(typeof obj === 'string'){ out.push(obj); return out; }
  if(Array.isArray(obj)){ for(const item of obj) collectStringsDeep(item, out); return out; }
  if(typeof obj === 'object'){ for(const val of Object.values(obj)) collectStringsDeep(val, out); }
  return out;
}

// ── Trait role sync ─────────────────────────────────────────────────────────
async function syncTraitRoles(guild, discordId, wallet){
  try{
    // Get all trait roles configured for this guild — collection_slug NULL means "primary collection"
    const traitRolesRes = await pgPool.query(
      'SELECT trait_type, trait_value, role_id, minimum_count, collection_slug FROM trait_roles WHERE guild_id=$1',
      [guild.id]
    );

    if(!traitRolesRes.rows.length) return { assigned: [], skipped: [], alreadyHad: [] }; // No trait roles configured

    const cfg = getConfig(guild.id) || {};
    const primarySlug = cfg.collectionSlug || cfg.slug || 'on-chain-all-stars';
    const extraCollections = (cfg.collections || []).filter(c => c.slug);

    // Group rules by their target collection slug (NULL/primary rules go under primarySlug)
    const rulesBySlug = {};
    for(const tr of traitRolesRes.rows){
      const slug = tr.collection_slug || primarySlug;
      if(!rulesBySlug[slug]) rulesBySlug[slug] = [];
      rulesBySlug[slug].push(tr);
    }

    const member = await guild.members.fetch(discordId).catch(()=>null);
    if(!member) return { assigned: [], skipped: [], alreadyHad: [] };

    const rolesSummary = { assigned: [], skipped: [], alreadyHad: [] };
    let totalOwnedAcrossCollections = 0;

    // Process each collection separately — fetch ownership + traits scoped to that slug
    for(const slug of Object.keys(rulesBySlug)){
      const rules = rulesBySlug[slug];

      const osRes = await fetch(
        `https://api.opensea.io/api/v2/chain/ethereum/account/${wallet}/nfts?collection=${slug}&limit=200`,
        { headers: osHeaders() }
      );
      if(!osRes.ok){
        console.error('[TraitSync] OpenSea NFT fetch failed for', slug, ':', osRes.status);
        continue;
      }
      const osData = await osRes.json();
      const ownedTokenIds = (osData.nfts||[]).map(n => parseInt(n.identifier)).filter(Boolean);
      totalOwnedAcrossCollections += ownedTokenIds.length;

      // Build trait count map for this collection's owned tokens.
      // Primary OCAS collection uses the legacy token_traits table (rich on-chain data);
      // other collections derive trait counts from the OpenSea per-NFT trait list directly.
      const traitCounts = {};
      if(slug === primarySlug){
        if(ownedTokenIds.length){
          const traitsRes = await pgPool.query(
            'SELECT trait_name, trait_value, COUNT(*) as count FROM token_traits WHERE token_id = ANY($1::int[]) GROUP BY trait_name, trait_value',
            [ownedTokenIds]
          );
          for(const r of traitsRes.rows)
            traitCounts[r.trait_name+'::'+r.trait_value] = parseInt(r.count);
        }
      } else {
        for(const nft of (osData.nfts || [])){
          for(const t of (nft.traits || [])){
            const key = t.trait_type + '::' + t.value;
            traitCounts[key] = (traitCounts[key] || 0) + 1;
          }
        }
      }

      for(const tr of rules){
        const hasRole = member.roles.cache.has(tr.role_id);
        let count;
        if(tr.trait_type === '_count'){
          count = ownedTokenIds.length;
        } else {
          count = traitCounts[tr.trait_type+'::'+tr.trait_value] || traitCounts[tr.trait_type+'::'+String(tr.trait_value||'')] || 0;
        }
        const minNeeded = parseInt(tr.minimum_count) || 1;
        const meetsMin = count >= minNeeded;
        console.log('[TraitSync]', slug, '| rule:', tr.trait_type, tr.trait_value||'', '>=', minNeeded, '| count:', count, '| meets:', meetsMin);

        if(meetsMin && !hasRole){
          const conflict = await isRoleManagedByOtherBot(guild, tr.role_id);
          if(!conflict){
            await member.roles.add(tr.role_id).catch(e=>console.error('[TraitSync] add role:', e.message));
            rolesSummary.assigned.push(tr.role_id);
          } else {
            console.log('[TraitSync] SKIP add — role managed by other bot:', tr.role_id);
            rolesSummary.skipped.push(tr.role_id);
          }
        } else if(meetsMin && hasRole){
          rolesSummary.alreadyHad.push(tr.role_id);
        }
        if(!meetsMin && hasRole){
          const conflict = await isRoleManagedByOtherBot(guild, tr.role_id);
          if(!conflict) await member.roles.remove(tr.role_id).catch(()=>{});
        }
      }
    }

    // Assign verified + holder roles from verification panel config
    const panel = await pgPool.query(
      'SELECT role_id, holder_role_id FROM verification_panels WHERE guild_id=$1',
      [guild.id]
    );
    if(panel.rows.length){
      const { role_id, holder_role_id } = panel.rows[0];
      // Verified role — any registered wallet
      if(role_id && !member.roles.cache.has(role_id))
        await member.roles.add(role_id).catch(()=>{});
      // Holder role — must own ≥1 token across any configured collection
      if(holder_role_id){
        if(totalOwnedAcrossCollections >= 1 && !member.roles.cache.has(holder_role_id))
          await member.roles.add(holder_role_id).catch(()=>{});
        if(totalOwnedAcrossCollections === 0 && member.roles.cache.has(holder_role_id))
          await member.roles.remove(holder_role_id).catch(()=>{});
      }
    }

    console.log('[TraitSync] Synced roles for', discordId, 'in', guild.name, '| tokens:', totalOwnedAcrossCollections, '| assigned:', rolesSummary.assigned.length, '| skipped:', rolesSummary.skipped.length);
    return rolesSummary;
  }catch(e){
    console.error('[TraitSync] Error:', e.message);
    return { assigned: [], skipped: [], alreadyHad: [] };
  }
}

// ── 24hr trait role sync job ──────────────────────────────────────────────────
async function runDailyTraitSync(){
  console.log('[TraitSync] Starting daily sync...');
  try{
    // Get all verified registrations
    const regs = await pgPool.query(
      'SELECT discord_id, guild_id, wallet FROM user_registrations WHERE verified=true'
    );
    for(const reg of regs.rows){
      const guild = client.guilds.cache.get(reg.guild_id);
      if(!guild) continue;
      await syncTraitRoles(guild, reg.discord_id, reg.wallet);
      await new Promise(r=>setTimeout(r, 500)); // Rate limit buffer
    }
    console.log('[TraitSync] Daily sync complete —', regs.rows.length, 'wallets synced');
  }catch(e){
    console.error('[TraitSync] Daily sync error:', e.message);
  }
}

// ── Discord winner ping lookup ──────────────────────────────────────────────
async function lookupDiscordPing(wallet){
  if(!wallet) return null;
  try{
    const r = await pgPool.query(
      `SELECT discord_id FROM user_registrations WHERE wallet=$1 AND verified=true`,
      [wallet.toLowerCase()]
    );
    return r.rows.length ? `<@${r.rows[0].discord_id}>` : null;
  }catch(_){ return null; }
}

// ── Role conflict detection ──────────────────────────────────────────────────
async function checkRoleConflict(guild, roleId){
  try{
    const role = await guild.roles.fetch(roleId);
    if(!role) return null;
    // Managed roles are controlled by integrations — never touch
    if(role.managed) return 'managed';
    // Check audit log — if another bot last assigned this role, flag it
    const logs = await guild.fetchAuditLogs({ type:25, limit:20 }).catch(()=>null); // type 25 = MEMBER_ROLE_UPDATE
    if(logs){
      const entries = logs.entries.filter(e =>
        e.changes?.some(c => c.key === '$add' && c.new?.some(r => r.id === roleId))
      );
      const otherBotEntry = entries.find(e =>
        e.executor?.bot && e.executor.id !== guild.members.me?.id
      );
      if(otherBotEntry) return 'other_bot:'+otherBotEntry.executor.id;
    }
    return null;
  }catch(_){ return null; }
}

// Cache of role conflicts per guild to avoid repeated audit log fetches
const _roleConflictCache = new Map(); // 'guildId:roleId' -> {result, ts}

// ── Trait index cache — per slug, 10-min TTL ─────────────────────────────────
const _traitIndexCache = new Map();
async function getCachedTraitIndex(RAILWAY_URL, API_SECRET, slug) {
  const cached = _traitIndexCache.get(slug);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.rows;
  try {
    const rows = await getTraitIndex(RAILWAY_URL, API_SECRET, slug);
    _traitIndexCache.set(slug, { rows, ts: Date.now() });
    return rows;
  } catch(e) {
    if (cached) return cached.rows;
    throw e;
  }
}
async function isRoleManagedByOtherBot(guild, roleId){
  const key = guild.id+':'+roleId;
  const cached = _roleConflictCache.get(key);
  // Cache for 10 minutes
  if(cached && Date.now() - cached.ts < 10*60*1000) return cached.result;
  const result = await checkRoleConflict(guild, roleId);
  const conflict = result !== null;
  _roleConflictCache.set(key, { result: conflict, ts: Date.now() });
  if(conflict) console.log('[RoleConflict]', roleId, 'in', guild.name, ':', result);
  return conflict;
}

client.on('interactionCreate', async (interaction)=>{
  // ── Autocomplete for collection slugs ───────────────────────────────────────
  if(interaction.isAutocomplete()){
    const focused = interaction.options.getFocused(true); // {name, value}
    const focusedValue = focused.value.toLowerCase();
    const guildId = interaction.guildId;
    const cfg = getConfig(guildId) || {};
    const commandName = interaction.commandName;

    // trait/value autocomplete for traitfind — uses in-memory cache for instant response
    if(commandName === 'traitfind' && (focused.name === 'trait' || focused.name === 'value')){
      const RAILWAY_URL = getRailwayApiUrl();
      const API_SECRET = process.env.API_SECRET;
      const colInput = interaction.options.getString('collection') || null;
      const allCols = [];
      const primarySlug = cfg.collectionSlug || cfg.slug;
      if(primarySlug) allCols.push({ slug: primarySlug, name: cfg.contractName || primarySlug });
      for(const c of cfg.collections || []) { if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }
      if(!colInput && allCols.length > 1 && focused.name === 'trait'){
        return interaction.respond([{ name: '← Select a collection first', value: '__select_collection__' }]);
      }
      let slug = primarySlug || 'on-chain-all-stars';
      if(colInput){
        const match = allCols.find(c => c.slug === colInput || c.name === colInput);
        if(match) slug = match.slug;
        else slug = colInput;
      }
      try {
        const traitIndex = await getCachedTraitIndex(RAILWAY_URL, API_SECRET, slug);
        let choices = [];
        if(focused.name === 'trait'){
          const names = [...new Set(traitIndex.map(t => t.trait_name))];
          choices = names
            .filter(n => n.toLowerCase().includes(focusedValue))
            .slice(0, 25)
            .map(n => ({ name: n, value: n }));
        } else {
          const selectedTrait = (interaction.options.getString('trait') || '').toLowerCase();
          const vals = traitIndex
            .filter(t => (!selectedTrait || t.trait_name.toLowerCase() === selectedTrait) && t.trait_value.toLowerCase().includes(focusedValue))
            .map(t => t.trait_value);
          choices = [...new Set(vals)].slice(0, 25).map(v => ({ name: v, value: v }));
        }
        return interaction.respond(choices);
      } catch(e) {
        return interaction.respond([]);
      }
    }

    // collection slug autocomplete (all commands)
    const choices = [];
    if(cfg.slug || cfg.collectionSlug){
      const slug = cfg.slug || cfg.collectionSlug;
      const name = cfg.contractName || slug;
      choices.push({ name: `${name} (${slug})`, value: slug });
    }
    for(const col of cfg.collections || []){
      if(col.slug) choices.push({ name: `${col.name||col.slug} (${col.slug})`, value: col.slug });
    }
    const filtered = choices
      .filter(c => c.name.toLowerCase().includes(focusedValue) || c.value.toLowerCase().includes(focusedValue))
      .slice(0, 25);
    return interaction.respond(filtered.length ? filtered : choices.slice(0,25));
  }


  // ── Wallet verification button ────────────────────────────────────────────

  // ── start_verification wallet modal submit ────────────────────────────────────
  if(interaction.isModalSubmit() && interaction.customId.startsWith('sv_modal:username:')){
    await interaction.deferReply({flags:64});
    const discordId  = interaction.user.id;
    const guildId    = interaction.guildId;
    const osUsername = (interaction.fields.getTextInputValue('os_username')||'').trim();

    if(!osUsername)
      return interaction.editReply({content:'❌ Please enter your OpenSea username.'});

    // Look up pending code for this user
    let codeRow;
    try{
      const r = await pgPool.query(
        'SELECT code, expires_at FROM verification_codes WHERE discord_id=$1 ORDER BY expires_at DESC LIMIT 1',
        [discordId]
      );
      codeRow = r.rows[0];
    }catch(e){
      console.error('[SVModal] DB lookup error:', e.message);
      return interaction.editReply({content:'❌ DB error. Please try again.'});
    }

    if(!codeRow) return interaction.editReply({content:'❌ No pending verification. Click Verify Wallet again.'});
    if(new Date() > new Date(codeRow.expires_at))
      return interaction.editReply({content:'❌ Code expired. Click Verify Wallet again.'});

    const code = codeRow.code;
    // Fetch OpenSea profile by username
    let profile;
    try{
      const osRes = await fetch(`https://api.opensea.io/api/v2/accounts/${osUsername}`, { headers:osHeaders() });
      if(!osRes.ok){
        if(osRes.status===404) return interaction.editReply({content:`❌ OpenSea username \`${osUsername}\` not found. Check the spelling and try again.`});
        return interaction.editReply({content:`❌ OpenSea error (${osRes.status}). Try again.`});
      }
      profile = await osRes.json();
    }catch(e){
      console.error('[SVModal]', e.message);
      return interaction.editReply({content:'❌ Failed to reach OpenSea. Try again.'});
    }

    // Check code is in their username
    const displayName = profile.username || '';
    if(!displayName.includes(code))
      return interaction.editReply({content:[
        '❌ Code not found in your OpenSea username.',
        '',
        `Go to https://opensea.io/${osUsername} → Edit Profile → temporarily add this to your username:`,
        '```'+code+'```',
        'Save, then try again. You can remove it after verification.',
      ].join('\n')});

    // Get all wallets linked to this OpenSea account
    const addresses = profile.addresses || [];
    const wallets = addresses
      .map(a => (a.address||'').toLowerCase())
      .filter(a => /^0x[0-9a-f]{40}$/.test(a));

    if(!wallets.length)
      return interaction.editReply({content:'❌ No Ethereum wallets linked to that OpenSea account. Connect a wallet on OpenSea first.'});

    // Use first wallet as primary, check holdings across all
    const primaryWallet = wallets[0];
    const cfg = getConfig(guildId) || {};
    const slug = cfg.collectionSlug || cfg.slug || 'on-chain-all-stars';

    // Fetch NFTs across all wallets combined
    let totalTokens = [];
    for(const w of wallets){
      try{
        const nftRes = await fetch(
          `https://api.opensea.io/api/v2/chain/ethereum/account/${w}/nfts?collection=${slug}&limit=200`,
          { headers:osHeaders(), agent:osAgent }
        );
        if(nftRes.ok){
          const nftData = await nftRes.json();
          totalTokens = totalTokens.concat(nftData.nfts||[]);
        }
      }catch(_){}
    }
    const tokenCount = totalTokens.length;

    // Save registration with primary wallet
    await pgPool.query(
      `INSERT INTO user_registrations (discord_id,guild_id,wallet,verified,verified_at,updated_at)
       VALUES ($1,$2,$3,true,NOW(),NOW())
       ON CONFLICT (discord_id,guild_id) DO UPDATE SET wallet=$3,verified=true,verified_at=NOW(),updated_at=NOW()`,
      [discordId, guildId, primaryWallet]
    ).catch(e => console.error('[SVModal] reg insert:', e.message));

    // Trigger wallet backfill (fire-and-forget)
    backfillWallet(primaryWallet, pgPool, process.env.ALCHEMY_API_KEY).catch(()=>{});

    // Assign roles
    try{
      const panelR = await pgPool.query(
        'SELECT role_id, holder_role_id FROM verification_panels WHERE guild_id=$1', [guildId]
      );
      if(panelR.rows[0]){
        const { role_id, holder_role_id } = panelR.rows[0];
        const member = await interaction.guild.members.fetch(discordId).catch(()=>null);
        if(member && role_id) await member.roles.add(role_id).catch(()=>{});
        if(member && holder_role_id && tokenCount >= 1)
          await member.roles.add(holder_role_id).catch(()=>{});
      }
    }catch(_){}

    // Clean up code
    await pgPool.query('DELETE FROM verification_codes WHERE discord_id=$1 AND guild_id=$2', [discordId, guildId]).catch(()=>{});

    const walletList = wallets.length > 1
      ? `\n🔗 **${wallets.length} wallets** linked (${wallets.map(w=>w.slice(0,6)+'...'+w.slice(-4)).join(', ')})`
      : `\n🔗 **Wallet:** \`${primaryWallet.slice(0,6)}...${primaryWallet.slice(-4)}\``;

    return interaction.editReply({content:[
      '✅ **Verified!**',
      walletList,
      `🪙 **Tokens found:** ${tokenCount} across all wallets`,
      '',
      'You can remove the code from your OpenSea username now.',
    ].join('\n')});
  }
  // ── Setup wizard modal + button handlers ───────────────────────────────────
  if(interaction.isModalSubmit() && interaction.customId.startsWith('setup_modal:')){
    const setupCtx = { pgPool, setConfig };
    return handleSetupModal(interaction, setupCtx);
  }
  if(interaction.isModalSubmit() && (interaction.customId.startsWith('cfg_modal:') || interaction.customId.startsWith('cfg_modal:col_filter:'))){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigModal(interaction, cfgCtx);
  }
  if(interaction.isModalSubmit() && interaction.customId.startsWith('gva_modal:')){
    const gGuildId = interaction.guildId;
    const gConfig = getConfig(gGuildId);
    const gIsAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    return handleGiveawayInteraction(interaction, buildCtx(interaction, gGuildId, gConfig, gIsAdmin));
  }

  if(interaction.isButton() && interaction.customId.startsWith('setup:')){
    const setupCtx = { pgPool, setConfig };
    return handleSetupButton(interaction, setupCtx);
  }
  if(interaction.isButton() && (interaction.customId.startsWith('cfg:') || interaction.customId.startsWith('cfg_role:') || interaction.customId.startsWith('cfg_col_filter:'))){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isButton() && interaction.customId.startsWith('ltrs:')){
    return handleLotteriesButton(interaction, { pgPool, getConfig });
  }
  if((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('gva:')){
    const gGuildId = interaction.guildId;
    const gConfig = getConfig(gGuildId);
    const gIsAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    return handleGiveawayInteraction(interaction, buildCtx(interaction, gGuildId, gConfig, gIsAdmin));
  }
  // Channel + role select menus from setup wizard
  if((interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) &&
     (interaction.customId.startsWith('setup_chsel:') || interaction.customId.startsWith('setup_rolesel:'))){
    const setupCtx = { pgPool, setConfig };
    return handleSetupButton(interaction, setupCtx);
  }
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('setup_traitrole:')){
    const setupCtx = { pgPool, setConfig };
    return handleSetupButton(interaction, setupCtx);
  }
  if(interaction.isStringSelectMenu() && (interaction.customId.startsWith('cfg_role:') || interaction.customId.startsWith('cfg_col:') || interaction.customId.startsWith('cfg_filter:') || interaction.customId.startsWith('cfg_col_filter:') || interaction.customId.startsWith('cfg_col_salesfilter:') || interaction.customId.startsWith('cfg_tzsel:'))){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('tf_browse:')){
    const tfCtx = {
      pgPool, getConfig, getRailwayApiUrl, getCachedTraitIndex,
      buildSaleEmbed, buildListingEmbed, postEmbeds, fetchBotApiJson,
      buildTokenSearchEmbed, fetchTokenMetaFromDb, traitObjectToArray,
    };
    return handleTraitBrowseInteraction(interaction, tfCtx);
  }
  if((interaction.isStringSelectMenu() || interaction.isButton()) && interaction.customId.startsWith('ma_browse:')){
    const maCtx = { getConfig, getRailwayApiUrl, getCachedTraitIndex, getAlert, setAlert };
    return handleMyAlertInteraction(interaction, maCtx);
  }
  if(interaction.isButton() && interaction.customId.startsWith('mac_browse:')){
    const macCtx = { getAlert, setAlert, deleteAlert };
    return handleMaClearInteraction(interaction, macCtx);
  }
  if((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('me_browse:')){
    const meCtx = { getAlert, setAlert, deleteAlert, getConfig, getRailwayApiUrl, getCachedTraitIndex, pgPool };
    return handleMeInteraction(interaction, meCtx);
  }

  // Modal submissions for price/floor alerts
  if(interaction.isModalSubmit() && interaction.customId.startsWith('me_modal:')){
    const parts = interaction.customId.split(':');
    const alertType = parts[1];
    const slug = parts.slice(2).join(':');

    if(alertType === 'pricealert'){
      const tokenId = parseInt(interaction.fields.getTextInputValue('token_id').trim());
      const threshold = parseFloat(interaction.fields.getTextInputValue('threshold').trim());
      const onceVal = (interaction.fields.getTextInputValue('once').trim() || 'once').toLowerCase();
      const alertOnce = onceVal !== 'repeat';
      const repeatAlert = !alertOnce;
      if(isNaN(tokenId) || isNaN(threshold) || threshold <= 0){
        return interaction.reply({ content: '❌ Invalid token ID or threshold. Token ID must be a number, threshold must be ETH like 0.05.', flags: MessageFlags.Ephemeral });
      }
      await pgPool.query(
        `INSERT INTO user_price_alerts (discord_id, slug, token_id, threshold_eth, alert_once, repeat_alert)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [interaction.user.id, slug, tokenId, threshold, alertOnce, repeatAlert]
      ).catch(()=>{});
      // Reply then show price alerts section
      const { ActionRowBuilder: AR2, ButtonBuilder: BB2, ButtonStyle: BS2 } = require('discord.js');
      await interaction.reply({
        content: `✅ Price alert set! I'll DM you when **#${tokenId}** (${slug}) is listed below **Ξ ${threshold.toFixed(4)}** (${alertOnce ? 'once' : 'repeating'}).`,
        components: [new AR2().addComponents(new BB2().setCustomId('me_browse:back').setLabel('← Back to My Settings').setStyle(BS2.Secondary))],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if(alertType === 'flooralert'){
      const threshold = parseFloat(interaction.fields.getTextInputValue('threshold').trim());
      const cooldownStr = interaction.fields.getTextInputValue('cooldown').trim() || '1h';
      // Parse cooldown — supports 30m, 2h, 1d, or plain number (minutes)
      const cooldownMinutes = (() => {
        const s = cooldownStr.toLowerCase();
        const m = s.match(/^([\d.]+)\s*([mhd]?)$/);
        if(!m) return 60;
        const val = parseFloat(m[1]);
        const unit = m[2] || 'm';
        if(unit === 'd') return Math.round(val * 24 * 60);
        if(unit === 'h') return Math.round(val * 60);
        return Math.round(val);
      })();
      if(isNaN(threshold) || threshold <= 0){
        return interaction.reply({ content: '❌ Invalid threshold. Enter an ETH amount like 0.05.', flags: MessageFlags.Ephemeral });
      }
      await pgPool.query(
        `INSERT INTO user_floor_alerts (discord_id, slug, threshold_eth, cooldown_minutes)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (discord_id, slug) DO UPDATE SET threshold_eth=$3, cooldown_minutes=$4`,
        [interaction.user.id, slug, threshold, cooldownMinutes]
      ).catch(()=>{});
      const cdDisplay = cooldownMinutes >= 1440 ? `${(cooldownMinutes/1440).toFixed(1).replace(/\.0$/,'')}d`
        : cooldownMinutes >= 60 ? `${(cooldownMinutes/60).toFixed(1).replace(/\.0$/,'')}h`
        : `${cooldownMinutes}m`;
      const { ActionRowBuilder: AR3, ButtonBuilder: BB3, ButtonStyle: BS3 } = require('discord.js');
      await interaction.reply({
        content: `✅ Floor alert set! I'll DM you when the **${slug}** floor drops below **Ξ ${threshold.toFixed(4)}** (cooldown: ${cdDisplay}).`,
        components: [new AR3().addComponents(new BB3().setCustomId('me_browse:back').setLabel('← Back to My Settings').setStyle(BS3.Secondary))],
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  }
  if((interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) &&
     (interaction.customId.startsWith('cfg_chsel:') || interaction.customId.startsWith('cfg_rolesel:'))){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isRoleSelectMenu() && interaction.customId === 'setup_traitrole:rolesel'){
    // Must call showModal — cannot deferUpdate first
    const roleId = interaction.values[0];
    const role   = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const modal = new ModalBuilder()
      .setCustomId('setup_modal:traitrole:'+roleId)
      .setTitle(`Role: ${(role?.name||'Selected').slice(0,40)}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_trait_type')
          .setLabel('Trait Category (optional — e.g. Type)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Leave blank to require a token count instead')
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_trait_value')
          .setLabel('Trait Value (optional — e.g. Zombie, Gold)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Leave blank if using token count')
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_min_count')
          .setLabel('Minimum tokens to qualify (default: 1)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 1, 5, 20')
          .setRequired(false)
      ),
    );
    return interaction.showModal(modal);
  }
  if(interaction.isRoleSelectMenu() && (interaction.customId === 'cfg_traitrole:rolesel' || interaction.customId.startsWith('cfg_traitrole:rolesel:'))){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('cfg_traitrole:catsel:')){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('cfg_traitrole:valsel:')){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('cfg_filtertrait:catsel:')){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('cfg_filtertrait:valsel:')){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isButton() && interaction.customId.startsWith('cfg_filtertrait:manual:')){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isButton() && interaction.customId.startsWith('cfg_traitrole:manual:')){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('cfg_role:')){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('cfg_col:')){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('cfg_filter:')){
    const cfgCtx = { pgPool, getConfig, setConfig, syncBurnConfig: syncBurnConfigFromServerConfigs };
    return handleConfigButton(interaction, cfgCtx);
  }

  // ── Legacy handler ──────────────────────────────────────────────────────────
  if(interaction.isButton() && interaction.customId.startsWith('verify_wallet:')){
    return interaction.reply({flags:64, content:'Please click **Verify Wallet** again to use the updated flow.'});
  }

  // ── Start Verification button ─────────────────────────────────────────────
  if(interaction.isButton() && interaction.customId.startsWith('start_verification:')){
    const svGuild = interaction.guildId;
    const svUser  = interaction.user.id;

    // Check if already verified in this server
    try{
      const svEx = await pgPool.query(
        'SELECT wallet FROM user_registrations WHERE discord_id=$1 AND guild_id=$2 AND verified=true',
        [svUser, svGuild]
      );
      if(svEx.rows.length){
        const w = svEx.rows[0].wallet;
        return interaction.reply({flags:64, content:'✅ Already verified in this server!\n🔗 Wallet: `'+w.slice(0,6)+'...'+w.slice(-4)+'`'});
      }
    }catch(_){}

    // Check if already verified in ANY server (cross-server shortcut)
    try{
      const globalEx = await pgPool.query(
        'SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1',
        [svUser]
      );
      if(globalEx.rows.length){
        await interaction.deferReply({flags:64});
        const knownWallet = globalEx.rows[0].wallet;
        const gCfg = getConfig(svGuild) || {};
        const slug = gCfg.collectionSlug || gCfg.slug || 'on-chain-all-stars';

        // Full OS profile fetch — get ALL linked wallets
        let allWallets = [knownWallet];
        try{
          const osRes = await fetch(
            `https://api.opensea.io/api/v2/accounts/${knownWallet}`,
            { headers:osHeaders() }
          );
          if(osRes.ok){
            const profile = await osRes.json();
            const extra = (profile.addresses||[])
              .map(a=>(a.address||'').toLowerCase())
              .filter(a=>/^0x[0-9a-f]{40}$/.test(a) && a!==knownWallet);
            allWallets = [knownWallet, ...extra];
          }
        }catch(_){}

        // Fetch token holdings across all wallets
        let totalTokens = [];
        for(const w of allWallets){
          try{
            const nftRes = await fetch(
              `https://api.opensea.io/api/v2/chain/ethereum/account/${w}/nfts?collection=${slug}&limit=200`,
              { headers:osHeaders() }
            );
            if(nftRes.ok) totalTokens = totalTokens.concat((await nftRes.json()).nfts||[]);
          }catch(_){}
        }
        const tokenCount = totalTokens.length;

        // Save to this guild
        await pgPool.query(
          `INSERT INTO user_registrations (discord_id,guild_id,wallet,verified,verified_at,updated_at)
           VALUES ($1,$2,$3,true,NOW(),NOW())
           ON CONFLICT (discord_id,guild_id) DO UPDATE SET wallet=$3,verified=true,verified_at=NOW(),updated_at=NOW()`,
          [svUser, svGuild, knownWallet]
        ).catch(()=>{});

        // Assign roles
        try{
          const panelR = await pgPool.query(
            'SELECT role_id, holder_role_id FROM verification_panels WHERE guild_id=$1', [svGuild]
          );
          console.log('[SVInstant] panel row:', JSON.stringify(panelR.rows[0]));
          if(panelR.rows[0]){
            const { role_id, holder_role_id } = panelR.rows[0];
            const member = await interaction.guild.members.fetch(svUser).catch(e=>{ console.error('[SVInstant] fetch member:', e.message); return null; });
            console.log('[SVInstant] member found:', !!member, 'role_id:', role_id, 'tokens:', tokenCount);
            if(member && role_id){
              await member.roles.add(role_id).catch(e=>console.error('[SVInstant] add verified role:', e.message));
            }
            if(member && holder_role_id && tokenCount >= 1){
              await member.roles.add(holder_role_id).catch(e=>console.error('[SVInstant] add holder role:', e.message));
            }
          } else {
            console.warn('[SVInstant] No verification_panels row for guild:', svGuild);
          }
        }catch(e){ console.error('[SVInstant] role assign error:', e.message); }

        // Sync trait roles immediately and collect summary
        const roleSummaryInst = await syncTraitRoles(interaction.guild, svUser, knownWallet).catch(()=>({ assigned:[], skipped:[], alreadyHad:[] }));

        const rolePartsInst = [];
        if(roleSummaryInst.assigned.length)   rolePartsInst.push(`✅ Roles assigned: ${roleSummaryInst.assigned.map(id=>`<@&${id}>`).join(', ')}`);
        if(roleSummaryInst.alreadyHad.length) rolePartsInst.push(`☑️ Already had: ${roleSummaryInst.alreadyHad.map(id=>`<@&${id}>`).join(', ')}`);

        const walletSummary = allWallets.length > 1
          ? `🔗 **${allWallets.length} wallets** on file (${allWallets.map(w=>w.slice(0,6)+'...'+w.slice(-4)).join(', ')})`
          : `🔗 **Wallet:** \`${knownWallet.slice(0,6)}...${knownWallet.slice(-4)}\``;

        return interaction.editReply({content:[
          '✅ **Verified instantly!**',
          walletSummary,
          `🪙 **Tokens found:** ${tokenCount}`,
          ...(rolePartsInst.length ? ['', ...rolePartsInst] : []),
          '',
          'Your wallet was recognised from another server — no re-verification needed.',
        ].join('\n')});
      }
    }catch(e){
      console.error('[SVInstant] Error in instant re-verify:', e.message);
      // Don't fall through to modal silently — tell the user something went wrong
      if(!interaction.deferred && !interaction.replied){
        return interaction.reply({ flags:64, content:'❌ Something went wrong during instant verification. Please try again.' });
      }
      return interaction.editReply({ content:'❌ Something went wrong during instant verification. Please try again.' });
    }

    // New user — show wallet input modal
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const svModal = new ModalBuilder()
      .setCustomId('sv_modal:wallet:'+svGuild)
      .setTitle('Verify Your Wallet');
    svModal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('wallet_input')
          .setLabel('Your Ethereum Wallet Address')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('0x...')
          .setMinLength(42).setMaxLength(42).setRequired(true)
      )
    );
    return interaction.showModal(svModal);
  }

  // ── Wallet address submitted — generate code, show instructions ──────────
  if(interaction.isModalSubmit() && interaction.customId.startsWith('sv_modal:wallet:')){
    await interaction.deferReply({flags:64});
    const svGuild   = interaction.customId.split(':')[2];
    const discordId = interaction.user.id;
    const wallet    = (interaction.fields.getTextInputValue('wallet_input')||'').trim().toLowerCase();

    if(!/^0x[0-9a-f]{40}$/i.test(wallet))
      return interaction.editReply({content:'❌ Invalid wallet address. Must start with `0x` and be 42 characters long.'});

    const code      = 'OCAS-'+Math.random().toString(36).slice(2,8).toUpperCase();
    const expiresAt = new Date(Date.now() + 30*60*1000);

    try{
      await pgPool.query(
        `INSERT INTO verification_codes (discord_id,guild_id,wallet,code,expires_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (discord_id,guild_id) DO UPDATE SET wallet=$3,code=$4,expires_at=$5`,
        [discordId, svGuild, wallet, code, expiresAt]
      );
    }catch(e){
      // Fallback for old single-column PK
      try{
        await pgPool.query(
          `INSERT INTO verification_codes (discord_id,guild_id,wallet,code,expires_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (discord_id) DO UPDATE SET guild_id=$2,wallet=$3,code=$4,expires_at=$5`,
          [discordId, svGuild, wallet, code, expiresAt]
        );
      }catch(e2){ console.error('[SVWallet] insert error:', e2.message); }
    }

    const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
    const codeEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🔐 Verify Your Wallet')
      .setDescription(
        `**Wallet:** \`${wallet.slice(0,6)}...${wallet.slice(-4)}\`\n\n` +
        '**Step 1 — Add this code to your OpenSea username:**\n' +
        '```' + code + '```' +
        `Go to https://opensea.io/${wallet} → Edit Profile → add the code anywhere in your **username**.\n` +
        `Example: \`YourName-${code}\`\n\n` +
        '**Step 2 — Once saved, click ✅ I\'ve Added It below.**\n\n' +
        '*You can remove the code from your bio after verification. Expires in 30 minutes.*'
      );
    const copyBtn = new ButtonBuilder()
      .setCustomId('sv_copy_code:'+svGuild)
      .setLabel('📋 Copy Code')
      .setStyle(ButtonStyle.Secondary);
    const doneBtn = new ButtonBuilder()
      .setCustomId('sv_done:'+svGuild)
      .setLabel("✅ I've Added It")
      .setStyle(ButtonStyle.Success);
    return interaction.editReply({embeds:[codeEmbed], components:[new ActionRowBuilder().addComponents(copyBtn, doneBtn)]});
  }

  // ── Copy Code button ──────────────────────────────────────────────────────
  if(interaction.isButton() && interaction.customId.startsWith('sv_copy_code:')){
    const discordId = interaction.user.id;
    try{
      const r = await pgPool.query(
        'SELECT code FROM verification_codes WHERE discord_id=$1 ORDER BY expires_at DESC LIMIT 1',
        [discordId]
      );
      const code = r.rows[0]?.code || '(expired — click Verify Wallet again)';
      return interaction.reply({flags:64, content:'```'+code+'```'});
    }catch(_){
      return interaction.reply({flags:64, content:'❌ Could not retrieve code. Try again.'});
    }
  }

  // ── I've Added It — fetch OS profile by wallet, check bio for code ────────
  if(interaction.isButton() && interaction.customId.startsWith('sv_done:')){
    await interaction.deferReply({flags:64});
    const svGuild   = interaction.customId.split(':')[1];
    const discordId = interaction.user.id;

    // Look up pending code + wallet
    let codeRow;
    try{
      const r = await pgPool.query(
        'SELECT code, wallet, expires_at FROM verification_codes WHERE discord_id=$1 ORDER BY expires_at DESC LIMIT 1',
        [discordId]
      );
      codeRow = r.rows[0];
    }catch(e){
      console.error('[SVDone] DB lookup:', e.message);
      return interaction.editReply({content:'❌ DB error. Please try again.'});
    }

    if(!codeRow)
      return interaction.editReply({content:'❌ No pending verification. Click **Verify Wallet** again.'});
    if(new Date() > new Date(codeRow.expires_at))
      return interaction.editReply({content:'❌ Code expired. Click **Verify Wallet** again to get a new one.'});

    const { code, wallet } = codeRow;

    // Fetch OpenSea profile by wallet address — add cache-bust to get fresh data
    let profile;
    try{
      const cacheBust = `&_=${Date.now()}`;
      const osRes = await fetch(
        `https://api.opensea.io/api/v2/accounts/${wallet}?${cacheBust}`,
        { headers:{ ...osHeaders(), 'Cache-Control':'no-cache', 'Pragma':'no-cache' } }
      );
      if(!osRes.ok){
        if(osRes.status===404) return interaction.editReply({content:`❌ No OpenSea account found for wallet \`${wallet.slice(0,6)}...${wallet.slice(-4)}\`. Make sure this wallet is connected to OpenSea.`});
        return interaction.editReply({content:`❌ OpenSea error (${osRes.status}). Please try again.`});
      }
      profile = await osRes.json();
      // If username looks stale (no code), try fetching fresh by username
      const allStringsFirst = collectStringsDeep(profile).join(' ');
      if(!allStringsFirst.includes(code) && profile.username){
        try{
          const osRes2 = await fetch(
            `https://api.opensea.io/api/v2/accounts/${profile.username}?_=${Date.now()}`,
            { headers:{ ...osHeaders(), 'Cache-Control':'no-cache', 'Pragma':'no-cache' } }
          );
          if(osRes2.ok) profile = await osRes2.json();
        }catch(_){}
      }
      console.log('[SVDone] username:', profile.username, '| code in profile:', collectStringsDeep(profile).join(' ').includes(code));
    }catch(e){
      console.error('[SVDone] OS fetch:', e.message);
      return interaction.editReply({content:'❌ Could not reach OpenSea. Please try again.'});
    }

    // Search entire profile object for the code (handles any field name OS uses)
    const allStrings = collectStringsDeep(profile).join(' ');
    if(!allStrings.includes(code))
      return interaction.editReply({content:[
        '❌ Code not found in your OpenSea profile yet.',
        '',
        `Go to https://opensea.io/${wallet} → Edit Profile → add the code to your **username**:`,
        '```'+code+'```',
        'Save your profile, then click **✅ I\'ve Added It** again.',
      ].join('\n')});

    // Get all linked wallets from profile
    const addresses = profile.addresses || [];
    const wallets = [wallet, ...addresses
      .map(a => (a.address||'').toLowerCase())
      .filter(a => /^0x[0-9a-f]{40}$/.test(a) && a !== wallet)
    ];

    const cfg  = getConfig(svGuild) || {};
    const slug = cfg.collectionSlug || cfg.slug || 'on-chain-all-stars';

    // Fetch token holdings across all wallets
    let totalTokens = [];
    for(const w of wallets){
      try{
        const nftRes = await fetch(
          `https://api.opensea.io/api/v2/chain/ethereum/account/${w}/nfts?collection=${slug}&limit=200`,
          { headers:osHeaders() }
        );
        if(nftRes.ok) totalTokens = totalTokens.concat((await nftRes.json()).nfts||[]);
      }catch(_){}
    }
    const tokenCount = totalTokens.length;

    // Save to user_registrations — global (no guild_id) + this guild
    const upsertReg = async (gid) => pgPool.query(
      `INSERT INTO user_registrations (discord_id,guild_id,wallet,verified,verified_at,updated_at)
       VALUES ($1,$2,$3,true,NOW(),NOW())
       ON CONFLICT (discord_id,guild_id) DO UPDATE SET wallet=$3,verified=true,verified_at=NOW(),updated_at=NOW()`,
      [discordId, gid, wallet]
    ).catch(e=>console.error('[SVDone] upsertReg failed guild='+gid+':', e.message));
    await upsertReg(svGuild);
    // Trigger wallet backfill (fire-and-forget)
    backfillWallet(wallet, pgPool, process.env.ALCHEMY_API_KEY).catch(()=>{});
    // Global cross-server record — DELETE existing global row for this wallet/discord_id then re-insert
    console.log('[SVDone] saving global row for discord_id:', discordId, 'wallet:', wallet.slice(0,8));
    try {
      await pgPool.query(
        `DELETE FROM user_registrations WHERE guild_id='global' AND (discord_id=$1 OR wallet=$2)`,
        [discordId, wallet]
      );
      await pgPool.query(
        `INSERT INTO user_registrations (discord_id,guild_id,wallet,verified,verified_at,updated_at)
         VALUES ($1,'global',$2,true,NOW(),NOW())`,
        [discordId, wallet]
      );
      console.log('[SVDone] global row saved OK');
    } catch(e) {
      console.error('[SVDone] global row save failed:', e.message);
    }
    console.log('[SVDone] saved registration for', discordId, 'guild:', svGuild);

    // Assign roles
    try{
      const panelR = await pgPool.query(
        'SELECT role_id, holder_role_id FROM verification_panels WHERE guild_id=$1', [svGuild]
      );
      console.log('[SVDone] panel row:', JSON.stringify(panelR.rows[0]));
      if(panelR.rows[0]){
        const { role_id, holder_role_id } = panelR.rows[0];
        const member = await interaction.guild.members.fetch(discordId).catch(e=>{ console.error('[SVDone] fetch member:', e.message); return null; });
        console.log('[SVDone] member found:', !!member, 'role_id:', role_id, 'tokens:', tokenCount);
        if(member && role_id){
          const conflict = await isRoleManagedByOtherBot(interaction.guild, role_id);
          if(!conflict) await member.roles.add(role_id).catch(e=>console.error('[SVDone] add verified role:', e.message));
          else console.log('[SVDone] SKIP verified role — managed by other bot:', role_id);
        }
        if(member && holder_role_id && tokenCount >= 1){
          await member.roles.add(holder_role_id).catch(e=>console.error('[SVDone] add holder role:', e.message));
        }
      } else {
        console.warn('[SVDone] No verification_panels row for guild:', svGuild);
      }
    }catch(e){ console.error('[SVDone] role assign error:', e.message); }

    // Clean up code
    await pgPool.query(
      'DELETE FROM verification_codes WHERE discord_id=$1',
      [discordId]
    ).catch(()=>{});

    const walletSummary = wallets.length > 1
      ? `🔗 **${wallets.length} wallets** found (${wallets.map(w=>w.slice(0,6)+'...'+w.slice(-4)).join(', ')})`
      : `🔗 **Wallet:** \`${wallet.slice(0,6)}...${wallet.slice(-4)}\``;

    // Sync trait roles immediately and collect summary
    const roleSummary = await syncTraitRoles(interaction.guild, discordId, wallet).catch(()=>({ assigned:[], skipped:[], alreadyHad:[] }));

    const roleParts = [];
    if(roleSummary.assigned.length)   roleParts.push(`✅ Roles assigned: ${roleSummary.assigned.map(id=>`<@&${id}>`).join(', ')}`);
    if(roleSummary.alreadyHad.length) roleParts.push(`☑️ Already had: ${roleSummary.alreadyHad.map(id=>`<@&${id}>`).join(', ')}`);

    return interaction.editReply({content:[
      '✅ **Verified!**',
      walletSummary,
      `🪙 **Tokens found:** ${tokenCount}`,
      ...(roleParts.length ? ['', ...roleParts] : []),
      '',
      'You can remove the code from your OpenSea username now.',
      'Your wallet is saved — future servers will verify you instantly.',
    ].join('\n')});
  }

  if(interaction.isButton() && interaction.customId.startsWith('lottery_enter:')){
    const lotteryId=parseInt(interaction.customId.split(':')[1]);
    // deferReply immediately so Discord doesn't expire the interaction during DB work
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
    try{
      const r=await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1',[lotteryId]); const row=r.rows[0];
      if(!row) return interaction.editReply({content:'Lottery not found.'});
      if(row.status!=='active' || new Date(row.end_time)<=new Date()) return interaction.editReply({content:'This lottery is closed.'});
      if(row.type!=='giveaway') return interaction.editReply({content:'This is a guess lottery — use the **Submit Guess** button instead.'});
      const username=interaction.member?.displayName||interaction.user?.globalName||interaction.user?.username||interaction.user.id;
      await pgPool.query(`INSERT INTO generic_lottery_entries (lottery_id,user_id,username) VALUES ($1,$2,$3) ON CONFLICT (lottery_id,user_id) DO UPDATE SET username=EXCLUDED.username`,[lotteryId,interaction.user.id,username]);
      const count=await getGenericLotteryEntryCount(lotteryId);
      try{
        const msg = interaction.message;
        const oldEmbed = msg.embeds[0];
        if(oldEmbed){
          const updated = EmbedBuilder.from(oldEmbed);
          const fields = updated.data.fields?.map(f =>
            f.name === 'Entries' ? { ...f, value: String(count) } : f
          );
          if(fields) updated.setFields(fields);
          await msg.edit({ embeds: [updated] });
        }
      }catch(_){}
      return interaction.editReply({content:`You are entered in lottery #${lotteryId}. Current entries: ${count}.`});
    }catch(e){ return interaction.editReply({content:'Could not enter lottery: '+e.message}).catch(()=>{}); }
  }
  // ── Guess lottery: button opens a modal asking for the number ────────────────
  if(interaction.isButton() && interaction.customId.startsWith('lottery_guess:')){
    const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
    const lotteryId = parseInt(interaction.customId.split(':')[1]);
    const modal = new ModalBuilder().setCustomId(`lottery_guess_modal:${lotteryId}`).setTitle('Submit Your Guess');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('number').setLabel('Your guess').setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter a number').setRequired(true)
      ),
    );
    return interaction.showModal(modal);
  }
  if(interaction.isModalSubmit() && interaction.customId.startsWith('lottery_guess_modal:')){
    const lotteryId = parseInt(interaction.customId.split(':')[1]);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
    try{
      const numRaw = interaction.fields.getTextInputValue('number').trim();
      const number = parseInt(numRaw);
      if(!Number.isInteger(number)) return interaction.editReply({ content:'Please enter a whole number.' });
      const r = await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1', [lotteryId]);
      const row = r.rows[0];
      if(!row) return interaction.editReply({ content:'Lottery not found.' });
      if(row.status !== 'active' || new Date(row.end_time) <= new Date())
        return interaction.editReply({ content:'This guess event is closed.' });
      if(number < row.min_number || number > row.max_number)
        return interaction.editReply({ content:`Guess must be between ${row.min_number} and ${row.max_number}.` });
      const username = interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || interaction.user.id;
      await pgPool.query(
        `INSERT INTO generic_lottery_entries (lottery_id, user_id, username, guess_number)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (lottery_id, user_id) DO UPDATE SET
           username=EXCLUDED.username, guess_number=EXCLUDED.guess_number, entered_at=NOW()`,
        [row.id, interaction.user.id, username, number]
      );
      return interaction.editReply({ content:`Your guess for lottery #${row.id} is **${number}**.` });
    }catch(e){ return interaction.editReply({content:'Could not submit guess: '+e.message}).catch(()=>{}); }
  }
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
    const row = buildNavRow(session.index, session.embeds.length);
    try{
      // Re-fetch image from source data stored on embed to avoid buffer loss on nav
      let ir = embed._imageResult;
      if(!ir && embed._imageSource){
        const src = embed._imageSource;
        if(src.startsWith('<svg') || src.startsWith('data:image/svg') || src.toLowerCase().includes('image/svg')){
          try{
            const buf = await extractPngFromSvg(src);
            if(buf) ir = { type:'buffer', buffer:buf, filename:embed._imageFilename||'token.png' };
          }catch(_){}
        } else if(src.startsWith('http') && isDiscordOk(src)){
          ir = { type:'url', url:src };
        }
      }
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
      const RAILWAY_URL = getRailwayApiUrl();
      const API_SECRET  = process.env.API_SECRET;
      let traits = null;

      const cached = ocasTraitsCache.get(tokenId);
      if(cached && Date.now() < cached.expires){
        traits = cached.traits;
      }

      // For OCAS, current contract tokenURI is the true source and preserves
      // duplicate trait categories through the raw attributes[] array.
      // Try it before API/DB so stale flattened DB traits do not hide duplicates.
      if(!traits || realTraitCount(traits) < 10){
        const contractTraits = await fetchTokenUriFromContract(tokenId).catch(e => {
          console.warn('[ShowTraits contract]', e.message);
          return null;
        });
        if(contractTraits && realTraitCount(contractTraits)){
          traits = contractTraits;
          setCachedTraits(tokenId, traits);
        }
      }

      // API fallback for cases where contract RPC is temporarily unavailable.
      if((!traits || !realTraitCount(traits)) && RAILWAY_URL){
        try{
          const tqs = new URLSearchParams({ key: API_SECRET||'' });
          const tr = await fetch(`${RAILWAY_URL}/db/token/${tokenId}?${tqs}`);
          if(tr.ok){
            const tj = await tr.json();
            if(tj.ok && tj.token?.traits) traits = tj.token.traits;
          }
          if(traits){
            setCachedTraits(tokenId, traits);
          }
        }catch(apiErr){
          console.warn('[ShowTraits API]', apiErr.message);
        }
      }

      if(!traits || !realTraitCount(traits)){
        const local = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
        traits = local?.traits || null;
      }

      if(!traits || !realTraitCount(traits)){ await interaction.editReply({ content: 'Could not load traits.' }); return; }
      const traitLines = traitDisplayLines(traits, 25).join('\n');
      await interaction.editReply({ content: `**OCAS #${tokenId} Traits (${realTraitCount(traits)})**\n${traitLines}`.slice(0, 1900) });
    } catch(e) {
      console.error('[ShowTraits]', e.message);
      try { await interaction.editReply({ content: 'Error loading traits.' }); } catch(_){}
    }
    return;
  }

  if(interaction.isButton() && interaction.customId.startsWith('burnlottery_proof:')){
    const lotteryId = parseInt(interaction.customId.split(':')[1], 10);
    try{
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if(!lotteryId){ await interaction.editReply({ content:'Lottery proof is unavailable.' }); return; }
      const r = await pgPool.query('SELECT * FROM burn_lotteries WHERE id=$1', [lotteryId]);
      if(!r.rows.length){ await interaction.editReply({ content:`No burn lottery #${lotteryId} found.` }); return; }
      const row = r.rows[0];
      const start = new Date(row.start_time), end = new Date(row.end_time);
      const timeZone = row.timezone || DEFAULT_LOTTERY_TIMEZONE;
      const { entries, wallets, burns } = await getBurnLotteryEntries(start, end, row.mode);
      const pick = isPendingDrawSeed(row.seed) ? null : lotteryPick(entries, row.seed);
      const proof = pick?.proof || row.result_json?.proof || 'unknown';
      const winner = row.winner_wallet || pick?.winner || null;
      const winnerPosition = pick?.position || row.result_json?.winner_position || null;
      const entryTotalPages = Math.ceil(burnLotteryDisplayEntries(entries, wallets, row.mode).length / 20);
      let content =
        `**🎟️ OCAS Burn Lottery #${lotteryId} Draw Proof**\n` +
        `**Window:** ${formatZonedLotteryTime(start, timeZone)} → ${formatZonedLotteryTime(end, timeZone)}\n` +
        `${burnLotteryWindowDetails(start, end, timeZone)}\n` +
        `**Mode:** ${row.mode === 'burn' ? 'One entry per burn — wallets can appear multiple times' : 'One entry per wallet'}\n` +
        `**Qualified wallets:** ${wallets.length}\n` +
        `**Total burns:** ${burns.length}\n` +
        `**Entries used for draw:** ${entries.length}\n` +
        (winner ? `**Winner:** ${etherscanAddressLink(winner)}\n\`${winner}\`\n` : `**Winner:** none\n`) +
        (winnerPosition ? `**Winning entry:** ${Number(winnerPosition).toLocaleString()} of ${entries.length.toLocaleString()}\n` : '') +
        `\n**How to verify:**\n` +
        `One entry per wallet (wallet mode) or one entry per burn (burn mode). ` +
        `The seed is an Ethereum block hash mined 5 blocks after the window closes — unpredictable by anyone including the bot operator. ` +
        `SHA-256(seed + ordered entries) → winning index. Same seed + same entries = same winner every time.\n` +
        ((() => { const rj = row.result_json || {}; return rj.block_number ? `Seed source: Ethereum block [#${rj.block_number}](https://etherscan.io/block/${rj.block_number})\n` : rj.seed_type === 'random_fallback' ? `Seed source: cryptographic random (ETH RPC unavailable — result is fair but not on-chain verifiable)\n` : ''; })()) +
        `\n**Seed:**\n\`${isPendingDrawSeed(row.seed) ? 'Pending — final seed is the hash of an Ethereum block mined after the window closes.' : String(row.seed || '').slice(0, 900)}\`\n` +
        `**Full proof hash:**\n\`${String(proof).slice(0, 128)}\``;
      await interaction.editReply({
        content:content.slice(0, 1900),
        components:buildBurnLotteryEntryPageComponents(lotteryId, 0, entryTotalPages)
      });
    }catch(e){
      console.error('[BurnLottery Proof]', e.message);
      try{ await interaction.editReply({ content:'Error loading draw proof.' }); }catch(_){}
    }
    return;
  }

  if(interaction.isButton() && (interaction.customId.startsWith('burnlottery_entries:') || interaction.customId.startsWith('burnlottery_current_entries:') || interaction.customId.startsWith('burnlottery_wallets:'))){
    const parts = interaction.customId.split(':');
    const isLive = parts[0] === 'burnlottery_current_entries';
    const lotteryId = parseInt(parts[1], 10);
    const page = Math.max(0, parseInt(parts[2] || '0', 10) || 0);
    try{
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if(!lotteryId){ await interaction.editReply({ content:'Entries are unavailable.' }); return; }
      const r = await pgPool.query('SELECT * FROM burn_lotteries WHERE id=$1', [lotteryId]);
      if(!r.rows.length){ await interaction.editReply({ content:`No burn lottery #${lotteryId} found.` }); return; }
      const row = r.rows[0];
      const start = new Date(row.start_time);
      const scheduledEnd = new Date(row.end_time);
      const end = isLive ? new Date(Math.min(Date.now(), scheduledEnd.getTime())) : scheduledEnd;
      const { entries, wallets } = await getBurnLotteryEntries(start, end, row.mode);
      const pick = !isLive && !isPendingDrawSeed(row.seed) ? lotteryPick(entries, row.seed) : null;
      const pageSize = 20;
      const displayEntries = burnLotteryDisplayEntries(entries, wallets, row.mode);
      const totalPages = Math.max(1, Math.ceil(displayEntries.length / pageSize));
      const safePage = Math.min(page, totalPages - 1);
      const startIndex = safePage * pageSize;
      const pageEntries = displayEntries.slice(startIndex, startIndex + pageSize);
      const winnerPosition = !isLive ? (pick?.position || row.result_json?.winner_position || null) : null;
      const lines = pageEntries.map((w, i) => {
        const pos = startIndex + i + 1;
        const isWinner = winnerPosition && pos === Number(winnerPosition);
        return `${pos}. ${isWinner ? '🏆 ' : ''}\`${w}\``;
      });
      const content =
        `**${isLive ? 'Current Entries' : 'Entries'} - Lottery #${lotteryId}**\n` +
        `${burnLotteryModeNote(row.mode)}\n` +
        `Page ${safePage + 1} / ${totalPages} - ${displayEntries.length} entr${displayEntries.length===1?'y':'ies'}\n\n` +
        (lines.join('\n') || 'No entries found yet.');
      await interaction.editReply({
        content:content.slice(0, 1900),
        components:buildBurnLotteryEntryPageComponents(lotteryId, safePage, totalPages, isLive)
      });
    }catch(e){
      console.error('[BurnLottery Entries]', e.message);
      try{ await interaction.editReply({ content:'Error loading entries.' }); }catch(_){}
    }
    return;
  }

  if(interaction.isButton() && interaction.customId.startsWith('generic_lottery_proof:')){
    const lotteryId = parseInt(interaction.customId.split(':')[1], 10);
    try{
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1', [lotteryId]);
      if(!r.rows.length){ await interaction.editReply({ content:'Lottery not found.' }); return; }
      const row = r.rows[0];
      const isPending = row.status === 'active' || row.status === 'processing';
      const rj = row.result_json || {};
      const blockNum = rj.block_number || null;
      const seedType = rj.seed_type || null;

      const seedDisplay = isPending
        ? 'Generated at draw time using an Ethereum block hash — unpredictable by anyone including the bot operator.'
        : `\`${String(row.seed).slice(0, 256)}\``;
      const proofDisplay = rj.proof
        ? `\`${String(rj.proof).slice(0, 64)}...\``
        : isPending ? 'Generated at draw time.' : 'Not available.';
      const seedSourceLine = blockNum
        ? `Seed source: Ethereum block [#${blockNum}](https://etherscan.io/block/${blockNum})`
        : seedType === 'random_fallback'
          ? 'Seed source: cryptographic random (ETH RPC unavailable — result is fair but not on-chain verifiable)'
          : '';

      const content = [
        `**🎲 Draw Proof — Lottery #${lotteryId}**`,
        `**Type:** ${row.type === 'guess' ? 'Guess the number' : 'Giveaway button entries'}`,
        `**Status:** ${row.status}`,
        `**Entries:** ${row.entry_count ?? (isPending ? 'Open' : '0')}`,
        ``,
        `**How to verify:**`,
        `One entry per user. The seed is an Ethereum block hash fetched at draw time — published on-chain before the result is calculated, so no one can predict or influence it.`,
        `SHA-256(seed + ordered entry list) → winning index. Same seed + same entries = same winner every time.`,
        seedSourceLine,
        ``,
        `**Seed:**`,
        seedDisplay,
        `**Proof Hash:**`,
        proofDisplay,
      ].filter(s => s !== undefined).join('\n');
      await interaction.editReply({ content: content.slice(0, 1900) });
    }catch(e){
      console.error('[GenericLottery Proof]', e.message);
      try{ await interaction.editReply({ content:'Error loading draw proof.' }); }catch(_){}
    }
    return;
  }

  if(interaction.isButton() && interaction.customId.startsWith('generic_lottery_entries:')){
    const lotteryId = parseInt(interaction.customId.split(':')[1], 10);
    try{
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1', [lotteryId]);
      if(!r.rows.length){ await interaction.editReply({ content:'Lottery not found.' }); return; }
      const row = r.rows[0];
      const er = await pgPool.query(
        'SELECT username, user_id, entered_at FROM generic_lottery_entries WHERE lottery_id=$1 ORDER BY entered_at ASC',
        [lotteryId]
      );
      if(!er.rows.length){ await interaction.editReply({ content:'No entries found.' }); return; }
      const isSnowflake = id => /^\d{17,19}$/.test(String(id||''));
      const winnerDisplay = row.winner_display || null;
      const winnerPos = row.result_json?.winner_position || null;
      const lines = er.rows.map((e,i) => {
        const name = isSnowflake(e.user_id) ? `<@${e.user_id}>` : String(e.username || e.user_id);
        const isWinner = winnerPos ? (i + 1 === winnerPos) : (winnerDisplay && name === winnerDisplay);
        return `${i+1}. ${isWinner ? '🏆 ' : ''}${name}`;
      });
      const header = `**Entries — Lottery #${lotteryId}** (${er.rows.length} total)\n`;
      const body = lines.join('\n').slice(0, 1800);
      await interaction.editReply({ content: header + body });
    }catch(e){
      console.error('[GenericLottery Entries]', e.message);
      try{ await interaction.editReply({ content:'Error loading entries.' }); }catch(_){}
    }
    return;
  }

  if(interaction.isButton() && interaction.customId.startsWith('burn_ids:')){
    const burnEventId = parseInt(interaction.customId.split(':')[1], 10);
    try{
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if(!burnEventId){ await interaction.editReply({ content:'Burn details are unavailable for this alert.' }); return; }
      const r = await pgPool.query(
        `SELECT be.survivor_token_id, bei.burned_token_id
         FROM burn_events be
         LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
         WHERE be.id = $1
         ORDER BY bei.burned_token_id ASC`,
        [burnEventId]
      );
      if(!r.rows.length){ await interaction.editReply({ content:'Burned IDs are not available for this alert.' }); return; }
      const survivorId = r.rows[0].survivor_token_id;
      const ids = r.rows.map(row => row.burned_token_id).filter(Boolean);
      const text = ids.length ? ids.map(id => `#${id}`).join(', ') : 'No burned token IDs found.';
      await interaction.editReply({ content:`**Burned Tokens:**\n${text}`.slice(0, 1900) });
    }catch(e){
      console.error('[Burn IDs]', e.message);
      try{ await interaction.editReply({ content:'Error loading burned IDs.' }); }catch(_){}
    }
    return;
  }

  if(interaction.isButton() && interaction.customId.startsWith('burn_all_tokens:')){
    const survivorId = parseInt(interaction.customId.split(':')[1], 10);
    try{
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await pgPool.query(`
        SELECT be.burned_at, be.points_used,
               array_agg(DISTINCT bei.burned_token_id ORDER BY bei.burned_token_id)
               FILTER (WHERE bei.burned_token_id IS NOT NULL) AS burned_ids,
               COALESCE(started.token_count, 0) AS started_count
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        LEFT JOIN LATERAL (
          SELECT COUNT(bsi.burned_token_id) AS token_count
          FROM burn_started_events bse
          JOIN burn_started_inputs bsi ON bsi.burn_started_id = bse.id
          WHERE bse.survivor_token_id = be.survivor_token_id
            AND bse.owner_wallet = be.burner_wallet
            AND bse.block_number <= be.block_number
          GROUP BY bse.id
          ORDER BY MAX(bse.block_number) DESC
          LIMIT 1
        ) started ON true
        WHERE be.survivor_token_id = $1
        GROUP BY be.id, started.token_count
        ORDER BY be.burned_at ASC NULLS LAST
      `, [survivorId]);
      if(!r.rows.length){ await interaction.editReply({ content:'No burn history found.' }); return; }
      const lines = r.rows.map((b, i) => {
        const burnNum = i + 1;
        const ids = (b.burned_ids||[]).filter(Boolean);
        const count = Number(b.started_count) || ids.length;
        const idsStr = ids.length ? ids.filter(id => id !== survivorId).map(id=>`#${id}`).join(', ') : '?';
        return `**Burn ${burnNum} (${count} tokens):** ${idsStr} → #${survivorId}`;
      });
      const msgContent = lines.join('\n').slice(0, 1900);
      await interaction.editReply({ content: msgContent });
    }catch(e){
      console.error('[Burn All Tokens]', e.message);
      try{ await interaction.editReply({ content:'Error loading token history.' }); }catch(_){}
    }
    return;
  }


  // ── Pre-burn history slideshow button ─────────────────────────────────────
  if(interaction.isButton() && interaction.customId.startsWith('burn_preburn:')){
    const survivorId = parseInt(interaction.customId.split(':')[1], 10);
    try{
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Fetch all burn events for this token in chronological order
      const r = await pgPool.query(`
        SELECT be.id, be.tx_hash, be.burned_at, be.result_body_type, be.result_is_angel, be.points_used,
               array_agg(DISTINCT bei.burned_token_id ORDER BY bei.burned_token_id)
               FILTER (WHERE bei.burned_token_id IS NOT NULL) AS burned_ids,
               COALESCE(started.token_count, 0) AS started_count
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        LEFT JOIN LATERAL (
          SELECT COUNT(bsi.burned_token_id) AS token_count
          FROM burn_started_events bse
          JOIN burn_started_inputs bsi ON bsi.burn_started_id = bse.id
          WHERE bse.survivor_token_id = be.survivor_token_id
            AND bse.owner_wallet = be.burner_wallet
            AND bse.block_number <= be.block_number
          GROUP BY bse.id
          ORDER BY MAX(bse.block_number) DESC
          LIMIT 1
        ) started ON true
        WHERE be.survivor_token_id = $1
        GROUP BY be.id, started.token_count
        ORDER BY be.burned_at ASC NULLS LAST
      `, [survivorId]);
      if(!r.rows.length){ await interaction.editReply({ content:'No burn history found.' }); return; }
      const contract = OCAS_CONTRACT;
      // Build one embed per burn showing what the token looked like BEFORE that burn.
      // Burn 1 → pre-state = permanent original archive snapshot.
      // Burn N → pre-state = post-state snapshot written after Burn N-1.
      // This avoids relying on token_image_snapshots.source as historical truth.
      const mintSnap = await pgPool.query(
        `SELECT image_data, traits_json FROM token_original_snapshots WHERE token_id=$1`,
        [survivorId]
      ).then(res => res.rows[0] || null).catch(()=>null);
      // Fetch burn_state_snapshots — post-burn state per burn event = pre-burn state of next burn
      const stateSnaps = await pgPool.query(
        `SELECT bss.burn_event_id, bss.image_data, bss.traits_json
         FROM burn_state_snapshots bss
         WHERE bss.token_id=$1
         ORDER BY bss.created_at ASC`,
        [survivorId]
      ).then(res => res.rows).catch(()=>[]);
      const stateSnapMap = {};
      for(const s of stateSnaps) stateSnapMap[s.burn_event_id] = s;
      const embeds = [];
      for(let i = 0; i < r.rows.length; i++){
        const b = r.rows[i];
        const burnNum = i + 1;
        const ago = b.burned_at ? timeSince(Math.floor(new Date(b.burned_at).getTime()/1000)) : '?';
        const allIds = (b.burned_ids||[]).filter(Boolean).map(Number);
        const consumedIds = allIds.filter(id => id !== survivorId);
        const displayCount = Number(b.started_count) > 0 ? Number(b.started_count) - 1 : consumedIds.length;
        const tokenTypes = await burnTypeBreakdown(consumedIds, b.id).catch(()=>String(displayCount||'?'));
        const tokensStr = tokenTypes.replace(/^\d+/, String(displayCount));
        let snap = null;
        if(i === 0){
          snap = mintSnap;
        } else {
          const prevBurnId = r.rows[i-1].id;
          snap = stateSnapMap[prevBurnId] || null;
        }
        let preBurnType = null;
        if(snap?.traits_json){
          const tj = typeof snap.traits_json==='string' ? JSON.parse(snap.traits_json) : snap.traits_json;
          const raw = tj?.Type || tj?.type || null;
          if(raw !== null && raw !== undefined) preBurnType = resolveOcasType(raw);
        }
        const osUrl = `https://opensea.io/assets/ethereum/${contract}/${survivorId}`;
        const txUrl = b.tx_hash ? `https://etherscan.io/tx/${b.tx_hash}` : null;
        const slideEmbed = new EmbedBuilder()
          .setColor(BURN_COLORS.FIRE)
          .setTitle(`Before Burn ${burnNum} — ${ago}`)
          .addFields(
            { name:'Tokens Burned', value:tokensStr, inline:true },
            { name:'Points Used',   value:String(b.points_used||0)+' pts', inline:true },
            { name:'Type Before',   value:preBurnType || '—', inline:true },
          )
          .setFooter({ text:`#${survivorId} · Burn ${burnNum} of ${r.rows.length}${txUrl ? ' · View on Etherscan' : ''}` })
          .setURL(txUrl || osUrl);
        // Attach image if available
        if(snap?.image_data){
          const imgSrc = snap.image_data;
          if(imgSrc.startsWith('<svg') || imgSrc.startsWith('data:image/svg') || imgSrc.toLowerCase().includes('image/svg')){
            try{
              const buf = await extractPngFromSvg(imgSrc);
              if(buf){
                slideEmbed._imageResult = { type:'buffer', buffer:buf, filename:`token-${survivorId}-burn${burnNum}.png` };
                slideEmbed._imageSource = imgSrc;
                slideEmbed._imageFilename = `token-${survivorId}-burn${burnNum}.png`;
              }
            }catch(_){}
          } else if(imgSrc.startsWith('http') && isDiscordOk(imgSrc)){
            slideEmbed._imageResult = { type:'url', url:imgSrc };
            slideEmbed._imageSource = imgSrc;
          }
        }
        embeds.push(slideEmbed);
      }
      if(!embeds.length){ await interaction.editReply({ content:'No pre-burn snapshots found.' }); return; }
      // Store image source on each embed for re-fetch on slideshow navigation
      for(const e of embeds){
        if(e._imageResult){
          if(e._imageResult.type === 'url') e._imageSource = e._imageResult.url;
          // For buffer type, source is the SVG data from snap.image_data — store it separately
        }
      }
      // Post first slide immediately
      const first = embeds[0];
      const ir = first._imageResult; delete first._imageResult;
      const row = embeds.length > 1 ? buildNavRow(0, embeds.length) : null;
      const components = row ? [row] : [];
      let firstPayload;
      if(ir?.type==='buffer'){
        const att = new AttachmentBuilder(ir.buffer, { name:ir.filename });
        first.setThumbnail(`attachment://${ir.filename}`);
        firstPayload = { embeds:[first], files:[att], components };
      } else {
        if(ir?.type==='url') first.setThumbnail(ir.url);
        firstPayload = { embeds:[first], components };
      }
      const msg = await interaction.editReply(firstPayload);
      // Store remaining slides in slideshow session keyed to the reply message
      if(embeds.length > 1){
        slideshowSessions.set(msg.id, {
          embeds,
          index: 0,
          userId: interaction.user.id,
          expiresAt: Date.now() + 15 * 60 * 1000,
        });
      }
    }catch(e){
      console.error('[BurnPreburn]', e.message);
      try{ await interaction.editReply({ content:'Error loading pre-burn history.' }); }catch(_){}
    }
    return;
  }

  if(!interaction.isChatInputCommand()) return;
  const {commandName,guildId}=interaction;
  const config=getConfig(guildId);
  const isAdmin=interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

  // /setup

  const ctx = buildCtx(interaction, guildId, config, isAdmin);

  if(ADMIN_COMMANDS.has(commandName))   return handleAdminCommand(commandName, ctx);
  if(MARKET_COMMANDS.has(commandName))  return handleMarketCommand(commandName, ctx);
  if(OCAS_COMMANDS.has(commandName))    return handleOcasCommand(commandName, ctx);
  if(TOKEN_COMMANDS.has(commandName))   return handleTokenCommand(commandName, ctx);
  if(BURN_COMMANDS.has(commandName))    return handleBurnCommand(commandName, ctx);
  if(GIVEAWAY_COMMANDS.has(commandName)) return handleGiveawayCommand(interaction, ctx);
  if(SETUP_COMMANDS.has(commandName))    return handleSetupCommand(interaction, ctx);
  if(CONFIG_COMMANDS.has(commandName))   return handleConfigCommand(interaction, { pgPool, getConfig, setConfig });
  if(LOTTERIES_COMMANDS.has(commandName)) return handleLotteriesCommand(interaction, { pgPool, getConfig });
  if(MISC_COMMANDS.has(commandName))    return handleMiscCommand(commandName, ctx);
  // ── /synctraits (manual trigger) ─────────────────────────────────────────────
  if(commandName==='resetverify'){
    if(!isAdmin) return interaction.reply({flags:64, content:'❌ Admin only.'});
    await interaction.deferReply({flags:64});
    const target = interaction.options.getUser('user') || interaction.user;
    try{
      // Delete guild-specific record only — keep global so instant re-verify works on other servers
      await pgPool.query(
        'DELETE FROM user_registrations WHERE discord_id=$1 AND guild_id=$2',
        [target.id, guildId]
      );
      await pgPool.query('DELETE FROM verification_codes WHERE discord_id=$1', [target.id]);

      // Remove all verification-related Discord roles
      const member = await interaction.guild.members.fetch(target.id).catch(()=>null);
      if(member){
        // Remove verified + holder roles from verification_panels
        const panelR = await pgPool.query(
          'SELECT role_id, holder_role_id FROM verification_panels WHERE guild_id=$1', [guildId]
        ).catch(()=>({rows:[]}));
        if(panelR.rows[0]){
          const { role_id, holder_role_id } = panelR.rows[0];
          if(role_id && member.roles.cache.has(role_id))
            await member.roles.remove(role_id).catch(()=>{});
          if(holder_role_id && member.roles.cache.has(holder_role_id))
            await member.roles.remove(holder_role_id).catch(()=>{});
        }
        // Remove all trait roles configured for this guild
        const traitR = await pgPool.query(
          'SELECT DISTINCT role_id FROM trait_roles WHERE guild_id=$1', [guildId]
        ).catch(()=>({rows:[]}));
        for(const row of traitR.rows){
          if(member.roles.cache.has(row.role_id))
            await member.roles.remove(row.role_id).catch(()=>{});
        }
      }

      return interaction.editReply({content:`✅ Verification reset for ${target.tag} — DB records and all verification roles removed. They can verify fresh.`});
    }catch(e){
      return interaction.editReply({content:'❌ Error: '+e.message});
    }
  }

  if(commandName==='synctraits'){
    await interaction.deferReply({flags:64});
    if(!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
      return interaction.editReply({content:'❌ You need Manage Server permission.'});
    await interaction.editReply({content:'⏳ Syncing trait roles for all verified members... This may take a moment.'});
    const guildId = interaction.guildId;
    try{
      const regs = await pgPool.query(
        'SELECT discord_id, wallet FROM user_registrations WHERE guild_id=$1 AND verified=true',
        [guildId]
      );
      for(const reg of regs.rows){
        await syncTraitRoles(interaction.guild, reg.discord_id, reg.wallet);
        await new Promise(r=>setTimeout(r,500));
      }
      return interaction.editReply({content:'✅ Trait roles synced for '+regs.rows.length+' verified member'+(regs.rows.length!==1?'s':'')+'.'});
    }catch(e){
      console.error('[SyncTraits]', e.message);
      return interaction.editReply({content:'❌ Sync failed: '+e.message});
    }
  }




    if(DOWNLOAD_COMMANDS.has(commandName)) return handleDownloadCommand(interaction, { getConfig, osHeaders });
});

// ── Welcome message on server join ───────────────────────────────────────────
// ── Welcome message on server join ────────────────────────────────────────────
client.on('guildCreate', async (guild)=>{
  try{
    // Send welcome DM to server owner only — keeps it private and targeted
    const owner = await guild.fetchOwner().catch(()=>null);
    const target = owner?.user || null;
    if(!target) return;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('👋 Thanks for adding me!')
      .setThumbnail(guild.iconURL({ dynamic: true }) || null)
      .setDescription(
        'I post NFT **sales & listings** alerts, verify holder wallets, and auto-assign trait roles — for any OpenSea collection.\n\n' +
        '**Get started in 2 minutes:**\n' +
        '→ Run `/setup` to configure channels, collection, and roles\n' +
        '→ Use `/config` anytime to manage settings\n\n' +
        '**Key commands:**\n' +
        '`/setup` — initial configuration wizard\n' +
        '`/config` — manage channels, roles & listing filters\n' +
        '`/synctraits` — manually sync holder trait roles\n' +
        '`/lotteries` — manage burn lotteries & giveaways\n' +
        '`/help` — full command list\n\n' +
        '**Recommended channel setup:**\n' +
        '`#sales` — auto-posts every sale\n' +
        '`#listings` — auto-posts new listings\n' +
        '`#burns` — burn machine alerts\n' +
        '`#owner-verification` — wallet verification panel\n\n' +
        '*This bot will never DM members or ask for seed phrases.*'
      )
      .setFooter({ text: 'Run /setup to get started · /config to manage settings' });

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
// ── Boot ──────────────────────────────────────────────────────────────────────
client.once('clientReady', async ()=>{
  console.log('Bot online as '+client.user.tag);
  checkStartupEnvVars();
  console.log('OpenSea key: '+(OPENSEA_KEY?'set':'NOT SET'));
  // Init Railway DB table, then load all persisted state
  await runMigrations();
  await loadAllConfigs();
  await migrateMarketCollectionsToServerConfigs();
  await loadBurnConfig();
  await syncBurnConfigFromServerConfigs();
  console.log('[Startup] burnConfig synced from server_configs');
  await loadAllAlerts();
  await loadSaleCursors();
  await loadListingCursors();
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
    setInterval(pollBurnEvents, 30_000);
  } else {
    console.log('[Burn] No ALCHEMY_API_KEY set — burn poller disabled');
  }
  // Process pending burn alerts every 30s — waits for metadata to refresh before posting
  setInterval(processPendingBurnAlerts, 30_000);
  // Only run rank sync on production — staging shares the same codebase but shouldn't consume OS API quota
  if(process.env.BOT_ENV === 'production'){
    setInterval(drainRankSyncQueue, 5_000);           // drain burn-queued rank updates
    setInterval(rollingRankSync, RANK_SYNC_INTERVAL); // rolling background rank re-sync
    console.log('[RankSync] Background rank sync started (production only)');
  } else {
    console.log('[RankSync] Skipped on non-production environment');
  }
  processDueBurnLotteries();
  setInterval(processDueBurnLotteries, 60_000);
  processDueGenericLotteries();
  setInterval(processDueGenericLotteries, 15_000);
  setTimeout(()=>{ runDailyTraitSync(); setInterval(runDailyTraitSync, 24*60*60*1000); }, 5*60*1000);
});

client.on('error',e=>{ console.error('[Discord]',e.message); sendErrorWebhook('Discord Client Error', e); });
process.on('unhandledRejection',e=>{ console.error('[Bot]',e); sendErrorWebhook('Unhandled Rejection', e); });

async function syncBurnConfigFromServerConfigs(){
  try{
    for(const [guildId, cfg] of getAllConfigs()){
      if(cfg.burnChannel || cfg.burnAlertChannelId){
        const existing = getBurnConfig(guildId) || {};
        burnConfig[guildId] = { ...existing, burnAlertChannelId: cfg.burnChannel || cfg.burnAlertChannelId };
      }
    }
    await saveBurnConfig();
  }catch(e){ console.error('[BurnSync]', e.message); }
}


// ── Migrate market_collections_v1 -> server_configs ──────────────────────────
// One-time migration: copies extra collections from the old /market add system
// into server_configs.collections[] so they appear in /config
async function migrateMarketCollectionsToServerConfigs(){
  try{
    const marketData = await dbLoad('market_collections_v1');
    if(!marketData){ console.log('[Migration] market_collections_v1: no data'); return; }
    let migrated = 0;
    for(const [guildId, guildData] of Object.entries(marketData)){
      const collections = guildData?.collections || {};
      const extraCols = Object.entries(collections)
        .filter(([alias]) => alias !== 'ocas')
        .map(([alias, col]) => ({
          name: col.name || alias,
          slug: col.slug || alias,
          contract: col.contract || null,
          salesChannel: col.salesChannel || col.channelId || null,
          listingsChannel: col.listingsChannel || col.listingsChannelId || null,
          listingFilters: col.listingFilters || {},
        }));
      if(!extraCols.length) continue;
      const cfg = getConfig(guildId) || {};
      const existing = cfg.collections || [];
      const existingSlugs = new Set(existing.map(c => c.slug));
      const toAdd = extraCols.filter(c => c.slug && !existingSlugs.has(c.slug));
      if(!toAdd.length) continue;
      cfg.collections = [...existing, ...toAdd];
      await setConfig(guildId, cfg);
      migrated += toAdd.length;
      console.log('[Migration] guild=' + guildId + ' added ' + toAdd.length + ' collections from market_collections_v1');
    }
    console.log('[Migration] market_collections_v1 -> server_configs: ' + migrated + ' collections migrated');
  }catch(e){
    console.error('[Migration] market_collections_v1 failed:', e.message);
  }
}

client.login(DISCORD_TOKEN);










































