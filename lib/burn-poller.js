'use strict';

const tokenMetaCache = new Map();
function cacheTokenMeta(key, value){
  if(tokenMetaCache.size >= TOKEN_META_CACHE_MAX){
    let evicted = 0;
    for(const k of tokenMetaCache.keys()){
      tokenMetaCache.delete(k);
      if(++evicted >= TOKEN_META_CACHE_EVICT) break;
    }
  }
  tokenMetaCache.set(key, value);
}
function cleanTraitLabel(label){
  return String(label || '').replace(/\d+$/, '').trim() || String(label || '');
} // tokenId → { meta, expires }

const fetch = require('node-fetch');
const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
  OCAS_CONTRACT, BURN_CONTRACT, COLORS, osHeaders,
  BURN_START_BLOCK, BURN_BLOCK_CHUNK, BURN_LAG_ALERT_BLOCKS,
  ALCHEMY_KEY, RANK_SYNC_DELAY_MS, TOKEN_META_CACHE_MAX, TOKEN_META_CACHE_EVICT, OCAS_SLUG,
} = require('./constants');
const {
  BURN_COLORS, BURN_ALERT_CHANNEL_ID, BURN_BACKFILL_ALERTS,
  BURN_METADATA_REFRESH_ENABLED, E1_TYPE_NAMES,
  TOPIC_BURN_STARTED, TOPIC_BURN_FINALIZED,
  burnTypeLabel, burnTypeColor, burnTypeEmoji, normalizeOcasType, resolveOcasType,
} = require('./burn-constants');
const { pgPool, dbLoad, dbSave } = require('./db');
const { sendErrorWebhook } = require('./error');
const { burnRpc, burnRpcUrl, rpcHostForLog, getBurnBlockTimestamp, fetchTokenUriFromContract } = require('./rpc');
const { normAddr } = require('../utils/format');
const { fetchTokenMetaFromDb, upsertTokenTraitRows, burnTypeBreakdown } = require('./embeds');
const { snapshotTokenFromContract, resolveImage, extractPngFromSvg, sendEmbed } = require('./images');


let _lastLagAlertTs = 0; // debounce lag alerts
const { imageCache, setCachedImage, dedupeChannelPost } = require('./cache');
const { rankSyncQueue } = require('./rank-sync');
const { burnConfig, getBurnConfig, getConfiguredBurnChannelId } = require('./burn-config');
const { queueRankSync } = require('./rank-sync');
const { shortAddr, isDiscordOk } = require('../utils/format');

// ── Burn Machine poller ──────────────────────────────────────────────────────
// Uses Alchemy JSON-RPC to poll for BurnFinalized + BurnStarted events.
// BurnStarted: stores burned token IDs + owner (commit phase)
// BurnFinalized: cross-references BurnStarted, posts embed (reveal phase)

const BURN_STARTED_TOPIC   = '0x' + require('crypto').createHash('sha256').update('').digest('hex').slice(0,0)
  || null; // computed at runtime below

// We compute these inline using ethers-style manual topic matching via log.topics[0]






// ABI fragments for decoding



let _client = null;
function setClient(client){ _client = client; }

async function resolveDiscordChannel(channelId){
  if(!channelId || !_client) return null;
  return _client.channels.cache.get(channelId) || await _client.channels.fetch(channelId).catch(()=>null);
}

async function getBurnAlertChannels(){
  const configured = [];
  const seen = new Set();
  for(const [guildId, cfg] of Object.entries(burnConfig || {})){
    const channelId = getConfiguredBurnChannelId(cfg);
    if(channelId && !seen.has(channelId)){
      seen.add(channelId);
      configured.push({ guildId, channelId });
    }
  }

  if(!configured.length && BURN_ALERT_CHANNEL_ID){
    configured.push({ guildId: 'fallback', channelId: BURN_ALERT_CHANNEL_ID });
  }

  const channels = [];
  for(const item of configured){
    const { guildId, channelId } = item;
    const ch = await resolveDiscordChannel(channelId);
    if(ch) channels.push({ guildId, channelId, channel: ch });
    else console.warn(`[Burn] Configured burn alert channel not found guild=${guildId} channel=${channelId}`);
  }
  return channels;
}


const TRAIT_META_KEYS = new Set(['__image', '__attributes']);

function normalizeTraitAttribute(t){
  if(!t || typeof t !== 'object') return null;
  const trait_type = t.trait_type || t.traitType || t.type || t.name;
  const value = t.value;
  if(!trait_type || value == null) return null;
  return { trait_type:String(trait_type), value:String(value) };
}

function traitsArrayFromInput(input){
  if(!input) return [];
  if(Array.isArray(input)) return input.map(normalizeTraitAttribute).filter(Boolean);
  if(typeof input === 'object'){
    const embedded = input.__attributes || input.attributes || input.traits_array || input.trait_array;
    if(Array.isArray(embedded)){
      const arr = embedded.map(normalizeTraitAttribute).filter(Boolean);
      if(arr.length) return arr;
    }
    return Object.entries(input)
      .filter(([k,v]) => !TRAIT_META_KEYS.has(k) && v != null && typeof v !== 'object')
      .map(([trait_type,value]) => ({ trait_type:String(trait_type), value:String(value) }));
  }
  return [];
}

function traitsObjectFromArray(attrs, image=null){
  const clean = traitsArrayFromInput(attrs);
  const obj = {};
  for(const t of clean){
    // Compatibility object lookup for old code. Duplicate trait names are preserved
    // in __attributes even though this object key will contain the last value.
    obj[t.trait_type] = t.value;
  }
  if(clean.length) obj.__attributes = clean;
  if(image) obj.__image = image;
  return obj;
}

function realTraitCount(traits){
  return traitsArrayFromInput(traits).length;
}

function traitValue(traits, name){
  const wanted = String(name || '').toLowerCase();
  const attrs = traitsArrayFromInput(traits);
  const found = attrs.find(t => String(t.trait_type || '').toLowerCase() === wanted);
  if(found) return found.value;
  return traits && typeof traits === 'object' ? (traits[name] || traits[String(name).toLowerCase()]) : null;
}

function traitDisplayLines(traits, limit=14){
  return traitsArrayFromInput(traits)
    .slice(0, limit)
    .map(t => `**${cleanTraitLabel(t.trait_type)}:** ${t.value}`);
}

function getTraitImageSource(traits){
  return traits && typeof traits === 'object' ? traits.__image : null;
}


