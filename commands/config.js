'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ChannelType, PermissionFlagsBits, MessageFlags,
} = require('discord.js');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const { OWNER_DISCORD_IDS } = require('../lib/constants');
const { STACKERS_SLUG } = require('../lib/stackers');
const { isPaidFeature } = require('./market');
const { buildRolePickerRows } = require('../lib/role-picker');
const { initSession: initValuePicker, getSession: getValuePickerSession, clearSession: clearValuePicker, buildStackedValuePickerRows, recordMenuSelection, parseValuePickerCustomId } = require('../lib/value-picker');

// ── Access control ────────────────────────────────────────────────────────────
// /config is gated to: server members with Manage Server permission, OR a
// guild-configured "Bot Manager" role (cfg.botManagerRoleId). This is checked
// in code on every entry point (slash command, button, select menu, modal) —
// not just at slash-command registration — since Discord lets server admins
// loosen a bot's default command permissions via Integrations settings without
// the bot owner knowing, so the registration-level permission alone isn't safe.
function hasConfigAccess(interaction, cfg){
  if(OWNER_DISCORD_IDS.has(String(interaction.user.id))) return true;
  if(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const managerRoleId = cfg?.botManagerRoleId;
  if(managerRoleId && interaction.member?.roles?.cache?.has(managerRoleId)) return true;
  return false;
}

const NO_ACCESS_MSG = '🔒 You need **Manage Server** permission or the designated Bot Manager role to use this.';

// ── Fetch & cache traits from OpenSea for a collection slug ──────────────────
// Canonical implementation lives in lib/db.js (includes dedup check).
const { fetchAndStoreCollectionTraits } = require('../lib/db');

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
      `🟢 **Sales:** ${ch(cfg.salesChannel||cfg.channelId)} ${ok(cfg.salesChannel||cfg.channelId)}\n` +
      `📋 **Listings:** ${ch(cfg.listingsChannel||cfg.listingsChannelId)} ${ok(cfg.listingsChannel||cfg.listingsChannelId)}\n` +
      (isOcas ? `🔥 **Burn Alerts:** ${ch(cfg.burnChannel)} ${ok(cfg.burnChannel)}\n` : '') +
      `📌 **Verification:** ${ch(cfg.verifyChannel)} ${ok(cfg.verifyChannel)}\n` +
      `✅ **Verified Role:** ${rol(cfg.verifyRole)} ${ok(cfg.verifyRole)}\n` +
      `🏆 **Holder Role:** ${cfg.holderRole ? rol(cfg.holderRole) + ' ✅' : '`Not set` ⚪'}\n` +
      `🎭 **Trait Roles:** ${tCount} configured\n` +
      `\n\n` +
      SEP + '\n' +
      '*Select a category below to edit.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function dashboardRow(cfg={}){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:cat:collection').setLabel('📦 Collections').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:channels').setLabel('📡 Channels').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:verification').setLabel('🔐 Verification').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:roles').setLabel('🎭 Roles').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:cat:access').setLabel('🛡️ Access').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:lotteries').setLabel('🎰 Lotteries').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:nickname').setLabel('🏷️ Bot Nickname').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:embedstyle').setLabel('🖼️ Embed Style').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Access (Bot Manager role) screen ──────────────────────────────────────────
