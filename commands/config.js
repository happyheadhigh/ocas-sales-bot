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
      `📦 **Collections:** ${(cfg.collections||[]).length + (cfg.contract?1:0)} configured ${ok(cfg.contract||((cfg.collections||[]).length>0))}\n` +
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
      new ButtonBuilder().setCustomId('cfg:cat:collection').setLabel('📦 Collections').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:channels').setLabel('📡 Channels').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:verification').setLabel('🔐 Verification').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:roles').setLabel('🎭 Roles').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Collection screen (multi-collection) ─────────────────────────────────────
function buildCollectionsEmbed(cfg){
  const extras = cfg.collections || [];
  const primary = cfg.contract ? {
    name: cfg.contractName || 'Primary Collection',
    slug: cfg.collectionSlug || '—',
    contract: cfg.contract,
    salesChannel: cfg.channelId,
    listingsChannel: cfg.listingsChannelId,
    isOcas: cfg.contract?.toLowerCase() === OCAS_CONTRACT,
  } : null;

  let desc = SEP + '\n\n';
  if(!primary && extras.length===0){
    desc += '*No collections configured.*\n\nClick **➕ Add Collection** to get started.\n';
  } else {
    if(primary){
      desc += `**1. ${primary.isOcas?'🔥 ':'📦 '}${primary.name}** *(primary)*\n`;
      desc += `> Slug: \`${primary.slug}\`\n`;
      desc += `> Sales: ${primary.salesChannel ? `<#${primary.salesChannel}>` : '`not set`'} · Listings: ${primary.listingsChannel ? `<#${primary.listingsChannel}>` : '`not set`'}\n\n`;
    }
    extras.forEach((col, i) => {
      const n = i + (primary ? 2 : 1);
      desc += `**${n}. 📦 ${col.name||col.slug}**\n`;
      desc += `> Slug: \`${col.slug}\`\n`;
      desc += `> Sales: ${col.salesChannel ? `<#${col.salesChannel}>` : '`not set`'} · Listings: ${col.listingsChannel ? `<#${col.listingsChannel}>` : '`not set`'}\n\n`;
    });
  }
  desc += SEP + '\n*Click a collection to edit, or add a new one.*';

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📦 Collections')
    .setDescription(desc)
    .setFooter({ text: 'Only visible to you' });
}

function collectionsRow(cfg){
  const extras = cfg.collections || [];
  const allCols = [];
  if(cfg.contract) allCols.push({ label: `1. ${cfg.contractName||'Primary'}`, id: 'primary' });
  extras.forEach((col, i) => allCols.push({ label: `${i+2}. ${col.name||col.slug}`, id: String(i) }));

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:col:add').setLabel('➕ Add Collection').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cfg:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];

  if(allCols.length > 0){
    const options = allCols.slice(0,25).map(c =>
      new StringSelectMenuOptionBuilder().setLabel(c.label).setValue(c.id)
    );
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cfg_col:select')
        .setPlaceholder('✏️ Edit a collection...')
        .addOptions(options)
    ));
  }
  return rows;
}