async function buildBurnEmbed(finalEvent, startEvent, overrideTraits = null, showSurvivorField = false){
  const survivorId   = finalEvent.survivorTokenId;
  const bodyType     = finalEvent.resultBodyType;
  const isAngel      = finalEvent.resultIsAngel;
  const points       = finalEvent.points;
  const burnerWallet = startEvent?.owner || 'unknown';
  const burnedIds    = startEvent?.tokenIds || [];
  const txHash       = finalEvent.txHash || '';
  const burnEventId  = finalEvent.burnEventId || null;

  const color     = burnTypeColor(bodyType, isAngel);

  const contract  = OCAS_CONTRACT;
  const osUrl     = `https://opensea.io/assets/ethereum/${contract}/${survivorId}`;
  const tvUrl     = `https://traitview.com/?token=${survivorId}`;
  const etherscan = txHash ? `https://etherscan.io/tx/${txHash}` : null;
  const burnerLink = burnerWallet !== 'unknown'
    ? `[${shortAddr(burnerWallet)}](https://opensea.io/${burnerWallet})`
    : 'unknown';

  // Exclude the survivor token from burned count/breakdown — it survived, wasn't burned
  const trulyBurnedIds = burnedIds.filter(id => String(id) !== String(survivorId));
  const burnedCount = trulyBurnedIds.length || '?';
  // Type breakdown: "2 · 2x Human" — seed type appended later as "(+ 1x Skeleton)"
  const burnedCountStr_base = trulyBurnedIds.length
    ? await burnTypeBreakdown(trulyBurnedIds, burnEventId).catch(()=>String(burnedCount))
    : String(burnedCount);

  // Get survivor's pre-burn type — try multiple sources in priority order
  let survivorPreBurnType = null;
  try{
    const sid = parseInt(survivorId);

    // 1. burn_state_snapshots — post-state from a previous burn (most accurate for multi-burn tokens)
    if(burnEventId){
      const snap1 = await pgPool.query(
        `SELECT traits_json FROM burn_state_snapshots
         WHERE token_id=$1 AND burn_event_id < $2
         ORDER BY burn_event_id DESC LIMIT 1`, [sid, burnEventId]
      ).catch(()=>({rows:[]}));
      if(snap1.rows[0]?.traits_json){
        const tj = typeof snap1.rows[0].traits_json === 'string'
          ? JSON.parse(snap1.rows[0].traits_json) : snap1.rows[0].traits_json;
        survivorPreBurnType = resolveOcasType(tj?.Type || tj?.type || null);
      }
    }

    // 2. token_original_snapshots — original mint traits (best for first-time burns)
    if(!survivorPreBurnType){
      const snap2 = await pgPool.query(
        `SELECT traits_json FROM token_original_snapshots WHERE token_id=$1`, [sid]
      ).catch(()=>({rows:[]}));
      if(snap2.rows[0]?.traits_json){
        const tj = typeof snap2.rows[0].traits_json === 'string'
          ? JSON.parse(snap2.rows[0].traits_json) : snap2.rows[0].traits_json;
        survivorPreBurnType = resolveOcasType(tj?.Type || tj?.type || null);
      }
    }

    // 3. token_traits — last resort
    if(!survivorPreBurnType){
      const snap3 = await pgPool.query(
        `SELECT trait_value FROM token_traits WHERE token_id=$1 AND LOWER(trait_name)='type' LIMIT 1`, [sid]
      ).catch(()=>({rows:[]}));
      if(snap3.rows[0]?.trait_value)
        survivorPreBurnType = resolveOcasType(snap3.rows[0].trait_value);
    }
  }catch(_){}

  // Prefer directly-passed freshTraits over cache to avoid stale-cache races.
  let dbMeta = null;
  if(overrideTraits && realTraitCount(overrideTraits)){
    dbMeta = { traits: overrideTraits, trait_count: realTraitCount(overrideTraits) };
  } else {
    const cached = tokenMetaCache.get(parseInt(survivorId)) || tokenMetaCache.get(`os:${parseInt(survivorId)}`);
    dbMeta = (cached && Date.now() < cached.expires) ? cached.meta : null;
  }

  // Image — contract tokenURI first (always current), fall back to OS
  imageCache?.delete?.(`${contract}:${survivorId}`);
  let imgResult = null;
  try{
    // Use contract image from traits cache if available
    const contractImgSrc = getTraitImageSource(dbMeta?.traits);
    if(contractImgSrc){
      if(contractImgSrc.startsWith('<svg') || contractImgSrc.startsWith('data:image/svg') || contractImgSrc.toLowerCase().includes('image/svg')){
        try{
          const buf = await extractPngFromSvg(contractImgSrc);
          if(buf) imgResult = { type:'buffer', buffer:buf, filename:`token-${survivorId}.png` };
        }catch(_){}
      }
      if(!imgResult && contractImgSrc.startsWith('http') && isDiscordOk(contractImgSrc)){
        imgResult = { type:'url', url:contractImgSrc };
      }
    }
    // Fall back to OpenSea if contract image unavailable
    if(!imgResult){
      imgResult = await resolveImage({identifier:String(survivorId)}, contract, 'ethereum');
      if(imgResult) setCachedImage(`${contract}:${survivorId}`, imgResult);
    }
  }catch(e){ console.warn('[Burn embed image]', e.message); }

  const embed = new EmbedBuilder()
    .setTitle(`🔥 OCAS Burn • #${survivorId} created`)
    .setColor(color)
    .setURL(osUrl)
    // No description — all info is in fields
    .addFields(
      { name:'Burner',         value:burnerLink,                inline:true },
      // Append seed type in parentheses — always shown so points always add up visually
      { name:'Tokens Burned',  value:(() => {
        if(!survivorPreBurnType) return burnedCountStr_base;
        const burnedTypes = burnedCountStr_base.toLowerCase();
        const seedLower = survivorPreBurnType.toLowerCase();
        const sameType = burnedTypes.includes(seedLower) && !burnedTypes.includes(',');
        return sameType ? burnedCountStr_base : `${burnedCountStr_base} (+ 1x ${survivorPreBurnType})`;
      })(), inline:true },
      { name:'Points Used',    value:`${points || 0} pts`,      inline:true },
      // Survivor field removed — title + image + traits already show the survivor
    );

  // Single Traits field in 2 columns — same layout as sales/listings.
  // Use __attributes when available so duplicate categories like Clothes are preserved.
  const burnTraitLines = traitDisplayLines(dbMeta?.traits, 14);
  if(burnTraitLines.length){
    const half = Math.ceil(burnTraitLines.length / 2);
    embed.addFields(
      { name:'Traits',    value: burnTraitLines.slice(0, half).join('\n') || '\u200b', inline:true },
      { name:'\u200b',   value: burnTraitLines.slice(half).join('\n')   || '\u200b', inline:true },
    );
  } else {
    embed.addFields({ name:'Traits', value:'_Syncing — check TraitView or OpenSea shortly_', inline:false });
  }

  const linkParts = [`[OpenSea](${osUrl})`, `[TraitView](${tvUrl})`];
  if(etherscan) linkParts.push(`[Etherscan](${etherscan})`);
  embed.addFields({ name:'Links', value:linkParts.join(' | '), inline:false });
  embed.setFooter({ text:'OCAS Burn Machine' }).setTimestamp();

  embed._imageResult = imgResult || null;

  // Always show Show Burned Tokens button
  const burnKey = finalEvent.burnEventId || `${finalEvent.txHash}:${finalEvent.logIndex}`;
  embed._components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`burn_ids:${burnKey}`)
      .setLabel(`Show Burned Tokens (${burnedCount})`)
      .setStyle(ButtonStyle.Secondary)
  )];

  return embed;
}

