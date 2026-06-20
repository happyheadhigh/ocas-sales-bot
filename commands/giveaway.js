'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { ALCHEMY_KEY } = require('../lib/constants');

// ── Access control ────────────────────────────────────────────────────────────
// Same gate as /config, /setup: Manage Server permission, or the guild's
// configured Bot Manager role.
function hasGiveawayAccess(interaction, cfg){
  if(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const managerRoleId = cfg?.botManagerRoleId;
  if(managerRoleId && interaction.member?.roles?.cache?.has(managerRoleId)) return true;
  return false;
}
const NO_ACCESS_MSG = '🔒 You need **Manage Server** permission or the designated Bot Manager role to use this.';

// ── Window presets — map straight to resolveLotteryWindow's windowText format ─
const PRESETS = [
  { value: '1hr',    label: '⏱️ 1 hour',     windowText: 'now 1hr' },
  { value: '24hrs',  label: '🌙 24 hours',   windowText: 'now 24hrs' },
  { value: '3days',  label: '📅 3 days',     windowText: 'now 3days' },
  { value: '7days',  label: '🗓️ 7 days',     windowText: 'now 7days' },
  { value: 'custom', label: '✏️ Custom...',  windowText: null },
];

function presetMenu(customId, placeholder){
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder || 'Pick a duration...')
    .addOptions(PRESETS.map(p =>
      new StringSelectMenuOptionBuilder().setLabel(p.label).setValue(p.value)
    ));
}

// ── Session state (in-memory per user, ephemeral so fine) ─────────────────────
const sessions = new Map(); // userId → { type, preset, windowText, ... }

// ── Step 1: /giveaway → type select ───────────────────────────────────────────
async function handleGiveawayCommand(interaction, ctx){
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { getConfig } = ctx;
  const cfg = (getConfig && getConfig(interaction.guildId)) || {};
  if(!hasGiveawayAccess(interaction, cfg)){
    return interaction.editReply({ content: NO_ACCESS_MSG });
  }

  sessions.set(interaction.user.id, {});

  const typeMenu = new StringSelectMenuBuilder()
    .setCustomId('gva:type')
    .setPlaceholder('What kind of giveaway?')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Burn Lottery').setEmoji('🔥').setValue('burn').setDescription('Entries come from OCAS burn events automatically'),
      new StringSelectMenuOptionBuilder().setLabel('Giveaway').setEmoji('🎁').setValue('giveaway').setDescription('Members enter manually, random winner picked'),
      new StringSelectMenuOptionBuilder().setLabel('Guess the Number').setEmoji('🎯').setValue('guess').setDescription('Members guess a number, closest wins'),
      new StringSelectMenuOptionBuilder().setLabel('Instant Draw').setEmoji('⚡').setValue('instant').setDescription('Draw immediately from a list or number range'),
    );

  return interaction.editReply({
    content: '**🎰 New Giveaway**\n\nStep 1 — pick the type:',
    components: [new ActionRowBuilder().addComponents(typeMenu)],
  });
}

// ── Step 2: type chosen → window preset (skip for instant) ───────────────────
async function handleTypeSelect(interaction, ctx){
  const type = interaction.values[0];
  const session = sessions.get(interaction.user.id) || {};
  session.type = type;
  sessions.set(interaction.user.id, session);

  if(type === 'instant'){
    // Instant draw needs no window — go straight to the entries/range modal
    return showInstantModal(interaction);
  }

  const typeLabel = { burn: '🔥 Burn Lottery', giveaway: '🎁 Giveaway', guess: '🎯 Guess the Number' }[type];
  return interaction.update({
    content: `**🎰 New Giveaway — ${typeLabel}**\n\nStep 2 — pick how long it should run:`,
    components: [
      new ActionRowBuilder().addComponents(presetMenu('gva:preset')),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gva:cancel').setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ],
  });
}

// ── Step 3: preset chosen → details modal (or custom window/timezone modal) ──
async function handlePresetSelect(interaction, ctx){
  const preset = PRESETS.find(p => p.value === interaction.values[0]);
  const session = sessions.get(interaction.user.id) || {};
  session.preset = preset.value;
  session.windowText = preset.windowText;
  sessions.set(interaction.user.id, session);

  if(preset.value === 'custom'){
    return showCustomWindowModal(interaction, session.type);
  }

  return showDetailsModal(interaction, session.type, preset.windowText, null);
}

// ── Custom window modal — free-text window + timezone, same as the old commands ─
async function showCustomWindowModal(interaction, type){
  const modal = new ModalBuilder().setCustomId(`gva_modal:customwindow:${type}`).setTitle('Custom Duration');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('window')
        .setLabel('When + duration')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('now 24hrs, today-10am 7days, 06-07-2026-3pm')
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('timezone')
        .setLabel('Timezone (optional, default Europe/London)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Europe/London')
        .setRequired(false)
    ),
  );
  return interaction.showModal(modal);
}

