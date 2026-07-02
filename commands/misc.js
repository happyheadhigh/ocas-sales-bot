'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');

async function handleMiscCommand(commandName, ctx){
  const { interaction, guildId, config } = ctx;

  if(commandName==='help'){
    const marketCmds=[
      '`/ocas search:zombie hoodie` — Random or searched OCAS token',
      '`/ocas search:gold chain floor` — Cheapest listed with that trait',
      '`/sweep search:10` — Cost to sweep 10 cheapest listed',
      '`/sweep search:2eth zombie` — Budget sweep with trait filter',
      '`/sweep search:0.05 floor zombie` — Clear below target floor',
      '`/traitfind search:zombie` — Tokens matching a trait',
      '`/traitfind search:zombie listings` — Currently listed with that trait',
      '`/traitfind search:zombie sales` — Sales history for that trait',
      '`/rankfind search:1-100` — Listed tokens by OS rank range',
      '`/rankfind search:1-100 sales` — Sales history by OS rank range',
    ].join('\n');
    const salesCmds=[
      '`/lastsale` — Most recent sale',
      '`/recentsales count:10` — Last N sales',
      '`/sale token:1234` — Last sale for a specific token',
      '`/listings count:5` — Recent new listings',
    ].join('\n');
    const burnCmds=[
      '`/burnstats` — Total burned, created, estimated supply',
      '`/burnlatest` — Most recent finalized burn',
      '`/burn token:1234` — Token burn status and lineage',
      '`/burnwallet wallet:0x...` — Wallet burn history',
      '`/burnleaderboard` — Top burners by tokens burned',
      '`/burnrefresh token:1234` — Refresh metadata + re-post burn alert (5 min cooldown)',
    ].join('\n');
    const alertCmds=[
      '`/myalert trait:Type value:Zombie` — DM when a Zombie sells or lists',
      '`/myalertstatus` — See your current alert settings',
      '`/myalertclear` — Remove your DM alert',
    ].join('\n');
    const adminCmds=[
      '`/setup` — Initial configuration wizard (collection, channels, roles)',
      '`/config` — Manage channels, roles, verification & listing filters',
      '`/synctraits` — Manually sync trait roles for all verified members',
      '`/resetverify` — Clear a member\'s verification so they can re-verify',
      '`/lotteries` — View and manage burn lotteries & giveaways',
      '`/status` — Show server config',
    ].join('\n');
    const accountCmds=[
      '`/me` — Your wallet portfolio, DM alert settings, and wallet verification',
    ].join('\n');
    await interaction.reply({embeds:[new EmbedBuilder()
      .setTitle('Bot Commands')
      .setColor(COLORS.OCAS_GREEN)
      .setDescription('Search tokens, track sales, sweep floors, monitor burns, verify holders, and manage your server.')  
      .addFields(
        {name:'👤 Your Account',             value:accountCmds, inline:false},
        {name:'🔍 Market & Search',         value:marketCmds, inline:false},
        {name:'📈 Sales & Listings',         value:salesCmds,  inline:false},
        {name:'🔥 Burn Machine',             value:burnCmds,   inline:false},
        {name:'🔔 Personal DM Alerts',       value:alertCmds,  inline:false},
        {name:'⚙️ Admin (Manage Server)',    value:adminCmds,  inline:false},
      )], flags: MessageFlags.Ephemeral});
    return;
  }

}

const MISC_COMMANDS = new Set(['help']);

module.exports = { handleMiscCommand, MISC_COMMANDS };

