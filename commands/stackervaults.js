'use strict';

const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getVaultListings } = require('../lib/stackers-vault-listings');
const { getWalletVaultSummary, getHeldTokenIds } = require('../lib/stackers-wallet-vault');
const { STACKERS_SLUG, NFT_ADDRESS, formatStackersFields } = require('../lib/stackers');
const { getOrCacheStackerImage } = require('../lib/stackers-image-cache');
const { optimize } = require('../lib/stackers-optimizer');
const { getRecentRoundHistory } = require('../lib/stackers-analytics');

const LISTINGS_PAGE_SIZE = 10;
const LISTINGS_QUERY_LIMIT = 50; // raised from 15 -- the chain-mismatch fix (querying 'ethereum' instead of the real chain) means significantly more real listings should surface now than before

// Shared render logic — used by both the initial slash command and every
// button-click page change, so they can never drift out of sync with
// each other the way two separate copies of this logic eventually would.
function buildListingsPage(rows, page){
  const totalPages = Math.ceil(rows.length / LISTINGS_PAGE_SIZE);
  const pageRows = rows.slice(page * LISTINGS_PAGE_SIZE, (page + 1) * LISTINGS_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle('🏦 Listed Stackers with Unclaimed Vault Value')
    .setColor(0xF97316)
    .setDescription(`Sorted cheapest listing first.${totalPages > 1 ? ` Page ${page + 1} of ${totalPages}.` : ''}`)
    .setFooter({ text: 'Vault balances and listing prices are both live' });

  for(const row of pageRows){
    const balances = row.vault_balances || [];
    const vaultText = balances.map(b => `${parseFloat(b.amountFormatted).toFixed(4)} ${b.symbol}`).join(', ');
    const priceStr = row.price_eth >= 1 ? Number(row.price_eth).toFixed(3) : Number(row.price_eth).toFixed(4);
    embed.addFields({
      name: `#${row.token_id} — Ξ${priceStr}`,
      value: `Vault: ${vaultText || 'empty'}\n[View on OpenSea](https://opensea.io/assets/robinhood/${NFT_ADDRESS}/${row.token_id})`,
      inline: false,
    });
  }

  const components = [];
  if(totalPages > 1){
    const navRow = new ActionRowBuilder();
    if(page > 0){
      navRow.addComponents(
        new ButtonBuilder().setCustomId(`stackervaults:listings:page:${page - 1}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary)
      );
    }
    if(page < totalPages - 1){
      navRow.addComponents(
        new ButtonBuilder().setCustomId(`stackervaults:listings:page:${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary)
      );
    }
    components.push(navRow);
  }

  return { embed, components };
}

async function handleListingsSubcommand(interaction, pgPool){
  await interaction.deferReply();

  const rows = await getVaultListings(pgPool, LISTINGS_QUERY_LIMIT).catch(e => {
    console.error('[stackervaults listings] getVaultListings failed:', e.message, e.stack);
    return null;
  });

  if(rows === null){
    return interaction.editReply({ content: 'Something went wrong looking this up — try again in a moment.' });
  }

  if(!rows.length){
    return interaction.editReply({
      content: 'No currently listed Stackers with unclaimed vault value found right now — either nothing genuinely qualifies at the moment, or the one-time vault-balance seed hasn\'t finished yet for these tokens.',
    });
  }

  const { embed, components } = buildListingsPage(rows, 0);
  return interaction.editReply({ embeds: [embed], components });
}

// Button-click page changes — re-queries fresh each time rather than
// trying to carry the full result set through the customId itself
// (Discord caps custom IDs at 100 characters, nowhere near enough room
// for 50 rows of data). The query itself is a cheap Postgres join, not
// an RPC call, so re-running it per click is inexpensive.
async function handleListingsPageButton(interaction, pgPool){
  const page = parseInt(interaction.customId.split(':')[3], 10) || 0;

  const rows = await getVaultListings(pgPool, LISTINGS_QUERY_LIMIT).catch(e => {
    console.error('[stackervaults listings page] getVaultListings failed:', e.message, e.stack);
    return null;
  });

  if(rows === null || !rows.length){
    return interaction.update({ content: 'Something went wrong looking this up — try again in a moment.', embeds: [], components: [] });
  }

  const { embed, components } = buildListingsPage(rows, page);
  return interaction.update({ embeds: [embed], components });
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

async function handleTokenSubcommand(interaction, pgPool){
  await interaction.deferReply();

  const tokenId = interaction.options.getInteger('id');

  // Same formatter already proven working in the fusion alert embeds —
  // tier, split, and vault balance in one call, fails safe (returns an
  // empty array, not a thrown error) if the token can't be read at all.
  const fields = await formatStackersFields(String(tokenId)).catch(() => []);
  if(!fields.length){
    return interaction.editReply({
      content: `Couldn't read data for Stacker #${tokenId} — either the token ID is wrong, or there was a temporary issue reading the chain. Try again in a moment.`,
    });
  }

  const listingRes = await pgPool.query(
    `SELECT price_eth FROM listings WHERE token_id = $1 AND collection_slug = $2`,
    [tokenId, STACKERS_SLUG]
  ).catch(() => ({ rows: [] }));
  const listing = listingRes.rows[0];

  const embed = new EmbedBuilder()
    .setTitle(`Stacker #${tokenId}`)
    .setColor(0xF97316)
    .setURL(`https://opensea.io/assets/robinhood/${NFT_ADDRESS}/${tokenId}`)
    .addFields(...fields);

  if(listing){
    const priceStr = listing.price_eth >= 1 ? Number(listing.price_eth).toFixed(3) : Number(listing.price_eth).toFixed(4);
    embed.addFields({ name: '🏷️ Listed', value: `Ξ${priceStr}`, inline: false });
  } else {
    embed.addFields({ name: '🏷️ Listed', value: 'Not currently listed', inline: false });
  }

  // Cache-first, not force-refresh — unlike the fusion handler, there's
  // no specific reason to suspect the art just changed here, so the
  // faster cached read is the right choice for an on-demand lookup.
  const files = [];
  try{
    const cached = await getOrCacheStackerImage(pgPool, tokenId);
    const ext = cached.isSvg ? 'svg' : 'png';
    const filename = `stacker-${tokenId}.${ext}`;
    const buffer = cached.isSvg ? Buffer.from(cached.data, 'utf8') : cached.data;
    files.push(new AttachmentBuilder(buffer, { name: filename }));
    embed.setImage(`attachment://${filename}`);
  }catch(e){
    console.warn(`[stackervaults token] Failed to attach image for #${tokenId}:`, e.message);
  }

  return interaction.editReply({ embeds: [embed], files });
}

// Fetches the list of currently listed, fused Stackers, cheapest first.
// Uses the Fused trait directly (confirmed real, OpenSea-filterable data:
// "2 parts"/"3 parts"/"No") rather than event-based tracking -- this
// covers every fusion in the collection's full history, not just ones
// that happen from here forward, since it reads from already-synced
// metadata rather than something built from scratch tonight.
async function getListedFusedTokens(pgPool){
  const res = await pgPool.query(
    `SELECT tt.token_id, tt.trait_value AS fused_parts, l.price_eth
     FROM token_traits tt
     JOIN listings l ON l.token_id = tt.token_id AND l.collection_slug = $1
     WHERE tt.collection_slug = $1 AND tt.trait_name = 'Fused' AND tt.trait_value != 'No'
     ORDER BY l.price_eth ASC`,
    [STACKERS_SLUG]
  );
  return res.rows;
}

// Shared render logic for one token in the fused browser — used by both
// the initial command and every Prev/Next click, same reasoning as
// buildListingsPage: one copy of this logic instead of two that could
// drift apart. Reuses formatStackersFields (tier/split/vault, same
// formatter proven working in tonight's fusion alerts) and the same
// image-attachment approach as handleTokenSubcommand.
async function buildFusedTokenView(pgPool, fusedList, index){
  const entry = fusedList[index];
  const tokenId = entry.token_id;

  const fields = await formatStackersFields(String(tokenId)).catch(() => []);

  const priceStr = entry.price_eth >= 1 ? Number(entry.price_eth).toFixed(3) : Number(entry.price_eth).toFixed(4);
  const embed = new EmbedBuilder()
    .setTitle(`🔥 Stacker #${tokenId} — Fused (${entry.fused_parts})`)
    .setColor(0xF97316)
    .setURL(`https://opensea.io/assets/robinhood/${NFT_ADDRESS}/${tokenId}`)
    .setDescription(`Listed for Ξ${priceStr} · ${index + 1} of ${fusedList.length}`);

  if(fields.length) embed.addFields(...fields);

  const files = [];
  try{
    const cached = await getOrCacheStackerImage(pgPool, tokenId);
    const ext = cached.isSvg ? 'svg' : 'png';
    const filename = `stacker-${tokenId}.${ext}`;
    const buffer = cached.isSvg ? Buffer.from(cached.data, 'utf8') : cached.data;
    files.push(new AttachmentBuilder(buffer, { name: filename }));
    embed.setImage(`attachment://${filename}`);
  }catch(e){
    console.warn(`[stackervaults fused] Failed to attach image for #${tokenId}:`, e.message);
  }

  const components = [];
  if(fusedList.length > 1){
    const navRow = new ActionRowBuilder();
    if(index > 0){
      navRow.addComponents(
        new ButtonBuilder().setCustomId(`stackervaults:fused:page:${index - 1}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary)
      );
    }
    if(index < fusedList.length - 1){
      navRow.addComponents(
        new ButtonBuilder().setCustomId(`stackervaults:fused:page:${index + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary)
      );
    }
    components.push(navRow);
  }

  return { embed, components, files };
}

async function handleFusedSubcommand(interaction, pgPool){
  await interaction.deferReply();

  const fusedList = await getListedFusedTokens(pgPool).catch(e => {
    console.error('[stackervaults fused] getListedFusedTokens failed:', e.message, e.stack);
    return null;
  });

  if(fusedList === null){
    return interaction.editReply({ content: 'Something went wrong looking this up — try again in a moment.' });
  }

  if(!fusedList.length){
    return interaction.editReply({ content: 'No currently listed fused Stackers found right now.' });
  }

  const { embed, components, files } = await buildFusedTokenView(pgPool, fusedList, 0);
  return interaction.editReply({ embeds: [embed], components, files });
}

// Button-click navigation — re-queries the listed+fused set fresh each
// time rather than carrying it through the customId (same reasoning as
// the listings pagination: Discord's 100-char customId limit, and this
// query is a cheap Postgres join, not an RPC call).
async function handleFusedPageButton(interaction, pgPool){
  const index = parseInt(interaction.customId.split(':')[3], 10) || 0;

  const fusedList = await getListedFusedTokens(pgPool).catch(e => {
    console.error('[stackervaults fused page] getListedFusedTokens failed:', e.message, e.stack);
    return null;
  });

  if(fusedList === null || !fusedList.length){
    return interaction.update({ content: 'Something went wrong looking this up — try again in a moment.', embeds: [], components: [], files: [] });
  }

  const safeIndex = Math.min(index, fusedList.length - 1);
  const { embed, components, files } = await buildFusedTokenView(pgPool, fusedList, safeIndex);
  return interaction.update({ embeds: [embed], components, files });
}

// Tier index -> display multiplier, matching Stackers' own docs table exactly
const TIER_MULTIPLIERS = [null, 1.0, 1.4, 1.9, 2.5, 3.5];

async function handleOptimizeSubcommand(interaction, pgPool){
  await interaction.deferReply();

  const budget = interaction.options.getInteger('budget');

  let address = interaction.options.getString('address');
  if(address){
    address = address.trim().toLowerCase();
    if(!/^0x[0-9a-f]{40}$/.test(address)){
      return interaction.editReply({ content: 'That doesn\'t look like a valid wallet address.' });
    }
  } else {
    const verifiedRes = await pgPool.query(
      `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
      [interaction.user.id]
    ).catch(() => ({ rows: [] }));
    if(!verifiedRes.rows.length){
      return interaction.editReply({
        content: 'You haven\'t verified a wallet yet, and no address was given. Either verify one, or run this again with an address: `/stackervaults optimize budget:X address:0x...`',
      });
    }
    address = verifiedRes.rows[0].wallet.toLowerCase();
  }

  const tokenIds = await getHeldTokenIds(address).catch(e => {
    console.error('[stackervaults optimize] getHeldTokenIds failed:', e.message, e.stack);
    return null;
  });

  if(tokenIds === null){
    return interaction.editReply({ content: 'Something went wrong looking up that wallet — try again in a moment.' });
  }
  if(!tokenIds.length){
    return interaction.editReply({ content: `That wallet doesn't hold any Stackers right now.` });
  }

  const statusRes = await pgPool.query(
    `SELECT token_id, tier_index FROM stackers_token_status WHERE token_id = ANY($1)`,
    [tokenIds]
  ).catch(() => ({ rows: [] }));
  const tierByToken = new Map(statusRes.rows.map(r => [r.token_id, r.tier_index]));

  // tier 0 = asleep/never activated -- matches the optimizer's own indexing
  const tokens = tokenIds.map(id => {
    const tierIndex = tierByToken.get(id);
    return { id, tier: tierIndex !== undefined && tierIndex !== null ? tierIndex + 1 : 0 };
  });

  const result = optimize(tokens, budget);

  const actionLines = result.actionsTaken.map((a, idx) => {
    const step = idx + 1;
    if(a.type === 'upgrade'){
      const mult = TIER_MULTIPLIERS[a.toTier];
      const reforgeNote = a.componentId !== a.groupSurvivorId ? ` (Reforge, part of #${a.groupSurvivorId}'s fused group)` : '';
      return `**${step}.** Upgrade #${a.componentId} to ${mult}×${reforgeNote} — **${a.cost.toLocaleString()}** $STACK`;
    }
    const verb = a.type === 'fusePair' ? 'Fuse' : 'Fuse (3-way)';
    return `**${step}.** ${verb} #${a.survivorId} + #${a.absorbedIds.join(' + #')} → new weight **${a.resultingWeight}** — **${a.cost.toLocaleString()}** $STACK`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🧮 Stacker Strategy — Recommended Steps')
    .setColor(0xF97316)
    .setDescription(
      actionLines.length
        ? actionLines.join('\n') + '\n\n_A strong, reasoned allocation — not a mathematical guarantee of the single best possible one. Each step is a separate on-chain transaction, in the order shown._'
        : '_No beneficial action found — either your budget is too small for anything meaningful, or everything you hold is already fully optimized._'
    )
    .addFields(
      { name: 'Budget', value: `${budget.toLocaleString()} $STACK`, inline: true },
      { name: 'Spent', value: `${result.totalSpent.toLocaleString()} $STACK`, inline: true },
      { name: 'Unused', value: `${result.remainingBudget.toLocaleString()} $STACK`, inline: true },
      { name: 'Resulting Total Weight', value: `${result.totalWeight}`, inline: false },
    );

  if(result.remainingBudget > 0 && actionLines.length){
    embed.addFields({ name: 'Why budget is left over', value: 'Everything affordable with what remains is already at max tier or fully fused — more Stackers would be needed to usefully spend the rest.', inline: false });
  }

  // Real, recent round data grounds this in what actually happened
  // recently rather than a guessed formula -- but genuinely volatile
  // hour to hour, and rewards depend entirely on trading activity that
  // isn't guaranteed or predictable going forward.
  const recentRounds = await getRecentRoundHistory(pgPool, 24).catch(() => []);
  if(recentRounds.length >= 2){
    const totalPotWei = recentRounds.reduce((sum, r) => sum + BigInt(r.pot_wei), 0n);
    const totalWeightSum = recentRounds.reduce((sum, r) => sum + BigInt(r.total_weight), 0n);
    const avgPotWei = totalPotWei / BigInt(recentRounds.length);
    const avgTotalWeight = totalWeightSum / BigInt(recentRounds.length);

    if(avgTotalWeight > 0n){
      const myShareOfPotWei = (avgPotWei * BigInt(result.totalWeight)) / avgTotalWeight;
      const estimatedEthPerHour = Number(myShareOfPotWei) / 1e18;
      embed.addFields({
        name: '📈 Estimated Earnings (based on real recent rounds)',
        value: `~**${estimatedEthPerHour.toFixed(6)} ETH/hour** worth of assets, based on the last ${recentRounds.length} recorded round(s) — averaged to smooth out any single hour's volume being unusually high or low.\n\n_A real estimate, not a promise — trading volume drives the actual pot every hour and isn't guaranteed or predictable. Doesn't account for your own added weight very slightly increasing the collection's total, a small effect given your share relative to the whole collection._`,
        inline: false,
      });
    }
  } else {
    embed.addFields({
      name: '📈 Estimated Earnings',
      value: `_Not enough real round history yet to estimate — ${recentRounds.length} recorded so far, need at least 2. Check back in a couple hours._`,
      inline: false,
    });
  }

  embed.setFooter({ text: `Planning for ${address.slice(0,6)}...${address.slice(-4)} · ${tokens.length} Stacker(s) held` });

  return interaction.editReply({ embeds: [embed] });
}

async function handleStackerVaultsCommand(commandName, ctx){
  const { interaction, pgPool } = ctx;
  if(commandName !== 'stackervaults') return;

  const subcommand = interaction.options.getSubcommand();
  if(subcommand === 'wallet') return handleWalletSubcommand(interaction, pgPool);
  if(subcommand === 'token') return handleTokenSubcommand(interaction, pgPool);
  if(subcommand === 'fused') return handleFusedSubcommand(interaction, pgPool);
  if(subcommand === 'optimize') return handleOptimizeSubcommand(interaction, pgPool);
  return handleListingsSubcommand(interaction, pgPool);
}

const STACKERVAULTS_COMMANDS = new Set(['stackervaults']);

module.exports = { handleStackerVaultsCommand, STACKERVAULTS_COMMANDS, handleListingsPageButton, handleFusedPageButton };