// Pending burn map: survivorTokenId → { owner, tokenIds, points, resultBodyType, resultIsAngel, boostChance, blockNumber, txHash }
const pendingBurns = new Map();

// ── Pending burn alert queue ──────────────────────────────────────────────────
// survivorTokenId → { finalEvent, startEvent, preBurnTraits, addedAt, attempts, slowMode }
// Populated on BurnFinalized; drained by processPendingBurnAlerts every 30s.
const pendingBurnAlerts = new Map();

// Fetch fresh OS metadata for a token, bypassing ALL caches.
async function fetchFreshOsMeta(tokenId){
  const id = parseInt(tokenId);
  if(!id) return null;
  // Delete both cache keys so the next call hits the network
  tokenMetaCache.delete(id);
  tokenMetaCache.delete(`os:${id}`);
  // Also bust the image cache so the embed gets the new image
  const imgKey = `${OCAS_CONTRACT}:${id}`;
  if(typeof imageCache !== 'undefined') imageCache?.delete?.(imgKey);
  try{
    const r = await fetch(
      `https://api.opensea.io/api/v2/chain/ethereum/contract/${OCAS_CONTRACT}/nfts/${id}`,
      { headers: osHeaders() }
    );
    if(!r.ok){ console.warn(`[BurnMeta] OS fetch failed for #${id}: HTTP ${r.status}`); return null; }
    const j = await r.json();
    const n = j.nft || j;
    const rawTraits = Array.isArray(n.traits) ? n.traits : (Array.isArray(n.attributes) ? n.attributes : []);
    const traits = traitsObjectFromArray(rawTraits, n.image || n.image_url || n.display_image_url || null);
    return realTraitCount(traits) ? traits : null;
  }catch(e){
    console.warn(`[BurnMeta] fetchFreshOsMeta error for #${id}:`, e.message);
    return null;
  }
}


// One-time fire-and-forget POST to OpenSea's metadata refresh endpoint.
// Tells OpenSea to re-fetch this token's metadata from the contract.
// Only called once per burn event. Does not block — errors are logged and ignored.
async function triggerOsMetadataRefresh(tokenId){
  if(!BURN_METADATA_REFRESH_ENABLED) return;
  const id = parseInt(tokenId);
  if(!id) return;
  try{
    const r = await fetch(
      `https://api.opensea.io/api/v2/chain/ethereum/contract/${OCAS_CONTRACT}/nfts/${id}/refresh`,
      { method:'POST', headers: osHeaders() }
    );
    console.log(`[BurnMeta] OS refresh triggered for #${id} — HTTP ${r.status}`);
  }catch(e){
    console.warn(`[BurnMeta] OS refresh trigger failed for #${id}:`, e.message);
  }
}

// Returns true if two trait objects differ (or one is null and the other isn't).
function traitsDiffer(a, b){
  const arrA = traitsArrayFromInput(a);
  const arrB = traitsArrayFromInput(b);
  if(!arrA.length && !arrB.length) return false;
  if(arrA.length !== arrB.length) return true;
  for(let i = 0; i < arrA.length; i++){
    if(String(arrA[i].trait_type) !== String(arrB[i].trait_type)) return true;
    if(String(arrA[i].value) !== String(arrB[i].value)) return true;
  }
  return false;
}

