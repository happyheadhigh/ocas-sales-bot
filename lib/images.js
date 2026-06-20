'use strict';

const { fetchTokenUriFromContract, realTraitCount, traitsArrayFromInput, traitsObjectFromArray, getTraitImageSource } = require('./rpc');

const fetch  = require('node-fetch');
const sharp  = require('sharp');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getCachedImage, setCachedImage, imageCache } = require('./cache');
const { isSvg, isDiscordOk } = require('../utils/format');
const { osHeaders, OCAS_SLUG } = require('./constants');
const { pgPool } = require('./db');

// ── SVG → PNG (OCAS on-chain SVG with embedded PNG + gradient background) ────
async function extractPngFromSvg(svgSource){
  let svgText;
  if(svgSource.startsWith('data:image/svg')){
    const b64=svgSource.split(',')[1]; if(!b64) throw new Error('Empty SVG');
    svgText=Buffer.from(b64,'base64').toString('utf-8');
  } else {
    const r=await fetch(svgSource); if(!r.ok) throw new Error('SVG fetch '+r.status);
    svgText=await r.text();
  }
  const SIZE=500;

  // Render the original SVG directly so pixel-banded backgrounds are preserved
  // exactly as authored — no gradient reconstruction. Previously the background
  // rect bands were discarded and rebuilt as a smooth linearGradient, causing
  // the blurry gradient look vs OpenSea's sharp pixel bands.
  let bgBuf;
  try{
    bgBuf=await sharp(Buffer.from(svgText))
      .resize(SIZE,SIZE,{kernel:'nearest',fit:'fill'})
      .png()
      .toBuffer();
  }catch(e){ throw new Error('SVG render failed: '+e.message); }

  // Extract the embedded character PNG and re-composite at full size with
  // nearest-neighbor upscaling so character pixels stay crisp.
  const pngMatch=svgText.match(/src=["']data:image\/png;base64,([A-Za-z0-9+/=\s]+)["']/);
  if(pngMatch){
    try{
      const rawPng=Buffer.from(pngMatch[1].replace(/\s/g,''),'base64');
      const charBuf=await sharp(rawPng).resize(SIZE,SIZE,{kernel:'nearest'}).png().toBuffer();
      return sharp(bgBuf).composite([{input:charBuf,blend:'over'}]).png().toBuffer();
    }catch(e){ console.warn('[extractPngFromSvg] char composite failed, using full SVG render:',e.message); }
  }

  return bgBuf;
}

// ── Image resolver ────────────────────────────────────────────────────────────
async function resolveImage(nft, contract, chain){
  const id=nft?.identifier||nft?.token_id;
  const key=`${contract}:${id}`;
  if(id&&imageCache.has(key)) return imageCache.get(key);
  const candidates=[nft?.display_image_url,nft?.image_url,nft?.image_preview_url];
  for(const url of candidates){ if(isDiscordOk(url)){ const r={type:'url',url}; if(id) imageCache.set(key,r); return r; } }
  if(id){
    try{
      const chainForImg=chain||'ethereum';
      const _ctrl=new AbortController();
const _timer=setTimeout(()=>_ctrl.abort(),5000);
let r;
try{ r=await fetch(`https://api.opensea.io/api/v2/chain/${chainForImg}/contract/${contract}/nfts/${id}`,{headers:osHeaders(),signal:_ctrl.signal}); }finally{ clearTimeout(_timer); }
      if(r.ok){
        const j=await r.json(); const n=j.nft||j;
        const deep=[n.display_image_url,n.image_url,n.image_preview_url,n.image_thumbnail_url];
        for(const url of deep){ if(isDiscordOk(url)){ const res={type:'url',url}; imageCache.set(key,res); return res; } }
        const svgSrc=deep.find(u=>u&&!u.startsWith('<svg')&&!u.startsWith('data:')&&isSvg(u))||candidates.find(u=>u&&isSvg(u));
        if(svgSrc){ const buf=await extractPngFromSvg(svgSrc); const res={type:'buffer',buffer:buf,filename:`token-${id}.png`}; imageCache.set(key,res); return res; }
      }
    }catch(e){ console.warn('[Image]',id,e.message); }
  }
  return null;
}

// ── Send embed (handles buffer attachment vs URL) ─────────────────────────────
async function sendEmbed(target, embed){
  return target.send(buildEmbedPayload(embed));
}

function buildEmbedPayload(embed){
  const ir=embed._imageResult; delete embed._imageResult;
  const components = embed._components || [];
  delete embed._components;
  if(ir?.type==='buffer'){ const att=new AttachmentBuilder(ir.buffer,{name:ir.filename}); embed.setThumbnail(`attachment://${ir.filename}`); return {embeds:[embed],files:[att],components}; }
  if(ir?.type==='url') embed.setThumbnail(ir.url);
  return {embeds:[embed],components};
}


// ── Token DB metadata helper — OS rank + traits for listing/sale cards ──────
const tokenMetaCache = new Map(); // tokenId → { meta, expires }
async function fetchTokenMetaFromDb(tokenId){
  const id = parseInt(tokenId);
  if(!id) return null;
  const cached = tokenMetaCache.get(id);
  if(cached && Date.now() < cached.expires) return cached.meta;

  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET  = process.env.API_SECRET;
  if(!RAILWAY_URL) return null;

  try{
    const qs = new URLSearchParams({ key: API_SECRET || '' });
    const r = await fetch(`${RAILWAY_URL}/db/token/${id}?${qs}`);
    if(!r.ok) return null;
    const j = await r.json();
    if(!j.ok || !j.token) return null;
    const localMeta = await fetchTokenMetaFromLocalDb(id).catch(()=>null);
    const apiTraits = j.token.traits || null;
    const bestTraits = realTraitCount(localMeta?.traits) > realTraitCount(apiTraits) ? localMeta.traits : apiTraits;
    const meta = {
      os_rank: j.token.os_rank ? parseInt(j.token.os_rank) : null,
      traits:  bestTraits || null,
      trait_count: realTraitCount(bestTraits) || (j.token.trait_count ? parseInt(j.token.trait_count) : null),
    };
    tokenMetaCache.set(id, { meta, expires: Date.now() + 5 * 60 * 1000 });
    return meta;
  }catch(e){
    console.warn('[Token meta]', id, e.message);
    return null;
  }
}

async function fetchTokenMetaFromOpenSea(tokenId){
  const id = parseInt(tokenId);
  if(!id) return null;
  const cacheKey = `os:${id}`;
  const cached = tokenMetaCache.get(cacheKey);
  if(cached && Date.now() < cached.expires) return cached.meta;
  try{
    const r = await fetch(`https://api.opensea.io/api/v2/chain/ethereum/contract/${OCAS_CONTRACT}/nfts/${id}`, { headers: osHeaders() });
    if(!r.ok) return null;
    const j = await r.json();
    const n = j.nft || j;
    const rawTraits = Array.isArray(n.traits) ? n.traits : (Array.isArray(n.attributes) ? n.attributes : []);
    const traits = traitsObjectFromArray(rawTraits, n.image || n.image_url || n.display_image_url || null);
    const meta = {
      os_rank: null,
      traits: realTraitCount(traits) ? traits : null,
      trait_count: realTraitCount(traits) || null,
    };
    tokenMetaCache.set(cacheKey, { meta, expires: Date.now() + 2 * 60 * 1000 });
    return meta;
  }catch(e){
    console.warn('[Token meta OpenSea]', id, e.message);
    return null;
  }
}


async function fetchTokenMetaFromLocalDb(tokenId){
  const id = parseInt(tokenId);
  if(!id) return null;
  try{
    // Prefer snapshot JSON when available because it preserves the full __attributes array.
    const snap = await pgPool.query(
      `SELECT traits_json FROM token_image_snapshots WHERE token_id=$1 AND traits_json IS NOT NULL LIMIT 1`,
      [id]
    ).catch(()=>({ rows:[] }));
    const snapTraits = snap.rows[0]?.traits_json || null;
    if(snapTraits && realTraitCount(snapTraits)){
      return { os_rank:null, traits:snapTraits, trait_count:realTraitCount(snapTraits) };
    }

    let r;
    try{
      r = await pgPool.query(
        `SELECT trait_name, trait_value FROM token_traits WHERE token_id=$1 ORDER BY trait_index ASC, id ASC`,
        [id]
      );
    }catch(_){
      // Backwards compatibility before trait_index column exists.
      r = await pgPool.query(
        `SELECT trait_name, trait_value FROM token_traits WHERE token_id=$1 ORDER BY id ASC`,
        [id]
      );
    }
    if(!r.rows.length) return null;
    const attrs = r.rows
      .filter(row => row.trait_name && row.trait_value != null)
      .map(row => ({ trait_type:String(row.trait_name), value:String(row.trait_value) }));
    const traits = traitsObjectFromArray(attrs);
    return realTraitCount(traits) ? { os_rank:null, traits, trait_count:realTraitCount(traits) } : null;
  }catch(e){
    console.warn('[Token local meta]', id, e.message);
    return null;
  }
}

async function upsertTokenTraitRows(tokenId, traits, source='unknown', collectionSlug=OCAS_SLUG){
  const id = parseInt(tokenId);
  const attrs = traitsArrayFromInput(traits);
  if(!id || !attrs.length) return false;
  try{
    // Scoped by collection_slug so this can never delete/overwrite another
    // collection's trait rows for the same token ID (see migrations/003 —
    // tokens/token_traits aren't globally unique by ID once more than one
    // collection has data here).
    await pgPool.query('DELETE FROM token_traits WHERE token_id=$1 AND collection_slug=$2', [id, collectionSlug]);
    for(let i = 0; i < attrs.length; i++){
      const t = attrs[i];
      await pgPool.query(
        `INSERT INTO token_traits (token_id, trait_name, trait_value, trait_index, collection_slug)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, String(t.trait_type), String(t.value), i, collectionSlug]
      );
    }
    const img = getTraitImageSource(traits);
    if(img){
      // Never overwrite a higher-priority snapshot source with a lower one.
      // Priority order: burn-start-input > backfill-chunks > burn-finalized-survivor
      // This ensures original mint traits (backfill-chunks) are never lost when
      // a token later becomes a burn survivor and gets new post-burn traits written.
      const SOURCE_PRIORITY = { 'burn-start-input': 3, 'backfill-chunks': 2, 'burn-finalized-survivor': 1 };
      const newPriority = SOURCE_PRIORITY[source] || 0;
      const traitsForSnapshot = traitsObjectFromArray(attrs, img);
      await pgPool.query(
        `INSERT INTO token_image_snapshots (token_id, image_data, traits_json, source, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (token_id) DO UPDATE SET
           image_data=EXCLUDED.image_data,
           traits_json=EXCLUDED.traits_json,
           source=EXCLUDED.source,
           updated_at=NOW()
         WHERE (
           CASE WHEN token_image_snapshots.source = 'burn-start-input' THEN 3
                WHEN token_image_snapshots.source = 'backfill-chunks' THEN 2
                WHEN token_image_snapshots.source = 'burn-finalized-survivor' THEN 1
                ELSE 0 END
         ) < $5`,
        [id, String(img), JSON.stringify(traitsForSnapshot), source, newPriority]
      ).catch(()=>{});
    }
    return true;
  }catch(e){
    console.warn(`[Token snapshot] failed for #${id}:`, e.message);
    return false;
  }
}

async function snapshotTokenFromContract(tokenId, source='burn-start'){
  const id = parseInt(tokenId);
  if(!id) return null;
  const traits = await fetchTokenUriFromContract(id).catch(()=>null);
  if(traits && realTraitCount(traits)){
    await upsertTokenTraitRows(id, traits, source);
    return traits;
  }
  return null;
}

async function fetchSnapshotImageForToken(tokenId){
  const id = parseInt(tokenId);
  if(!id) return null;
  try{
    const snap = await pgPool.query('SELECT image_data FROM token_image_snapshots WHERE token_id=$1', [id]);
    let imgSrc = snap.rows[0]?.image_data || null;
    if(!imgSrc){
      const meta = await fetchTokenMetaFromLocalDb(id);
      imgSrc = meta?.traits?.__image || null;
    }
    if(!imgSrc) return null;
    if(imgSrc.startsWith('<svg') || imgSrc.startsWith('data:image/svg') || imgSrc.toLowerCase().includes('image/svg')){
      const buf = await extractPngFromSvg(imgSrc);
      if(buf) return { type:'buffer', buffer:buf, filename:`token-${id}.png` };
    }
    if(imgSrc.startsWith('http') && isDiscordOk(imgSrc)) return { type:'url', url:imgSrc };
  }catch(e){
    console.warn(`[Token snapshot image] #${id}:`, e.message);
  }
  return null;
}

// Normalize raw OCAS Type trait to clean display name.
// "Human 5" → "Human", "Human Trait Booster" → "Human", "Zombie 2" → "Zombie"
function normalizeOcasType(raw){
  if(!raw) return null;
  const s = String(raw).trim();
  const words = s.split(/\s+/).filter(w => !/^(trait|booster|\d+)$/i.test(w));
  return words.join(' ') || s.split(/\s+/)[0] || s;
}

// Returns a compact type breakdown string for a list of burned token IDs.
// Looks up each token's Type trait from token_traits DB.
// Example output: "3 · 3x Human" or "2 · 1x Zombie, 1x Ape"
async function burnTypeBreakdown(tokenIds, burnEventId=null){
  if(!tokenIds || !tokenIds.length) return String(tokenIds?.length || '?');
  try{
    const ids = tokenIds.filter(Boolean).map(Number);
    if(!ids.length) return String(tokenIds.length);

    const typeMap = {};

    // Step 1 (best): burn_state_snapshots from the PREVIOUS burn event for each token.
    // This is the most historically accurate source — it records the post-burn state
    // of a token after each burn, which equals the pre-burn state going into the next burn.
    // For a given burn event, we look for the most recent burn_state_snapshot for each
    // input token that was written BEFORE this burn event.
    if(burnEventId){
      const stateSnap = await pgPool.query(
        `SELECT DISTINCT ON (bss.token_id) bss.token_id, bss.traits_json
         FROM burn_state_snapshots bss
         WHERE bss.token_id = ANY($1)
           AND bss.burn_event_id < $2
         ORDER BY bss.token_id, bss.burn_event_id DESC`,
        [ids, burnEventId]
      );
      for(const row of stateSnap.rows){
        if(!row.traits_json) continue;
        const tj = typeof row.traits_json === 'string' ? JSON.parse(row.traits_json) : row.traits_json;
        const rawType = tj?.Type || tj?.type || null;
        if(rawType) typeMap[row.token_id] = normalizeOcasType(rawType);
      }
    }

    // Step 2: burn-start-input snapshots — for tokens not covered by state snapshots,
    // use the snapshot captured at the moment the token was selected for burning.
    // Note: for re-burned tokens this may be stale (frozen at first burn), so it's
    // only used as fallback when no state snapshot exists.
    const missing0 = ids.filter(id => !typeMap[id]);
    if(missing0.length){
      const snapBurn = await pgPool.query(
        `SELECT token_id, traits_json FROM token_image_snapshots
         WHERE token_id = ANY($1) AND source = 'burn-start-input'`,
        [missing0]
      );
      for(const row of snapBurn.rows){
        if(!row.traits_json) continue;
        const tj = typeof row.traits_json === 'string' ? JSON.parse(row.traits_json) : row.traits_json;
        const rawType = tj?.Type || tj?.type || null;
        if(rawType) typeMap[row.token_id] = normalizeOcasType(rawType);
      }
    }

    // Step 3: backfill-chunks snapshots — original mint traits, correct for tokens
    // that were never snapshotted at burn time (first-time burns, never re-burned).
    const missing1 = ids.filter(id => !typeMap[id]);
    if(missing1.length){
      const snapBackfill = await pgPool.query(
        `SELECT token_id, traits_json FROM token_image_snapshots
         WHERE token_id = ANY($1) AND source = 'backfill-chunks'`,
        [missing1]
      );
      for(const row of snapBackfill.rows){
        if(!row.traits_json) continue;
        const tj = typeof row.traits_json === 'string' ? JSON.parse(row.traits_json) : row.traits_json;
        const rawType = tj?.Type || tj?.type || null;
        if(rawType) typeMap[row.token_id] = normalizeOcasType(rawType);
      }
    }

    // Step 4: token_traits — last resort, may reflect current state after re-burns
    const missing2 = ids.filter(id => !typeMap[id]);
    if(missing2.length){
      const r = await pgPool.query(
        `SELECT token_id, trait_value FROM token_traits
         WHERE token_id = ANY($1) AND LOWER(trait_name) = 'type'`,
        [missing2]
      );
      for(const row of r.rows) typeMap[row.token_id] = normalizeOcasType(row.trait_value);
    }

    const counts = {};
    for(const id of ids){
      const t = typeMap[id] || null;
      if(t) counts[t] = (counts[t] || 0) + 1;
    }

    const known = Object.entries(counts).sort((a,b) => b[1] - a[1]);
    const unknownCount = ids.length - Object.values(counts).reduce((s,n)=>s+n, 0);
    const parts = known.map(([type, n]) => `${n}x ${type}`);
    if(unknownCount > 0) parts.push(`${unknownCount}x ?`);

    const breakdown = parts.join(', ');
    return breakdown ? `${ids.length} · ${breakdown}` : String(ids.length);
  }catch(e){
    return String(tokenIds.length);
  }
}

async function fetchBurnDisplayTraits(tokenId){
  const id = parseInt(tokenId);
  if(!id) return null;
  let traits = await fetchTokenUriFromContract(id).catch(()=>null);
  if(!traits) traits = await fetchFreshOsMeta(id).catch(()=>null);
  if(!traits){
    const local = await fetchTokenMetaFromLocalDb(id).catch(()=>null);
    traits = local?.traits || null;
  }
  if(traits && realTraitCount(traits)){
    const freshMeta = { os_rank:null, traits, trait_count:realTraitCount(traits) };
    tokenMetaCache.set(id, { meta:freshMeta, expires:Date.now() + 5 * 60_000 });
    tokenMetaCache.set(`os:${id}`, { meta:freshMeta, expires:Date.now() + 5 * 60_000 });
  }
  return traits;
}

async function fetchCreatedTokenMeta(tokenId){
  const contractTraits = await fetchTokenUriFromContract(tokenId).catch(()=>null);
  if(contractTraits && realTraitCount(contractTraits)){
    return { os_rank:null, traits:contractTraits, trait_count:realTraitCount(contractTraits) };
  }
  const dbMeta = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
  if(dbMeta?.traits && realTraitCount(dbMeta.traits)) return dbMeta;
  const localMeta = await fetchTokenMetaFromLocalDb(tokenId).catch(()=>null);
  if(localMeta?.traits && realTraitCount(localMeta.traits)) return localMeta;
  const osMeta = await fetchTokenMetaFromOpenSea(tokenId).catch(()=>null);
  return osMeta?.traits ? { ...(dbMeta || {}), ...osMeta } : dbMeta;
}

function traitObjectToArray(traitsObj){
  return traitsArrayFromInput(traitsObj);
}

function osRankBadge(osRank){
  return osRank ? `⬥${Number(osRank).toLocaleString()}` : '';
}

function titleTokenId(tokenId, fallbackName){
  return tokenId ? `#${tokenId}` : (fallbackName || 'Unknown');
}

// ── Build SALE embed ──────────────────────────────────────────────────────────

module.exports = {
  extractPngFromSvg, resolveImage, sendEmbed, buildEmbedPayload,
  snapshotTokenFromContract,
};
