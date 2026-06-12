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
  PENDING_DRAW_SEED_PREFIX,
} = require('./lib/constants');

const {
  pgPool, runMigrations, dbLoad, dbSave,
  loadAllConfigs, getConfig, setConfig,
} = require('./lib/db');

const { sendErrorWebhook, checkStartupEnvVars } = require('./lib/error');

const {
  getCachedImage, setCachedImage,
  getCachedTraits, setCachedTraits,
  sweepSessions, slideshowSessions,
  recentChannelPosts, alertedEventIds,
  checkCooldown, dedupeChannelPost,
} = require('./lib/cache');

const { burnRpc, burnRpcUrl, fetchEthBlockHashSeed, waitForEthBlock } = require('./lib/rpc');
const { rollingRankSync, drainRankSyncQueue, queueRankSync, rankSyncQueue } = require('./lib/rank-sync');

const { BURN_COLORS, E1_TYPE_NAMES, normalizeOcasType } = require('./lib/burn-constants');
const {
  burnConfig, loadBurnConfig, saveBurnConfig,
  getBurnConfig, getConfiguredBurnChannelId,
  checkCommandCooldown, fetchBotApiJson,
  buildNavRow, postEmbeds,
} = require('./lib/burn-config');

const {
  pollBurnEvents, processPendingBurnAlerts,
  buildBurnEmbed, triggerOsMetadataRefresh,
  setClient,
} = require('./lib/burn-poller');

const {
  buildBurnLotteryEmbed, buildActiveBurnLotteryComponents, buildBurnLotteryComponents,
  buildGenericLotteryStartEmbed, buildGenericLotteryResultEmbed,
  buildGenericLotteryComponents, getGenericLotteryEntryCount,
  drawGenericLottery, processDueGenericLotteries,
  getBurnLotteryEntries, drawAndPostBurnLottery, processDueBurnLotteries,
} = require('./lib/lottery-engine');

const { fetchTokenMetaFromDb, upsertTokenTraitRows, buildSaleEmbed, buildListingEmbed } = require('./lib/embeds');
const { resolveImage, sendEmbed, extractPngFromSvg } = require('./lib/images');

const {
  pollSales, pollListings,
  getAlert, setAlert, deleteAlert,
  loadAllAlerts, loadSaleCursors, loadListingCursors,
  saveSaleCursors, saveListingCursors,
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
const { handleMarketCommand, MARKET_COMMANDS }   = require('./commands/market');
const { handleOcasCommand, OCAS_COMMANDS }       = require('./commands/ocas');
const { handleBurnCommand, BURN_COMMANDS }       = require('./commands/burn');
const { handleLotteryCommand, LOTTERY_COMMANDS } = require('./commands/lottery');
const { handleMiscCommand, MISC_COMMANDS }       = require('./commands/misc');

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
setClient(client); // inject into burn-poller

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
    COLORS, OCAS_CONTRACT, BURN_CONTRACT, BURN_COLORS, E1_TYPE_NAMES,
    // Helpers
    osHeaders, getRailwayApiUrl, fetchBotApiJson, resolveDiscordChannel,
    checkCommandCooldown, normalizeOcasType,
    // DB
    pgPool, dbLoad, dbSave, getConfig, setConfig,
    // Cache
    getCachedImage, setCachedImage, getCachedTraits, setCachedTraits,
    sweepSessions, slideshowSessions, recentChannelPosts,
    // RPC
    burnRpc, burnRpcUrl, fetchEthBlockHashSeed, waitForEthBlock,
    // Embeds
    buildSaleEmbed, buildListingEmbed, sendEmbed, postEmbeds,
    resolveImage, extractPngFromSvg,
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
    normAddr, shortAddr, formatEth, timeSince, lotteryTime,
    isSvg, isDiscordOk, matchesFilters,
    // Rank sync
    rankSyncQueue, queueRankSync,
    // Components
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder, AttachmentBuilder, MessageFlags, PermissionFlagsBits,
  };
}