async function storeBurnStarted(event, opts = {}){
  const snapshotInputs = opts.snapshotInputs !== false;
  try{
    // Snapshot pre-burn DB traits for the survivor token so we can detect when metadata refreshes
    const preBurnMeta = await fetchTokenMetaFromDb(event.survivorTokenId).catch(()=>null);
    const preBurnTraits = preBurnMeta?.traits ? { ...preBurnMeta.traits } : null;
    if(preBurnTraits) console.log(`[BurnMeta] Pre-burn snapshot for #${event.survivorTokenId}: Type=${preBurnTraits.Type||preBurnTraits.type||'?'}`);

    // Snapshot selected tokens only for live/new burns.
// Historical backfill can include already-consumed tokens, which causes tons of
// reverted tokenURI eth_call requests and provider 429s.
if(snapshotInputs){
  for(const tid of (event.tokenIds || [])){
    snapshotTokenFromContract(tid, 'burn-start-input').catch(e =>
      console.warn(`[BurnMeta] input snapshot failed for #${tid}:`, e.message)
    );
  }
} else {
  console.log(`[BurnMeta] Skipping input snapshots for historical burn start #${event.survivorTokenId}`);
}

    // Cache in memory for cross-referencing with BurnFinalized
    pendingBurns.set(String(event.survivorTokenId), {
      owner:         event.owner,
      tokenIds:      event.tokenIds.map(Number),
      points:        event.points,
      resultBodyType: event.resultBodyType,
      resultIsAngel: event.resultIsAngel,
      boostChance:   event.boostChance,
      blockNumber:   event.blockNumber,
      logIndex:       event.logIndex,
      txHash:        event.txHash,
      preBurnTraits, // snapshot for metadata refresh detection
    });
    const r = await pgPool.query(
      `INSERT INTO burn_started_events
         (tx_hash, block_number, log_index, owner_wallet, survivor_token_id,
          points_used, result_body_type, result_is_angel, boost_chance, reveal_block, selection_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tx_hash, log_index) DO UPDATE SET
          owner_wallet=EXCLUDED.owner_wallet,
          survivor_token_id=EXCLUDED.survivor_token_id,
          points_used=EXCLUDED.points_used,
          result_body_type=EXCLUDED.result_body_type,
          result_is_angel=EXCLUDED.result_is_angel,
          boost_chance=EXCLUDED.boost_chance,
          reveal_block=EXCLUDED.reveal_block,
          selection_hash=EXCLUDED.selection_hash
       RETURNING id`,
      [
        event.txHash || '', event.blockNumber || 0, event.logIndex || 0,
        normAddr(event.owner) || event.owner || '', event.survivorTokenId,
        event.points, event.resultBodyType, event.resultIsAngel,
        event.boostChance, event.revealBlock || null, event.selectionHash || null,
      ]
    );
    const burnStartedId = r.rows[0]?.id;
    if(burnStartedId){
      for(const tokenId of event.tokenIds || []){
        await pgPool.query(
          `INSERT INTO burn_started_inputs (burn_started_id, burned_token_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [burnStartedId, tokenId]
        ).catch(()=>{});
      }
    }
  }catch(e){ console.warn('[Burn] storeBurnStarted error:', e.message); }
}

const burnBlockTimestampCache = new Map();



async function storeBurnFinalized(finalEvent, startEvent){
  try{
    const burnedIds = startEvent?.tokenIds || [];
    const burnedAt = await getBurnBlockTimestamp(finalEvent.blockNumber);
    if(!burnedAt) throw new Error(`block timestamp unavailable for finalized tx=${finalEvent.txHash || 'unknown'} block=${finalEvent.blockNumber || 'unknown'}`);
    const r = await pgPool.query(
      `INSERT INTO burn_events
         (tx_hash, block_number, log_index, burner_wallet, survivor_token_id,
           result_body_type, result_is_angel, points_used, boost_chance, burn_seed, burned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tx_hash, log_index) DO UPDATE SET
           block_number=EXCLUDED.block_number,
           burner_wallet=EXCLUDED.burner_wallet,
           survivor_token_id=EXCLUDED.survivor_token_id,
           result_body_type=EXCLUDED.result_body_type,
           result_is_angel=EXCLUDED.result_is_angel,
           points_used=EXCLUDED.points_used,
           boost_chance=EXCLUDED.boost_chance,
           burn_seed=EXCLUDED.burn_seed,
           burned_at=EXCLUDED.burned_at
       RETURNING id`,
      [
        finalEvent.txHash || '', finalEvent.blockNumber || 0, finalEvent.logIndex || 0,
        startEvent?.owner || '', finalEvent.survivorTokenId,
        finalEvent.resultBodyType, finalEvent.resultIsAngel,
        finalEvent.points, finalEvent.boostChance,
        String(finalEvent.burnSeed || ''), burnedAt,
      ]
    );
    if(r.rows.length && burnedIds.length){
      const burnEventId = r.rows[0].id;
      for(const tokenId of burnedIds){
        await pgPool.query(
          `INSERT INTO burn_event_inputs (burn_event_id, burned_token_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [burnEventId, tokenId]
        ).catch(()=>{});
      }
    }
    return r.rows[0]?.id || null;
  }catch(e){ console.warn('[Burn] storeBurnFinalized DB error:', e.message); }
  return null;
}

async function postBurnAlertToConfiguredChannels(finalEvent, startEvent, freshTraits = null){
  const burnChannels = await getBurnAlertChannels();
  if(!burnChannels.length){
    console.log(`[Burn alert] no configured burn alert channels for tx=${finalEvent.txHash || 'unknown'} log=${finalEvent.logIndex ?? 'unknown'}`);
    return;
  }
  const dedupeKey = `burn:${finalEvent.txHash || ''}:${finalEvent.logIndex ?? ''}`;
  for(const target of burnChannels){
    const { guildId, channelId, channel } = target;
    try{
      if(!dedupeChannelPost(channelId, dedupeKey)){
        console.log(`[Burn alert] skipped guild=${guildId} channel=${channelId} tx=${finalEvent.txHash} log=${finalEvent.logIndex}`);
        continue;
      }
      const posted = await pgPool.query(
        'SELECT 1 FROM burn_alert_posts WHERE tx_hash=$1 AND log_index=$2 AND channel_id=$3 LIMIT 1',
        [finalEvent.txHash || '', finalEvent.logIndex || 0, channelId]
      ).catch(e => {
        console.warn(`[Burn alert] dedupe lookup failed guild=${guildId} channel=${channelId}: ${e.message}`);
        return { rows: [] };
      });
      if(posted.rows.length){
        console.log(`[Burn alert] skipped guild=${guildId} channel=${channelId} tx=${finalEvent.txHash} log=${finalEvent.logIndex} reason=already-posted`);
        continue;
      }
      const embed = await buildBurnEmbed(finalEvent, startEvent, freshTraits);
      await sendEmbed(channel, embed);
      await pgPool.query(
        `INSERT INTO burn_alert_posts (tx_hash, log_index, guild_id, channel_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tx_hash, log_index, channel_id) DO NOTHING`,
        [finalEvent.txHash || '', finalEvent.logIndex || 0, guildId, channelId]
      ).catch(e => console.warn(`[Burn alert] post marker failed guild=${guildId} channel=${channelId}: ${e.message}`));
      console.log(`[Burn alert] posted guild=${guildId} channel=${channelId} tx=${finalEvent.txHash} log=${finalEvent.logIndex}`);
    }catch(e){
      console.warn(`[Burn alert] failed guild=${guildId} channel=${channelId} tx=${finalEvent.txHash} log=${finalEvent.logIndex}: ${e.message}`);
    }
  }
}

async function pollBurnEventsLegacy(){
  const rpcUrl = burnRpcUrl();
  if(!rpcUrl) return;


  try{
    const lastBlockRaw = await dbLoad('burn_last_block');
    let fromBlock = lastBlockRaw ? parseInt(lastBlockRaw) + 1 : null;

    if(!fromBlock){
      const r = await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]})});
      const j = await r.json();
      fromBlock = Math.max(0, parseInt(j.result,16) - 2000);
      console.log('[Burn] First run, starting from block', fromBlock);
    }

    const r2 = await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]})});
    const j2 = await r2.json();
    const toBlock = parseInt(j2.result,16);
    if(fromBlock >= toBlock) return;

    const logsRes = await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_getLogs',params:[{
        address: BURN_CONTRACT,
        fromBlock: '0x'+fromBlock.toString(16),
        toBlock:   '0x'+toBlock.toString(16),
        // Filter for only our two event topics
        topics: [[TOPIC_BURN_STARTED, TOPIC_BURN_FINALIZED]],
      }]})});
    const logsJson = await logsRes.json();
    const logs = logsJson.result || [];
    if(logsJson.error) throw new Error('eth_getLogs error: ' + JSON.stringify(logsJson.error));

    if(logs.length) console.log(`[Burn] ${logs.length} log(s) in blocks ${fromBlock}→${toBlock}`);

    // ── Pass 1: process BurnStarted — store pending burns ─────────────────
    for(const log of logs){
      if(log.topics[0]?.toLowerCase() !== TOPIC_BURN_STARTED) continue;
      // BurnStarted topics: [topic0, owner(indexed), survivorTokenId(indexed), survivorTokenIdSeed(indexed)]
      // data: tokenIds[], points, resultBodyType, resultIsAngel, boostChance, revealBlock, selectionHash
      try{
        const owner           = '0x' + log.topics[1].slice(26);
        const survivorTokenId = parseInt(log.topics[2], 16);
        const txHash          = log.transactionHash;
        const blockNum        = parseInt(log.blockNumber, 16);
        const data            = log.data.slice(2);
        const words           = [];
        for(let i=0;i<data.length;i+=64) words.push(data.slice(i,i+64));

        // ABI: data starts with offset to tokenIds[] dynamic array
        // word[0] = offset (bytes) to start of tokenIds array = 0xe0 = 224 = 7*32
        // word[1..6] = 6 static params (points, bodyType, isAngel, boostChance, revealBlock, selectionHash)
        // BUT: dynamic array comes FIRST in data for this event
        // Actual layout: offset_to_array | points | bodyType | isAngel | boostChance | revealBlock | selectionHash | array_len | array_items...
        const offset   = parseInt(words[0]||'0', 16); // byte offset = 0xe0 = 224 → word index 7
        const arrWord  = offset / 32;                 // = 7
        const arrLen   = parseInt(words[arrWord]||'0', 16);
        const tokenIds = [];
        for(let i=0;i<arrLen;i++) tokenIds.push(parseInt(words[arrWord+1+i]||'0',16));

        // Static params are words 1..6 (before the array)
        const points      = parseInt(words[1]||'0',16);
        const bodyType    = parseInt(words[2]||'0',16);
        const isAngel     = parseInt(words[3]||'0',16) === 1;
        const boostChance = parseInt(words[4]||'0',16);

        await storeBurnStarted({ owner, survivorTokenId, tokenIds, points,
          resultBodyType: bodyType, resultIsAngel: isAngel, boostChance, blockNumber: blockNum, txHash });
        console.log(`[Burn] BurnStarted: #${survivorTokenId} ← [${tokenIds.join(',')}] by ${shortAddr(owner)} pts=${points} type=${bodyType}`);
      }catch(e){ console.warn('[Burn] BurnStarted decode error:', e.message, 'topics:', log.topics, 'data:', log.data?.slice(0,130)); }
    }

    // ── Pass 2: process BurnFinalized — post embeds ────────────────────────
    for(const log of logs){
      if(log.topics[0]?.toLowerCase() !== TOPIC_BURN_FINALIZED) continue;
      // BurnFinalized topics: [topic0, survivorTokenId(indexed), survivorTokenIdSeed(indexed)]
      // data: burnSeed, points, resultBodyType, resultIsAngel, boostChance
      try{
        const survivorTokenId = parseInt(log.topics[1], 16);
        const txHash          = log.transactionHash;
        const blockNum        = parseInt(log.blockNumber, 16);
        const logIndex        = parseInt(log.logIndex, 16);
        const data            = log.data.slice(2);
        const words           = [];
        for(let i=0;i<data.length;i+=64) words.push(data.slice(i,i+64));

        // data layout: burnSeed | points | resultBodyType | resultIsAngel | boostChance
        const burnSeed    = words[0] || '';
        const points      = parseInt(words[1]||'0',16);
        const bodyType    = parseInt(words[2]||'0',16);
        const isAngel     = parseInt(words[3]||'0',16) === 1;
        const boostChance = parseInt(words[4]||'0',16);

        console.log(`[Burn] BurnFinalized raw: #${survivorTokenId} bodyType=${bodyType} isAngel=${isAngel} points=${points}`);

        // Check duplicate
        const existing = await pgPool.query(
          'SELECT id FROM burn_events WHERE tx_hash=$1 AND log_index=$2', [txHash, logIndex]
        );
        const wasAlreadyStored = existing.rows.length > 0;
        if(wasAlreadyStored) console.log(`[Burn] Already stored tx ${txHash.slice(0,10)} log=${logIndex}; skipping replay alert`);

        // Cross-reference with BurnStarted data
        const startEvent = pendingBurns.get(String(survivorTokenId)) ||
          await loadBurnStartFromDB(survivorTokenId);

        if(!startEvent) console.warn(`[Burn] No BurnStarted found for survivor #${survivorTokenId} — embed will show unknown burner/burned IDs`);

        const finalEvent = { survivorTokenId, burnSeed, points, resultBodyType: bodyType,
          resultIsAngel: isAngel, boostChance, txHash, blockNumber: blockNum, logIndex };

        finalEvent.burnEventId = await storeBurnFinalized(finalEvent, startEvent);
        console.log(`[Burn] BurnFinalized: #${survivorTokenId} → ${burnTypeLabel(bodyType,isAngel)} burned=[${startEvent?.tokenIds?.join(',')||'?'}]`);

        // Queue to pending alert system — same as processBurnLogs.
        // Do not re-alert already-stored historical burns during staging/repair catch-up.
        if(!wasAlreadyStored){
          const alertKey = String(survivorTokenId);
          if(!pendingBurnAlerts.has(alertKey)){
            pendingBurnAlerts.set(alertKey, {
              finalEvent: { ...finalEvent },
              startEvent: { ...startEvent },
              preBurnTraits: startEvent?.preBurnTraits || null,
              addedAt:  Date.now(),
              attempts: 0,
              slowMode: false,
            });
            console.log(`[BurnMeta] Queued pending alert for #${survivorTokenId} — awaiting metadata refresh`);
            // Fire-and-forget OS metadata refresh — helps speed up metadata propagation
            triggerOsMetadataRefresh(survivorTokenId);
          }
        }
        pendingBurns.delete(String(survivorTokenId));
      }catch(e){ console.warn('[Burn] BurnFinalized error:', e.message); }
    }

    await dbSave('burn_last_block', String(toBlock));
  }catch(e){ console.error('[Burn poller]', e.message); }
}


