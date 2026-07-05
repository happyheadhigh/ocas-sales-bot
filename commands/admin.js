'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');
const { COLORS } = require('../lib/constants');

/**
 * Handle admin configuration commands.
 * @param {object} ctx - shared context: { interaction, guildId, config, isAdmin, setConfig, pgPool, dbLoad, burnConfig, saveBurnConfig, getBurnConfig, getConfiguredBurnChannelId, BURN_COLORS }
 */
async function handleAdminCommand(commandName, ctx){
  const {
    interaction, guildId, config, isAdmin,
    setConfig, dbLoad, burnConfig, saveBurnConfig,
    getBurnConfig, getConfiguredBurnChannelId, BURN_COLORS,
  } = ctx;

  if(commandName === 'setuphere'){
    if(!isAdmin) return interaction.reply({ content: 'Need Manage Server permission.', flags: MessageFlags.Ephemeral });
    const slug      = interaction.options.getString('collection');
    const contract  = (interaction.options.getString('contract') || '').toLowerCase().trim();
    const chain     = (interaction.options.getString('chain') || 'ethereum').toLowerCase().trim();
    const channelId = interaction.channelId;
    setConfig(guildId, { channelId, slug: slug.toLowerCase().trim(), contract, chain, salesFilters: {}, listingFilters: {}, paused: false });
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Sales Bot Configured!').setColor(0x2dd4bf)
      .addFields(
        { name: 'Sales Channel', value: `<#${channelId}> (this channel)`, inline: true },
        { name: 'Collection',    value: slug,                              inline: true },
        { name: 'Contract',      value: contract || 'not set',            inline: true },
      )
      .setDescription('Sales will post to **this channel** automatically.\nRun `/setlistingshere` in your listings channel to enable listing alerts.')] });
    return;
  }

  if(commandName === 'setlistingshere'){
    if(!isAdmin) return interaction.reply({ content: 'Need Manage Server permission.', flags: MessageFlags.Ephemeral });
    const channelId = interaction.channelId;
    setConfig(guildId, { listingsChannelId: channelId });
    await interaction.reply({ content: `Listings channel set to this channel <#${channelId}>. New listings will post here automatically.` });
    return;
  }

  if(commandName === 'setlistings'){
    if(!isAdmin) return interaction.reply({ content: 'Need Manage Server permission.', flags: MessageFlags.Ephemeral });
    const channel = interaction.options.getChannel('channel');
    setConfig(guildId, { listingsChannelId: channel.id });
    await interaction.reply({ content: `Listings channel set to <#${channel.id}>. New listings will post there automatically.` });
    return;
  }

  if(commandName === 'status'){
    if(!isAdmin) return interaction.reply({ content: 'Need Manage Server permission.', flags: MessageFlags.Ephemeral });
    const fmtFilter = f => Object.keys(f || {}).length === 0
      ? 'none'
      : Object.entries(f).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(' OR ') : v}`).join(', ');
    const sf       = fmtFilter(config.salesFilters);
    const lf       = fmtFilter(config.listingFilters);
    const ra       = config.rankAlert
      ? `⬥ OS Rank #${config.rankAlert.min}–#${config.rankAlert.max}${config.rankAlert.channelId ? ` → <#${config.rankAlert.channelId}>` : ''}`
      : 'none';
    const burnCfg       = getBurnConfig(guildId);
    const burnChannelId = getConfiguredBurnChannelId(burnCfg);
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Bot Status').setColor(0x7aa2ff)
      .addFields(
        { name: 'Collection',       value: config.slug || 'not set',                                        inline: true },
        { name: 'Paused',           value: config.paused ? 'Yes' : 'No',                                   inline: true },
        { name: '​',           value: '​',                                                         inline: true },
        { name: 'Sales Channel',    value: config.channelId ? `<#${config.channelId}>` : 'not set',        inline: true },
        { name: 'Listings Channel', value: config.listingsChannelId ? `<#${config.listingsChannelId}>` : 'not set', inline: true },
        { name: 'Burn Alerts',      value: burnChannelId ? `<#${burnChannelId}>` : 'not set',              inline: true },
        { name: 'Sales Filters',    value: sf,                                                              inline: true },
        { name: 'Listing Filters',  value: lf,                                                              inline: true },
        { name: 'Rank Alert',       value: ra,                                                              inline: true },
      )], flags: MessageFlags.Ephemeral });
    return;
  }