// ── Custom window modal submit → go to details modal ──────────────────────────
async function handleCustomWindowModal(interaction, ctx){
  const type = interaction.customId.split(':')[2];
  const windowText = interaction.fields.getTextInputValue('window').trim();
  const timezone = interaction.fields.getTextInputValue('timezone').trim() || null;

  const session = sessions.get(interaction.user.id) || {};
  session.windowText = windowText;
  session.timezone = timezone;
  sessions.set(interaction.user.id, session);

  // Modals can't chain directly into another modal from a modal submit —
  // Discord requires a button/select click in between. Show a confirm button.
  return interaction.reply({
    content: `**Window set:** \`${windowText}\`${timezone ? ` (${timezone})` : ''}\n\nClick below to finish setting up your ${type === 'burn' ? 'burn lottery' : type === 'guess' ? 'guess lottery' : 'giveaway'}.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gva:details:${type}`).setLabel('➕ Continue').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('gva:cancel').setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

// ── Button that opens the details modal after a custom-window round-trip ─────
async function handleDetailsButton(interaction, ctx){
  const type = interaction.customId.split(':')[2];
  return showDetailsModal(interaction, type, null, null);
}

// ── Details modal — title/prize/mode depending on type ────────────────────────
async function showDetailsModal(interaction, type, windowText, _unused){
  const session = sessions.get(interaction.user.id) || {};
  if(windowText) session.windowText = windowText;
  sessions.set(interaction.user.id, session);

  const modal = new ModalBuilder().setCustomId(`gva_modal:details:${type}`).setTitle('Giveaway Details');
  const rows = [
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short)
        .setPlaceholder(type === 'burn' ? 'OCAS Burn Lottery' : type === 'guess' ? 'Guess the Number' : 'Giveaway')
        .setRequired(false)
    ),
  ];
  if(type !== 'guess'){
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('prize').setLabel('Prize (optional)').setStyle(TextInputStyle.Short).setRequired(false)
    ));
  }
  if(type === 'burn'){
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('mode').setLabel('Entry mode: wallet or burn').setStyle(TextInputStyle.Short)
        .setPlaceholder('wallet = one entry per wallet, burn = one per burn').setValue('wallet').setRequired(false)
    ));
  }
  if(type === 'guess'){
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('range').setLabel('Number range, e.g. 1-100').setStyle(TextInputStyle.Short)
        .setPlaceholder('1-100').setValue('1-100').setRequired(true)
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('winnermode').setLabel('Winner mode: closest or exact').setStyle(TextInputStyle.Short)
        .setPlaceholder('closest = nearest guess wins, exact = must match exactly').setValue('closest').setRequired(false)
    ));
  }
  modal.addComponents(...rows);

  // showModal must be the first response to THIS interaction — works for both
  // select-menu and button triggers since neither has been deferred/replied yet.
  return interaction.showModal(modal);
}

// ── Instant draw modal — entries or min/max range ─────────────────────────────
async function showInstantModal(interaction){
  const modal = new ModalBuilder().setCustomId('gva_modal:instant').setTitle('Instant Draw');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Title (optional)').setStyle(TextInputStyle.Short)
        .setPlaceholder('Instant Lottery').setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('entries').setLabel('Entries — comma separated (or leave blank)').setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Alice, Bob, Charlie').setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('range').setLabel('OR a number range, e.g. 1-100').setStyle(TextInputStyle.Short)
        .setPlaceholder('1-100').setRequired(false)
    ),
  );
  return interaction.showModal(modal);
}

