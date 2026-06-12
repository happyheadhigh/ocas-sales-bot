'use strict';

const fetch = require('node-fetch');
const sharp = require('sharp');
const { AttachmentBuilder, MessageFlags } = require('discord.js');
const { extractPngFromSvg } = require('../lib/images');
const { pgPool, dbLoad } = require('../lib/db');

const DOWNLOAD_USER_COOLDOWN_MS = Math.max(0, parseInt(process.env.DOWNLOAD_USER_COOLDOWN_MS || '15000', 10));
const DOWNLOAD_GUILD_WINDOW_MS = Math.max(10000, parseInt(process.env.DOWNLOAD_GUILD_WINDOW_MS || '60000', 10));
const DOWNLOAD_GUILD_MAX_PER_WINDOW = Math.max(1, parseInt(process.env.DOWNLOAD_GUILD_MAX_PER_WINDOW || '8', 10));


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

const DOWNLOAD_COMMANDS = new Set(['download']);

module.exports = { handleDownloadCommand, DOWNLOAD_COMMANDS };
