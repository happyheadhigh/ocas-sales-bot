'use strict';

const fetch = require('node-fetch');
const sharp = require('sharp');
const { AttachmentBuilder, MessageFlags } = require('discord.js');
const { extractPngFromSvg } = require('../lib/images');
const { pgPool, dbLoad, dbSave } = require('../lib/db');

const DOWNLOAD_USER_COOLDOWN_MS = Math.max(0, parseInt(process.env.DOWNLOAD_USER_COOLDOWN_MS || '15000', 10));
const DOWNLOAD_GUILD_WINDOW_MS = Math.max(10000, parseInt(process.env.DOWNLOAD_GUILD_WINDOW_MS || '60000', 10));
const DOWNLOAD_GUILD_MAX_PER_WINDOW = Math.max(1, parseInt(process.env.DOWNLOAD_GUILD_MAX_PER_WINDOW || '8', 10));

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const DEFAULT_CHAIN = 'ethereum';
const DEFAULT_SLUG  = 'on-chain-all-stars';


function normalizeAlias(alias){
  return String(alias || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
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

  // OCAS should always resolve, even if it was never added through /market add.
  if(cleanAlias === 'ocas'){
    return {
      alias:'ocas',
      cfg:{
        alias:'ocas',
        slug:DEFAULT_SLUG,
        contract:OCAS_CONTRACT,
        chain:DEFAULT_CHAIN
      }
    };
  }

  if(cleanAlias && collections[cleanAlias]) return { alias: cleanAlias, cfg: collections[cleanAlias] };

  const byChannel = channelId ? guildCfg?.channelDefaults?.[channelId] : null;
  if(byChannel && collections[byChannel]) return { alias: byChannel, cfg: collections[byChannel] };

  if(collections.ocas) return { alias:'ocas', cfg: collections.ocas };

  const first = Object.keys(collections)[0];
  return first ? { alias:first, cfg:collections[first] } : null;
}

function findCollectionAliasInText(guildCfg, text){
  const cleanText = String(text || '').toLowerCase();
  const words = cleanText.split(/[\s,]+/).map(w => normalizeAlias(w.replace(/^#/, ''))).filter(Boolean);
  const collections = guildCfg?.collections || {};
  for(const w of words){
    if(w === 'ocas') return 'ocas';
    if(collections[w]) return w;
  }
  for(const [alias,c] of Object.entries(collections)){
    const slug = normalizeAlias(c?.slug || '');
    if(words.includes(slug)) return alias;
  }
  return null;
}

function parseDownloadSearch(search, guildCfg){
  const raw = String(search || '').trim();
  const lower = raw.toLowerCase();
  const alias = findCollectionAliasInText(guildCfg, raw) || null;
  const transparent = /\b(no\s*bg|nobg|no\s*background|transparent|alpha|clear)\b/i.test(raw);
  const sizeMatch = raw.match(/\b(512|1024|2048|4096)\b/);
  const size = sizeMatch ? parseInt(sizeMatch[1], 10) : null;
  let tokenId = null;

  const hashMatch = raw.match(/#\s*(\d{1,10})/);
  if(hashMatch){
    tokenId = parseInt(hashMatch[1], 10);
  }else{
    const nums = [...raw.matchAll(/\b(\d{1,10})\b/g)].map(m => parseInt(m[1], 10));
    const nonSize = nums.find(n => ![512,1024,2048,4096].includes(n));
    tokenId = nonSize || nums[0] || null;
  }

  return { alias, tokenId, size, transparent };
}

const downloadUserLastAt = new Map();
const downloadGuildHits = new Map();

function checkDownloadCooldown(interaction){
  if(!DOWNLOAD_USER_COOLDOWN_MS && !DOWNLOAD_GUILD_MAX_PER_WINDOW) return null;
  const now = Date.now();
  const userKey = interaction.user?.id || interaction.member?.user?.id || 'unknown';

  if(DOWNLOAD_USER_COOLDOWN_MS > 0){
    const last = downloadUserLastAt.get(userKey) || 0;
    const wait = DOWNLOAD_USER_COOLDOWN_MS - (now - last);
    if(wait > 0) return `Slow down a little — try again in ${Math.ceil(wait / 1000)}s.`;
    downloadUserLastAt.set(userKey, now);
  }

  const guildKey = interaction.guildId || interaction.channelId || 'dm';
  const hits = (downloadGuildHits.get(guildKey) || []).filter(t => now - t < DOWNLOAD_GUILD_WINDOW_MS);
  if(hits.length >= DOWNLOAD_GUILD_MAX_PER_WINDOW){
    const wait = DOWNLOAD_GUILD_WINDOW_MS - (now - hits[0]);
    downloadGuildHits.set(guildKey, hits);
    return `This server is hitting the download limit. Try again in ${Math.ceil(wait / 1000)}s.`;
  }
  hits.push(now);
  downloadGuildHits.set(guildKey, hits);
  return null;
}


// rpcUrlForChain replaced by burnRpcUrl from lib/rpc

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
  const wsOrHttpRpc = process.env.ALCHEMY_WEBSOCKET_URL || process.env.ETH_RPC_URL || process.env.ALCHEMY_RPC_URL || '';
  const rpc = wsOrHttpRpc
    ? wsOrHttpRpc.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
    : (process.env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : '');

  if(!rpc){
    throw new Error('No Ethereum RPC configured. Set ALCHEMY_WEBSOCKET_URL, ETH_RPC_URL, ALCHEMY_RPC_URL, or ALCHEMY_API_KEY.');
  }

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


async function renderTokenPng({ contract, tokenId, chain, size, transparent, osHeaders }){
  const uri = await fetchTokenUri(contract, tokenId, chain);
  const meta = await loadJsonFromUri(uri);

  // Check for animated content first — try on-chain metadata, then OpenSea API
  let animUrl = meta.animation_url || meta.animated_url || null;

  // If no animation_url in on-chain metadata, try OpenSea API (gets CDN GIF)
  if(!animUrl && osHeaders && contract && tokenId){
    try{
      const osNftUrl = `https://api.opensea.io/api/v2/chain/ethereum/contract/${contract}/nfts/${tokenId}`;
      console.log('[Download] Fetching OS metadata for animation_url:', osNftUrl);
      const osRes = await fetch(osNftUrl, { headers: osHeaders() });
      if(osRes.ok){
        const osData = await osRes.json();
        animUrl = osData?.nft?.animation_url || osData?.nft?.metadata?.animation_url || null;
        console.log('[Download] OS animation_url:', animUrl);
      } else {
        console.log('[Download] OS API status:', osRes.status);
      }
    }catch(e){ console.log('[Download] OS API error:', e.message); }
  }
  console.log('[Download] animUrl final:', animUrl, 'osHeaders available:', !!osHeaders);

  if(animUrl){
    const animStr = String(animUrl).toLowerCase();
    const isGif = animStr.includes('.gif') || animStr.includes('image/gif') || animStr.includes('seadn.io');
    const isMp4 = animStr.includes('.mp4') || animStr.includes('video/mp4') || animStr.includes('.webm');
    console.log('[Download] isGif:', isGif, 'isMp4:', isMp4, 'animStr:', animStr.slice(0,60));
    if(isGif || isMp4){
      console.log('[Download] Fetching animated file:', ipfsToHttp(animUrl));
      // Request GIF explicitly — CDNs like seadn.io may serve WebP otherwise
      const r = await fetch(ipfsToHttp(animUrl), { headers: { 'Accept': 'image/gif,image/*;q=0.9' } });
      console.log('[Download] Fetch status:', r.status, 'content-type:', r.headers.get('content-type'));
      if(!r.ok) throw new Error('animation fetch HTTP ' + r.status);
      const buffer = await r.buffer();
      // Use actual content-type to determine extension
      const ct = r.headers.get('content-type') || '';
      let ext = 'gif';
      if(isMp4 || ct.includes('video/mp4')) ext = 'mp4';
      else if(ct.includes('video/webm')) ext = 'webm';
      else if(ct.includes('image/webp')) ext = 'webp';
      else if(ct.includes('image/gif') || animStr.includes('.gif')) ext = 'gif';
      console.log('[Download] Returning animated buffer, ext:', ext, 'size:', buffer.length);
      return { buffer, meta, ext, animUrl: ipfsToHttp(animUrl) };
    }
  }

  let src = await imageSourceToSvgOrBuffer(meta.image_data || meta.image || meta.image_url);

  if(typeof src === 'string' && transparent){
  src = makeSvgTransparent(src);
  src = src.replace(/<rect\b[^>]*>/gi, '');
  src = src.replace(/<path\b[^>]*(?:fill=['"]#[0-9a-f]{3,8}['"]|fill=['"][^'"]+['"])[^>]*>\s*<\/path>/gi, '');
  src = src.replace(/<path\b[^>]*(?:fill=['"]#[0-9a-f]{3,8}['"]|fill=['"][^'"]+['"])[^>]*\/?>/gi, '');
}

  if(typeof src === 'string' && isSvgSource(src)){
  let buffer;

  if(src.trim().startsWith('<svg')){
    const svgDataUri = 'data:image/svg+xml;base64,' + Buffer.from(src).toString('base64');
    buffer = await extractPngFromSvg(svgDataUri);
  } else {
    buffer = await extractPngFromSvg(src);
  }

  if(size && size !== 500){
    buffer = await sharp(buffer)
      .resize(size, size, { kernel:'nearest', fit:'fill' })
      .png()
      .toBuffer();
  }

  return { buffer, meta };
}

  let pipeline = sharp(Buffer.isBuffer(src) ? src : Buffer.from(src));
  pipeline = pipeline.resize(size, size, { fit:'contain', withoutEnlargement:false });
  const buffer = await pipeline.png().toBuffer();
  return { buffer, meta };
}

async function handleDownloadCommand(interaction, forced={}){
  // forced may contain ctx fields like getConfig; extract them
  const ctx = forced.getConfig ? forced : {};
  if(forced.getConfig) forced = {};
  const cfgForParse = await loadMarketConfig();
  const guildCfgForParse = getGuildMarket(cfgForParse, interaction.guildId || 'dm');
  const searchText = interaction.options?.getString?.('search') || '';
  const parsed = parseDownloadSearch(searchText, guildCfgForParse);

  const tokenId = forced.tokenId || interaction.options?.getInteger?.('token') || parsed.tokenId;
  const sizeRaw = forced.size || interaction.options?.getInteger?.('size') || parsed.size || 2048;
  const size = Math.max(512, Math.min(sizeRaw, 4096));
  const transparent = forced.transparent ?? interaction.options?.getBoolean?.('transparent') ?? parsed.transparent ?? false;
  const collection = interaction.options?.getString?.('collection') || parsed.alias || 'ocas';
  if(!tokenId) return interaction.reply({ content:'Provide a token ID. Example: `/download search:ocas #337 2048 no bg`', flags:MessageFlags.Ephemeral });

  const cooldownMessage = forced.skipCooldown ? null : checkDownloadCooldown(interaction);
  if(cooldownMessage){
    return interaction.reply({ content:cooldownMessage, flags:MessageFlags.Ephemeral }).catch(()=>{});
  }

  if(!interaction.deferred && !interaction.replied){
    if(forced.ephemeral) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferReply();
  }

  try{
    let contract = OCAS_CONTRACT, slug = DEFAULT_SLUG, chain = DEFAULT_CHAIN, alias = 'ocas';
    if(collection && collection !== 'ocas'){
      // Check server_configs first (new wizard-configured collections)
      const serverCfg = ctx.getConfig ? ctx.getConfig(interaction.guildId) : null;
      let resolvedFromServer = false;
      if(serverCfg){
        // Check primary collection
        const primarySlug = serverCfg.slug || serverCfg.collectionSlug;
        if(primarySlug && (collection === primarySlug || collection === (serverCfg.contractName||'').toLowerCase())){
          contract = serverCfg.contract || contract;
          slug = primarySlug;
          alias = serverCfg.contractName || primarySlug;
          resolvedFromServer = true;
        }
        // Check extra collections
        if(!resolvedFromServer){
          for(const col of serverCfg.collections || []){
            const colSlug = col.slug || '';
            const colName = (col.name||'').toLowerCase();
            if(collection === colSlug || collection === colName){
              contract = col.contract || contract;
              slug = colSlug;
              alias = col.name || colSlug;
              resolvedFromServer = true;
              break;
            }
          }
        }
      }
      // Fall back to market_collections_v1 if not found in server_configs
      if(!resolvedFromServer){
        const cfg = await loadMarketConfig();
        const guildCfg = getGuildMarket(cfg, interaction.guildId || 'dm');
        const resolved = resolveCollectionFromGuild(guildCfg, collection, interaction.channelId);
        if(resolved){ contract = resolved.cfg.contract || contract; slug = resolved.cfg.slug || slug; chain = resolved.cfg.chain || chain; alias = resolved.alias; }
      }
    }
    const finalTransparent = transparent;
    const rendered = await renderTokenPng({ contract, tokenId, chain, size, transparent: finalTransparent, osHeaders: ctx.osHeaders });
    const { buffer } = rendered;
    const ext = rendered.ext || 'png';
    const sizeStr = ext === 'png' ? `-${size}` : '';
    const transparentStr = (ext === 'png' && finalTransparent) ? '-transparent' : '';
    const filename = `${alias}-${tokenId}${sizeStr}${transparentStr}.${ext}`.replace(/[^a-z0-9_.-]+/gi,'-');
    const att = new AttachmentBuilder(buffer, { name:filename });
    const isAnimated = ext !== 'png';
    let content;
    if(isAnimated){
      let rawUrl = rendered.animUrl || null;
      if(rawUrl) rawUrl = rawUrl.replace('i2c.seadn.io', 'raw2.seadn.io').replace('i.seadn.io', 'raw2.seadn.io');
      content = `${ext.toUpperCase()} download for **${alias.toUpperCase()} #${tokenId}**`;
      if(rawUrl) content += `\n📥 *To save the full quality GIF: [tap here](${rawUrl})*`;
    } else {
      content = `PNG download for **${alias.toUpperCase()} #${tokenId}** · ${size}px${finalTransparent?' · transparent':''}`;
    }
    return interaction.editReply({ content, files:[att] });
  }catch(e){
    return interaction.editReply('Download failed: ' + e.message).catch(()=>{});
  }
}

const DOWNLOAD_COMMANDS = new Set(['download']);

module.exports = { handleDownloadCommand, DOWNLOAD_COMMANDS };