// ── interactionCreate — button handlers + command dispatch ────────────────────
client.on('interactionCreate', async (interaction)=>{
  if(interaction.isButton() && interaction.customId.startsWith('lottery_enter:')){
    const lotteryId=parseInt(interaction.customId.split(':')[1]);
    try{
      const r=await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1',[lotteryId]); const row=r.rows[0];
      if(!row) return interaction.reply({content:'Lottery not found.',flags:MessageFlags.Ephemeral});
      if(row.status!=='active' || new Date(row.end_time)<=new Date()) return interaction.reply({content:'This lottery is closed.',flags:MessageFlags.Ephemeral});
      if(row.type!=='giveaway') return interaction.reply({content:'This is a guess lottery. Use /lottery guess.',flags:MessageFlags.Ephemeral});
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
      return interaction.reply({content:`You are entered in lottery #${lotteryId}. Current entries: ${count}.`,flags:MessageFlags.Ephemeral});
    }catch(e){ return interaction.reply({content:'Could not enter lottery: '+e.message,flags:MessageFlags.Ephemeral}).catch(()=>{}); }
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
          if(ocasTraitsCache.size >= OCAS_TRAITS_CACHE_MAX){
          const oldest = [...ocasTraitsCache.keys()].slice(0, 200);
          for(const k of oldest) ocasTraitsCache.delete(k);
        }
        ocasTraitsCache.set(tokenId, { traits, expires: Date.now() + 5 * 60 * 1000 });
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
            if(ocasTraitsCache.size >= OCAS_TRAITS_CACHE_MAX){
              const oldest = [...ocasTraitsCache.keys()].slice(0, 200);
              for(const k of oldest) ocasTraitsCache.delete(k);
            }
            ocasTraitsCache.set(tokenId, { traits, expires: Date.now() + 5 * 60 * 1000 });
          }
        }catch(apiErr){
          console.warn('[ShowTraits API]', apiErr.message);
        }
      }

      if(!traits || !realTraitCount(traits)){
        const local = await fetchTokenMetaFromLocalDb(tokenId).catch(()=>null);
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
               array_agg(bei.burned_token_id ORDER BY bei.burned_token_id) AS burned_ids
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        WHERE be.survivor_token_id = $1
        GROUP BY be.id
        ORDER BY be.burned_at ASC NULLS LAST
      `, [survivorId]);
      if(!r.rows.length){ await interaction.editReply({ content:'No burn history found.' }); return; }
      const lines = r.rows.map((b, i) => {
        const burnNum = i + 1;
        const ids = (b.burned_ids||[]).filter(Boolean);
        const idsStr = ids.length ? ids.map(id=>`#${id}`).join(', ') : '?';
        return `**Burn ${burnNum}:** ${idsStr} → #${survivorId}`;
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
        SELECT be.id, be.burned_at, be.result_body_type, be.result_is_angel, be.points_used,
               array_agg(bei.burned_token_id ORDER BY bei.burned_token_id) AS burned_ids
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        WHERE be.survivor_token_id = $1
        GROUP BY be.id
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
        const ids = (b.burned_ids||[]).filter(Boolean);
        const tokensStr = await burnTypeBreakdown(ids, b.id).catch(()=>String(ids.length||'?'));
        // Pre-burn state: Burn 1 = original archive, Burn N = post-state of Burn N-1
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
          if(raw) preBurnType = normalizeOcasType(typeof raw==='string' ? raw.replace(/^"|"$/g,'') : String(raw));
        }
        const osUrl = `https://opensea.io/assets/ethereum/${contract}/${survivorId}`;
        const slideEmbed = new EmbedBuilder()
          .setColor(BURN_COLORS.FIRE)
          .setTitle(`Before Burn ${burnNum} — ${ago}`)
          .setURL(osUrl)
          .addFields(
            { name:'Tokens Burned', value:tokensStr, inline:true },
            { name:'Points Used',   value:String(b.points_used||0)+' pts', inline:true },
            { name:'Type Before',   value:preBurnType || '—', inline:true },
          )
          .setFooter({ text:`#${survivorId} · Burn ${burnNum} of ${r.rows.length}` });
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

  if(!interaction.isChatInputCommand()) return;
  const ctx = buildCtx(interaction, guildId, config, isAdmin);

  if(ADMIN_COMMANDS.has(commandName))   return handleAdminCommand(commandName, ctx);
  if(MARKET_COMMANDS.has(commandName))  return handleMarketCommand(commandName, ctx);
  if(OCAS_COMMANDS.has(commandName))    return handleOcasCommand(commandName, ctx);
  if(BURN_COMMANDS.has(commandName))    return handleBurnCommand(commandName, ctx);
  if(LOTTERY_COMMANDS.has(commandName)) return handleLotteryCommand(commandName, ctx);
  if(MISC_COMMANDS.has(commandName))    return handleMiscCommand(commandName, ctx);
});

// ── Welcome message on server join ───────────────────────────────────────────
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
// ── Boot ──────────────────────────────────────────────────────────────────────
client.once('clientReady', async ()=>{
  console.log('Bot online as '+client.user.tag);
  checkStartupEnvVars();
  console.log('OpenSea key: '+(OPENSEA_KEY?'set':'NOT SET'));
  // Init Railway DB table, then load all persisted state
  await runMigrations();
  await loadAllConfigs();
  await loadAllAlerts();
  await loadSaleCursors();
  await loadListingCursors();
  await loadBurnConfig();
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
});

client.on('error',e=>{ console.error('[Discord]',e.message); sendErrorWebhook('Discord Client Error', e); });
process.on('unhandledRejection',e=>{ console.error('[Bot]',e); sendErrorWebhook('Unhandled Rejection', e); });
client.login(DISCORD_TOKEN);