// ── Details modal submitted → create the lottery via the right engine ─────────
async function handleDetailsModal(interaction, ctx){
  const type = interaction.customId.split(':')[2];
  const session = sessions.get(interaction.user.id) || {};
  const windowText = session.windowText;
  const timezone = session.timezone;
  const guildId = interaction.guildId;

  const title = interaction.fields.getTextInputValue('title').trim() || null;
  const prize = type !== 'guess' ? (interaction.fields.getTextInputValue('prize').trim() || null) : null;

  await interaction.deferReply();

  const {
    pgPool, resolveLotteryWindow, DEFAULT_LOTTERY_TIMEZONE, pendingDrawSeed,
    COLORS, buildActiveBurnLotteryComponents, formatBurnLotteryWindow,
    buildGenericLotteryStartEmbed, buildGenericLotteryComponents,
    lotteryNumberFromSeed,
  } = ctx;

  try{
    if(type === 'burn'){
      const mode = interaction.fields.getTextInputValue('mode').trim().toLowerCase() === 'burn' ? 'burn' : 'wallet';
      const resolved = resolveLotteryWindow({ windowText, hours: 24, timezone: timezone || DEFAULT_LOTTERY_TIMEZONE });
      const { start, end, timeZone } = resolved;
      if(end <= start) return interaction.editReply('End time must be after start time — check your custom window.');
      const seed = pendingDrawSeed();
      const channel = interaction.channel;
      const r = await pgPool.query(
        `INSERT INTO burn_lotteries (guild_id, channel_id, created_by, title, prize, mode, start_time, end_time, seed, status, timezone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10) RETURNING *`,
        [guildId, channel.id, interaction.user.id, title || 'OCAS Burn Lottery', prize, mode, start, end, seed, timeZone]
      );
      const row = r.rows[0];
      const msg = await interaction.editReply({ embeds:[new EmbedBuilder()
        .setTitle('🎟️ Burn lottery scheduled')
        .setColor(COLORS.OCAS_GREEN)
        .addFields(
          { name:'ID', value:String(row.id), inline:true },
          { name:'Window', value:formatBurnLotteryWindow(start, end, timeZone), inline:false },
          { name:'Mode', value: mode === 'burn' ? 'One entry per burn' : 'One entry per wallet', inline:true },
        )
        .setTimestamp()], components:buildActiveBurnLotteryComponents(row.id) });
      await pgPool.query('UPDATE burn_lotteries SET message_id=$1 WHERE id=$2', [msg.id, row.id]).catch(()=>{});
      sessions.delete(interaction.user.id);
      return;
    }

    if(type === 'giveaway' || type === 'guess'){
      const resolved = resolveLotteryWindow({ windowText, hours: 24, timezone: timezone || DEFAULT_LOTTERY_TIMEZONE });
      const { start, end } = resolved;
      const minutes = Math.max(1, Math.round((end - start) / 60000));
      const seed = type === 'giveaway' ? pendingDrawSeed() : require('crypto').randomBytes(12).toString('hex');

      let minN = null, maxN = null, winnerMode = 'random', winning = null;
      if(type === 'guess'){
        const rangeRaw = interaction.fields.getTextInputValue('range').trim();
        const m = rangeRaw.match(/(-?\d+)\s*-\s*(-?\d+)/);
        if(!m) return interaction.editReply('Could not parse the number range — use the format `1-100`.');
        minN = Math.min(parseInt(m[1]), parseInt(m[2]));
        maxN = Math.max(parseInt(m[1]), parseInt(m[2]));
        if(minN === maxN) return interaction.editReply('Min and max cannot match.');
        const winnerModeRaw = interaction.fields.getTextInputValue('winnermode').trim().toLowerCase();
        winnerMode = winnerModeRaw === 'exact' ? 'exact' : 'closest';
        winning = lotteryNumberFromSeed(`${seed}:winning-number`, minN, maxN);
      }

      const r = await pgPool.query(
        `INSERT INTO generic_lotteries
           (guild_id, channel_id, created_by, title, prize, type, min_number, max_number,
            winner_mode, winning_number, start_time, end_time, seed, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active') RETURNING *`,
        [guildId, interaction.channel.id, interaction.user.id,
         title || (type === 'guess' ? 'Guess the Number' : 'Giveaway Lottery'), prize, type,
         minN, maxN, winnerMode, winning, start, end, seed]
      );
      const row = r.rows[0];
      const components = buildGenericLotteryComponents(row.id, type, true);
      const msg = await interaction.editReply({ embeds:[buildGenericLotteryStartEmbed(row, 0)], components });
      await pgPool.query('UPDATE generic_lotteries SET message_id=$1 WHERE id=$2', [msg.id, row.id]).catch(()=>{});
      sessions.delete(interaction.user.id);
      return;
    }
  }catch(e){
    console.error('[/giveaway details]', e);
    if(ctx.sendErrorWebhook) ctx.sendErrorWebhook('/giveaway Error', e, `guild=${guildId} type=${type}`);
    return interaction.editReply('Something went wrong creating the giveaway: ' + e.message);
  }
}

