'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, ChannelType,
} = require('discord.js');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const OCAS_SLUG     = 'on-chain-all-stars';

// Re-use trait cache helper from config (inline here to avoid circular require)
async function fetchAndStoreCollectionTraits(slug, pgPool){
  if(!slug) return;
  try{
    const { osHeaders } = require('../lib/constants');
    const fetch = require('node-fetch');
    const res = await fetch(
      `https://api.opensea.io/api/v2/traits/${slug}`,
      { headers: osHeaders() }
    );
    if(!res.ok){ console.warn('[TraitCache] OS traits fetch failed:', res.status, slug); return; }
    const data = await res.json();
    const categories = data.categories || {};
    let count = 0;
    for(const [traitName, values] of Object.entries(categories)){
      if(!Array.isArray(values)) continue;
      for(const v of values){
        const val = typeof v === 'object' ? (v.value||v.trait_value||String(v)) : String(v);
        const cnt = typeof v === 'object' ? (parseInt(v.count)||0) : 0;
        await pgPool.query(
          `INSERT INTO collection_traits (slug, trait_name, trait_value, token_count)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (slug, trait_name, trait_value) DO UPDATE SET token_count=$4`,
          [slug, traitName, val, cnt]
        ).catch(()=>{});
        count++;
      }
    }
    console.log(`[TraitCache] Stored ${count} trait values for ${slug}`);
  }catch(e){
    console.warn('[TraitCache] Error fetching traits for', slug, ':', e.message);
  }
}

// ── Wizard state ──────────────────────────────────────────────────────────────
// In-memory cache; backed by server_configs JSONB (wizard_state key) for persistence
const wizardCache = new Map(); // guildId → { step, config }

async function loadState(guildId, pgPool){
  if(wizardCache.has(guildId)) return wizardCache.get(guildId);
  try{
    const r = await pgPool.query(`SELECT config FROM server_configs WHERE guild_id=$1`, [guildId]);
    const saved = r.rows[0]?.config?.wizard_state;
    if(saved){ wizardCache.set(guildId, saved); return saved; }
  }catch(_){}
  const fresh = { step: 1, config: {} };
  wizardCache.set(guildId, fresh);
  return fresh;
}

async function saveState(guildId, state, pgPool){
  wizardCache.set(guildId, state);
  try{
    await pgPool.query(
      `INSERT INTO server_configs(guild_id, config) VALUES($1, jsonb_build_object('wizard_state',$2::jsonb))
       ON CONFLICT(guild_id) DO UPDATE SET config = server_configs.config || jsonb_build_object('wizard_state',$2::jsonb)`,
      [guildId, JSON.stringify(state)]
    );
  }catch(e){ console.warn('[Setup] saveState:', e.message); }
}

async function clearWizardState(guildId, pgPool){
  wizardCache.delete(guildId);
  try{
    await pgPool.query(
      `UPDATE server_configs SET config = config - 'wizard_state' WHERE guild_id=$1`,
      [guildId]
    );
  }catch(_){}
}

// ── Step UI helpers ───────────────────────────────────────────────────────────
function stepBar(current, total){
  return '█'.repeat(current) + '░'.repeat(total - current) + `  Step ${current} of ${total}`;
}
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

