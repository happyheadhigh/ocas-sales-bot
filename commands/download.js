'use strict';

const fetch = require('node-fetch');
const sharp = require('sharp');
const { AttachmentBuilder, MessageFlags } = require('discord.js');
const { extractPngFromSvg } = require('../lib/images');
const { pgPool, dbLoad, dbSave } = require('../lib/db');
const { SUPPORTED_CHAINS } = require('../lib/collection-backfill');

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
  const alchemySubdomain = SUPPORTED_CHAINS[chain];
  const envOverride = process.env.ALCHEMY_WEBSOCKET_URL || process.env.ETH_RPC_URL || process.env.ALCHEMY_RPC_URL || '';
  // Env-var overrides are Ethereum-specific by their own naming (ETH_RPC_URL
  // etc.) — only use them when we're actually on Ethereum, otherwise they'd
  // silently point a non-Ethereum-chain call at an Ethereum RPC, the same
  // class of bug this fix addresses.
  const rpc = (chain === 'ethereum' || chain === DEFAULT_CHAIN) && envOverride
    ? envOverride.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
    : (process.env.ALCHEMY_API_KEY && alchemySubdomain ? `https://${alchemySubdomain}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : '');

  if(!rpc){
    throw new Error(alchemySubdomain
      ? 'No Ethereum RPC configured. Set ALCHEMY_WEBSOCKET_URL, ETH_RPC_URL, ALCHEMY_RPC_URL, or ALCHEMY_API_KEY.'
      : `Unsupported chain "${chain}" — no Alchemy subdomain known for it.`);
  }

  const result = await rpcCall(rpc, 'eth_call', [{ to:contract, data:encodeTokenUriCall(tokenId) }, 'latest']);
  return decodeAbiString(result);
}

// Returns an array of candidate HTTP URLs to try, in priority order. For
// ipfs:// URIs specifically, tries several gateways rather than a single
// hardcoded one — ipfs.io (what this used to point to exclusively) is a
// free, shared public gateway used across the entire web3 ecosystem, and
// is known to be one of the more congested ones. Cloudflare and dweb.link
// tend to be meaningfully faster in practice; ipfs.io kept as a last
// fallback rather than removed, since it's still a legitimate gateway,
// just not the best first choice. Non-IPFS URLs pass through unaffected,
// as a single-item array.
function ipfsToHttpCandidates(url){
  const s = String(url || '');
  if(s.startsWith('ipfs://')){
    const path = s.replace('ipfs://','').replace(/^ipfs\//,'');
    return [
      `https://cloudflare-ipfs.com/ipfs/${path}`,
      `https://dweb.link/ipfs/${path}`,
      `https://ipfs.io/ipfs/${path}`,
    ];
  }
  return [s];
}

// Backward-compatible single-URL helper, for callers that just need a
// display/link URL rather than an actual fetch (e.g. showing a raw link
// to the user) — returns the first, fastest candidate.
function ipfsToHttp(url){
  return ipfsToHttpCandidates(url)[0];
}

// Tries each gateway candidate in sequence with a real timeout (node-fetch
// v2 has none by default). Moves to the next candidate on a transient 5xx
// specifically (a genuine gateway-side problem, worth trying elsewhere for)
// or on a hard failure like a timeout — but not on a 404 or other non-5xx
// error, where a different gateway serving the exact same content wouldn't
// help.
async function fetchWithGatewayFallback(url, fetchOptions = {}){
  const candidates = ipfsToHttpCandidates(url);
  let lastErr = null;
  for(let i = 0; i < candidates.length; i++){
    const candidateUrl = candidates[i];
    try{
      console.log(`[Download] Fetching (gateway ${i+1}/${candidates.length}):`, candidateUrl);
      const r = await fetch(candidateUrl, { timeout: 15000, ...fetchOptions });
      console.log('[Download] Fetch status:', r.status);
      if(r.ok) return r;
      if([502,503,504].includes(r.status) && i < candidates.length - 1){
        lastErr = new Error(`HTTP ${r.status}`);
        continue;
      }
      throw new Error(`HTTP ${r.status}`);
    }catch(e){
      lastErr = e;
      if(i === candidates.length - 1) throw lastErr;
      console.log(`[Download] Gateway ${i+1} failed (${e.message}), trying next`);
    }
  }
  throw lastErr;
}

