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
const { burnRpcUrl, burnRpc } = require('./rpc');

const PAGE_SIZE = 100;
const DELAY_MS  = 100;

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

async function resolveUri(uri, alchemyKey){
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
        ? `https://eth-mainnet.g.alchemy.com/nft/v3/${alchemyKey}/ipfsGateway/${cid}`
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

async function fetchTokenUriMetadata(contract, tokenId, alchemyKey){
  const rpcUrl = burnRpcUrl();
  if(!rpcUrl) return null;
  try{
    const paddedId = parseInt(tokenId).toString(16).padStart(64, '0');
    const result = await burnRpc(rpcUrl, 'eth_call', [{
      to: contract,
      data: TOKEN_URI_SELECTOR + paddedId,
    }, 'latest']);
    if(!result || result === '0x') return null;
    const uri = decodeAbiString(result);
    if(!uri) return null;
    return await resolveUri(uri, alchemyKey);
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

async function fetchPage(alchemyKey, contract, pageKey, retries = 0){
  const url = new URL(`https://eth-mainnet.g.alchemy.com/nft/v3/${alchemyKey}/getNFTsForContract`);
  url.searchParams.set('contractAddress', contract);
  url.searchParams.set('withMetadata', 'true');
  url.searchParams.set('limit', String(PAGE_SIZE));
  if(pageKey) url.searchParams.set('startToken', pageKey);

  try{
    const r = await fetch(url.toString());
    if(r.status === 429){
      const wait = Math.min(2000 * Math.pow(2, retries), 60000);
      await sleep(wait);
      return fetchPage(alchemyKey, contract, pageKey, Math.min(retries + 1, 5));
    }
    if(!r.ok){
      if(retries < 3){ await sleep(3000 * (retries + 1)); return fetchPage(alchemyKey, contract, pageKey, retries + 1); }
      return { error: `HTTP ${r.status}` };
    }
    const j = await r.json();
    return { nfts: j.nfts || [], pageKey: j.pageKey || null };
  }catch(e){
    if(retries < 3){ await sleep(3000 * (retries + 1)); return fetchPage(alchemyKey, contract, pageKey, retries + 1); }
    return { error: e.message };
  }
}

async function writePage(pgPool, slug, nfts, contract, alchemyKey){
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
      let attrs = Array.isArray(rawAttrs) ? rawAttrs.map(normalizeTraitAttribute).filter(Boolean) : [];

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
        const meta = await fetchTokenUriMetadata(contract, tokenId, alchemyKey);
        if(meta){
          const fallbackAttrs = meta.attributes || meta.traits || meta.properties?.attributes || meta.properties || [];
          if(Array.isArray(fallbackAttrs)){
            attrs = fallbackAttrs.map(normalizeTraitAttribute).filter(Boolean);
          }
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

      if(!attrs.length){
        // No traits but still store image_url if available
        if(imageUrl){
          await client.query(
            `INSERT INTO tokens (id, collection_slug, trait_count, image_url)
             VALUES ($1,$2,0,$3)
             ON CONFLICT (id, collection_slug) DO UPDATE SET image_url=COALESCE($3, tokens.image_url)`,
            [tokenId, slug, imageUrl]
          );
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
        [tokenId, slug, attrs.length, imageUrl]
      );
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

async function backfillCollectionTraits(pgPool, { contract, slug }){
  if(!contract || !slug) throw new Error('contract and slug are required');
  const lcSlug = slug.toLowerCase();
  const lcContract = contract.toLowerCase();
  if(lcSlug === OCAS_SLUG_LOWER || lcContract === OCAS_CONTRACT_LOWER){
    throw new Error('Refusing to run collection backfill against OCAS — already has correct burn-aware trait data.');
  }

  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  if(!ALCHEMY_KEY) throw new Error('Missing ALCHEMY_API_KEY/ALCHEMY_KEY env var');

  console.log(`[backfill] Starting ${slug} (${contract})`);
  const stats = { written: 0, skipped: 0, pages: 0, failed: 0, animated: false };
  let pageKey = null;
  let consecutiveFails = 0;
  let hasMore = true;
  let animationDetected = false;

  while(hasMore){
    const page = await fetchPage(ALCHEMY_KEY, contract, pageKey);
    if(page.error){
      stats.failed++;
      consecutiveFails++;
      if(consecutiveFails >= 3){ await sleep(60000); consecutiveFails = 0; }
      await sleep(DELAY_MS);
      continue;
    }
    consecutiveFails = 0;

    // Detect animation on first page only
    if(!animationDetected && page.nfts?.length){
      animationDetected = detectAnimated(page.nfts);
      stats.animated = animationDetected;
    }

    console.log(`[backfill] ${slug} fetched page ${stats.pages + 1}: ${page.nfts?.length} nfts, nextPageKey=${!!page.pageKey}`);
    const result = await writePage(pgPool, slug, page.nfts, contract, ALCHEMY_KEY);
    stats.written += result.written;
    stats.skipped += result.skipped;
    stats.pages++;
    console.log(`[backfill] ${slug} page ${stats.pages}: written=${result.written} skipped=${result.skipped} hasMore=${!!pageKey}`);

    pageKey = page.pageKey;
    hasMore = !!pageKey;
    if(hasMore) await sleep(DELAY_MS);
  }

  return stats;
}

module.exports = { backfillCollectionTraits };
