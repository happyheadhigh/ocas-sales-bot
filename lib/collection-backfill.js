/**
 * lib/collection-backfill.js
 * ─────────────────────────────────────────────────────────────────
 * Reusable core of the collection trait backfill (originally
 * backfill-collection-traits.js, a CLI-only script). Extracted so the
 * bot can trigger this automatically — see runCollectionBackfill()
 * below — without spawning a child process or duplicating logic.
 *
 * The CLI script (backfill-collection-traits.js) still exists for
 * manual/resumable runs with checkpoint files, debug dumps, and
 * --dry-run — this module intentionally does NOT replace it, it's
 * the shared engine underneath both call sites.
 *
 * Same OCAS guard, same rate-limit strategy, same DB write pattern as
 * the original script — see backfill-collection-traits.js for the
 * full rationale comments on each of those.
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

const fetch = require('node-fetch');
// burnRpc/burnRpcUrl removed — tokenURI now uses Alchemy RPC directly

const PAGE_SIZE = 100;
const DELAY_MS  = 100;
const MAX_CONSECUTIVE_FAILS = 5; // getNFTsForContract failures before giving up and switching to range mode

// ── Supported chains ──────────────────────────────────────────────────────────
// Alchemy subdomain per chain, confirmed directly against Alchemy's own docs
// for each (not guessed) — same discipline as the Stream API field mapping.
// Adding a new EVM chain here is legitimately cheap; adding a non-EVM chain
// (Solana, Tezos, etc.) is NOT — those need an entirely different data model
// (no contract+tokenId+tokenURI concept) and don't belong in this registry.
const SUPPORTED_CHAINS = {
  ethereum:  'eth-mainnet',
  base:      'base-mainnet',
  polygon:   'polygon-mainnet',
  robinhood: 'robinhood-mainnet',
};

// ── tokenURI fallback for collections with missing Alchemy metadata ───────────
// Calls eth_call tokenURI(uint256) on the given contract, fetches the resulting
// URI (IPFS, HTTP, or data:), and extracts attributes + image from the JSON.
// Returns { attrs: [{trait_type, value}], imageUrl: string|null } or null.

const TOKEN_URI_SELECTOR = '0xc87b56dd'; // keccak256("tokenURI(uint256)")[:4]

function decodeAbiString(hex){
  // ABI-encoded string: 32-byte offset + 32-byte length + utf8 bytes
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if(data.length < 128) return null;
  const byteLen = parseInt(data.slice(64, 128), 16);
  if(!byteLen) return null;
  return Buffer.from(data.slice(128, 128 + byteLen * 2), 'hex').toString('utf-8');
}

async function resolveUri(uri, alchemyKey, alchemySubdomain){
  if(!uri) return null;
  try{
    // data URI — decode inline
    if(uri.startsWith('data:application/json;base64,')){
      return JSON.parse(Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf-8'));
    }
    if(uri.startsWith('data:application/json,')){
      return JSON.parse(decodeURIComponent(uri.slice('data:application/json,'.length)));
    }
    // IPFS — use Alchemy's gateway if we have a key, else public gateway
    if(uri.startsWith('ipfs://')){
      const cid = uri.slice(7);
      const gateway = alchemyKey
        ? `https://${alchemySubdomain}.g.alchemy.com/nft/v3/${alchemyKey}/ipfsGateway/${cid}`
        : `https://ipfs.io/ipfs/${cid}`;
      uri = gateway;
    }
    const r = await fetch(uri, { timeout: 10000 });
    if(!r.ok) return null;
    return await r.json();
  }catch(_){
    return null;
  }
}

async function fetchTokenUriMetadata(contract, tokenId, alchemyKey, alchemySubdomain){
  if(!alchemyKey) return null;
  try{
    const paddedId = parseInt(tokenId).toString(16).padStart(64, '0');
    const rpcUrl = `https://${alchemySubdomain}.g.alchemy.com/v2/${alchemyKey}`;
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: contract, data: TOKEN_URI_SELECTOR + paddedId }, 'latest']
      })
    });
    if(!r.ok){
      if(tokenId <= 5) console.warn(`[backfill] token ${tokenId} eth_call HTTP ${r.status} on ${alchemySubdomain}`);
      return null;
    }
    const j = await r.json();
    // JSON-RPC errors often come back with HTTP 200 but an error field
    // instead of result — the old code silently treated this identically to
    // "no result", with zero visibility into the actual rejection reason.
    if(j.error){
      if(tokenId <= 5) console.warn(`[backfill] token ${tokenId} eth_call RPC error on ${alchemySubdomain}: ${JSON.stringify(j.error)}`);
      return null;
    }
    const result = j.result;
    if(!result || result === '0x'){
      if(tokenId <= 5) console.warn(`[backfill] token ${tokenId} eth_call returned empty result on ${alchemySubdomain} (contract may not implement tokenURI, or token doesn't exist)`);
      return null;
    }
    const uri = decodeAbiString(result);
    if(!uri){
      if(tokenId <= 5) console.warn(`[backfill] token ${tokenId} eth_call result could not be decoded as a string: ${result.slice(0, 100)}`);
      return null;
    }
    if(tokenId <= 5) console.log(`[backfill] token ${tokenId} tokenURI resolved: ${uri.slice(0, 120)}`);
    const resolved = await resolveUri(uri, alchemyKey, alchemySubdomain);
    if(tokenId <= 5) console.log(`[backfill] token ${tokenId} resolveUri result: ${resolved ? JSON.stringify(resolved).slice(0, 300) : 'null'}`);
    return resolved;
  }catch(e){
    console.warn(`[backfill] tokenURI eth_call failed for ${contract}#${tokenId}:`, e.message);
    return null;
  }
}

const OCAS_SLUG_LOWER     = 'on-chain-all-stars';
const OCAS_CONTRACT_LOWER = '0x078be86f3104a32313a47815792230a3808642cc';

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function normalizeTraitAttribute(t){
  if(!t || typeof t !== 'object') return null;
  const trait_type = t.trait_type || t.traitType || t.type || t.name;
  const value = t.value;
  if(!trait_type || value == null) return null;
  return { trait_type: String(trait_type), value: String(value) };
}

// Handles two shapes: the standard array ([{trait_type, value}]) that
// almost every collection uses, and an object keyed by trait category
// ({category: value} or {category: {value, state, ...}}) — seen on
// OnChainHoodies' own API, which returns traits this second way. This is a
// best-evidence guess at the raw on-chain tokenURI shape based on that API's
// response (not independently confirmed against the raw tokenURI directly,
// since that's not reachable from where this was written) — worth
// double-checking against real results once this actually runs.
function extractTraits(rawAttrs){
  if(Array.isArray(rawAttrs)){
    return rawAttrs.map(normalizeTraitAttribute).filter(Boolean);
  }
  if(rawAttrs && typeof rawAttrs === 'object'){
    const out = [];
    for(const [category, val] of Object.entries(rawAttrs)){
      if(val == null) continue;
      if(typeof val === 'object'){
        // {category: {value: "...", state: "present"/"absent", ...}}
        if(val.state && String(val.state).toLowerCase() === 'absent') continue;
        if(val.value != null) out.push({ trait_type: String(category), value: String(val.value) });
      } else {
        // {category: "value"}
        out.push({ trait_type: String(category), value: String(val) });
      }
    }
    return out;
  }
  return [];
}

async function fetchPage(alchemyKey, contract, pageKey, alchemySubdomain, retries = 0){
  const url = new URL(`https://${alchemySubdomain}.g.alchemy.com/nft/v3/${alchemyKey}/getNFTsForContract`);
  url.searchParams.set('contractAddress', contract);
  url.searchParams.set('withMetadata', 'true');
  url.searchParams.set('limit', String(PAGE_SIZE));
  if(pageKey) url.searchParams.set('startToken', pageKey);

  try{
    const r = await fetch(url.toString(), { timeout: 15000 });
    if(r.status === 429){
      const wait = Math.min(2000 * Math.pow(2, retries), 60000);
      await sleep(wait);
      return fetchPage(alchemyKey, contract, pageKey, alchemySubdomain, Math.min(retries + 1, 5));
    }
    if(!r.ok){
      if(retries < 3){ await sleep(3000 * (retries + 1)); return fetchPage(alchemyKey, contract, pageKey, alchemySubdomain, retries + 1); }
      return { error: `HTTP ${r.status}` };
    }
    const j = await r.json();
    return { nfts: j.nfts || [], pageKey: j.pageKey || null, totalCount: j.totalCount || null };
  }catch(e){
    if(retries < 3){ await sleep(3000 * (retries + 1)); return fetchPage(alchemyKey, contract, pageKey, alchemySubdomain, retries + 1); }
    return { error: e.message };
  }
}

// Fallback: fetch a single token via tokenURI when Alchemy pagination is broken
async function fetchTokensByRange(alchemyKey, contract, startId, count, alchemySubdomain){
  const nfts = [];
  for(let i = startId; i < startId + count; i++){
    try{
      const url = new URL(`https://${alchemySubdomain}.g.alchemy.com/nft/v3/${alchemyKey}/getNFTMetadata`);
      url.searchParams.set('contractAddress', contract);
      url.searchParams.set('tokenId', String(i));
      url.searchParams.set('refreshCache', 'false');
      const r = await fetch(url.toString(), { timeout: 15000 });
      if(r.ok){
        const j = await r.json();
        nfts.push(j);
      }
    }catch(e){
      console.warn(`[backfill] fetchTokensByRange failed for token ${i}:`, e.message);
    }
    await sleep(50);
  }
  return nfts;
}

async function writePage(pgPool, slug, nfts, contract, alchemyKey, alchemySubdomain){
  if(!nfts.length) return { written: 0, skipped: 0 };
  const client = await pgPool.connect();
  let written = 0, skipped = 0;
  try{
    await client.query('BEGIN');
    for(const nft of nfts){
      const tokenId = parseInt(nft.tokenId);
      if(!tokenId && tokenId !== 0){ skipped++; continue; }
      let rawAttrs = nft.raw?.metadata?.attributes
        || nft.raw?.metadata?.traits
        || nft.contract?.openSeaMetadata?.attributes
        || nft.raw?.metadata?.properties?.attributes
        || nft.raw?.metadata?.properties;
      let attrs = extractTraits(rawAttrs);

      // Extract image URL — prefer display_image_url (animated for collections like Portraits)
      // then cachedUrl (CDN), then originalUrl — store even if no traits
      let imageUrl = nft.display_image_url || nft.image?.cachedUrl || nft.image?.originalUrl || nft.image?.thumbnailUrl || null;

      // ── tokenURI fallback ──────────────────────────────────────────────────
      // Alchemy returns {} raw metadata for some collections (e.g. Fluxeto).
      // If we got no traits and have a contract address, fetch directly from
      // the on-chain tokenURI and extract attributes + image from that JSON.
      if(!attrs.length && contract){
        if(tokenId <= 5){
          console.log(`[backfill] token ${tokenId} Alchemy raw empty, falling back to tokenURI`);
        }
        const meta = await fetchTokenUriMetadata(contract, tokenId, alchemyKey, alchemySubdomain);
        if(meta){
          const fallbackAttrs = meta.attributes || meta.traits || meta.properties?.attributes || meta.properties || [];
          attrs = extractTraits(fallbackAttrs);
          // Prefer Alchemy image if already set, otherwise use tokenURI image
          if(!imageUrl){
            imageUrl = meta.image || meta.image_url || meta.image_data || null;
            // Resolve IPFS URIs in image field
            if(imageUrl && imageUrl.startsWith('ipfs://')){
              imageUrl = `https://ipfs.io/ipfs/${imageUrl.slice(7)}`;
            }
          }
        }
      }

      // Detect SVG image — store in token_svg_cache, not in tokens.image_url
      const isSvgImage = imageUrl && (
        imageUrl.startsWith('<svg') ||
        imageUrl.startsWith('data:image/svg') ||
        imageUrl.includes('image/svg')
      );
      const discordImageUrl = isSvgImage ? null : imageUrl;

      if(!attrs.length){
        // No traits but still store image_url if available
        if(discordImageUrl){
          await client.query(
            `INSERT INTO tokens (id, collection_slug, trait_count, image_url)
             VALUES ($1,$2,0,$3)
             ON CONFLICT (id, collection_slug) DO UPDATE SET image_url=COALESCE($3, tokens.image_url)`,
            [tokenId, slug, discordImageUrl]
          );
        }
        // Store SVG data for on-chain SVG collections (non-OCAS)
        if(isSvgImage && slug !== 'on-chain-all-stars'){
          await client.query(
            `INSERT INTO token_svg_cache (token_id, collection_slug, image_data)
             VALUES ($1,$2,$3)
             ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=$3`,
            [tokenId, slug, imageUrl]
          ).catch(e => console.warn(`[backfill] token_svg_cache insert failed for ${slug}#${tokenId}: ${e.message}`));
        }
        skipped++; continue;
      }

      await client.query('DELETE FROM token_traits WHERE token_id=$1 AND collection_slug=$2', [tokenId, slug]);
      for(let i = 0; i < attrs.length; i++){
        const t = attrs[i];
        await client.query(
          `INSERT INTO token_traits (token_id, trait_name, trait_value, trait_index, collection_slug)
           VALUES ($1,$2,$3,$4,$5)`,
          [tokenId, t.trait_type, t.value, i, slug]
        );
      }
      await client.query(
        `INSERT INTO tokens (id, collection_slug, trait_count, image_url)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id, collection_slug) DO UPDATE SET trait_count=$3, image_url=COALESCE($4, tokens.image_url)`,
        [tokenId, slug, attrs.length, discordImageUrl]
      );
      // Store SVG data for on-chain SVG collections (non-OCAS)
      if(isSvgImage && slug !== 'on-chain-all-stars'){
        await client.query(
          `INSERT INTO token_svg_cache (token_id, collection_slug, image_data)
           VALUES ($1,$2,$3)
           ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=$3`,
          [tokenId, slug, imageUrl]
        ).catch(e => console.warn(`[backfill] token_svg_cache insert failed for ${slug}#${tokenId}: ${e.message}`));
      }
      written++;
    }
    await client.query('COMMIT');
  }catch(e){
    await client.query('ROLLBACK');
    throw e;
  }finally{
    client.release();
  }
  return { written, skipped };
}

/**
 * Runs a full collection trait backfill against an already-open pg pool.
 * Returns a stats object on success; throws on hard failure (caller
 * decides how to handle/log — see runCollectionBackfill for the
 * bot-facing wrapper with status tracking).
 *
 * Refuses to run against OCAS under any circumstances — same guard as
 * the CLI script, no override flag exists here since this is meant to
 * be called automatically/unattended, unlike the CLI's manual override.
 */
