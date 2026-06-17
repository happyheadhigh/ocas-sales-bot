'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ChannelType,
} = require('discord.js');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const OCAS_SLUG     = 'on-chain-all-stars';
const SEP           = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

// ── Helpers ───────────────────────────────────────────────────────────────────
const ch  = id => id ? `<#${id}>` : '`Not set`';
const rol = id => id ? `<@&${id}>` : '`Not set`';
const ok  = v  => v  ? '✅' : '❌';

// ── Main dashboard embed ──────────────────────────────────────────────────────
function buildDashboardEmbed(cfg, traitRoles){
  const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
  const tCount = traitRoles.length;

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⚙️ Server Configuration')
    .setDescription(
      SEP + '\n\n' +
      `📦 **Collection:** ${cfg.contractName || (cfg.contract ? `\`${cfg.contract.slice(0,10)}...\`` : '`Not set`')} ${ok(cfg.contract)}\n` +
      `🟢 **Sales:** ${ch(cfg.salesChannel)} ${ok(cfg.salesChannel)}\n` +
      `📋 **Listings:** ${ch(cfg.listingsChannel)} ${ok(cfg.listingsChannel)}\n` +
      (isOcas ? `🔥 **Burn Alerts:** ${ch(cfg.burnChannel)} ${ok(cfg.burnChannel)}\n` : '') +
      `📌 **Verification:** ${ch(cfg.verifyChannel)} ${ok(cfg.verifyChannel)}\n` +
      `✅ **Verified Role:** ${rol(cfg.verifyRole)} ${ok(cfg.verifyRole)}\n` +
      `🏆 **Holder Role:** ${cfg.holderRole ? rol(cfg.holderRole) + ' ✅' : '`Not set` ⚪'}\n` +
      `🎭 **Trait Roles:** ${tCount} configured\n\n` +
      SEP + '\n' +
      '*Select a category below to edit.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function dashboardRow(){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:cat:collection').setLabel('📦 Collection').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:channels').setLabel('📡 Channels').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:verification').setLabel('🔐 Verification').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:roles').setLabel('🎭 Roles').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Collection screen ─────────────────────────────────────────────────────────
function buildCollectionEmbed(cfg){
  const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📦 Collection')
    .setDescription(
      SEP + '\n\n' +
      `**Contract:** ${cfg.contract ? `\`${cfg.contract}\`` : '`Not set`'} ${ok(cfg.contract)}\n` +
      `**Name:** ${cfg.contractName || '`Unknown`'}\n` +
      `**Slug:** \`${cfg.collectionSlug || 'Not set'}\`\n` +
      (isOcas ? '\n🔥 **OCAS detected** — full feature set active.\n' : '') +
      '\n*Change the contract address to switch collections.\nThe slug is used for OpenSea listing lookups.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function collectionRow(hasCfg){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:col:contract').setLabel('📝 Edit Contract').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cfg:col:slug').setLabel('🔗 Edit Slug').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Channels screen ───────────────────────────────────────────────────────────
