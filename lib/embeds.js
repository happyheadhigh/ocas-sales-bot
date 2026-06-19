'use strict';

const { EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { COLORS, OCAS_CONTRACT, osHeaders, getRankTierColor, getRailwayApiUrl } = require('./constants');
const { pgPool } = require('./db');
const { shortAddr, formatEth, formatListingEth, timeSince } = require('../utils/format');
const { resolveImage, extractPngFromSvg } = require('./images');
const { realTraitCount, traitsObjectFromArray, traitsArrayFromInput, fetchTokenUriFromContract , getTraitImageSource } = require('./rpc');
const { isDiscordOk } = require('../utils/format');

function traitDisplayLines(traits, limit=14){
  const clean = (traitsArrayFromInput(traits) || []).slice(0, limit);
  return clean.map(t => {
    const label = String(t.trait_type || '').replace(/\d+$/, '').trim() || String(t.trait_type || '');
    return `**${label}:** ${t.value}`;
  });
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

async function upsertTokenTraitRows(tokenId, traits, source='unknown'){
  const id = parseInt(tokenId);
  const attrs = traitsArrayFromInput(traits);
  if(!id || !attrs.length) return false;
  try{
    await pgPool.query('DELETE FROM token_traits WHERE token_id=$1', [id]);
    for(let i = 0; i < attrs.length; i++){
      const t = attrs[i];
      await pgPool.query(
        `INSERT INTO token_traits (token_id, trait_name, trait_value, trait_index)
         VALUES ($1, $2, $3, $4)`,
        [id, String(t.trait_type), String(t.value), i]
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
        const isAngelToken = tj?.Angel === 'yes' || tj?.angel === 'yes' || tj?.Angel === true || tj?.angel === true;
        if(rawType) typeMap[row.token_id] = isAngelToken ? 'Angel' : normalizeOcasType(rawType);
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
        const isAngelToken = tj?.Angel === 'yes' || tj?.angel === 'yes' || tj?.Angel === true || tj?.angel === true;
        if(rawType) typeMap[row.token_id] = isAngelToken ? 'Angel' : normalizeOcasType(rawType);
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
        const isAngelToken = tj?.Angel === 'yes' || tj?.angel === 'yes' || tj?.Angel === true || tj?.angel === true;
        if(rawType) typeMap[row.token_id] = isAngelToken ? 'Angel' : normalizeOcasType(rawType);
      }
    }

    // Step 4: token_traits — last resort, may reflect current state after re-burns
    const missing2 = ids.filter(id => !typeMap[id]);
    if(missing2.length){
      const r = await pgPool.query(
        `SELECT token_id, LOWER(trait_name) AS tname, trait_value FROM token_traits
         WHERE token_id = ANY($1) AND LOWER(trait_name) IN ('type', 'angel')`,
        [missing2]
      );
      // Build per-token {type, angel} map first
      const step4 = {};
      for(const row of r.rows){
        if(!step4[row.token_id]) step4[row.token_id] = {};
        if(row.tname === 'type') step4[row.token_id].type = row.trait_value;
        if(row.tname === 'angel') step4[row.token_id].angel = row.trait_value;
      }
      for(const [tokenId, data] of Object.entries(step4)){
        if(!data.type) continue;
        const isAngelToken = data.angel === 'yes' || data.angel === true;
        typeMap[tokenId] = isAngelToken ? 'Angel' : normalizeOcasType(data.type);
      }
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
async function buildSaleEmbed(sale, config){
  const id=sale.nft?.identifier;
  const name=sale.nft?.name||`#${id}`;
  const eth=formatEth(sale);
  const contract=config.contract||'';
  const slug=config.slug||'';
  const chain=config.chain||'ethereum';
  const osUrl=contract?`https://opensea.io/assets/${chain}/${contract}/${id}`:`https://opensea.io/assets/${chain}/${id}`;
  const tvUrl=`https://traitview.com/?jump=${id}`;
  const timeStr=sale.event_timestamp?timeSince(sale.event_timestamp):'';
  const buyerLink=sale.buyer&&sale.buyer!=='unknown'?`[${shortAddr(sale.buyer)}](https://opensea.io/${sale.buyer})`:'unknown';
  const sellerLink=sale.seller&&sale.seller!=='unknown'?`[${shortAddr(sale.seller)}](https://opensea.io/${sale.seller})`:'unknown';

  // Detect ETH vs WETH and sale type
  const paymentToken = sale.payment?.symbol || '';
  const paymentAddr  = (sale.payment?.token_address||'').toLowerCase();
  const WETH_ADDR    = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const isWeth       = paymentAddr === WETH_ADDR || paymentToken.toLowerCase() === 'weth';
  const currencySymbol = isWeth ? 'WETH' : 'ETH';

  const isOcasSale = (config.contract||'').toLowerCase() === '0x078be86f3104a32313a47815792230a3808642cc';
  const dbMeta = (id && isOcasSale) ? await fetchTokenMetaFromDb(id) : null;
  const osRank = dbMeta?.os_rank || sale.nft?.os_rank || null;
  const rankPart = osRankBadge(osRank);
  const sweepPrefix = sale._isSweep ? '🧹 ' : '';
  const tokenLabel = titleTokenId(id, name);
  const embedTitle = `${sweepPrefix}${eth ? eth+' '+currencySymbol : '--'} • ${tokenLabel}${rankPart ? ' '+rankPart : ''} • Sold`;

  const footerBits = ['Sales Bot', slug];
  if(timeStr) footerBits.push(timeStr);

  // Sale color = payment type only. Rank is visible in the title (⬥) and
  // does not affect sidebar color — that would confuse ETH vs WETH signal.
  const saleColor = isWeth ? COLORS.WETH_ROSE : COLORS.OCAS_GREEN;

  const embed=new EmbedBuilder()
    .setTitle(embedTitle)
    .setColor(saleColor)
    .setURL(osUrl)
    .setFooter({text:footerBits.filter(Boolean).join(' • ')})
    .setTimestamp();

  embed._imageResult=await resolveImage(sale.nft,contract,config.chain||'ethereum');

  // Buyer + Seller on same row, then Traits stacked underneath.
  embed.addFields(
    {name:'Buyer',  value:buyerLink,  inline:true},
    {name:'Seller', value:sellerLink, inline:true},
    {name:'​',   value:'​',        inline:true},
  );
  let traits=sale.nft?.traits||[];
  if((!traits || traits.length===0) && dbMeta?.traits) traits = traitObjectToArray(dbMeta.traits);
  if(traits.length>0){
    const traitLines = traitDisplayLines(traits, 12);
    const half = Math.ceil(traitLines.length/2);
    const col1 = traitLines.slice(0,half).join('\n');
    const col2 = traitLines.slice(half).join('\n');
    embed.addFields(
      {name:'Traits', value:col1, inline:true},
      {name:'​',  value:col2||'​', inline:true},
    );
  }
  embed.addFields({name:'Links',value:`[OpenSea](${osUrl}) • [TraitView](${tvUrl})`,inline:false});
  return embed;
}

// ── Build LISTING embed ───────────────────────────────────────────────────────
// OpenSea listing events (event_type:"order") real structure from debug:
//   listing.asset        → NFT data (token_id, name, image_url, traits)
//   listing.payment      → { quantity (wei), decimals, symbol }
//   listing.maker        → seller address (string)
//   listing.criteria     → trait filter if collection offer
async function buildListingEmbed(listing, config){
  // OpenSea listing event structure (confirmed via /debuglisting):
  //   asset = null for some collections (OCAS)
  //   criteria.encoded_token_ids = token ID when asset is null
  //   criteria.contract.address = contract address
  //   payment.quantity = price in wei
  //   maker = seller address string
  const asset      = listing.asset || {};
  const criteria   = listing.criteria || {};
  const eth        = formatListingEth(listing);
  const slug       = config.slug || '';
  const chain      = config.chain || 'ethereum';

  // Token ID: from asset first, then criteria
  const id = String(
    asset.token_id ||
    asset.identifier ||
    criteria.encoded_token_ids ||
    listing.token_id ||
    listing.identifier ||
    ''
  );

  // Contract: from config first, then asset, then criteria
  const contract = config.contract ||
    (asset.asset_contract && asset.asset_contract.address) ||
    (criteria.contract && criteria.contract.address) ||
    '0x078be86f3104a32313a47815792230a3808642cc';

  const osUrl  = (contract && id) ? 'https://opensea.io/assets/'+chain+'/'+contract+'/'+id : 'https://opensea.io/collection/'+slug;
  const tvUrl  = id ? 'https://traitview.com/?jump='+id : '';

  const sellerAddr = (typeof listing.maker === 'string' ? listing.maker : (listing.maker && listing.maker.address)) || listing.seller || '';
  const sellerLink = sellerAddr ? '['+shortAddr(sellerAddr)+'](https://opensea.io/'+sellerAddr+')' : 'unknown';

  // Only fetch local DB metadata for OCAS — other collections don't have local trait data
  const isOcasContract = contract?.toLowerCase() === '0x078be86f3104a32313a47815792230a3808642cc';
  const dbMeta = listing._dbToken || (id && isOcasContract ? await fetchTokenMetaFromDb(id) : null);
  const osRank = dbMeta?.os_rank || listing.os_rank || asset.os_rank || null;
  const rankPart = osRankBadge(osRank);
  const tokenLabel = titleTokenId(id, asset.name);
  const embedTitle = `${eth ? eth+' ETH' : '--'} • ${tokenLabel}${rankPart ? ' '+rankPart : ''} • Listed`;

  const footerBits = ['Listings Bot', slug];
  if(config._rankAlert) footerBits.push('Rank Alert');

  // Listing color: rank tier first, then OpenSea blue
  const rankTierColor = getRankTierColor(osRank);
  const listingColor = rankTierColor ?? COLORS.OPENSEA_BLUE;

  const embed = new EmbedBuilder()
    .setTitle(embedTitle)
    .setColor(listingColor)
    .setURL(osUrl)
    .setFooter({text:footerBits.filter(Boolean).join(' • ')})
    .setTimestamp();

  // resolveImage fetches from OpenSea NFT endpoint using the token ID
  // This handles the case where asset is null - it goes direct to the NFT endpoint
  const nftLike = {
    identifier:        id,
    image_url:         asset.image_url || null,
    display_image_url: asset.display_image_url || null,
    image_preview_url: asset.image_preview_url || null,
  };
  embed._imageResult = id ? await resolveImage(nftLike, contract, chain) : null;

  // Seller + Buy Now on same row, then Traits stacked underneath like sale cards.
  embed.addFields(
    {name:'Seller',  value: sellerLink,             inline:true},
    {name:'Buy Now', value: '[OpenSea]('+osUrl+')', inline:true},
    {name:'​',  value:'​', inline:true},
  );

  let traits = asset.traits || [];
  if((!traits || traits.length === 0) && dbMeta?.traits) traits = traitObjectToArray(dbMeta.traits);
  if(traits.length > 0){
    const traitLines = traitDisplayLines(traits, 12);
    const half = Math.ceil(traitLines.length/2);
    const col1 = traitLines.slice(0,half).join('\n');
    const col2 = traitLines.slice(half).join('\n');
    embed.addFields(
      {name:'Traits', value:col1, inline:true},
      {name:'​', value:col2||'​', inline:true},
    );
  }

  const linkParts = ['[OpenSea]('+osUrl+')'];
  if(tvUrl) linkParts.push('[TraitView]('+tvUrl+')');
  embed.addFields({name:'Links', value:linkParts.join(' • '), inline:false});
  return embed;
}

// ── Command search helpers ───────────────────────────────────────────────────

module.exports = {
  fetchTokenMetaFromDb, upsertTokenTraitRows, buildSaleEmbed, buildListingEmbed,
  traitObjectToArray, burnTypeBreakdown, fetchBurnDisplayTraits, fetchSnapshotImageForToken,
  osRankBadge, titleTokenId,
};


