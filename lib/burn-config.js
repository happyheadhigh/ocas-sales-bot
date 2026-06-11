'use strict';

const { pgPool, dbLoad, dbSave } = require('./db');
const { BURN_ALERT_CHANNEL_ID } = require('./burn-constants');

// ── Burn machine config (stored per-guild via bot_state) ─────────────────────
// burnConfig: guildId -> { burnAlertChannelId }.
// Legacy { channelId } is still read for backwards compatibility.
let burnConfig = {};
async function loadBurnConfig(){
  const db = await dbLoad('burn_config');
  if(db){
    burnConfig = db;
    const configured = Object.entries(burnConfig || {})
      .map(([guildId, cfg]) => `${guildId}:${getConfiguredBurnChannelId(cfg) || 'none'}`)
      .join(', ');
    console.log(`[Burn] Config loaded (${Object.keys(burnConfig || {}).length} guilds): ${configured || 'none'}`);
  } else {
    burnConfig = {};
    console.log('[Burn] Config loaded (0 guilds): none');
  }
}
async function saveBurnConfig(){
  await dbSave('burn_config', burnConfig);
}
function getBurnConfig(guildId){ return burnConfig[guildId] || null; }
function getConfiguredBurnChannelId(cfg){
  return cfg?.burnAlertChannelId || cfg?.channelId || null;
}

function normalizePhrase(s){
  return String(s||"").toLowerCase().replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}

async function getTraitIndex(RAILWAY_URL, API_SECRET){
  const now = Date.now();
  if(global.__ocasTraitIndexCache && now - global.__ocasTraitIndexCache.ts < 60*60*1000)
    return global.__ocasTraitIndexCache.items;
  if(!RAILWAY_URL) return [];
  const qs = new URLSearchParams({ key: API_SECRET||"" });
  const r = await fetch(`${RAILWAY_URL}/db/trait-index?${qs}`);
  if(!r.ok) throw new Error(`trait-index API HTTP ${r.status}`);
  const j = await r.json();
  if(!j.ok) throw new Error(j.error||"trait-index API error");
  const items = (j.traits||[])
    .map(t => ({ trait_name:t.trait_name, trait_value:t.trait_value, token_count:Number(t.token_count||0), norm:normalizePhrase(t.trait_value) }))
    .filter(t => t.norm)
    .sort((a,b) => {
      const aw=a.norm.split(" ").length, bw=b.norm.split(" ").length;
      if(bw!==aw) return bw-aw;
      if(b.norm.length!==a.norm.length) return b.norm.length-a.norm.length;
      return (b.token_count||0)-(a.token_count||0);
    });
  global.__ocasTraitIndexCache = { ts:now, items };
  return items;
}

function chooseTraitGroupsFromQuery(search, traitIndex){
  let remaining = ` ${normalizePhrase(search)} `;
  const groups=[], unmatched=[], seenNorms=new Set();
  const byNorm = new Map();
  for(const item of traitIndex){
    if(!byNorm.has(item.norm)) byNorm.set(item.norm,[]);
    byNorm.get(item.norm).push(item);
  }
  const phrases = [...byNorm.keys()].sort((a,b)=>{
    const aw=a.split(" ").length, bw=b.split(" ").length;
    if(bw!==aw) return bw-aw;
    return b.length-a.length;
  });
  for(const phrase of phrases){
    if(seenNorms.has(phrase)) continue;
    const re = new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\\]\\]/g,"\\$&")}(?=\\s|$)`,"i");
    if(re.test(remaining)){
      const alts = byNorm.get(phrase).sort((a,b)=>(b.token_count||0)-(a.token_count||0)).map(x=>({trait_name:x.trait_name,trait_value:x.trait_value}));
      groups.push(alts);
      seenNorms.add(phrase);
      remaining = remaining.replace(re," ").replace(/\s+/g," ");
    }
  }
  let leftover = normalizePhrase(remaining).split(" ").filter(Boolean).filter(w=>!["and","with","plus"].includes(w));
  for(const word of leftover.slice()){
    if(word.length<3) continue;
    const re = new RegExp(`(^|\\s)${word.replace(/[.*+?^${}()|[\\]\\]/g,"\\$&")}(?=\\s|$)`,"i");
    const alts = traitIndex.filter(x=>re.test(x.norm)).slice(0,25);
    if(alts.length && alts.length<=12){
      groups.push(alts.map(x=>({trait_name:x.trait_name,trait_value:x.trait_value})));
      leftover = leftover.filter(w=>w!==word);
    }
  }
  unmatched.push(...leftover);
  return { groups, unmatched };
}

function getSweepTokenId(item){
  return item?.token_id ?? item?.id ?? item?.identifier ?? item?.tokenId ?? item?.tokenID ?? null;
}

function normalizeSweepListing(item){
  const tokenId = getSweepTokenId(item);
  return {
    token_id: tokenId ? parseInt(tokenId) : null,
    price_eth: item?.price_eth != null ? parseFloat(item.price_eth) : null,
    url: item?.url || null,
    os_rank: item?.os_rank ? parseInt(item.os_rank) : null,
    obs_rank: item?.obs_rank ? parseInt(item.obs_rank) : null,
    trait_count: item?.trait_count ? parseInt(item.trait_count) : null
  };
}

function sweepTokenUrl(item){
  const tokenId = getSweepTokenId(item);
  const contract = '0x078be86f3104a32313a47815792230a3808642cc';
  return tokenId ? ('https://opensea.io/assets/ethereum/' + contract + '/' + tokenId) : 'https://opensea.io/collection/on-chain-all-stars';
}

function formatSweepTokenLine(item){
  const tokenId = getSweepTokenId(item);
  const rank = item?.os_rank ? ('⬥' + Number(item.os_rank).toLocaleString()) : (item?.obs_rank ? ('⬥' + Number(item.obs_rank).toLocaleString()) : null);
  const tokenLink = '[#' + tokenId + '](' + sweepTokenUrl(item) + ')';
  const price = 'Ξ ' + parseFloat(item.price_eth).toFixed(4);
  return [tokenLink, rank, price].filter(Boolean).join(' · ');
}


// Clean up expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for(const [id, s] of slideshowSessions) {
    if(s.expiresAt < now) slideshowSessions.delete(id);
  }
}, 5 * 60 * 1000);

// Build navigation row
function buildNavRow(index, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('slide_prev')
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index === 0),
    new ButtonBuilder()
      .setCustomId('slide_pos')
      .setLabel(`${index + 1} / ${total}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('slide_next')
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index === total - 1)
  );
}

