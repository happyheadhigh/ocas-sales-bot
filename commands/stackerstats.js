'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');
const { getLatestSnapshotWithComparison } = require('../lib/stackers-analytics');

// Tier/asset stats computed live from the event-driven status cache
// (lib/stackers-status-poller.js) rather than the periodic snapshot —
// tier and split both have dedicated on-chain events, so this data is
// genuinely current, not up-to-24h stale. Vault balance has no confirmed
// event mapping yet, so it still comes from the slower full snapshot,
// unchanged. Convention matches the original snapshot code exactly:
// tier_index is 0-based on-chain, displayed 1-based ("Tier 1"-"Tier 5"),
// "0" reserved for tokens with no tier yet.
async function getInstantTierAndAssetStats(pgPool){
  const res = await pgPool.query(`SELECT tier_index, is_active, split FROM stackers_token_status`);
  const totalTracked = res.rows.length;
  if(!totalTracked) return null;

  const tierDist = {};
  const assetPop = {};
  let activeCount = 0;
  for(const row of res.rows){
    const tierLabel = row.tier_index === null ? '0' : String(row.tier_index + 1);
    tierDist[tierLabel] = (tierDist[tierLabel] || 0) + 1;
    if(row.is_active) activeCount++;
    const split = row.split || [];
    for(const s of split){
      if(!s?.symbol) continue;
      assetPop[s.symbol] = (assetPop[s.symbol] || 0) + 1;
    }
  }
  return { totalTracked, tierDist, assetPop, activeCount };
}

async function handleStackerStatsCommand(commandName, ctx){
  const { interaction, pgPool } = ctx;
  if(commandName !== 'stackerstats') return;

  await interaction.deferReply();

  const { latest, comparison } = await getLatestSnapshotWithComparison(pgPool).catch(e => {
    console.error('[stackerstats] getLatestSnapshotWithComparison failed:', e.message, e.stack);
    return { latest: null, comparison: null };
  });

  const instant = await getInstantTierAndAssetStats(pgPool).catch(e => {
    console.error('[stackerstats] getInstantTierAndAssetStats failed:', e.message, e.stack);
    return null;
  });

  if(!latest && !instant){
    return interaction.editReply({
      content: 'No Stackers data available yet — both the analytics snapshot and the live status cache need at least one run. Check back shortly.',
    });
  }

  // Prefer the instant, event-driven cache for tier/asset/active data —
  // falls back to the periodic snapshot only during the brief window
  // before the status cache has been seeded at all.
  const usingInstant = !!instant;
  const tierDist = usingInstant ? instant.tierDist : (latest?.tier_distribution || {});
  const assetPop = usingInstant ? instant.assetPop : (latest?.asset_popularity || {});
  const totalForPct = usingInstant ? instant.totalTracked : (latest?.total_tokens || 0);
  const activeTokens = usingInstant ? instant.activeCount : latest?.active_tokens;
  const totalTokensDisplay = usingInstant ? instant.totalTracked : latest?.total_tokens;

  const tierEntries = Object.entries(tierDist).sort(([a], [b]) => {
    if(a === '0') return 1;
    if(b === '0') return -1;
    return Number(a) - Number(b);
  });
  const tierLines = tierEntries.map(([tier, count]) => {
    const pct = totalForPct ? ((count / totalForPct) * 100).toFixed(1) : '0.0';
    const label = tier === '0' ? 'Not yet tiered' : `Tier ${tier}`;
    return `${label}: **${count}** (${pct}%)`;
  });

  const assetEntries = Object.entries(assetPop).sort(([, a], [, b]) => b - a);
  const assetLines = assetEntries.map(([symbol, count]) => {
    const pct = totalForPct ? ((count / totalForPct) * 100).toFixed(1) : '0.0';
    return `${symbol}: **${count}** (${pct}%)`;
  });

  const vaultTotals = latest?.vault_totals || {};
  const vaultEntries = Object.entries(vaultTotals).sort(([a], [b]) => a.localeCompare(b));
  const vaultLines = vaultEntries.map(([symbol, amount]) =>
    `${symbol}: **${parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: 4 })}**`
  );

  const embed = new EmbedBuilder()
    .setTitle('📊 Stackers Collection Stats')
    .setColor(0xF97316);

  const footerParts = [];
  if(usingInstant) footerParts.push('Tier/Asset: live');
  else footerParts.push('Tier/Asset: last snapshot');
  if(latest) footerParts.push(`Vault: snapshot from ${new Date(latest.snapshot_at).toLocaleString()}`);
  embed.setFooter({ text: footerParts.join(' · ') });

  if(!usingInstant){
    embed.setDescription('_Live tier/asset cache hasn\'t been seeded yet — showing the last full snapshot instead. This will switch to live automatically once the one-time backfill runs._');
  } else if(latest && latest.tokens_processed < latest.total_tokens){
    const pct = ((latest.tokens_processed / latest.total_tokens) * 100).toFixed(0);
    embed.setDescription(`⚠️ Vault holdings below are from a **partial snapshot** — only ${latest.tokens_processed}/${latest.total_tokens} tokens (${pct}%) were processed before that run was interrupted. Tier/Asset data above is live and unaffected.`);
  }

  embed.addFields(
    { name: 'Tokens', value: `${totalTokensDisplay ?? '?'} total · ${activeTokens ?? '?'} active`, inline: false },
    { name: '🎚️ Tier Distribution', value: tierLines.join('\n') || 'No data', inline: true },
    { name: '🎯 Asset Popularity', value: assetLines.join('\n') || 'No data', inline: true },
    { name: '🏦 Total Vault Holdings', value: vaultLines.join('\n') || 'No snapshot data yet', inline: false },
  );

  if(comparison && latest && latest.tokens_processed === latest.total_tokens){
    const compTotals = comparison.vault_totals || {};
    const deltaLines = [];
    for(const [symbol, latestAmount] of Object.entries(vaultTotals)){
      const before = parseFloat(compTotals[symbol] || '0');
      const after = parseFloat(latestAmount);
      const delta = after - before;
      if(Math.abs(delta) < 0.0001) continue;
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
  } else if(latest){
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
