'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');
const { getLatestSnapshotWithComparison } = require('../lib/stackers-analytics');

async function handleStackerStatsCommand(commandName, ctx){
  const { interaction, pgPool } = ctx;
  if(commandName !== 'stackerstats') return;

  await interaction.deferReply();

  const { latest, comparison } = await getLatestSnapshotWithComparison(pgPool).catch(() => ({ latest: null, comparison: null }));
  if(!latest){
    return interaction.editReply({
      content: 'No Stackers snapshot exists yet — the analytics job runs periodically and needs at least one full pass to have data. Check back after the next scheduled run.',
    });
  }

  const tierDist = latest.tier_distribution || {};
  const assetPop = latest.asset_popularity || {};
  const vaultTotals = latest.vault_totals || {};

  // Tier distribution, sorted by tier index. "0" (not yet tiered) shown last.
  const tierEntries = Object.entries(tierDist).sort(([a], [b]) => {
    if(a === '0') return 1;
    if(b === '0') return -1;
    return Number(a) - Number(b);
  });
  const tierLines = tierEntries.map(([tier, count]) => {
    const pct = ((count / latest.total_tokens) * 100).toFixed(1);
    const label = tier === '0' ? 'Not yet tiered' : `Tier ${tier}`;
    return `${label}: **${count}** (${pct}%)`;
  });

  // Asset popularity, sorted by count descending.
  const assetEntries = Object.entries(assetPop).sort(([, a], [, b]) => b - a);
  const assetLines = assetEntries.map(([symbol, count]) => {
    const pct = ((count / latest.total_tokens) * 100).toFixed(1);
    return `${symbol}: **${count}** (${pct}%)`;
  });

  // Current vault totals, sorted by symbol for stable ordering.
  const vaultEntries = Object.entries(vaultTotals).sort(([a], [b]) => a.localeCompare(b));
  const vaultLines = vaultEntries.map(([symbol, amount]) =>
    `${symbol}: **${parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: 4 })}**`
  );

  const embed = new EmbedBuilder()
    .setTitle('📊 Stackers Collection Stats')
    .setColor(0xF97316)
    .setFooter({ text: `Snapshot from ${new Date(latest.snapshot_at).toLocaleString()}` });

  // A snapshot now checkpoints its progress periodically rather than only
  // writing once at the end (a bot restart mid-run used to mean losing
  // everything). tokens_processed < total_tokens means this row is a
  // checkpoint from a run that got interrupted, not a complete picture —
  // shown clearly rather than silently presented as final.
  if(latest.tokens_processed < latest.total_tokens){
    const pct = ((latest.tokens_processed / latest.total_tokens) * 100).toFixed(0);
    embed.setDescription(`⚠️ **Partial snapshot** — only ${latest.tokens_processed}/${latest.total_tokens} tokens (${pct}%) were processed before this run was interrupted. Numbers below reflect just that subset, not the full collection. A complete run will replace this automatically.`);
  }

  embed.addFields(
    { name: 'Tokens', value: `${latest.total_tokens} total · ${latest.active_tokens} active`, inline: false },
    { name: '🎚️ Tier Distribution', value: tierLines.join('\n') || 'No data', inline: true },
    { name: '🎯 Asset Popularity', value: assetLines.join('\n') || 'No data', inline: true },
    { name: '🏦 Total Vault Holdings', value: vaultLines.join('\n') || 'Empty', inline: false },
  );

  // Honest "at today's rate" section — real observed change over roughly the
  // last 24h, in actual token quantities. Deliberately NOT converted to a
  // dollar figure: there's no price data source integrated for these
  // synthetic-stock tokens, and fabricating a USD estimate from nothing
  // would be exactly the kind of confident-sounding guess this feature was
  // built to avoid. If there's no comparison snapshot yet (not enough
  // history), this section is skipped entirely rather than shown empty.
  if(comparison && latest.tokens_processed === latest.total_tokens){
    const compTotals = comparison.vault_totals || {};
    const deltaLines = [];
    for(const [symbol, latestAmount] of Object.entries(vaultTotals)){
      const before = parseFloat(compTotals[symbol] || '0');
      const after = parseFloat(latestAmount);
      const delta = after - before;
      if(Math.abs(delta) < 0.0001) continue; // skip negligible/no-change assets
      const sign = delta >= 0 ? '+' : '';
      deltaLines.push(`${symbol}: ${sign}${delta.toLocaleString(undefined, { maximumFractionDigits: 4 })}`);
    }
    if(deltaLines.length){
      const hoursElapsed = (new Date(latest.snapshot_at) - new Date(comparison.snapshot_at)) / 3_600_000;
      embed.addFields({
        name: `📈 Collection-Wide Accrual (last ~${hoursElapsed.toFixed(0)}h, observed)`,
        value: deltaLines.join('\n') + '\n\n_Real change since the last snapshot — not a projection or promise, just what actually happened. Per-token/per-tier rates aren\'t shown here since actual earnings depend on live weight distribution, which shifts as Stackers activate, fuse, and re-tier._',
        inline: false,
      });
    }
  } else {
    embed.addFields({
      name: '📈 Collection-Wide Accrual',
      value: '_Not enough snapshot history yet to show a real accrual rate — check back once the analytics job has run for about a day._',
      inline: false,
    });
  }

  return interaction.editReply({ embeds: [embed] });
}

const STACKERSTATS_COMMANDS = new Set(['stackerstats']);

module.exports = { handleStackerStatsCommand, STACKERSTATS_COMMANDS };
