/**
 * OCAS Discord Sales Bot
 * ─────────────────────────────────────────────────────────────
 * Watches On-Chain All Stars sales via OpenSea API v2 and posts
 * rich embeds with token image to a Discord channel.
 *
 * TRAIT FILTER commands (usable by anyone in Discord):
 *   !salesfilter Background Blue        → only ping sales with Background = Blue
 *   !salesfilter Eyes Laser             → filter by Eyes = Laser
 *   !salesfilter Background Blue Eyes Laser → multi-trait filter (AND logic)
 *   !salesfilters                       → show all active filters
 *   !clearsalesfilters                  → remove all filters
 *   !saleson / !salesoff                → pause / resume sale pings
 *   !saleshelp                          → show all commands
 *
 * SETUP:
 *   1. npm install
 *   2. cp .env.example .env  →  fill in values
 *   3. node bot.js
 *
 * HOST FREE: Railway.app or Render.com (connect GitHub repo)
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fetch = require('node-fetch');

// ── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const CHANNEL_ID     = process.env.SALES_CHANNEL_ID;
const OPENSEA_KEY    = process.env.OPENSEA_KEY || '';
const OS_SLUG        = 'on-chain-all-stars';
const CONTRACT       = '0x078be86f3104a32313a47815792230a3808642cc';
const POLL_MS        = parseInt(process.env.POLL_MS || '30000', 10); // default 30s
const CMD_PREFIX     = '!';

// ── State ────────────────────────────────────────────────────────────────────
let lastSeenSaleId  = null;   // tracks newest sale we've already posted
let paused          = false;  // !salesoff / !saleson
// traitFilters: Map<traitName (lowercase), value (lowercase)>
// e.g. Map { "background" => "blue", "eyes" => "laser" }
let traitFilters    = new Map();

// ── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

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

/**
 * Check if a sale matches ALL active trait filters.
 * sale.nft.traits = [{ trait_type, value }, ...]
 */
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

// ── Build embed ──────────────────────────────────────────────────────────────
function buildEmbed(sale) {
  const id       = sale.nft?.identifier;
  const name     = sale.nft?.name || `#${id}`;
  const imageUrl = sale.nft?.image_url || sale.nft?.display_image_url || null;
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

  if (imageUrl) embed.setImage(imageUrl);

  embed.addFields(
    { name: 'Price',  value: ethPrice ? `◆ ${ethPrice} ETH` : '—', inline: true },
    { name: 'Buyer',  value: buyer,  inline: true },
    { name: 'Seller', value: seller, inline: true },
  );

  // Add trait fields if sale carries them
  const nftTraits = sale.nft?.traits || [];
  if (nftTraits.length > 0) {
    const traitLines = nftTraits
      .slice(0, 10)
      .map(t => `**${t.trait_type}**: ${t.value}`)
      .join('\n');
    embed.addFields({ name: 'Traits', value: traitLines, inline: false });
  }

  // Active filter indicator
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

// ── Poll OpenSea ─────────────────────────────────────────────────────────────
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

  // First run — just record the latest ID so we don't spam old sales
  if (lastSeenSaleId === null) {
    lastSeenSaleId = sales[0].id || sales[0].event_timestamp;
    console.log(`[Sales] Bot ready. Watching from sale ID: ${lastSeenSaleId}`);
    return;
  }

  // Find new sales (newer than lastSeenSaleId)
  const newSales = [];
  for (const sale of sales) {
    const sid = sale.id || sale.event_timestamp;
    if (sid === lastSeenSaleId) break;
    newSales.push(sale);
  }

  if (!newSales.length) return;

  // Update cursor
  lastSeenSaleId = sales[0].id || sales[0].event_timestamp;

  const channel = client.channels.cache.get(CHANNEL_ID);
  if (!channel) {
    console.warn('[Sales] Channel not found:', CHANNEL_ID);
    return;
  }

  // Post newest → oldest (reverse so Discord shows chronological order)
  for (const sale of newSales.reverse()) {
    if (!matchesFilters(sale)) {
      console.log(`[Sales] Skipping #${sale.nft?.identifier} — doesn't match trait filter`);
      continue;
    }
    try {
      const embed = buildEmbed(sale);
      await channel.send({ embeds: [embed] });
      console.log(`[Sales] Posted sale #${sale.nft?.identifier}`);
    } catch (e) {
      console.error('[Sales] Error posting embed:', e.message);
    }
  }
}