// Detect if a collection uses animated images by comparing display_image_url vs image_url
// on the first NFT. If they differ and display_image_url looks animated, return true.
function detectAnimated(nfts){
  if(!nfts?.length) return false;
  const nft = nfts[0];
  const displayUrl = nft.display_image_url || '';
  const staticUrl  = nft.image?.cachedUrl || nft.image?.originalUrl || '';
  if(!displayUrl) return false;
  // Different URLs = OpenSea is serving a different (likely animated) version
  if(displayUrl !== staticUrl){
    // Confirm it looks like an animated format
    const lower = displayUrl.toLowerCase();
    if(lower.includes('.gif') || lower.includes('.mp4') || lower.includes('video') || lower.includes('animation')){
      return true;
    }
    // display_image_url exists and differs — likely animated even without explicit extension
    return true;
  }
  return false;
}

async function backfillCollectionTraits(pgPool, { contract, slug, chain = 'ethereum', totalSupply = null }){
  if(!contract || !slug) throw new Error('contract and slug are required');
  const lcSlug = slug.toLowerCase();
  const lcContract = contract.toLowerCase();
  if(lcSlug === OCAS_SLUG_LOWER || lcContract === OCAS_CONTRACT_LOWER){
    throw new Error('Refusing to run collection backfill against OCAS — already has correct burn-aware trait data.');
  }

  const alchemySubdomain = SUPPORTED_CHAINS[chain];
  if(!alchemySubdomain){
    throw new Error(`Unsupported chain "${chain}" — currently supported: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`);
  }

  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  if(!ALCHEMY_KEY) throw new Error('Missing ALCHEMY_API_KEY/ALCHEMY_KEY env var');

  console.log(`[backfill] Starting ${slug} (${contract}) on ${chain} (${alchemySubdomain})`);
  const stats = { written: 0, skipped: 0, pages: 0, failed: 0, animated: false };
  let pageKey = null;
  let consecutiveFails = 0;
  let hasMore = true;
  let animationDetected = false;
  let paginationBroken = false;
  let rpcOnlyMode = false;
  const rpcOnlyCeiling = totalSupply ? totalSupply + 10 : 20000; // small buffer past known supply; generous fixed ceiling if supply wasn't provided
  let rangeStart = 0;
  let totalFetched = 0;

  while(hasMore){
    let page;

    if(rpcOnlyMode){
      // No Alchemy NFT-API call at all here — just enumerate token IDs and
      // let writePage's existing tokenURI/eth_call fallback do the actual
      // fetching per token, below.
      const batch = [];
      for(let i = rangeStart; i < rangeStart + PAGE_SIZE && i < rpcOnlyCeiling; i++) batch.push({ tokenId: i });
      if(!batch.length){ hasMore = false; break; }
      page = { nfts: batch, pageKey: null };
      rangeStart += PAGE_SIZE;
      if(rangeStart >= rpcOnlyCeiling) hasMore = false;
    } else if(paginationBroken){
      // Alchemy pagination broken for this contract — fetch by token ID range
      const batchNfts = await fetchTokensByRange(ALCHEMY_KEY, contract, rangeStart, PAGE_SIZE, alchemySubdomain);
      if(!batchNfts.length){ hasMore = false; break; }
      page = { nfts: batchNfts, pageKey: null };
      rangeStart += PAGE_SIZE;
      if(batchNfts.length < PAGE_SIZE) hasMore = false;
    } else {
      page = await fetchPage(ALCHEMY_KEY, contract, pageKey, alchemySubdomain);
      if(page.error){
        stats.failed++;
        consecutiveFails++;
        console.warn(`[backfill] ${slug} getNFTsForContract failed (${consecutiveFails} consecutive): ${page.error}`);
        if(consecutiveFails >= MAX_CONSECUTIVE_FAILS){
          // getNFTsForContract isn't working for this contract/chain at all —
          // likely not indexed yet (seen on brand-new chains). Switch to pure
          // RPC mode: bare {tokenId} stubs straight into writePage, which
          // already falls back to a raw eth_call tokenURI() read per token
          // whenever attrs come back empty (built for the Fluxeto gap case).
          // Deliberately NOT falling back to fetchTokensByRange/getNFTMetadata
          // here — that's the same Alchemy NFT-API indexing layer as
          // getNFTsForContract and would likely fail for the identical
          // reason, just slower (one call per token instead of paginated).
          console.warn(`[backfill] ${slug} getNFTsForContract failed ${consecutiveFails} times in a row on ${alchemySubdomain} — switching to RPC-only mode (raw tokenURI via eth_call, bypassing Alchemy's NFT API indexing entirely) instead of retrying indefinitely.`);
          rpcOnlyMode = true;
          rangeStart = 0; // no page has succeeded yet via the normal path
          hasMore = true;
          consecutiveFails = 0;
          continue;
        }
        await sleep(DELAY_MS);
        continue;
      }
      consecutiveFails = 0;
    }

    // Detect animation on first page only
    if(!animationDetected && page.nfts?.length){
      animationDetected = detectAnimated(page.nfts);
      stats.animated = animationDetected;
    }

    totalFetched += page.nfts?.length || 0;
    console.log(`[backfill] ${slug} fetched page ${stats.pages + 1}: ${page.nfts?.length} nfts, nextPageKey=${!!page.pageKey}${rpcOnlyMode ? ' (rpc-only mode)' : paginationBroken ? ' (range mode)' : ''}`);

    // Detect broken Alchemy pagination: full page returned but no continuation key
    if(!rpcOnlyMode && !paginationBroken && !page.pageKey && page.nfts?.length === PAGE_SIZE){
      const totalCount = page.totalCount;
      if(!totalCount || totalCount > totalFetched){
        console.warn(`[backfill] ${slug} Alchemy pagination broken (no pageKey after full page, totalCount=${totalCount}). Switching to token ID range mode.`);
        paginationBroken = true;
        rangeStart = PAGE_SIZE; // page 1 (tokens 0-99) already fetched
        hasMore = true;
      }
    }

    let result;
    try{
      result = await writePage(pgPool, slug, page.nfts, contract, ALCHEMY_KEY, alchemySubdomain);
    }catch(pageErr){
      console.error(`[backfill] ${slug} page ${stats.pages + 1} error: ${pageErr.message}`);
      stats.failed++;
      if(!paginationBroken && !rpcOnlyMode){ pageKey = page.pageKey; hasMore = !!pageKey; }
      if(hasMore) await sleep(DELAY_MS);
      continue;
    }
    stats.written += result.written;
    stats.skipped += result.skipped;
    stats.pages++;
    console.log(`[backfill] ${slug} page ${stats.pages}: written=${result.written} skipped=${result.skipped} hasMore=${hasMore}`);

    if(!paginationBroken && !rpcOnlyMode){
      pageKey = page.pageKey;
      hasMore = !!pageKey;
    }
    if(hasMore) await sleep(DELAY_MS);
  }

  return stats;
}

module.exports = { backfillCollectionTraits, SUPPORTED_CHAINS };