async function processBurnLogs(logs, shouldAlert){
  if(logs.length) console.log(`[Burn] processing ${logs.length} log(s), alerts=${shouldAlert ? 'on' : 'off'}`);

  for(const log of logs){
    if(log.topics[0]?.toLowerCase() !== TOPIC_BURN_STARTED) continue;
    try{
      const owner           = normAddr('0x' + log.topics[1].slice(26));
      const survivorTokenId = parseInt(log.topics[2], 16);
      const txHash          = String(log.transactionHash || '').toLowerCase();
      const blockNum        = parseInt(log.blockNumber, 16);
      const logIndex        = parseInt(log.logIndex, 16);
      const data            = log.data.slice(2);
      const words           = [];
      for(let i=0;i<data.length;i+=64) words.push(data.slice(i,i+64));

      const offset   = parseInt(words[0]||'0', 16);
      const arrWord  = offset / 32;
      const arrLen   = parseInt(words[arrWord]||'0', 16);
      const tokenIds = [];
      for(let i=0;i<arrLen;i++) tokenIds.push(parseInt(words[arrWord+1+i]||'0',16));

      const points        = parseInt(words[1]||'0',16);
      const bodyType      = parseInt(words[2]||'0',16);
      const isAngel       = parseInt(words[3]||'0',16) === 1;
      const boostChance   = parseInt(words[4]||'0',16);
      const revealBlock   = parseInt(words[5]||'0',16);
      const selectionHash = words[6] ? '0x' + words[6] : null;

      await storeBurnStarted({ owner, survivorTokenId, tokenIds, points,
  resultBodyType: bodyType, resultIsAngel: isAngel, boostChance,
  revealBlock, selectionHash, blockNumber: blockNum, logIndex, txHash }, { snapshotInputs: shouldAlert });
      console.log(`[Burn] BurnStarted: #${survivorTokenId} <- [${tokenIds.join(',')}] by ${shortAddr(owner)} pts=${points} tier=${bodyType}`);
    }catch(e){ console.warn('[Burn] BurnStarted decode error:', e.message, 'topics:', log.topics, 'data:', log.data?.slice(0,130)); }
  }

  for(const log of logs){
    if(log.topics[0]?.toLowerCase() !== TOPIC_BURN_FINALIZED) continue;
    try{
      const survivorTokenId = parseInt(log.topics[1], 16);
      const txHash          = String(log.transactionHash || '').toLowerCase();
      const blockNum        = parseInt(log.blockNumber, 16);
      const logIndex        = parseInt(log.logIndex, 16);
      const data            = log.data.slice(2);
      const words           = [];
      for(let i=0;i<data.length;i+=64) words.push(data.slice(i,i+64));

      const burnSeed    = words[0] || '';
      const points      = parseInt(words[1]||'0',16);
      const bodyType    = parseInt(words[2]||'0',16);
      const isAngel     = parseInt(words[3]||'0',16) === 1;
      const boostChance = parseInt(words[4]||'0',16);

      const existing = await pgPool.query(
        'SELECT id FROM burn_events WHERE tx_hash=$1 AND log_index=$2', [txHash, logIndex]
      );
      const wasAlreadyStored = existing.rows.length > 0;
      if(wasAlreadyStored) console.log(`[Burn] Already stored tx ${txHash.slice(0,10)} log=${logIndex}; skipping replay alert`);

      const startEvent = pendingBurns.get(String(survivorTokenId)) ||
        await loadBurnStartFromDB(survivorTokenId);
      if(!startEvent) console.warn(`[Burn] No BurnStarted found for survivor #${survivorTokenId} - embed will show unknown burner/burned IDs`);

      const finalEvent = { survivorTokenId, burnSeed, points, resultBodyType: bodyType,
        resultIsAngel: isAngel, boostChance, txHash, blockNumber: blockNum, logIndex };

      finalEvent.burnEventId = await storeBurnFinalized(finalEvent, startEvent);
      console.log(`[Burn] BurnFinalized: #${survivorTokenId} tier=${burnTypeLabel(bodyType,isAngel)} burned=[${startEvent?.tokenIds?.join(',')||'?'}]`);

      if(shouldAlert && !wasAlreadyStored){
        // Queue to pending alert system — do NOT post immediately.
        // processPendingBurnAlerts() will wait for metadata to refresh before posting.
        // Already-stored burns are DB replays/backfills and should not repost to Discord.
        const preBurnTraits = startEvent?.preBurnTraits || null;
        const alertKey = String(survivorTokenId);
        if(!pendingBurnAlerts.has(alertKey)){
          pendingBurnAlerts.set(alertKey, {
            finalEvent: { ...finalEvent },
            startEvent: { ...startEvent },
            preBurnTraits,
            addedAt:  Date.now(),
            attempts: 0,
            slowMode: false,
          });
          console.log(`[BurnMeta] Queued pending alert for #${survivorTokenId} — awaiting metadata refresh`);
          // Fire-and-forget OS metadata refresh — helps speed up metadata propagation
          triggerOsMetadataRefresh(survivorTokenId);
        }
      }
      pendingBurns.delete(String(survivorTokenId));
    }catch(e){ console.warn('[Burn] BurnFinalized error:', e.message); }
  }
}