// ── Command handler ───────────────────────────────────────────────────────────
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(CMD_PREFIX)) return;

  const raw   = msg.content.slice(CMD_PREFIX.length).trim();
  const parts = raw.split(/\s+/);
  const cmd   = parts[0]?.toLowerCase();

  // ── !saleshelp ────────────────────────────────────────────────────────────
  if (cmd === 'saleshelp') {
    await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🤖 OCAS Sales Bot — Commands')
          .setColor(0x7aa2ff)
          .setDescription(
            '**!salesfilter <Trait> <Value>**\n' +
            'Filter to sales where that trait = that value.\n' +
            'You can stack multiple traits: `!salesfilter Background Blue Eyes Laser`\n\n' +
            '**!salesfilters**\n' +
            'Show currently active trait filters.\n\n' +
            '**!clearsalesfilters**\n' +
            'Remove all active filters — show all sales.\n\n' +
            '**!saleson**\n' +
            'Resume sale notifications if paused.\n\n' +
            '**!salesoff**\n' +
            'Pause all sale notifications.\n\n' +
            '**!salesstatus**\n' +
            'Show bot status (paused, filters, poll rate).'
          )
      ],
    });
    return;
  }

  // ── !salesfilter Background Blue [Eyes Laser ...] ─────────────────────────
  if (cmd === 'salesfilter') {
    // args after cmd, comes in pairs: Trait Value Trait Value ...
    const args = parts.slice(1);
    if (args.length < 2 || args.length % 2 !== 0) {
      await msg.reply(
        '⚠️ Usage: `!salesfilter <TraitName> <Value> [<TraitName2> <Value2> ...]`\n' +
        'Example: `!salesfilter Background Blue`\n' +
        'Multi-trait: `!salesfilter Background Blue Eyes Laser`'
      );
      return;
    }
    traitFilters.clear();
    const pairs = [];
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i].toLowerCase();
      const val  = args[i + 1].toLowerCase();
      traitFilters.set(name, val);
      pairs.push(`**${args[i]}** = ${args[i + 1]}`);
    }
    await msg.reply(`✅ Trait filter set! Only sales matching:\n${pairs.join('\n')}\n\nUse \`!clearsalesfilters\` to remove.`);
    return;
  }

  // ── !salesfilters ─────────────────────────────────────────────────────────
  if (cmd === 'salesfilters') {
    if (traitFilters.size === 0) {
      await msg.reply('No trait filters active — showing all sales. Use `!salesfilter <Trait> <Value>` to add one.');
    } else {
      const lines = [...traitFilters.entries()].map(([k, v]) => `• **${k}** = ${v}`).join('\n');
      await msg.reply(`Current filters:\n${lines}`);
    }
    return;
  }

  // ── !clearsalesfilters ────────────────────────────────────────────────────
  if (cmd === 'clearsalesfilters') {
    traitFilters.clear();
    await msg.reply('✅ All sale trait filters cleared. Watching all sales.');
    return;
  }

  // ── !salesoff ─────────────────────────────────────────────────────────────
  if (cmd === 'salesoff') {
    paused = true;
    await msg.reply('⏸ Sale notifications paused. Use `!saleson` to resume.');
    return;
  }

  // ── !saleson ──────────────────────────────────────────────────────────────
  if (cmd === 'saleson') {
    paused = false;
    await msg.reply('▶️ Sale notifications resumed!');
    return;
  }

  // ── !salesstatus ──────────────────────────────────────────────────────────
  if (cmd === 'salesstatus') {
    const filterStr = traitFilters.size > 0
      ? [...traitFilters.entries()].map(([k, v]) => `${k}=${v}`).join(', ')
      : 'none (all sales)';
    await msg.reply(
      `📊 **OCAS Sales Bot Status**\n` +
      `• Paused: ${paused ? 'Yes ⏸' : 'No ▶️'}\n` +
      `• Poll interval: ${POLL_MS / 1000}s\n` +
      `• Active filters: ${filterStr}\n` +
      `• Collection: ${OS_SLUG}\n` +
      `• OpenSea key: ${OPENSEA_KEY ? 'Set ✅' : 'Not set ⚠️'}`
    );
    return;
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ OCAS Sales Bot online as ${client.user.tag}`);
  console.log(`   Channel: ${CHANNEL_ID}`);
  console.log(`   Poll every: ${POLL_MS / 1000}s`);
  console.log(`   OpenSea key: ${OPENSEA_KEY ? 'set' : 'NOT SET — may be rate limited'}`);

  // Initial poll to set cursor
  pollSales();
  // Then poll on interval
  setInterval(pollSales, POLL_MS);
});

client.on('error', (e) => console.error('[Discord] Error:', e.message));
process.on('unhandledRejection', (e) => console.error('[Bot] Unhandled rejection:', e));

client.login(DISCORD_TOKEN);
