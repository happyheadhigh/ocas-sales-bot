'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ChannelType,
} = require('discord.js');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';

// ── Fetch & cache traits from OpenSea for a collection slug ──────────────────
async function fetchAndStoreCollectionTraits(slug, pgPool){
  if(!slug) return;
  try{
    const { OPENSEA_KEY, osHeaders } = require('../lib/constants');
    const fetch = require('node-fetch');
    const res = await fetch(
      `https://api.opensea.io/api/v2/traits/${slug}`,
      { headers: osHeaders() }
    );
    if(!res.ok){ console.warn('[TraitCache] OS traits fetch failed:', res.status, slug); return; }
    const data = await res.json();
    // OS v2 traits response: { categories: { "Type": "string" }, counts: { "Type": { "Zombie": 123 } } }
    const counts = data.counts || {};
    let count = 0;
    for(const [traitName, valueCounts] of Object.entries(counts)){
      if(typeof valueCounts !== 'object' || Array.isArray(valueCounts)) continue;
      for(const [val, cnt] of Object.entries(valueCounts)){
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

function dashboardRow(){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:cat:collection').setLabel('📦 Collections').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:channels').setLabel('📡 Channels').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:verification').setLabel('🔐 Verification').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:roles').setLabel('🎭 Roles').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg:cat:rankalert').setLabel('🏆 Rank Alert').setStyle(ButtonStyle.Secondary),
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
      `**Listing Filters:** ${Object.keys(col.listingFilters||{}).length} active\n` +
      `**Sales Filters:** ${Object.keys(col.salesFilters||{}).length} active\n` +
      `**Status:** ${col.paused ? '⏸️ Paused' : '▶️ Active'}\n` +
      (isOcas ? '\n🔥 **OCAS** — full feature set active.\n' : '') +
      '\n*Changes save immediately.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function collectionEditRow(colId, isPrimary, isOcas=false){
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cfg:col:name:${colId}`).setLabel('✏️ Name').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`cfg:col:slug:${colId}`).setLabel('🔗 Slug').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`cfg:col:filters:${colId}`).setLabel('🔍 Listings').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`cfg:col:salesfilters:${colId}`).setLabel('💰 Sales').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`cfg:col:pause:${colId}`).setLabel('⏸️ Pause').setStyle(ButtonStyle.Secondary),
  );
  const row1b = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cfg:col:saleschan:${colId}`).setLabel('🟢 Sales Ch.').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`cfg:col:clearchan:sales:${colId}`).setLabel('✕ Sales').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cfg:col:listchan:${colId}`).setLabel('📋 Listings Ch.').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`cfg:col:clearchan:listings:${colId}`).setLabel('✕ Listings').setStyle(ButtonStyle.Danger),
  );
  const rows = [row1, row1b];
  const row3Btns = [
    new ButtonBuilder().setCustomId(`cfg:col:traitroles:${colId}`).setLabel('🎭 Trait Roles').setStyle(ButtonStyle.Secondary),
  ];
  if(isOcas){
    row3Btns.push(
      new ButtonBuilder().setCustomId(`cfg:col:burnchan:${colId}`).setLabel('🔥 Burn Ch.').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:col:clearchan:burn:${colId}`).setLabel('✕ Burn').setStyle(ButtonStyle.Danger),
    );
  }
  rows.push(new ActionRowBuilder().addComponents(row3Btns));
  const row2Btns = [
    new ButtonBuilder().setCustomId('cfg:cat:collection').setLabel('← Collections').setStyle(ButtonStyle.Secondary),
  ];
  if(!isPrimary) row2Btns.push(
    new ButtonBuilder().setCustomId(`cfg:col:remove:${colId}`).setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger)
  );
  rows.push(new ActionRowBuilder().addComponents(row2Btns));
  return rows;
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

