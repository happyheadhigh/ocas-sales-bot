'use strict';

const { EmbedBuilder } = require('discord.js');
const { getVaultListings } = require('../lib/stackers-vault-listings');
const { getWalletVaultSummary } = require('../lib/stackers-wallet-vault');
const { STACKERS_SLUG, NFT_ADDRESS } = require('../lib/stackers');

async function handleListingsSubcommand(interaction, pgPool){
  await interaction.deferReply();

  const rows = await getVaultListings(pgPool, 15).catch(e => {
    console.error('[stackervaults listings] getVaultListings failed:', e.message, e.stack);
    return null;
  });

  if(rows === null){
    return interaction.editReply({ content: 'Something went wrong looking this up — try again in a moment.' });
  }

  if(!rows.length){
    return interaction.editReply({
      content: 'No currently listed Stackers with unclaimed vault value found right now — either nothing qualifies, or the background check hasn\'t run yet. Check back after the next scheduled refresh.',
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🏦 Listed Stackers with Unclaimed Vault Value')
    .setColor(0xF97316)
    .setDescription('Sorted cheapest listing first.')
    .setFooter({ text: `Vault data checked periodically, not live — listing prices are current` });

  for(const row of rows.slice(0, 10)){
    const balances = row.vault_balances || [];
    const vaultText = balances.map(b => `${parseFloat(b.amountFormatted).toFixed(4)} ${b.symbol}`).join(', ');
    const priceStr = row.price_eth >= 1 ? Number(row.price_eth).toFixed(3) : Number(row.price_eth).toFixed(4);
    embed.addFields({
      name: `#${row.token_id} — Ξ${priceStr}`,
      value: `Vault: ${vaultText || 'empty'}\n[View on OpenSea](https://opensea.io/assets/robinhood/${NFT_ADDRESS}/${row.token_id})`,
      inline: false,
    });
  }

  if(rows.length > 10){
    embed.addFields({ name: '\u200b', value: `+ ${rows.length - 10} more not shown here`, inline: false });
  }

  return interaction.editReply({ embeds: [embed] });
}

async function handleWalletSubcommand(interaction, pgPool){
  await interaction.deferReply();

  let address = interaction.options.getString('address');
  if(address){
    address = address.trim().toLowerCase();
    if(!/^0x[0-9a-f]{40}$/.test(address)){
      return interaction.editReply({ content: 'That doesn\'t look like a valid wallet address.' });
    }
  } else {
    // No address given — resolve the user's own verified wallet. Same
    // cross-server "already verified anywhere" lookup used elsewhere in
    // this codebase, purely a convenience shortcut. The underlying data
    // is public on-chain state either way; nothing here requires actually
    // being verified except skipping having to type an address.
    const verifiedRes = await pgPool.query(
      `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
      [interaction.user.id]
    ).catch(() => ({ rows: [] }));
    if(!verifiedRes.rows.length){
      return interaction.editReply({
        content: 'You haven\'t verified a wallet yet, and no address was given. Either verify one, or run this again with an address: `/stackervaults wallet address:0x...`',
      });
    }
    address = verifiedRes.rows[0].wallet.toLowerCase();
  }

  const summary = await getWalletVaultSummary(address).catch(e => {
    console.error('[stackervaults wallet] getWalletVaultSummary failed:', e.message, e.stack);
    return null;
  });

  if(summary === null){
    return interaction.editReply({ content: 'Something went wrong looking this up — try again in a moment.' });
  }

  if(!summary.tokenCount){
    return interaction.editReply({ content: `\`${address}\` doesn't currently hold any Stackers.` });
  }

  const shortAddr = `${address.slice(0,6)}...${address.slice(-4)}`;
  const embed = new EmbedBuilder()
    .setTitle(`🏦 Unclaimed Vault Value — ${shortAddr}`)
    .setColor(0xF97316)
    .setDescription(`Across ${summary.tokenCount} held Stacker${summary.tokenCount === 1 ? '' : 's'}`);

  if(summary.totals.length){
    const lines = summary.totals.map(t => `${t.amount.toFixed(4)} ${t.symbol}`).join('\n');
    embed.addFields({ name: 'Total Unclaimed', value: lines, inline: false });
  } else {
    embed.addFields({ name: 'Total Unclaimed', value: 'Empty across all held tokens', inline: false });
  }

  if(summary.failed){
    embed.setFooter({ text: `${summary.failed} token(s) couldn't be checked — try again if this seems incomplete` });
  }

  return interaction.editReply({ embeds: [embed] });
}

async function handleStackerVaultsCommand(commandName, ctx){
  const { interaction, pgPool } = ctx;
  if(commandName !== 'stackervaults') return;

  const subcommand = interaction.options.getSubcommand();
  if(subcommand === 'wallet') return handleWalletSubcommand(interaction, pgPool);
  return handleListingsSubcommand(interaction, pgPool);
}

const STACKERVAULTS_COMMANDS = new Set(['stackervaults']);

module.exports = { handleStackerVaultsCommand, STACKERVAULTS_COMMANDS };
