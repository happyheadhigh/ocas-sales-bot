'use strict';

// ── Stackers image cache ──────────────────────────────────────────────────────
// Caches resolved image bytes per token, so /download can serve straight from
// our own database instead of doing a live on-chain + IPFS fetch on every
// single request. IPFS gateways (even with fallback across several) are
// inherently less reliable than our own Postgres — this removes that
// dependency from the common case entirely.
//
// Correctness note: Stackers' art can change over time — fusion reassigns
// artwork. This is NOT a "backfill once, trust forever" cache. It's meant
// to be kept fresh by the fusion poller re-caching a token's image the
// moment it detects that token was involved in a fusion (see
// lib/stackers-fusion-poller.js). This module only handles read/write;
// staying fresh is the caller's responsibility.

const { getContracts, STACKERS_SLUG } = require('./stackers');
const { fetchWithGatewayFallback } = require('./ipfs-gateway');

const CACHE_DELAY_MS = 150; // same gentle pacing as the analytics snapshot job, for the same reasons

// Resolves a Stacker's tokenURI -> metadata -> actual image bytes, live, via
// chain + IPFS. Returns the same shape download.js's imageSourceToSvgOrBuffer
// does (a string for SVG content, a Buffer otherwise) so this can be a true
// drop-in replacement at that call site — Stackers has only ever been
// observed using externally-hosted PNG images, but this stays correct if
// that's ever not true for some token. Does not touch the cache table —
// callers decide whether/how to store the result.
async function resolveStackerImageLive(tokenId){
  const { nft } = getContracts();
  const uri = await nft.tokenURI(tokenId);
  const metaRes = await fetchWithGatewayFallback(uri);
  const meta = await metaRes.json();
  const imageSrc = meta.image_data || meta.image || meta.image_url;
  if(!imageSrc) throw new Error(`No image field in metadata for token ${tokenId}`);

  if(imageSrc.startsWith('data:image/svg+xml;base64,')){
    return { data: Buffer.from(imageSrc.split(',')[1], 'base64').toString('utf8'), isSvg: true, contentType: 'image/svg+xml' };
  }
  if(imageSrc.startsWith('data:image/svg+xml;utf8,')){
    return { data: decodeURIComponent(imageSrc.split(',').slice(1).join(',')), isSvg: true, contentType: 'image/svg+xml' };
  }
  if(imageSrc.trim().startsWith('<svg')){
    return { data: imageSrc, isSvg: true, contentType: 'image/svg+xml' };
  }

  const imgRes = await fetchWithGatewayFallback(imageSrc);
  const buffer = await imgRes.buffer();
  const contentType = imgRes.headers.get('content-type') || 'image/png';
  if(contentType.includes('svg') || buffer.toString('utf8',0,20).includes('<svg')){
    return { data: buffer.toString('utf8'), isSvg: true, contentType: 'image/svg+xml' };
  }
  return { data: buffer, isSvg: false, contentType };
}

// Reads whatever's currently cached for a token, or null if nothing's there
// yet. Returns the same {data, isSvg, contentType} shape as the live resolver.
async function getCachedStackerImage(pgPool, tokenId){
  const res = await pgPool.query(
    `SELECT image_data, is_svg, content_type FROM stackers_image_cache WHERE token_id = $1`, [tokenId]
  );
  if(!res.rows.length) return null;
  const row = res.rows[0];
  const data = row.is_svg ? row.image_data.toString('utf8') : row.image_data;
  return { data, isSvg: row.is_svg, contentType: row.content_type };
}

// Resolves live and stores the result — used both for lazy first-time fills
// (from /download when the cache is empty) and for fusion-poller-driven
// refreshes (when a token's art may have just changed).
async function cacheStackerImage(pgPool, tokenId){
  const result = await resolveStackerImageLive(tokenId);
  const bytesToStore = result.isSvg ? Buffer.from(result.data, 'utf8') : result.data;
  await pgPool.query(
    `INSERT INTO stackers_image_cache (token_id, image_data, is_svg, content_type, cached_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (token_id) DO UPDATE SET image_data=$2, is_svg=$3, content_type=$4, cached_at=NOW()`,
    [tokenId, bytesToStore, result.isSvg, result.contentType]
  );
  return result;
}

// Cache-first read: returns the cached image if present, otherwise resolves
// live and caches it for next time before returning. This is what /download
// actually calls.
async function getOrCacheStackerImage(pgPool, tokenId){
  const cached = await getCachedStackerImage(pgPool, tokenId);
  if(cached) return cached;
  return await cacheStackerImage(pgPool, tokenId);
}

// Proactive backfill — iterates every known Stacker token and caches its
// image, so the benefit isn't only realized lazily as people happen to
// request specific tokens. Same gentle-pacing philosophy as the analytics
// snapshot job. Skips tokens already cached, so this is safe to re-run
// (e.g. to pick up newly-minted tokens) without re-fetching everything.
async function backfillStackerImageCache(pgPool){
  const { rows } = await pgPool.query(
    `SELECT id FROM tokens WHERE collection_slug = $1 ORDER BY id`, [STACKERS_SLUG]
  );
  console.log(`[StackersImageCache] Starting backfill for ${rows.length} tokens`);
  let cached = 0, skipped = 0, failed = 0;
  for(const { id: tokenId } of rows){
    try{
      const existing = await getCachedStackerImage(pgPool, tokenId);
      if(existing){ skipped++; continue; }
      await cacheStackerImage(pgPool, tokenId);
      cached++;
    }catch(e){
      failed++;
      if(failed <= 5) console.warn(`[StackersImageCache] Token ${tokenId} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, CACHE_DELAY_MS));
    const done = cached + skipped + failed;
    if(done > 0 && done % 500 === 0){
      console.log(`[StackersImageCache] ${done}/${rows.length} processed so far (${cached} cached, ${skipped} skipped, ${failed} failed)`);
    }
  }
  console.log(`[StackersImageCache] Backfill complete: ${cached} cached, ${skipped} skipped, ${failed} failed`);
  return { total: rows.length, cached, skipped, failed };
}

module.exports = {
  resolveStackerImageLive,
  getCachedStackerImage,
  cacheStackerImage,
  getOrCacheStackerImage,
  backfillStackerImageCache,
};
