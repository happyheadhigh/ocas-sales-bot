/**
 * Run this ONCE to register slash commands globally with Discord.
 * After running, commands appear in all servers within ~1 hour.
 *
 * Usage: node register-commands.js
 */

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
  // ── Admin commands ──────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure the sales bot for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post sales in').setRequired(true))
    .addStringOption(o => o.setName('collection').setDescription('OpenSea collection slug (e.g. on-chain-all-stars)').setRequired(true))
    .addStringOption(o => o.setName('contract').setDescription('Contract address (e.g. 0x078be86...) — needed for /sale command').setRequired(false))
    .addBooleanOption(o => o.setName('traitview').setDescription('Include TraitView links? (default: true)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Change the channel where sales are posted')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('New sales channel').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setcollection')
    .setDescription('Change which NFT collection to watch')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('slug').setDescription('OpenSea collection slug').setRequired(true))
    .addStringOption(o => o.setName('contract').setDescription('Contract address').setRequired(false)),

  new SlashCommandBuilder()
    .setName('salesfilter')
    .setDescription('Only post sales where a trait matches a value')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('trait').setDescription('Trait name (e.g. Background)').setRequired(true))
    .addStringOption(o => o.setName('value').setDescription('Trait value (e.g. Blue)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('clearfilters')
    .setDescription('Remove all trait filters — watch all sales')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause sale notifications for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume sale notifications for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show current bot configuration for this server'),

  // ── Public commands ─────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('lastsale')
    .setDescription('Show the most recent sale')
    .addStringOption(o => o.setName('collection').setDescription('Collection slug (uses server default if not set)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('recentsales')
    .setDescription('Show the last N sales')
    .addIntegerOption(o => o.setName('count').setDescription('Number of sales to show (max 10, default 5)').setRequired(false).setMinValue(1).setMaxValue(10))
    .addStringOption(o => o.setName('collection').setDescription('Collection slug (uses server default if not set)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('sale')
    .setDescription('Show the most recent sale for a specific token')
    .addStringOption(o => o.setName('token').setDescription('Token ID (e.g. 7370 or #7370)').setRequired(true))
    .addStringOption(o => o.setName('collection').setDescription('Collection slug (uses server default if not set)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),
].map(c => c.toJSON());

const rest = new REST({ version:'10' }).setToken(process.env.DISCORD_TOKEN);

(async ()=>{
  try{
    console.log(`Registering ${commands.length} slash commands globally…`);
    const data = await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log(`✅ Registered ${data.length} commands successfully!`);
    console.log('Commands will appear in all servers within ~1 hour.');
    console.log('\nTo get your CLIENT_ID:');
    console.log('  discord.dev/applications → your app → General Information → Application ID');
  }catch(e){
    console.error('❌ Registration failed:', e.message);
  }
})();