async function loadJsonFromUri(uri){
  const u = String(uri || '');
  if(u.startsWith('data:application/json;base64,')) return JSON.parse(Buffer.from(u.split(',')[1], 'base64').toString('utf8'));
  if(u.startsWith('data:application/json;utf8,')) return JSON.parse(decodeURIComponent(u.split(',').slice(1).join(',')));
  const r = await fetchWithGatewayFallback(u);
  return await r.json();
}

async function imageSourceToSvgOrBuffer(image){
  const img = String(image || '');
  if(img.startsWith('data:image/svg+xml;base64,')) return Buffer.from(img.split(',')[1], 'base64').toString('utf8');
  if(img.startsWith('data:image/svg+xml;utf8,')) return decodeURIComponent(img.split(',').slice(1).join(','));
  if(img.trim().startsWith('<svg')) return img;
  if(img.startsWith('http') || img.startsWith('ipfs://')){
    const r = await fetchWithGatewayFallback(img);
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
      const osNftUrl = `https://api.opensea.io/api/v2/chain/${chain || 'ethereum'}/contract/${contract}/nfts/${tokenId}`;
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
      const r = await fetchWithGatewayFallback(animUrl, { headers: { 'Accept': 'image/gif,image/*;q=0.9' } });
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
  // The broader rect/filled-path stripping below removes EVERY matching
  // element in the whole SVG, not just a background — fine for OCAS
  // specifically (its character art apparently isn't built from these),
  // but destructive for a collection whose actual artwork IS made of rects
  // (confirmed happening for onchainhoodies: pixel art is visibly built
  // from rects, so this was stripping the character itself, not just the
  // background, leaving nothing to render — hence the blank image).
  if(contract?.toLowerCase() === OCAS_CONTRACT){
    src = src.replace(/<rect\b[^>]*>/gi, '');
    src = src.replace(/<path\b[^>]*(?:fill=['"]#[0-9a-f]{3,8}['"]|fill=['"][^'"]+['"])[^>]*>\s*<\/path>/gi, '');
    src = src.replace(/<path\b[^>]*(?:fill=['"]#[0-9a-f]{3,8}['"]|fill=['"][^'"]+['"])[^>]*\/?>/gi, '');
  }
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

// Collections available for this guild's guided /download flow. Always
// returns at least one entry (OCAS) so the picker step can be skipped when
// there's nothing to choose between, same as /traitfind's collection picker.
function buildDownloadCollectionOptions(serverCfg){
  const allCols = [];
  const primarySlug = serverCfg?.collectionSlug || serverCfg?.slug;
  if(primarySlug) allCols.push({ slug: primarySlug, name: serverCfg.contractName || primarySlug });
  for(const c of serverCfg?.collections || []){ if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }
  if(!allCols.length) allCols.push({ slug: DEFAULT_SLUG, name: 'OCAS' });
  return allCols;
}

function showDlTokenModal(interaction, collectionSlug){
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = require('discord.js');
  const modal = new ModalBuilder()
    .setCustomId(`dl_modal:token:${collectionSlug || ''}`)
    .setTitle('Download — Token Details');
  modal.addComponents(
    new AR().addComponents(new TextInputBuilder().setCustomId('token_id').setLabel('Token ID').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('337')),
    new AR().addComponents(new TextInputBuilder().setCustomId('size').setLabel('Size in pixels (512-4096)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('2048')),
    new AR().addComponents(new TextInputBuilder().setCustomId('transparent').setLabel('Transparent background? (yes/no)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('no')),
  );
  return interaction.showModal(modal);
}

async function handleDownloadColPick(interaction, ctx){
  const slug = interaction.values[0];
  return showDlTokenModal(interaction, slug);
}

async function handleDownloadModalSubmit(interaction, ctx){
  const parts = interaction.customId.split(':');
  const collection = parts.slice(2).join(':') || 'ocas';
  const tokenId = parseInt((interaction.fields.getTextInputValue('token_id')||'').trim(), 10);
  if(!tokenId || tokenId < 1){
    return interaction.reply({ content:'❌ Invalid token ID. Please enter a positive number.', flags:MessageFlags.Ephemeral });
  }
  const sizeInput = (interaction.fields.getTextInputValue('size')||'').trim();
  const sizeRaw = sizeInput ? parseInt(sizeInput, 10) : 2048;
  if(sizeInput && (isNaN(sizeRaw) || sizeRaw < 512 || sizeRaw > 4096)){
    return interaction.reply({ content:'❌ Invalid size. Must be a number between 512 and 4096.', flags:MessageFlags.Ephemeral });
  }
  const size = Math.max(512, Math.min(sizeRaw || 2048, 4096));
  const transparentInput = (interaction.fields.getTextInputValue('transparent')||'').trim().toLowerCase();
  const transparent = transparentInput === 'yes' || transparentInput === 'y' || transparentInput === 'true';

  const cooldownMessage = checkDownloadCooldown(interaction);
  if(cooldownMessage){
    return interaction.reply({ content:cooldownMessage, flags:MessageFlags.Ephemeral }).catch(()=>{});
  }
  await interaction.deferReply();
  return runDownload(interaction, ctx, { tokenId, size, transparent, collection });
}

async function runDownload(interaction, ctx, { tokenId, size, transparent, collection, alias: forcedAlias }){
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
    // Authoritative chain lookup — server_configs' own collection entries
    // (primary + extras) never carry a chain field at all, so the branches
    // above leave `chain` at its default regardless of which collection was
    // actually resolved. The collections registry (populated during
    // onboarding via real OpenSea resolution) is the actual source of
    // truth; only fall back to whatever chain was already set if this
    // collection predates the registry (e.g. OCAS).
    try{
      const chainRow = await pgPool.query(`SELECT chain FROM collections WHERE slug = $1`, [slug]);
      if(chainRow.rows[0]?.chain) chain = chainRow.rows[0].chain;
    }catch(e){
      console.warn('[download] collections chain lookup failed:', e.message);
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

  // Nothing given at all — launch the guided flow. Collection picker only
  // appears if this guild actually has more than one collection configured;
  // otherwise it's skipped and falls straight to that one collection's modal.
  if(!tokenId && !searchText.trim()){
    const serverCfg = ctx.getConfig ? ctx.getConfig(interaction.guildId) : null;
    const allCols = buildDownloadCollectionOptions(serverCfg);
    if(allCols.length === 1){
      return showDlTokenModal(interaction, allCols[0].slug);
    }
    const { StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder: AR } = require('discord.js');
    const menu = new StringSelectMenuBuilder()
      .setCustomId('dl_browse:col')
      .setPlaceholder('Pick a collection...')
      .addOptions(allCols.slice(0, 25).map(c =>
        new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug)
      ));
    return interaction.reply({
      content: '**📥 Download** — Pick a collection:',
      components: [new AR().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if(!tokenId) return interaction.reply({ content:'Provide a token ID. Example: `/download search:ocas #337 2048 no bg`', flags:MessageFlags.Ephemeral });

  const cooldownMessage = forced.skipCooldown ? null : checkDownloadCooldown(interaction);
  if(cooldownMessage){
    return interaction.reply({ content:cooldownMessage, flags:MessageFlags.Ephemeral }).catch(()=>{});
  }

  if(!interaction.deferred && !interaction.replied){
    if(forced.ephemeral) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferReply();
  }

  return runDownload(interaction, ctx, { tokenId, size, transparent, collection });
}

const DOWNLOAD_COMMANDS = new Set(['download']);

module.exports = { handleDownloadCommand, handleDownloadColPick, handleDownloadModalSubmit, DOWNLOAD_COMMANDS };