// ── Step embeds ───────────────────────────────────────────────────────────────
function buildWelcomeEmbed(){
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🤖 Bot Setup Wizard')
    .setDescription(
      SEP + '\n\n' +
      'Welcome! This wizard will walk you through setting up your bot.\n\n' +
      '**What we\'ll configure:**\n' +
      '→ Your NFT collection\n' +
      '→ Sales & listings channels\n' +
      '→ Wallet verification & holder roles\n' +
      '→ Trait-based roles (optional)\n\n' +
      '*You can run `/setup` anytime to update settings.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildCollectionEmbed(state){
  const cfg = state.config;
  const hasC = !!cfg.contract;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📦 Collection')
    .setDescription(
      stepBar(2, 6) + '\n' + SEP + '\n\n' +
      'Enter your NFT contract address so the bot knows which collection to track.\n\n' +
      (hasC
        ? `✅ **Contract:** \`${cfg.contract}\`\n` +
          (cfg.isOcas ? '🔥 **OCAS detected** — full feature set unlocked!\n' : `📁 **Name:** ${cfg.contractName || 'Custom collection'}\n`)
        : '❌ No contract set yet.\n') +
      '\n*Tip: Your contract address starts with `0x` and is 42 characters long.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildChannelsEmbed(state){
  const cfg = state.config;
  const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
  const ch = id => id ? `<#${id}> ✅` : '❌ Not set';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📡 Alert Channels')
    .setDescription(
      stepBar(3, 6) + '\n' + SEP + '\n\n' +
      'Choose which channels the bot posts alerts in.\n\n' +
      `🟢 **Sales:** ${ch(cfg.salesChannel)}\n` +
      `📋 **Listings:** ${ch(cfg.listingsChannel)}\n` +
      (isOcas ? `🔥 **Burn Alerts:** ${ch(cfg.burnChannel)}\n` : '') +
      '\n*You can skip any channel — alerts just won\'t post there.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildVerificationEmbed(state){
  const cfg = state.config;
  const configured = !!(cfg.verifyChannel && cfg.verifyRole);
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔐 Wallet Verification')
    .setDescription(
      stepBar(4, 6) + '\n' + SEP + '\n\n' +
      'Any member can link their wallet — no token required.\n' +
      'Members who hold ≥1 token also get the **Holder** role automatically.\n\n' +
      `📌 **Channel:** ${cfg.verifyChannel ? `<#${cfg.verifyChannel}> ✅` : '❌ Not set'}\n` +
      `✅ **Verified Role:** ${cfg.verifyRole ? `<@&${cfg.verifyRole}> ✅` : '❌ Not set'}\n` +
      `🏆 **Holder Role:** ${cfg.holderRole ? `<@&${cfg.holderRole}> ✅` : '⚪ Optional'}\n\n` +
      (configured ? '✅ Ready to deploy verification panel.' : '*Set channel and Verified role to continue.*')
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildTraitRolesEmbed(state){
  const cfg = state.config;
  const roles = cfg.traitRoles || [];

  let roleList = '';
  if(roles.length === 0){
    roleList = '*No trait roles configured yet.*\n';
  } else {
    roleList = roles.map((r, i) =>
      `**${i+1}.** <@&${r.roleId}> — ${r.traitType === '_count' ? `Own ${r.minCount}+ tokens` : `${r.traitType}: ${r.traitValue}${r.minCount > 1 ? ` (×${r.minCount})` : ''}`}`
    ).join('\n') + '\n';
  }

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎭 Trait Roles')
    .setDescription(
      stepBar(5, 6) + '\n' + SEP + '\n\n' +
      'Automatically assign roles based on what tokens a member holds.\n\n' +
      '**Configured roles:**\n' + roleList + '\n' +
      '**How it works:**\n' +
      '→ Member verifies → bot checks their tokens & traits\n' +
      '→ Matching roles assigned instantly, re-synced every 24h\n\n' +
      '**Examples:** Own a Zombie → `@Zombie Holder` · Own 20+ → `@Whale`'
    )
    .setFooter({ text: 'Only visible to you — manage trait roles anytime with /config' });
}

function buildSummaryEmbed(state, guild){
  const cfg = state.config;
  const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
  const ch  = id => id ? `<#${id}>` : 'Not set';
  const rol = id => id ? `<@&${id}>` : 'Not set';
  const tick = v => v ? '✅' : '❌';
  const roles = cfg.traitRoles || [];

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Setup Complete!')
    .setDescription(
      SEP + '\n\n' +
      `📦 **Collection:** ${isOcas ? 'On-Chain All Stars 🔥' : (cfg.contractName || 'Custom')} ${tick(cfg.contract)}\n` +
      `🟢 **Sales Channel:** ${ch(cfg.salesChannel)} ${tick(cfg.salesChannel)}\n` +
      `📋 **Listings Channel:** ${ch(cfg.listingsChannel)} ${tick(cfg.listingsChannel)}\n` +
      (isOcas ? `🔥 **Burn Alerts:** ${ch(cfg.burnChannel)} ${tick(cfg.burnChannel)}\n` : '') +
      `📌 **Verification Channel:** ${ch(cfg.verifyChannel)} ${tick(cfg.verifyChannel)}\n` +
      `✅ **Verified Role:** ${rol(cfg.verifyRole)} ${tick(cfg.verifyRole)}\n` +
      `🏆 **Holder Role:** ${cfg.holderRole ? rol(cfg.holderRole) + ' ✅' : '⚪ Not set'}\n` +
      `🎭 **Trait Roles:** ${roles.length} configured\n\n` +
      SEP + '\n' +
      '**What happens next:**\n' +
      '→ Members verify in your verification channel — roles assigned automatically\n' +
      '→ Roles re-sync every 24 hours\n' +
      '→ Run `/setup` or `/config` anytime to change settings\n' +
      '→ Use `/setuptraitrole` to add more trait roles later'
    )
    .setFooter({ text: 'Run /setup to update · /config to manage settings' });
}

// ── Button rows ───────────────────────────────────────────────────────────────
function welcomeRow(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:start').setLabel('🚀 Get Started').setStyle(ButtonStyle.Primary)
  );
}

function collectionRow(hasContract){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:back:1').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:contract').setLabel('📦 Enter Contract').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:step:3').setLabel(hasContract ? 'Next →' : 'Skip →').setStyle(hasContract ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
}

function channelsRow(isOcas){
  const btns = [
    new ButtonBuilder().setCustomId('setup:back:2').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:channel:sales').setLabel('🟢 Sales').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:channel:listings').setLabel('📋 Listings').setStyle(ButtonStyle.Secondary),
  ];
  if(isOcas) btns.push(new ButtonBuilder().setCustomId('setup:channel:burn').setLabel('🔥 Burn Alerts').setStyle(ButtonStyle.Secondary));
  btns.push(new ButtonBuilder().setCustomId('setup:step:4').setLabel('Next →').setStyle(ButtonStyle.Success));
  return new ActionRowBuilder().addComponents(btns);
}

function verificationRow(configured){
  // Max 5 buttons per row — split across two rows
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:verify:channel').setLabel('📌 Set Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:verify:role').setLabel('✅ Verified Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:verify:holderrole').setLabel('🏆 Holder Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:verify:deploy').setLabel('📨 Post to Channel').setStyle(ButtonStyle.Primary).setDisabled(!configured),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:back:3').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:step:5').setLabel('Next →').setStyle(ButtonStyle.Success),
  );
  return [row1, row2];
}

