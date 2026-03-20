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
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

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

// ── SVG → Discord-compatible image resolver ───────────────────────────────────
// Strategy:
//   1. Check if sale already has a usable PNG/JPG URL from OpenSea CDN
//   2. If not (SVG/data URI), fetch the token from OpenSea NFT endpoint
//      which usually has a display_image_url pointing to a CDN PNG
//   3. If still SVG, use a public SVG-to-PNG proxy
//   4. Cache result so we don't re-fetch the same token repeatedly

async function resolveImage(sale) {
  const id = sale.nft?.identifier;

  // Return cached result
  if (id && imageCache.has(id)) return imageCache.get(id);

  // Check URLs already in the sale event
  const candidates = [
    sale.nft?.display_image_url,
    sale.nft?.image_url,
    sale.nft?.image_preview_url,
  ];

  for (const url of candidates) {
    if (isDiscordCompatible(url)) {
      if (id) imageCache.set(id, url);
      console.log(`[Image] #${id} — direct CDN URL found`);
      return url;
    }
  }

  // Fetch full NFT from OpenSea — it usually has a CDN-rasterized PNG
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
            imageCache.set(id, url);
            console.log(`[Image] #${id} — resolved from NFT endpoint: ${url.slice(0, 60)}...`);
            return url;
          }
        }

        // OpenSea only has SVG — use a proxy to convert to PNG
        const svgSource = deepCandidates.find(u => u && !u.startsWith('<svg') && !u.startsWith('data:') && isSvg(u))
                       || candidates.find(u => u && !u.startsWith('<svg') && !u.startsWith('data:') && isSvg(u));

        if (svgSource) {
          const proxyUrl = `https://resvg.vercel.app/api?url=${encodeURIComponent(svgSource)}&width=500&height=500`;
          imageCache.set(id, proxyUrl);
          console.log(`[Image] #${id} — using SVG proxy for: ${svgSource.slice(0, 60)}`);
          return proxyUrl;
        }
      }
    } catch (e) {
      console.warn(`[Image] #${id} — NFT endpoint failed: ${e.message}`);
    }
  }

  console.log(`[Image] #${id} — no displayable image found, embedding without image`);
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

  // Resolve image with SVG fallback
  const imageUrl = await resolveImage(sale);
  if (imageUrl) embed.setImage(imageUrl);

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
    lastSeenSaleId = sales[0].id || sales[0].event_timestamp;
    console.log(`[Sales] Bot ready. Watching from sale ID: ${lastSeenSaleId}`);
    return;
  }

  // Collect new sales since last check
  const newSales = [];
  for (const sale of sales) {
    const sid = sale.id || sale.event_timestamp;
    if (sid === lastSeenSaleId) break;
    newSales.push(sale);
  }

  if (!newSales.length) return;
  lastSeenSaleId = sales[0].id || sales[0].event_timestamp;

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
      await channel.send({ embeds: [embed] });
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
