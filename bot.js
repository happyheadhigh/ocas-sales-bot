/**
 * OCAS Discord Sales Bot — FIXED
 * ------------------------------------------------------------
 * Fixes included:
 * - Reliable channel fetching for auto-posts
 * - Poll locking (prevents overlapping intervals)
 * - Persistent lastSeenSaleId via state.json
 * - Automatic SVG / base64 SVG -> PNG conversion
 * - Discord-safe image attachments for fully onchain NFTs
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { Resvg } = require('@resvg/resvg-js');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');

// ── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.SALES_CHANNEL_ID;
const OPENSEA_KEY = process.env.OPENSEA_KEY || '';
const OS_SLUG = 'on-chain-all-stars';
const CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const POLL_MS = parseInt(process.env.POLL_MS || '30000', 10);
const CMD_PREFIX = '!';
const STATE_FILE = path.join(__dirname, 'state.json');

// ── State ────────────────────────────────────────────────────────────────────
let lastSeenSaleId = null;
let paused = false;
let pollInProgress = false;
let traitFilters = new Map(); // Map<traitName lowercase, value lowercase>

// imageCache stores:
// tokenId -> { type: 'url', value: 'https://...' }
// tokenId -> { type: 'pngBuffer', value: <Buffer> }
const imageCache = new Map();

// ── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── State persistence ────────────────────────────────────────────────────────
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log('[State] No state file found yet');
      return;
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    lastSeenSaleId = parsed.lastSeenSaleId ?? null;
    console.log(`[State] Loaded lastSeenSaleId: ${lastSeenSaleId}`);
  } catch (e) {
    console.warn('[State] Failed to load state:', e.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ lastSeenSaleId }, null, 2),
      'utf8'
    );
  } catch (e) {
    console.warn('[State] Failed to save state:', e.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
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
  } catch {
    return null;
  }
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || 'unknown';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function timeSince(unixTs) {
  const ts = Number(unixTs);
  if (!ts || !Number.isFinite(ts)) return '';
  const nowSec = Math.floor(Date.now() / 1000);

  // OpenSea sometimes returns seconds, sometimes ISO strings in other endpoints.
  // Your existing event_timestamp has worked numerically, so keep seconds logic first.
  const s = nowSec - ts;
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function isSvg(value) {
  if (!value) return false;
  const s = String(value).trim().toLowerCase();
  return (
    s.startsWith('<svg') ||
    s.startsWith('data:image/svg+xml') ||
    s.includes('image/svg+xml') ||
    s.endsWith('.svg')
  );
}

function isHttpUrl(value) {
  if (!value) return false;
  const s = String(value).trim().toLowerCase();
  return s.startsWith('http://') || s.startsWith('https://');
}

function isDiscordCompatibleRasterUrl(value) {
  if (!value) return false;
  const s = String(value).trim();
  if (!isHttpUrl(s)) return false;
  if (isSvg(s)) return false;
  if (s.startsWith('data:')) return false;
  return true;
}

function safeTokenId(sale) {
  return sale?.nft?.identifier || 'unknown';
}

function getSaleId(sale) {
  return sale?.id || sale?.event_timestamp || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripDataUriPrefix(dataUri) {
  const idx = dataUri.indexOf(',');
  return idx === -1 ? dataUri : dataUri.slice(idx + 1);
}

function decodeBase64Utf8(base64) {
  return Buffer.from(base64, 'base64').toString('utf8');
}

function isLikelyBase64(str) {
  return /^[A-Za-z0-9+/=\r\n]+$/.test(str);
}

// ── Data URI / metadata helpers ──────────────────────────────────────────────
function extractSvgFromDataUri(input) {
  if (!input || typeof input !== 'string') return null;

  const s = input.trim();

  // data:image/svg+xml;base64,...
  if (s.startsWith('data:image/svg+xml;base64,')) {
    try {
      return Buffer.from(stripDataUriPrefix(s), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  // data:image/svg+xml;utf8,...
  if (s.startsWith('data:image/svg+xml;utf8,')) {
    try {
      return decodeURIComponent(stripDataUriPrefix(s));
    } catch {
      return stripDataUriPrefix(s);
    }
  }

  // raw SVG string
  if (s.startsWith('<svg')) return s;

  return null;
}

function extractJsonFromDataUri(input) {
  if (!input || typeof input !== 'string') return null;

  const s = input.trim();

  // data:application/json;base64,...
  if (s.startsWith('data:application/json;base64,')) {
    try {
      return JSON.parse(Buffer.from(stripDataUriPrefix(s), 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }

  // data:application/json;utf8,...
  if (s.startsWith('data:application/json;utf8,')) {
    try {
      return JSON.parse(decodeURIComponent(stripDataUriPrefix(s)));
    } catch {
      return null;
    }
  }

  return null;
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: '*/*',
    },
  });
  if (!r.ok) throw new Error(`fetchText failed: ${r.status}`);
  return r.text();
}