// ── Pending burn alert processor ─────────────────────────────────────────────
// Runs every 30s. For each queued burn event, fetches fresh OS metadata and
// Reads traits directly from contract tokenURI — no OS polling or snapshot wait needed.
// Contract always has current on-chain state the moment BurnFinalized is confirmed.
// Falls back to OS metadata if contract call fails. Retries up to 2 hours on post failure.
async function processPendingBurnAlerts(){
  if(!pendingBurnAlerts.size) return;
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60_000;

  for(const [key, entry] of pendingBurnAlerts){
    const { finalEvent, startEvent, addedAt, attempts } = entry;
    const survivorId = finalEvent.survivorTokenId;
    const ageMs      = now - addedAt;
    entry.attempts++;

    // Hard cap: 2 hours — post minimal fallback and remove
    if(ageMs > TWO_HOURS){
      console.warn(`[BurnMeta] #${survivorId} failed to post after 2 hours — posting minimal fallback`);
      try{ await postBurnFallbackAlert(finalEvent, startEvent); }catch(e){ console.error(`[BurnMeta] fallback failed for #${survivorId}:`, e.message); }
      pendingBurnAlerts.delete(key);
      continue;
    }

    // Fetch traits from contract — always current post-burn state
    let freshTraits = null;
    try{
      freshTraits = await fetchTokenUriFromContract(survivorId);
      if(freshTraits) console.log(`[BurnMeta] #${survivorId} contract traits OK → Type=${freshTraits.Type||freshTraits.type||'?'}`);
    }catch(e){
      console.warn(`[BurnMeta] contract tokenURI failed for #${survivorId}:`, e.message);
    }

    // Fallback to OS if contract call failed
    if(!freshTraits){
      console.log(`[BurnMeta] #${survivorId} contract failed — trying OS fallback`);
      try{ freshTraits = await fetchFreshOsMeta(survivorId); }catch(e){ console.warn(`[BurnMeta] OS fallback also failed for #${survivorId}:`, e.message); }
    }

    if(!freshTraits){
      console.log(`[BurnMeta] #${survivorId} no traits yet (attempt ${entry.attempts}) — retrying next tick`);
      continue;
    }

    // Set traits into cache so buildBurnEmbed picks them up
    const freshMeta = { os_rank: null, traits: freshTraits, trait_count: realTraitCount(freshTraits) };
    cacheTokenMeta(parseInt(survivorId), { meta: freshMeta, expires: Date.now() + 5 * 60_000 });
    cacheTokenMeta(`os:${parseInt(survivorId)}`, { meta: freshMeta, expires: Date.now() + 5 * 60_000 });
    imageCache?.delete?.(`${OCAS_CONTRACT}:${survivorId}`);

    try{
      await postBurnAlertToConfiguredChannels(finalEvent, startEvent, freshTraits);
      // Write post-burn traits to DB so /burnlatest and /burn work after restarts
      try{
        await upsertTokenTraitRows(survivorId, freshTraits, 'burn-finalized-survivor');
        console.log(`[BurnMeta] Wrote ${realTraitCount(freshTraits)} post-burn trait rows to DB for #${survivorId}`);
        // Also keep tokens.image_url current — reuses the same __image data
        // already fetched above for the trait write, no extra API call.
        // This was previously only backfilled manually (never kept live),
        // which is why TraitView's grid showed stale images until a token
        // was clicked (which triggers its own separate live OpenSea fetch).
        const survivorImg = getTraitImageSource(freshTraits);
        if(survivorImg){
          try{
            await pgPool.query(
              `UPDATE tokens SET image_url=$1 WHERE id=$2 AND collection_slug=$3`,
              [survivorImg, survivorId, OCAS_SLUG]
            );
          }catch(imgErr){
            console.warn(`[BurnMeta] Failed to write tokens.image_url for #${survivorId}:`, imgErr.message);
          }
        }
        // Queue a delayed OS rank fetch — wait for OS to update their end before fetching
        setTimeout(() => { rankSyncQueue.add(parseInt(survivorId)); }, RANK_SYNC_DELAY_MS);
        console.log(`[BurnMeta] OS rank update queued for #${survivorId} in ${RANK_SYNC_DELAY_MS/1000}s`);
      }catch(dbErr){
        console.warn(`[BurnMeta] Failed to write post-burn traits for #${survivorId}:`, dbErr.message);
      }
      // Write to burn_state_snapshots — permanent record of post-burn state per burn event
      try{
        const burnEventId = finalEvent.burnEventId;
        console.log(`[BurnMeta] burn_state_snapshots write attempt: burnEventId=${burnEventId} survivorId=${survivorId} hasImage=${!!getTraitImageSource(freshTraits)}`);
        if(burnEventId){
          const snapImg = getTraitImageSource(freshTraits) || null;
          await pgPool.query(
            `INSERT INTO burn_state_snapshots (burn_event_id, token_id, image_data, traits_json)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (burn_event_id, token_id) DO UPDATE SET
               image_data=EXCLUDED.image_data,
               traits_json=EXCLUDED.traits_json`,
            [burnEventId, survivorId, snapImg, JSON.stringify(freshTraits)]
          );
          console.log(`[BurnMeta] Saved burn_state_snapshot for burn_event_id=${burnEventId} token=#${survivorId}`);
        } else {
          console.warn(`[BurnMeta] Skipped burn_state_snapshot for #${survivorId} — burnEventId is null/falsy`);
        }
      }catch(snapErr){
        console.warn(`[BurnMeta] Failed to write burn_state_snapshot for #${survivorId}:`, snapErr.message);
      }
      pendingBurnAlerts.delete(key);
    }catch(e){
      console.error(`[BurnMeta] post failed for #${survivorId}:`, e.message); sendErrorWebhook(`Burn Alert Post Failed #${survivorId}`, e);
      // Keep in queue — retry next tick
    }
  }
}