// ── Instant draw modal submitted → draw immediately ────────────────────────────
async function handleInstantModal(interaction, ctx){
  const guildId = interaction.guildId;
  const title = interaction.fields.getTextInputValue('title').trim() || 'Instant Lottery';
  const entriesRaw = interaction.fields.getTextInputValue('entries').trim();
  const rangeRaw = interaction.fields.getTextInputValue('range').trim();

  await interaction.deferReply();

  const {
    pgPool, pendingDrawSeed, randomLotterySeed, lotteryPick,
    waitForEthBlock, fetchEthBlockHashSeed, burnRpc,
    COLORS, buildGenericLotteryResultEmbed, buildGenericLotteryComponents,
  } = ctx;

  try{
    let entries = entriesRaw ? entriesRaw.split(',').map(s=>s.trim()).filter(Boolean) : [];
    if(!entries.length && rangeRaw){
      const m = rangeRaw.match(/(-?\d+)\s*-\s*(-?\d+)/);
      if(m){
        const lo = Math.min(parseInt(m[1]), parseInt(m[2])), hi = Math.max(parseInt(m[1]), parseInt(m[2]));
        for(let i = lo; i <= hi; i++) entries.push(String(i));
      }
    }
    if(entries.length < 2) return interaction.editReply('Add at least 2 entries (comma separated), or a number range like `1-100`.');

    const preInsert = await pgPool.query(
      `INSERT INTO generic_lotteries
         (guild_id, channel_id, created_by, title, type, start_time, end_time, seed, status)
       VALUES ($1,$2,$3,$4,'giveaway',NOW(),NOW(),$5,'processing') RETURNING id`,
      [guildId, interaction.channel.id, interaction.user.id, title, pendingDrawSeed()]
    );
    const lotteryId = preInsert.rows[0]?.id;

    for(let i = 0; i < entries.length; i++){
      await pgPool.query(
        `INSERT INTO generic_lottery_entries (lottery_id, user_id, username) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [lotteryId, `${entries[i]}:${i}`, entries[i]]
      ).catch(()=>{});
    }

    let ethSeed = null, ethBlockNumber = null;
    try{
      const rpcUrl = process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://','https://') || `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
      const latestBlock = parseInt(await burnRpc(rpcUrl, 'eth_blockNumber', []), 16);
      const targetBlock = latestBlock + 5;
      const arrived = await waitForEthBlock(targetBlock);
      if(arrived){
        const { hash } = await fetchEthBlockHashSeed(targetBlock);
        ethSeed = hash;
        ethBlockNumber = targetBlock;
      }
    }catch(_){}

    const activeSeed = ethSeed || randomLotterySeed();
    const pick = lotteryPick(entries, activeSeed);

    await pgPool.query(
      `UPDATE generic_lotteries SET seed=$1, status='completed', result_json=$2, completed_at=NOW() WHERE id=$3`,
      [activeSeed, JSON.stringify({ proof: pick.proof||null, winner_index: pick.index??null, winner_position: pick.position??null, block_number: ethBlockNumber||null }), lotteryId]
    ).catch(()=>{});

    const resultRow = { id: lotteryId, title, type:'giveaway', seed: activeSeed,
      winner_display: String(pick.winner),
      result_json: { proof: pick.proof||null, block_number: ethBlockNumber||null } };
    const resultEmbed = buildGenericLotteryResultEmbed(resultRow, entries.map(e=>({ username:e, user_id:e })), pick);
    const resultComponents = buildGenericLotteryComponents(lotteryId, 'giveaway', false);

    sessions.delete(interaction.user.id);
    return interaction.editReply({ embeds:[resultEmbed], components:resultComponents });
  }catch(e){
    console.error('[/giveaway instant]', e);
    if(ctx.sendErrorWebhook) ctx.sendErrorWebhook('/giveaway Instant Error', e, `guild=${guildId}`);
    return interaction.editReply('Something went wrong: ' + e.message);
  }
}

// ── Cancel button (during the picker flow, before anything is created) ────────
async function handleCancelButton(interaction, ctx){
  sessions.delete(interaction.user.id);
  return interaction.update({ content: '❌ Giveaway setup cancelled.', components: [] });
}

// ── Top-level button/select router for gva: customIds ──────────────────────────
async function handleGiveawayInteraction(interaction, ctx){
  const customId = interaction.customId;

  if(interaction.isStringSelectMenu() && customId === 'gva:type')        return handleTypeSelect(interaction, ctx);
  if(interaction.isStringSelectMenu() && customId === 'gva:preset')      return handlePresetSelect(interaction, ctx);
  if(interaction.isButton() && customId.startsWith('gva:details:'))      return handleDetailsButton(interaction, ctx);
  if(interaction.isButton() && customId === 'gva:cancel')                return handleCancelButton(interaction, ctx);
  if(interaction.isModalSubmit() && customId.startsWith('gva_modal:customwindow:')) return handleCustomWindowModal(interaction, ctx);
  if(interaction.isModalSubmit() && customId.startsWith('gva_modal:details:'))      return handleDetailsModal(interaction, ctx);
  if(interaction.isModalSubmit() && customId === 'gva_modal:instant')               return handleInstantModal(interaction, ctx);
}

const GIVEAWAY_COMMANDS = new Set(['giveaway']);

module.exports = { handleGiveawayCommand, handleGiveawayInteraction, GIVEAWAY_COMMANDS };