function buildAccessEmbed(cfg){
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🛡️ Bot Access')
    .setDescription(
      SEP + '\n\n' +
      '**Manage Server** permission always has access to `/config`.\n\n' +
      `**Bot Manager Role:** ${cfg.botManagerRoleId ? `<@&${cfg.botManagerRoleId}>` : '*Not set*'}\n\n` +
      '*Members with this role can also use `/config`, even without\nManage Server permission — useful for delegating bot management.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function accessRow(cfg){
  const hasRole = !!cfg.botManagerRoleId;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:access:set').setLabel(hasRole ? '✏️ Change Role' : '➕ Set Bot Manager Role').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cfg:access:clear').setLabel('🗑️ Clear').setStyle(ButtonStyle.Danger).setDisabled(!hasRole),
      new ButtonBuilder().setCustomId('cfg:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Bot Nickname screen ────────────────────────────────────────────────────────
// Nickname state lives entirely in Discord itself (the guild member object),
// not in the bot's own config DB — read live each time rather than trying to
// keep a separate copy in sync.
function buildNicknameEmbed(currentNickname){
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🏷️ Bot Nickname')
    .setDescription(
      SEP + '\n\n' +
      `**Current Nickname:** ${currentNickname ? currentNickname : '*Default (bot\'s regular name)*'}\n\n` +
      '*Give the bot a different display name just in this server — this only changes how it looks here. Its actual account name and every other server are unaffected.*'
    );
}

function nicknameRow(hasNickname){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:nickname:set').setLabel(hasNickname ? '✏️ Change Nickname' : '➕ Set Nickname').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cfg:nickname:remove').setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger).setDisabled(!hasNickname),
      new ButtonBuilder().setCustomId('cfg:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Collection screen (multi-collection) ─────────────────────────────────────
function buildCollectionsEmbed(cfg){
  const extras = cfg.collections || [];
  const primary = cfg.contract ? {
    name: cfg.contractName || 'Primary Collection',
    slug: cfg.collectionSlug || cfg.slug || '—',
    contract: cfg.contract,
    salesChannel: cfg.salesChannel || cfg.channelId,
    listingsChannel: cfg.listingsChannel || cfg.listingsChannelId,
    isOcas: cfg.contract?.toLowerCase() === OCAS_CONTRACT,
  } : null;

  let desc = SEP + '\n\n';
  if(!primary && extras.length===0){
    desc += '*No collections configured.*\n\nClick **➕ Add Collection** to get started.\n';
  } else {
    if(primary){
      desc += `**1. ${primary.isOcas?'🔥 ':'📦 '}${primary.name}** *(primary)*\n`;
      desc += `> Slug: \`${primary.slug}\`\n`;
      desc += `> Sales: ${primary.salesChannel ? `<#${primary.salesChannel}>` : '`not set`'} · Listings: ${primary.listingsChannel ? `<#${primary.listingsChannel}>` : '`not set`'}${primary.isOcas && cfg.burnChannel ? ` · Burn: <#${cfg.burnChannel}>` : ''}\n\n`;
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
function buildCollectionEditEmbed(col, isPrimary, cfg={}){
  const isOcas = col.contract?.toLowerCase() === OCAS_CONTRACT;
  const isStackers = col.slug === STACKERS_SLUG;
  const ra = col.rankAlert;
  const raLabel = ra ? `#${ra.min}–#${ra.max} (${ra.rankType==='obs'?'TraitView':'OpenSea'})` : 'Not set';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📦 Edit: ${col.name || col.slug || 'Collection'}${isPrimary?' *(primary)*':''}`)
    .setDescription(
      SEP + '\n\n' +
      `**Contract:** ${col.contract ? `\`${col.contract}\`` : '`Not set`'} ${ok(col.contract)}\n` +
      `**Slug:** \`${col.slug || 'Not set'}\`\n` +
      `**Sales Channel:** ${col.salesChannel ? `<#${col.salesChannel}>` : '`Not set`'} ${ok(col.salesChannel)}\n` +
      `**Listings Channel:** ${col.listingsChannel ? `<#${col.listingsChannel}>` : '`Not set`'} ${ok(col.listingsChannel)}\n` +
      (isOcas ? `**Burn Alerts Channel:** ${cfg.burnChannel ? `<#${cfg.burnChannel}>` : '`Not set`'} ${ok(cfg.burnChannel)}\n` : '') +
      (isStackers ? `**Vault Alerts Channel:** ${cfg.vaultAlertChannel ? `<#${cfg.vaultAlertChannel}>` : '`Not set (uses Sales Channel)`'}\n` : '') +
      (isStackers ? `**Fusion Alerts Channel:** ${cfg.fusionChannel ? `<#${cfg.fusionChannel}>` : '`Not set (uses Sales Channel)`'}\n` : '') +
      `**Listing Filters:** ${Object.keys(col.listingFilters||{}).length} active\n` +
      `**Sales Filters:** ${Object.keys(col.salesFilters||{}).length} active\n` +
      `**Rank Alert:** ${raLabel}${!isOcas ? ' 🔒' : ''}\n` +
      `**Status:** ${col.paused ? '⏸️ Paused' : '▶️ Active'}\n` +
      (!isOcas ? `**Animated:** ${col.animated ? '🎞️ ON' : '🖼️ OFF (static)'}\n` : '') +
      (isOcas ? '\n🔥 **OCAS** — full feature set active.\n' : '\n🔒 *Rank Alert requires a paid tier for non-OCAS collections.*\n') +
      '\n*Use the dropdown below to edit a section.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function collectionEditRow(colId, isPrimary, isOcas=false, isStackers=false){
  const options = [
    new StringSelectMenuOptionBuilder().setLabel('Name').setEmoji('✏️').setValue('name').setDescription('Edit the display name'),
    new StringSelectMenuOptionBuilder().setLabel('Slug').setEmoji('🔗').setValue('slug').setDescription('Edit the OpenSea collection slug'),
    new StringSelectMenuOptionBuilder().setLabel('Sales Channel').setEmoji('🟢').setValue('saleschan').setDescription('Where sales post'),
    new StringSelectMenuOptionBuilder().setLabel('Listings Channel').setEmoji('📋').setValue('listchan').setDescription('Where listings post'),
    new StringSelectMenuOptionBuilder().setLabel('Listing Filters').setEmoji('🔍').setValue('filters').setDescription('Only post matching listings'),
    new StringSelectMenuOptionBuilder().setLabel('Sales Filters').setEmoji('💰').setValue('salesfilters').setDescription('Only post matching sales'),
    new StringSelectMenuOptionBuilder().setLabel('Rank Alert').setEmoji('🏆').setValue('rankalert').setDescription(isOcas ? 'Alert when a rank range gets listed' : '🔒 Paid tier required'),
    new StringSelectMenuOptionBuilder().setLabel('Trait Roles').setEmoji('🎭').setValue('traitroles').setDescription('Auto-assign roles by trait'),
    new StringSelectMenuOptionBuilder().setLabel('Pause / Resume').setEmoji('⏸️').setValue('pause').setDescription('Toggle auto-posting'),
    new StringSelectMenuOptionBuilder().setLabel('Re-backfill Traits').setEmoji('🔄').setValue('rebackfill').setDescription('Refresh trait & image data (paid · 24h cooldown)'),
    new StringSelectMenuOptionBuilder().setLabel('Animated Images').setEmoji('🎞️').setValue('animated').setDescription('Toggle animated thumbnails (auto-detected on backfill)'),
  ];
  if(isOcas){
    options.push(new StringSelectMenuOptionBuilder().setLabel('Burn Alerts Channel').setEmoji('🔥').setValue('burnchan').setDescription('Where burn alerts post'));
  }
  if(isStackers){
    options.push(new StringSelectMenuOptionBuilder().setLabel('Vault Alerts Channel').setEmoji('🏦').setValue('vaultalert').setDescription('Where new listings with unclaimed vault value post — defaults to Sales Channel'));
    options.push(new StringSelectMenuOptionBuilder().setLabel('Fusion Alerts Channel').setEmoji('🔥').setValue('fusionchan').setDescription('Where fusion alerts post — defaults to Sales Channel if not set'));
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cfg_col:section:${colId}`)
    .setPlaceholder('⚙️ Select a section to edit...')
    .addOptions(options);

  const row2Btns = [
    new ButtonBuilder().setCustomId('cfg:collections:back').setLabel('← Collections').setStyle(ButtonStyle.Secondary),
  ];
  if(!isPrimary) row2Btns.push(
    new ButtonBuilder().setCustomId(`cfg:col:remove:${colId}`).setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger)
  );
  if(isPrimary) row2Btns.push(
    new ButtonBuilder().setCustomId('cfg:col:removeprimary').setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger)
  );

  return [
    new ActionRowBuilder().addComponents(menu),
    new ActionRowBuilder().addComponents(row2Btns),
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
      `🟢 **Sales:** ${ch(cfg.salesChannel||cfg.channelId)} ${ok(cfg.salesChannel||cfg.channelId)}\n` +
      `📋 **Listings:** ${ch(cfg.listingsChannel||cfg.listingsChannelId)} ${ok(cfg.listingsChannel||cfg.listingsChannelId)}\n` +
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
  const hasAnyRole = !!(cfg.verifyRole || cfg.holderRole);
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔐 Wallet Verification')
    .setDescription(
      SEP + '\n\n' +
      `📌 **Channel:** ${ch(cfg.verifyChannel)} ${ok(cfg.verifyChannel)}\n` +
      `✅ **Verified Role:** ${rol(cfg.verifyRole)} ${ok(cfg.verifyRole)}\n` +
      `🏆 **Holder Role:** ${cfg.holderRole ? rol(cfg.holderRole) + ' ✅' : '`Not set` ⚪'}\n` +
      `🚦 **Panel status:** ${deployed ? '✅ Deployed' : '❌ Not deployed'}\n\n` +
      (cfg.verifyChannel && cfg.verifyRole
        ? '*Any member who verifies gets the Verified role.\nMembers holding ≥1 token also get the Holder role.*'
        : '*Don\'t need verification? That\'s fine — leave this unconfigured. Your alerts (sales, listings, burns) don\'t depend on it.*') +
      (hasAnyRole
        ? '\n\n⚠️ **Important:** in Server Settings → Roles, drag this bot\'s own role **above** the role(s) set here. Discord only lets a bot assign roles ranked below its own — if it isn\'t, assignment silently fails with no error shown anywhere.'
        : '')
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

// ── Rank Alert screen ────────────────────────────────────────────────────────
function buildRankAlertEmbed(col, colId, colLabel){
  const ra = col.rankAlert;
  const rankLabel = ra?.rankType === 'obs' ? 'TraitView Observed' : 'OpenSea';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(colLabel ? `🏆 Rank Alert — ${colLabel}` : '🏆 Rank Alert')
    .setDescription(
      SEP + '\n\n' +
      (ra
        ? `**Range:** #${ra.min} – #${ra.max}\n` +
          `**Rank System:** ${rankLabel}\n` +
          `**Channel:** ${ch(ra.channelId)} ${ra.channelId ? '' : '*(falls back to listings channel)*'}\n`
        : '*No rank alert configured.*\n'
      ) + '\n' +
      '*Posts an alert whenever a token in this rank range gets listed.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function rankAlertRow(col, colId){
  const hasAlert = !!col.rankAlert;
  const backId = colId ? `cfg:col:view:${colId}` : 'cfg:back';
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:rank:set:${colId}`).setLabel(hasAlert ? '✏️ Edit Range' : '➕ Set Rank Alert').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:rank:channel:${colId}`).setLabel('📌 Channel').setStyle(ButtonStyle.Secondary).setDisabled(!hasAlert),
      new ButtonBuilder().setCustomId(`cfg:rank:clear:${colId}`).setLabel('🗑️ Clear').setStyle(ButtonStyle.Danger).setDisabled(!hasAlert),
      new ButtonBuilder().setCustomId(backId).setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
}


// ── Roles screen ──────────────────────────────────────────────────────────────
function traitRuleLabel(r){
  if(r.trait_type === '_count') return `Own ${r.minimum_count}+ tokens`;
  if(r.trait_type === '_totalburns') return `${r.minimum_count}+ burn transactions, ever`;
  if(r.trait_type === '_maxburn') return `${r.minimum_count}+ tokens in a single burn`;
  return `${r.trait_type}: ${r.trait_value || 'any'}${r.minimum_count > 1 ? ` ×${r.minimum_count}` : ''}`;
}

function buildRolesEmbed(traitRoles, collectionLabel){
  const list = traitRoles.length === 0
    ? '*No trait roles configured yet.*'
    : traitRoles.map((r, i) =>
        `**${i+1}.** ${r.role_id ? `<@&${r.role_id}>` : 'Unknown Role'} — ${traitRuleLabel(r)}`
      ).join('\n');

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(collectionLabel ? `🎭 Trait Roles — ${collectionLabel}` : '🎭 Trait Roles')
    .setDescription(
      SEP + '\n\n' +
      list + '\n\n' +
      '*Roles are assigned automatically when a member verifies\nand re-synced every 24 hours.*' +
      (traitRoles.length
        ? '\n\n⚠️ **Important:** in Server Settings → Roles, drag this bot\'s own role **above** every role listed above. Discord only lets a bot assign roles ranked below its own — if it isn\'t, assignment silently fails with no error shown anywhere.'
        : '')
    )
    .setFooter({ text: 'Only visible to you' });
}

function rolesRow(traitRoles, colId){
  const addId   = colId ? `cfg:role:add:${colId}` : 'cfg:role:add';
  const backId  = colId ? `cfg:col:view:${colId}` : 'cfg:back';
  const delId   = colId ? `cfg_role:delete:${colId}` : 'cfg_role:delete';
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(addId).setLabel('➕ Add Trait Role').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(backId).setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
  if(traitRoles.length > 0){
    const options = traitRoles.slice(0, 25).map((r, i) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${i+1}. ${traitRuleLabel(r)}`)
        .setDescription(`Role: ${r.role_id ? `<@&${r.role_id}>` : 'Unknown'}`)
        .setValue(`${r.id}`)
    );
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(delId)
        .setPlaceholder('🗑️ Remove a trait role...')
        .addOptions(options)
    ));
  }
  return rows;
}

// ── Embed Style screen — independent per-context toggles ──────────────────────
// Sales/listings/commands can each independently show traits+thumbnail
// (default) or large artwork with no traits — e.g. a server might want
// artwork-focused sales/command results but keep the full trait list on
// listings. All default to true (traits shown) so no server's display
// changes without opting in.
function buildEmbedStyleEmbed(cfg){
  const modeLabel = (key) => (cfg.embedShowTraits?.[key] === false) ? '🖼️ Large artwork (no traits)' : '📋 Traits + thumbnail (default)';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🖼️ Embed Style')
    .setDescription(
      SEP + '\n\n' +
      'Controls how sale alerts, listing alerts, and command results ' +
      '(/traitfind, /rankfind) display each token — the full trait list ' +
      'with a small thumbnail, or a large, artwork-focused image with no ' +
      'trait list. Each can be set independently.\n\n' +
      `🟢 **Sales Alerts:** ${modeLabel('sales')}\n` +
      `📋 **Listing Alerts:** ${modeLabel('listings')}\n` +
      `⌨️ **Commands** (/traitfind, /rankfind, etc.): ${modeLabel('commands')}\n`
    )
    .setFooter({ text: 'Only visible to you' });
}
function embedStyleRow(){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:toggle:embedstyle:sales').setLabel('Toggle Sales').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:toggle:embedstyle:listings').setLabel('Toggle Listings').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:toggle:embedstyle:commands').setLabel('Toggle Commands').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Main handler ──────────────────────────────────────────────────────────────

// ── Filters screen ────────────────────────────────────────────────────────────
function buildFiltersEmbed(cfg){
  const filters = cfg.listingFilters || {};
  const entries = Object.entries(filters);

  let list = entries.length === 0
    ? '*No listing filters set — all listings post to your listings channel.*\n'
    : entries.map(([k, vals]) =>
        `**${k}:** ${Array.isArray(vals) ? vals.join(', ') : vals}`
      ).join('\n') + '\n';

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📋 Listing Filters')
    .setDescription(
      SEP + '\n\n' +
      'Only listings matching these trait filters will post to your listings channel.\n' +
      'Leave empty to post all listings.\n\n' +
      '**Active filters:**\n' + list + '\n' +
      '*Example: Type = Zombie → only Zombie listings post.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function filtersRow(cfg){
  const filters = cfg.listingFilters || {};
  const hasFilters = Object.keys(filters).length > 0;
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:filter:add').setLabel('➕ Add Filter').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cfg:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
  if(hasFilters){
    const options = [];
    for(const [k, vals] of Object.entries(filters)){
      const arr = Array.isArray(vals) ? vals : [vals];
      for(const v of arr){
        if(options.length >= 25) break;
        options.push(new StringSelectMenuOptionBuilder()
          .setLabel(`${k}: ${v}`)
          .setValue(`${k}::${v}`)
        );
      }
    }
    if(options.length > 0){
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cfg_filter:remove')
          .setPlaceholder('🗑️ Remove a value...')
          .addOptions(options)
      ));
    }
  }
  return rows;
}


// ── Per-collection filter screen ─────────────────────────────────────────────
function buildColFiltersEmbed(col, colId){
  const filters = col.listingFilters || {};
  const entries = Object.entries(filters);
  const name = col.name || col.slug || 'Collection';
  let list = entries.length === 0
    ? '*No filters — all listings post.*\n'
    : entries.map(([k,v]) => `**${k}:** ${Array.isArray(v)?v.join(', '):v}`).join('\n') + '\n';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🔍 Listing Filters — ${name}`)
    .setDescription(
      SEP + '\n\n' +
      'Only listings matching these traits will post for this collection.\n' +
      'Leave empty to post all listings.\n\n' +
      '**Active filters:**\n' + list
    )
    .setFooter({ text: 'Only visible to you' });
}

function colFiltersRow(col, colId){
  const filters = col.listingFilters || {};
  const hasFilters = Object.keys(filters).length > 0;
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:col:filter:add:${colId}`).setLabel('➕ Add Filter').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:col:filters:back:${colId}`).setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
  if(hasFilters){
    const options = [];
    for(const [k, vals] of Object.entries(filters)){
      const arr = Array.isArray(vals) ? vals : [vals];
      for(const v of arr){
        if(options.length >= 25) break;
        options.push(new StringSelectMenuOptionBuilder()
          .setLabel(`${k}: ${v}`)
          .setValue(`${k}::${v}`)
        );
      }
    }
    if(options.length > 0){
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cfg_col_filter:remove:${colId}`)
          .setPlaceholder('🗑️ Remove a value...')
          .addOptions(options)
      ));
    }
  }
  return rows;
}

// ── Per-collection Sales Filters screen ──────────────────────────────────────
function buildColSalesFiltersEmbed(col, colId){
  const filters = col.salesFilters || {};
  const entries = Object.entries(filters);
  const name = col.name || col.slug || 'Collection';
  let list = entries.length === 0
    ? '*No filters — all sales post.*\n'
    : entries.map(([k,v]) => `**${k}:** ${Array.isArray(v)?v.join(', '):v}`).join('\n') + '\n';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`💰 Sales Filters — ${name}`)
    .setDescription(
      SEP + '\n\n' +
      'Only sales matching these traits will post for this collection.\n' +
      'Leave empty to post all sales.\n\n' +
      '**Active filters:**\n' + list
    )
    .setFooter({ text: 'Only visible to you' });
}

function colSalesFiltersRow(col, colId){
  const filters = col.salesFilters || {};
  const hasFilters = Object.keys(filters).length > 0;
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:col:salesfilter:add:${colId}`).setLabel('➕ Add Filter').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:col:salesfilters:back:${colId}`).setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
  if(hasFilters){
    const options = [];
    for(const [k, vals] of Object.entries(filters)){
      const arr = Array.isArray(vals) ? vals : [vals];
      for(const v of arr){
        if(options.length >= 25) break;
        options.push(new StringSelectMenuOptionBuilder()
          .setLabel(`${k}: ${v}`)
          .setValue(`${k}::${v}`)
        );
      }
    }
    if(options.length > 0){
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cfg_col_salesfilter:remove:${colId}`)
          .setPlaceholder('🗑️ Remove a value...')
          .addOptions(options)
      ));
    }
  }
  return rows;
}

async function handleConfigCommand(interaction, ctx){
  await interaction.deferReply({ flags: 64 });
  const { pgPool, getConfig } = ctx;
  const cfg = getConfig(interaction.guildId) || {};
  if(!hasConfigAccess(interaction, cfg)){
    return interaction.editReply({ content: NO_ACCESS_MSG, embeds:[], components:[] });
  }
  const trRes = await pgPool.query(
    'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
    [interaction.guildId]
  ).catch(()=>({ rows:[] }));
  return interaction.editReply({
    embeds: [buildDashboardEmbed(cfg, trRes.rows)],
    components: dashboardRow(cfg),
  });
}

// ── Shared trait-category/value picker for Listing & Sales filters ───────────
async function showFilterCategoryPicker(interaction, cfg, colId, kind){
  const { pgPool } = require('../lib/db');
  const isPrimary = colId === 'primary';
  const slug = isPrimary
    ? (cfg.collectionSlug || cfg.slug || '')
    : ((cfg.collections||[])[parseInt(colId)]?.slug || '');

  const catRes = await pgPool.query(
    `SELECT DISTINCT trait_name FROM collection_traits WHERE slug=$1 ORDER BY trait_name`,
    [slug]
  ).catch(()=>({ rows:[] }));

  const categories = catRes.rows.map(r => r.trait_name).filter(Boolean);
  const kindLabel = kind === 'sales' ? '💰 Sales' : '🔍 Listing';
  const backId = kind === 'sales' ? `cfg:col:salesfilters:${colId}` : `cfg:col:filters:${colId}`;

  if(!categories.length){
    return interaction.editReply({
      content: `**Adding ${kindLabel} Filter**\n\nNo cached trait data found for this collection yet. Re-save the slug in this collection's edit screen to fetch traits, then try again.`,
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(backId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  }

  // Up to 4 stacked menus (100 categories) + 1 row for Cancel, comfortably
  // covering any realistic trait-category count -- this is a single-select
  // (pick one category, not several), so unlike the value pickers there's
  // no accumulation needed at all: whichever menu the user actually uses
  // fires the existing cfg_filtertrait:catsel: handler completely
  // unchanged, same as how lib/role-picker.js's paginated role menus work.
  const CAT_CHUNK = 25;
  const catMenuCount = Math.min(4, Math.ceil(categories.length / CAT_CHUNK));
  const catRows = [];
  for(let i = 0; i < catMenuCount; i++){
    const slice = categories.slice(i * CAT_CHUNK, (i + 1) * CAT_CHUNK);
    if(!slice.length) break;
    const opts = slice.map(c => new StringSelectMenuOptionBuilder().setLabel(c).setValue(c));
    const m = new StringSelectMenuBuilder()
      .setCustomId(`cfg_filtertrait:catsel:${kind}:${colId}:${i}`)
      .setPlaceholder(catMenuCount > 1 ? `Categories ${i * CAT_CHUNK + 1}-${i * CAT_CHUNK + slice.length} of ${categories.length}` : 'Step 1 of 2 — Pick a trait category...')
      .addOptions(opts);
    catRows.push(new ActionRowBuilder().addComponents(m));
  }
  catRows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(backId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
  ));

  return interaction.editReply({
    content: `**Adding ${kindLabel} Filter**\n\nStep 1 of 2 — Pick the trait category:`,
    embeds: [],
    components: catRows,
  });
}

async function handleConfigButton(interaction, ctx){
  const { pgPool, getConfig, setConfig, syncBurnConfig } = ctx;
  const guildId  = interaction.guildId;
  let customId   = interaction.customId;

  // Access check first, before any defer/showModal — a stale or shared component
  // shouldn't let a non-admin act on it even if they weren't the one who ran /config.
  const accessCfg = getConfig(guildId) || {};
  if(!hasConfigAccess(interaction, accessCfg)){
    return interaction.reply({ content: NO_ACCESS_MSG, flags: MessageFlags.Ephemeral }).catch(()=>{});
  }

  // ── Collection edit dropdown: translate the selected section into its legacy customId ──
  // The dropdown (cfg_col:section:colId) replaced the old per-button customIds; rather than
  // duplicate every handler below, we resolve the chosen section here and let the existing
  // if(customId.startsWith(...)) chain handle it unchanged.
  let rankAlertPaidBlock = false;
  if(customId.startsWith('cfg_col:section:')){
    const colId   = customId.split(':')[2];
    const section = interaction.values[0];
    const sectionMap = {
      name:          `cfg:col:name:${colId}`,
      slug:          `cfg:col:slug:${colId}`,
      saleschan:     `cfg:col:saleschan:${colId}`,
      listchan:      `cfg:col:listchan:${colId}`,
      burnchan:      `cfg:col:burnchan:${colId}`,
      filters:       `cfg:col:filters:${colId}`,
      salesfilters:  `cfg:col:salesfilters:${colId}`,
      rankalert:     `cfg:col:rankalert:${colId}`,
      vaultalert:    `cfg:col:vaultalertchan:${colId}`,
      fusionchan:    `cfg:col:fusionchan:${colId}`,
      traitroles:    `cfg:col:traitroles:${colId}`,
      pause:         `cfg:col:pause:${colId}`,
      rebackfill:    `cfg:col:rebackfill:${colId}`,
      animated:      `cfg:col:animated:${colId}`,
    };
    if(section === 'rankalert'){
      const preCfg = getConfig(guildId) || {};
      const isPrimaryCheck = colId === 'primary';
      const colCheck = isPrimaryCheck ? { contract: preCfg.contract } : (preCfg.collections||[])[parseInt(colId)];
      if(isPaidFeature(colCheck, 'rankalert', interaction.user.id)) rankAlertPaidBlock = true;
    }
    customId = sectionMap[section] || customId;
  }

  // Modals open with showModal (their own response) — everything else defers first
  const tzCustomPicked = customId === 'cfg_tzsel:lotteries' && interaction.values?.[0] === 'custom';
  const isModal = customId === 'cfg:col:contract' || customId === 'cfg:col:slug' ||
                  customId === 'cfg:col:add' ||
                  customId === 'cfg:nickname:set' ||
                  customId === 'cfg:filter:add' ||
                  tzCustomPicked ||
                  customId.startsWith('cfg:rank:set:') ||
                  customId.startsWith('cfg_traitrole:manual:') ||
                  customId.startsWith('cfg_traitrole:quickmodal:') ||
                  (customId.startsWith('vpick:traitrole:') && customId.endsWith(':setcount')) ||
                  customId.startsWith('cfg_filtertrait:manual:') ||
                  customId.startsWith('cfg:col:name:') ||
                  customId.startsWith('cfg:col:contract:') || customId.startsWith('cfg:col:slug:');
  if(!isModal) await interaction.deferUpdate();

  const cfg = getConfig(guildId) || {};

  if(rankAlertPaidBlock){
    return interaction.editReply({ content: '🔒 Rank Alert requires a paid tier for non-OCAS collections. Visit traitview.com to upgrade.', embeds:[], components:[
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(customId.replace('cfg:col:rankalert:', 'cfg:col:view:')).setLabel('← Back').setStyle(ButtonStyle.Secondary)
      )
    ]});
  }

  const traitRolesQ = () => pgPool.query(
    'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
    [guildId]
  ).catch(()=>({ rows:[] }));

  // colSlug=null returns only rules with NULL collection_slug (primary collection); pass a slug for collection-specific rules
  const traitRolesQFor = (colSlug) => pgPool.query(
    colSlug
      ? 'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 AND collection_slug=$2 ORDER BY trait_type, trait_value'
      : 'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 AND collection_slug IS NULL ORDER BY trait_type, trait_value',
    colSlug ? [guildId, colSlug] : [guildId]
  ).catch(()=>({ rows:[] }));

  // ── Embed style category + toggles ─────────────────────────────────────────
  if(customId === 'cfg:cat:embedstyle'){
    return interaction.editReply({
      content: '',
      embeds: [buildEmbedStyleEmbed(cfg)],
      components: embedStyleRow(),
    });
  }
  if(customId.startsWith('cfg:toggle:embedstyle:')){
    const key = customId.split(':')[3]; // 'sales' | 'listings' | 'commands'
    cfg.embedShowTraits = cfg.embedShowTraits || {};
    cfg.embedShowTraits[key] = cfg.embedShowTraits[key] === false ? true : false;
    await setConfig(guildId, cfg);
    return interaction.editReply({
      content: '',
      embeds: [buildEmbedStyleEmbed(cfg)],
      components: embedStyleRow(),
    });
  }

  // ── Back to dashboard ──────────────────────────────────────────────────────
  if(customId === 'cfg:back'){
    const trRes = await traitRolesQ();
    return interaction.editReply({
      content: '',
      embeds: [buildDashboardEmbed(cfg, trRes.rows)],
      components: dashboardRow(cfg),
    });
  }

  function resolveColFromId(cfg, colId){
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { contract: cfg.contract, slug: cfg.collectionSlug || cfg.slug, name: cfg.contractName, salesChannel: cfg.channelId, listingsChannel: cfg.listingsChannelId, listingFilters: cfg.listingFilters||{}, salesFilters: cfg.salesFilters||{}, paused: cfg.paused }
      : (cfg.collections||[])[parseInt(colId)];
    return { col, isPrimary };
  }

  // ── Category navigation ────────────────────────────────────────────────────
  if(customId === 'cfg:cat:collection'){
    const extras = cfg.collections || [];
    const allCols = [];
    if(cfg.contract) allCols.push('primary');
    extras.forEach((_, i) => allCols.push(String(i)));
    if(allCols.length === 1){
      // Only one collection configured — skip the picker, go straight to editing it.
      const { col, isPrimary } = resolveColFromId(cfg, allCols[0]);
      if(col) return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(allCols[0], isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT, col?.slug === STACKERS_SLUG) });
    }
    return interaction.editReply({ content:'', embeds:[buildCollectionsEmbed(cfg)], components:collectionsRow(cfg) });
  }

  // ── Back button from inside a collection's edit screen — always shows the
  // list, even with only one collection configured. Deliberately does NOT
  // share cfg:cat:collection's "skip straight to editing it" shortcut above,
  // since that shortcut only makes sense the first time someone opens
  // Collections from the dashboard, not when they're explicitly asking to
  // go back from an already-open collection. Sharing the same customId
  // for both used to make the back button look like a no-op whenever only
  // one collection existed, since it just re-rendered the identical screen.
  if(customId === 'cfg:collections:back'){
    return interaction.editReply({ content:'', embeds:[buildCollectionsEmbed(cfg)], components:collectionsRow(cfg) });
  }

  // Select a collection to edit
  if(customId === 'cfg_col:select'){
    const colId = interaction.values[0];
    const { col, isPrimary } = resolveColFromId(cfg, colId);
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });
    return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT, col?.slug === STACKERS_SLUG) });
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
  if(customId.startsWith('cfg:col:name:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { name: cfg.contractName||'' }
      : (cfg.collections||[])[parseInt(colId)] || {};
    const modal = new ModalBuilder().setCustomId(`cfg_modal:col_name:${colId}`).setTitle('Edit Collection Name');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('col_name')
          .setLabel('Collection Name / Alias')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Portraits, MyNFT')
          .setValue(col.name||'')
          .setRequired(true)
      )
    );
    return interaction.showModal(modal);
  }

  if(customId.startsWith('cfg:col:contract:') || customId.startsWith('cfg:col:slug:')){
    const parts = customId.split(':');
    const field = parts[2]; // 'contract' or 'slug'
    const colId = parts[3];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { contract: cfg.contract, slug: cfg.collectionSlug || cfg.slug, name: cfg.contractName }
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
  if(customId.startsWith('cfg:col:clearchan:')){
    const parts = customId.split(':');
    const field  = parts[3]; // 'sales' or 'listings'
    const colId  = parts[4];
    const isPrimary = colId === 'primary';
    // Using `= null` here, not `delete` — setConfig() re-fetches the DB row
    // and merges it under the incoming cfg (`{...dbCfg, ...cfg}`) to avoid
    // clobbering fields the caller doesn't know about. That merge can only
    // override a key that's actually PRESENT on the incoming object; a
    // `delete`d key is simply absent, so the merge let the old DB value flow
    // straight back through and the "disabled" channel came right back the
    // next time any /config action re-saved the config. Every downstream
    // reader already treats null exactly like unset (e.g. lib/poll.js's
    // `if(!ctx.listingsChannelId) continue`), so this is a safe, real fix.
    if(isPrimary){
      if(field === 'sales')    { cfg.channelId = null; cfg.salesChannel = null; }
      if(field === 'listings') { cfg.listingsChannelId = null; cfg.listingsChannel = null; }
      if(field === 'burn')     { cfg.burnChannel = null; if(syncBurnConfig) syncBurnConfig().catch(()=>{}); }
      if(field === 'fusion')   { cfg.fusionChannel = null; }
      if(field === 'vaultalert') { cfg.vaultAlertChannel = null; }
    } else {
      const idx = parseInt(colId);
      if(cfg.collections?.[idx]){
        if(field === 'sales')    cfg.collections[idx].salesChannel    = null;
        if(field === 'listings') cfg.collections[idx].listingsChannel = null;
      }
      // burn, fusion, and vault-alert channels are always top-level in cfg
      if(field === 'burn') { cfg.burnChannel = null; if(syncBurnConfig) syncBurnConfig().catch(()=>{}); }
      if(field === 'fusion') { cfg.fusionChannel = null; }
      if(field === 'vaultalert') { cfg.vaultAlertChannel = null; }
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { contract:cfg.contract, slug:cfg.collectionSlug||cfg.slug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId, listingFilters:cfg.listingFilters||{} }
      : cfg.collections?.[parseInt(colId)] || {};
    return interaction.editReply({ content:'✅ Channel cleared.', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)
], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT, col?.slug === STACKERS_SLUG) });
  }

  if(customId.startsWith('cfg:col:saleschan:') || customId.startsWith('cfg:col:listchan:')){
    const parts = customId.split(':');
    const field = parts[2]; // 'saleschan' or 'listchan'
    const colId = parts[3];
    const label = field==='saleschan' ? '🟢 Sales' : '📋 Listings';
    const clearField = field==='saleschan' ? 'sales' : 'listings'; // clearchan handler expects 'sales'/'listings', not 'saleschan'/'listchan'
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(`cfg_chsel:col:${field}:${colId}`)
      .setPlaceholder(`Pick the ${label} channel`)
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:`**Select the ${label} channel:**`, embeds:[], components:[
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cfg:col:clearchan:${clearField}:${colId}`).setLabel(`🚫 Disable ${label.replace(/^\S+\s/, '')} Alerts`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`cfg:col:view:${colId}`).setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ]});
  }

  if(customId.startsWith('cfg:col:burnchan:')){
    const colId = customId.split(':')[3];
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(`cfg_chsel:col:burnchan:${colId}`)
      .setPlaceholder('Pick the Burn Alerts channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the 🔥 Burn Alerts channel:**', embeds:[], components:[
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cfg:col:clearchan:burn:${colId}`).setLabel('🚫 Disable Burn Alerts').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`cfg:col:view:${colId}`).setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ]});
  }

  if(customId.startsWith('cfg:col:fusionchan:')){
    const colId = customId.split(':')[3];
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(`cfg_chsel:col:fusionchan:${colId}`)
      .setPlaceholder('Pick the Fusion Alerts channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the 🔥 Fusion Alerts channel:**\n_Leave unset and fusion alerts post to the Sales Channel instead._', embeds:[], components:[
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cfg:col:clearchan:fusion:${colId}`).setLabel('↩️ Reset to Sales Channel').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`cfg:col:view:${colId}`).setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ]});
  }

  // ── Per-collection Trait Roles ──────────────────────────────────────────────
  if(customId.startsWith('cfg:col:traitroles:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { slug: cfg.collectionSlug || cfg.slug, name: cfg.contractName || 'Primary Collection' }
      : (cfg.collections||[])[parseInt(colId)];
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });

    // Primary collection's rules are stored with collection_slug=NULL for backward compatibility
    const colSlug = isPrimary ? null : col.slug;
    const trRes = await traitRolesQFor(colSlug);
    return interaction.editReply({
      content: '',
      embeds: [buildRolesEmbed(trRes.rows, col.name || col.slug)],
      components: rolesRow(trRes.rows, colId),
    });
  }

  // Back to a specific collection's edit screen from its Trait Roles view
  if(customId.startsWith('cfg:col:view:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { contract: cfg.contract, slug: cfg.collectionSlug || cfg.slug, name: cfg.contractName, salesChannel: cfg.channelId, listingsChannel: cfg.listingsChannelId, listingFilters: cfg.listingFilters||{}, salesFilters: cfg.salesFilters||{}, paused: cfg.paused }
      : (cfg.collections||[])[parseInt(colId)];
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });
    return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT, col?.slug === STACKERS_SLUG) });
  }

  // Remove extra collection
  if(customId.startsWith('cfg:col:filters:back:')){
    const colId = customId.split(':')[4];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { contract:cfg.contract, slug:cfg.collectionSlug||cfg.slug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId, listingFilters:cfg.listingFilters||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT, col?.slug === STACKERS_SLUG) });
  }

  if(customId.startsWith('cfg:col:filters:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { ...cfg, slug: cfg.collectionSlug||cfg.slug, listingFilters: cfg.listingFilters||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    return interaction.editReply({ content:'', embeds:[buildColFiltersEmbed(col, colId)], components:colFiltersRow(col, colId) });
  }

  if(customId.startsWith('cfg:col:filter:add:')){
    const colId = customId.split(':')[4];
    return showFilterCategoryPicker(interaction, cfg, colId, 'listing');
  }

  if(customId.startsWith('cfg_col_filter:remove:')){
    const parts = customId.split(':');
    const colId = parts[2];
    const [traitType, traitVal] = interaction.values[0].split('::');
    const isPrimary = colId === 'primary';
    if(isPrimary){
      const filters = cfg.listingFilters || {};
      if(filters[traitType]){
        const arr = Array.isArray(filters[traitType]) ? filters[traitType] : [filters[traitType]];
        const updated = arr.filter(v => v !== traitVal);
        if(updated.length === 0) delete filters[traitType];
        else filters[traitType] = updated;
      }
      cfg.listingFilters = filters;
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]){
        const filters = cols[idx].listingFilters || {};
        if(filters[traitType]){
          const arr = Array.isArray(filters[traitType]) ? filters[traitType] : [filters[traitType]];
          const updated = arr.filter(v => v !== traitVal);
          if(updated.length === 0) delete filters[traitType];
          else filters[traitType] = updated;
        }
        cols[idx].listingFilters = filters;
        cfg.collections = cols;
      }
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { ...cfg, listingFilters: cfg.listingFilters||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    return interaction.editReply({ content:'✅ Filter removed.', embeds:[buildColFiltersEmbed(col, colId)], components:colFiltersRow(col, colId) });
  }

  // ── Sales Filters screen ─────────────────────────────────────────────────
  if(customId.startsWith('cfg:col:salesfilters:back:')){
    const colId = customId.split(':')[4];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { contract: cfg.contract, slug: cfg.collectionSlug || cfg.slug, name: cfg.contractName, salesChannel: cfg.channelId, listingsChannel: cfg.listingsChannelId, listingFilters: cfg.listingFilters||{}, salesFilters: cfg.salesFilters||{}, paused: cfg.paused }
      : (cfg.collections||[])[parseInt(colId)];
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });
    return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT, col?.slug === STACKERS_SLUG) });
  }

  if(customId.startsWith('cfg:col:salesfilters:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { ...cfg, slug: cfg.collectionSlug||cfg.slug, salesFilters: cfg.salesFilters||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    return interaction.editReply({ content:'', embeds:[buildColSalesFiltersEmbed(col, colId)], components:colSalesFiltersRow(col, colId) });
  }

  if(customId.startsWith('cfg:col:salesfilter:add:')){
    const colId = customId.split(':')[4];
    return showFilterCategoryPicker(interaction, cfg, colId, 'sales');
  }

  // ── Filter category selected → show value multi-select ─────────────────
  // ── Shared paginated multi-select value picker (page/sel/done) ──────────────
  // Handles Prev/Next navigation and selection-accumulation generically for
  // ANY flow that hit the >25-values case, then branches only for the final
  // Done action, since each flow saves its picks differently.
  if(customId.startsWith('vpick:')){
   try{
    const parsed = parseValuePickerCustomId(customId);
    if(!parsed){
      return interaction.editReply({ content: '❌ Something went wrong with this picker. Please start over.', embeds:[], components:[] });
    }
    const { action, customIdPrefix } = parsed;
    const prefixParts = customIdPrefix.split(':');
    const flow = prefixParts[0]; // 'filtertrait' or 'traitrole'

    // Reconstruct the same sessionKey used when this picker was first opened.
    let sessionKey, cancelId, placeholder, category, kind, colId, roleId, catColId, valColId;
    if(flow === 'filtertrait'){
      [, kind, colId] = prefixParts;
      category = decodeURIComponent(prefixParts[3]);
      sessionKey = `${interaction.user.id}:filtertrait:${kind}:${colId}:${category}`;
      cancelId = kind === 'sales' ? `cfg:col:salesfilters:${colId}` : `cfg:col:filters:${colId}`;
      placeholder = 'Pick one or more values...';
    } else if(flow === 'traitrole'){
      [, roleId, catColId] = prefixParts;
      category = decodeURIComponent(prefixParts[3]);
      valColId = (catColId && catColId !== '_') ? catColId : '';
      sessionKey = `${interaction.user.id}:traitrole:${roleId}${valColId ? ':'+valColId : ''}:${category}`;
      cancelId = valColId ? `cfg:col:traitroles:${valColId}` : 'cfg:cat:roles';
      placeholder = 'Pick one or more values...';
    } else {
      return interaction.editReply({ content: '❌ Unknown picker type. Please start over.', embeds:[], components:[] });
    }

    const session = getValuePickerSession(sessionKey);
    if(!session){
      return interaction.editReply({ content: '❌ This picker session expired (likely a bot restart mid-flow). Please start over.', embeds:[], components:[] });
    }

    if(action === 'sel'){
      const newValues = interaction.values || [];
      recordMenuSelection(sessionKey, parsed.menuIndex, newValues);

      if(newValues.length && flow === 'filtertrait'){
        // Additive by design (adding new values never removes ones saved
        // from a different menu earlier in this same session), so filters
        // still apply immediately -- no minimum-count concept here at all,
        // nothing to wait for.
        const catKey = category.toLowerCase();
        const lowerValues = newValues.map(v => v.toLowerCase());
        const fieldKey = kind === 'sales' ? 'salesFilters' : 'listingFilters';
        const isPrimary = colId === 'primary';
        if(isPrimary){
          if(!cfg[fieldKey]) cfg[fieldKey] = {};
          const existing = cfg[fieldKey][catKey] || [];
          cfg[fieldKey][catKey] = [...new Set([...existing, ...lowerValues])];
        } else {
          const cols = cfg.collections || [];
          const idx = parseInt(colId);
          if(cols[idx]){
            if(!cols[idx][fieldKey]) cols[idx][fieldKey] = {};
            const existing = cols[idx][fieldKey][catKey] || [];
            cols[idx][fieldKey][catKey] = [...new Set([...existing, ...lowerValues])];
            cfg.collections = cols;
          }
        }
        await setConfig(guildId, cfg);
      }
      // traitrole: just record the pick in the session -- nothing saves to
      // trait_roles until Done, since a minimum-count modal happens next
      // and the count needs to be known before any row is written.

      const { rows, truncatedNote } = buildStackedValuePickerRows(sessionKey, customIdPrefix, { placeholder, cancelId, countButton: flow === 'traitrole' });
      const doneHint = flow === 'traitrole'
        ? `pick from as many of the menus below as you want, then Done to finish (defaults to needing 1), or Set Count first if you want a different minimum.`
        : `Picks save as soon as you make them — pick from as many of the menus below as you want, then Done when finished.`;
      return interaction.editReply({
        content: `**${category}**${truncatedNote}\n\n${doneHint}`,
        embeds: [],
        components: rows,
      });
    }

    if(action === 'setcount'){
      if(flow !== 'traitrole'){
        return interaction.editReply({ content: '❌ Not applicable here.', embeds:[], components:[] });
      }
      // Don't clear the session or save anything yet -- need the count
      // first. showModal must be this interaction's first response, so
      // this branch is listed in the isModal skip-defer check up top.
      if(!session.selected.size){
        return interaction.editReply({ content: 'No values were selected. Please pick at least one value first.', embeds:[], components:[] });
      }
      const modal = new ModalBuilder()
        .setCustomId(`cfg_modal:trcount:${roleId}:${valColId || '_'}:${encodeURIComponent(category)}`)
        .setTitle(`${category}`.slice(0, 45));
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('tr_count_min')
            .setLabel('How many needed? (default: 1)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. 1, 3, 5')
            .setRequired(false)
        ),
      );
      return interaction.showModal(modal);
    }

    if(action === 'done'){
      const selectedValues = [...session.selected];
      clearValuePicker(sessionKey);

      if(flow === 'filtertrait'){
        const col = colId === 'primary' ? { ...cfg, [kind === 'sales' ? 'salesFilters' : 'listingFilters']: cfg[kind === 'sales' ? 'salesFilters' : 'listingFilters']||{} } : (cfg.collections||[])[parseInt(colId)] || {};
        const embedFn = kind === 'sales' ? buildColSalesFiltersEmbed : buildColFiltersEmbed;
        const rowFn = kind === 'sales' ? colSalesFiltersRow : colFiltersRow;
        return interaction.editReply({
          content: selectedValues.length
            ? `✅ Added **${selectedValues.length}** value${selectedValues.length>1?'s':''} for **${category}**.`
            : `No values were selected for **${category}** — nothing added.`,
          embeds: [embedFn(col, colId)],
          components: rowFn(col, colId),
        });
      }

      if(flow === 'traitrole'){
        // Done is the one-click "just finish, default to needing 1" path --
        // Set Count (a separate button, see the 'setcount' action above) is
        // where an actual custom minimum gets collected. Nothing here waits
        // on user input, so this saves immediately at count=1, same as
        // before the count feature existed at all.
        if(!selectedValues.length){
          return interaction.editReply({ content: `No values were selected — nothing added.`, embeds:[], components:[] });
        }
        let collectionSlugForSave = null;
        let colLabel;
        if(valColId && valColId !== 'primary'){
          const col = (cfg.collections||[])[parseInt(valColId)];
          collectionSlugForSave = col?.slug || null;
          colLabel = col?.name || col?.slug;
        }
        for(const val of selectedValues){
          await pgPool.query(
            `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count, collection_slug)
             VALUES ($1,$2,$3,$4,1,$5)
             ON CONFLICT (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count) DO UPDATE SET collection_slug=$5`,
            [guildId, roleId, category, val, collectionSlugForSave]
          ).catch(e => console.warn('[Config] trait_roles insert:', e.message));
        }
        const trRes = valColId
          ? await pgPool.query(
              collectionSlugForSave
                ? 'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 AND collection_slug=$2 ORDER BY trait_type, trait_value'
                : 'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 AND collection_slug IS NULL ORDER BY trait_type, trait_value',
              collectionSlugForSave ? [guildId, collectionSlugForSave] : [guildId]
            ).catch(()=>({ rows:[] }))
          : await pgPool.query(
              'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
              [guildId]
            ).catch(()=>({ rows:[] }));
        return interaction.editReply({
          content: `✅ Added **${selectedValues.length}** trait role rule${selectedValues.length > 1 ? 's' : ''} for <@&${roleId}>:\n${selectedValues.map(v=>`• ${category}: ${v}`).join('\n')}`,
          embeds: [buildRolesEmbed(trRes.rows, colLabel)],
          components: rolesRow(trRes.rows, valColId || undefined),
        });
      }
    }
   }catch(e){
     console.error('[Config] vpick dispatcher error:', e);
     return interaction.editReply({ content: `❌ Something went wrong saving your picks: ${e.message || 'unknown error'}. Please try again or start over.`, embeds:[], components:[] }).catch(()=>{});
   }
  }

  if(customId.startsWith('cfg_filtertrait:catsel:')){
    const parts = customId.split(':');
    const kind  = parts[2];
    const colId = parts[3];
    const category = interaction.values[0];
    const backId = kind === 'sales' ? `cfg:col:salesfilters:${colId}` : `cfg:col:filters:${colId}`;

    const isPrimary = colId === 'primary';
    const slug = isPrimary
      ? (cfg.collectionSlug || cfg.slug || '')
      : ((cfg.collections||[])[parseInt(colId)]?.slug || '');

    const valRes = await pgPool.query(
      `SELECT DISTINCT trait_value FROM collection_traits WHERE slug=$1 AND trait_name=$2 ORDER BY trait_value`,
      [slug, category]
    ).catch(()=>({ rows:[] }));

    const values = valRes.rows.map(r => r.trait_value).filter(Boolean);
    if(!values.length){
      return interaction.editReply({ content: `❌ No trait values found for category **${category}**. Try again.`, embeds:[], components:[] });
    }

    if(values.length > 25){
      const sessionKey = `${interaction.user.id}:filtertrait:${kind}:${colId}:${category}`;
      initValuePicker(sessionKey, values);
      const customIdPrefix = `filtertrait:${kind}:${colId}:${encodeURIComponent(category)}`;
      const { rows, truncatedNote } = buildStackedValuePickerRows(sessionKey, customIdPrefix, {
        placeholder: 'Pick one or more values...',
        cancelId: backId,
      });
      return interaction.editReply({
        content: `**Adding ${kind === 'sales' ? '💰 Sales' : '🔍 Listing'} Filter**\n\nCategory: **${category}**\nStep 2 of 2 — Pick the trait value(s) to filter by${truncatedNote}\n\nPicks save as soon as you make them — pick from as many of the menus below as you want.`,
        embeds: [],
        components: rows,
      });
    }

    const valOptions = values.map(v =>
      new StringSelectMenuOptionBuilder().setLabel(v).setValue(v)
    );

    const valMenu = new StringSelectMenuBuilder()
      .setCustomId(`cfg_filtertrait:valsel:${kind}:${colId}:${encodeURIComponent(category)}`)
      .setPlaceholder('Step 2 of 2 — Pick one or more values...')
      .setMinValues(1)
      .setMaxValues(valOptions.length)
      .addOptions(valOptions);

    return interaction.editReply({
      content: `**Adding ${kind === 'sales' ? '💰 Sales' : '🔍 Listing'} Filter**\n\nCategory: **${category}**\nStep 2 of 2 — Pick the trait value(s) to filter by:`,
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(valMenu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(backId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  }

  // ── Filter values selected → save ───────────────────────────────────────
  if(customId.startsWith('cfg_filtertrait:valsel:')){
    const parts    = customId.split(':');
    const kind     = parts[2];
    const colId    = parts[3];
    const category = decodeURIComponent(parts[4]);
    const selectedValues = interaction.values.map(v => v.toLowerCase());
    const fieldKey = kind === 'sales' ? 'salesFilters' : 'listingFilters';
    const catKey   = category.toLowerCase();

    const isPrimary = colId === 'primary';
    if(isPrimary){
      if(!cfg[fieldKey]) cfg[fieldKey] = {};
      const existing = cfg[fieldKey][catKey] || [];
      cfg[fieldKey][catKey] = [...new Set([...existing, ...selectedValues])];
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]){
        if(!cols[idx][fieldKey]) cols[idx][fieldKey] = {};
        const existing = cols[idx][fieldKey][catKey] || [];
        cols[idx][fieldKey][catKey] = [...new Set([...existing, ...selectedValues])];
        cfg.collections = cols;
      }
    }
    await setConfig(guildId, cfg);

    const col = isPrimary
      ? { ...cfg, [fieldKey]: cfg[fieldKey]||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    const embedFn = kind === 'sales' ? buildColSalesFiltersEmbed : buildColFiltersEmbed;
    const rowFn   = kind === 'sales' ? colSalesFiltersRow : colFiltersRow;
    return interaction.editReply({
      content: `✅ Added **${selectedValues.length}** value${selectedValues.length>1?'s':''} for **${category}**.`,
      embeds: [embedFn(col, colId)],
      components: rowFn(col, colId),
    });
  }

  // ── Manual fallback for >25-value categories ────────────────────────────
  if(customId.startsWith('cfg_filtertrait:manual:')){
    const parts    = customId.split(':');
    const kind     = parts[2];
    const colId    = parts[3];
    const category = decodeURIComponent(parts[4] || '');
    const modal = new ModalBuilder()
      .setCustomId(`cfg_modal:filtertrait:${kind}:${colId}:${encodeURIComponent(category)}`)
      .setTitle(`${category.slice(0,30)} — manual entry`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('filter_trait_values')
          .setLabel('Trait Values — comma separated')
          .setStyle(TextInputStyle.Short).setPlaceholder('Zombie, Ape, Alien').setRequired(true)
      ),
    );
    return interaction.showModal(modal);
  }

  if(customId.startsWith('cfg_col_salesfilter:remove:')){
    const parts = customId.split(':');
    const colId = parts[2];
    const [traitType, traitVal] = interaction.values[0].split('::');
    const isPrimary = colId === 'primary';
    if(isPrimary){
      const filters = cfg.salesFilters || {};
      if(filters[traitType]){
        const arr = Array.isArray(filters[traitType]) ? filters[traitType] : [filters[traitType]];
        const updated = arr.filter(v => v !== traitVal);
        if(updated.length === 0) delete filters[traitType];
        else filters[traitType] = updated;
      }
      cfg.salesFilters = filters;
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]){
        const filters = cols[idx].salesFilters || {};
        if(filters[traitType]){
          const arr = Array.isArray(filters[traitType]) ? filters[traitType] : [filters[traitType]];
          const updated = arr.filter(v => v !== traitVal);
          if(updated.length === 0) delete filters[traitType];
          else filters[traitType] = updated;
        }
        cols[idx].salesFilters = filters;
        cfg.collections = cols;
      }
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { ...cfg, salesFilters: cfg.salesFilters||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    return interaction.editReply({ content:'✅ Filter removed.', embeds:[buildColSalesFiltersEmbed(col, colId)], components:colSalesFiltersRow(col, colId) });
  }

  // ── Pause/Resume toggle (per collection) ─────────────────────────────────
  // ── Vault Listing Alerts channel (Stackers only) ──────────────────────────────
  if(customId.startsWith('cfg:col:vaultalertchan:')){
    const colId = customId.split(':')[3];
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(`cfg_chsel:col:vaultalertchan:${colId}`)
      .setPlaceholder('Pick the Vault Listing Alerts channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the 🏦 Vault Listing Alerts channel:**\n_Leave unset and vault listing alerts post to the Sales Channel instead._', embeds:[], components:[
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cfg:col:clearchan:vaultalert:${colId}`).setLabel('↩️ Reset to Sales Channel').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`cfg:col:view:${colId}`).setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ]});
  }

  if(customId.startsWith('cfg:col:pause:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    if(isPrimary){
      cfg.paused = !cfg.paused;
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]) cols[idx].paused = !cols[idx].paused;
      cfg.collections = cols;
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { contract: cfg.contract, slug: cfg.collectionSlug || cfg.slug, name: cfg.contractName, salesChannel: cfg.channelId, listingsChannel: cfg.listingsChannelId, listingFilters: cfg.listingFilters||{}, salesFilters: cfg.salesFilters||{}, paused: cfg.paused }
      : (cfg.collections||[])[parseInt(colId)];
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });
    const status = col.paused ? '⏸️ Paused' : '▶️ Resumed';
    return interaction.editReply({ content:`${status} for ${col.name||col.slug}.`, embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT, col?.slug === STACKERS_SLUG) });
  }

  // ── Animated toggle ──────────────────────────────────────────────────────────
  if(customId.startsWith('cfg:col:animated:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    if(isPrimary){
      cfg.animated = !cfg.animated;
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]) cols[idx].animated = !cols[idx].animated;
      cfg.collections = cols;
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { contract: cfg.contract, slug: cfg.collectionSlug || cfg.slug, name: cfg.contractName, animated: cfg.animated }
      : (cfg.collections||[])[parseInt(colId)];
    const isOcasCol = col?.contract?.toLowerCase() === OCAS_CONTRACT;
    const isStackersCol = col?.slug === STACKERS_SLUG;
    return interaction.editReply({
      content: `${col?.animated ? '🎞️ Animated ON' : '🖼️ Static'} for **${col?.name||col?.slug}**.`,
      embeds: [buildCollectionEditEmbed(col, isPrimary, isOcasCol)],
      components: collectionEditRow(colId, isPrimary, isOcasCol, isStackersCol)
    });
  }

  // ── Re-backfill traits (admin only, paid tier, 24h cooldown) ────────────────
  if(customId.startsWith('cfg:col:rebackfill:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { contract: cfg.contract, slug: cfg.collectionSlug || cfg.slug, name: cfg.contractName }
      : (cfg.collections||[])[parseInt(colId)];
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });

    // Admin only
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(()=>null);
    const isAdmin = OWNER_DISCORD_IDS.has(String(interaction.user.id))
      || member?.permissions?.has('Administrator')
      || member?.permissions?.has('ManageGuild');
    if(!isAdmin){
      return interaction.editReply({ content:'🔒 Re-backfill requires Administrator or Manage Server permission.', embeds:[], components:[] });
    }

    // Paid tier check (OCAS always free)
    const isOcasCol = col.contract?.toLowerCase() === OCAS_CONTRACT;
    if(!isOcasCol && isPaidFeature(col, 'rebackfill', interaction.user.id)){
      return interaction.editReply({ content:'🔒 Re-backfill is a paid tier feature for non-OCAS collections.', embeds:[], components:[] });
    }

    // 24h cooldown — stored in collection config (bypassed for bot owner)
    const isOwner = OWNER_DISCORD_IDS.has(String(interaction.user.id));
    if(!isOwner){
      const now = Date.now();
      const COOLDOWN_MS = 24 * 60 * 60 * 1000;
      const lastRun = col.last_backfilled_at ? new Date(col.last_backfilled_at).getTime() : 0;
      if(now - lastRun < COOLDOWN_MS){
        const nextRun = new Date(lastRun + COOLDOWN_MS);
        const hrs = Math.ceil((nextRun - now) / 3600000);
        return interaction.editReply({ content:`⏳ Re-backfill is on cooldown. Available again in **${hrs}h**.`, embeds:[], components:[] });
      }
    }

    // Store timestamp before running
    if(isPrimary){
      cfg.last_backfilled_at = new Date().toISOString();
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]) cols[idx].last_backfilled_at = new Date().toISOString();
      cfg.collections = cols;
    }
    await setConfig(guildId, cfg);

    // Run backfill directly — bypasses the "already backfilled" guard in
    // maybeStartBackfill (intentional: this button should be able to force
    // a re-run even after a prior completion), but now goes through the
    // SAME lock (tryClaimBackfillLock) that the auto-trigger path checks —
    // confirmed live that skipping this entirely let a manual re-backfill
    // click collide with an auto-triggered run already in progress for the
    // same slug, running two full concurrent backfills that each burned
    // real Alchemy/OpenSea request volume for no benefit (ON CONFLICT
    // protections meant no data got corrupted, just wasted duplicate work).
    const { backfillCollectionTraits } = require('../lib/collection-backfill');
    const { tryClaimBackfillLock, releaseBackfillLock } = require('../lib/auto-backfill');
    // chain/totalSupply were never passed here, so backfillCollectionTraits()
    // silently fell back to its own default of chain='ethereum' every time —
    // for a non-Ethereum collection (e.g. Robinhood Chain), that means Alchemy
    // gets asked about the contract on the WRONG chain, finds nothing, and the
    // whole run finishes instantly with 0 tokens written and no error at all.
    // The other two call sites (auto-backfill.js, collection-onboard.js)
    // already resolve chain correctly — this one just never did. Reading it
    // straight from the collections table (already confirmed correct) avoids
    // re-hitting OpenSea's API a second time, which is also where the
    // total_supply mismatch came from in the first place.
    const collRow = await pgPool.query(
      `SELECT chain, total_supply FROM collections WHERE slug=$1`, [col.slug]
    ).catch(()=>({ rows:[] }));
    const chain       = collRow.rows[0]?.chain || 'ethereum';
    const totalSupply = collRow.rows[0]?.total_supply || null;

    const claim = await tryClaimBackfillLock(pgPool, col.slug, col.contract).catch(() => ({ claimed: true })); // fail open — a lock-check error shouldn't block a manual retry
    if(!claim.claimed){
      const secondsAgo = Math.round((claim.startedMsAgo || 0) / 1000);
      return interaction.editReply({
        content: `⏳ A backfill is already running for **${col.name||col.slug}** (started ~${secondsAgo}s ago). Please wait for it to finish before starting another — running two at once just wastes API calls without going any faster.`,
        embeds: [], components: [],
      });
    }

    await interaction.editReply({ content:`🔄 Re-backfilling **${col.name||col.slug}**... This may take a minute.`, embeds:[], components:[] });

    backfillCollectionTraits(pgPool, { contract: col.contract, slug: col.slug, chain, totalSupply, guildId, guildName: interaction.guild?.name })
      .then(async stats => {
        await releaseBackfillLock(pgPool, col.slug, { success: true, tokensWritten: stats?.written || 0 });
        // Store animated detection result in collection config
        if(typeof stats?.animated === 'boolean'){
          const freshCfg = getConfig(guildId) || {};
          if(isPrimary){
            freshCfg.animated = stats.animated;
          } else {
            const cols = freshCfg.collections || [];
            const idx = parseInt(colId);
            if(cols[idx]) cols[idx].animated = stats.animated;
            freshCfg.collections = cols;
          }
          await setConfig(guildId, freshCfg).catch(()=>{});
        }
        const animatedNote = stats?.animated ? ' · 🎞️ Animated detected' : '';
        const repairNote = stats?.queuedForRepair
          ? ` (${stats.queuedForRepair} more resolving in the background — check back shortly)`
          : '';
        interaction.followUp({ content:`✅ Re-backfill complete for **${col.name||col.slug}** — ${stats?.written||0} tokens updated${repairNote}${animatedNote}.`, ephemeral: true }).catch(()=>{});
      })
      .catch(e => {
        releaseBackfillLock(pgPool, col.slug, { success: false, error: e.message }).catch(()=>{});
        console.error('[Config rebackfill]', e.message);
        interaction.followUp({ content:`❌ Re-backfill failed: ${e.message}`, ephemeral: true }).catch(()=>{});
      });
    return;
  }

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
  if(customId === 'cfg:col:removeprimary'){
    // setConfig merges {...dbCfg, ...cfg} -- a JS delete removes the key
    // entirely, which the merge then reads as "not in cfg" and silently
    // restores from the database. Explicit null keeps the key present so
    // the merge actually overwrites it.
    cfg.contract = null;
    cfg.contractName = null;
    cfg.collectionSlug = null;
    cfg.slug = null;
    cfg.salesChannel = null;
    cfg.channelId = null;
    cfg.listingsChannel = null;
    cfg.listingsChannelId = null;
    cfg.burnChannel = null;
    cfg.vaultAlertChannel = null;
    cfg.fusionChannel = null;
    cfg.isPaidTier = null;
    cfg.animated = null;
    cfg.listingFilters = null;
    cfg.salesFilters = null;
    cfg.rankAlert = null;
    cfg.paused = null;
    await setConfig(guildId, cfg);
    return interaction.editReply({ content:'✅ Primary collection removed. Click **➕ Add Collection** to set up a new one.', embeds:[buildCollectionsEmbed(cfg)], components:collectionsRow(cfg) });
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

  // ── Bot Access (Bot Manager role) ────────────────────────────────────────
  if(customId === 'cfg:cat:access'){
    return interaction.editReply({ content:'', embeds:[buildAccessEmbed(cfg)], components:accessRow(cfg) });
  }

  // ── Bot Nickname ──────────────────────────────────────────────────────────
  if(customId === 'cfg:cat:nickname'){
    const currentNickname = interaction.guild.members.me?.nickname || null;
    return interaction.editReply({ content:'', embeds:[buildNicknameEmbed(currentNickname)], components:nicknameRow(!!currentNickname) });
  }

  if(customId === 'cfg:nickname:set'){
    const currentNickname = interaction.guild.members.me?.nickname || '';
    const modal = new ModalBuilder().setCustomId('cfg_modal:nickname').setTitle('Set Bot Nickname');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('nickname_input')
        .setLabel('Nickname (max 32 characters)')
        .setStyle(TextInputStyle.Short)
        .setValue(currentNickname)
        .setMaxLength(32)
        .setRequired(true)
    ));
    return interaction.showModal(modal);
  }

  if(customId === 'cfg:nickname:remove'){
    try{
      await interaction.guild.members.me.setNickname(null);
    }catch(e){
      return interaction.editReply({ content:`❌ Couldn't remove the nickname: ${e.message}. Make sure the bot has the "Change Nickname" permission in this server.`, embeds:[], components:[] });
    }
    return interaction.editReply({ content:'', embeds:[buildNicknameEmbed(null)], components:nicknameRow(false) });
  }

  // ── Lotteries (admin view, reuses the same session/dashboard as /lotteries) ──
  if(customId === 'cfg:cat:lotteries'){
    const { fetchAll: fetchAllLotteries, buildDashboardEmbed: buildLotteriesEmbed, dashboardButtons: lotteriesDashboardButtons, sessions: lotterySessions } = require('./lotteries');
    const all = await fetchAllLotteries(pgPool, guildId);
    // Reaching this point already passed /config's own access gate, so admin controls are always on here.
    lotterySessions.set(interaction.user.id, { page:0, filter:'all', all, isAdmin:true, fromConfig:true });
    const { embed, pages } = buildLotteriesEmbed(all, 0, 'all');
    const rows = lotteriesDashboardButtons(0, pages, 'all', true);
    // Nav row (row index 1) already has Prev/Next/Refresh/←config — append Giveaway
    // Settings onto the same row so it sits right next to the /config button.
    const navRow = rows[1];
    if(navRow && navRow.components && navRow.components.length < 5){
      navRow.addComponents(
        new ButtonBuilder().setCustomId('cfg:lotteries:settings').setLabel('⚙️ Settings').setStyle(ButtonStyle.Secondary)
      );
    } else {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg:lotteries:settings').setLabel('⚙️ Giveaway Settings').setStyle(ButtonStyle.Secondary)
      ));
    }
    const liveLotteries = all.filter(r=>r.status==='active');
    if(liveLotteries.length>0){
      const { ButtonBuilder: BB, ButtonStyle: BS } = require('discord.js');
      const idBtns = liveLotteries.slice(0,5).map(r=>
        new BB().setCustomId(`ltrs:detail:${r._table}:${r.id}`).setLabel(`${r._table[0].toUpperCase()}${r.id} 🟢`).setStyle(BS.Success)
      );
      rows.push(new ActionRowBuilder().addComponents(idBtns));
    }
    return interaction.editReply({ content:'', embeds:[embed], components:rows });
  }

  // ── Giveaway settings (currently just timezone) ───────────────────────────────
  if(customId === 'cfg:lotteries:settings'){
    const { DEFAULT_LOTTERY_TIMEZONE } = require('../lib/constants');
    const tz = cfg.giveawayTimezone || DEFAULT_LOTTERY_TIMEZONE;
    const now = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle:'full', timeStyle:'short' }).format(new Date());
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('⚙️ Giveaway Settings')
      .setDescription(
        `**Timezone:** \`${tz}\`${cfg.giveawayTimezone ? '' : ' (default)'}\n` +
        `It's currently **${now}** there.\n\n` +
        `This is used when starting a burn lottery or giveaway in \`/giveaway\` with a date-only custom window ` +
        `(e.g. "June 16 2026" instead of "now 24hrs"). Burn lotteries especially rely on this — the entry window ` +
        `needs an exact start/end moment to know which on-chain burns qualify, and a date with no time of day is ` +
        `otherwise ambiguous about which timezone it means.\n\n` +
        `Whoever runs \`/giveaway\` can still type a different timezone directly into that screen to override this ` +
        `for a single giveaway.`
      );
    const tzMenu = new StringSelectMenuBuilder()
      .setCustomId('cfg_tzsel:lotteries')
      .setPlaceholder('Pick a timezone...')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('UK / London').setValue('Europe/London').setDescription('GMT/BST'),
        new StringSelectMenuOptionBuilder().setLabel('Western Europe').setValue('Europe/Paris').setDescription('Paris, Berlin, Madrid, Rome — CET/CEST'),
        new StringSelectMenuOptionBuilder().setLabel('Eastern Europe').setValue('Europe/Athens').setDescription('Athens, Helsinki, Kyiv — EET/EEST'),
        new StringSelectMenuOptionBuilder().setLabel('US Eastern').setValue('America/New_York').setDescription('New York, Miami, Toronto — ET'),
        new StringSelectMenuOptionBuilder().setLabel('US Central').setValue('America/Chicago').setDescription('Chicago, Dallas, Mexico City — CT'),
        new StringSelectMenuOptionBuilder().setLabel('US Mountain').setValue('America/Denver').setDescription('Denver, Phoenix — MT'),
        new StringSelectMenuOptionBuilder().setLabel('US Pacific').setValue('America/Los_Angeles').setDescription('Los Angeles, Seattle, Vancouver — PT'),
        new StringSelectMenuOptionBuilder().setLabel('Brazil').setValue('America/Sao_Paulo').setDescription('São Paulo — BRT'),
        new StringSelectMenuOptionBuilder().setLabel('UAE / Gulf').setValue('Asia/Dubai').setDescription('Dubai, Abu Dhabi — GST'),
        new StringSelectMenuOptionBuilder().setLabel('India').setValue('Asia/Kolkata').setDescription('Mumbai, Delhi, Bangalore — IST'),
        new StringSelectMenuOptionBuilder().setLabel('Singapore / Malaysia').setValue('Asia/Singapore').setDescription('SGT'),
        new StringSelectMenuOptionBuilder().setLabel('Hong Kong / China').setValue('Asia/Hong_Kong').setDescription('HKT/CST'),
        new StringSelectMenuOptionBuilder().setLabel('Japan').setValue('Asia/Tokyo').setDescription('Tokyo, Osaka — JST'),
        new StringSelectMenuOptionBuilder().setLabel('South Korea').setValue('Asia/Seoul').setDescription('Seoul — KST'),
        new StringSelectMenuOptionBuilder().setLabel('Australia East').setValue('Australia/Sydney').setDescription('Sydney, Melbourne — AEST/AEDT'),
        new StringSelectMenuOptionBuilder().setLabel('Australia West').setValue('Australia/Perth').setDescription('Perth — AWST'),
        new StringSelectMenuOptionBuilder().setLabel('New Zealand').setValue('Pacific/Auckland').setDescription('Auckland — NZST/NZDT'),
        new StringSelectMenuOptionBuilder().setLabel('UTC').setValue('UTC').setDescription('No daylight saving offset'),
        new StringSelectMenuOptionBuilder().setLabel('Custom...').setValue('custom').setDescription('Type any IANA timezone manually'),
      );
    return interaction.editReply({ content:'', embeds:[embed], components:[
      new ActionRowBuilder().addComponents(tzMenu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg:cat:lotteries').setLabel('← Back').setStyle(ButtonStyle.Secondary),
      ),
    ]});
  }

  if(customId === 'cfg_tzsel:lotteries'){
    const picked = interaction.values[0];

    if(picked === 'custom'){
      const { DEFAULT_LOTTERY_TIMEZONE } = require('../lib/constants');
      const modal = new ModalBuilder().setCustomId('cfg_modal:lotteries:settz').setTitle('Custom Timezone');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('timezone')
            .setLabel('Timezone (IANA format)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. Europe/Madrid, America/Sao_Paulo, Asia/Manila')
            .setValue(cfg.giveawayTimezone || DEFAULT_LOTTERY_TIMEZONE)
            .setRequired(true)
        ),
      );
      return interaction.showModal(modal);
    }

    const { normalizeLotteryTimezone } = require('../utils/lottery');
    let tz;
    try{
      tz = normalizeLotteryTimezone(picked);
    }catch(e){
      return interaction.editReply({ content: `❌ ${e.message}` });
    }
    cfg.giveawayTimezone = tz;
    await setConfig(guildId, cfg);
    const now = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle:'full', timeStyle:'short' }).format(new Date());
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('⚙️ Giveaway Settings')
      .setDescription(`✅ Giveaway timezone set to \`${tz}\`.\nIt's currently **${now}** there.\n\nThis is used for date-only inputs in \`/giveaway\`'s custom window (e.g. "June 16 2026") — burn lotteries especially need this since the entry window must resolve to an exact start/end moment to know which on-chain burns qualify.`);
    return interaction.editReply({ content:'', embeds:[embed], components:[
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg:lotteries:settings').setLabel('✏️ Change Timezone').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cfg:cat:lotteries').setLabel('← Back').setStyle(ButtonStyle.Secondary),
      ),
    ]});
  }

  if(customId === 'cfg:access:set'){
    const { rows, pageLabel } = buildRolePickerRows(interaction.guild, 'cfg_rolesel:botmanager', 'cfg:cat:access', 'Pick the Bot Manager role');
    return interaction.editReply({ content:'**Select the role that should be able to use `/config`** (in addition to Manage Server admins):'+pageLabel, embeds:[], components: rows });
  }

  if(customId === 'cfg:access:clear'){
    cfg.botManagerRoleId = null;
    await setConfig(guildId, cfg);
    return interaction.editReply({ content:'✅ Bot Manager role cleared.', embeds:[buildAccessEmbed(cfg)], components:accessRow(cfg) });
  }

  // ── Rank Alert (per-collection) ──────────────────────────────────────────
  if(customId.startsWith('cfg:col:rankalert:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { rankAlert: cfg.rankAlert || null }
      : (cfg.collections||[])[parseInt(colId)] || {};
    const colLabel = isPrimary ? (cfg.contractName || 'Primary Collection') : (col.name || col.slug);
    return interaction.editReply({ content:'', embeds:[buildRankAlertEmbed(col, colId, colLabel)], components:rankAlertRow(col, colId) });
  }

  if(customId.startsWith('cfg:rank:set:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    const col = isPrimary ? { rankAlert: cfg.rankAlert||null } : ((cfg.collections||[])[parseInt(colId)]||{});
    const ra = col.rankAlert || {};
    const modal = new ModalBuilder().setCustomId(`cfg_modal:rankalert:${colId}`).setTitle('Set Rank Alert');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rank_min')
          .setLabel('Minimum rank')
          .setStyle(TextInputStyle.Short).setPlaceholder('1')
          .setValue(ra.min ? String(ra.min) : '')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rank_max')
          .setLabel('Maximum rank')
          .setStyle(TextInputStyle.Short).setPlaceholder('100')
          .setValue(ra.max ? String(ra.max) : '')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rank_type')
          .setLabel('Rank system: os or obs')
          .setStyle(TextInputStyle.Short).setPlaceholder('os = OpenSea, obs = TraitView')
          .setValue(ra.rankType || 'os')
          .setRequired(false)
      ),
    );
    return interaction.showModal(modal);
  }

  if(customId.startsWith('cfg:rank:channel:')){
    const colId = customId.split(':')[3];
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(`cfg_chsel:rankalert:${colId}`)
      .setPlaceholder('Pick the rank alert channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the channel for rank alerts** (leave unset to use the listings channel):', embeds:[], components:[
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cfg:col:rankalert:${colId}`).setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ]});
  }

  if(customId.startsWith('cfg:rank:clear:')){
    const colId = customId.split(':')[3];
    const isPrimary = colId === 'primary';
    if(isPrimary){
      cfg.rankAlert = null;
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]) cols[idx].rankAlert = null;
      cfg.collections = cols;
    }
    await setConfig(guildId, cfg);
    const col = isPrimary ? { rankAlert: null } : ((cfg.collections||[])[parseInt(colId)]||{});
    return interaction.editReply({ content:'✅ Rank alert cleared.', embeds:[buildRankAlertEmbed(col, colId)], components:rankAlertRow(col, colId) });
  }
  if(customId === 'cfg:cat:filters'){
    return interaction.editReply({ content:'', embeds:[buildFiltersEmbed(cfg)], components:filtersRow(cfg) });
  }
  if(customId === 'cfg:filter:add'){
    const modal = new ModalBuilder().setCustomId('cfg_modal:filter').setTitle('Add Listing Filter');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('filter_trait_type')
          .setLabel('Trait Category (e.g. Type, Background)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Type')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('filter_trait_values')
          .setLabel('Trait Values — comma separated')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Zombie, Ape, Alien')
          .setRequired(true)
      ),
    );
    return interaction.showModal(modal);
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
        .setValue(cfg.collectionSlug || cfg.slug || '')
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
    return interaction.editReply({ content:`**Select the ${label} channel:**`, embeds:[], components:[
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg:cat:channels').setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ]});
  }

  // ── Verification edits ─────────────────────────────────────────────────────
  if(customId === 'cfg:ver:channel'){
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId('cfg_chsel:verify')
      .setPlaceholder('Pick the verification channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the verification channel:**', embeds:[], components:[
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg:cat:verification').setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ]});
  }
  if(customId === 'cfg:ver:role'){
    const { rows, pageLabel } = buildRolePickerRows(interaction.guild, 'cfg_rolesel:verify', 'cfg:cat:verification', 'Pick the ✅ Verified Wallet role');
    return interaction.editReply({ content:'**Select the ✅ Verified Wallet role:**'+pageLabel, embeds:[], components: rows });
  }
  if(customId === 'cfg:ver:holder'){
    const { rows, pageLabel } = buildRolePickerRows(interaction.guild, 'cfg_rolesel:holder', 'cfg:cat:verification', 'Pick the 🏆 Holder role');
    return interaction.editReply({ content:'**Select the 🏆 Holder role:**'+pageLabel, embeds:[], components: rows });
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
          '→ Add a short code to your OpenSea bio\n' +
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
  if(customId === 'cfg:role:add' || customId.startsWith('cfg:role:add:')){
    const addColId = customId.startsWith('cfg:role:add:') ? customId.split(':')[3] : '';
    const targetId = addColId ? `cfg_traitrole:rolesel:${addColId}` : 'cfg_traitrole:rolesel';
    const cancelId = addColId ? `cfg:col:traitroles:${addColId}` : 'cfg:cat:roles';
    const { rows, pageLabel } = buildRolePickerRows(interaction.guild, targetId, cancelId, 'Pick a role to assign...');
    return interaction.editReply({
      content: '**Step 1 of 3 — Pick the Discord role to assign:**'+pageLabel,
      embeds: [],
      components: rows,
    });
  }

  if(customId.startsWith('cfg_traitrole:manual:')){
    const mParts = customId.split(':');
    const roleId = mParts[2];
    const manColId = mParts[3] || '';
    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    const modal = new ModalBuilder()
      .setCustomId(`cfg_modal:traitrole:${roleId}${manColId ? ':'+manColId : ''}`)
      .setTitle(`Role: ${(role?.name || 'Selected').slice(0, 40)}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_trait_type')
          .setLabel('Trait Category (or _count etc.)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Type, _count, _totalburns, or _maxburn')
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

  // ── Quick modal for _count/_totalburns/_maxburn — number field only, the
  // category is already known from the dropdown pick, no need to retype it ──
  if(customId.startsWith('cfg_traitrole:quickmodal:')){
    const qParts   = customId.split(':');
    const roleId   = qParts[2];
    const qColId   = qParts[3];
    const category = qParts[4];
    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    const fieldLabels = {
      _count:      'Minimum tokens owned (default: 1)',
      _totalburns: 'Minimum burn transactions (default: 1)',
      _maxburn:    'Minimum tokens in one burn (default: 1)',
    };
    const modal = new ModalBuilder()
      .setCustomId(`cfg_modal:trquick:${roleId}:${qColId}:${category}`)
      .setTitle(`Role: ${(role?.name || 'Selected').slice(0, 40)}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_quick_count')
          .setLabel((fieldLabels[category] || 'Minimum count').slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 1, 5, 10')
          .setRequired(false)
      ),
    );
    return interaction.showModal(modal);
  }

  if(customId === 'cfg_traitrole:rolesel' || customId.startsWith('cfg_traitrole:rolesel:')){
    const rsColId = customId.startsWith('cfg_traitrole:rolesel:') ? customId.split(':')[2] : '';
    const roleId = interaction.values[0];
    const role   = await interaction.guild.roles.fetch(roleId).catch(()=>null);

    // Resolve which collection's slug to use for the trait lookup
    let slug;
    if(rsColId && rsColId !== 'primary'){
      const col = (cfg.collections||[])[parseInt(rsColId)];
      slug = col?.slug || '';
    } else {
      slug = cfg.collectionSlug || cfg.slug || '';
    }
    const cancelId = rsColId ? `cfg:col:traitroles:${rsColId}` : 'cfg:cat:roles';
    const suffix = rsColId ? `:${rsColId}` : '';

    const catRes = await pgPool.query(
      `SELECT DISTINCT trait_name FROM collection_traits WHERE slug=$1 ORDER BY trait_name`,
      [slug]
    ).catch(()=>({ rows:[] }));
    if(!catRes.rows.length && !rsColId){
      // fallback to legacy token_traits only for the primary/no-collection flow
      const fallback = await pgPool.query('SELECT DISTINCT trait_name FROM token_traits ORDER BY trait_name').catch(()=>({ rows:[] }));
      catRes.rows = fallback.rows;
    }

    const categories = catRes.rows.map(r => r.trait_name).filter(Boolean);
    if(!categories.length){
      // No trait data available — can't showModal here since interaction is already deferred.
      // Show a button that opens the manual-entry modal on next click instead.
      return interaction.editReply({
        content: `**Adding trait role for ${role?.name || 'role'}**\n\nNo cached trait data found for this collection yet. Click below to enter the trait manually.`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cfg_traitrole:manual:${roleId}${suffix}`).setLabel('✏️ Enter Manually').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(cancelId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }

    // Build category dropdown(s) -- stacked if more than fit in one menu.
    // Special options (Token Count + burn-based, when this is OCAS) always
    // go first, on menu 0 only. Burns are inherently OCAS-only (this bot's
    // burn tracking never applied to any other collection), so those two
    // options only show up when configuring the OCAS collection specifically.
    const isOcasSlug = slug === OCAS_SLUG;
    const specialCount = isOcasSlug ? 3 : 1;
    const CAT_CHUNK = 25;
    const catMenuCount = Math.min(4, Math.ceil((categories.length + specialCount) / CAT_CHUNK));
    const catRows = [];
    for(let i = 0; i < catMenuCount; i++){
      const startIdx = i === 0 ? 0 : i * CAT_CHUNK - specialCount;
      const roomLeft = i === 0 ? CAT_CHUNK - specialCount : CAT_CHUNK;
      const slice = categories.slice(startIdx, startIdx + roomLeft);
      if(!slice.length && i > 0) break;
      const opts = slice.map(c => new StringSelectMenuOptionBuilder().setLabel(c).setValue(c));
      if(i === 0){
        opts.unshift(new StringSelectMenuOptionBuilder()
          .setLabel('🪙 Token Count')
          .setValue('_count')
          .setDescription('Assign role based on how many tokens the user holds')
        );
        if(isOcasSlug){
          opts.unshift(new StringSelectMenuOptionBuilder()
            .setLabel('🔥 Total Burns')
            .setValue('_totalburns')
            .setDescription('Number of separate burn transactions this wallet has ever participated in')
          );
          opts.unshift(new StringSelectMenuOptionBuilder()
            .setLabel('💥 Biggest Single Burn')
            .setValue('_maxburn')
            .setDescription('Largest number of tokens fed into any ONE burn transaction')
          );
        }
      }
      // Fixed-position placeholder ('_' for "no collection id") rather than
      // conditionally omitting the segment -- appending a chunk index after
      // a sometimes-present, sometimes-absent suffix would shift what the
      // handler reads at each position depending on which case applied.
      const m = new StringSelectMenuBuilder()
        .setCustomId(`cfg_traitrole:catsel:${roleId}:${rsColId || '_'}:${i}`)
        .setPlaceholder(catMenuCount > 1 ? `Categories (menu ${i + 1} of ${catMenuCount})` : 'Step 2 of 3 — Pick a trait category...')
        .addOptions(opts.slice(0, 25));
      catRows.push(new ActionRowBuilder().addComponents(m));
    }
    catRows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cancelId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
    ));

    return interaction.editReply({
      content: `**Adding trait role for ${role?.name || 'role'}**

Step 2 of 3 — Pick the trait category:`,
      embeds: [],
      components: catRows,
    });
  }

  // ── Trait role: category selected → show value multi-select ───────────────
  if(customId.startsWith('cfg_traitrole:catsel:')){
    const parts  = customId.split(':');
    const roleId = parts[2];
    const catColId = (parts[3] && parts[3] !== '_') ? parts[3] : '';
    const category = interaction.values[0];
    const cancelId = catColId ? `cfg:col:traitroles:${catColId}` : 'cfg:cat:roles';
    const suffix = catColId ? `:${catColId}` : '';

    // Token count / burn-based shortcuts — already deferred, so show a button that opens the modal next click
    if(category === '_count' || category === '_totalburns' || category === '_maxburn'){
      const labels = {
        _count: ['Token Count Rule', 'Set Token Count', 'the minimum token count'],
        _totalburns: ['Total Burns Rule', 'Set Total Burns', 'the minimum number of burn transactions this wallet has ever done'],
        _maxburn: ['Biggest Single Burn Rule', 'Set Burn Size', 'the minimum tokens in any ONE burn transaction'],
      }[category];
      return interaction.editReply({
        content: `**${labels[0]}**\n\nClick below to set ${labels[2]} for this role.`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cfg_traitrole:quickmodal:${roleId}:${catColId||'_'}:${category}`).setLabel(`✏️ ${labels[1]}`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(cancelId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }

    // Load distinct values for this category — scoped to the selected collection if applicable
    let slugForVal;
    if(catColId && catColId !== 'primary'){
      const col = (cfg.collections||[])[parseInt(catColId)];
      slugForVal = col?.slug || '';
    } else {
      slugForVal = cfg.collectionSlug || cfg.slug || '';
    }
    let valRes = await pgPool.query(
      `SELECT DISTINCT trait_value FROM collection_traits WHERE slug=$1 AND trait_name=$2 ORDER BY trait_value`,
      [slugForVal, category]
    ).catch(()=>({ rows:[] }));
    if(!valRes.rows.length && !catColId){
      valRes = await pgPool.query(
        'SELECT DISTINCT trait_value FROM token_traits WHERE trait_name=$1 ORDER BY trait_value',
        [category]
      ).catch(()=>({ rows:[] }));
    }

    const values = valRes.rows.map(r => r.trait_value).filter(Boolean);
    if(!values.length){
      return interaction.editReply({ content: `❌ No trait values found for category **${category}**. Try again.`, embeds:[], components:[] });
    }

    // Always use the stacked/session picker now, regardless of value count --
    // a minimum-count step needs to happen after Done either way (see the
    // vpick: 'done' handler below), so there's no longer a reason for a
    // separate direct-menu path only for small categories.
    const sessionKey = `${interaction.user.id}:traitrole:${roleId}${suffix}:${category}`;
    initValuePicker(sessionKey, values);
    const customIdPrefix = `traitrole:${roleId}:${catColId || '_'}:${encodeURIComponent(category)}`;
    const { rows, truncatedNote } = buildStackedValuePickerRows(sessionKey, customIdPrefix, {
      placeholder: 'Pick one or more values...',
      cancelId,
      countButton: true,
    });
    return interaction.editReply({
      content: `**Adding trait role**\n\nCategory: **${category}**\nStep 3 of 3 — Pick the trait value(s) that qualify for this role${truncatedNote}\n\nPick from as many of the menus below as you want, then Done to finish (defaults to needing 1), or Set Count first if you want a different minimum.`,
      embeds: [],
      components: rows,
    });
  }

  // ── Trait role: values selected → save one row per value ─────────────────
  if(customId.startsWith('cfg_traitrole:valsel:')){
    const parts    = customId.split(':');
    const roleId   = parts[2];
    const category = decodeURIComponent(parts[3]);
    const valColId = parts[4] || '';
    const selectedValues = interaction.values;

    // Resolve collection_slug to store with each rule — NULL for primary, slug for extra collections
    let collectionSlugForSave = null;
    let colLabel;
    if(valColId && valColId !== 'primary'){
      const col = (cfg.collections||[])[parseInt(valColId)];
      collectionSlugForSave = col?.slug || null;
      colLabel = col?.name || col?.slug;
    }

    for(const val of selectedValues){
      await pgPool.query(
        `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count, collection_slug)
         VALUES ($1,$2,$3,$4,1,$5)
         ON CONFLICT (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count) DO UPDATE SET collection_slug=$5`,
        [guildId, roleId, category, val, collectionSlugForSave]
      ).catch(e => console.warn('[Config] trait_roles insert:', e.message));
    }

    const trRes = valColId ? await traitRolesQFor(collectionSlugForSave) : await traitRolesQ();
    const role  = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    return interaction.editReply({
      content: `✅ Added **${selectedValues.length}** trait role rule${selectedValues.length > 1 ? 's' : ''} for <@&${roleId}>:
${selectedValues.map(v=>`• ${category}: ${v}`).join('\n')}`,
      embeds: [buildRolesEmbed(trRes.rows, colLabel)],
      components: rolesRow(trRes.rows, valColId || undefined),
    });
  }

  // ── Roles: delete select ───────────────────────────────────────────────────
  if(customId === 'cfg_role:delete' || customId.startsWith('cfg_role:delete:')){
    const delColId = customId.startsWith('cfg_role:delete:') ? customId.split(':')[2] : '';
    const rowId = parseInt(interaction.values[0]);
    await pgPool.query('DELETE FROM trait_roles WHERE id=$1 AND guild_id=$2', [rowId, guildId]).catch(()=>{});

    let delCollectionSlug = null;
    let delColLabel;
    if(delColId && delColId !== 'primary'){
      const col = (cfg.collections||[])[parseInt(delColId)];
      delCollectionSlug = col?.slug || null;
      delColLabel = col?.name || col?.slug;
    }

    const trRes = delColId ? await traitRolesQFor(delCollectionSlug) : await traitRolesQ();
    return interaction.editReply({ content:'', embeds:[buildRolesEmbed(trRes.rows, delColLabel)], components:rolesRow(trRes.rows, delColId || undefined) });
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
        if(field==='burnchan')   { cfg.burnChannel = chId; if(syncBurnConfig) syncBurnConfig().catch(()=>{}); }
        if(field==='fusionchan') cfg.fusionChannel = chId;
        if(field==='vaultalertchan') cfg.vaultAlertChannel = chId;
      } else {
        const idx = parseInt(colId);
        if(!cfg.collections) cfg.collections = [];
        if(cfg.collections[idx]){
          if(field==='saleschan')  cfg.collections[idx].salesChannel    = chId;
          if(field==='listchan')   cfg.collections[idx].listingsChannel = chId;
        }
        // burn, fusion, and vault-alert channels are always top-level in cfg
        if(field==='burnchan') { cfg.burnChannel = chId; if(syncBurnConfig) syncBurnConfig().catch(()=>{}); }
        if(field==='fusionchan') cfg.fusionChannel = chId;
        if(field==='vaultalertchan') cfg.vaultAlertChannel = chId;
      }
      await setConfig(guildId, cfg);
      // Cursor persists independently of channel configuration — confirmed
      // live that (re-)setting a channel for a collection that had one
      // configured at some earlier point resumes from a stale cursor
      // position instead of "now", dumping every sale/listing that happened
      // in the gap as if it were brand new. Always reset on (re-)configure
      // so the next poll cycle starts clean.
      {
        const { resetSaleCursor, resetListingCursor } = require('../lib/poll');
        const targetSlug = isPrimary ? (cfg.collectionSlug || cfg.slug) : cfg.collections[parseInt(colId)]?.slug;
        if(targetSlug){
          if(field==='saleschan') resetSaleCursor(guildId, targetSlug);
          if(field==='listchan')  resetListingCursor(guildId, targetSlug);
        }
      }
      const col = isPrimary
        ? { contract:cfg.contract, slug:cfg.collectionSlug||cfg.slug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId }
        : cfg.collections[parseInt(colId)];
      return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT, col?.slug === STACKERS_SLUG) });
    }

    // Standard channel edit
    const type = parts[1];
    if(type === 'sales')    { cfg.salesChannel = chId; cfg.channelId = chId; }
    if(type === 'listings') { cfg.listingsChannel = chId; cfg.listingsChannelId = chId; }
    if(type === 'burn'){     cfg.burnChannel    = chId; if(syncBurnConfig) syncBurnConfig().catch(()=>{}); }
    if(type === 'verify')   cfg.verifyChannel  = chId;
    if(type === 'rankalert'){
      const raColId = parts[2];
      const raIsPrimary = raColId === 'primary';
      if(raIsPrimary){
        if(!cfg.rankAlert) cfg.rankAlert = { min:1, max:100, rankType:'os' };
        cfg.rankAlert.channelId = chId;
      } else {
        const cols = cfg.collections || [];
        const idx = parseInt(raColId);
        if(cols[idx]){
          if(!cols[idx].rankAlert) cols[idx].rankAlert = { min:1, max:100, rankType:'os' };
          cols[idx].rankAlert.channelId = chId;
        }
        cfg.collections = cols;
      }
    }
    await setConfig(guildId, cfg);
    // Same reset as the collection-scoped select above — see there for reasoning.
    if(type === 'sales' || type === 'listings'){
      const { resetSaleCursor, resetListingCursor } = require('../lib/poll');
      const targetSlug = cfg.collectionSlug || cfg.slug;
      if(targetSlug){
        if(type === 'sales')    resetSaleCursor(guildId, targetSlug);
        if(type === 'listings') resetListingCursor(guildId, targetSlug);
      }
    }
    if(type === 'rankalert'){
      const raColId = parts[2];
      const raIsPrimary = raColId === 'primary';
      const col = raIsPrimary ? { rankAlert: cfg.rankAlert||null } : ((cfg.collections||[])[parseInt(raColId)]||{});
      return interaction.editReply({ content:'✅ Rank alert channel set.', embeds:[buildRankAlertEmbed(col, raColId)], components:rankAlertRow(col, raColId) });
    }
    if(type === 'verify'){

    // Auto-sync verification_panels with latest roles
    try{
      await pgPool.query(
        `INSERT INTO verification_panels (guild_id, channel_id, role_id, holder_role_id, min_tokens, welcome_text)
         VALUES ($1, $2, $3, $4, 0, $5)
         ON CONFLICT (guild_id) DO UPDATE SET
           channel_id     = COALESCE($2, verification_panels.channel_id),
           role_id        = COALESCE($3, verification_panels.role_id),
           holder_role_id = COALESCE($4, verification_panels.holder_role_id)`,
        [guildId, cfg.verifyChannel||null, cfg.verifyRole||null, cfg.holderRole||null,
         'Link your wallet to prove ownership and unlock holder roles.']
      );
    }catch(e){ console.warn('[Config] panel sync:', e.message); }
      return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(cfg)], components:verificationRow(cfg) });
    }
    const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
    return interaction.editReply({ content:'', embeds:[buildChannelsEmbed(cfg)], components:channelsRow(isOcas) });
  }

  // ── Role select menus ──────────────────────────────────────────────────────
  if(customId.startsWith('cfg_rolesel:')){
    const type   = customId.split(':')[1];
    const roleId = interaction.values[0];

    if(type === 'botmanager'){
      cfg.botManagerRoleId = roleId;
      await setConfig(guildId, cfg);
      return interaction.editReply({ content:'✅ Bot Manager role set.', embeds:[buildAccessEmbed(cfg)], components:accessRow(cfg) });
    }

    if(type === 'verify') cfg.verifyRole = roleId;
    if(type === 'holder') cfg.holderRole = roleId;
    await setConfig(guildId, cfg);

    // Auto-sync verification_panels with latest roles/channel
    try{
      await pgPool.query(
        `INSERT INTO verification_panels (guild_id, channel_id, role_id, holder_role_id, min_tokens, welcome_text)
         VALUES ($1, $2, $3, $4, 0, $5)
         ON CONFLICT (guild_id) DO UPDATE SET
           channel_id     = COALESCE($2, verification_panels.channel_id),
           role_id        = COALESCE($3, verification_panels.role_id),
           holder_role_id = COALESCE($4, verification_panels.holder_role_id)`,
        [guildId, cfg.verifyChannel||null, cfg.verifyRole||null, cfg.holderRole||null,
         'Link your wallet to prove ownership and unlock holder roles.']
      );
    }catch(e){ console.warn('[Config] panel sync:', e.message); }
    return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(cfg)], components:verificationRow(cfg) });
  }
}

async function handleConfigModal(interaction, ctx){
  const { pgPool, getConfig, setConfig, syncBurnConfig } = ctx;
  const guildId  = interaction.guildId;
  const customId = interaction.customId;

  const accessCfgModal = getConfig(guildId) || {};
  if(!hasConfigAccess(interaction, accessCfgModal)){
    return interaction.reply({ content: NO_ACCESS_MSG, flags: MessageFlags.Ephemeral }).catch(()=>{});
  }

  await interaction.deferUpdate();
  const cfg = getConfig(guildId) || {};

  // ── Set/change bot nickname ─────────────────────────────────────────────────
  if(customId === 'cfg_modal:nickname'){
    const newNickname = interaction.fields.getTextInputValue('nickname_input').trim();
    if(!newNickname) return interaction.editReply({ content:'❌ Nickname cannot be empty.' });
    try{
      await interaction.guild.members.me.setNickname(newNickname);
    }catch(e){
      return interaction.editReply({
        content: `❌ Couldn't set that nickname: ${e.message}. Make sure the bot has the "Change Nickname" permission in this server, and that its role is high enough (Discord won't let a bot change its own nickname if something else is blocking it).`,
        embeds: [], components: [],
      });
    }
    return interaction.editReply({ content:'', embeds:[buildNicknameEmbed(newNickname)], components:nicknameRow(true) });
  }

  // ── Set giveaway timezone ─────────────────────────────────────────────────
  if(customId === 'cfg_modal:lotteries:settz'){
    const { normalizeLotteryTimezone } = require('../utils/lottery');
    const raw = interaction.fields.getTextInputValue('timezone').trim();
    let tz;
    try{
      tz = normalizeLotteryTimezone(raw);
    }catch(e){
      return interaction.editReply({ content: `❌ ${e.message}` });
    }
    cfg.giveawayTimezone = tz;
    await setConfig(guildId, cfg);
    const now = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle:'full', timeStyle:'short' }).format(new Date());
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('⚙️ Giveaway Settings')
      .setDescription(`✅ Giveaway timezone set to \`${tz}\`.\nIt's currently **${now}** there.\n\nThis is used for date-only inputs in \`/giveaway\`'s custom window (e.g. "June 16 2026") — burn lotteries especially need this since the entry window must resolve to an exact start/end moment to know which on-chain burns qualify.`);
    return interaction.editReply({ content:'', embeds:[embed], components:[
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg:lotteries:settings').setLabel('✏️ Change Timezone').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cfg:cat:lotteries').setLabel('← Back').setStyle(ButtonStyle.Secondary),
      ),
    ]});
  }

  // ── Add listing filter ────────────────────────────────────────────────────
  if(customId === 'cfg_modal:filter'){
    const traitType  = interaction.fields.getTextInputValue('filter_trait_type').trim().toLowerCase();
    const valuesRaw  = interaction.fields.getTextInputValue('filter_trait_values').trim();
    const values     = valuesRaw.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
    if(!traitType || !values.length)
      return interaction.editReply({ content:'❌ Trait category and at least one value required.' });
    if(!cfg.listingFilters) cfg.listingFilters = {};
    const existing = cfg.listingFilters[traitType] || [];
    cfg.listingFilters[traitType] = [...new Set([...existing, ...values])];
    await setConfig(guildId, cfg);
    return interaction.editReply({ content:'✅ Filter added.', embeds:[buildFiltersEmbed(cfg)], components:filtersRow(cfg) });
  }

  // ── Edit collection name/alias ──────────────────────────────────────────────
  if(customId.startsWith('cfg_modal:col_name:')){
    const colId    = customId.split(':')[2];
    const newName  = interaction.fields.getTextInputValue('col_name').trim();
    const isPrimary = colId === 'primary';
    if(isPrimary){
      cfg.contractName = newName;
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]) cols[idx].name = newName;
      cfg.collections = cols;
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { contract:cfg.contract, slug:cfg.collectionSlug||cfg.slug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId, listingFilters:cfg.listingFilters||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    return interaction.editReply({ content:'✅ Name updated.', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT, col?.slug === STACKERS_SLUG) });
  }

  // ── Per-collection listing filter modal ────────────────────────────────────
  if(customId.startsWith('cfg_modal:col_filter:')){
    const colId     = customId.split(':')[2];
    const traitType = interaction.fields.getTextInputValue('filter_trait_type').trim().toLowerCase();
    const valuesRaw = interaction.fields.getTextInputValue('filter_trait_values').trim();
    const values    = valuesRaw.split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
    if(!traitType || !values.length)
      return interaction.editReply({ content:'❌ Trait category and at least one value required.' });
    const isPrimary = colId === 'primary';
    if(isPrimary){
      if(!cfg.listingFilters) cfg.listingFilters = {};
      const existing = cfg.listingFilters[traitType] || [];
      cfg.listingFilters[traitType] = [...new Set([...existing, ...values])];
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]){
        if(!cols[idx].listingFilters) cols[idx].listingFilters = {};
        const existing = cols[idx].listingFilters[traitType] || [];
        cols[idx].listingFilters[traitType] = [...new Set([...existing, ...values])];
        cfg.collections = cols;
      }
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { ...cfg, listingFilters: cfg.listingFilters||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    return interaction.editReply({ content:'✅ Filter added.', embeds:[buildColFiltersEmbed(col, colId)], components:colFiltersRow(col, colId) });
  }

  if(customId.startsWith('cfg_modal:col_salesfilter:')){
    const colId     = customId.split(':')[2];
    const traitType = interaction.fields.getTextInputValue('filter_trait_type').trim().toLowerCase();
    const valuesRaw = interaction.fields.getTextInputValue('filter_trait_values').trim();
    const values    = valuesRaw.split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
    if(!traitType || !values.length)
      return interaction.editReply({ content:'❌ Trait category and at least one value required.' });
    const isPrimary = colId === 'primary';
    if(isPrimary){
      if(!cfg.salesFilters) cfg.salesFilters = {};
      const existing = cfg.salesFilters[traitType] || [];
      cfg.salesFilters[traitType] = [...new Set([...existing, ...values])];
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]){
        if(!cols[idx].salesFilters) cols[idx].salesFilters = {};
        const existing = cols[idx].salesFilters[traitType] || [];
        cols[idx].salesFilters[traitType] = [...new Set([...existing, ...values])];
        cfg.collections = cols;
      }
    }
    await setConfig(guildId, cfg);
    const colS = isPrimary
      ? { ...cfg, salesFilters: cfg.salesFilters||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    return interaction.editReply({ content:'✅ Filter added.', embeds:[buildColSalesFiltersEmbed(colS, colId)], components:colSalesFiltersRow(colS, colId) });
  }

  // ── Manual entry for >25-value trait filter categories ───────────────────
  if(customId.startsWith('cfg_modal:filtertrait:')){
    const parts    = customId.split(':');
    const kind     = parts[2];
    const colId    = parts[3];
    const category = decodeURIComponent(parts[4]).toLowerCase();
    const valuesRaw = interaction.fields.getTextInputValue('filter_trait_values').trim();
    const values    = valuesRaw.split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
    if(!values.length)
      return interaction.editReply({ content:'❌ At least one value required.' });

    const fieldKey = kind === 'sales' ? 'salesFilters' : 'listingFilters';
    const isPrimary = colId === 'primary';
    if(isPrimary){
      if(!cfg[fieldKey]) cfg[fieldKey] = {};
      const existing = cfg[fieldKey][category] || [];
      cfg[fieldKey][category] = [...new Set([...existing, ...values])];
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]){
        if(!cols[idx][fieldKey]) cols[idx][fieldKey] = {};
        const existing = cols[idx][fieldKey][category] || [];
        cols[idx][fieldKey][category] = [...new Set([...existing, ...values])];
        cfg.collections = cols;
      }
    }
    await setConfig(guildId, cfg);

    const col = isPrimary
      ? { ...cfg, [fieldKey]: cfg[fieldKey]||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    const embedFn = kind === 'sales' ? buildColSalesFiltersEmbed : buildColFiltersEmbed;
    const rowFn   = kind === 'sales' ? colSalesFiltersRow : colFiltersRow;
    return interaction.editReply({
      content: `✅ Added **${values.length}** value${values.length>1?'s':''} for **${category}**.`,
      embeds: [embedFn(col, colId)],
      components: rowFn(col, colId),
    });
  }

  // ── Rank Alert: min/max/type submitted ────────────────────────────────────
  if(customId.startsWith('cfg_modal:rankalert:')){
    const colId = customId.split(':')[2];
    const isPrimary = colId === 'primary';

    // Defense-in-depth: re-check paid tier at submit time
    const colCheck = isPrimary ? { contract: cfg.contract } : (cfg.collections||[])[parseInt(colId)];
    if(isPaidFeature(colCheck, 'rankalert', interaction.user.id)){
      return interaction.editReply({ content: '🔒 Rank Alert requires a paid tier for non-OCAS collections. Visit traitview.com to upgrade.', embeds:[], components:[] });
    }

    const minRaw  = interaction.fields.getTextInputValue('rank_min').trim();
    const maxRaw  = interaction.fields.getTextInputValue('rank_max').trim();
    const typeRaw = (interaction.fields.getTextInputValue('rank_type') || 'os').trim().toLowerCase();

    const min = parseInt(minRaw);
    const max = parseInt(maxRaw);
    const existingRankAlert = isPrimary ? cfg.rankAlert : ((cfg.collections||[])[parseInt(colId)]?.rankAlert);
    if(!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < 1 || min > 10000 || max > 10000 || min > max){
      const col = isPrimary ? { rankAlert: existingRankAlert||null } : ((cfg.collections||[])[parseInt(colId)]||{});
      return interaction.editReply({ content: '❌ Min and max must be whole numbers between 1 and 10000, with min ≤ max.', embeds:[buildRankAlertEmbed(col, colId)], components:rankAlertRow(col, colId) });
    }
    const rankType = (typeRaw === 'obs') ? 'obs' : 'os';

    const newRankAlert = {
      min, max, rankType,
      channelId: existingRankAlert?.channelId || null, // preserve existing channel if already set
    };
    if(isPrimary){
      cfg.rankAlert = newRankAlert;
    } else {
      const cols = cfg.collections || [];
      const idx = parseInt(colId);
      if(cols[idx]) cols[idx].rankAlert = newRankAlert;
      cfg.collections = cols;
    }
    await setConfig(guildId, cfg);

    const col = isPrimary ? { rankAlert: cfg.rankAlert } : ((cfg.collections||[])[parseInt(colId)]||{});
    return interaction.editReply({ content: '✅ Rank alert saved.', embeds:[buildRankAlertEmbed(col, colId)], components:rankAlertRow(col, colId) });
  }

  // ── Add collection ─────────────────────────────────────────────────────────
  if(customId === 'cfg_modal:addcol'){
    const name     = interaction.fields.getTextInputValue('col_name').trim();
    const slug     = interaction.fields.getTextInputValue('col_slug').trim().toLowerCase();
    const contract = interaction.fields.getTextInputValue('col_contract').trim().toLowerCase();
    if(!cfg.collections) cfg.collections = [];
    cfg.collections.push({ name, slug, contract:contract||null, salesChannel:null, listingsChannel:null });
    await setConfig(guildId, cfg);

    // Backfill all verified wallets in this server for the new collection
    if(slug && contract){
      const { backfillServerWallets } = require('../lib/wallet-backfill');
      pgPool.query(`SELECT chain FROM collections WHERE slug = $1`, [slug])
        .then(r => backfillServerWallets(guildId, contract, slug, pgPool, process.env.ALCHEMY_API_KEY, r.rows[0]?.chain || 'ethereum'))
        .catch(()=>{});
    }

    // Every server gets an automatic trait backfill for any new non-OCAS
    // collection — this is what powers /traitfind, /rankfind, and trait-
    // filtered listings for that collection. Free tier now includes this
    // (confirmed safe: a single collection backfill is ~100 Alchemy calls
    // total, and the lock in lib/auto-backfill.js guarantees any given
    // slug is only ever backfilled once across all servers/time, so the
    // repeated-manual-invocation pattern that caused a real CU spike during
    // tonight's debugging — same collection re-backfilled many times with
    // no lock — cannot happen through this automated path). Skips silently
    // if this slug was already backfilled by ANY server in the past — see
    // lib/auto-backfill.js for the detection logic. Rank computation
    // remains the actual paid-tier differentiator, separately, and is not
    // part of this backfill at all.
    let waitMsg = '';
    if(slug && contract){
      try{
        const { maybeStartBackfill } = require('../lib/auto-backfill');
        const result = await maybeStartBackfill(pgPool, { contract, slug, guildId, guildName: interaction.guild?.name });
        if(result.needed) waitMsg = '\n\n⏳ Please wait 1-2 minutes while trait search data is being loaded for this collection. Listings and sales are already live.';
      }catch(e){ console.warn('[Config] auto-backfill trigger failed:', e.message); }
    }

    return interaction.editReply({ content:`✅ Collection added.${waitMsg}`, embeds:[buildCollectionsEmbed(cfg)], components:collectionsRow(cfg) });
  }

  // ── Edit collection field (contract or slug) ───────────────────────────────
  if(customId.startsWith('cfg_modal:editcol:')){
    const parts = customId.split(':'); // cfg_modal editcol field colId
    const field = parts[2];
    const colId = parts[3];
    const val   = interaction.fields.getTextInputValue('value_input').trim();
    const isPrimary = colId === 'primary';
    let waitMsg = '';

    if(isPrimary){
      if(field==='contract'){
        const c = val.toLowerCase();
        if(!/^0x[0-9a-f]{40}$/i.test(c)) return interaction.editReply({ content:'❌ Invalid contract address.' });
        cfg.contract = c;
        if(c === OCAS_CONTRACT){ cfg.contractName='On-Chain All Stars'; cfg.collectionSlug=OCAS_SLUG; cfg.isOcas=true; }
        else cfg.isOcas=false;
      }
      if(field==='slug'){
        cfg.collectionSlug = val.toLowerCase();
        fetchAndStoreCollectionTraits(cfg.collectionSlug, pgPool).catch(()=>{});

        // Primary-collection slug being set is the completion point for a
        // /setup-driven non-OCAS collection (contract is set in a separate
        // prior modal submission, slug here) — same auto-backfill trigger
        // as cfg_modal:addcol, free tier, for the same reason (see comment there).
        if(cfg.collectionSlug && cfg.contract){
          try{
            const { maybeStartBackfill } = require('../lib/auto-backfill');
            const result = await maybeStartBackfill(pgPool, { contract: cfg.contract, slug: cfg.collectionSlug || cfg.slug, guildId, guildName: interaction.guild?.name });
            if(result.needed) waitMsg = '\n\n⏳ Please wait 1-2 minutes while trait search data is being loaded for this collection. Listings and sales are already live.';
          }catch(e){ console.warn('[Config] auto-backfill trigger failed:', e.message); }
        }
      }
    } else {
      const idx = parseInt(colId);
      if(!cfg.collections?.[idx]) return interaction.editReply({ content:'❌ Collection not found.' });
      if(field==='contract'){
        const c = val.toLowerCase();
        if(!/^0x[0-9a-f]{40}$/i.test(c)) return interaction.editReply({ content:'❌ Invalid contract address.' });
        cfg.collections[idx].contract = c;
      }
      if(field==='slug'){
        cfg.collections[idx].slug = val.toLowerCase();
        fetchAndStoreCollectionTraits(cfg.collections[idx].slug, pgPool).catch(()=>{});
        // Trigger wallet backfill if both contract and slug are now set
        if(cfg.collections[idx].contract && cfg.collections[idx].slug){
          const { backfillServerWallets } = require('../lib/wallet-backfill');
          const colContract = cfg.collections[idx].contract, colSlug = cfg.collections[idx].slug;
          pgPool.query(`SELECT chain FROM collections WHERE slug = $1`, [colSlug])
            .then(r => backfillServerWallets(guildId, colContract, colSlug, pgPool, process.env.ALCHEMY_API_KEY, r.rows[0]?.chain || 'ethereum'))
            .catch(()=>{});
        }
      }
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { contract:cfg.contract, slug:cfg.collectionSlug||cfg.slug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId }
      : cfg.collections[parseInt(colId)];
    return interaction.editReply({ content:`✅ Updated.${waitMsg}`, embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT, col?.slug === STACKERS_SLUG) });
  }

  // ── Add trait role ─────────────────────────────────────────────────────────
  if(customId.startsWith('cfg_modal:traitrole:')){
    const modParts     = customId.split(':');
    const roleId        = modParts[2];
    const modColId       = modParts[3] || '';
    const traitTypeRaw = interaction.fields.getTextInputValue('tr_trait_type').trim();
    const traitVal     = interaction.fields.getTextInputValue('tr_trait_value').trim();
    const minCount     = parseInt(interaction.fields.getTextInputValue('tr_min_count').trim()) || 1;
    // If no trait category entered, treat as a token count rule
    const traitType    = traitTypeRaw || '_count';

    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    if(!role)
      return interaction.editReply({ content:'❌ Role not found. Please try again.' });

    // Resolve collection_slug — NULL for primary, slug for extra collections
    let modCollectionSlug = null;
    let modColLabel;
    if(modColId && modColId !== 'primary'){
      const col = (cfg.collections||[])[parseInt(modColId)];
      modCollectionSlug = col?.slug || null;
      modColLabel = col?.name || col?.slug;
    }

    await pgPool.query(
      `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count, collection_slug)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count) DO UPDATE SET collection_slug=$6`,
      [guildId, roleId, traitType, traitVal||'', minCount, modCollectionSlug]
    ).catch(e => console.warn('[Config] trait_roles insert:', e.message));

    const trRes = modColId
      ? await pgPool.query(
          modCollectionSlug
            ? 'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 AND collection_slug=$2 ORDER BY trait_type, trait_value'
            : 'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 AND collection_slug IS NULL ORDER BY trait_type, trait_value',
          modCollectionSlug ? [guildId, modCollectionSlug] : [guildId]
        ).catch(()=>({ rows:[] }))
      : await pgPool.query(
          'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
          [guildId]
        ).catch(()=>({ rows:[] }));

    return interaction.editReply({ content:'✅ Trait role added.', embeds:[buildRolesEmbed(trRes.rows, modColLabel)], components:rolesRow(trRes.rows, modColId || undefined) });
  }

  // ── Quick modal submit — category already known from the button, just the number ──
  if(customId.startsWith('cfg_modal:trquick:')){
    const qParts   = customId.split(':');
    const roleId   = qParts[2];
    const qColId   = qParts[3];
    const category = qParts[4];
    const minCount = parseInt(interaction.fields.getTextInputValue('tr_quick_count').trim()) || 1;

    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    if(!role)
      return interaction.editReply({ content:'❌ Role not found. Please try again.' });

    const modColId = (qColId && qColId !== '_') ? qColId : '';
    let modCollectionSlug = null;
    let modColLabel;
    if(modColId && modColId !== 'primary'){
      const col = (cfg.collections||[])[parseInt(modColId)];
      modCollectionSlug = col?.slug || null;
      modColLabel = col?.name || col?.slug;
    }

    await pgPool.query(
      `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count, collection_slug)
       VALUES ($1,$2,$3,'',$4,$5)
       ON CONFLICT (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count) DO UPDATE SET collection_slug=$5`,
      [guildId, roleId, category, minCount, modCollectionSlug]
    ).catch(e => console.warn('[Config] trait_roles insert:', e.message));

    const trRes = modColId
      ? await pgPool.query(
          modCollectionSlug
            ? 'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 AND collection_slug=$2 ORDER BY trait_type, trait_value'
            : 'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 AND collection_slug IS NULL ORDER BY trait_type, trait_value',
          modCollectionSlug ? [guildId, modCollectionSlug] : [guildId]
        ).catch(()=>({ rows:[] }))
      : await pgPool.query(
          'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
          [guildId]
        ).catch(()=>({ rows:[] }));

    return interaction.editReply({ content:'✅ Trait role added.', embeds:[buildRolesEmbed(trRes.rows, modColLabel)], components:rolesRow(trRes.rows, modColId || undefined) });
  }

  // ── Trait role count modal — finalize the session with the chosen minimum ──
  if(customId.startsWith('cfg_modal:trcount:')){
    const tcParts   = customId.split(':');
    const roleId    = tcParts[2];
    const tcColId   = tcParts[3];
    const category  = decodeURIComponent(tcParts[4]);
    const valColId  = (tcColId && tcColId !== '_') ? tcColId : '';
    const minCount  = parseInt(interaction.fields.getTextInputValue('tr_count_min').trim()) || 1;

    const suffix = valColId ? `:${valColId}` : '';
    const sessionKey = `${interaction.user.id}:traitrole:${roleId}${suffix}:${category}`;
    const session = getValuePickerSession(sessionKey);
    if(!session || !session.selected.size){
      return interaction.editReply({ content: '❌ This session expired before you set a count. Please pick the value(s) again.', embeds:[], components:[] });
    }
    const selectedValues = [...session.selected];
    clearValuePicker(sessionKey);

    let collectionSlugForSave = null;
    let colLabel;
    if(valColId && valColId !== 'primary'){
      const col = (cfg.collections||[])[parseInt(valColId)];
      collectionSlugForSave = col?.slug || null;
      colLabel = col?.name || col?.slug;
    }

    for(const val of selectedValues){
      await pgPool.query(
        `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count, collection_slug)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count) DO UPDATE SET collection_slug=$6`,
        [guildId, roleId, category, val, minCount, collectionSlugForSave]
      ).catch(e => console.warn('[Config] trait_roles insert:', e.message));
    }

    const trRes = valColId
      ? await pgPool.query(
          collectionSlugForSave
            ? 'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 AND collection_slug=$2 ORDER BY trait_type, trait_value'
            : 'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 AND collection_slug IS NULL ORDER BY trait_type, trait_value',
          collectionSlugForSave ? [guildId, collectionSlugForSave] : [guildId]
        ).catch(()=>({ rows:[] }))
      : await pgPool.query(
          'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
          [guildId]
        ).catch(()=>({ rows:[] }));
    return interaction.editReply({
      content: `✅ Added **${selectedValues.length}** trait role rule${selectedValues.length > 1 ? 's' : ''} for <@&${roleId}> (need ${minCount}+):\n${selectedValues.map(v=>`• ${category}: ${v}`).join('\n')}`,
      embeds: [buildRolesEmbed(trRes.rows, colLabel)],
      components: rolesRow(trRes.rows, valColId || undefined),
    });
  }
}

const CONFIG_COMMANDS = new Set(['config']);
module.exports = { handleConfigCommand, handleConfigButton, handleConfigModal, CONFIG_COMMANDS };



























