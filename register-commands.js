const path = require('path');

const envName = String(process.argv[2] || '').trim().toLowerCase();
const envFile =
  envName === 'staging' ? '.env.staging' :
  envName === 'production' || envName === 'prod' ? '.env.production' :
  '.env';

require('dotenv').config({ path: path.join(__dirname, envFile), override: true });

console.log(`Using environment file: ${envFile}`);
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const chainChoices = [
  {name:'Ethereum',value:'ethereum'},
  {name:'Base',value:'base'},
  {name:'Polygon',value:'matic'},
  {name:'Arbitrum',value:'arbitrum'},
  {name:'Optimism',value:'optimism'},
  {name:'Solana',value:'solana'},
];

const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Configure sales channel and collection')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o=>o.setName('channel').setDescription('Channel to post sales in').setRequired(true))
    .addStringOption(o=>o.setName('collection').setDescription('OpenSea collection slug (e.g. on-chain-all-stars)').setRequired(true))
    .addStringOption(o=>o.setName('contract').setDescription('Contract address (e.g. 0x078be86...)').setRequired(false))
    .addStringOption(o=>o.setName('chain').setDescription('Blockchain (default: ethereum)').setRequired(false).addChoices(...chainChoices)),

  new SlashCommandBuilder().setName('setuphere')
    .setDescription('Mobile-friendly setup — posts sales to the channel you run this in')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('collection').setDescription('OpenSea collection slug (e.g. on-chain-all-stars)').setRequired(true))
    .addStringOption(o=>o.setName('contract').setDescription('Contract address (e.g. 0x078be86...)').setRequired(false))
    .addStringOption(o=>o.setName('chain').setDescription('Blockchain (default: ethereum)').setRequired(false).addChoices(...chainChoices)),

  new SlashCommandBuilder().setName('setlistingshere').setDescription('Mobile-friendly — sets listings channel to the channel you run this in').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setlistings').setDescription('Set the channel for new listing alerts').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addChannelOption(o=>o.setName('channel').setDescription('Channel to post new listings in').setRequired(true)),
  new SlashCommandBuilder().setName('setchannel').setDescription('Change the sales channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addChannelOption(o=>o.setName('channel').setDescription('New sales channel').setRequired(true)),
  new SlashCommandBuilder().setName('setcollection').setDescription('Change the collection being watched').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addStringOption(o=>o.setName('slug').setDescription('OpenSea collection slug').setRequired(true)).addStringOption(o=>o.setName('contract').setDescription('Contract address').setRequired(false)),
  new SlashCommandBuilder().setName('salesfilter').setDescription('Only auto-post sales where a trait matches').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addStringOption(o=>o.setName('trait').setDescription('Trait name (e.g. Type)').setRequired(true)).addStringOption(o=>o.setName('value').setDescription('Trait value (e.g. Zombie)').setRequired(true)),
  new SlashCommandBuilder().setName('traitlistingfilter').setDescription('Only auto-post listings where a trait matches').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addStringOption(o=>o.setName('trait').setDescription('Trait name (e.g. Background)').setRequired(true)).addStringOption(o=>o.setName('value').setDescription('Trait value (e.g. Blue)').setRequired(true)),
  new SlashCommandBuilder().setName('clearallfilters').setDescription('Clear all trait filters and rank alert').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('pause').setDescription('Pause all auto-posts').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('resume').setDescription('Resume all auto-posts').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('status').setDescription('Show current bot configuration'),

  new SlashCommandBuilder().setName('market')
    .setDescription('Universal multi-collection market tools')
    .addSubcommand(sc=>sc.setName('add').setDescription('Add a collection sales feed to this server')
      .addStringOption(o=>o.setName('alias').setDescription('Short name, e.g. ocas, flux, rocks').setRequired(true))
      .addStringOption(o=>o.setName('slug').setDescription('OpenSea collection slug').setRequired(true))
      .addStringOption(o=>o.setName('contract').setDescription('Contract address, e.g. 0x078be86...').setRequired(true))
      .addChannelOption(o=>o.setName('sales_channel').setDescription('Sales channel; defaults to current channel').setRequired(false))
      .addStringOption(o=>o.setName('chain').setDescription('Blockchain; default ethereum').setRequired(false).addChoices(...chainChoices)))
    .addSubcommand(sc=>sc.setName('addhere').setDescription('Mobile-friendly: add a collection sales feed to this channel')
      .addStringOption(o=>o.setName('alias').setDescription('Short name, e.g. ocas, flux, rocks').setRequired(true))
      .addStringOption(o=>o.setName('slug').setDescription('OpenSea collection slug').setRequired(true))
      .addStringOption(o=>o.setName('contract').setDescription('Contract address, e.g. 0x078be86...').setRequired(true))
      .addStringOption(o=>o.setName('chain').setDescription('Blockchain; default ethereum').setRequired(false).addChoices(...chainChoices)))
    .addSubcommand(sc=>sc.setName('list').setDescription('List configured market collections'))
    .addSubcommand(sc=>sc.setName('remove').setDescription('Remove a collection from this server').addStringOption(o=>o.setName('alias').setDescription('Collection alias to remove').setRequired(true)))
    .addSubcommand(sc=>sc.setName('channel').setDescription('Set a collection sales/default channel').addStringOption(o=>o.setName('alias').setDescription('Collection alias').setRequired(true)).addChannelOption(o=>o.setName('sales_channel').setDescription('Sales/default channel; defaults to current channel').setRequired(false)))
    .addSubcommand(sc=>sc.setName('sales').setDescription('Show recent sales for a configured collection')
      .addStringOption(o=>o.setName('search').setDescription('Example: ocas 5').setRequired(false))
      .addStringOption(o=>o.setName('alias').setDescription('Collection alias; defaults by channel or OCAS').setRequired(false))
      .addIntegerOption(o=>o.setName('count').setDescription('Number of sales, max 10').setRequired(false).setMinValue(1).setMaxValue(10))),

  new SlashCommandBuilder().setName('download')
  .setDescription('Download a high-res PNG for OCAS or another configured collection')
  .addStringOption(o=>o.setName('search').setDescription('Example: ocas #337 2048 no bg').setRequired(false))
  .addIntegerOption(o=>o.setName('token').setDescription('Token ID').setRequired(false).setMinValue(1))
  .addStringOption(o=>o.setName('collection').setDescription('Alias, e.g. ocas, flux, rocks. Defaults to OCAS').setRequired(false))
  .addIntegerOption(o=>o.setName('size').setDescription('PNG size in pixels, default 2048').setRequired(false).setMinValue(512).setMaxValue(4096))
  .addBooleanOption(o=>o.setName('transparent').setDescription('Export with transparent/no background').setRequired(false)),

  new SlashCommandBuilder().setName('lastsale').setDescription('Show the most recent sale').addStringOption(o=>o.setName('collection').setDescription('Collection slug (uses server default if not set)').setRequired(false)),
  new SlashCommandBuilder().setName('recentsales').setDescription('Show the last N sales').addIntegerOption(o=>o.setName('count').setDescription('Number of sales (max 20, default 5)').setRequired(false).setMinValue(1).setMaxValue(20)).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),
  new SlashCommandBuilder().setName('sale').setDescription('Show the last sale for a specific token').addStringOption(o=>o.setName('token').setDescription('Token ID (e.g. 7370)').setRequired(true)).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),
  new SlashCommandBuilder().setName('traitfind').setDescription('Find sales or listings by trait — e.g. zombie, gold chain listings').addStringOption(o=>o.setName('search').setDescription('Trait + optional mode/count').setRequired(true)).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),
  new SlashCommandBuilder().setName('listings').setDescription('Show recent new listings').addIntegerOption(o=>o.setName('count').setDescription('Number of listings (max 20, default 5)').setRequired(false).setMinValue(1).setMaxValue(20)).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),
  new SlashCommandBuilder().setName('myalert').setDescription('Get personal DMs when matching sales or listings happen').addStringOption(o=>o.setName('trait').setDescription('Trait name to filter by').setRequired(false)).addStringOption(o=>o.setName('value').setDescription('Trait value to filter by').setRequired(false)).addBooleanOption(o=>o.setName('sales').setDescription('DM me for sales? (default: true)').setRequired(false)).addBooleanOption(o=>o.setName('listings').setDescription('DM me for listings? (default: true)').setRequired(false)).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),
  new SlashCommandBuilder().setName('removetraitfilter').setDescription('Remove a specific trait value from a sales or listing filter').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addStringOption(o=>o.setName('type').setDescription('Which filter to modify').setRequired(true).addChoices({name:'Sales',value:'sales'},{name:'Listings',value:'listings'})).addStringOption(o=>o.setName('trait').setDescription('Trait name').setRequired(true)).addStringOption(o=>o.setName('value').setDescription('Value to remove').setRequired(true)),
  new SlashCommandBuilder().setName('debuglisting').setDescription('Show raw listing event data to diagnose issues (admin only)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),
  new SlashCommandBuilder().setName('myalertclear').setDescription('Remove your personal DM alert').addStringOption(o=>o.setName('trait').setDescription('Remove just this trait filter').setRequired(false)).addStringOption(o=>o.setName('value').setDescription('Specific value to remove').setRequired(false)),
  new SlashCommandBuilder().setName('myalertstatus').setDescription('See your current personal alert settings'),
  new SlashCommandBuilder().setName('help').setDescription('Show all available commands'),

  new SlashCommandBuilder().setName('rankfind').setDescription('Find listings or sales by OS rank range — e.g. 1-100').addStringOption(o=>o.setName('search').setDescription('Range + optional mode').setRequired(false)),
  new SlashCommandBuilder().setName('ranklistingfilter').setDescription('Alert when a token in an OS rank range gets listed').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addIntegerOption(o=>o.setName('min').setDescription('Minimum OS rank').setRequired(true).setMinValue(1).setMaxValue(10000)).addIntegerOption(o=>o.setName('max').setDescription('Maximum OS rank').setRequired(true).setMinValue(1).setMaxValue(10000)).addChannelOption(o=>o.setName('channel').setDescription('Channel to post rank alerts in').setRequired(false)),
  new SlashCommandBuilder().setName('removerankfilter').setDescription('Remove the rank listing alert').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('ocas').setDescription('Show a random OCAS — search by trait, count, rank, or token ID').addIntegerOption(o=>o.setName('token').setDescription('Specific token ID').setRequired(false).setMinValue(1).setMaxValue(10000)).addStringOption(o=>o.setName('search').setDescription('Search: zombie, 15 traits, rank 1-100, or token number').setRequired(false)),
  new SlashCommandBuilder().setName('sweep').setDescription('Calculate ETH cost to sweep cheapest listed OCAS').addStringOption(o=>o.setName('search').setDescription('e.g. 10, 2eth, 0.05 floor, 10 zombie').setRequired(false)),

  new SlashCommandBuilder().setName('setupburn').setDescription('Set the channel for OCAS burn alerts (defaults to this channel)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addChannelOption(o=>o.setName('channel').setDescription('Channel to post burn alerts in').setRequired(false)),
  new SlashCommandBuilder().setName('burnstats').setDescription('Show OCAS Burn Machine stats — total burned, created, estimated supply'),
  new SlashCommandBuilder().setName('burnlatest').setDescription('Show recent finalized OCAS burn events').addIntegerOption(o=>o.setName('count').setDescription('Number of burns to show (max 10, default 1)').setRequired(false).setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName('burn').setDescription('Show burn status and lineage for a token').addIntegerOption(o=>o.setName('token').setDescription('Token ID').setRequired(true).setMinValue(1).setMaxValue(10000)),
  new SlashCommandBuilder().setName('burnwallet').setDescription('Show burn history for a wallet address').addStringOption(o=>o.setName('wallet').setDescription('Wallet address (0x...)').setRequired(true)),
  new SlashCommandBuilder().setName('burnleaderboard').setDescription('Top OCAS burners ranked by tokens burned'),
  new SlashCommandBuilder().setName('burnrefresh').setDescription('Refresh metadata and re-post burn alert for a created token (5 min cooldown)').addIntegerOption(o=>o.setName('token').setDescription('Survivor/created token ID').setRequired(true).setMinValue(1).setMaxValue(10000)),

  new SlashCommandBuilder().setName('synctraits').setDescription('Refresh token traits from contract — fixes missing/stale traits in DB (admin only)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('mode').setDescription('survivors = refresh all burn survivors; token = single token (default)').setRequired(false).addChoices({name:'Single token',value:'token'},{name:'All burn survivors',value:'survivors'}))
    .addIntegerOption(o=>o.setName('token').setDescription('Token ID (required for single token mode)').setRequired(false).setMinValue(1).setMaxValue(10000)),

  new SlashCommandBuilder().setName('burnlottery').setDescription('Schedule or draw an OCAS burn lottery').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc=>sc.setName('start').setDescription('Start a burn lottery that auto-draws when the window ends')
      .addStringOption(o=>o.setName('window').setDescription('When + duration, e.g. now 24hrs, today-10am 7days, 06-07-2026-3pm, uk:06-07-2026-3pm').setRequired(false))
      .addStringOption(o=>o.setName('mode').setDescription('Entry mode').setRequired(false).addChoices({name:'One entry per wallet',value:'wallet'},{name:'One entry per burn',value:'burn'}))
      .addStringOption(o=>o.setName('timezone').setDescription('Optional timezone override; default is Europe/London').setRequired(false)))
    .addSubcommand(sc=>sc.setName('draw').setDescription('Draw immediately from a past window or a scheduled lottery ID')
      .addIntegerOption(o=>o.setName('id').setDescription('Draw a scheduled lottery ID').setRequired(false))
      .addStringOption(o=>o.setName('window').setDescription('Past window, e.g. yesterday-10am 24hrs, 06-07-2026-3pm 1week, uk:06-07-2026-3pm 1week').setRequired(false))
      .addStringOption(o=>o.setName('mode').setDescription('Entry mode').setRequired(false).addChoices({name:'One entry per wallet',value:'wallet'},{name:'One entry per burn',value:'burn'}))
      .addStringOption(o=>o.setName('timezone').setDescription('Optional timezone override; default is Europe/London').setRequired(false)))
    .addSubcommand(sc=>sc.setName('status').setDescription('Show recent/scheduled burn lotteries').addIntegerOption(o=>o.setName('id').setDescription('Lottery ID').setRequired(false)))
    .addSubcommand(sc=>sc.setName('cancel').setDescription('Cancel an active scheduled burn lottery').addIntegerOption(o=>o.setName('id').setDescription('Lottery ID').setRequired(true))),

  new SlashCommandBuilder().setName('lottery').setDescription('Generic giveaways, number guessing games, and instant random picks')
    .addSubcommand(sc=>sc.setName('start').setDescription('Start a timed giveaway or number-guessing event')
      .addStringOption(o=>o.setName('type').setDescription('Lottery type').setRequired(true).addChoices({name:'Giveaway button entries',value:'giveaway'},{name:'Guess the number',value:'guess'}))
      .addIntegerOption(o=>o.setName('minutes').setDescription('How long entries stay open, default 10').setRequired(false).setMinValue(1).setMaxValue(10080))
      .addIntegerOption(o=>o.setName('min').setDescription('Minimum number for guess events').setRequired(false))
      .addIntegerOption(o=>o.setName('max').setDescription('Maximum number for guess events').setRequired(false))
      .addStringOption(o=>o.setName('winner').setDescription('Guess winner mode').setRequired(false).addChoices({name:'Exact guess only',value:'exact'},{name:'Closest guess wins',value:'closest'}))
      .addStringOption(o=>o.setName('title').setDescription('Public title').setRequired(false))
      .addStringOption(o=>o.setName('prize').setDescription('Prize note').setRequired(false))
      .addStringOption(o=>o.setName('seed').setDescription('Optional public seed').setRequired(false))
      .addChannelOption(o=>o.setName('channel').setDescription('Where to post; defaults here').setRequired(false)))
    .addSubcommand(sc=>sc.setName('enter').setDescription('Enter the active giveaway').addIntegerOption(o=>o.setName('id').setDescription('Lottery ID').setRequired(false)))
    .addSubcommand(sc=>sc.setName('guess').setDescription('Submit or update your number guess').addIntegerOption(o=>o.setName('number').setDescription('Your guess').setRequired(true)).addIntegerOption(o=>o.setName('id').setDescription('Lottery ID').setRequired(false)))
    .addSubcommand(sc=>sc.setName('status').setDescription('Show active/recent lotteries').addIntegerOption(o=>o.setName('id').setDescription('Lottery ID').setRequired(false)))
    .addSubcommand(sc=>sc.setName('draw').setDescription('Admin: draw/end a lottery now').addIntegerOption(o=>o.setName('id').setDescription('Lottery ID').setRequired(true)))
    .addSubcommand(sc=>sc.setName('cancel').setDescription('Admin: cancel an active lottery').addIntegerOption(o=>o.setName('id').setDescription('Lottery ID').setRequired(true)))
    .addSubcommand(sc=>sc.setName('instant').setDescription('Admin: instantly pick from names or a number range')
      .addStringOption(o=>o.setName('entries').setDescription('Comma-separated entries').setRequired(false))
      .addIntegerOption(o=>o.setName('min').setDescription('Minimum number').setRequired(false))
      .addIntegerOption(o=>o.setName('max').setDescription('Maximum number').setRequired(false))
      .addStringOption(o=>o.setName('seed').setDescription('Optional seed').setRequired(false))),

  new SlashCommandBuilder().setName('register')
    .setDescription('Link your wallet to your Discord for giveaways')
    .addStringOption(o=>o.setName('wallet').setDescription('Your Ethereum wallet address (0x...)').setRequired(true)),


  new SlashCommandBuilder().setName('myregistration')
    .setDescription('Show your current wallet registration status'),


  new SlashCommandBuilder().setName('setupverification')
    .setDescription('Setup a wallet verification panel in a channel (Admin only)')
    .addChannelOption(o=>o.setName('channel').setDescription('Channel to post the verification panel in').setRequired(true))
    .addRoleOption(o=>o.setName('role').setDescription('Role to assign after verification').setRequired(false))
    .addIntegerOption(o=>o.setName('minimum').setDescription('Minimum OCAS tokens required (0 = any wallet)').setRequired(false).setMinValue(0))
    .addStringOption(o=>o.setName('message').setDescription('Custom welcome message for the panel').setRequired(false)),

  new SlashCommandBuilder().setName('setuptraitrole')
    .setDescription('Assign a Discord role to holders of a specific OCAS trait (Admin only)')
    .addStringOption(o=>o.setName('trait_type').setDescription('Trait category e.g. Type, Hat Hair, Clothes').setRequired(true))
    .addStringOption(o=>o.setName('trait_value').setDescription('Trait value e.g. Zombie, Mohawk Blonde').setRequired(true))
    .addRoleOption(o=>o.setName('role').setDescription('Role to assign to holders of this trait').setRequired(true)),

  new SlashCommandBuilder().setName('removetraitrole')
    .setDescription('Remove a trait role mapping (Admin only)')
    .addStringOption(o=>o.setName('trait_type').setDescription('Trait category').setRequired(true))
    .addStringOption(o=>o.setName('trait_value').setDescription('Trait value').setRequired(true))
    .addRoleOption(o=>o.setName('role').setDescription('Role to remove').setRequired(true)),

  new SlashCommandBuilder().setName('listtraitroles')
    .setDescription('List all trait role mappings for this server'),

  new SlashCommandBuilder().setName('synctraits')
    .setDescription('Manually sync trait roles for all verified members now (Admin only)'),

].map(c=>c.toJSON());

if(!process.env.DISCORD_TOKEN){
  console.error(`Missing DISCORD_TOKEN in ${envFile}`);
  process.exit(1);
}
if(!process.env.CLIENT_ID){
  console.error(`Missing CLIENT_ID in ${envFile}`);
  process.exit(1);
}
if(!/^\d{17,22}$/.test(String(process.env.CLIENT_ID))){
  console.error(`CLIENT_ID in ${envFile} does not look like a Discord application/client ID. Do not use a channel ID or server ID here.`);
  process.exit(1);
}

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