if(commandName === 'verifydashboard'){
  await interaction.deferReply({ephemeral:true});
  if(!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
    return interaction.editReply({content:'❌ You need Manage Server permission.'});

  const guildId = interaction.guildId;
  const { pgPool } = ctx;

  try{
    const verifiedRes = await pgPool.query(
      `SELECT COUNT(*) FROM user_registrations WHERE guild_id=$1 AND verified=true`,
      [guildId]
    );
    const verifiedCount = parseInt(verifiedRes.rows[0].count);

    const pendingRes = await pgPool.query(
      `SELECT COUNT(*) FROM verification_codes WHERE guild_id=$1 AND expires_at > NOW()`,
      [guildId]
    );
    const pendingCount = parseInt(pendingRes.rows[0].count);

    const totalAttempts = parseInt((await pgPool.query(
      `SELECT COUNT(*) FROM verification_codes WHERE guild_id=$1`, [guildId]
    )).rows[0].count) + verifiedCount;
    const successRate = totalAttempts > 0
      ? ((verifiedCount / totalAttempts) * 100).toFixed(1) + '%'
      : '—';

    const lastRes = await pgPool.query(
      `SELECT verified_at FROM user_registrations WHERE guild_id=$1 AND verified=true ORDER BY verified_at DESC NULLS LAST`,
      [guildId]
    );
    const lastVerified = lastRes.rows[0]?.verified_at
      ? '<t:'+Math.floor(new Date(lastRes.rows[0].verified_at).getTime()/1000)+':R>'
      : '—';

    const traitRolesRes = await pgPool.query(
      `SELECT role_id, trait_type, trait_value, minimum_count FROM trait_roles WHERE guild_id=$1 ORDER BY trait_type, trait_value`,
      [guildId]
    );
    const panelRes = await pgPool.query(
      `SELECT role_id FROM verification_panels WHERE guild_id=$1`, [guildId]
    );
    const holderRoleId = panelRes.rows[0]?.role_id;

    // Live Discord role member counts — fetch all members first to populate cache
    await interaction.guild.members.fetch();
    let rolesDisplay = '';
    if(holderRoleId){
      const holderRole = interaction.guild.roles.cache.get(holderRoleId);
      rolesDisplay += '<@&'+holderRoleId+'> — '+(holderRole?.members.size??0)+'\n';
    }
    for(const tr of traitRolesRes.rows){
      const role  = interaction.guild.roles.cache.get(tr.role_id);
      const count = role?.members.size ?? 0;
      const label = tr.minimum_count > 1 ? tr.minimum_count+'+ '+tr.trait_value : tr.trait_value;
      rolesDisplay += '<@&'+tr.role_id+'> ('+label+') — '+count+'\n';
    }
    if(!rolesDisplay) rolesDisplay = '*No trait roles configured*';

    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 Verification Dashboard')
      .setDescription('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      .addFields(
        { name:'👥 Verified Wallets', value:'**'+verifiedCount+'**', inline:true },
        { name:'⏳ Pending',          value:'**'+pendingCount+'**',  inline:true },
        { name:'✅ Success Rate',     value:'**'+successRate+'**',   inline:true },
        { name:'🎭 Roles Assigned',   value:rolesDisplay,            inline:false },
        { name:'🕐 Last Verification',value:lastVerified,            inline:false },
      )
      .setFooter({ text:'Only visible to you • Role counts are live from Discord' })
      .setTimestamp();

    return interaction.editReply({ embeds:[embed] });
  }catch(e){
    console.error('[VerifyDashboard]', e.message);
    return interaction.editReply({content:'❌ Failed to load dashboard: '+e.message});
  }
}

}

const ADMIN_COMMANDS = new Set([
  'setuphere','setlistingshere','setlistings','verifydashboard','status',
]);

// ── /verifydashboard ──────────────────────────────────────────────────────────

module.exports = { handleAdminCommand, ADMIN_COMMANDS };