async function renderSvgToPngBuffer(svgString) {
  const resvg = new Resvg(svgString, {
    fitTo: {
      mode: 'width',
      value: 800,
    },
  });
  const pngData = resvg.render();
  return pngData.asPng();
}

async function svgUrlToPngBuffer(svgUrl) {
  const svgText = await fetchText(svgUrl);
  return renderSvgToPngBuffer(svgText);
}

// ── Resolve image from sale / NFT endpoint ───────────────────────────────────
async function fetchNftFromOpenSea(tokenId) {
  const nftUrl = `https://api.opensea.io/api/v2/chain/ethereum/contract/${CONTRACT}/nfts/${tokenId}`;
  const r = await fetch(nftUrl, { headers: osHeaders() });
  if (!r.ok) {
    throw new Error(`OpenSea NFT endpoint returned ${r.status}`);
  }
  const j = await r.json();
  return j.nft || j;
}

function collectImageCandidates(sale, nft) {
  return [
    sale?.nft?.display_image_url,
    sale?.nft?.image_url,
    sale?.nft?.image_preview_url,
    sale?.nft?.metadata_url,
    nft?.display_image_url,
    nft?.image_url,
    nft?.image_preview_url,
    nft?.image_thumbnail_url,
    nft?.metadata_url,
    nft?.animation_url,
    nft?.token_uri,
    nft?.tokenUri,
    nft?.image_original_url,
  ].filter(Boolean);
}

async function tryResolveFromMetadataSource(source) {
  // Case 1: direct SVG data URI
  const directSvg = extractSvgFromDataUri(source);
  if (directSvg) {
    const png = await renderSvgToPngBuffer(directSvg);
    return { type: 'pngBuffer', value: png };
  }

  // Case 2: data:application/json with image inside
  const jsonFromDataUri = extractJsonFromDataUri(source);
  if (jsonFromDataUri?.image) {
    const nestedSvg = extractSvgFromDataUri(jsonFromDataUri.image);
    if (nestedSvg) {
      const png = await renderSvgToPngBuffer(nestedSvg);
      return { type: 'pngBuffer', value: png };
    }
    if (isDiscordCompatibleRasterUrl(jsonFromDataUri.image)) {
      return { type: 'url', value: jsonFromDataUri.image };
    }
    if (isSvg(jsonFromDataUri.image) && isHttpUrl(jsonFromDataUri.image)) {
      const png = await svgUrlToPngBuffer(jsonFromDataUri.image);
      return { type: 'pngBuffer', value: png };
    }
  }

  // Case 3: normal raster URL
  if (isDiscordCompatibleRasterUrl(source)) {
    return { type: 'url', value: source };
  }

  // Case 4: SVG URL
  if (isSvg(source) && isHttpUrl(source)) {
    const png = await svgUrlToPngBuffer(source);
    return { type: 'pngBuffer', value: png };
  }

  // Case 5: metadata URL that returns JSON
  if (isHttpUrl(source) && !isSvg(source)) {
    try {
      const text = await fetchText(source);

      // Try JSON first
      try {
        const json = JSON.parse(text);
        if (json?.image) {
          const nestedSvg = extractSvgFromDataUri(json.image);
          if (nestedSvg) {
            const png = await renderSvgToPngBuffer(nestedSvg);
            return { type: 'pngBuffer', value: png };
          }
          if (isDiscordCompatibleRasterUrl(json.image)) {
            return { type: 'url', value: json.image };
          }
          if (isSvg(json.image) && isHttpUrl(json.image)) {
            const png = await svgUrlToPngBuffer(json.image);
            return { type: 'pngBuffer', value: png };
          }
        }
      } catch {
        // not JSON
      }

      // Maybe the URL itself returned raw SVG
      if (text.trim().startsWith('<svg')) {
        const png = await renderSvgToPngBuffer(text);
        return { type: 'pngBuffer', value: png };
      }
    } catch {
      // ignore and continue
    }
  }

  return null;
}