function traitRolesRow(state){
  const roles = state.config.traitRoles || [];
  const rows = [];

  // Add / Next row
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:back:4').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:traitrole:add').setLabel('➕ Add Trait Role').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:step:6').setLabel('Finish →').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
  ));

  // Delete select if roles exist
  if(roles.length > 0){
    const options = roles.map((r, i) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${i+1}. ${r.traitType === '_count' ? `Own ${r.minCount}+ tokens` : `${r.traitType}: ${r.traitValue}`}`)
        .setDescription(`Role: ${r.roleId ? `<@&${r.roleId}>` : (r.roleName||'Unknown')}`)
        .setValue(String(i))
    );
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('setup_traitrole:delete')
        .setPlaceholder('🗑️ Remove a trait role...')
        .addOptions(options)
    ));
  }

  return rows;
}

function summaryRow(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:close').setLabel('Done ✅').setStyle(ButtonStyle.Success),
  );
}

// ── Handlers ──────────────────────────────────────────────────────────────────
async function handleSetupCommand(interaction, ctx){
  await interaction.deferReply({ flags: 64 }); // ephemeral
  const { pgPool } = ctx;
  const guildId = interaction.guildId;
  const state = await loadState(guildId, pgPool);
  state.step = state.step || 1;

  if(state.step > 1 && state.config && Object.keys(state.config).length > 0){
    // Resume — go back to where they were
    return resumeStep(interaction, state, ctx);
  }
  state.step = 1;
  await saveState(guildId, state, pgPool);
  return interaction.editReply({ embeds:[buildWelcomeEmbed()], components:[welcomeRow()] });
}

async function resumeStep(interaction, state, ctx){
  const { pgPool } = ctx;
  const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;
  const step = state.step;
  if(step <= 1) return interaction.editReply({ embeds:[buildWelcomeEmbed()], components:[welcomeRow()] });
  if(step === 2) return interaction.editReply({ embeds:[buildCollectionEmbed(state)], components:[collectionRow(!!state.config.contract)] });
  if(step === 3) return interaction.editReply({ embeds:[buildChannelsEmbed(state)], components:[channelsRow(isOcas)] });
  if(step === 4){ const v = !!(state.config.verifyChannel && state.config.verifyRole); return interaction.editReply({ embeds:[buildVerificationEmbed(state)], components:verificationRow(v) }); }
  if(step === 5) return interaction.editReply({ embeds:[buildTraitRolesEmbed(state)], components:traitRolesRow(state) });
  return interaction.editReply({ embeds:[buildSummaryEmbed(state, interaction.guild)], components:[summaryRow()] });
}

async function handleSetupButton(interaction, ctx){
  const { pgPool, setConfig } = ctx;
  const guildId  = interaction.guildId;
  const customId = interaction.customId;

  // Defer immediately — must happen within 3s or Discord kills the interaction
  // Modals are exempt (showModal is its own response), handle those below
  const isModal = customId === 'setup:contract' || customId === 'setup_traitrole:rolesel';
  if(!isModal) await interaction.deferUpdate();

  const state = await loadState(guildId, pgPool);

  // ── back navigation ────────────────────────────────────────────────────────
  if(customId.startsWith('setup:back:')){
    const backTo = parseInt(customId.split(':')[2]);
    state.step = backTo;
    await saveState(guildId, state, pgPool);
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;
    if(backTo === 1) return interaction.editReply({ content:'', embeds:[buildWelcomeEmbed()], components:[welcomeRow()] });
    if(backTo === 2) return interaction.editReply({ content:'', embeds:[buildCollectionEmbed(state)], components:[collectionRow(!!state.config.contract)] });
    if(backTo === 3) return interaction.editReply({ content:'', embeds:[buildChannelsEmbed(state)], components:[channelsRow(isOcas)] });
    if(backTo === 4){ const v=!!(state.config.verifyChannel&&state.config.verifyRole); return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(state)], components:verificationRow(v) }); }
  }

  // ── step navigation ────────────────────────────────────────────────────────
  if(customId === 'setup:start' || customId.startsWith('setup:step:')){
    const step = customId === 'setup:start' ? 2 : parseInt(customId.split(':')[2]);
    state.step = step;
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;
    await saveState(guildId, state, pgPool);

    if(step === 2) return interaction.editReply({ embeds:[buildCollectionEmbed(state)], components:[collectionRow(!!state.config.contract)] });
    if(step === 3) return interaction.editReply({ embeds:[buildChannelsEmbed(state)], components:[channelsRow(isOcas)] });
    if(step === 4){ const v = !!(state.config.verifyChannel && state.config.verifyRole); return interaction.editReply({ embeds:[buildVerificationEmbed(state)], components:verificationRow(v) }); }
    if(step === 5) return interaction.editReply({ embeds:[buildTraitRolesEmbed(state)], components:traitRolesRow(state) });
    if(step === 6){
      try{
        const sc = state.config;
        // Normalize field names: wizard uses salesChannel/listingsChannel
        // poll.js uses channelId/listingsChannelId — populate both
        const merged = {
          ...sc,
          channelId:         sc.salesChannel    || sc.channelId,
          listingsChannelId: sc.listingsChannel || sc.listingsChannelId,
          slug:              sc.collectionSlug  || sc.slug,
        };
        await setConfig(guildId, merged);

        // Always sync verification_panels with latest roles — no manual re-deploy needed
        try{
          await pgPool.query(
            `INSERT INTO verification_panels (guild_id, channel_id, role_id, holder_role_id, min_tokens, welcome_text)
             VALUES ($1, $2, $3, $4, 0, $5)
             ON CONFLICT (guild_id) DO UPDATE SET
               channel_id    = COALESCE($2, verification_panels.channel_id),
               role_id       = COALESCE($3, verification_panels.role_id),
               holder_role_id= COALESCE($4, verification_panels.holder_role_id)`,
            [guildId, sc.verifyChannel||null, sc.verifyRole||null, sc.holderRole||null,
             'Link your wallet to prove ownership and unlock holder roles.']
          );
        }catch(e){ console.warn('[Setup] panel sync:', e.message); }
      }catch(e){ console.error('[Setup] Save error:', e.message); }
      await clearWizardState(guildId, pgPool);
      return interaction.editReply({ embeds:[buildSummaryEmbed(state, interaction.guild)], components:[summaryRow()] });
    }
  }

  // ── contract modal ─────────────────────────────────────────────────────────
  if(customId === 'setup:contract'){
    const modal = new ModalBuilder().setCustomId('setup_modal:contract').setTitle('Enter Contract Address');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('contract_input').setLabel('NFT Contract Address (0x...)')
        .setStyle(TextInputStyle.Short).setPlaceholder('0x078be86f3104a32313a47815792230a3808642cc')
        .setRequired(true).setMinLength(42).setMaxLength(42)
    ));
    return interaction.showModal(modal);
  }

  // ── channel selectors ──────────────────────────────────────────────────────
  if(customId.startsWith('setup:channel:')){
    const type  = customId.split(':')[2];
    const label = type === 'sales' ? '🟢 Sales' : type === 'listings' ? '📋 Listings' : '🔥 Burn Alerts';
    const menu  = new ChannelSelectMenuBuilder()
      .setCustomId('setup_chsel:'+type).setPlaceholder('Pick the '+label+' channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the '+label+' channel:**', components:[new ActionRowBuilder().addComponents(menu)], embeds:[] });
  }

  // ── verification pickers ───────────────────────────────────────────────────
  if(customId === 'setup:verify:channel'){
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId('setup_chsel:verify').setPlaceholder('Pick the verification channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the verification channel:**', components:[new ActionRowBuilder().addComponents(menu)], embeds:[] });
  }

  if(customId === 'setup:verify:role'){
    const menu = new RoleSelectMenuBuilder().setCustomId('setup_rolesel:verify').setPlaceholder('Pick the ✅ Verified Wallet role');
    return interaction.editReply({ content:'**Select the ✅ Verified Wallet role** (given to anyone who links a wallet):', components:[new ActionRowBuilder().addComponents(menu)], embeds:[] });
  }

  if(customId === 'setup:verify:holderrole'){
    const menu = new RoleSelectMenuBuilder().setCustomId('setup_rolesel:holder').setPlaceholder('Pick the 🏆 Holder role');
    return interaction.editReply({ content:'**Select the 🏆 Holder role** (given to members who hold ≥1 token):', components:[new ActionRowBuilder().addComponents(menu)], embeds:[] });
  }

  if(customId === 'setup:verify:deploy'){
    try{
      const ch = await interaction.guild.channels.fetch(state.config.verifyChannel).catch(()=>null);
      if(!ch) return interaction.editReply({ content:'❌ Could not find verification channel.' });

      const guildName = interaction.guild.name;
      const panelEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🔐 ${guildName} — Verify Ownership`)
        .setDescription(
          'Link your wallet to prove ownership and unlock holder roles.\n\n' +
          '**How it works:**\n' +
          '→ Click the button below\n' +
          '→ Enter your wallet address\n' +
          '→ Add a short code to your OpenSea username\n' +
          '→ Roles are assigned automatically\n\n' +
          '*This bot will never DM you or ask for your seed phrase.*'
        )
        .setThumbnail(interaction.guild.iconURL({ dynamic: true }) || null);

      const startBtn = new ButtonBuilder()
        .setCustomId('start_verification:'+guildId).setLabel('Verify Wallet').setStyle(ButtonStyle.Primary).setEmoji('🔗');

      const msg = await ch.send({ embeds:[panelEmbed], components:[new ActionRowBuilder().addComponents(startBtn)] });
      state.config.verifyMessageId = msg.id;
      await saveState(guildId, state, pgPool);

      await pgPool.query(
        `INSERT INTO verification_panels (guild_id,channel_id,role_id,holder_role_id,min_tokens,message_id,welcome_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id=$2,role_id=$3,holder_role_id=$4,min_tokens=$5,message_id=$6,welcome_text=$7`,
        [guildId, state.config.verifyChannel, state.config.verifyRole||null, state.config.holderRole||null, 0, msg.id, `Link your wallet to prove ownership and unlock holder roles in ${guildName}.`]
      );

      const v = !!(state.config.verifyChannel && state.config.verifyRole);
      return interaction.editReply({ content:'✅ Panel deployed!', embeds:[buildVerificationEmbed(state)], components:verificationRow(v) });
    }catch(e){
      console.error('[Setup] Deploy panel error:', e.message);
      return interaction.editReply({ content:'❌ Failed to deploy panel: '+e.message });
    }
  }

  // ── channel / role select menus ────────────────────────────────────────────
  if(customId.startsWith('setup_chsel:') || customId.startsWith('setup_rolesel:')){
    const type  = customId.split(':')[1];
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;

    if(customId.startsWith('setup_chsel:')){
      const chId = interaction.values[0];
      if(type === 'sales')    state.config.salesChannel    = chId;
      if(type === 'listings') state.config.listingsChannel = chId;
      if(type === 'burn')     state.config.burnChannel     = chId;
      if(type === 'verify')   state.config.verifyChannel   = chId;
      await saveState(guildId, state, pgPool);
      if(type === 'verify'){
        const v = !!(state.config.verifyChannel && state.config.verifyRole);
        return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(state)], components:verificationRow(v) });
      }
      return interaction.editReply({ content:'', embeds:[buildChannelsEmbed(state)], components:[channelsRow(isOcas)] });
    }

    if(customId.startsWith('setup_rolesel:')){
      const roleId = interaction.values[0];
      if(type === 'verify') state.config.verifyRole = roleId;
      if(type === 'holder') state.config.holderRole = roleId;
      await saveState(guildId, state, pgPool);
      const v = !!(state.config.verifyChannel && state.config.verifyRole);
      return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(state)], components:verificationRow(v) });
    }
  }

  // ── trait role: add ────────────────────────────────────────────────────────
  if(customId === 'setup:traitrole:add'){
    const roleMenu = new RoleSelectMenuBuilder()
      .setCustomId('setup_traitrole:rolesel')
      .setPlaceholder('Pick a role to assign...');
    return interaction.editReply({
      content: '**Step 1 of 2 — Pick the Discord role to assign:**',
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(roleMenu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('setup:step:5').setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
  }

  // ── trait role: role selected → open trait fields modal ─────────────────
  if(customId === 'setup_traitrole:rolesel'){
    const roleId = interaction.values[0];
    const role   = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    const modal  = new ModalBuilder()
      .setCustomId('setup_modal:traitrole:'+roleId)
      .setTitle(`Role: ${(role?.name || 'Selected').slice(0, 40)}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_trait_type')
          .setLabel('Trait Category  (use "_count" for token count)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Type   or   Background   or   _count')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_trait_value')
          .setLabel('Trait Value  (leave blank if using _count)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Zombie   or   Gold   or   Human 4')
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_min_count')
          .setLabel('How many tokens needed?  (default: 1)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('1 = own at least one · 5 = own five or more')
          .setRequired(false)
      ),
    );
    return interaction.showModal(modal);
  }

  // ── trait role: delete select ─────────────────────────────────────────────
  if(customId === 'setup_traitrole:delete'){
    const idx = parseInt(interaction.values[0]);
    const roles = state.config.traitRoles || [];
    if(!isNaN(idx) && roles[idx]) roles.splice(idx, 1);
    state.config.traitRoles = roles;
    await saveState(guildId, state, pgPool);
    return interaction.editReply({ content:'', embeds:[buildTraitRolesEmbed(state)], components:traitRolesRow(state) });
  }

  // ── close / skip ───────────────────────────────────────────────────────────
  if(customId === 'setup:close' || customId === 'setup:skip'){
    if(customId === 'setup:close'){
      await clearWizardState(guildId, pgPool);
      return interaction.editReply({ embeds:[], components:[], content:'✅ Setup complete!\n\n→ Run `/setup` anytime to update settings.\n→ Use `/config` to manage channels, roles and collections.' });
    }
    // skip just advances to next step
    const nextStep = (state.step || 5) + 1;
    state.step = nextStep;
    await saveState(guildId, state, pgPool);
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;
    if(nextStep === 6){
      try{
        const sc = state.config;
        const merged = { ...sc, channelId: sc.salesChannel||sc.channelId, listingsChannelId: sc.listingsChannel||sc.listingsChannelId, slug: sc.collectionSlug||sc.slug };
        await setConfig(guildId, merged);

        // Always sync verification_panels with latest roles — no manual re-deploy needed
        try{
          await pgPool.query(
            `INSERT INTO verification_panels (guild_id, channel_id, role_id, holder_role_id, min_tokens, welcome_text)
             VALUES ($1, $2, $3, $4, 0, $5)
             ON CONFLICT (guild_id) DO UPDATE SET
               channel_id    = COALESCE($2, verification_panels.channel_id),
               role_id       = COALESCE($3, verification_panels.role_id),
               holder_role_id= COALESCE($4, verification_panels.holder_role_id)`,
            [guildId, sc.verifyChannel||null, sc.verifyRole||null, sc.holderRole||null,
             'Link your wallet to prove ownership and unlock holder roles.']
          );
        }catch(e){ console.warn('[Setup] panel sync:', e.message); }
      }catch(_){}
      await clearWizardState(guildId, pgPool);
      return interaction.editReply({ embeds:[buildSummaryEmbed(state, interaction.guild)], components:[summaryRow()] });
    }
    return interaction.editReply({ embeds:[buildTraitRolesEmbed(state)], components:traitRolesRow(state) });
  }
}

async function handleSetupModal(interaction, ctx){
  const { pgPool, setConfig } = ctx;
  const guildId  = interaction.guildId;
  const customId = interaction.customId;

  await interaction.deferUpdate();
  const state = await loadState(guildId, pgPool);

  // ── contract address ───────────────────────────────────────────────────────
  if(customId === 'setup_modal:contract'){
    const contract = interaction.fields.getTextInputValue('contract_input').trim().toLowerCase();
    if(!/^0x[0-9a-f]{40}$/i.test(contract))
      return interaction.editReply({ content:'❌ Invalid contract address. Must be 0x followed by 40 hex characters.' });
    state.config.contract = contract;
    const isOcas = contract === OCAS_CONTRACT;
    if(isOcas){
      state.config.contractName   = 'On-Chain All Stars';
      state.config.collectionSlug = OCAS_SLUG;
      state.config.isOcas         = true;
      fetchAndStoreCollectionTraits(OCAS_SLUG, pgPool).catch(()=>{});
    }
    await saveState(guildId, state, pgPool);
    return interaction.editReply({ content:'', embeds:[buildCollectionEmbed(state)], components:[collectionRow(true)] });
  }

  // ── add trait role ─────────────────────────────────────────────────────────
  if(customId.startsWith('setup_modal:traitrole:')){
    const roleId      = customId.split(':')[2];
    const traitTypeRaw = interaction.fields.getTextInputValue('tr_trait_type').trim();
    const traitVal     = interaction.fields.getTextInputValue('tr_trait_value').trim();
    const minCount     = parseInt(interaction.fields.getTextInputValue('tr_min_count').trim()) || 1;
    // If no trait category entered, treat as a token count rule
    const traitType    = traitTypeRaw || '_count';

    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    if(!role)
      return interaction.editReply({ content:'❌ Role not found. Please try again.' });

    if(!state.config.traitRoles) state.config.traitRoles = [];
    state.config.traitRoles.push({
      roleId,
      roleName: role.name,
      traitType,
      traitValue: traitVal || null,
      minCount,
    });
    await saveState(guildId, state, pgPool);

    // Also persist to trait_roles table
    try{
      await pgPool.query(
        `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count) DO NOTHING`,
        [guildId, roleId, traitType, traitVal||'', minCount]
      );
    }catch(e){ console.warn('[Setup] trait_roles insert:', e.message); }

    return interaction.editReply({ content:'', embeds:[buildTraitRolesEmbed(state)], components:traitRolesRow(state) });
  }

  // channel/role selects handled in handleSetupButton
}

const SETUP_COMMANDS = new Set(['setup']);
module.exports = { handleSetupCommand, handleSetupButton, handleSetupModal, SETUP_COMMANDS };
















