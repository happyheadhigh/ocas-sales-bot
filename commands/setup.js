'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
} = require('discord.js');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const OCAS_SLUG     = 'on-chain-all-stars';

// ── Wizard state (in-memory per guild, ephemeral so fine) ─────────────────────
const wizardState = new Map(); // guildId → { step, config }

function getState(guildId){
  if(!wizardState.has(guildId)) wizardState.set(guildId, { step: 0, config: {} });
  return wizardState.get(guildId);
}

// ── Step embeds ───────────────────────────────────────────────────────────────
function stepBar(current, total){
  const filled = '█'.repeat(current);
  const empty  = '░'.repeat(total - current);
  return `${filled}${empty}  Step ${current} of ${total}`;
}

function buildWelcomeEmbed(){
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🤖 Bot Setup Wizard')
    .setDescription(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      'Welcome! This wizard will walk you through\n' +
      'configuring your bot in a few easy steps.\n\n' +
      '**What you\'ll set up:**\n' +
      '📦 Your NFT collection\n' +
      '📢 Alert channels\n' +
      '🔐 Wallet verification\n' +
      '🎭 Trait roles\n\n' +
      '*You can run `/setup` anytime to update settings.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildCollectionEmbed(state){
  const cfg = state.config;
  const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
  const statusLine = cfg.contract
    ? (isOcas
        ? '🔥 **OCAS detected** — Full feature set unlocked!'
        : `✅ Contract set — Standard features enabled\n\`${cfg.contract.slice(0,6)}...${cfg.contract.slice(-4)}\``)
    : '❌ Not set';

  return new EmbedBuilder()
    .setColor(isOcas ? 0xFF6B00 : 0x5865F2)
    .setTitle('📦 Collection Setup')
    .setDescription(
      stepBar(1, 5) + '\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      '**Enter your NFT collection contract address.**\n' +
      'This determines which features are available.\n\n' +
      `**Status:** ${statusLine}\n\n` +
      (isOcas ? '> `/burn`, `/burnlottery`, `/burnstats`, `/ocas`,\n> `/sweep`, `/traitfind` and all OCAS commands enabled.' : '')
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildChannelsEmbed(state){
  const cfg = state.config;
  const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
  const s = (id) => id ? `<#${id}> ✅` : '❌ Not set';

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📢 Alert Channels')
    .setDescription(
      stepBar(2, 5) + '\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      'Set which channels receive which alerts.\n\n' +
      `🟢 **Sales:** ${s(cfg.salesChannel)}\n` +
      `📋 **Listings:** ${s(cfg.listingsChannel)}\n` +
      (isOcas ? `🔥 **Burn Alerts:** ${s(cfg.burnChannel)}\n` : '') +
      '\nClick each button to set the channel.'
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildVerificationEmbed(state){
  const cfg = state.config;
  const configured = cfg.verifyChannel && cfg.verifyRole;

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔐 Wallet Verification')
    .setDescription(
      stepBar(3, 5) + '\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      'Any member can link their wallet — no token required.\n' +
      'Use `/setuptraitrole` to gate roles by token ownership.\n\n' +
      `📌 **Channel:** ${cfg.verifyChannel ? `<#${cfg.verifyChannel}> ✅` : '❌ Not set'}\n` +
      `🎭 **Verified Role:** ${cfg.verifyRole ? `<@&${cfg.verifyRole}> ✅` : '❌ Not set'}\n\n` +
      (configured ? '✅ Ready to deploy verification panel.' : '*Set channel and role to enable.*')
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildTraitRolesEmbed(state){
  const cfg = state.config;
  const count = (cfg.traitRoles || []).length;

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎭 Trait Roles')
    .setDescription(
      stepBar(4, 5) + '\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      'Assign roles automatically based on token traits\n' +
      'or how many tokens a member holds.\n\n' +
      '**Examples:**\n' +
      '• `Type: Zombie` → `@Zombie Holder`\n' +
      '• `5+ Type: Ape` → `@King Ape`\n' +
      '• `20+ Collection: Any` → `@Collector`\n\n' +
      `**Configured:** ${count} trait role${count !== 1 ? 's' : ''}\n\n` +
      '*Use `/setuptraitrole` after setup to add more.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildSummaryEmbed(state, guild){
  const cfg = state.config;
  const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
  const tick = v => v ? '✅' : '❌';

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Setup Complete!')
    .setDescription(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      `**Collection:** ${isOcas ? 'OCAS 🔥' : (cfg.contractName || 'Custom')} ${tick(cfg.contract)}\n` +
      `**Sales:** ${cfg.salesChannel ? `<#${cfg.salesChannel}>` : 'Not set'} ${tick(cfg.salesChannel)}\n` +
      `**Listings:** ${cfg.listingsChannel ? `<#${cfg.listingsChannel}>` : 'Not set'} ${tick(cfg.listingsChannel)}\n` +
      (isOcas ? `**Burn Alerts:** ${cfg.burnChannel ? `<#${cfg.burnChannel}>` : 'Not set'} ${tick(cfg.burnChannel)}\n` : '') +
      `**Verification:** ${cfg.verifyChannel ? `<#${cfg.verifyChannel}>` : 'Not set'} ${tick(cfg.verifyChannel)}\n` +
      `**Trait Roles:** ${(cfg.traitRoles||[]).length} configured\n\n` +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '**Useful commands:**\n' +
      '• `/setup` — return here anytime\n' +
      '• `/setuptraitrole` — add trait roles\n' +
      '• `/listtraitroles` — view trait roles\n' +
      '• `/synctraits` — manually sync roles now'
    )
    .setFooter({ text: 'Run /setup anytime to update settings' });
}

// ── Button rows ───────────────────────────────────────────────────────────────
function welcomeRow(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:start').setLabel('🚀 Get Started').setStyle(ButtonStyle.Primary)
  );
}

function collectionRow(hasContract){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:contract').setLabel('Enter Contract Address').setStyle(ButtonStyle.Primary).setEmoji('📦'),
    new ButtonBuilder().setCustomId('setup:step:3').setLabel(hasContract ? 'Next →' : 'Skip').setStyle(hasContract ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
}

function channelsRow(isOcas){
  const btns = [
    new ButtonBuilder().setCustomId('setup:channel:sales').setLabel('🟢 Sales Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:channel:listings').setLabel('📋 Listings Channel').setStyle(ButtonStyle.Secondary),
  ];
  if(isOcas) btns.push(
    new ButtonBuilder().setCustomId('setup:channel:burn').setLabel('🔥 Burn Alerts').setStyle(ButtonStyle.Secondary)
  );
  btns.push(new ButtonBuilder().setCustomId('setup:step:4').setLabel('Next →').setStyle(ButtonStyle.Success));
  return new ActionRowBuilder().addComponents(btns);
}

function verificationRow(configured){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:verify:channel').setLabel('📌 Set Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:verify:role').setLabel('🎭 Set Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:verify:deploy').setLabel('🚀 Deploy Panel').setStyle(ButtonStyle.Primary).setDisabled(!configured),
    new ButtonBuilder().setCustomId('setup:step:5').setLabel('Next →').setStyle(ButtonStyle.Success),
  );
}

function traitRolesRow(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:step:6').setLabel('Finish ✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
  );
}

function summaryRow(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:close').setLabel('Close').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:step:2').setLabel('↩ Start Over').setStyle(ButtonStyle.Secondary),
  );
}

// ── Main handler ──────────────────────────────────────────────────────────────
async function handleSetupCommand(interaction, ctx){
  await interaction.deferReply({ flags: 64 }); // ephemeral
  const state = getState(interaction.guildId);
  state.step = 1;
  await interaction.editReply({
    embeds: [buildWelcomeEmbed()],
    components: [welcomeRow()],
  });
}

async function handleSetupButton(interaction, ctx){
  const { pgPool } = ctx;
  const guildId  = interaction.guildId;
  const state    = getState(guildId);
  const customId = interaction.customId;

  // ── step navigation ──────────────────────────────────────────────────────
  if(customId === 'setup:start' || customId.startsWith('setup:step:')){
    await interaction.deferUpdate();
    const step = customId === 'setup:start' ? 2 : parseInt(customId.split(':')[2]);
    state.step = step;
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;

    if(step === 2){
      return interaction.editReply({ embeds:[buildCollectionEmbed(state)], components:[collectionRow(!!state.config.contract)] });
    }
    if(step === 3){
      return interaction.editReply({ embeds:[buildChannelsEmbed(state)], components:[channelsRow(isOcas)] });
    }
    if(step === 4){
      const verified = state.config.verifyChannel && state.config.verifyRole;
      return interaction.editReply({ embeds:[buildVerificationEmbed(state)], components:[verificationRow(verified)] });
    }
    if(step === 5){
      return interaction.editReply({ embeds:[buildTraitRolesEmbed(state)], components:[traitRolesRow()] });
    }
    if(step === 6){
      // Save config to DB
      try{
        const { setConfig } = ctx;
        const existing = await setConfig(guildId, state.config);
      }catch(e){ console.error('[Setup] Save error:', e.message); }
      return interaction.editReply({ embeds:[buildSummaryEmbed(state, interaction.guild)], components:[summaryRow()] });
    }
  }

  // ── contract address modal ───────────────────────────────────────────────
  if(customId === 'setup:contract'){
    const modal = new ModalBuilder()
      .setCustomId('setup_modal:contract')
      .setTitle('Enter Contract Address');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('contract_input')
          .setLabel('NFT Contract Address (0x...)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('0x078be86f3104a32313a47815792230a3808642cc')
          .setRequired(true)
          .setMinLength(42)
          .setMaxLength(42)
      )
    );
    return interaction.showModal(modal);
  }

  // ── channel selectors ────────────────────────────────────────────────────
  if(customId.startsWith('setup:channel:')){
    await interaction.deferUpdate();
    const type  = customId.split(':')[2];
    const label = type === 'sales' ? '🟢 Sales' : type === 'listings' ? '📋 Listings' : '🔥 Burn Alerts';
    const menu  = new ChannelSelectMenuBuilder()
      .setCustomId('setup_chsel:'+type)
      .setPlaceholder('Pick the '+label+' channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({
      content: '**Select the '+label+' channel:**',
      components: [new ActionRowBuilder().addComponents(menu)],
      embeds: [],
    });
  }

  // ── verification setup ───────────────────────────────────────────────────
  if(customId === 'setup:verify:channel'){
    await interaction.deferUpdate();
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId('setup_chsel:verify')
      .setPlaceholder('Pick the verification channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({
      content: '**Select the verification channel:**',
      components: [new ActionRowBuilder().addComponents(menu)],
      embeds: [],
    });
  }

  if(customId === 'setup:verify:role'){
    await interaction.deferUpdate();
    const menu = new RoleSelectMenuBuilder()
      .setCustomId('setup_rolesel:verify')
      .setPlaceholder('Pick the Verified role');
    return interaction.editReply({
      content: '**Select the 🎭 Verified role:**',
      components: [new ActionRowBuilder().addComponents(menu)],
      embeds: [],
    });
  }

  if(customId === 'setup:verify:deploy'){
    await interaction.deferUpdate();
    try{
      const ch = await interaction.guild.channels.fetch(state.config.verifyChannel).catch(()=>null);
      if(!ch) return interaction.editReply({ content:'❌ Could not find verification channel.' });

      const panelEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Wallet Verification')
        .setDescription('Verify your wallet to get access.\n\nClick the button below to get started.')
        .setFooter({ text:'Click the button below to get started' });

      const startBtn = new ButtonBuilder()
        .setCustomId('start_verification:'+guildId)
        .setLabel('Start Verification')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🔗');

      const msg = await ch.send({ embeds:[panelEmbed], components:[new ActionRowBuilder().addComponents(startBtn)] });
      state.config.verifyMessageId = msg.id;

      await pgPool.query(
        `INSERT INTO verification_panels (guild_id,channel_id,role_id,min_tokens,message_id,welcome_text)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id=$2,role_id=$3,min_tokens=$4,message_id=$5,welcome_text=$6`,
        [guildId, state.config.verifyChannel, state.config.verifyRole||null, 0, msg.id, 'Verify your wallet to get access.']
      );

      const verified = state.config.verifyChannel && state.config.verifyRole;
      return interaction.editReply({ embeds:[buildVerificationEmbed(state)], components:[verificationRow(verified)], content:'✅ Panel deployed!' });
    }catch(e){
      console.error('[Setup] Deploy panel error:', e.message);
      return interaction.editReply({ content:'❌ Failed to deploy panel: '+e.message });
    }
  }

  // ── channel / role select menus ──────────────────────────────────────────
  if(customId.startsWith('setup_chsel:') || customId.startsWith('setup_rolesel:')){
    await interaction.deferUpdate();
    const type = customId.split(':')[1];
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;
    if(customId.startsWith('setup_chsel:')){
      const chId = interaction.values[0];
      if(type === 'sales')    state.config.salesChannel    = chId;
      if(type === 'listings') state.config.listingsChannel = chId;
      if(type === 'burn')     state.config.burnChannel     = chId;
      if(type === 'verify')   state.config.verifyChannel   = chId;
      if(type === 'verify'){
        const verified = state.config.verifyChannel && state.config.verifyRole;
        return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(state)], components:[verificationRow(verified)] });
      }
      return interaction.editReply({ content:'', embeds:[buildChannelsEmbed(state)], components:[channelsRow(isOcas)] });
    }
    if(customId.startsWith('setup_rolesel:')){
      state.config.verifyRole = interaction.values[0];
      const verified = state.config.verifyChannel && state.config.verifyRole;
      return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(state)], components:[verificationRow(verified)] });
    }
  }

  // ── close / skip ─────────────────────────────────────────────────────────
  if(customId === 'setup:close' || customId === 'setup:skip'){
    await interaction.deferUpdate();
    wizardState.delete(guildId);
    return interaction.editReply({ embeds:[], components:[], content:'✅ Setup closed. Run `/setup` anytime to return.' });
  }
}

async function handleSetupModal(interaction, ctx){
  const { pgPool, setConfig } = ctx;
  const guildId  = interaction.guildId;
  const state    = getState(guildId);
  const customId = interaction.customId;

  // ── contract address ──────────────────────────────────────────────────────
  if(customId === 'setup_modal:contract'){
    await interaction.deferUpdate();
    const contract = interaction.fields.getTextInputValue('contract_input').trim().toLowerCase();
    if(!/^0x[0-9a-f]{40}$/i.test(contract)){
      return interaction.editReply({ content:'❌ Invalid contract address. Must be 0x followed by 40 hex characters.' });
    }
    state.config.contract = contract;
    const isOcas = contract === OCAS_CONTRACT;
    if(isOcas){
      state.config.contractName   = 'On-Chain All Stars';
      state.config.collectionSlug = OCAS_SLUG;
      state.config.isOcas         = true;
    }
    return interaction.editReply({
      embeds: [buildCollectionEmbed(state)],
      components: [collectionRow(true)],
    });
  }

  // channel/role selects handled in handleSetupButton (routed there by bot.js)
}
const SETUP_COMMANDS = new Set(['setup']);

module.exports = { handleSetupCommand, handleSetupButton, handleSetupModal, SETUP_COMMANDS };