// ── Rank Alert screen ────────────────────────────────────────────────────────
function buildRankAlertEmbed(cfg){
  const ra = cfg.rankAlert;
  const rankLabel = ra?.rankType === 'obs' ? 'TraitView Observed' : 'OpenSea';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🏆 Rank Alert')
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

function rankAlertRow(cfg){
  const hasAlert = !!cfg.rankAlert;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg:rank:set').setLabel(hasAlert ? '✏️ Edit Range' : '➕ Set Rank Alert').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cfg:rank:channel').setLabel('📌 Channel').setStyle(ButtonStyle.Secondary).setDisabled(!hasAlert),
      new ButtonBuilder().setCustomId('cfg:rank:clear').setLabel('🗑️ Clear').setStyle(ButtonStyle.Danger).setDisabled(!hasAlert),
      new ButtonBuilder().setCustomId('cfg:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];
}


// ── Roles screen ──────────────────────────────────────────────────────────────
function buildRolesEmbed(traitRoles, collectionLabel){
  const list = traitRoles.length === 0
    ? '*No trait roles configured yet.*'
    : traitRoles.map((r, i) =>
        `**${i+1}.** ${r.role_id ? `<@&${r.role_id}>` : 'Unknown Role'} — ` +
        (r.trait_type === '_count'
          ? `Own ${r.minimum_count}+ tokens`
          : `${r.trait_type}: ${r.trait_value || 'any'}${r.minimum_count > 1 ? ` ×${r.minimum_count}` : ''}`)
      ).join('\n');

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(collectionLabel ? `🎭 Trait Roles — ${collectionLabel}` : '🎭 Trait Roles')
    .setDescription(
      SEP + '\n\n' +
      list + '\n\n' +
      '*Roles are assigned automatically when a member verifies\nand re-synced every 24 hours.*'
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
        .setLabel(`${i+1}. ${r.trait_type === '_count' ? `Own ${r.minimum_count}+ tokens` : `${r.trait_type}: ${r.trait_value || 'any'}`}`)
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
  const trRes = await pgPool.query(
    'SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value',
    [interaction.guildId]
  ).catch(()=>({ rows:[] }));
  return interaction.editReply({
    embeds: [buildDashboardEmbed(cfg, trRes.rows)],
    components: dashboardRow(),
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

  const catOptions = categories.slice(0, 25).map(c =>
    new StringSelectMenuOptionBuilder().setLabel(c).setValue(c)
  );

  const catMenu = new StringSelectMenuBuilder()
    .setCustomId(`cfg_filtertrait:catsel:${kind}:${colId}`)
    .setPlaceholder('Step 1 of 2 — Pick a trait category...')
    .addOptions(catOptions);

  return interaction.editReply({
    content: `**Adding ${kindLabel} Filter**\n\nStep 1 of 2 — Pick the trait category:`,
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(catMenu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(backId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function handleConfigButton(interaction, ctx){
  const { pgPool, getConfig, setConfig, syncBurnConfig } = ctx;
  const guildId  = interaction.guildId;
  const customId = interaction.customId;

  // Modals open with showModal (their own response) — everything else defers first
  const isModal = customId === 'cfg:col:contract' || customId === 'cfg:col:slug' ||
                  customId === 'cfg:col:add' ||
                  customId === 'cfg:filter:add' ||
                  customId === 'cfg:rank:set' ||
                  customId.startsWith('cfg_traitrole:manual:') ||
                  customId.startsWith('cfg_filtertrait:manual:') ||
                  customId.startsWith('cfg:col:name:') ||
                  customId.startsWith('cfg:col:contract:') || customId.startsWith('cfg:col:slug:');
  if(!isModal) await interaction.deferUpdate();

  const cfg = getConfig(guildId) || {};

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
      ? { contract: cfg.contract, slug: cfg.collectionSlug, name: cfg.contractName, salesChannel: cfg.channelId, listingsChannel: cfg.listingsChannelId, listingFilters: cfg.listingFilters||{}, salesFilters: cfg.salesFilters||{}, paused: cfg.paused }
      : (cfg.collections||[])[parseInt(colId)];
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });
    return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT) });
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
  if(customId.startsWith('cfg:col:clearchan:')){
    const parts = customId.split(':');
    const field  = parts[3]; // 'sales' or 'listings'
    const colId  = parts[4];
    const isPrimary = colId === 'primary';
    if(isPrimary){
      if(field === 'sales')    { delete cfg.channelId; delete cfg.salesChannel; }
      if(field === 'listings') { delete cfg.listingsChannelId; delete cfg.listingsChannel; }
      if(field === 'burn')     { delete cfg.burnChannel; if(syncBurnConfig) syncBurnConfig().catch(()=>{}); }
    } else {
      const idx = parseInt(colId);
      if(cfg.collections?.[idx]){
        if(field === 'sales')    cfg.collections[idx].salesChannel    = null;
        if(field === 'listings') cfg.collections[idx].listingsChannel = null;
      }
      // burn channel is always top-level in cfg
      if(field === 'burn') { delete cfg.burnChannel; if(syncBurnConfig) syncBurnConfig().catch(()=>{}); }
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { contract:cfg.contract, slug:cfg.collectionSlug||cfg.slug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId, listingFilters:cfg.listingFilters||{} }
      : cfg.collections?.[parseInt(colId)] || {};
    return interaction.editReply({ content:'✅ Channel cleared.', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)
], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT) });
  }

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

  if(customId.startsWith('cfg:col:burnchan:')){
    const colId = customId.split(':')[3];
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(`cfg_chsel:col:burnchan:${colId}`)
      .setPlaceholder('Pick the Burn Alerts channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the 🔥 Burn Alerts channel:**', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
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
      ? { contract: cfg.contract, slug: cfg.collectionSlug, name: cfg.contractName, salesChannel: cfg.channelId, listingsChannel: cfg.listingsChannelId, listingFilters: cfg.listingFilters||{}, salesFilters: cfg.salesFilters||{}, paused: cfg.paused }
      : (cfg.collections||[])[parseInt(colId)];
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });
    return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT) });
  }

  // Remove extra collection
  if(customId.startsWith('cfg:col:filters:back:')){
    const colId = customId.split(':')[4];
    const isPrimary = colId === 'primary';
    const col = isPrimary
      ? { contract:cfg.contract, slug:cfg.collectionSlug||cfg.slug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId, listingFilters:cfg.listingFilters||{} }
      : (cfg.collections||[])[parseInt(colId)] || {};
    return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT) });
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
      ? { contract: cfg.contract, slug: cfg.collectionSlug, name: cfg.contractName, salesChannel: cfg.channelId, listingsChannel: cfg.listingsChannelId, listingFilters: cfg.listingFilters||{}, salesFilters: cfg.salesFilters||{}, paused: cfg.paused }
      : (cfg.collections||[])[parseInt(colId)];
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });
    return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT) });
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
      return interaction.editReply({
        content: `**${category}** has ${values.length} values — too many to list in a dropdown.\n\nClick below to enter the value(s) manually.\nExamples: ${values.slice(0,3).join(', ')}...`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cfg_filtertrait:manual:${kind}:${colId}:${encodeURIComponent(category)}`).setLabel('✏️ Enter Manually').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(backId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
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
      ? { contract: cfg.contract, slug: cfg.collectionSlug, name: cfg.contractName, salesChannel: cfg.channelId, listingsChannel: cfg.listingsChannelId, listingFilters: cfg.listingFilters||{}, salesFilters: cfg.salesFilters||{}, paused: cfg.paused }
      : (cfg.collections||[])[parseInt(colId)];
    if(!col) return interaction.editReply({ content:'❌ Collection not found.', embeds:[], components:[] });
    const status = col.paused ? '⏸️ Paused' : '▶️ Resumed';
    return interaction.editReply({ content:`${status} for ${col.name||col.slug}.`, embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT) });
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
  if(customId === 'cfg:cat:rankalert'){
    return interaction.editReply({ content:'', embeds:[buildRankAlertEmbed(cfg)], components:rankAlertRow(cfg) });
  }

  if(customId === 'cfg:rank:set'){
    const ra = cfg.rankAlert || {};
    const modal = new ModalBuilder().setCustomId('cfg_modal:rankalert').setTitle('Set Rank Alert');
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
          .setLabel('Rank system: "os" (OpenSea) or "obs" (TraitView)')
          .setStyle(TextInputStyle.Short).setPlaceholder('os')
          .setValue(ra.rankType || 'os')
          .setRequired(false)
      ),
    );
    return interaction.showModal(modal);
  }

  if(customId === 'cfg:rank:channel'){
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId('cfg_chsel:rankalert')
      .setPlaceholder('Pick the rank alert channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the channel for rank alerts** (leave unset to use the listings channel):', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }

  if(customId === 'cfg:rank:clear'){
    cfg.rankAlert = null;
    await setConfig(guildId, cfg);
    return interaction.editReply({ content:'✅ Rank alert cleared.', embeds:[buildRankAlertEmbed(cfg)], components:rankAlertRow(cfg) });
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
    const roleMenu = new RoleSelectMenuBuilder()
      .setCustomId(addColId ? `cfg_traitrole:rolesel:${addColId}` : 'cfg_traitrole:rolesel')
      .setPlaceholder('Pick a role to assign...');
    const cancelId = addColId ? `cfg:col:traitroles:${addColId}` : 'cfg:cat:roles';
    return interaction.editReply({
      content: '**Step 1 of 3 — Pick the Discord role to assign:**',
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(roleMenu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(cancelId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
        ),
      ],
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

    // Build category dropdown (cap at 25)
    const catOptions = categories.slice(0, 24).map(c =>
      new StringSelectMenuOptionBuilder().setLabel(c).setValue(c)
    );
    // Always include token count option
    catOptions.unshift(new StringSelectMenuOptionBuilder()
      .setLabel('🪙 Token Count (own N or more)')
      .setValue('_count')
      .setDescription('Assign role based on how many tokens the user holds')
    );

    const catMenu = new StringSelectMenuBuilder()
      .setCustomId(`cfg_traitrole:catsel:${roleId}${suffix}`)
      .setPlaceholder('Step 2 of 3 — Pick a trait category...')
      .addOptions(catOptions.slice(0, 25));

    return interaction.editReply({
      content: `**Adding trait role for ${role?.name || 'role'}**

Step 2 of 3 — Pick the trait category:`,
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(catMenu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(cancelId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
  }

  // ── Trait role: category selected → show value multi-select ───────────────
  if(customId.startsWith('cfg_traitrole:catsel:')){
    const parts  = customId.split(':');
    const roleId = parts[2];
    const catColId = parts[3] || '';
    const category = interaction.values[0];
    const cancelId = catColId ? `cfg:col:traitroles:${catColId}` : 'cfg:cat:roles';
    const suffix = catColId ? `:${catColId}` : '';

    // Token count shortcut — already deferred, so show a button that opens the modal next click
    if(category === '_count'){
      return interaction.editReply({
        content: `**Token Count Rule**\n\nClick below to set the minimum token count for this role.`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cfg_traitrole:manual:${roleId}${suffix}`).setLabel('✏️ Set Token Count').setStyle(ButtonStyle.Primary),
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

    // If more than 25 values, fall back to manual entry — Discord select menus cap at 25
    if(values.length > 25){
      return interaction.editReply({
        content: `**${category}** has ${values.length} values — too many to list in a dropdown.\n\nClick below to enter the trait value manually.\nExamples: ${values.slice(0,3).join(', ')}...`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cfg_traitrole:manual:${roleId}${suffix}`).setLabel('✏️ Enter Manually').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(cancelId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }

    const valOptions = values.map(v =>
      new StringSelectMenuOptionBuilder().setLabel(v).setValue(v)
    );

    const valMenu = new StringSelectMenuBuilder()
      .setCustomId(`cfg_traitrole:valsel:${roleId}:${encodeURIComponent(category)}${suffix}`)
      .setPlaceholder('Step 3 of 3 — Pick one or more values...')
      .setMinValues(1)
      .setMaxValues(valOptions.length)
      .addOptions(valOptions);

    return interaction.editReply({
      content: `**Adding trait role**

Category: **${category}**
Step 3 of 3 — Pick the trait value(s) that qualify for this role:`,
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(valMenu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(cancelId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
        ),
      ],
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
      } else {
        const idx = parseInt(colId);
        if(!cfg.collections) cfg.collections = [];
        if(cfg.collections[idx]){
          if(field==='saleschan')  cfg.collections[idx].salesChannel    = chId;
          if(field==='listchan')   cfg.collections[idx].listingsChannel = chId;
        }
        // burn channel is always top-level in cfg
        if(field==='burnchan') { cfg.burnChannel = chId; if(syncBurnConfig) syncBurnConfig().catch(()=>{}); }
      }
      await setConfig(guildId, cfg);
      const col = isPrimary
        ? { contract:cfg.contract, slug:cfg.collectionSlug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId }
        : cfg.collections[parseInt(colId)];
      return interaction.editReply({ content:'', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT) });
    }

    // Standard channel edit
    const type = parts[1];
    if(type === 'sales')    { cfg.salesChannel = chId; cfg.channelId = chId; }
    if(type === 'listings') { cfg.listingsChannel = chId; cfg.listingsChannelId = chId; }
    if(type === 'burn'){     cfg.burnChannel    = chId; if(syncBurnConfig) syncBurnConfig().catch(()=>{}); }
    if(type === 'verify')   cfg.verifyChannel  = chId;
    if(type === 'rankalert'){
      if(!cfg.rankAlert) cfg.rankAlert = { min:1, max:100, rankType:'os' };
      cfg.rankAlert.channelId = chId;
    }
    await setConfig(guildId, cfg);
    if(type === 'rankalert'){
      return interaction.editReply({ content:'✅ Rank alert channel set.', embeds:[buildRankAlertEmbed(cfg)], components:rankAlertRow(cfg) });
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

  await interaction.deferUpdate();
  const cfg = getConfig(guildId) || {};

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
    return interaction.editReply({ content:'✅ Name updated.', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT) });
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
  if(customId === 'cfg_modal:rankalert'){
    const minRaw  = interaction.fields.getTextInputValue('rank_min').trim();
    const maxRaw  = interaction.fields.getTextInputValue('rank_max').trim();
    const typeRaw = (interaction.fields.getTextInputValue('rank_type') || 'os').trim().toLowerCase();

    const min = parseInt(minRaw);
    const max = parseInt(maxRaw);
    if(!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < 1 || min > 10000 || max > 10000 || min > max){
      return interaction.editReply({ content: '❌ Min and max must be whole numbers between 1 and 10000, with min ≤ max.', embeds:[buildRankAlertEmbed(cfg)], components:rankAlertRow(cfg) });
    }
    const rankType = (typeRaw === 'obs') ? 'obs' : 'os';

    cfg.rankAlert = {
      min, max, rankType,
      channelId: cfg.rankAlert?.channelId || null, // preserve existing channel if already set
    };
    await setConfig(guildId, cfg);
    return interaction.editReply({ content: '✅ Rank alert saved.', embeds:[buildRankAlertEmbed(cfg)], components:rankAlertRow(cfg) });
  }

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
      if(field==='slug'){
        cfg.collectionSlug = val.toLowerCase();
        fetchAndStoreCollectionTraits(cfg.collectionSlug, pgPool).catch(()=>{});
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
      }
    }
    await setConfig(guildId, cfg);
    const col = isPrimary
      ? { contract:cfg.contract, slug:cfg.collectionSlug, name:cfg.contractName, salesChannel:cfg.channelId, listingsChannel:cfg.listingsChannelId }
      : cfg.collections[parseInt(colId)];
    return interaction.editReply({ content:'✅ Updated.', embeds:[buildCollectionEditEmbed(col, isPrimary, cfg)], components:collectionEditRow(colId, isPrimary, col?.contract?.toLowerCase() === OCAS_CONTRACT) });
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
}

const CONFIG_COMMANDS = new Set(['config']);
module.exports = { handleConfigCommand, handleConfigButton, handleConfigModal, CONFIG_COMMANDS };



