// Single collection edit embed
function buildCollectionEditEmbed(col, isPrimary){
  const isOcas = col.contract?.toLowerCase() === OCAS_CONTRACT;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📦 Edit: ${col.name || col.slug || 'Collection'}${isPrimary?' *(primary)*':''}`)
    .setDescription(
      SEP + '\n\n' +
      `**Contract:** ${col.contract ? `\`${col.contract}\`` : '`Not set`'} ${ok(col.contract)}\n` +
      `**Slug:** \`${col.slug || 'Not set'}\`\n` +
      `**Sales Channel:** ${col.salesChannel ? `<#${col.salesChannel}>` : '`Not set`'} ${ok(col.salesChannel)}\n` +
      `**Listings Channel:** ${col.listingsChannel ? `<#${col.listingsChannel}>` : '`Not set`'} ${ok(col.listingsChannel)}\n` +
      (isOcas ? '\n🔥 **OCAS** — full feature set active.\n' : '') +
      '\n*Changes save immediately.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function collectionEditRow(colId, isPrimary){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:col:contract:${colId}`).setLabel('📝 Contract').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:col:slug:${colId}`).setLabel('🔗 Slug').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:col:saleschan:${colId}`).setLabel('🟢 Sales Ch.').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:col:listchan:${colId}`).setLabel('📋 Listings Ch.').setStyle(ButtonStyle.Secondary),
      ...(!isPrimary ? [new ButtonBuilder().setCustomId(`cfg:col:remove:${colId}`).setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger)] : []),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:cat:collection').setLabel('← Collections').setStyle(ButtonStyle.Secondary),
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

  // Modals open with showModal (their own response) — everything else defers first
  const isModal = customId === 'cfg:col:contract' || customId === 'cfg:col:slug' ||
                  customId === 'cfg:col:add' || customId === 'cfg:role:add' ||
                  customId.startsWith('cfg:col:contract:') || customId.startsWith('cfg:col:slug:');
  if(!isModal) await interaction.deferUpdate();

  const cfg = getConfig(guildId) || {};

  const traitRolesQ = () => pgPool.query(
    'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
    [guildId]
  ).catch(()=>({ rows:[] }));

  // ── Back to dashboard ──────────────────────────────────────────────────────
  if(customId === 'cfg:back'){
    const trRes = await traitRolesQ();
    return interaction.editReply({
      content: '',
      embeds: [buildDashboardEmbed(cfg, trRes.rows)],
      components: dashboardRow(),
    });
  }

  // ── Category navigation ────────────────────────────────────────────────────
  if(customId === 'cfg:cat:collection'){
    return interaction.editReply({ content:'', embeds:[buildCollectionsEmbed(cfg)], components:collectionsRow(cfg) });
  }

  // Select a collection to edit
  if(customId === 'cfg_col:select'){
    const colId = interaction.values[0];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { contract: cfg.contract, slug: cfg.collectionSlug, name: cfg.contractName, salesChannel: cfg.channelId, listingsChannel: cfg.listingsChannelId }
      : (cfg.collections||[])[parseInt(colId)];
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });
    return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary)], components:collectionEditRow(colId, isPrimary) });
  }

  // Add collection button
  if(customId === 'cfg:col:add'){
    const modal = new ModalBuilder().setCustomId('cfg_modal:addcol').setTitle('Add Collection');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('col_name').setLabel('Collection Name').setStyle(TextInputStyle.Short).setPlaceholder('My NFT Project').setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('col_slug').setLabel('OpenSea Slug').setStyle(TextInputStyle.Short).setPlaceholder('my-nft-project').setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('col_contract').setLabel('Contract Address (0x...)').setStyle(TextInputStyle.Short).setPlaceholder('0x...').setRequired(false).setMinLength(0).setMaxLength(42)
      ),
    );
    return interaction.showModal(modal);
  }

  // Edit collection contract/slug via modal
  if(customId.startsWith('cfg:col:contract:') || customId.startsWith('cfg:col:slug:')){
    const parts = customId.split(':');
    const field = parts[2]; // 'contract' or 'slug'
    const colId = parts[3];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { contract: cfg.contract, slug: cfg.collectionSlug, name: cfg.contractName }
      : (cfg.collections||[])[parseInt(colId)];
    const modal = new ModalBuilder().setCustomId(`cfg_modal:editcol:${field}:${colId}`).setTitle(`Edit ${field==='contract'?'Contract':'Slug'}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      (() => {
        const ti = new TextInputBuilder().setCustomId('value_input')
          .setLabel(field==='contract' ? 'Contract Address (0x...)' : 'OpenSea Slug')
          .setStyle(TextInputStyle.Short)
          .setValue(field==='contract' ? (col?.contract||'') : (col?.slug||''))
          .setRequired(true);
        if(field==='contract'){ ti.setMinLength(42); ti.setMaxLength(42); }
        return ti;
      })()
    ));
    return interaction.showModal(modal);
  }

  // Edit collection channels (show channel select)
  if(customId.startsWith('cfg:col:saleschan:') || customId.startsWith('cfg:col:listchan:')){
    const parts = customId.split(':');
    const field = parts[2]; // 'saleschan' or 'listchan'
    const colId = parts[3];
    const label = field==='saleschan' ? '🟢 Sales' : '📋 Listings';
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(`cfg_chsel:col:${field}:${colId}`)
      .setPlaceholder(`Pick the ${label} channel`)
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:`**Select the ${label} channel:**`, embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }

  // Remove extra collection
  if(customId.startsWith('cfg:col:remove:')){
    const colId = parseInt(customId.split(':')[3]);
    if(!isNaN(colId)){
      const cols = cfg.collections || [];
      cols.splice(colId, 1);
      cfg.collections = cols;
      await setConfig(guildId, cfg);
    }
    return interaction.editReply({ content:'✅ Collection removed.', embeds:[buildCollectionsEmbed(cfg)], components:collectionsRow(cfg) });
  }
  if(customId === 'cfg:cat:channels'){
    const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
    return interaction.editReply({ content:'', embeds:[buildChannelsEmbed(cfg)], components:channelsRow(isOcas) });
  }
  if(customId === 'cfg:cat:verification'){
    return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(cfg)], components:verificationRow(cfg) });
  }
  if(customId === 'cfg:cat:roles'){
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
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId('cfg_chsel:verify')
      .setPlaceholder('Pick the verification channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the verification channel:**', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }
  if(customId === 'cfg:ver:role'){
    const menu = new RoleSelectMenuBuilder().setCustomId('cfg_rolesel:verify').setPlaceholder('Pick the ✅ Verified Wallet role');
    return interaction.editReply({ content:'**Select the ✅ Verified Wallet role:**', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }
  if(customId === 'cfg:ver:holder'){
    const menu = new RoleSelectMenuBuilder().setCustomId('cfg_rolesel:holder').setPlaceholder('Pick the 🏆 Holder role');
    return interaction.editReply({ content:'**Select the 🏆 Holder role:**', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }
  if(customId === 'cfg:ver:deploy'){
    try{
      const verCh = await interaction.guild.channels.fetch(cfg.verifyChannel).catch(()=>null);
      if(!verCh) return interaction.editReply({ content:'❌ Verification channel not found. Set it first.' });

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
        .setCustomId('start_verification:'+guildId)
        .setLabel('Verify Wallet').setStyle(ButtonStyle.Primary).setEmoji('🔗');

      const msg = await verCh.send({ embeds:[panelEmbed], components:[new ActionRowBuilder().addComponents(startBtn)] });
      cfg.verifyMessageId = msg.id;
      await setConfig(guildId, cfg);

      await pgPool.query(
        `INSERT INTO verification_panels (guild_id,channel_id,role_id,holder_role_id,min_tokens,message_id,welcome_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id=$2,role_id=$3,holder_role_id=$4,min_tokens=$5,message_id=$6,welcome_text=$7`,
        [guildId, cfg.verifyChannel, cfg.verifyRole||null, cfg.holderRole||null, 0, msg.id, `Link your wallet to prove ownership and unlock holder roles in ${guildName}.`]
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
    const rowId = parseInt(interaction.values[0]);
    await pgPool.query('DELETE FROM trait_roles WHERE id=$1 AND guild_id=$2', [rowId, guildId]).catch(()=>{});
    const trRes = await traitRolesQ();
    return interaction.editReply({ content:'', embeds:[buildRolesEmbed(trRes.rows)], components:rolesRow(trRes.rows) });
  }

  // ── Channel select menus ───────────────────────────────────────────────────
  if(customId.startsWith('cfg_chsel:')){
    const parts = customId.split(':');
    const chId = interaction.values[0];

    // Collection channel edit: cfg_chsel:col:saleschan|listchan:colId
    if(parts[1] === 'col'){
      const field = parts[2]; // saleschan or listchan
      const colId = parts[3];
      const isPrimary = colId === 'primary';
      if(isPrimary){
        if(field==='saleschan')  cfg.channelId         = chId;
        if(field==='listchan')   cfg.listingsChannelId = chId;
      } else {
        const idx = parseInt(colId);
        if(!cfg.collections) cfg.collections = [];
        if(cfg.collections[idx]){
          if(field==='saleschan')  cfg.collections[idx].salesChannel    = chId;
          if(field==='listchan')   cfg.collections[idx].listingsChannel = chId;
        }
      }
      await setConfig(guildId, cfg);
      const col = isPrimary
        ? { contract:cfg.contract, slug:cfg.collectionSlug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId }
        : cfg.collections[parseInt(colId)];
      return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary)], components:collectionEditRow(colId, isPrimary) });
    }

    // Standard channel edit
    const type = parts[1];
    if(type === 'sales')    { cfg.salesChannel = chId; cfg.channelId = chId; }
    if(type === 'listings') { cfg.listingsChannel = chId; cfg.listingsChannelId = chId; }
    if(type === 'burn')     cfg.burnChannel    = chId;
    if(type === 'verify')   cfg.verifyChannel  = chId;
    await setConfig(guildId, cfg);
    if(type === 'verify'){
      return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(cfg)], components:verificationRow(cfg) });
    }
    const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
    return interaction.editReply({ content:'', embeds:[buildChannelsEmbed(cfg)], components:channelsRow(isOcas) });
  }

  // ── Role select menus ──────────────────────────────────────────────────────
  if(customId.startsWith('cfg_rolesel:')){
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
  const customId = interaction.customId;

  await interaction.deferUpdate();
  const cfg = getConfig(guildId) || {};

  // ── Add collection ─────────────────────────────────────────────────────────
  if(customId === 'cfg_modal:addcol'){
    const name     = interaction.fields.getTextInputValue('col_name').trim();
    const slug     = interaction.fields.getTextInputValue('col_slug').trim().toLowerCase();
    const contract = interaction.fields.getTextInputValue('col_contract').trim().toLowerCase();
    if(!cfg.collections) cfg.collections = [];
    cfg.collections.push({ name, slug, contract:contract||null, salesChannel:null, listingsChannel:null });
    await setConfig(guildId, cfg);
    return interaction.editReply({ content:'✅ Collection added.', embeds:[buildCollectionsEmbed(cfg)], components:collectionsRow(cfg) });
  }

  // ── Edit collection field (contract or slug) ───────────────────────────────
  if(customId.startsWith('cfg_modal:editcol:')){
    const parts = customId.split(':'); // cfg_modal editcol field colId
    const field = parts[2];
    const colId = parts[3];
    const val   = interaction.fields.getTextInputValue('value_input').trim();
    const isPrimary = colId === 'primary';

    if(isPrimary){
      if(field==='contract'){
        const c = val.toLowerCase();
        if(!/^0x[0-9a-f]{40}$/i.test(c)) return interaction.editReply({ content:'❌ Invalid contract address.' });
        cfg.contract = c;
        if(c === OCAS_CONTRACT){ cfg.contractName='On-Chain All Stars'; cfg.collectionSlug=OCAS_SLUG; cfg.isOcas=true; }
        else cfg.isOcas=false;
      }
      if(field==='slug') cfg.collectionSlug = val.toLowerCase();
    } else {
      const idx = parseInt(colId);
      if(!cfg.collections?.[idx]) return interaction.editReply({ content:'❌ Collection not found.' });
      if(field==='contract'){
        const c = val.toLowerCase();
        if(!/^0x[0-9a-f]{40}$/i.test(c)) return interaction.editReply({ content:'❌ Invalid contract address.' });
        cfg.collections[idx].contract = c;
      }
      if(field==='slug') cfg.collections[idx].slug = val.toLowerCase();
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { contract:cfg.contract, slug:cfg.collectionSlug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId }
      : cfg.collections[parseInt(colId)];
    return interaction.editReply({ content:'✅ Updated.', embeds:[buildCollectionEditEmbed(col, isPrimary)], components:collectionEditRow(colId, isPrimary) });
  }

  // ── Add trait role ─────────────────────────────────────────────────────────
  if(customId === 'cfg_modal:traitrole'){
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



