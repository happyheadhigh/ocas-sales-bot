/**
 * OCAS Discord Sales Bot — Public Multi-Server Edition
 * ─────────────────────────────────────────────────────────────
 * Anyone can add this bot to their server and configure it
 * entirely through slash commands — no code changes needed.
 *
 * SLASH COMMANDS (server admins):
 *   /setup channel:#sales-channel collection:on-chain-all-stars
 *   /setchannel channel:#new-channel
 *   /setcollection slug:on-chain-all-stars contract:0x...
 *   /salesfilter trait:Background value:Blue
 *   /clearfilters
 *   /pause
 *   /resume
 *   /status
 *
 * SLASH COMMANDS (anyone):
 *   /lastsale
 *   /recentsales count:5
 *   /sale token:7370
 *   /help
 *
 * SETUP FOR BOT OWNER:
 *   1. npm install
 *   2. Set env vars: DISCORD_TOKEN, OPENSEA_KEY (optional but recommended)
 *   3. node register-commands.js   ← register slash commands once
 *   4. node bot.js
 *
 * HOST: Railway.app — connect GitHub repo, add env vars, deploy
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes,
  EmbedBuilder, AttachmentBuilder, PermissionFlagsBits,
  SlashCommandBuilder
} = require('discord.js');
const fetch  = require('node-fetch');
const sharp  = require('sharp');
const fs     = require('fs');
const path   = require('path');

// ── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const OPENSEA_KEY    = process.env.OPENSEA_KEY || '';
const POLL_MS        = parseInt(process.env.POLL_MS || '30000', 10);
const CONFIG_FILE    = path.join(__dirname, 'server-configs.json');

// ── Per-server config persistence ────────────────────────────────────────────
// Stored as: { guildId: { channelId, slug, contract, traitFilters, paused } }
function loadConfigs(){
  try{ return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch{ return {}; }
}
function saveConfigs(configs){
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
}

let serverConfigs = loadConfigs();

function getConfig(guildId){
  return serverConfigs[guildId] || null;
}
function setConfig(guildId, updates){
  serverConfigs[guildId] = { ...(serverConfigs[guildId] || {}), ...updates };
  saveConfigs(serverConfigs);
}

// ── Per-server sale cursor (not persisted — resets on restart) ────────────────
const lastSeenIds = new Map(); // guildId → last seen sale id string

// ── Image cache ───────────────────────────────────────────────────────────────
const imageCache = new Map(); // "slug:tokenId" → resolved result

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function osHeaders(){
  const h = { accept: 'application/json' };
  if(OPENSEA_KEY) h['x-api-key'] = OPENSEA_KEY;
  return h;
}

function formatEth(event){
  try{
    const qty = BigInt(event.payment?.quantity || '0');
    const dec = event.payment?.decimals ?? 18;
    const eth = Number(qty) / Math.pow(10, dec);
    if(!isFinite(eth) || eth <= 0) return null;
    return eth >= 1 ? eth.toFixed(4) : eth.toFixed(5);
  }catch{ return null; }
}

function shortAddr(addr){
  if(!addr || addr.length < 10) return addr || 'unknown';
  return addr.slice(0,6) + '…' + addr.slice(-4);
}

function timeSince(unixTs){
  const s = Math.floor(Date.now()/1000 - unixTs);
  if(s < 60)   return `${s}s ago`;
  if(s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function isSvg(url){
  if(!url) return false;
  const s = String(url).trim();
  return s.startsWith('<svg') || s.startsWith('data:image/svg') ||
         s.toLowerCase().endsWith('.svg') || s.includes('image/svg');
}

function isDiscordCompatible(url){
  if(!url || isSvg(url)) return false;
  const s = url.toLowerCase();
  return (s.startsWith('http://') || s.startsWith('https://')) &&
         !s.startsWith('data:') && !s.startsWith('<svg');
}

// ── SVG → PNG (extracts embedded PNG from foreignObject, composites background) ─
async function extractPngFromSvg(svgSource){
  let svgText;
  if(svgSource.startsWith('data:image/svg')){
    const b64 = svgSource.split(',')[1];
    if(!b64) throw new Error('Empty SVG data URI');
    svgText = Buffer.from(b64, 'base64').toString('utf-8');
  } else {
    const r = await fetch(svgSource);
    if(!r.ok) throw new Error(`SVG fetch: ${r.status}`);
    svgText = await r.text();
  }

  const SIZE = 500;

  // Extract embedded PNG character
  const pngMatch = svgText.match(/src=["']data:image\/png;base64,([A-Za-z0-9+/=\s]+)["']/);
  let charBuffer = null;
  if(pngMatch){
    const pngB64 = pngMatch[1].replace(/\s/g, '');
    const rawPng = Buffer.from(pngB64, 'base64');
    charBuffer = await sharp(rawPng)
      .resize(SIZE, SIZE, { kernel: 'nearest' })
      .png().toBuffer();
  }

  // Extract gradient stops for background
  const stopMatches = [...svgText.matchAll(/stop-color=["'](#[0-9a-fA-F]{6,8})["']/g)];
  const stops = stopMatches.map(m => m[1].slice(0,7));
  const uniqueStops = stops.filter((c,i) => c !== stops[i-1]);

  const gradDirMatch = svgText.match(/linearGradient[^>]+x1=["']([\d.]+)["'][^>]+y1=["']([\d.]+)["'][^>]+x2=["']([\d.]+)["'][^>]+y2=["']([\d.]+)["']/);
  const [gx1,gy1,gx2,gy2] = gradDirMatch
    ? [gradDirMatch[1], gradDirMatch[2], gradDirMatch[3], gradDirMatch[4]]
    : ['0','0','0','1'];

  let gradStops;
  if(uniqueStops.length <= 1){
    const c = uniqueStops[0] || '#1a1a2e';
    gradStops = `<stop offset="0%" stop-color="${c}"/><stop offset="100%" stop-color="${c}"/>`;
  } else {
    gradStops = uniqueStops.map((c,i) => {
      const pct = Math.round((i/(uniqueStops.length-1))*100);
      return `<stop offset="${pct}%" stop-color="${c}"/>`;
    }).join('');
  }

  const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <defs><linearGradient id="bg" x1="${gx1}" y1="${gy1}" x2="${gx2}" y2="${gy2}">${gradStops}</linearGradient></defs>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
  </svg>`;

  const bgBuffer = await sharp(Buffer.from(bgSvg)).resize(SIZE, SIZE).png().toBuffer();

  if(charBuffer){
    return sharp(bgBuffer).composite([{input: charBuffer, blend:'over'}]).png().toBuffer();
  }
  return bgBuffer;
}

// ── Image resolver ────────────────────────────────────────────────────────────
async function resolveImage(sale, contract){
  const id  = sale.nft?.identifier;
  const key = `${contract}:${id}`;

  if(id && imageCache.has(key)) return imageCache.get(key);

  const candidates = [
    sale.nft?.display_image_url,
    sale.nft?.image_url,
    sale.nft?.image_preview_url,
  ];

  for(const url of candidates){
    if(isDiscordCompatible(url)){
      const result = { type:'url', url };
      if(id) imageCache.set(key, result);
      return result;
    }
  }

  if(id){
    try{
      const nftUrl = `https://api.opensea.io/api/v2/chain/ethereum/contract/${contract}/nfts/${id}`;
      const r = await fetch(nftUrl, { headers: osHeaders() });
      if(r.ok){
        const j   = await r.json();
        const nft = j.nft || j;
        const deep = [nft.display_image_url, nft.image_url, nft.image_preview_url, nft.image_thumbnail_url];
        for(const url of deep){
          if(isDiscordCompatible(url)){
            const result = { type:'url', url };
            imageCache.set(key, result);
            return result;
          }
        }
        const svgSrc = deep.find(u => u && !u.startsWith('<svg') && !u.startsWith('data:') && isSvg(u))
                    || candidates.find(u => u && isSvg(u));
        if(svgSrc){
          const buf    = await extractPngFromSvg(svgSrc);
          const result = { type:'buffer', buffer:buf, filename:`token-${id}.png` };
          imageCache.set(key, result);
          return result;
        }
      }
    }catch(e){ console.warn(`[Image] #${id} error:`, e.message); }
  }
  return null;
}

// ── Trait filter check ────────────────────────────────────────────────────────
function matchesFilters(sale, traitFilters){
  if(!traitFilters || Object.keys(traitFilters).length === 0) return true;
  const nftTraits = sale.nft?.traits || [];
  const lookup = {};
  for(const t of nftTraits) lookup[t.trait_type?.toLowerCase()] = String(t.value).toLowerCase();
  for(const [name, val] of Object.entries(traitFilters)){
    if(lookup[name] !== val) return false;
  }
  return true;
}

// ── Build embed ───────────────────────────────────────────────────────────────
async function buildEmbed(sale, config, isTest=false){
  const id        = sale.nft?.identifier;
  const name      = sale.nft?.name || `#${id}`;
  const ethPrice  = formatEth(sale);
  const contract  = config.contract || '';
  const slug      = config.slug     || '';
  const osUrl     = `https://opensea.io/assets/ethereum/${contract}/${id}`;
  const tvUrl     = `https://traitview.com/?jump=${id}`;
  const timeStr   = sale.event_timestamp ? timeSince(sale.event_timestamp) : '';

  const buyerAddr  = sale.buyer  || 'unknown';
  const sellerAddr = sale.seller || 'unknown';
  const buyerLink  = buyerAddr  !== 'unknown' ? `[${shortAddr(buyerAddr)}](https://opensea.io/${buyerAddr})`   : 'unknown';
  const sellerLink = sellerAddr !== 'unknown' ? `[${shortAddr(sellerAddr)}](https://opensea.io/${sellerAddr})` : 'unknown';

  const title = isTest
    ? `🧪 ${name} — ◆ ${ethPrice ? ethPrice+' ETH' : '—'}`
    : `🟢 ${name} — ◆ ${ethPrice ? ethPrice+' ETH' : '—'}`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x2dd4bf)
    .setURL(osUrl)
    .setFooter({ text: `Sales Bot • ${slug}${timeStr ? ' • '+timeStr : ''}` })
    .setTimestamp();

  const imageResult = await resolveImage(sale, contract);
  embed._imageResult = imageResult;

  embed.addFields(
    { name:'◆ Price',  value: ethPrice ? `${ethPrice} ETH` : '—', inline:true },
    { name:'🛒 Buyer',  value: buyerLink,  inline:true },
    { name:'💰 Seller', value: sellerLink, inline:true },
  );

  const nftTraits = sale.nft?.traits || [];
  if(nftTraits.length > 0){
    embed.addFields({
      name: 'Traits',
      value: nftTraits.slice(0,12).map(t=>`**${t.trait_type}**: ${t.value}`).join('\n'),
      inline: true,
    });
  }

  const links = [`[OpenSea](${osUrl})`];
  if(config.traitviewUrl !== false) links.push(`[TraitView](${tvUrl})`);
  embed.addFields({ name:'Links', value: links.join(' • '), inline:false });

  return embed;
}

// ── Send embed helper (handles buffer vs url) ─────────────────────────────────
async function sendEmbed(target, embed){
  const ir = embed._imageResult;
  delete embed._imageResult;
  if(ir?.type === 'buffer'){
    const att = new AttachmentBuilder(ir.buffer, { name: ir.filename });
    embed.setThumbnail(`attachment://${ir.filename}`);
    return target.send({ embeds:[embed], files:[att] });
  }
  if(ir?.type === 'url') embed.setThumbnail(ir.url);
  return target.send({ embeds:[embed] });
}

// ── Poll sales for all configured servers ─────────────────────────────────────
async function pollAllServers(){
  for(const [guildId, config] of Object.entries(serverConfigs)){
    if(!config.channelId || !config.slug || config.paused) continue;

    try{
      const url = `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(config.slug)}?event_type=sale&limit=20`;
      const r   = await fetch(url, { headers: osHeaders() });
      if(!r.ok){ console.warn(`[${config.slug}] OpenSea ${r.status}`); continue; }
      const j     = await r.json();
      const sales = j.asset_events || [];
      if(!sales.length) continue;

      const lastId = lastSeenIds.get(guildId);

      // First run for this server — just set cursor
      if(!lastId){
        lastSeenIds.set(guildId, String(sales[0].id || sales[0].event_timestamp));
        console.log(`[${guildId}] Watching "${config.slug}" from sale ${lastSeenIds.get(guildId)}`);
        continue;
      }

      // Find new sales
      const newSales = [];
      for(const sale of sales){
        const sid = String(sale.id || sale.event_timestamp);
        if(sid === lastId) break;
        newSales.push(sale);
      }
      if(!newSales.length) continue;

      lastSeenIds.set(guildId, String(sales[0].id || sales[0].event_timestamp));

      const channel = client.channels.cache.get(config.channelId);
      if(!channel){ console.warn(`[${guildId}] Channel ${config.channelId} not found`); continue; }

      for(const sale of newSales.reverse()){
        if(!matchesFilters(sale, config.traitFilters)) continue;
        try{
          const embed = await buildEmbed(sale, config);
          await sendEmbed(channel, embed);
          console.log(`[${guildId}] Posted #${sale.nft?.identifier}`);
        }catch(e){ console.error(`[${guildId}] Post error:`, e.message); }
      }

    }catch(e){ console.error(`[${guildId}] Poll error:`, e.message); }
  }
}

// ── Slash command handlers ────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if(!interaction.isChatInputCommand()) return;

  const { commandName, guildId } = interaction;
  const config = getConfig(guildId) || {};
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

  // ── /setup ─────────────────────────────────────────────────────────────────
  if(commandName === 'setup'){
    if(!isAdmin) return interaction.reply({ content:'❌ You need **Manage Server** permission.', ephemeral:true });
    const channel    = interaction.options.getChannel('channel');
    const slug       = interaction.options.getString('collection');
    const contract   = interaction.options.getString('contract') || '';
    const traitview  = interaction.options.getBoolean('traitview') ?? true;

    setConfig(guildId, {
      channelId:   channel.id,
      slug:        slug.toLowerCase().trim(),
      contract:    contract.toLowerCase().trim(),
      traitviewUrl: traitview,
      traitFilters: {},
      paused:      false,
    });

    await interaction.reply({
      embeds:[new EmbedBuilder()
        .setTitle('✅ Sales Bot Configured!')
        .setColor(0x2dd4bf)
        .addFields(
          { name:'Channel',    value:`<#${channel.id}>`,    inline:true },
          { name:'Collection', value:slug,                   inline:true },
          { name:'Contract',   value:contract || 'not set',  inline:true },
        )
        .setDescription('Sales will start posting automatically. Use `/status` to check.')
      ]
    });
    return;
  }

  // ── /setchannel ────────────────────────────────────────────────────────────
  if(commandName === 'setchannel'){
    if(!isAdmin) return interaction.reply({ content:'❌ Need **Manage Server** permission.', ephemeral:true });
    const channel = interaction.options.getChannel('channel');
    setConfig(guildId, { channelId: channel.id });
    await interaction.reply({ content:`✅ Sales channel set to <#${channel.id}>`, ephemeral:true });
    return;
  }

  // ── /setcollection ─────────────────────────────────────────────────────────
  if(commandName === 'setcollection'){
    if(!isAdmin) return interaction.reply({ content:'❌ Need **Manage Server** permission.', ephemeral:true });
    const slug     = interaction.options.getString('slug').toLowerCase().trim();
    const contract = (interaction.options.getString('contract') || '').toLowerCase().trim();
    setConfig(guildId, { slug, contract, traitFilters:{} });
    await interaction.reply({ content:`✅ Collection set to **${slug}**${contract ? ` (${contract})` : ''}`, ephemeral:true });
    return;
  }

  // ── /salesfilter ───────────────────────────────────────────────────────────
  if(commandName === 'salesfilter'){
    if(!isAdmin) return interaction.reply({ content:'❌ Need **Manage Server** permission.', ephemeral:true });
    const trait = interaction.options.getString('trait').toLowerCase().trim();
    const value = interaction.options.getString('value').toLowerCase().trim();
    const filters = { ...(config.traitFilters || {}), [trait]: value };
    setConfig(guildId, { traitFilters: filters });
    const lines = Object.entries(filters).map(([k,v])=>`**${k}** = ${v}`).join('\n');
    await interaction.reply({ content:`✅ Filters set:\n${lines}\nUse \`/clearfilters\` to remove all.`, ephemeral:true });
    return;
  }

  // ── /clearfilters ──────────────────────────────────────────────────────────
  if(commandName === 'clearfilters'){
    if(!isAdmin) return interaction.reply({ content:'❌ Need **Manage Server** permission.', ephemeral:true });
    setConfig(guildId, { traitFilters:{} });
    await interaction.reply({ content:'✅ All filters cleared — watching all sales.', ephemeral:true });
    return;
  }

  // ── /pause ─────────────────────────────────────────────────────────────────
  if(commandName === 'pause'){
    if(!isAdmin) return interaction.reply({ content:'❌ Need **Manage Server** permission.', ephemeral:true });
    setConfig(guildId, { paused:true });
    await interaction.reply({ content:'⏸ Sale notifications paused. Use `/resume` to restart.', ephemeral:true });
    return;
  }

  // ── /resume ────────────────────────────────────────────────────────────────
  if(commandName === 'resume'){
    if(!isAdmin) return interaction.reply({ content:'❌ Need **Manage Server** permission.', ephemeral:true });
    setConfig(guildId, { paused:false });
    await interaction.reply({ content:'▶️ Sale notifications resumed!', ephemeral:true });
    return;
  }

  // ── /status ────────────────────────────────────────────────────────────────
  if(commandName === 'status'){
    if(!config.slug){
      await interaction.reply({ content:'⚠️ Not configured yet. Use `/setup` to get started.', ephemeral:true });
      return;
    }
    const filters = config.traitFilters && Object.keys(config.traitFilters).length > 0
      ? Object.entries(config.traitFilters).map(([k,v])=>`${k}=${v}`).join(', ')
      : 'none (all sales)';
    await interaction.reply({
      embeds:[new EmbedBuilder()
        .setTitle('📊 Sales Bot Status')
        .setColor(0x7aa2ff)
        .addFields(
          { name:'Collection', value:config.slug || '—',                              inline:true },
          { name:'Channel',    value:config.channelId ? `<#${config.channelId}>` : '—', inline:true },
          { name:'Paused',     value:config.paused ? 'Yes ⏸' : 'No ▶️',              inline:true },
          { name:'Filters',    value:filters,                                          inline:false },
        )
      ],
      ephemeral:true
    });
    return;
  }

  // ── /lastsale ──────────────────────────────────────────────────────────────
  if(commandName === 'lastsale'){
    const slug = interaction.options.getString('collection') || config.slug;
    if(!slug) return interaction.reply({ content:'⚠️ Provide a collection or run `/setup` first.', ephemeral:true });
    await interaction.deferReply();
    try{
      const url = `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=1`;
      const r   = await fetch(url, { headers: osHeaders() });
      if(!r.ok){ await interaction.editReply(`❌ OpenSea error: ${r.status}`); return; }
      const j     = await r.json();
      const sales = j.asset_events || [];
      if(!sales.length){ await interaction.editReply('No sales found.'); return; }
      const cfg   = { ...config, slug };
      const embed = await buildEmbed(sales[0], cfg, true);
      const ir    = embed._imageResult; delete embed._imageResult;
      if(ir?.type === 'buffer'){
        const att = new AttachmentBuilder(ir.buffer, { name:ir.filename });
        embed.setThumbnail(`attachment://${ir.filename}`);
        await interaction.editReply({ embeds:[embed], files:[att] });
      } else {
        if(ir?.type === 'url') embed.setThumbnail(ir.url);
        await interaction.editReply({ embeds:[embed] });
      }
    }catch(e){ await interaction.editReply(`❌ Error: ${e.message}`); }
    return;
  }

  // ── /recentsales ───────────────────────────────────────────────────────────
  if(commandName === 'recentsales'){
    const slug  = interaction.options.getString('collection') || config.slug;
    const count = Math.min(interaction.options.getInteger('count') || 5, 10);
    if(!slug) return interaction.reply({ content:'⚠️ Provide a collection or run `/setup` first.', ephemeral:true });
    await interaction.deferReply();
    try{
      const url = `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=${count}`;
      const r   = await fetch(url, { headers: osHeaders() });
      if(!r.ok){ await interaction.editReply(`❌ OpenSea error: ${r.status}`); return; }
      const j     = await r.json();
      const sales = j.asset_events || [];
      if(!sales.length){ await interaction.editReply('No sales found.'); return; }
      await interaction.editReply(`📋 Last ${sales.length} sales for **${slug}**:`);
      const cfg = { ...config, slug };
      for(const sale of sales.reverse()){
        const embed = await buildEmbed(sale, cfg, true);
        await sendEmbed(interaction.channel, embed);
        await new Promise(res => setTimeout(res, 800));
      }
    }catch(e){ await interaction.editReply(`❌ Error: ${e.message}`); }
    return;
  }

  // ── /traitfind ─────────────────────────────────────────────────────────────
  // Search recent sales history for a specific trait without touching auto-post filters
  if(commandName === 'traitfind'){
    const slug  = interaction.options.getString('collection') || config.slug;
    const trait = interaction.options.getString('trait').toLowerCase().trim();
    const value = interaction.options.getString('value').toLowerCase().trim();
    const want  = Math.min(interaction.options.getInteger('count') || 5, 10);
    if(!slug) return interaction.reply({ content:'⚠️ Provide a collection or run `/setup` first.', ephemeral:true });

    await interaction.deferReply();
    try{
      const matched = [];
      let cursor    = null;
      let pages     = 0;
      const MAX_PAGES = 15; // search up to 1500 sales back

      await interaction.editReply(`🔍 Searching sales for **${trait}: ${value}**…`);

      while(matched.length < want && pages < MAX_PAGES){
        const qs  = new URLSearchParams({ event_type:'sale', limit:'100' });
        if(cursor) qs.set('next', cursor);
        const url = `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?${qs}`;
        const r   = await fetch(url, { headers: osHeaders() });
        if(!r.ok) throw new Error(`OpenSea ${r.status}`);
        const j   = await r.json();
        const sales = j.asset_events || [];
        if(!sales.length) break;

        for(const sale of sales){
          if(matched.length >= want) break;
          const traits = sale.nft?.traits || [];
          const lookup = {};
          for(const t of traits) lookup[t.trait_type?.toLowerCase()] = String(t.value).toLowerCase();
          if(lookup[trait] === value) matched.push(sale);
        }

        cursor = j.next || null;
        if(!cursor) break;
        pages++;
      }

      if(!matched.length){
        await interaction.editReply(`No sales found with **${trait}: ${value}** in the last ${pages * 100} sales.`);
        return;
      }

      await interaction.editReply(`✅ Found **${matched.length}** sale${matched.length===1?'':'s'} with **${trait}: ${value}**:`);
      const cfg = { ...config, slug };
      for(const sale of matched){
        const embed = await buildEmbed(sale, cfg, true);
        await sendEmbed(interaction.channel, embed);
        await new Promise(res => setTimeout(res, 800));
      }
    }catch(e){ await interaction.editReply(`❌ Error: ${e.message}`); }
    return;
  }

  // ── /sale ──────────────────────────────────────────────────────────────────
  if(commandName === 'sale'){
    const tokenId  = interaction.options.getString('token').replace('#','');
    const slug     = interaction.options.getString('collection') || config.slug;
    const contract = config.contract || '';
    if(!slug)     return interaction.reply({ content:'⚠️ Provide a collection or run `/setup` first.', ephemeral:true });
    if(!contract) return interaction.reply({ content:'⚠️ Set a contract address with `/setcollection`.', ephemeral:true });
    await interaction.deferReply();
    try{
      const url = `https://api.opensea.io/api/v2/events/chain/ethereum/contract/${contract}/nfts/${tokenId}?event_type=sale&limit=1`;
      const r   = await fetch(url, { headers: osHeaders() });
      if(!r.ok){ await interaction.editReply(`❌ OpenSea error: ${r.status}`); return; }
      const j     = await r.json();
      const sales = j.asset_events || [];
      if(!sales.length){ await interaction.editReply(`No sales found for #${tokenId}.`); return; }
      const embed = await buildEmbed(sales[0], config, true);
      const ir    = embed._imageResult; delete embed._imageResult;
      if(ir?.type === 'buffer'){
        const att = new AttachmentBuilder(ir.buffer, { name:ir.filename });
        embed.setThumbnail(`attachment://${ir.filename}`);
        await interaction.editReply({ embeds:[embed], files:[att] });
      } else {
        if(ir?.type === 'url') embed.setThumbnail(ir.url);
        await interaction.editReply({ embeds:[embed] });
      }
    }catch(e){ await interaction.editReply(`❌ Error: ${e.message}`); }
    return;
  }

  // ── /help ──────────────────────────────────────────────────────────────────
  if(commandName === 'help'){
    await interaction.reply({
      embeds:[new EmbedBuilder()
        .setTitle('🤖 NFT Sales Bot — Help')
        .setColor(0x7aa2ff)
        .setDescription(
          '**Admin commands** *(Manage Server permission required)*\n' +
          '`/setup` — Configure channel + collection\n' +
          '`/setchannel` — Change the sales channel\n' +
          '`/setcollection` — Change the collection\n' +
          '`/salesfilter` — Filter to specific trait sales\n' +
          '`/clearfilters` — Remove all filters\n' +
          '`/pause` / `/resume` — Pause/resume notifications\n' +
          '`/status` — Show current configuration\n\n' +
          '**Anyone can use**\n' +
          '`/lastsale [collection]` — Show most recent sale\n' +
          '`/recentsales [count] [collection]` — Show last N sales\n' +
          '`/sale token:1234` — Show a specific token\'s last sale\n' +
          '`/help` — This message'
        )
      ],
      ephemeral: true
    });
    return;
  }
});

// ── Welcome message when bot joins a new server ───────────────────────────────
client.on('guildCreate', async (guild) => {
  try{
    // Find the first channel the bot can send messages in
    const channel = guild.channels.cache
      .filter(c => c.type === 0 && c.permissionsFor(guild.members.me)?.has('SendMessages'))
      .sort((a, b) => a.position - b.position)
      .first();

    if(!channel) return;

    const { EmbedBuilder } = require('discord.js');

    const embed = new EmbedBuilder()
      .setTitle('👋 Thanks for adding the NFT Sales Bot!')
      .setColor(0x2dd4bf)
      .setDescription(
        'I automatically post NFT sale alerts to your server with **token images, price, traits, and buyer/seller links**.

' +
        'I work with **any OpenSea collection** — just run `/setup` to get started.'
      )
      .addFields(
        {
          name: '🚀 Quick Setup (30 seconds)',
          value:
            '**1.** Run `/setup` and fill in:
' +
            '> • **channel** — where to post sales (e.g. `#sales`)
' +
            '> • **collection** — OpenSea slug (e.g. `on-chain-all-stars`)
' +
            '> • **contract** — contract address (optional, needed for `/sale`)

' +
            '**2.** Done! Sales will post automatically.

' +
            '**3.** Test it with `/lastsale`',
          inline: false,
        },
        {
          name: '📋 Key Commands',
          value:
            '`/setup` — Configure channel + collection
' +
            '`/lastsale` — Show most recent sale now
' +
            '`/recentsales count:10` — Show last 10 sales
' +
            '`/traitfind trait:Type value:Zombie` — Find sales by trait
' +
            '`/salesfilter trait:Background value:Blue` — Auto-post only matching traits
' +
            '`/clearfilters` — Remove filters, watch all sales
' +
            '`/help` — See all commands',
          inline: false,
        },
        {
          name: '💡 Finding your collection slug & contract',
          value:
            '**Slug** — look at the OpenSea URL:
' +
            '`opensea.io/collection/`**`on-chain-all-stars`**

' +
            '**Contract** — OpenSea collection page → any token → Details → Contract Address',
          inline: false,
        },
      )
      .setFooter({ text: 'Use /help anytime to see all commands • Works with any OpenSea collection' });

    await channel.send({ embeds: [embed] });
    console.log(`[Welcome] Sent setup guide to ${guild.name}`);
  } catch(e) {
    console.warn(`[Welcome] Could not send welcome to ${guild.name}:`, e.message);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
client.once('ready', ()=>{
  console.log(`✅ Sales Bot online as ${client.user.tag}`);
  console.log(`   Watching ${Object.keys(serverConfigs).length} server(s)`);
  console.log(`   OpenSea key: ${OPENSEA_KEY ? 'set' : 'NOT SET'}`);
  pollAllServers();
  setInterval(pollAllServers, POLL_MS);
});

client.on('error', e => console.error('[Discord]', e.message));
process.on('unhandledRejection', e => console.error('[Bot]', e));
client.login(DISCORD_TOKEN);
