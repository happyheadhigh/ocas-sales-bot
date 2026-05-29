require('dotenv').config();

const fetch = require('node-fetch');
const sharp = require('sharp');
const { Pool } = require('pg');
const {
  Client,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const DEFAULT_CHAIN = 'ethereum';
const DEFAULT_SLUG = 'on-chain-all-stars';
const OPENSEA_KEY = process.env.OPENSEA_KEY || '';
const MARKET_POLL_MS = Math.max(30000, parseInt(process.env.MARKET_POLL_MS || '60000', 10));

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pgPool.on('error', e => console.error('[Market/Download PG]', e.message));

function osHeaders(){
  const h = { accept: 'application/json' };
  if(OPENSEA_KEY) h['x-api-key'] = OPENSEA_KEY;
  return h;
}

async function dbLoad(key){
  try{
    const r = await pgPool.query('SELECT value FROM bot_state WHERE key=$1', [key]);
    if(!r.rows.length) return null;
    return JSON.parse(r.rows[0].value);
  }catch(e){ console.warn('[Market DB load]', key, e.message); return null; }
}

async function dbSave(key, value){
  await pgPool.query(
    `INSERT INTO bot_state(key,value,updated_at) VALUES($1,$2,NOW())
     ON CONFLICT(key) DO UPDATE SET value=$2, updated_at=NOW()`,
    [key, JSON.stringify(value)]
  );
}

function shortAddr(addr){
  const s = String(addr || '');
  return s.length > 10 ? `${s.slice(0,6)}...${s.slice(-4)}` : (s || 'unknown');
}

function isAdmin(interaction){
  try{ return interaction.memberPermissions?.has?.('ManageGuild'); }catch{ return false; }
}

function normalizeAlias(alias){
  return String(alias || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function normalizeContract(contract){
  const c = String(contract || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(c) ? c : '';
}

async function loadMarketConfig(){
  return await dbLoad('market_collections_v1') || {};
}

async function saveMarketConfig(cfg){
  await dbSave('market_collections_v1', cfg || {});
}

function getGuildMarket(cfg, guildId){
  if(!cfg[guildId]) cfg[guildId] = { collections:{}, channelDefaults:{} };
  if(!cfg[guildId].collections) cfg[guildId].collections = {};
  if(!cfg[guildId].channelDefaults) cfg[guildId].channelDefaults = {};
  return cfg[guildId];
}

function resolveCollectionFromGuild(guildCfg, alias, channelId){
  const collections = guildCfg?.collections || {};
  const cleanAlias = normalizeAlias(alias);
  if(cleanAlias && collections[cleanAlias]) return { alias: cleanAlias, cfg: collections[cleanAlias] };
  const byChannel = channelId ? guildCfg?.channelDefaults?.[channelId] : null;
  if(byChannel && collections[byChannel]) return { alias: byChannel, cfg: collections[byChannel] };
  if(collections.ocas) return { alias:'ocas', cfg: collections.ocas };
  const first = Object.keys(collections)[0];
  return first ? { alias:first, cfg:collections[first] } : null;
}

function tokenIdFromSale(sale){
  return sale?.nft?.identifier || sale?.nft?.token_id || sale?.asset?.token_id || sale?.asset?.identifier || '?';
}

function priceFromSale(sale){
  const p = sale?.payment || {};
  const qty = p.quantity || sale?.price?.quantity || sale?.total_price || sale?.base_price || '0';
  const decimals = Number(p.decimals ?? sale?.price?.decimals ?? 18);
  const symbol = p.symbol || sale?.price?.currency || 'ETH';
  let n = 0;
  try{ n = Number(BigInt(String(qty))) / Math.pow(10, decimals); }catch{ n = Number(qty) || 0; }
  return { eth:n, symbol };
}

function saleEventKey(sale){
  return String(sale?.event_id || sale?.id || sale?.transaction || sale?.transaction_hash || sale?.event_timestamp || JSON.stringify(sale).slice(0,120));
}

function buildMarketSaleEmbed(sale, cfg, alias){
  const tokenId = tokenIdFromSale(sale);
  const { eth, symbol } = priceFromSale(sale);
  const chain = cfg.chain || DEFAULT_CHAIN;
  const contract = cfg.contract || '';
  const slug = cfg.slug || DEFAULT_SLUG;
  const name = cfg.name || alias || slug;
  const osUrl = contract && tokenId !== '?' ? `https://opensea.io/assets/${chain}/${contract}/${tokenId}` : `https://opensea.io/collection/${slug}`;
  const embed = new EmbedBuilder()
    .setTitle(`${name} sale: #${tokenId}`)
    .setURL(osUrl)
    .setColor(0x0786FF)
    .addFields(
      { name:'Price', value:`Ξ ${Number(eth || 0).toFixed(4)} ${symbol || ''}`.trim(), inline:true },
      { name:'Seller', value:shortAddr(sale?.seller), inline:true },
      { name:'Buyer', value:shortAddr(sale?.buyer), inline:true },
      { name:'Collection', value:`${alias || slug}`, inline:true },
    )
    .setFooter({ text:'Market sales feed' })
    .setTimestamp();
  const img = sale?.nft?.image_url || sale?.nft?.display_image_url || sale?.asset?.image_url || sale?.image_url;
  if(img && String(img).startsWith('http')) embed.setThumbnail(img);
  return embed;
}

async function fetchLatestSales(slug, limit=5){
  const url = `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=${limit}`;
  const r = await fetch(url, { headers: osHeaders() });
  if(!r.ok) throw new Error(`OpenSea error ${r.status}`);
  const j = await r.json();
  return j.asset_events || [];
}

async function handleMarketCommand(interaction){
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  if(!guildId) return interaction.reply({ content:'Use this inside a server.', flags:MessageFlags.Ephemeral });
  const cfg = await loadMarketConfig();
  const guildCfg = getGuildMarket(cfg, guildId);

  if(sub === 'add'){
    if(!isAdmin(interaction)) return interaction.reply({ content:'Need Manage Server permission.', flags:MessageFlags.Ephemeral });
    const alias = normalizeAlias(interaction.options.getString('alias'));
    const slug = String(interaction.options.getString('slug') || '').trim();
    const contract = normalizeContract(interaction.options.getString('contract'));
    const chain = interaction.options.getString('chain') || DEFAULT_CHAIN;
    const channel = interaction.options.getChannel('sales_channel') || interaction.channel;
    if(!alias || !slug || !contract) return interaction.reply({ content:'Alias, slug, and valid contract are required.', flags:MessageFlags.Ephemeral });
    guildCfg.collections[alias] = { alias, slug, contract, chain, salesChannelId: channel.id, paused:false, addedAt:Date.now() };
    guildCfg.channelDefaults[channel.id] = alias;
    await saveMarketConfig(cfg);
    return interaction.reply({ content:`Added **${alias}** → \`${slug}\` sales in <#${channel.id}>.`, flags:MessageFlags.Ephemeral });
  }

  if(sub === 'list'){
    const entries = Object.entries(guildCfg.collections || {});
    if(!entries.length) return interaction.reply({ content:'No market collections configured yet.', flags:MessageFlags.Ephemeral });
    const lines = entries.map(([alias,c]) => `**${alias}** — \`${c.slug}\` — <#${c.salesChannelId}>${c.paused?' — paused':''}`);
    return interaction.reply({ content:lines.join('\n').slice(0,1900), flags:MessageFlags.Ephemeral });
  }

  if(sub === 'remove'){
    if(!isAdmin(interaction)) return interaction.reply({ content:'Need Manage Server permission.', flags:MessageFlags.Ephemeral });
    const alias = normalizeAlias(interaction.options.getString('alias'));
    if(!guildCfg.collections[alias]) return interaction.reply({ content:`No collection found for alias **${alias}**.`, flags:MessageFlags.Ephemeral });
    delete guildCfg.collections[alias];
    for(const [channelId,a] of Object.entries(guildCfg.channelDefaults || {})) if(a === alias) delete guildCfg.channelDefaults[channelId];
    await saveMarketConfig(cfg);
    return interaction.reply({ content:`Removed **${alias}**.`, flags:MessageFlags.Ephemeral });
  }

  if(sub === 'channel'){
    if(!isAdmin(interaction)) return interaction.reply({ content:'Need Manage Server permission.', flags:MessageFlags.Ephemeral });
    const alias = normalizeAlias(interaction.options.getString('alias'));
    const channel = interaction.options.getChannel('sales_channel') || interaction.channel;
    if(!guildCfg.collections[alias]) return interaction.reply({ content:`No collection found for alias **${alias}**.`, flags:MessageFlags.Ephemeral });
    guildCfg.collections[alias].salesChannelId = channel.id;
    guildCfg.channelDefaults[channel.id] = alias;
    await saveMarketConfig(cfg);
    return interaction.reply({ content:`Set **${alias}** sales/default channel to <#${channel.id}>.`, flags:MessageFlags.Ephemeral });
  }

  if(sub === 'sales'){
    const aliasOpt = interaction.options.getString('alias');
    const count = Math.max(1, Math.min(interaction.options.getInteger('count') || 5, 10));
    const resolved = resolveCollectionFromGuild(guildCfg, aliasOpt, interaction.channelId);
    if(!resolved) return interaction.reply({ content:'No market collection configured. Use `/market add` first.', flags:MessageFlags.Ephemeral });
    await interaction.deferReply();
    try{
      const sales = await fetchLatestSales(resolved.cfg.slug, count);
      if(!sales.length) return interaction.editReply('No recent sales found.');
      const embeds = sales.reverse().map(s => buildMarketSaleEmbed(s, resolved.cfg, resolved.alias));
      return interaction.editReply({ content:`Latest ${embeds.length} sale${embeds.length===1?'':'s'} for **${resolved.alias}**:`, embeds: embeds.slice(0,10) });
    }catch(e){ return interaction.editReply('Error: '+e.message); }
  }
}

function rpcUrlForChain(chain){
  if(chain !== 'ethereum') return process.env.RPC_URL || process.env.ETH_RPC_URL || process.env.ALCHEMY_RPC_URL || '';
  if(process.env.ALCHEMY_RPC_URL) return process.env.ALCHEMY_RPC_URL;
  if(process.env.ETH_RPC_URL) return process.env.ETH_RPC_URL;
  if(process.env.RPC_URL) return process.env.RPC_URL;
  if(process.env.ALCHEMY_API_KEY) return `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  return '';
}

function strip0x(s){ return String(s || '').replace(/^0x/i, ''); }
function pad64(hex){ return strip0x(hex).padStart(64, '0'); }
function encodeTokenUriCall(tokenId){ return '0xc87b56dd' + pad64(BigInt(tokenId).toString(16)); }

function decodeAbiString(hex){
  const clean = strip0x(hex);
  if(!clean || clean === '0') throw new Error('empty tokenURI result');
  const offset = parseInt(clean.slice(0,64), 16) * 2;
  const len = parseInt(clean.slice(offset, offset+64), 16) * 2;
  const data = clean.slice(offset+64, offset+64+len);
  return Buffer.from(data, 'hex').toString('utf8');
}

async function rpcCall(rpcUrl, method, params){
  const r = await fetch(rpcUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0', id:Date.now(), method, params}) });
  const j = await r.json();
  if(j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

async function fetchTokenUri(contract, tokenId, chain=DEFAULT_CHAIN){
  const rpc = rpcUrlForChain(chain);
  if(!rpc) throw new Error('No Ethereum RPC configured. Set ALCHEMY_API_KEY or ALCHEMY_RPC_URL.');
  const result = await rpcCall(rpc, 'eth_call', [{ to:contract, data:encodeTokenUriCall(tokenId) }, 'latest']);
  return decodeAbiString(result);
}

function ipfsToHttp(url){
  const s = String(url || '');
  if(s.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + s.replace('ipfs://','').replace(/^ipfs\//,'');
  return s;
}

async function loadJsonFromUri(uri){
  const u = String(uri || '');
  if(u.startsWith('data:application/json;base64,')) return JSON.parse(Buffer.from(u.split(',')[1], 'base64').toString('utf8'));
  if(u.startsWith('data:application/json;utf8,')) return JSON.parse(decodeURIComponent(u.split(',').slice(1).join(',')));
  const r = await fetch(ipfsToHttp(u));
  if(!r.ok) throw new Error(`metadata HTTP ${r.status}`);
  return await r.json();
}

async function imageSourceToSvgOrBuffer(image){
  const img = String(image || '');
  if(img.startsWith('data:image/svg+xml;base64,')) return Buffer.from(img.split(',')[1], 'base64').toString('utf8');
  if(img.startsWith('data:image/svg+xml;utf8,')) return decodeURIComponent(img.split(',').slice(1).join(','));
  if(img.trim().startsWith('<svg')) return img;
  if(img.startsWith('http') || img.startsWith('ipfs://')){
    const r = await fetch(ipfsToHttp(img));
    if(!r.ok) throw new Error(`image HTTP ${r.status}`);
    const buf = await r.buffer();
    const ct = r.headers.get('content-type') || '';
    if(ct.includes('svg') || buf.toString('utf8',0,20).includes('<svg')) return buf.toString('utf8');
    return buf;
  }
  throw new Error('Unsupported image format.');
}

function makeSvgTransparent(svg){
  let out = String(svg || '');
  out = out.replace(/<rect\b(?=[^>]*(?:width=['"]?100%|width=['"]?\d+))(?=[^>]*(?:height=['"]?100%|height=['"]?\d+))[^>]*(?:fill=['"][^'"]+['"])[^>]*>\s*<\/rect>/i, '');
  out = out.replace(/<rect\b(?=[^>]*(?:width=['"]?100%|width=['"]?\d+))(?=[^>]*(?:height=['"]?100%|height=['"]?\d+))[^>]*\/?>/i, '');
  return out;
}

function isSvgSource(src){
  if(!src) return false;
  const s = String(src).trim().toLowerCase();
  return (
    s.startsWith('<svg') ||
    s.startsWith('data:image/svg') ||
    s.endsWith('.svg') ||
    s.includes('image/svg')
  );
}

async function extractPngFromSvg(svgSource, size=2048){
  let svgText;
  const src = String(svgSource || '');

  if(src.trim().startsWith('<svg')){
    svgText = src;
  }else if(src.startsWith('data:image/svg+xml;base64,')){
    const b64 = src.split(',')[1];
    if(!b64) throw new Error('Empty SVG');
    svgText = Buffer.from(b64, 'base64').toString('utf-8');
  }else if(src.startsWith('data:image/svg+xml;utf8,')){
    svgText = decodeURIComponent(src.split(',').slice(1).join(','));
  }else{
    const r = await fetch(src);
    if(!r.ok) throw new Error('SVG fetch ' + r.status);
    svgText = await r.text();
  }

  let bgBuf;
  try{
    bgBuf = await sharp(Buffer.from(svgText))
      .resize(size, size, { kernel:'nearest', fit:'fill' })
      .png()
      .toBuffer();
  }catch(e){
    throw new Error('SVG render failed: ' + e.message);
  }

  const pngMatch = svgText.match(/src=["']data:image\/png;base64,([A-Za-z0-9+/=\s]+)["']/);
  if(pngMatch){
    try{
      const rawPng = Buffer.from(pngMatch[1].replace(/\s/g,''), 'base64');
      const charBuf = await sharp(rawPng)
        .resize(size, size, { kernel:'nearest' })
        .png()
        .toBuffer();

      return await sharp(bgBuf)
        .composite([{ input: charBuf, blend:'over' }])
        .png()
        .toBuffer();
    }catch(e){
      console.warn('[extractPngFromSvg] char composite failed, using full SVG render:', e.message);
    }
  }

  return bgBuf;
}

async function renderTokenPng({ contract, tokenId, chain, size, transparent }){
  const uri = await fetchTokenUri(contract, tokenId, chain);
  const meta = await loadJsonFromUri(uri);
  let src = await imageSourceToSvgOrBuffer(meta.image_data || meta.image || meta.image_url);

  if(typeof src === 'string' && transparent){
    src = makeSvgTransparent(src);
  }

  if(typeof src === 'string' && isSvgSource(src)){
    const buffer = await extractPngFromSvg(src, size);
    return { buffer, meta };
  }

  let pipeline = sharp(Buffer.isBuffer(src) ? src : Buffer.from(src));
  pipeline = pipeline.resize(size, size, { fit:'contain', withoutEnlargement:false });
  const buffer = await pipeline.png().toBuffer();
  return { buffer, meta };
}

async function handleDownloadCommand(interaction, forced={}){
  const tokenId = forced.tokenId || interaction.options?.getInteger?.('token');
  const sizeRaw = forced.size || interaction.options?.getInteger?.('size') || 2048;
  const size = Math.max(512, Math.min(sizeRaw, 4096));
  const transparent = forced.transparent ?? interaction.options?.getBoolean?.('transparent') ?? false;
  const collection = interaction.options?.getString?.('collection') || 'ocas';
  if(!tokenId) return interaction.reply({ content:'Provide a token ID.', flags:MessageFlags.Ephemeral });

  if(!interaction.deferred && !interaction.replied){
    if(forced.ephemeral) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferReply();
  }

  try{
    let contract = OCAS_CONTRACT, slug = DEFAULT_SLUG, chain = DEFAULT_CHAIN, alias = 'ocas';
    if(collection && collection !== 'ocas'){
      const cfg = await loadMarketConfig();
      const guildCfg = getGuildMarket(cfg, interaction.guildId || 'dm');
      const resolved = resolveCollectionFromGuild(guildCfg, collection, interaction.channelId);
      if(resolved){ contract = resolved.cfg.contract || contract; slug = resolved.cfg.slug || slug; chain = resolved.cfg.chain || chain; alias = resolved.alias; }
    }
    const finalTransparent = transparent;
    const { buffer } = await renderTokenPng({ contract, tokenId, chain, size, transparent: finalTransparent });
    const filename = `${alias}-${tokenId}-${size}${finalTransparent?'-transparent':''}.png`.replace(/[^a-z0-9_.-]+/gi,'-');
    const att = new AttachmentBuilder(buffer, { name:filename });
    const content = `PNG download for **${alias.toUpperCase()} #${tokenId}** · ${size}px${finalTransparent?' · transparent':''}`;
    return interaction.editReply({ content, files:[att] });
  }catch(e){
    return interaction.editReply('Download failed: ' + e.message).catch(()=>{});
  }
}

function extractTokenIdFromPayload(payload){
  const embeds = payload?.embeds || [];
  for(const e of embeds){
    const raw = [e?.data?.title, e?.data?.url, e?.data?.description].filter(Boolean).join(' ');
    const m = raw.match(/#(\d{1,5})|token[=/](\d{1,5})|assets\/ethereum\/0x[0-9a-f]{40}\/(\d{1,5})/i);
    if(m) return parseInt(m[1] || m[2] || m[3], 10);
  }
  return null;
}

function appendOcasDownloadButton(payload){
  if(!payload || typeof payload !== 'object') return payload;
  const tokenId = extractTokenIdFromPayload(payload);
  if(!tokenId) return payload;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ocas_download:${tokenId}:2048:0`).setLabel('Download PNG').setStyle(ButtonStyle.Secondary)
  );
  const existing = Array.isArray(payload.components) ? payload.components : [];
  return { ...payload, components:[...existing, row].slice(0,5) };
}

function patchOcasInteraction(interaction){
  const originalReply = interaction.reply?.bind(interaction);
  const originalEditReply = interaction.editReply?.bind(interaction);
  if(originalReply){
    interaction.reply = (options) => originalReply(typeof options === 'object' ? appendOcasDownloadButton(options) : options);
  }
  if(originalEditReply){
    interaction.editReply = (options) => originalEditReply(typeof options === 'object' ? appendOcasDownloadButton(options) : options);
  }
}

let marketPollStarted = false;
async function startMarketPoller(client){
  if(marketPollStarted) return;
  marketPollStarted = true;
  console.log(`[Market] Starting multi-collection sales poller every ${MARKET_POLL_MS}ms`);
  const tick = async () => {
    try{
      const cfg = await loadMarketConfig();
      const cursors = await dbLoad('market_sale_cursors_v1') || {};
      for(const [guildId,guildCfg] of Object.entries(cfg || {})){
        for(const [alias,c] of Object.entries(guildCfg.collections || {})){
          if(c.paused || !c.slug || !c.salesChannelId) continue;
          let sales = [];
          try{ sales = await fetchLatestSales(c.slug, 10); }catch(e){ console.warn('[Market poll fetch]', alias, e.message); continue; }
          if(!sales.length) continue;
          const latestKey = saleEventKey(sales[0]);
          const cursorKey = `${guildId}:${alias}`;
          if(!cursors[cursorKey]){ cursors[cursorKey] = latestKey; continue; }
          const newSales = [];
          for(const s of sales){
            const k = saleEventKey(s);
            if(k === cursors[cursorKey]) break;
            newSales.push(s);
          }
          if(!newSales.length) continue;
          const channel = await client.channels.fetch(c.salesChannelId).catch(()=>null);
          if(!channel){ console.warn(`[Market] channel not found guild=${guildId} alias=${alias} channel=${c.salesChannelId}`); continue; }
          for(const sale of newSales.reverse()){
            await channel.send({ embeds:[buildMarketSaleEmbed(sale, c, alias)] }).catch(e=>console.warn('[Market post]', e.message));
            await new Promise(r=>setTimeout(r, 500));
          }
          cursors[cursorKey] = latestKey;
        }
      }
      await dbSave('market_sale_cursors_v1', cursors);
    }catch(e){ console.warn('[Market poll]', e.message); }
  };
  setInterval(tick, MARKET_POLL_MS);
  setTimeout(tick, 5000);
}

const originalOn = Client.prototype.on;
Client.prototype.on = function(event, listener){
  if(event === 'ready'){
    return originalOn.call(this, event, async (...args) => {
      try{ await listener.apply(this, args); }catch(e){ console.error('[Wrapped ready original]', e.message); }
      startMarketPoller(this).catch(e=>console.error('[Market start]', e.message));
    });
  }
  if(event === 'interactionCreate'){
    return originalOn.call(this, event, async (interaction, ...args) => {
      try{
        if(interaction.isChatInputCommand?.() && interaction.commandName === 'market'){
          await handleMarketCommand(interaction);
          return;
        }
        if(interaction.isChatInputCommand?.() && interaction.commandName === 'download'){
          await handleDownloadCommand(interaction);
          return;
        }
        if(interaction.isButton?.() && interaction.customId?.startsWith('ocas_download:')){
          const [, token, size, transparentFlag] = interaction.customId.split(':');
          await handleDownloadCommand(interaction, { tokenId:parseInt(token,10), size:parseInt(size||'2048',10), transparent:transparentFlag === '1', ephemeral:true });
          return;
        }
        if(interaction.isChatInputCommand?.() && interaction.commandName === 'ocas'){
          patchOcasInteraction(interaction);
        }
      }catch(e){
        console.error('[Market/download wrapper]', e.message);
        try{ if(!interaction.replied && !interaction.deferred) await interaction.reply({content:'Error: '+e.message, flags:MessageFlags.Ephemeral}); }catch(_){}
        return;
      }
      return listener.call(this, interaction, ...args);
    });
  }
  return originalOn.call(this, event, listener);
};

require('./bot.js');