// Minimal fallback alert — no traits/image — used when metadata never refreshed after 2h
async function postBurnFallbackAlert(finalEvent, startEvent){
  const burnChannels = await getBurnAlertChannels();
  if(!burnChannels.length) return;
  const survivorId  = finalEvent.survivorTokenId;
  const contract    = OCAS_CONTRACT;
  const osUrl       = `https://opensea.io/assets/ethereum/${contract}/${survivorId}`;
  const tvUrl       = `https://traitview.com/?token=${survivorId}`;
  const txHash      = finalEvent.txHash || '';
  const etherscan   = txHash ? `https://etherscan.io/tx/${txHash}` : null;
  const burnedCount = startEvent?.tokenIds?.length || '?';
  const burnerWallet = startEvent?.owner || 'unknown';
  const burnerLink  = burnerWallet !== 'unknown'
    ? `[${shortAddr(burnerWallet)}](https://opensea.io/${burnerWallet})` : 'unknown';
  const color       = burnTypeColor(finalEvent.resultBodyType, finalEvent.resultIsAngel);
  const linkParts   = [`[OpenSea](${osUrl})`, `[TraitView](${tvUrl})`];
  if(etherscan) linkParts.push(`[Etherscan](${etherscan})`);
  const burnKey = finalEvent.burnEventId || `${txHash}:${finalEvent.logIndex}`;

  const embed = new EmbedBuilder()
    .setTitle(`🔥 OCAS Burn • #${survivorId} created`)
    .setColor(color)
    .setURL(osUrl)
    .addFields(
      { name:'Burner',        value:burnerLink,           inline:true },
      { name:'Tokens Burned', value:String(burnedCount),  inline:true },
      { name:'Points Used',   value:`${finalEvent.points || 0} pts`, inline:true },
      { name:'Traits',        value:'_Metadata still syncing — check TraitView or OpenSea_', inline:false },
      { name:'Links',         value:linkParts.join(' | '), inline:false },
    )
    .setFooter({ text:'OCAS Burn Machine' })
    .setTimestamp();

  embed._components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`burn_ids:${burnKey}`)
      .setLabel(`Show Burned Tokens (${burnedCount})`)
      .setStyle(ButtonStyle.Secondary)
  )];

  const dedupeKey = `burn:${txHash}:${finalEvent.logIndex ?? ''}`;
  for(const target of burnChannels){
    const { guildId, channelId, channel } = target;
    try{
      if(!dedupeChannelPost(channelId, dedupeKey)) continue;
      await sendEmbed(channel, embed);
      console.log(`[BurnMeta] fallback alert posted guild=${guildId} channel=${channelId}`);
    }catch(e){ console.warn(`[BurnMeta] fallback post failed guild=${guildId}:`, e.message); }
  }
}