// Post a slideshow or individual embeds depending on count
async function postEmbeds(interaction, embeds, headerText) {
  if(embeds.length === 0) return;

  if(embeds.length <= 5) {
    // 5 or fewer — post all individually
    await interaction.editReply(headerText);
    for(const embed of embeds) {
      if(!embed) continue;
      await sendEmbed(interaction.channel, embed);
      await new Promise(r => setTimeout(r, 600));
    }
  } else {
    // 6+ — post first 5 individually, then a "Show More" button for the rest
    await interaction.editReply(headerText);
    const first5 = embeds.slice(0, 5);
    const remaining = embeds.slice(5);

    for(const embed of first5) {
      if(!embed) continue;
      await sendEmbed(interaction.channel, embed);
      await new Promise(r => setTimeout(r, 600));
    }

    // Post "Show More" button for remaining results
    const showMoreRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('show_more')
        .setLabel(`Show More (${remaining.length} remaining)`)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('▶️')
    );
    const moreMsg = await interaction.channel.send({
      content: `_${remaining.length} more result${remaining.length===1?'':'s'} — click to browse:_`,
      components: [showMoreRow]
    });

    // Store remaining embeds as a slideshow session keyed to this message
    slideshowSessions.set(moreMsg.id, {
      embeds: remaining,
      index: 0,
      userId: interaction.user.id,
      expiresAt: Date.now() + 15 * 60 * 1000,
      isShowMore: true  // flag so we know to open slideshow on first click
    });
  }
}

// ── Sweep detection ───────────────────────────────────────────────────────────
// Groups sales by buyer + tx hash within a poll batch.
// When a group hits 5+ tokens, marks each sale with _isSweep=true and fires
// a summary embed after the last sale in the sweep is posted.

const cachedFloors = new Map(); // guildId → floor ETH at start of poll cycle

async function fetchFloorEth(slug) {
  try {
    const r = await fetch(
      `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`,
      { headers: osHeaders() }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j?.total?.floor_price ?? j?.stats?.floor_price ?? null;
  } catch { return null; }
}

async function fireSweepAlert({ sales: sweepSales, config }, channel) {
  const buyer = sweepSales[0].buyer || 'unknown';
  const count = sweepSales.length;
  const total = sweepSales.reduce((sum, s) => sum + (parseFloat(formatEth(s)) || 0), 0);
  const avg   = total / count;

  const fmt = n => (n != null && n > 0) ? (n >= 1 ? n.toFixed(3) : n.toFixed(4)) : '—';
  const buyerLink = buyer !== 'unknown'
    ? `[${shortAddr(buyer)}](https://opensea.io/${buyer})`
    : 'unknown';

  const embed = new EmbedBuilder()
    .setTitle(`🧹 Sweep Alert`)
    .setColor(0xf59e0b)
    .addFields(
      { name: 'Buyer',       value: buyerLink,           inline: true },
      { name: 'Swept',       value: `${count} OCAS`,     inline: true },
      { name: '​',      value: '​',             inline: true },
      { name: 'Total Spent', value: `${fmt(total)} ETH`, inline: true },
      { name: 'Avg Buy',     value: `${fmt(avg)} ETH`,   inline: true },
    )
    .setFooter({ text: `Sales Bot · ${config.slug}` })
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
    console.log(`[Sweep] ${count} tokens by ${shortAddr(buyer)} in ${config.slug}`);
  } catch(e) {
    console.error('[Sweep alert post]', e.message);
  }
}

// ── Burn Machine poller ──────────────────────────────────────────────────────


module.exports = {
  burnConfig, loadBurnConfig, saveBurnConfig,
  getBurnConfig, getConfiguredBurnChannelId,
  checkCommandCooldown, fetchBotApiJson,
  resolveDiscordChannel,
};
