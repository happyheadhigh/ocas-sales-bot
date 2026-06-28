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

const PAGE_SIZE = 100;
const DELAY_MS  = 300;

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

async function writePage(pgPool, slug, nfts){
  if(!nfts.length) return { written: 0, skipped: 0 };
  const client = await pgPool.connect();
  let written = 0, skipped = 0;
  try{
    await client.query('BEGIN');
    for(const nft of nfts){
      const tokenId = parseInt(nft.tokenId);
      if(!tokenId && tokenId !== 0){ skipped++; continue; }
      const rawAttrs = nft.raw?.metadata?.attributes;
      const attrs = Array.isArray(rawAttrs) ? rawAttrs.map(normalizeTraitAttribute).filter(Boolean) : [];

      // Extract image URL — prefer display_image_url (animated for collections like Portraits)
      // then cachedUrl (CDN), then originalUrl — store even if no traits
      const imageUrl = nft.display_image_url || nft.image?.cachedUrl || nft.image?.originalUrl || nft.image?.thumbnailUrl || null;

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
    const result = await writePage(pgPool, slug, page.nfts);
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
