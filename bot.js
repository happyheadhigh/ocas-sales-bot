/**
 * OCAS Discord Sales Bot — SVG IMAGE FIX EDITION
 * ─────────────────────────────────────────────────────────────
 * Watches On-Chain All Stars sales via OpenSea API v2 and posts
 * rich embeds with token image to a Discord channel.
 *
 * SVG FIX: OCAS is a fully on-chain collection. Raw SVG images
 * don't display in Discord. This bot resolves each token's image
 * through OpenSea's NFT endpoint which returns a CDN-hosted PNG,
 * then falls back to a resvg PNG conversion service if needed.
 *
 * TRAIT FILTER commands (usable by anyone in Discord):
 *   !salesfilter Background Blue        → only ping sales with Background = Blue
 *   !salesfilter Eyes Laser             → filter by Eyes = Laser
 *   !salesfilter Background Blue Eyes Laser → multi-trait AND filter
 *   !salesfilters                       → show active filters
 *   !clearsalesfilters                  → remove all filters
 *   !saleson / !salesoff                → pause / resume sale pings
 *   !salesstatus                        → show bot status
 *   !saleshelp                          → show all commands
 *
 * HOST FREE: Railway.app (connect GitHub repo, add env vars)
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');
const sharp = require('sharp');

// ── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID    = process.env.SALES_CHANNEL_ID;
const OPENSEA_KEY   = process.env.OPENSEA_KEY || '';
const OS_SLUG       = 'on-chain-all-stars';
const CONTRACT      = '0x078be86f3104a32313a47815792230a3808642cc';
const POLL_MS       = parseInt(process.env.POLL_MS || '30000', 10);
const CMD_PREFIX    = '!';

// ── State ────────────────────────────────────────────────────────────────────
let lastSeenSaleId = null;
let paused         = false;
let traitFilters   = new Map(); // Map<traitName lowercase, value lowercase>

// Image cache: tokenId → resolved PNG url (avoids re-fetching same token)
const imageCache = new Map();

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function osHeaders() {
  const h = { accept: 'application/json' };
  if (OPENSEA_KEY) h['x-api-key'] = OPENSEA_KEY;
  return h;
}

function formatEth(event) {
  try {
    const qty = BigInt(event.payment?.quantity || '0');
    const dec = event.payment?.decimals ?? 18;
    const eth = Number(qty) / Math.pow(10, dec);
    if (!isFinite(eth) || eth <= 0) return null;
    return eth >= 1 ? eth.toFixed(4) : eth.toFixed(5);
  } catch { return null; }
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || 'unknown';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function timeSince(unixTs) {
  const s = Math.floor(Date.now() / 1000 - unixTs);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function isSvg(url) {
  if (!url) return false;
  const s = String(url).trim();
  return s.startsWith('<svg') ||
         s.startsWith('data:image/svg') ||
         s.toLowerCase().endsWith('.svg') ||
         s.includes('image/svg');
}

function isDiscordCompatible(url) {
  if (!url) return false;
  if (isSvg(url)) return false;
  const s = url.toLowerCase();
  return (s.startsWith('http://') || s.startsWith('https://')) &&
         !s.startsWith('data:') &&
         !s.startsWith('<svg');
}

// ── OCAS SVG image extractor ─────────────────────────────────────────────────
// OCAS SVGs use <foreignObject><img src="data:image/png;base64,..."> to embed
// the actual pixel art PNG. librsvg (used by sharp) doesn't support foreignObject,
// so we extract the embedded PNG directly instead of rendering the SVG.
async function extractPngFromOcasSvg(svgSource) {
  let svgText;

  if (svgSource.startsWith('data:image/svg')) {
    // data URI — base64 decode to get SVG text
    const b64 = svgSource.split(',')[1];
    if (!b64) throw new Error('Empty SVG data URI');
    svgText = Buffer.from(b64, 'base64').toString('utf-8');
  } else {
    // Remote URL — fetch SVG text
    const r = await fetch(svgSource);
    if (!r.ok) throw new Error(`SVG fetch: ${r.status}`);
    svgText = await r.text();
  }

  // Extract the embedded PNG base64 from <img src="data:image/png;base64,...">
  const pngMatch = svgText.match(/src=["']data:image\/png;base64,([A-Za-z0-9+/=\s]+)["']/);
  if (pngMatch) {
    const pngB64 = pngMatch[1].replace(/\s/g, '');
    const pngBuffer = Buffer.from(pngB64, 'base64');
    // Scale up from tiny pixel art (24x24) to 500x500 using nearest-neighbor
    return sharp(pngBuffer)
      .resize(500, 500, { kernel: 'nearest' })
      .png()
      .toBuffer();
  }

  // Fallback: no embedded PNG found, try rendering SVG directly
  // (won't show character but at least shows background)
  const svgBuffer = Buffer.from(svgText, 'utf-8');
  return sharp(svgBuffer, { density: 150 })
    .resize(500, 500, { fit: 'contain' })
    .png()
    .toBuffer();
}

// ── Image resolver — returns { url } or { buffer, filename } ─────────────────
// Strategy:
//   1. Check if OpenSea already has a Discord-compatible CDN PNG/JPG
//   2. Fetch the OpenSea NFT endpoint for better image fields
//   3. If all we have is SVG, download and convert to PNG with sharp
//   4. Cache results

async function resolveImage(sale) {
  const id = sale.nft?.identifier;

  if (id && imageCache.has(id)) return imageCache.get(id);

  // Gather all candidate URLs from the sale event
  const candidates = [
    sale.nft?.display_image_url,
    sale.nft?.image_url,
    sale.nft?.image_preview_url,
  ];

  // Step 1: direct CDN URL check
  for (const url of candidates) {
    if (isDiscordCompatible(url)) {
      const result = { type: 'url', url };
      if (id) imageCache.set(id, result);
      console.log(`[Image] #${id} — direct CDN URL`);
      return result;
    }
  }

  // Step 2: fetch full NFT from OpenSea
  let svgSource = null;
  if (id) {
    try {
      console.log(`[Image] #${id} — fetching from OpenSea NFT endpoint`);
      const nftUrl = `https://api.opensea.io/api/v2/chain/ethereum/contract/${CONTRACT}/nfts/${id}`;
      const r = await fetch(nftUrl, { headers: osHeaders() });
      if (r.ok) {
        const j = await r.json();
        const nft = j.nft || j;
        const deepCandidates = [
          nft.display_image_url,
          nft.image_url,
          nft.image_preview_url,
          nft.image_thumbnail_url,
        ];
        for (const url of deepCandidates) {
          if (isDiscordCompatible(url)) {
            const result = { type: 'url', url };
            imageCache.set(id, result);
            console.log(`[Image] #${id} — CDN URL from NFT endpoint`);
            return result;
          }
        }
        // Collect the SVG source for step 3
        svgSource = deepCandidates.find(u => u && isSvg(u))
                 || candidates.find(u => u && isSvg(u));
      }
    } catch (e) {
      console.warn(`[Image] #${id} — NFT endpoint error: ${e.message}`);
    }
  }

  if (!svgSource) {
    svgSource = candidates.find(u => u && isSvg(u));
  }

  // Step 3: convert SVG → PNG with sharp
  if (svgSource) {
    try {
      console.log(`[Image] #${id} — converting SVG to PNG with sharp`);
      const pngBuffer = await extractPngFromOcasSvg(svgSource);
      const result = { type: 'buffer', buffer: pngBuffer, filename: `ocas-${id}.png` };
      if (id) imageCache.set(id, result);
      console.log(`[Image] #${id} — SVG converted to PNG (${pngBuffer.length} bytes)`);
      return result;
    } catch (e) {
      console.warn(`[Image] #${id} — SVG conversion failed: ${e.message}`);
    }
  }

  console.log(`[Image] #${id} — no image available`);
  return null;
}

// ── Trait filter check ────────────────────────────────────────────────────────
function matchesFilters(sale) {
  if (traitFilters.size === 0) return true;
  const nftTraits = sale.nft?.traits || [];
  const lookup = {};
  for (const t of nftTraits) {
    lookup[t.trait_type?.toLowerCase()] = String(t.value).toLowerCase();
  }
  for (const [name, val] of traitFilters) {
    if (lookup[name] !== val) return false;
  }
  return true;
}

// ── Build Discord embed ───────────────────────────────────────────────────────
async function buildEmbed(sale) {
  const id       = sale.nft?.identifier;
  const name     = sale.nft?.name || `#${id}`;
  const ethPrice = formatEth(sale);
  const buyer    = shortAddr(sale.buyer);
  const seller   = shortAddr(sale.seller);
  const timeStr  = sale.event_timestamp ? timeSince(sale.event_timestamp) : '';
  const osUrl    = `https://opensea.io/assets/ethereum/${CONTRACT}/${id}`;
  const meUrl    = `https://magiceden.io/collections/ethereum/on-chain_all_stars/${id}`;
  const tvUrl    = `https://traitview.com/#${id}`;

  const embed = new EmbedBuilder()
    .setTitle(`🟢  Sale — On-Chain All Stars ${name}`)
    .setColor(0x2dd4bf)
    .setURL(osUrl)
    .setFooter({ text: `OCAS Sales Bot • traitview.com${timeStr ? ' • ' + timeStr : ''}` })
    .setTimestamp();

  // Resolve image — may return a URL string or a PNG buffer
  const imageResult = await resolveImage(sale);
  // We'll return the result alongside the embed so the caller can attach files
  embed._imageResult = imageResult;

  embed.addFields(
    { name: 'Price',  value: ethPrice ? `◆ ${ethPrice} ETH` : '—', inline: true },
    { name: 'Buyer',  value: buyer,  inline: true },
    { name: 'Seller', value: seller, inline: true },
  );

  // Traits
  const nftTraits = sale.nft?.traits || [];
  if (nftTraits.length > 0) {
    const traitLines = nftTraits
      .slice(0, 12)
      .map(t => `**${t.trait_type}**: ${t.value}`)
      .join('\n');
    embed.addFields({ name: 'Traits', value: traitLines, inline: false });
  }

  // Active filter note
  if (traitFilters.size > 0) {
    const filterStr = [...traitFilters.entries()]
      .map(([k, v]) => `${k}: ${v}`)
      .join(' • ');
    embed.addFields({ name: '🔍 Filter active', value: filterStr, inline: false });
  }

  embed.addFields({
    name: 'Links',
    value: `[OpenSea](${osUrl}) • [Magic Eden](${meUrl}) • [TraitView](${tvUrl})`,
    inline: false,
  });

  return embed;
}

// ── Poll OpenSea for new sales ────────────────────────────────────────────────
async function pollSales() {
  if (paused) return;

  let sales;
  try {
    const url = `https://api.opensea.io/api/v2/events/collection/${OS_SLUG}?event_type=sale&limit=20`;
    const r   = await fetch(url, { headers: osHeaders() });
    if (!r.ok) {
      console.warn(`[Sales] OpenSea returned ${r.status}`);
      return;
    }
    const j = await r.json();
    sales = j.asset_events || [];
  } catch (e) {
    console.error('[Sales] fetch error:', e.message);
    return;
  }

  if (!sales.length) return;

  // First run — set cursor without posting
  if (lastSeenSaleId === null) {
    lastSeenSaleId = String(sales[0].id || sales[0].event_timestamp);
    console.log(`[Sales] Bot ready. Watching from sale ID: ${lastSeenSaleId}`);
    return;
  }

  // Collect new sales since last check — always compare as strings
  const newSales = [];
  for (const sale of sales) {
    const sid = String(sale.id || sale.event_timestamp);
    if (sid === lastSeenSaleId) break;
    newSales.push(sale);
  }

  if (!newSales.length) return;
  lastSeenSaleId = String(sales[0].id || sales[0].event_timestamp);

  const channel = client.channels.cache.get(CHANNEL_ID);
  if (!channel) {
    console.warn('[Sales] Channel not found:', CHANNEL_ID);
    return;
  }

  // Post newest→oldest so Discord shows chronological order
  for (const sale of newSales.reverse()) {
    if (!matchesFilters(sale)) {
      console.log(`[Sales] Skipping #${sale.nft?.identifier} — filtered`);
      continue;
    }
    try {
      const embed = await buildEmbed(sale);
      const imageResult = embed._imageResult;
      delete embed._imageResult;

      if (imageResult?.type === 'buffer') {
        // Attach PNG file and reference it in the embed
        const attachment = new AttachmentBuilder(imageResult.buffer, { name: imageResult.filename });
        embed.setImage(`attachment://${imageResult.filename}`);
        await channel.send({ embeds: [embed], files: [attachment] });
      } else if (imageResult?.type === 'url') {
        embed.setImage(imageResult.url);
        await channel.send({ embeds: [embed] });
      } else {
        await channel.send({ embeds: [embed] });
      }
      console.log(`[Sales] Posted sale #${sale.nft?.identifier}`);
    } catch (e) {
      console.error('[Sales] Error posting embed:', e.message);
    }
  }
}

// ── Discord commands ──────────────────────────────────────────────────────────
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(CMD_PREFIX)) return;

  const raw   = msg.content.slice(CMD_PREFIX.length).trim();
  const parts = raw.split(/\s+/);
  const cmd   = parts[0]?.toLowerCase();

  if (cmd === 'saleshelp') {
    await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🤖 OCAS Sales Bot — Commands')
          .setColor(0x7aa2ff)
          .setDescription(
            '**!salesfilter <Trait> <Value>**\n' +
            'Filter to sales matching that trait.\n' +
            'Stack multiple: `!salesfilter Background Blue Eyes Laser`\n\n' +
            '**!salesfilters** — Show active filters\n\n' +
            '**!clearsalesfilters** — Remove all filters\n\n' +
            '**!saleson / !salesoff** — Resume / pause pings\n\n' +
            '**!salesstatus** — Show bot status\n\n' +
            '**!saleshelp** — This message\n\n' +
            '**— Testing commands —**\n' +
            '**!lastsale** — Post the most recent sale right now\n' +
            '**!recentsales [N]** — Post last N sales (default 5, max 10)\n' +
            '**!sale #1234** — Post most recent sale for a specific token\n' +
            '**!debugimage #1234** — Show raw image URLs for a token (diagnose SVG issue)\n\n' +
            '*Trait names and values are case-insensitive.*'
          )
      ],
    });
    return;
  }

  if (cmd === 'salesfilter') {
    const args = parts.slice(1);
    if (args.length < 2 || args.length % 2 !== 0) {
      await msg.reply('⚠️ Usage: `!salesfilter <TraitName> <Value>`\nExample: `!salesfilter Background Blue`\nMulti: `!salesfilter Background Blue Eyes Laser`');
      return;
    }
    traitFilters.clear();
    const pairs = [];
    for (let i = 0; i < args.length; i += 2) {
      traitFilters.set(args[i].toLowerCase(), args[i + 1].toLowerCase());
      pairs.push(`**${args[i]}** = ${args[i + 1]}`);
    }
    await msg.reply(`✅ Filter set! Only posting sales matching:\n${pairs.join('\n')}\n\nUse \`!clearsalesfilters\` to remove.`);
    return;
  }

  if (cmd === 'salesfilters') {
    if (traitFilters.size === 0) {
      await msg.reply('No filters active — showing all sales.');
    } else {
      const lines = [...traitFilters.entries()].map(([k, v]) => `• **${k}** = ${v}`).join('\n');
      await msg.reply(`Current filters:\n${lines}`);
    }
    return;
  }

  if (cmd === 'clearsalesfilters') {
    traitFilters.clear();
    await msg.reply('✅ Filters cleared — watching all sales.');
    return;
  }

  if (cmd === 'salesoff') {
    paused = true;
    await msg.reply('⏸ Paused. Use `!saleson` to resume.');
    return;
  }

  if (cmd === 'saleson') {
    paused = false;
    await msg.reply('▶️ Resumed!');
    return;
  }

  if (cmd === 'salesstatus') {
    const filterStr = traitFilters.size > 0
      ? [...traitFilters.entries()].map(([k, v]) => `${k}=${v}`).join(', ')
      : 'none (all sales)';
    await msg.reply(
      `📊 **OCAS Sales Bot Status**\n` +
      `• Paused: ${paused ? 'Yes ⏸' : 'No ▶️'}\n` +
      `• Poll: every ${POLL_MS / 1000}s\n` +
      `• Filters: ${filterStr}\n` +
      `• OpenSea key: ${OPENSEA_KEY ? 'Set ✅' : 'Not set ⚠️'}\n` +
      `• Image cache: ${imageCache.size} tokens`
    );
    return;
  }

  // !lastsale — fetch the single most recent sale (great for testing image display)
  if (cmd === 'lastsale') {
    await msg.reply('🔍 Fetching most recent sale...');
    try {
      const url = `https://api.opensea.io/api/v2/events/collection/${OS_SLUG}?event_type=sale&limit=1`;
      const r   = await fetch(url, { headers: osHeaders() });
      if (!r.ok) { await msg.reply(`❌ OpenSea error: ${r.status}`); return; }
      const j     = await r.json();
      const sales = j.asset_events || [];
      if (!sales.length) { await msg.reply('No sales found.'); return; }
      const embed = await buildEmbed(sales[0]);
      embed.setTitle(`🧪 TEST — ${embed.data.title}`);
      const ir = embed._imageResult; delete embed._imageResult;
      if (ir?.type === 'buffer') {
        const att = new AttachmentBuilder(ir.buffer, { name: ir.filename });
        embed.setImage(`attachment://${ir.filename}`);
        await msg.reply({ embeds: [embed], files: [att] });
      } else {
        if (ir?.type === 'url') embed.setImage(ir.url);
        await msg.reply({ embeds: [embed] });
      }
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  // !recentsales [count] — show last N sales (default 5, max 10)
  if (cmd === 'recentsales') {
    const count = Math.min(parseInt(parts[1]) || 5, 10);
    await msg.reply(`🔍 Fetching last ${count} sales...`);
    try {
      const url = `https://api.opensea.io/api/v2/events/collection/${OS_SLUG}?event_type=sale&limit=${count}`;
      const r   = await fetch(url, { headers: osHeaders() });
      if (!r.ok) { await msg.reply(`❌ OpenSea error: ${r.status}`); return; }
      const j     = await r.json();
      const sales = j.asset_events || [];
      if (!sales.length) { await msg.reply('No sales found.'); return; }
      for (const sale of sales.reverse()) {
        const embed = await buildEmbed(sale);
        embed.setTitle(`🧪 TEST — ${embed.data.title}`);
        const ir2 = embed._imageResult; delete embed._imageResult;
        if (ir2?.type === 'buffer') {
          const att2 = new AttachmentBuilder(ir2.buffer, { name: ir2.filename });
          embed.setImage(`attachment://${ir2.filename}`);
          await msg.channel.send({ embeds: [embed], files: [att2] });
        } else {
          if (ir2?.type === 'url') embed.setImage(ir2.url);
          await msg.channel.send({ embeds: [embed] });
        }
        await new Promise(res => setTimeout(res, 800));
      }
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  // !sale #ID — fetch a specific token's most recent sale
  if (cmd === 'sale') {
    const tokenId = parts[1]?.replace('#', '');
    if (!tokenId || isNaN(tokenId)) {
      await msg.reply('Usage: `!sale 1234` or `!sale #1234`');
      return;
    }
    await msg.reply(`🔍 Fetching sale for #${tokenId}...`);
    try {
      const url = `https://api.opensea.io/api/v2/events/chain/ethereum/contract/${CONTRACT}/nfts/${tokenId}?event_type=sale&limit=1`;
      const r   = await fetch(url, { headers: osHeaders() });
      if (!r.ok) { await msg.reply(`❌ OpenSea error: ${r.status}`); return; }
      const j     = await r.json();
      const sales = j.asset_events || [];
      if (!sales.length) { await msg.reply(`No sales found for #${tokenId}.`); return; }
      const embed = await buildEmbed(sales[0]);
      embed.setTitle(`🧪 TEST — ${embed.data.title}`);
      const ir3 = embed._imageResult; delete embed._imageResult;
      if (ir3?.type === 'buffer') {
        const att3 = new AttachmentBuilder(ir3.buffer, { name: ir3.filename });
        embed.setImage(`attachment://${ir3.filename}`);
        await msg.reply({ embeds: [embed], files: [att3] });
      } else {
        if (ir3?.type === 'url') embed.setImage(ir3.url);
        await msg.reply({ embeds: [embed] });
      }
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  // !debugimage #ID — shows exactly what image URLs OpenSea returns for a token
  if (cmd === 'debugimage') {
    const tokenId = (parts[1] || '3930').replace('#', '');
    await msg.reply(`🔬 Checking image URLs for #${tokenId}...`);
    try {
      // Step 1: check the NFT endpoint
      const nftUrl = `https://api.opensea.io/api/v2/chain/ethereum/contract/${CONTRACT}/nfts/${tokenId}`;
      const r = await fetch(nftUrl, { headers: osHeaders() });
      const j = await r.json();
      const nft = j.nft || j;

      const fields = [
        `**image_url:** ${nft.image_url || 'null'}`,
        `**display_image_url:** ${nft.display_image_url || 'null'}`,
        `**image_preview_url:** ${nft.image_preview_url || 'null'}`,
        `**image_thumbnail_url:** ${nft.image_thumbnail_url || 'null'}`,
        `**animation_url:** ${nft.animation_url || 'null'}`,
        `**metadata_url:** ${nft.metadata_url || 'null'}`,
        `\n**isSvg(image_url):** ${isSvg(nft.image_url)}`,
        `**isDiscordCompatible(display_image_url):** ${isDiscordCompatible(nft.display_image_url)}`,
        `**HTTP status:** ${r.status}`,
      ];

      // Also check what the sale event itself returns
      const saleUrl = `https://api.opensea.io/api/v2/events/chain/ethereum/contract/${CONTRACT}/nfts/${tokenId}?event_type=sale&limit=1`;
      const r2 = await fetch(saleUrl, { headers: osHeaders() });
      const j2 = await r2.json();
      const saleNft = j2.asset_events?.[0]?.nft;
      if (saleNft) {
        fields.push(`\n**Sale event image_url:** ${saleNft.image_url || 'null'}`);
        fields.push(`**Sale event display_image_url:** ${saleNft.display_image_url || 'null'}`);
      }

      await msg.reply(fields.join('\n').slice(0, 1900));
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return;
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ OCAS Sales Bot online as ${client.user.tag}`);
  console.log(`   Channel: ${CHANNEL_ID}`);
  console.log(`   Poll every: ${POLL_MS / 1000}s`);
  console.log(`   OpenSea key: ${OPENSEA_KEY ? 'set' : 'NOT SET — may be rate limited'}`);
  pollSales();
  setInterval(pollSales, POLL_MS);
});

client.on('error', (e) => console.error('[Discord] Error:', e.message));
process.on('unhandledRejection', (e) => console.error('[Bot] Unhandled rejection:', e));

client.login(DISCORD_TOKEN);
