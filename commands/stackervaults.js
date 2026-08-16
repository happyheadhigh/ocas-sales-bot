'use strict';

const { EmbedBuilder } = require('discord.js');
const { getVaultListings } = require('../lib/stackers-vault-listings');
const { STACKERS_SLUG, NFT_ADDRESS } = require('../lib/stackers');

async function handleStackerVaultsCommand(commandName, ctx){
  const { interaction, pgPool } = ctx;
  if(commandName !== 'stackervaults') return;

  await interaction.deferReply();

  const rows = await getVaultListings(pgPool, 15).catch(e => {
    console.error('[stackervaults] getVaultListings failed:', e.message, e.stack);
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

const STACKERVAULTS_COMMANDS = new Set(['stackervaults']);

module.exports = { handleStackerVaultsCommand, STACKERVAULTS_COMMANDS };