async function resolveImageAsset(sale) {
  const tokenId = safeTokenId(sale);

  if (imageCache.has(tokenId)) {
    return imageCache.get(tokenId);
  }

  let nft = null;
  try {
    nft = await fetchNftFromOpenSea(tokenId);
  } catch (e) {
    console.warn(`[Image] #${tokenId} — OpenSea NFT lookup failed: ${e.message}`);
  }

  const candidates = collectImageCandidates(sale, nft);

  for (const candidate of candidates) {
    try {
      const resolved = await tryResolveFromMetadataSource(candidate);
      if (resolved) {
        imageCache.set(tokenId, resolved);
        console.log(`[Image] #${tokenId} — resolved as ${resolved.type}`);
        return resolved;
      }
    } catch (e) {
      console.warn(
        `[Image] #${tokenId} — candidate resolution failed: ${e.message}`
      );
    }
  }

  console.log(`[Image] #${tokenId} — no usable image found`);
  return null;
}

// ── Trait filter check ───────────────────────────────────────────────────────
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

// ── Build Discord payload ────────────────────────────────────────────────────
async function buildMessagePayload(sale, { testMode = false } = {}) {
  const tokenId = safeTokenId(sale);
  const name = sale.nft?.name || `#${tokenId}`;
  const ethPrice = formatEth(sale);
  const buyer = shortAddr(sale.buyer);
  const seller = shortAddr(sale.seller);
  const timeStr = sale.event_timestamp ? timeSince(sale.event_timestamp) : '';
  const osUrl = `https://opensea.io/assets/ethereum/${CONTRACT}/${tokenId}`;
  const meUrl = `https://magiceden.io/collections/ethereum/on-chain_all_stars/${tokenId}`;
  const tvUrl = `https://traitview.com/#${tokenId}`;

  const embed = new EmbedBuilder()
    .setTitle(`${testMode ? '🧪 TEST — ' : '🟢  Sale — '}On-Chain All Stars ${name}`)
    .setColor(0x2dd4bf)
    .setURL(osUrl)
    .setFooter({
      text: `OCAS Sales Bot • traitview.com${timeStr ? ' • ' + timeStr : ''}`,
    })
    .setTimestamp();

  const files = [];
  const imageAsset = await resolveImageAsset(sale);

  if (imageAsset) {
    if (imageAsset.type === 'url') {
      embed.setImage(imageAsset.value);
    } else if (imageAsset.type === 'pngBuffer') {
      const filename = `token-${tokenId}.png`;
      files.push(new AttachmentBuilder(imageAsset.value, { name: filename }));
      embed.setImage(`attachment://${filename}`);
    }
  }

  embed.addFields(
    { name: 'Price', value: ethPrice ? `◆ ${ethPrice} ETH` : '—', inline: true },
    { name: 'Buyer', value: buyer, inline: true },
    { name: 'Seller', value: seller, inline: true }
  );

  const nftTraits = sale.nft?.traits || [];
  if (nftTraits.length > 0) {
    const traitLines = nftTraits
      .slice(0, 12)
      .map((t) => `**${t.trait_type}**: ${t.value}`)
      .join('\n');
    embed.addFields({ name: 'Traits', value: traitLines, inline: false });
  }

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

  return { embeds: [embed], files };
}

