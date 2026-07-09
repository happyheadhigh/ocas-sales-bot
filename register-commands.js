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



  new SlashCommandBuilder().setName('status').setDescription('Show current bot configuration'),


  new SlashCommandBuilder().setName('download')
  .setDescription('Download a high-res PNG for OCAS or another configured collection — leave blank for a guided menu')
  .addStringOption(o=>o.setName('search').setDescription('Example: ocas #337 2048 no bg').setRequired(false))
  .addIntegerOption(o=>o.setName('token').setDescription('Token ID').setRequired(false).setMinValue(1))
  .addStringOption(o=>o.setName('collection').setDescription('Collection slug or alias. Defaults to OCAS').setRequired(false).setAutocomplete(true))
  .addIntegerOption(o=>o.setName('size').setDescription('PNG size in pixels, default 2048').setRequired(false).setMinValue(512).setMaxValue(4096))
  .addBooleanOption(o=>o.setName('transparent').setDescription('Export with transparent/no background').setRequired(false)),

  new SlashCommandBuilder().setName('lastsale').setDescription('Show the most recent sale').addStringOption(o=>o.setName('collection').setDescription('Collection slug (uses server default if not set)').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder().setName('recentsales').setDescription('Show the last N sales').addIntegerOption(o=>o.setName('count').setDescription('Number of sales (max 20, default 5)').setRequired(false).setMinValue(1).setMaxValue(20)).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder().setName('sale').setDescription('Show the last sale for a specific token').addStringOption(o=>o.setName('token').setDescription('Token ID (e.g. 7370)').setRequired(true)).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder().setName('traitfind').setDescription('Find tokens, listings, or sales by trait — leave blank for a guided menu').addStringOption(o=>o.setName('trait').setDescription('Trait name (e.g. Emotion, Type, Clothes)').setRequired(false).setAutocomplete(true)).addStringOption(o=>o.setName('value').setDescription('Trait value (e.g. Sadness, Zombie, Gold Chain)').setRequired(false).setAutocomplete(true)).addStringOption(o=>o.setName('mode').setDescription('What to search (default: tokens)').setRequired(false).addChoices({name:'Tokens',value:'tokens'},{name:'Listings',value:'listings'},{name:'Sales',value:'sales'})).addIntegerOption(o=>o.setName('count').setDescription('Number of results (default 20, max 50)').setRequired(false).setMinValue(1).setMaxValue(50)).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder().setName('listings').setDescription('Show recent new listings').addIntegerOption(o=>o.setName('count').setDescription('Number of listings (max 20, default 5)').setRequired(false).setMinValue(1).setMaxValue(20)).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder().setName('me').setDescription('Your personal hub — alerts, wallet, preferences'),
  new SlashCommandBuilder().setName('debuglisting').setDescription('Show raw listing event data to diagnose issues (admin only)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false)),


  new SlashCommandBuilder().setName('help').setDescription('Show all available commands'),

  new SlashCommandBuilder().setName('rankfind').setDescription('Find listings or sales by OS rank range — leave blank for a guided menu').addIntegerOption(o=>o.setName('min_rank').setDescription('Minimum OS rank (default 1)').setRequired(false).setMinValue(1).setMaxValue(10000)).addIntegerOption(o=>o.setName('max_rank').setDescription('Maximum OS rank (default 100)').setRequired(false).setMinValue(1).setMaxValue(10000)).addStringOption(o=>o.setName('mode').setDescription('What to search (default: listings)').setRequired(false).addChoices({name:'Listings',value:'listings'},{name:'Sales',value:'sales'})).addStringOption(o=>o.setName('sort').setDescription('Sort order for listings (default: cheapest first)').setRequired(false).addChoices({name:'Cheapest first',value:'price'},{name:'Best rank first',value:'rank'})).addStringOption(o=>o.setName('collection').setDescription('Collection slug').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder().setName('ocas').setDescription('Show a random OCAS — search by trait, count, rank, or token ID').addIntegerOption(o=>o.setName('token').setDescription('Specific token ID').setRequired(false).setMinValue(1).setMaxValue(10000)).addStringOption(o=>o.setName('search').setDescription('Search: zombie, 15 traits, rank 1-100, or token number').setRequired(false)),
  new SlashCommandBuilder().setName('token').setDescription('Show a random OCAS — search by trait, count, rank, or token ID').addIntegerOption(o=>o.setName('token').setDescription('Specific token ID').setRequired(false).setMinValue(1).setMaxValue(10000)).addStringOption(o=>o.setName('search').setDescription('Search: zombie, 15 traits, rank 1-100, or token number').setRequired(false))
    .addStringOption(o=>o.setName('collection').setDescription('Collection to search (defaults to primary)').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder().setName('sweep').setDescription('Calculate ETH cost to sweep cheapest listed OCAS').addStringOption(o=>o.setName('search').setDescription('e.g. 10, 2eth, 0.05 floor, 10 zombie').setRequired(false)),

  new SlashCommandBuilder().setName('burnstats').setDescription('Show OCAS Burn Machine stats — total burned, created, estimated supply'),
  new SlashCommandBuilder().setName('burnlatest').setDescription('Show recent finalized OCAS burn events').addIntegerOption(o=>o.setName('count').setDescription('Number of burns to show (max 10, default 1)').setRequired(false).setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName('burn').setDescription('Show burn status and lineage for a token').addIntegerOption(o=>o.setName('token').setDescription('Token ID').setRequired(true).setMinValue(1).setMaxValue(10000)),
  new SlashCommandBuilder().setName('burnwallet').setDescription('Show burn history for a wallet address').addStringOption(o=>o.setName('wallet').setDescription('Wallet address (0x...)').setRequired(true)),
  new SlashCommandBuilder().setName('burnleaderboard').setDescription('Top OCAS burners ranked by tokens burned'),
  new SlashCommandBuilder().setName('burnrefresh').setDescription('Refresh metadata and re-post burn alert for a created token (5 min cooldown)').addIntegerOption(o=>o.setName('token').setDescription('Survivor/created token ID').setRequired(true).setMinValue(1).setMaxValue(10000)),

  new SlashCommandBuilder().setName('synctraits').setDescription('Refresh token traits from contract — fixes missing/stale traits in DB (admin only)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('mode').setDescription('survivors = refresh all burn survivors; token = single token (default)').setRequired(false).addChoices({name:'Single token',value:'token'},{name:'All burn survivors',value:'survivors'}))
    .addIntegerOption(o=>o.setName('token').setDescription('Token ID (required for single token mode)').setRequired(false).setMinValue(1).setMaxValue(10000)),







  new SlashCommandBuilder().setName('setup').setDescription('Setup wizard — configure your bot step by step (Admin only)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('config').setDescription('Configure your bot — collections, channels, roles (Admin only)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('lotteries').setDescription('View live and completed lotteries and giveaways'),
  new SlashCommandBuilder().setName('giveaway').setDescription('Start a burn lottery, giveaway, guess game, or instant draw (Admin only)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('resetverify')
    .setDescription('Clear a member\'s verification so they can verify again (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(o => o.setName('user').setDescription('User to reset (leave blank to reset yourself)').setRequired(false))
    .addBooleanOption(o => o.setName('global').setDescription('Also clear the cross-server verification shortcut (owner only)').setRequired(false)),
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




