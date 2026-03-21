/**
 * OCAS Discord Sales Bot — Sharp Renderer Version
 * ---------------------------------------------------------
 * Uses browser-free SVG -> PNG rendering with sharp


require('dotenv').config();

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const sharp = require('sharp');
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
let traitFilters = new Map();
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

function dedupeArray(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// ── Data URI / metadata helpers ──────────────────────────────────────────────
function extractSvgFromDataUri(input) {
  if (!input || typeof input !== 'string') return null;

  const s = input.trim();

  if (s.startsWith('data:image/svg+xml;base64,')) {
    try {
      return Buffer.from(stripDataUriPrefix(s), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  if (s.startsWith('data:image/svg+xml;utf8,')) {
    try {
      return decodeURIComponent(stripDataUriPrefix(s));
    } catch {
      return stripDataUriPrefix(s);
    }
  }

  if (s.startsWith('<svg')) return s;

  return null;
}

function extractJsonFromDataUri(input) {
  if (!input || typeof input !== 'string') return null;

  const s = input.trim();

  if (s.startsWith('data:application/json;base64,')) {
    try {
      return JSON.parse(Buffer.from(stripDataUriPrefix(s), 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }

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

// ── Sharp SVG rendering ──────────────────────────────────────────────────────
async function renderSvgToPngBuffer(svgString, tokenId = 'unknown') {
  console.log(`[Render] Starting sharp SVG -> PNG render for #${tokenId}`);

  const svgBuffer = Buffer.from(svgString, 'utf8');

  const png = await sharp(svgBuffer, { density: 1200 })
    .resize(1000, 1000, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  console.log(`[Render] Sharp SVG -> PNG success for #${tokenId}`);
  return png;
}

async function svgUrlToPngBuffer(svgUrl, tokenId = 'unknown') {
  console.log('[Render] Fetching SVG URL:', svgUrl.slice(0, 180));
  const svgText = await fetchText(svgUrl);
  return renderSvgToPngBuffer(svgText, tokenId);
}

// ── OpenSea NFT lookup ───────────────────────────────────────────────────────
async function fetchNftFromOpenSea(tokenId) {
  const nftUrl = `https://api.opensea.io/api/v2/chain/ethereum/contract/${CONTRACT}/nfts/${tokenId}`;
  console.log(`[OpenSea] Fetching NFT metadata for #${tokenId}`);
  const r = await fetch(nftUrl, { headers: osHeaders() });
  if (!r.ok) {
    throw new Error(`OpenSea NFT endpoint returned ${r.status}`);
  }
  const j = await r.json();
  return j.nft || j;
}

function collectImageCandidates(sale, nft) {
  return dedupeArray([
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
  ]);
}

async function tryResolveFromMetadataSource(source, tokenId) {
  console.log(
    '[Image] Trying source:',
    typeof source === 'string' ? source.slice(0, 180) : source
  );

  const directSvg = extractSvgFromDataUri(source);
  if (directSvg) {
    console.log('[Image] Found direct SVG data URI / raw SVG');
    const png = await renderSvgToPngBuffer(directSvg, tokenId);
    console.log('[Image] Successfully rendered direct SVG to PNG');
    return { type: 'pngBuffer', value: png };
  }

  const jsonFromDataUri = extractJsonFromDataUri(source);
  if (jsonFromDataUri) {
    console.log('[Image] Found JSON data URI');
  }

  if (jsonFromDataUri?.image) {
    console.log(
      '[Image] JSON data URI contains image:',
      String(jsonFromDataUri.image).slice(0, 180)
    );

    const nestedSvg = extractSvgFromDataUri(jsonFromDataUri.image);
    if (nestedSvg) {
      console.log('[Image] Found nested SVG inside JSON data URI');
      const png = await renderSvgToPngBuffer(nestedSvg, tokenId);
      console.log('[Image] Successfully rendered nested SVG to PNG');
      return { type: 'pngBuffer', value: png };
    }

    if (isDiscordCompatibleRasterUrl(jsonFromDataUri.image)) {
      console.log('[Image] Using raster URL from JSON data URI');
      return { type: 'url', value: jsonFromDataUri.image };
    }

    if (isSvg(jsonFromDataUri.image) && isHttpUrl(jsonFromDataUri.image)) {
      console.log('[Image] Found SVG URL inside JSON data URI');
      const png = await svgUrlToPngBuffer(jsonFromDataUri.image, tokenId);
      console.log('[Image] Successfully rendered SVG URL to PNG');
      return { type: 'pngBuffer', value: png };
    }
  }

  if (isDiscordCompatibleRasterUrl(source)) {
    console.log('[Image] Using direct raster URL');
    return { type: 'url', value: source };
  }

  if (isSvg(source) && isHttpUrl(source)) {
    console.log('[Image] Found direct SVG URL');
    const png = await svgUrlToPngBuffer(source, tokenId);
    console.log('[Image] Successfully rendered direct SVG URL to PNG');
    return { type: 'pngBuffer', value: png };
  }

  if (isHttpUrl(source) && !isSvg(source)) {
    console.log('[Image] Fetching HTTP source text for deeper inspection');

    try {
      const text = await fetchText(source);
      console.log('[Image] HTTP source fetched, first 180 chars:', text.slice(0, 180));

      try {
        const json = JSON.parse(text);
        console.log('[Image] HTTP source parsed as JSON');

        if (json?.image) {
          console.log('[Image] JSON has image field:', String(json.image).slice(0, 180));

          const nestedSvg = extractSvgFromDataUri(json.image);
          if (nestedSvg) {
            console.log('[Image] Found nested SVG inside fetched JSON');
            const png = await renderSvgToPngBuffer(nestedSvg, tokenId);
            console.log('[Image] Successfully rendered fetched JSON SVG to PNG');
            return { type: 'pngBuffer', value: png };
          }

          if (isDiscordCompatibleRasterUrl(json.image)) {
            console.log('[Image] Using raster URL from fetched JSON');
            return { type: 'url', value: json.image };
          }

          if (isSvg(json.image) && isHttpUrl(json.image)) {
            console.log('[Image] Found SVG URL inside fetched JSON');
            const png = await svgUrlToPngBuffer(json.image, tokenId);
            console.log('[Image] Successfully rendered fetched JSON SVG URL to PNG');
            return { type: 'pngBuffer', value: png };
          }
        }
      } catch {
        console.log('[Image] HTTP source is not JSON');
      }

      if (text.trim().startsWith('<svg')) {
        console.log('[Image] HTTP source returned raw SVG');
        const png = await renderSvgToPngBuffer(text, tokenId);
        console.log('[Image] Successfully rendered raw fetched SVG to PNG');
        return { type: 'pngBuffer', value: png };
      }
    } catch (e) {
      console.log('[Image] Failed while inspecting HTTP source:', e.message);
    }
  }

  console.log('[Image] Source not usable');
  return null;
}

async function resolveImageAsset(sale) {
  const tokenId = safeTokenId(sale);

  if (imageCache.has(tokenId)) {
    console.log(`[Image] #${tokenId} loaded from cache`);
    return imageCache.get(tokenId);
  }

  let nft = null;
  try {
    nft = await fetchNftFromOpenSea(tokenId);
  } catch (e) {
    console.warn(`[Image] #${tokenId} — OpenSea NFT lookup failed: ${e.message}`);
  }

  const candidates = collectImageCandidates(sale, nft);

  console.log(`[Image] #${tokenId} candidate count:`, candidates.length);
  console.log(
    '[Image] Candidates:',
    candidates.map((c) => String(c).slice(0, 180))
  );

  for (const candidate of candidates) {
    try {
      const resolved = await tryResolveFromMetadataSource(candidate, tokenId);
      if (resolved) {
        imageCache.set(tokenId, resolved);
        console.log(`[Image] #${tokenId} — resolved as ${resolved.type}`);
        return resolved;
      }
    } catch (e) {
      console.warn(`[Image] #${tokenId} — candidate resolution failed: ${e.message}`);
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
    .setTitle(`${testMode ? '🧪 TEST — ' : '🟢 Sale — '}On-Chain All Stars ${name}`)
    .setColor(0x2dd4bf)
    .setURL(osUrl)
    .setFooter({
      text: `OCAS Sales Bot • traitview.com${timeStr ? ' • ' + timeStr : ''}`,
    })
    .setTimestamp();

  const files = [];
  const imageAsset = await resolveImageAsset(sale);

  console.log(`[Image] buildMessagePayload #${tokenId}:`, imageAsset ? imageAsset.type : 'null');

  if (imageAsset) {
    if (imageAsset.type === 'url') {
      embed.setImage(imageAsset.value);
      console.log(`[Image] #${tokenId} using embed image URL`);
    } else if (imageAsset.type === 'pngBuffer') {
      const filename = `token-${tokenId}.png`;
      files.push(new AttachmentBuilder(imageAsset.value, { name: filename }));
      embed.setImage(`attachment://${filename}`);
      console.log(`[Image] #${tokenId} using attachment image ${filename}`);
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
        console.error(`[Sales] Error posting #${safeTokenId(sale)}:`, e.message);
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

// ── Process safety ───────────────────────────────────────────────────────────
client.on('error', (e) => console.error('[Discord] Error:', e.message));
process.on('unhandledRejection', (e) =>
  console.error('[Bot] Unhandled rejection:', e)
);
process.on('uncaughtException', (e) =>
  console.error('[Bot] Uncaught exception:', e)
);

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

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN');
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error('Missing SALES_CHANNEL_ID');
  process.exit(1);
}

client.login(DISCORD_TOKEN);