let _pollBurnRunning = false;
let _lastKnownBurnBlock = null;
let _pollTickCount = 0; // write burn_last_block every N ticks
async function pollBurnEvents(){
  if(_pollBurnRunning){ console.log('[Burn] Poll tick skipped — previous still running'); return; }
  _pollBurnRunning = true;
  try{
    // Default RPC — may be overridden below once we know how far behind we are
    let rpcUrl = burnRpcUrl();
    if(!rpcUrl){
      console.warn('[Burn] No RPC configured; set ETH_RPC_URL, ALCHEMY_RPC_URL, or ALCHEMY_API_KEY');
      return;
    }

    try{
      const lastBlockRaw = await dbLoad('burn_last_block');
      let effectiveLastBlockRaw = lastBlockRaw;

      // In-memory cursor always wins if it's ahead of the DB value
      // Prevents DB save failures from rewinding the cursor
      if(_lastKnownBurnBlock !== null){
        const dbVal  = lastBlockRaw ? parseInt(lastBlockRaw, 10) : 0;
        const memVal = _lastKnownBurnBlock;
        if(memVal >= dbVal){
          effectiveLastBlockRaw = String(memVal);
          if(memVal > dbVal + 1)
            console.log('[Burn] In-memory cursor '+memVal+' ahead of DB '+dbVal+' — using memory to prevent rewind');
        }
      }

      const latestRaw = await burnRpc(rpcUrl, 'eth_blockNumber', []);
      const latest = parseInt(latestRaw, 16);
      if(!Number.isFinite(latest)){
        throw new Error(`eth_blockNumber returned non-finite raw=${JSON.stringify(latestRaw)} rpc=${rpcHostForLog(rpcUrl)}`);
      }

      // Recover from poisoned DB state (NaN saved from a previous bad tick)
      if(effectiveLastBlockRaw === 'NaN' || (effectiveLastBlockRaw && !Number.isFinite(parseInt(effectiveLastBlockRaw, 10)))){
        console.warn('[Burn] burn_last_block is invalid ('+effectiveLastBlockRaw+'), resetting to latest-2000');
        const resetBlock = Math.max(0, latest - 2000);
        dbSave('burn_last_block', String(resetBlock)).catch(()=>{});
        _lastKnownBurnBlock = resetBlock;
      }

      const lastBlockClean = (effectiveLastBlockRaw && effectiveLastBlockRaw !== 'NaN' && Number.isFinite(parseInt(effectiveLastBlockRaw, 10))) ? effectiveLastBlockRaw : null;
      let fromBlock = lastBlockClean ? parseInt(lastBlockClean, 10) + 1 : null;
      let historicalBackfill = false;

      if(!fromBlock){
        if(Number.isFinite(BURN_START_BLOCK) && BURN_START_BLOCK >= 0){
          fromBlock = BURN_START_BLOCK;
          historicalBackfill = true;
          console.log(`[Burn] No burn_last_block; starting historical backfill from BURN_START_BLOCK=${fromBlock}`);
        } else {
          fromBlock = Math.max(0, latest - 2000);
          historicalBackfill = true;
          console.warn(`[Burn] BURN_START_BLOCK missing; safe fallback starts at latest-2000 (${fromBlock}). Set BURN_START_BLOCK for full historical backfill.`);
        }
      }

      // blockGapEst always computed here — fromBlock is guaranteed to be set by this point
      const blockGapEst = latest - fromBlock;

      // Auto-switch RPC: use BURN_RPC_OVERRIDE only while >100 blocks behind
      if(process.env.BURN_RPC_OVERRIDE){
        if(blockGapEst > 100){
          rpcUrl = process.env.BURN_RPC_OVERRIDE.startsWith('wss://')
            ? process.env.BURN_RPC_OVERRIDE.replace('wss://','https://')
            : process.env.BURN_RPC_OVERRIDE;
        } else {
          console.log('[Burn] Caught up — BURN_RPC_OVERRIDE ignored, using default RPC');
        }
      }

      if(fromBlock > latest) return;
      console.log(`[Burn] Cursor state last=${effectiveLastBlockRaw || 'none'} from=${fromBlock} latest=${latest} chunk=${BURN_BLOCK_CHUNK} rpc=${rpcHostForLog(rpcUrl)}`);

      // Adaptive chunk: use 5000 with override RPC when catching up, normal otherwise
      const blockGap = latest - fromBlock;
      const effectiveChunk = (process.env.BURN_RPC_OVERRIDE && blockGapEst > 100)
        ? Math.max(1, parseInt(process.env.BURN_BLOCK_CHUNK_OVERRIDE || '5000', 10))
        : BURN_BLOCK_CHUNK;
      const adaptiveChunk = blockGap > 3 ? effectiveChunk : 2;
      const chunkTo = Math.min(latest, fromBlock + adaptiveChunk - 1);
      const shouldAlert = !historicalBackfill || BURN_BACKFILL_ALERTS;

      const logs = await burnRpc(rpcUrl, 'eth_getLogs', [{
        address: BURN_CONTRACT,
        fromBlock: '0x'+fromBlock.toString(16),
        toBlock:   '0x'+chunkTo.toString(16),
        topics: [[TOPIC_BURN_STARTED, TOPIC_BURN_FINALIZED]],
      }]);
      console.log(`[Burn] Polling blocks ${fromBlock}-${chunkTo} (latest=${latest})`);
      if(logs?.length) console.log(`[Burn] ${logs.length} log(s) in blocks ${fromBlock}-${chunkTo}`);
      await processBurnLogs(logs || [], shouldAlert);

      _pollTickCount++;
      // Write cursor to DB every 10 ticks (~5 min) or whenever burns were found
      // Non-blocking save — DB timeout must never stall the tick
      if(_pollTickCount % 10 === 0 || (logs && logs.length > 0)){
        dbSave('burn_last_block', String(chunkTo)).catch(e =>
          console.error('[dbSave] burn_last_block failed:', e.message)
        );
      }
      _lastKnownBurnBlock = chunkTo;

      const lagBlocks = latest - chunkTo;
      if(lagBlocks > 0){
        console.log(`[Burn] Behind by ${lagBlocks} block(s)`);
        if(lagBlocks >= BURN_LAG_ALERT_BLOCKS && Date.now() - _lastLagAlertTs > 10 * 60 * 1000){
          _lastLagAlertTs = Date.now();
          sendErrorWebhook(
            'Burn Poller Lag Alert',
            new Error(`Poller is ${lagBlocks} blocks behind latest block ${latest}`),
            `fromBlock=${fromBlock} chunkTo=${chunkTo} gap=${lagBlocks}`
          );
          console.warn(`[Burn] ⚠️ Lag alert fired — ${lagBlocks} blocks behind`);
        }
      }
    }catch(e){ console.error('[Burn poller]', e.message); sendErrorWebhook('Burn Poller Error', e); }
  } finally { _pollBurnRunning = false; }
}

async function loadBurnStartFromDB(survivorTokenId){
  // Prefer the persisted BurnStarted event so backfills/restarts can still
  // attach burned input IDs to the later BurnFinalized event.
  try{
    const r = await pgPool.query(
      `SELECT bse.owner_wallet, bse.points_used, bse.result_body_type, bse.result_is_angel,
              bse.boost_chance, array_agg(bsi.burned_token_id ORDER BY bsi.burned_token_id) AS token_ids
       FROM burn_started_events bse
       LEFT JOIN burn_started_inputs bsi ON bsi.burn_started_id = bse.id
       WHERE bse.survivor_token_id = $1
       GROUP BY bse.id
       ORDER BY bse.block_number DESC, bse.log_index DESC
       LIMIT 1`,
      [survivorTokenId]
    );
    if(r.rows.length){
      return {
        owner: r.rows[0].owner_wallet,
        tokenIds: (r.rows[0].token_ids||[]).filter(Boolean),
        points: r.rows[0].points_used,
        resultBodyType: r.rows[0].result_body_type,
        resultIsAngel: r.rows[0].result_is_angel,
        boostChance: r.rows[0].boost_chance,
      };
    }
  }catch(e){}
  try{
    const r = await pgPool.query(
      `SELECT be.burner_wallet, array_agg(bei.burned_token_id) AS token_ids
       FROM burn_events be
       LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
       WHERE be.survivor_token_id = $1
       GROUP BY be.burner_wallet LIMIT 1`,
      [survivorTokenId]
    );
    if(r.rows.length) return { owner: r.rows[0].burner_wallet, tokenIds: (r.rows[0].token_ids||[]).filter(Boolean) };
  }catch(e){}
  return null;
}

// ── Discord client ────────────────────────────────────────────────────────────

module.exports = {
  pollBurnEvents, pollBurnEventsLegacy,
  processPendingBurnAlerts,
  buildBurnEmbed, triggerOsMetadataRefresh,
  setClient, resolveDiscordChannel,
  traitDisplayLines, fetchTokenUriFromContract,
  pendingBurns, pendingBurnAlerts, tokenMetaCache,
};
