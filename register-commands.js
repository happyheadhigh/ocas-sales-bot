require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
  // ── Admin ──────────────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName('setup').setDescription('Configure sales channel and collection')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o=>o.setName('channel').setDescription('Channel to post sales in').setRequired(true))
    .addStringOption(o=>o.setName('collection').setDescription('OpenSea collection slug (e.g. on-chain-all-stars)').setRequired(true))
    .addStringOption(o=>o.setName('contract').setDescription('Contract address (e.g. 0x078be86...)').setRequired(false))
    .addStringOption(o=>o.setName('chain').setDescription('Blockchain (default: ethereum — use base, polygon, etc for other chains)').setRequired(false)
      .addChoices(
        {name:'Ethereum',value:'ethereum'},
        {name:'Base',value:'base'},
        {name:'Polygon',value:'matic'},
        {name:'Arbitrum',value:'arbitrum'},
        {name:'Optimism',value:'optimism'},
        {name:'Solana',value:'solana'},
      )),

  new SlashCommandBuilder().setName('setuphere')
    .setDescription('Mobile-friendly setup — posts sales to the channel you run this in')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('collection').setDescription('OpenSea collection slug (e.g. on-chain-all-stars)').setRequired(true))
    .addStringOption(o=>o.setName('contract').setDescription('Contract address (e.g. 0x078be86...)').setRequired(false))
    .addStringOption(o=>o.setName('chain').setDescription('Blockchain (default: ethereum)').setRequired(false)
      .addChoices(
        {name:'Ethereum',value:'ethereum'},
        {name:'Base',value:'base'},
        {name:'Polygon',value:'matic'},
        {name:'Arbitrum',value:'arbitrum'},
        {name:'Optimism',value:'optimism'},
        {name:'Solana',value:'solana'},
      )),

  new SlashCommandBuilder().setName('setlistingshere')
    .setDescription('Mobile-friendly — sets listings channel to the channel you run this in')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('setlistings').setDescription('Set the channel for new listing alerts')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o=>o.setName('channel').setDescription('Channel to post new listings in').setRequired(true)),

  new SlashCommandBuilder().setName('setchannel').setDescription('Change the sales channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o=>o.setName('channel').setDescription('New sales channel').setRequired(true)),

  new SlashCommandBuilder().setName('setcollection').setDescription('Change the collection being watched')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('slug').setDescription('OpenSea collection slug').setRequired(true))
    .addStringOption(o=>o.setName('contract').setDescription('Contract address').setRequired(false)),

  new SlashCommandBuilder().setName('salesfilter').setDescription('Only auto-post sales where a trait matches')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('trait').setDescription('Trait name (e.g. Type)').setRequired(true))
    .addStringOption(o=>o.setName('value').setDescription('Trait value (e.g. Zombie)').setRequired(true)),

  new SlashCommandBuilder().setName('traitlistingfilter').setDescription('Only auto-post listings where a trait matches')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('trait').setDescription('Trait name (e.g. Background)').setRequired(true))
    .addStringOption(o=>o.setName('value').setDescription('Trait value (e.g. Blue)').setRequired(true)),

  new SlashCommandBuilder().setName('clearallfilters').setDescription('Clear all trait filters and rank alert')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('pause').setDescription('Pause all auto-posts')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('resume').setDescription('Resume all auto-posts')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('status').setDescription('Show current bot configuration'),

  // ── Public ─────────────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName('lastsale').setDescription('Show the most recent sale')
    .addStringOption(o=>o.setName('collection').setDescription('Collection slug (uses server default if not set)').setRequired(false)),

  new SlashCommandBuilder().setName('recentsales').setDescription('Show the last N sales')
    .addIntegerOption(o=>o.setName('count').setDescription('Number of sales (max 20, default 5)').setRequired(false).setMinValue(1).setMaxValue(20))
    .addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),

  new SlashCommandBuilder().setName('sale').setDescription('Show the last sale for a specific token')
    .addStringOption(o=>o.setName('token').setDescription('Token ID (e.g. 7370)').setRequired(true))
    .addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),

  new SlashCommandBuilder().setName('traitfind').setDescription('Search recent sales history for a specific trait')
    .addStringOption(o=>o.setName('trait').setDescription('Trait name (e.g. Type)').setRequired(true))
    .addStringOption(o=>o.setName('value').setDescription('Trait value (e.g. Zombie)').setRequired(true))
    .addIntegerOption(o=>o.setName('count').setDescription('How many to find (max 20, default 5)').setRequired(false).setMinValue(1).setMaxValue(20))
    .addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),

  new SlashCommandBuilder().setName('listings').setDescription('Show recent new listings')
    .addIntegerOption(o=>o.setName('count').setDescription('Number of listings (max 20, default 5)').setRequired(false).setMinValue(1).setMaxValue(20))
    .addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),

  new SlashCommandBuilder().setName('myalert').setDescription('Get personal DMs when matching sales or listings happen')
    .addStringOption(o=>o.setName('trait').setDescription('Trait name to filter by (e.g. Type)').setRequired(false))
    .addStringOption(o=>o.setName('value').setDescription('Trait value to filter by (e.g. Zombie)').setRequired(false))
    .addBooleanOption(o=>o.setName('sales').setDescription('DM me for sales? (default: true)').setRequired(false))
    .addBooleanOption(o=>o.setName('listings').setDescription('DM me for listings? (default: true)').setRequired(false))
    .addStringOption(o=>o.setName('collection').setDescription('Collection slug (uses server default if not set)').setRequired(false)),

  new SlashCommandBuilder().setName('removetraitfilter').setDescription('Remove a specific trait value from a sales or listing filter')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('type').setDescription('Which filter to modify').setRequired(true)
      .addChoices({name:'Sales',value:'sales'},{name:'Listings',value:'listings'}))
    .addStringOption(o=>o.setName('trait').setDescription('Trait name (e.g. Type)').setRequired(true))
    .addStringOption(o=>o.setName('value').setDescription('Value to remove (e.g. Zombie)').setRequired(true)),

  new SlashCommandBuilder().setName('debuglisting').setDescription('Show raw listing event data to diagnose issues (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),

  new SlashCommandBuilder().setName('myalertclear').setDescription('Remove your personal DM alert (all or just one filter)')
    .addStringOption(o=>o.setName('trait').setDescription('Remove just this trait filter (leave blank to remove entire alert)').setRequired(false))
    .addStringOption(o=>o.setName('value').setDescription('Specific value to remove from that trait filter').setRequired(false)),

  new SlashCommandBuilder().setName('myalertstatus').setDescription('See your current personal alert settings'),

  new SlashCommandBuilder().setName('help').setDescription('Show all available commands'),

  // ── Rank filter & alerts ───────────────────────────────────────────────────
  new SlashCommandBuilder().setName('rankfilter').setDescription('Show currently listed tokens by OS rarity rank range')
    .addIntegerOption(o=>o.setName('min').setDescription('Minimum OS rank (e.g. 1)').setRequired(false).setMinValue(1).setMaxValue(10000))
    .addIntegerOption(o=>o.setName('max').setDescription('Maximum OS rank (e.g. 100)').setRequired(false).setMinValue(1).setMaxValue(10000))
    .addStringOption(o=>o.setName('sort').setDescription('Sort order (default: cheapest first)').setRequired(false)
      .addChoices(
        {name:'Cheapest first', value:'price'},
        {name:'Best rank first', value:'rank'},
      )),

  new SlashCommandBuilder().setName('ranklistingfilter').setDescription('Alert when a token in an OS rank range gets listed')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption(o=>o.setName('min').setDescription('Minimum OS rank (e.g. 1)').setRequired(true).setMinValue(1).setMaxValue(10000))
    .addIntegerOption(o=>o.setName('max').setDescription('Maximum OS rank (e.g. 100)').setRequired(true).setMinValue(1).setMaxValue(10000))
    .addChannelOption(o=>o.setName('channel').setDescription('Channel to post rank alerts in (defaults to listings channel)').setRequired(false)),

  new SlashCommandBuilder().setName('removerankfilter').setDescription('Remove the rank listing alert')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('ocas').setDescription('Show a random or specific OCAS token')
    .addIntegerOption(o=>o.setName('token').setDescription('Token ID (leave blank for random)').setRequired(false).setMinValue(1).setMaxValue(10000))
    .addStringOption(o=>o.setName('trait').setDescription('Trait name to filter by (e.g. Type)').setRequired(false))
    .addStringOption(o=>o.setName('value').setDescription('Trait value (e.g. Zombie)').setRequired(false))
    .addStringOption(o=>o.setName('trait2').setDescription('Second trait name (optional)').setRequired(false))
    .addStringOption(o=>o.setName('value2').setDescription('Second trait value (optional)').setRequired(false)),

  new SlashCommandBuilder().setName('traitfloor').setDescription('Show the floor price for a specific trait or trait count')
    .addStringOption(o=>o.setName('trait').setDescription('Trait name (e.g. Type)').setRequired(false))
    .addStringOption(o=>o.setName('value').setDescription('Trait value (e.g. Zombie)').setRequired(false))
    .addIntegerOption(o=>o.setName('trait_count').setDescription('Number of traits (e.g. 16)').setRequired(false).setMinValue(1).setMaxValue(30)),

].map(c=>c.toJSON());

const rest = new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);

(async()=>{
  try{
    console.log('Registering '+commands.length+' slash commands...');
    const data = await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {body:commands});
    console.log('Registered '+data.length+' commands successfully!');
    console.log('Commands appear in Discord within ~1 hour.');
  }catch(e){
    console.error('Registration failed:', e.message);
  }
})();