function buildChannelsEmbed(cfg){
  const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📡 Alert Channels')
    .setDescription(
      SEP + '\n\n' +
      `🟢 **Sales:** ${ch(cfg.salesChannel)} ${ok(cfg.salesChannel)}\n` +
      `📋 **Listings:** ${ch(cfg.listingsChannel)} ${ok(cfg.listingsChannel)}\n` +
      (isOcas ? `🔥 **Burn Alerts:** ${ch(cfg.burnChannel)} ${ok(cfg.burnChannel)}\n` : '') +
      '\n*Click a button to change that channel.\nLeave a channel unset to disable those alerts.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function channelsRow(isOcas){
  const btns = [
    new ButtonBuilder().setCustomId('cfg:ch:sales').setLabel('🟢 Sales').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:ch:listings').setLabel('📋 Listings').setStyle(ButtonStyle.Secondary),
  ];
  if(isOcas) btns.push(new ButtonBuilder().setCustomId('cfg:ch:burn').setLabel('🔥 Burn Alerts').setStyle(ButtonStyle.Secondary));
  btns.push(new ButtonBuilder().setCustomId('cfg:back').setLabel('← Back').setStyle(ButtonStyle.Secondary));
  return [new ActionRowBuilder().addComponents(btns)];
}

// ── Verification screen ───────────────────────────────────────────────────────
function buildVerificationEmbed(cfg){
  const deployed = !!cfg.verifyMessageId;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔐 Wallet Verification')
    .setDescription(
      SEP + '\n\n' +
      `📌 **Channel:** ${ch(cfg.verifyChannel)} ${ok(cfg.verifyChannel)}\n` +
      `✅ **Verified Role:** ${rol(cfg.verifyRole)} ${ok(cfg.verifyRole)}\n` +
      `🏆 **Holder Role:** ${cfg.holderRole ? rol(cfg.holderRole) + ' ✅' : '`Not set` ⚪'}\n` +
      `🚦 **Panel status:** ${deployed ? '✅ Deployed' : '❌ Not deployed'}\n\n` +
      '*Any member who verifies gets the Verified role.\nMembers holding ≥1 token also get the Holder role.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function verificationRow(cfg){
  const canDeploy = !!(cfg.verifyChannel && cfg.verifyRole);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:ver:channel').setLabel('📌 Channel').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:ver:role').setLabel('✅ Verified Role').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:ver:holder').setLabel('🏆 Holder Role').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:ver:deploy').setLabel('📨 Re-deploy Panel').setStyle(ButtonStyle.Primary).setDisabled(!canDeploy),
      new ButtonBuilder().setCustomId('cfg:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Roles screen ──────────────────────────────────────────────────────────────
function buildRolesEmbed(traitRoles){
  const list = traitRoles.length === 0
    ? '*No trait roles configured yet.*'
    : traitRoles.map((r, i) =>
        `**${i+1}.** <@&${r.role_id}> — ` +
        (r.trait_type === '_count'
          ? `Own ${r.minimum_count}+ tokens`
          : `${r.trait_type}: ${r.trait_value || 'any'}${r.minimum_count > 1 ? ` ×${r.minimum_count}` : ''}`)
      ).join('\n');

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎭 Trait Roles')
    .setDescription(
      SEP + '\n\n' +
      list + '\n\n' +
      '*Roles are assigned automatically when a member verifies\nand re-synced every 24 hours.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function rolesRow(traitRoles){
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:role:add').setLabel('➕ Add Trait Role').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cfg:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
  if(traitRoles.length > 0){
    const options = traitRoles.slice(0, 25).map((r, i) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${i+1}. ${r.trait_type === '_count' ? `Own ${r.minimum_count}+ tokens` : `${r.trait_type}: ${r.trait_value || 'any'}`}`)
        .setDescription(`Role ID: ${r.role_id}`)
        .setValue(`${r.id}`)
    );
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cfg_role:delete')
        .setPlaceholder('🗑️ Remove a trait role...')
        .addOptions(options)
    ));
  }
  return rows;
}

// ── Main handler ──────────────────────────────────────────────────────────────
async function handleConfigCommand(interaction, ctx){
  await interaction.deferReply({ flags: 64 });
  const { pgPool, getConfig } = ctx;
  const cfg = getConfig(interaction.guildId) || {};
  const trRes = await pgPool.query(
    'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
    [interaction.guildId]
  ).catch(()=>({ rows:[] }));
  return interaction.editReply({
    embeds: [buildDashboardEmbed(cfg, trRes.rows)],
    components: dashboardRow(),
  });
}

async function handleConfigButton(interaction, ctx){
  const { pgPool, getConfig, setConfig } = ctx;
  const guildId  = interaction.guildId;
  const customId = interaction.customId;
  const cfg      = getConfig(guildId) || {};

  const traitRolesQ = () => pgPool.query(
    'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
    [guildId]
  ).catch(()=>({ rows:[] }));

  // ── Back to dashboard ──────────────────────────────────────────────────────
  if(customId === 'cfg:back'){
    await interaction.deferUpdate();
    const trRes = await traitRolesQ();
    return interaction.editReply({
      content: '',
      embeds: [buildDashboardEmbed(cfg, trRes.rows)],
      components: dashboardRow(),
    });
  }

  // ── Category navigation ────────────────────────────────────────────────────
  if(customId === 'cfg:cat:collection'){
    await interaction.deferUpdate();
    return interaction.editReply({ content:'', embeds:[buildCollectionEmbed(cfg)], components:collectionRow(!!cfg.contract) });
  }
  if(customId === 'cfg:cat:channels'){
    await interaction.deferUpdate();
    const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
    return interaction.editReply({ content:'', embeds:[buildChannelsEmbed(cfg)], components:channelsRow(isOcas) });
  }
  if(customId === 'cfg:cat:verification'){
    await interaction.deferUpdate();
    return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(cfg)], components:verificationRow(cfg) });
  }
  if(customId === 'cfg:cat:roles'){
    await interaction.deferUpdate();
    const trRes = await traitRolesQ();
    return interaction.editReply({ content:'', embeds:[buildRolesEmbed(trRes.rows)], components:rolesRow(trRes.rows) });
  }

  // ── Collection edits ───────────────────────────────────────────────────────
  if(customId === 'cfg:col:contract'){
    const modal = new ModalBuilder().setCustomId('cfg_modal:contract').setTitle('Edit Contract Address');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('contract_input')
        .setLabel('NFT Contract Address (0x...)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('0x078be86f3104a32313a47815792230a3808642cc')
        .setValue(cfg.contract || '')
        .setRequired(true).setMinLength(42).setMaxLength(42)
    ));
    return interaction.showModal(modal);
  }
  if(customId === 'cfg:col:slug'){
    const modal = new ModalBuilder().setCustomId('cfg_modal:slug').setTitle('Edit Collection Slug');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('slug_input')
        .setLabel('OpenSea Collection Slug')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('on-chain-all-stars')
        .setValue(cfg.collectionSlug || '')
        .setRequired(true)
    ));
    return interaction.showModal(modal);
  }

  // ── Channel edits (show channel select menu) ───────────────────────────────
  if(customId.startsWith('cfg:ch:')){
    await interaction.deferUpdate();
    const type  = customId.split(':')[2];
    const label = type === 'sales' ? '🟢 Sales' : type === 'listings' ? '📋 Listings' : '🔥 Burn Alerts';
    const menu  = new ChannelSelectMenuBuilder()
      .setCustomId('cfg_chsel:'+type)
      .setPlaceholder('Pick the '+label+' channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:`**Select the ${label} channel:**`, embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }

  // ── Verification edits ─────────────────────────────────────────────────────
  if(customId === 'cfg:ver:channel'){
    await interaction.deferUpdate();
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId('cfg_chsel:verify')
      .setPlaceholder('Pick the verification channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the verification channel:**', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }
  if(customId === 'cfg:ver:role'){
    await interaction.deferUpdate();
    const menu = new RoleSelectMenuBuilder().setCustomId('cfg_rolesel:verify').setPlaceholder('Pick the ✅ Verified Wallet role');
    return interaction.editReply({ content:'**Select the ✅ Verified Wallet role:**', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }
  if(customId === 'cfg:ver:holder'){
    await interaction.deferUpdate();
    const menu = new RoleSelectMenuBuilder().setCustomId('cfg_rolesel:holder').setPlaceholder('Pick the 🏆 Holder role');
    return interaction.editReply({ content:'**Select the 🏆 Holder role:**', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }
  if(customId === 'cfg:ver:deploy'){
    await interaction.deferUpdate();
    try{
      const verCh = await interaction.guild.channels.fetch(cfg.verifyChannel).catch(()=>null);
      if(!verCh) return interaction.editReply({ content:'❌ Verification channel not found. Set it first.' });

      const panelEmbed = new EmbedBuilder()
        .setColor(0x5865F2).setTitle('🔐 Wallet Verification')
        .setDescription('Link your wallet to unlock holder roles and access.\n\nClick **Start Verification** below to get started.');
      const startBtn = new ButtonBuilder()
        .setCustomId('start_verification:'+guildId)
        .setLabel('Start Verification').setStyle(ButtonStyle.Primary).setEmoji('🔗');

      const msg = await verCh.send({ embeds:[panelEmbed], components:[new ActionRowBuilder().addComponents(startBtn)] });
      cfg.verifyMessageId = msg.id;
      await setConfig(guildId, cfg);

      await pgPool.query(
        `INSERT INTO verification_panels (guild_id,channel_id,role_id,holder_role_id,min_tokens,message_id,welcome_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id=$2,role_id=$3,holder_role_id=$4,min_tokens=$5,message_id=$6,welcome_text=$7`,
        [guildId, cfg.verifyChannel, cfg.verifyRole||null, cfg.holderRole||null, 0, msg.id, 'Link your wallet to unlock holder roles and access.']
      );
      return interaction.editReply({ content:'✅ Verification panel posted!', embeds:[buildVerificationEmbed(cfg)], components:verificationRow(cfg) });
    }catch(e){
      return interaction.editReply({ content:'❌ Failed: '+e.message });
    }
  }

  // ── Roles: add ─────────────────────────────────────────────────────────────
  if(customId === 'cfg:role:add'){
    const modal = new ModalBuilder().setCustomId('cfg_modal:traitrole').setTitle('Add Trait Role');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_role_id').setLabel('Role ID (right-click role → Copy ID)')
          .setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678').setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_trait_type').setLabel('Trait Type  (or "_count" for token count)')
          .setStyle(TextInputStyle.Short).setPlaceholder('Type   or   _count').setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_trait_value').setLabel('Trait Value  (leave blank if using _count)')
          .setStyle(TextInputStyle.Short).setPlaceholder('Zombie').setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_min_count').setLabel('Min token/trait count  (default: 1)')
          .setStyle(TextInputStyle.Short).setPlaceholder('1').setRequired(false)
      ),
    );
    return interaction.showModal(modal);
  }

  // ── Roles: delete select ───────────────────────────────────────────────────
  if(customId === 'cfg_role:delete'){
    await interaction.deferUpdate();
    const rowId = parseInt(interaction.values[0]);
    await pgPool.query('DELETE FROM trait_roles WHERE id=$1 AND guild_id=$2', [rowId, guildId]).catch(()=>{});
    const trRes = await traitRolesQ();
    return interaction.editReply({ content:'', embeds:[buildRolesEmbed(trRes.rows)], components:rolesRow(trRes.rows) });
  }

  // ── Channel select menus ───────────────────────────────────────────────────
  if(customId.startsWith('cfg_chsel:')){
    await interaction.deferUpdate();
    const type = customId.split(':')[1];
    const chId = interaction.values[0];
    if(type === 'sales')    cfg.salesChannel    = chId;
    if(type === 'listings') cfg.listingsChannel = chId;
    if(type === 'burn')     cfg.burnChannel     = chId;
    if(type === 'verify')   cfg.verifyChannel   = chId;
    await setConfig(guildId, cfg);
    if(type === 'verify'){
      return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(cfg)], components:verificationRow(cfg) });
    }
    const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
    return interaction.editReply({ content:'', embeds:[buildChannelsEmbed(cfg)], components:channelsRow(isOcas) });
  }

  // ── Role select menus ──────────────────────────────────────────────────────
  if(customId.startsWith('cfg_rolesel:')){
    await interaction.deferUpdate();
    const type   = customId.split(':')[1];
    const roleId = interaction.values[0];
    if(type === 'verify') cfg.verifyRole = roleId;
    if(type === 'holder') cfg.holderRole = roleId;
    await setConfig(guildId, cfg);
    return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(cfg)], components:verificationRow(cfg) });
  }
}

async function handleConfigModal(interaction, ctx){
  const { pgPool, getConfig, setConfig } = ctx;
  const guildId  = interaction.guildId;
  const cfg      = getConfig(guildId) || {};
  const customId = interaction.customId;

  // ── Contract ───────────────────────────────────────────────────────────────
  if(customId === 'cfg_modal:contract'){
    await interaction.deferUpdate();
    const contract = interaction.fields.getTextInputValue('contract_input').trim().toLowerCase();
    if(!/^0x[0-9a-f]{40}$/i.test(contract))
      return interaction.editReply({ content:'❌ Invalid contract address.' });
    cfg.contract = contract;
    const isOcas = contract === OCAS_CONTRACT;
    if(isOcas){
      cfg.contractName   = 'On-Chain All Stars';
      cfg.collectionSlug = OCAS_SLUG;
      cfg.isOcas         = true;
    } else {
      cfg.isOcas = false;
    }
    await setConfig(guildId, cfg);
    return interaction.editReply({ content:'', embeds:[buildCollectionEmbed(cfg)], components:collectionRow(true) });
  }

  // ── Slug ───────────────────────────────────────────────────────────────────
  if(customId === 'cfg_modal:slug'){
    await interaction.deferUpdate();
    cfg.collectionSlug = interaction.fields.getTextInputValue('slug_input').trim().toLowerCase();
    await setConfig(guildId, cfg);
    return interaction.editReply({ content:'✅ Slug updated.', embeds:[buildCollectionEmbed(cfg)], components:collectionRow(true) });
  }

  // ── Add trait role ─────────────────────────────────────────────────────────
  if(customId === 'cfg_modal:traitrole'){
    await interaction.deferUpdate();
    const roleId    = interaction.fields.getTextInputValue('tr_role_id').trim();
    const traitType = interaction.fields.getTextInputValue('tr_trait_type').trim();
    const traitVal  = interaction.fields.getTextInputValue('tr_trait_value').trim();
    const minCount  = parseInt(interaction.fields.getTextInputValue('tr_min_count').trim()) || 1;

    if(!/^\d{17,20}$/.test(roleId))
      return interaction.editReply({ content:'❌ Invalid Role ID. Right-click a role → Copy ID.' });
    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    if(!role)
      return interaction.editReply({ content:'❌ Role not found in this server.' });

    await pgPool.query(
      `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (guild_id, trait_type, trait_value, role_id, minimum_count) DO NOTHING`,
      [guildId, roleId, traitType, traitVal||'', minCount]
    ).catch(e => console.warn('[Config] trait_roles insert:', e.message));

    const trRes = await pgPool.query(
      'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
      [guildId]
    ).catch(()=>({ rows:[] }));

    return interaction.editReply({ content:'✅ Trait role added.', embeds:[buildRolesEmbed(trRes.rows)], components:rolesRow(trRes.rows) });
  }
}

const CONFIG_COMMANDS = new Set(['config']);
module.exports = { handleConfigCommand, handleConfigButton, handleConfigModal, CONFIG_COMMANDS };