// ── OpenSea polling ──────────────────────────────────────────────────────────
async function fetchLatestSales(limit = 20) {
  const url = `https://api.opensea.io/api/v2/events/collection/${OS_SLUG}?event_type=sale&limit=${limit}`;
  const r = await fetch(url, { headers: osHeaders() });
  if (!r.ok) {
    throw new Error(`OpenSea returned ${r.status}`);
  }
  const j = await r.json();
  return j.asset_events || [];
}

async function getSalesChannel() {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    return channel || null;
  } catch (e) {
    console.warn('[Sales] Channel fetch failed:', e.message);
    return null;
  }
}

async function pollSales() {
  if (paused) return;

  if (pollInProgress) {
    console.log('[Sales] Poll skipped — previous poll still running');
    return;
  }

  pollInProgress = true;

  try {
    const sales = await fetchLatestSales(20);
    if (!sales.length) return;

    // First run: establish cursor without posting old sales
    if (lastSeenSaleId === null) {
      lastSeenSaleId = getSaleId(sales[0]);
      saveState();
      console.log(`[Sales] Ready. Watching from sale ID: ${lastSeenSaleId}`);
      return;
    }

    const newSales = [];
    for (const sale of sales) {
      const sid = getSaleId(sale);
      if (sid === lastSeenSaleId) break;
      newSales.push(sale);
    }

    if (!newSales.length) return;

    const newestSeenId = getSaleId(sales[0]);
    const channel = await getSalesChannel();

    if (!channel) {
      console.warn('[Sales] Channel not found:', CHANNEL_ID);
      return;
    }

    // oldest -> newest so Discord reads in order
    for (const sale of newSales.reverse()) {
      if (!matchesFilters(sale)) {
        console.log(`[Sales] Skipping #${safeTokenId(sale)} — filtered`);
        continue;
      }

      try {
        const payload = await buildMessagePayload(sale);
        await channel.send(payload);
        console.log(`[Sales] Posted sale #${safeTokenId(sale)}`);
        await sleep(700);
      } catch (e) {
        console.error(
          `[Sales] Error posting #${safeTokenId(sale)}:`,
          e.message
        );
      }
    }

    lastSeenSaleId = newestSeenId;
    saveState();
  } catch (e) {
    console.error('[Sales] Poll error:', e.message);
  } finally {
    pollInProgress = false;
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(CMD_PREFIX)) return;

  const raw = msg.content.slice(CMD_PREFIX.length).trim();
  const parts = raw.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

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
              '**!sale #1234** — Post most recent sale for a specific token\n\n' +
              '*Trait names and values are case-insensitive.*'
          ),
      ],
    });
    return;
  }

  if (cmd === 'salesfilter') {
    const args = parts.slice(1);
    if (args.length < 2 || args.length % 2 !== 0) {
      await msg.reply(
        '⚠️ Usage: `!salesfilter <TraitName> <Value>`\nExample: `!salesfilter Background Blue`\nMulti: `!salesfilter Background Blue Eyes Laser`'
      );
      return;
    }

    traitFilters.clear();
    const pairs = [];
    for (let i = 0; i < args.length; i += 2) {
      traitFilters.set(args[i].toLowerCase(), args[i + 1].toLowerCase());
      pairs.push(`**${args[i]}** = ${args[i + 1]}`);
    }

    await msg.reply(
      `✅ Filter set! Only posting sales matching:\n${pairs.join('\n')}\n\nUse \`!clearsalesfilters\` to remove.`
    );
    return;
  }

  if (cmd === 'salesfilters') {
    if (traitFilters.size === 0) {
      await msg.reply('No filters active — showing all sales.');
    } else {
      const lines = [...traitFilters.entries()]
        .map(([k, v]) => `• **${k}** = ${v}`)
        .join('\n');
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
    const filterStr =
      traitFilters.size > 0
        ? [...traitFilters.entries()].map(([k, v]) => `${k}=${v}`).join(', ')
        : 'none (all sales)';

    await msg.reply(
      `📊 **OCAS Sales Bot Status**\n` +
        `• Paused: ${paused ? 'Yes ⏸' : 'No ▶️'}\n` +
        `• Poll in progress: ${pollInProgress ? 'Yes' : 'No'}\n` +
        `• Poll: every ${POLL_MS / 1000}s\n` +
        `• Filters: ${filterStr}\n` +
        `• OpenSea key: ${OPENSEA_KEY ? 'Set ✅' : 'Not set ⚠️'}\n` +
        `• Last seen sale ID: ${lastSeenSaleId || 'none'}\n` +
        `• Image cache: ${imageCache.size} tokens`
    );
    return;
  }

  if (cmd === 'lastsale') {
    await msg.reply('🔍 Fetching most recent sale...');
    try {
      const sales = await fetchLatestSales(1);
      if (!sales.length) {
        await msg.reply('No sales found.');
        return;
      }
      const payload = await buildMessagePayload(sales[0], { testMode: true });
      await msg.reply(payload);
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  if (cmd === 'recentsales') {
    const count = Math.min(parseInt(parts[1], 10) || 5, 10);
    await msg.reply(`🔍 Fetching last ${count} sales...`);
    try {
      const sales = await fetchLatestSales(count);
      if (!sales.length) {
        await msg.reply('No sales found.');
        return;
      }
      for (const sale of sales.reverse()) {
        const payload = await buildMessagePayload(sale, { testMode: true });
        await msg.channel.send(payload);
        await sleep(800);
      }
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  if (cmd === 'sale') {
    const tokenId = parts[1]?.replace('#', '');
    if (!tokenId || isNaN(tokenId)) {
      await msg.reply('Usage: `!sale 1234` or `!sale #1234`');
      return;
    }

    await msg.reply(`🔍 Fetching sale for #${tokenId}...`);

    try {
      const url = `https://api.opensea.io/api/v2/events/chain/ethereum/contract/${CONTRACT}/nfts/${tokenId}?event_type=sale&limit=1`;
      const r = await fetch(url, { headers: osHeaders() });
      if (!r.ok) {
        await msg.reply(`❌ OpenSea error: ${r.status}`);
        return;
      }
      const j = await r.json();
      const sales = j.asset_events || [];
      if (!sales.length) {
        await msg.reply(`No sales found for #${tokenId}.`);
        return;
      }

      const payload = await buildMessagePayload(sales[0], { testMode: true });
      await msg.reply(payload);
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }

    return;
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ OCAS Sales Bot online as ${client.user.tag}`);
  console.log(`   Channel: ${CHANNEL_ID}`);
  console.log(`   Poll every: ${POLL_MS / 1000}s`);
  console.log(`   OpenSea key: ${OPENSEA_KEY ? 'set' : 'NOT SET — may be rate limited'}`);

  loadState();

  await pollSales();
  setInterval(() => {
    pollSales().catch((e) => {
      console.error('[Sales] Interval poll failed:', e.message);
    });
  }, POLL_MS);
});

client.on('error', (e) => console.error('[Discord] Error:', e.message));
process.on('unhandledRejection', (e) =>
  console.error('[Bot] Unhandled rejection:', e)
);
process.on('uncaughtException', (e) =>
  console.error('[Bot] Uncaught exception:', e)
);

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN');
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error('Missing SALES_CHANNEL_ID');
  process.exit(1);
}

client.login(DISCORD_TOKEN);