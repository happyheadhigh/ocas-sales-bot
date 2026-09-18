/**
 * TraitView API Server
 * Runs as its own separate Railway service (NOT in the same container as
 * the Discord bot — confirmed via deploy logs showing this process never
 * starts when only the bot service is redeployed). Connects to Railway
 * Postgres and serves HTTP endpoints that the Cloudflare Worker calls.
 * 
 * Deploy: this file's own Railway service, separate from bot.js's service.
 * Set environment variables: DATABASE_URL, API_SECRET
 */

const express = require('express');
const { Pool } = require('pg');
const { OCAS_SLUG, BURN_CONTRACT } = require('./lib/constants');
const { runMigrations, fetchAndStoreCollectionTraits } = require('./lib/db');
const saleStream = require('./lib/sale-stream');

// Loaded at module level (not lazily inside a route handler) specifically
// so its setInterval-driven sync loops actually start the moment this
// process boots. Previously this was require()'d only inside the manual
// /db/listings/sync handler, which meant sync-listings.js's top-level code
// — including both setInterval calls — never ran at all unless someone
// manually hit that endpoint at least once. That's the real reason no
// [sync] log lines were ever appearing, on this version or the version
// before today's rewrite.
const syncListingsModule = require('./sync-listings');
const { onboardCollection, backfillCollectionLinks } = require('./lib/collection-onboard');
const { computeObsRanks } = require('./lib/rank-compute');
const { refreshBurnedStatus } = require('./lib/burn-detect');
const { fixCollectionImages, fetchRawTokenUri, diagnoseIpfsGateways } = require('./lib/collection-backfill');

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';

function normalizeEthAddress(addr) {
  const s = String(addr || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : '';
}

const OCAS_CONTRACT = normalizeEthAddress(process.env.OCAS_CONTRACT || DEFAULT_OCAS_CONTRACT);

function traitsFromRows(rows) {
  const attrs = (rows || [])
    .filter(r => r && r.trait_name && r.trait_value != null)
    .sort((a, b) => {
      const ai = Number(a.trait_index || 0);
      const bi = Number(b.trait_index || 0);
      if (ai !== bi) return ai - bi;
      return String(a.trait_name).localeCompare(String(b.trait_name));
    })
    .map(r => ({ trait_type: String(r.trait_name), value: String(r.trait_value) }));

  const traits = {};
  for (const t of attrs) {
    // Compatibility for old consumers. Duplicate trait names are preserved in
    // __attributes even though this key stores the last value for a trait name.
    traits[t.trait_type] = t.value;
  }
  if (attrs.length) traits.__attributes = attrs;
  return traits;
}

const ACTIVE_TOKEN_CONDITION = `NOT EXISTS (
  SELECT 1 FROM burn_event_inputs active_burned
  JOIN burn_events active_be ON active_be.id = active_burned.burn_event_id
  WHERE active_burned.burned_token_id = t.id
    AND active_burned.burned_token_id != active_be.survivor_token_id
)`;


// ── Database connection pool ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false                        // internal Railway network — no SSL needed
    : { rejectUnauthorized: false }, // public URL — SSL required
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => console.error('DB pool error:', err.message));

// ── Simple auth middleware ────────────────────────────────────────────────────
// All requests must include ?key=YOUR_API_SECRET or x-api-key header
const API_SECRET = process.env.API_SECRET;
const REQUIRE_API_AUTH = process.env.NODE_ENV === 'production';
// Railway sits behind a reverse proxy -- without this, req.ip always reflects
// the proxy's IP for every request, which would make per-IP rate limiting
// completely ineffective (every request looks like it's from the same "IP").
app.set('trust proxy', true);

function auth(req, res, next) {
  if (!API_SECRET) {
    if (REQUIRE_API_AUTH) {
      return res.status(503).json({ ok: false, error: 'API auth is not configured' });
    }
    return next(); // no secret set = open in local/dev only
  }
  const key = req.query.key || req.headers['x-api-key'];
  if (key !== API_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

// ── Lightweight in-memory rate limiter ───────────────────────────────────────
// Single Railway instance, no need for Redis-backed limiting. Keyed however
// the caller wants (per-IP for abuse/brute-force protection, per-wallet-
// address for write-throttling regardless of source IP).
const _rateLimitBuckets = new Map();
function rateLimit({ max, windowMs, keyFn }) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let bucket = _rateLimitBuckets.get(key);
    if (!bucket) { bucket = []; _rateLimitBuckets.set(key, bucket); }
    while (bucket.length && now - bucket[0] > windowMs) bucket.shift();
    if (bucket.length >= max) {
      return res.status(429).json({ ok: false, error: 'rate_limited', retryAfterMs: windowMs - (now - bucket[0]) });
    }
    bucket.push(now);
    next();
  };
}
// Periodic cleanup so this Map doesn't grow unbounded over a long-running process
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of _rateLimitBuckets.entries()) {
    if (!bucket.length || now - bucket[bucket.length - 1] > 3600000) _rateLimitBuckets.delete(key);
  }
}, 15 * 60 * 1000);

// 5mb limit (default is 100kb) -- needed for POST /render/svg-token, which
// accepts a base64 on-chain SVG data URI in the request body. Confirmed
// live: a large embedded-PNG on-chain SVG failed with HTTP 431 when sent as
// a GET query-string parameter (a request line has much tighter length
// limits than a POST body almost everywhere) -- moving it to a POST body
// fixes that, but only if the body-size limit is actually large enough to
// hold it. Raised globally rather than as a second, route-specific
// express.json() call: Express only reads the request body stream once, so
// stacking a second json() middleware on top of this global one for a
// single route risks silently no-op'ing or erroring on an already-consumed
// stream, not actually widening anything.
app.use(express.json({ limit: '5mb' }));

// ── CORS — allow the production site, Cloudflare Pages previews, and local/
// LAN dev testing; reject arbitrary third-party origins from embedding
// cross-origin calls to this API using a visitor's browser session ─────────
function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser requests (server-to-server, curl) have no Origin header
  try {
    const host = new URL(origin).hostname;
    if (host === 'traitview.com' || host === 'www.traitview.com') return true;
    if (host.endsWith('.pages.dev')) return true;
    if (host.endsWith('.workers.dev')) return true;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;       // private LAN (dev testing)
    if (/^192\.168\.\d+\.\d+$/.test(host)) return true;      // private LAN (dev testing)
    if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true; // private LAN (dev testing)
    return false;
  } catch (_) { return false; }
}
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-api-key, content-type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'traitview-api', ts: new Date().toISOString() });
});

// ── GET /db/tokens ────────────────────────────────────────────────────────────
// Filter tokens by trait combinations, rank range.
// Query params:
//   traits    — JSON: {"Hair":["Mohawk Blonde"],"Eyes":["Left","Right"]}
//   rank_min  — number
//   rank_max  — number
//   listed    — "1" to only return currently listed tokens
//   limit     — default 10000
// Returns: { ok, tokens: [{id, obs_rank}], count }
app.get('/db/tokens', auth, async (req, res) => {
  try {
    const traitFilters = req.query.traits ? JSON.parse(req.query.traits) : {};
    const rankMin   = req.query.rank_min ? parseInt(req.query.rank_min) : null;
    const rankMax   = req.query.rank_max ? parseInt(req.query.rank_max) : null;
    const listedOnly = req.query.listed === '1';
    const limit     = Math.min(parseInt(req.query.limit || '10000'), 10000);
    // jv: same cross-collection bug class found and fixed across several
    // other endpoints tonight (/db/token-sales, /db/floor-trend,
    // /db/trait-sales, /db/rank-sales) -- this entire query joined
    // tokens/token_traits/listings purely on token_id, with no
    // collection_slug filter anywhere at all. Every collection's tokens
    // were being mixed together in whatever generic token search/filter
    // this backs. slug defaults to OCAS_SLUG, matching this file's
    // existing convention.
    const slug = (req.query.slug || OCAS_SLUG).toString();

    const traitEntries = Object.entries(traitFilters).filter(([, vals]) => vals?.length > 0);
    const traitCountFilter = req.query.trait_count ? parseInt(req.query.trait_count) : null;

    let query = `SELECT t.id, t.obs_rank FROM tokens t`;
    const params = [slug];
    let p = 2;

    // One JOIN per trait name — AND logic across names, OR within values
    traitEntries.forEach(([name, vals], i) => {
      query += ` JOIN token_traits tt${i} ON tt${i}.token_id = t.id AND tt${i}.collection_slug = t.collection_slug`
             + ` AND tt${i}.trait_name = $${p++}`
             + ` AND tt${i}.trait_value = ANY($${p++}::text[])`;
      params.push(name, Array.isArray(vals) ? vals : [vals]);
    });

    if (listedOnly) query += ` JOIN listings l ON l.token_id = t.id AND l.collection_slug = t.collection_slug`;

    const conditions = [ACTIVE_TOKEN_CONDITION, `t.collection_slug = $1`];
    if (rankMin !== null) { conditions.push(`t.obs_rank >= $${p++}`); params.push(rankMin); }
    if (rankMax !== null) { conditions.push(`t.obs_rank <= $${p++}`); params.push(rankMax); }
    if (traitCountFilter !== null) { conditions.push(`t.trait_count = $${p++}`); params.push(traitCountFilter); }
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;

    query += ` ORDER BY t.obs_rank LIMIT $${p++}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.json({
      ok: true,
      tokens: result.rows.map(r => ({ id: parseInt(r.id), obs_rank: r.obs_rank ? parseInt(r.obs_rank) : null })),
      count: result.rows.length
    });
  } catch (e) {
    console.error('/db/tokens error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/token/:id ─────────────────────────────────────────────────────────
// Single token — traits + rank. Cached at CDN level.
// Returns: { ok, token: {id, obs_rank, rarity_score, trait_count, traits} }
app.get('/db/token/:id', auth, async (req, res) => {
  try {
    const tokenId = parseInt(req.params.id);
    if (isNaN(tokenId) || tokenId < 0 || tokenId > 10_000_000) { // generous, collection-agnostic bound — was hardcoded to OCAS's ~10k supply and also rejected token id 0 (breaks 0-indexed collections like CryptoPunks)
      return res.status(400).json({ ok: false, error: 'invalid token id' });
    }
    // Defaults to OCAS when no slug is provided so any caller not yet updated
    // to pass one keeps its exact current behavior. Without this scoping,
    // token_id collisions across collections (e.g. cryptopunks #9228 and
    // on-chain-all-stars #9228 both existing in these tables) get merged
    // together into one result — confirmed root cause of the 2026-07-01
    // /traitfind garbled-trait bug.
    const slug = (req.query.slug || OCAS_SLUG).toString();

    const [tokenRes, traitsRes, collRes] = await Promise.all([
      pool.query(`SELECT id, obs_rank, os_rank, os_score, rarity_score, trait_count, image_url, is_burned FROM tokens WHERE id = $1 AND collection_slug = $2`, [tokenId, slug]),
      pool.query(`SELECT trait_name, trait_value, COALESCE(trait_index,0) AS trait_index FROM token_traits WHERE token_id = $1 AND collection_slug = $2 ORDER BY COALESCE(trait_index,0), trait_name`, [tokenId, slug]),
      pool.query(`SELECT contract, chain FROM collections WHERE slug = $1`, [slug]).catch(() => ({ rows: [] }))
    ]);

    if (!tokenRes.rows.length) return res.status(404).json({ ok: false, error: 'not found' });

    const t = tokenRes.rows[0];
    const traits = traitsFromRows(traitsRes.rows);
    const actualTraitCount = traits.__attributes?.length || parseInt(t.trait_count || 0);
    const collInfo = collRes.rows[0] || null;

    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.json({
      ok: true,
      token: {
        id: parseInt(t.id),
        obs_rank: t.obs_rank ? parseInt(t.obs_rank) : null,
        os_rank:  t.os_rank  ? parseInt(t.os_rank)    : null,
        os_score: t.os_score ? parseFloat(t.os_score) : null,
        rarity_score: t.rarity_score != null ? parseFloat(t.rarity_score) : null,
        trait_count: actualTraitCount,
        image_url: t.image_url || null,
        burned: !!t.is_burned,
        chain: collInfo?.chain || null,
        contract: collInfo?.contract || null,
        traits
      }
    });
  } catch (e) {
    console.error('/db/token error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/trait-floor ───────────────────────────────────────────────────────
// Cheapest listed token for a given trait value.
// Query params: trait_name, trait_value
// Returns: { ok, floor: {token_id, obs_rank, price_eth, url} | null }
app.get('/db/trait-floor', auth, async (req, res) => {
  try {
    const { trait_name, trait_value } = req.query;
    if (!trait_name || !trait_value) {
      return res.status(400).json({ ok: false, error: 'missing trait_name or trait_value' });
    }
    // jv: same cross-collection bug class as several other endpoints fixed
    // tonight -- no collection_slug filter anywhere in this query at all.
    // Also: the burn exclusion subquery ran unconditionally for every
    // collection against OCAS-specific burn_event_inputs data -- a
    // non-OCAS collection's token could be incorrectly excluded here if
    // its numeric id happened to match an OCAS burned token's id (the same
    // cross-collection numeric-id-collision class of bug, just via burn
    // data specifically). Gated to isOcas only, same pattern already used
    // in lib/rank-compute.js for this exact same subquery shape.
    const slug = (req.query.slug || OCAS_SLUG).toString();
    const isOcas = slug === OCAS_SLUG;
    const burnExclusion = isOcas ? `AND NOT EXISTS (
          SELECT 1 FROM burn_event_inputs active_burned
          JOIN burn_events active_be ON active_be.id = active_burned.burn_event_id
          WHERE active_burned.burned_token_id = t.id
            AND active_burned.burned_token_id != active_be.survivor_token_id
        )` : '';

    const result = await pool.query(`
      SELECT t.id, t.obs_rank, l.price_eth, l.url
      FROM tokens t
      JOIN token_traits tt ON tt.token_id = t.id AND tt.collection_slug = t.collection_slug
      JOIN listings l ON l.token_id = t.id AND l.collection_slug = t.collection_slug
      WHERE t.collection_slug = $3 AND tt.trait_name = $1 AND tt.trait_value = $2
        ${burnExclusion}
      ORDER BY l.price_eth ASC
      LIMIT 1
    `, [trait_name, trait_value, slug]);

    res.set('Cache-Control', 'public, max-age=120, s-maxage=120');
    res.json({
      ok: true,
      floor: result.rows.length ? {
        token_id: parseInt(result.rows[0].id),
        obs_rank: result.rows[0].obs_rank ? parseInt(result.rows[0].obs_rank) : null,
        price_eth: parseFloat(result.rows[0].price_eth),
        url: result.rows[0].url
      } : null
    });
  } catch (e) {
    console.error('/db/trait-floor error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/holders/trait ─────────────────────────────────────────────────────
// Which wallets hold tokens with a given trait, with counts.
// Combines Alchemy holder data with DB trait data.
// Query params: trait_name, trait_value, holders JSON (array of {address, ids[]})
// Returns: { ok, matches: [{address, matching_ids[], match_count}] }
app.get('/db/holders/trait', auth, async (req, res) => {
  try {
    const { trait_name, trait_value } = req.query;
    if (!trait_name || !trait_value) {
      return res.status(400).json({ ok: false, error: 'missing trait_name or trait_value' });
    }

    // Get all token IDs that have this trait
    const traitResult = await pool.query(`
      SELECT token_id FROM token_traits
      WHERE trait_name = $1 AND trait_value = $2
        AND NOT EXISTS (
          SELECT 1 FROM burn_event_inputs active_burned
          JOIN burn_events active_be ON active_be.id = active_burned.burn_event_id
          WHERE active_burned.burned_token_id = token_traits.token_id
            AND active_burned.burned_token_id != active_be.survivor_token_id
        )
    `, [trait_name, trait_value]);

    const traitTokenIds = new Set(traitResult.rows.map(r => parseInt(r.token_id)));

    res.json({
      ok: true,
      trait_token_ids: [...traitTokenIds],
      count: traitTokenIds.size
    });
  } catch (e) {
    console.error('/db/holders/trait error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/listings/sync — manually trigger a sync for all configured collections ──
app.get('/db/listings/sync', auth, async (req, res) => {
  try {
    res.json({ ok: true, message: 'Sync triggered for all configured collections — running in background' });
    syncListingsModule.syncAllListings();
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/collections/onboard — full onboarding for a brand-new collection ──
// Resolves the slug via OpenSea, validates it (rejects disabled/NSFW/non-
// Ethereum/non-erc721 collections), creates the registry row, then runs
// trait/image backfill followed by the market history seed in sequence.
// Runs in background; poll /db/collections to watch status move through
// pending -> backfilling_traits -> backfilling_market -> ready/failed.
//
// Admin-only, gated by a SEPARATE secret from the regular API key — that
// key is already embedded in TraitView's public frontend JS (visible via
// devtools), so it can't provide real gating for something that kicks off
// OpenSea/Alchemy-heavy work. ADMIN_ONBOARD_SECRET must be set on Railway
// and never given to the frontend; trigger manually (browser URL bar or
// curl) until there's a considered decision to open this up more broadly.
const ADMIN_ONBOARD_SECRET = process.env.ADMIN_ONBOARD_SECRET;
app.get('/db/collections/onboard', async (req, res) => {
  try {
    if (!ADMIN_ONBOARD_SECRET || req.query.admin_key !== ADMIN_ONBOARD_SECRET) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const slug = String(req.query.slug || '').toLowerCase().trim();
    if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });

    res.json({ ok: true, message: `Onboarding started for "${slug}" — running in background, poll /db/collections to watch status` });
    onboardCollection(pool, slug).catch(e => {
      console.error(`[/db/collections/onboard] ${slug} failed:`, e.message);
    });
  } catch(e) {
    console.error('/db/collections/onboard error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/collections/:slug/sync-trait-index — populate collection_traits only ──
// For collections onboarded before onboardCollection started calling this
// automatically. Pulls trait-frequency stats directly from OpenSea's own
// /v2/traits/{slug} endpoint (a separate data source from token_traits/
// Alchemy) — this is specifically what /traitfind's dropdown depends on for
// non-OCAS collections. Cheap and fast compared to a full re-backfill.
app.get('/db/collections/:slug/sync-trait-index', auth, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim();
    if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });
    // This used to always report ok:true regardless of whether the OpenSea
    // fetch actually succeeded, since fetchAndStoreCollectionTraits swallowed
    // every error internally and returned nothing — making this endpoint
    // useless as an actual diagnostic. It now returns what really happened.
    const result = await fetchAndStoreCollectionTraits(slug, pool);
    const countRes = await pool.query(`SELECT COUNT(*)::int AS n FROM collection_traits WHERE slug=$1`, [slug]).catch(()=>({rows:[{n:0}]}));
    res.json({
      ok: !!result.ok,
      slug,
      reason: result.reason || null,
      opensea_status: result.status || null,
      rows_in_collection_traits: countRes.rows[0]?.n || 0,
      message: result.ok
        ? `Trait index sync succeeded for "${slug}" — check /db/trait-index?slug=${slug} to confirm`
        : `Trait index sync did NOT populate data for "${slug}": ${result.reason || 'unknown reason'}`,
    });
  } catch(e) {
    console.error(`/db/collections/${req.params.slug}/sync-trait-index error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/collections/:slug/fix-images — re-verify images for a non-Ethereum
// collection backfilled before writePage started always checking non-Ethereum
// images against the real on-chain source. One-time correction pass; skips
// traits entirely (those are already correct). Runs in the background —
// iterates every token individually, so this takes a while for a large
// collection. Check server logs for progress.
app.get('/db/collections/:slug/fix-images', auth, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim();
    if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });

    const collRes = await pool.query(`SELECT slug, contract, chain FROM collections WHERE slug = $1`, [slug]);
    if (!collRes.rows.length) {
      return res.status(404).json({ ok: false, error: `No collections row for slug "${slug}"` });
    }

    res.json({ ok: true, message: `Image fix started for "${slug}" — running in background, check server logs for progress` });
    fixCollectionImages(pool, collRes.rows[0]).catch(e => {
      console.error(`[/db/collections/${slug}/fix-images] background fix failed:`, e.message);
    });
  } catch(e) {
    console.error(`/db/collections/${req.params.slug}/fix-images error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/collections/:slug/repair-status — check progress of the
// background metadata repair queue (Tier 4 of the tiered backfill) without
// needing to tail server logs. Reports pending/done/permanently_failed
// counts, plus a small sample of currently-pending token IDs so it's
// obvious at a glance whether the drain is actually making progress.
app.get('/db/collections/:slug/repair-status', auth, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim();
    if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });

    const countsRes = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM metadata_repair_jobs WHERE collection_slug=$1 GROUP BY status`,
      [slug]
    );
    const counts = { pending: 0, done: 0, permanently_failed: 0 };
    for (const row of countsRes.rows) counts[row.status] = row.n;

    const sampleRes = await pool.query(
      `SELECT token_id, attempts, last_error, last_attempt_at FROM metadata_repair_jobs
       WHERE collection_slug=$1 AND status='pending' ORDER BY token_id ASC LIMIT 10`,
      [slug]
    );

    const total = counts.pending + counts.done + counts.permanently_failed;
    res.json({
      ok: true,
      slug,
      total,
      pending: counts.pending,
      done: counts.done,
      permanently_failed: counts.permanently_failed,
      percentComplete: total ? Math.round(((counts.done + counts.permanently_failed) / total) * 100) : 100,
      stillDraining: counts.pending > 0,
      samplePendingTokens: sampleRes.rows,
    });
  } catch(e) {
    console.error(`/db/collections/${req.params.slug}/repair-status error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/collections/:slug/seed-market — one-time full sales history +
// current listings pull for a newly onboarded collection. Runs in the
// background; poll /db/collections (added in phase 1) to watch status go
// pending -> backfilling_market -> ready/failed. Expects the collection row
// to already exist (created by the trait/image backfill step) — this only
// covers the market side.
app.get('/db/collections/:slug/seed-market', auth, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim();
    if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });

    const existing = await pool.query(`SELECT slug, contract FROM collections WHERE slug = $1`, [slug]);
    if (!existing.rows.length) {
      return res.status(404).json({ ok: false, error: `No collections row for slug "${slug}" — run the trait/image backfill first` });
    }

    res.json({ ok: true, message: `Market history seed started for ${slug} — running in background, poll /db/collections to watch status` });
    syncListingsModule.seedMarketHistory(existing.rows[0]).catch(e => {
      console.error(`[/db/collections/${slug}/seed-market] background seed failed:`, e.message);
    });
  } catch(e) {
    console.error('/db/collections/:slug/seed-market error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/listings — all current listings from DB ───────────────────────────
app.get('/db/listings', auth, async (req, res) => {
  try {
    // Default to OCAS slug for TraitView; pass ?slug= to override
    const slug = req.query.slug || 'on-chain-all-stars';
    const result = await pool.query(
      `SELECT token_id, price_eth, url, currency FROM listings WHERE collection_slug = $1 ORDER BY price_eth ASC`,
      [slug]
    );
    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      listings: result.rows.map(r => ({
        token_id: parseInt(r.token_id),
        price_eth: parseFloat(r.price_eth),
        url: r.url,
        currency: r.currency || 'ETH'
      })),
      count: result.rows.length
    });
  } catch(e) {
    console.error('/db/listings error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/floor-trend — aggregated sales for chart ─────────────────────────
app.get('/db/floor-trend', auth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '90'), 365);
    const slug = (req.query.slug || OCAS_SLUG).toLowerCase();
    // jv: "when it does load it's all stacked in 1 spot" -- the daily
    // floor line (from floor_history, a periodic snapshot with no row cap
    // at all) correctly spanned the full 30 days, but the individual sale
    // dots all crowded into the last few days only. Root cause: LIMIT 2000
    // ordered by sale_ts DESC returns the MOST RECENT 2000 sales, not an
    // even sample across whatever range was actually requested. This
    // collection does roughly 100+ sales/day -- at that rate 2000 rows are
    // consumed in well under 3 weeks, so a 30-day (or longer) request was
    // silently getting truncated down to just its most recent few days,
    // no matter which range the user had actually selected. Raised well
    // past this collection's own current all-time sale count (order of
    // 15k) so a genuinely full range comes back uncapped in practice
    // rather than needing a cap increase again the next time volume grows.
    const result = await pool.query(
      `SELECT s.token_id, s.price_eth, s.currency, s.sale_ts, t.obs_rank
       FROM sales s JOIN tokens t ON t.id = s.token_id AND t.collection_slug = s.collection_slug
       WHERE s.collection_slug = $2 AND s.sale_ts > NOW() - ($1 || ' days')::INTERVAL
       ORDER BY s.sale_ts DESC LIMIT 20000`,
      [days, slug]
    );
    res.set('Cache-Control', 'public, max-age=120, s-maxage=120');
    res.json({
      ok: true,
      sales: result.rows.map(r => ({
        token_id: parseInt(r.token_id),
        price_eth: parseFloat(r.price_eth),
        currency: r.currency,
        sale_ts: r.sale_ts,
        obs_rank: r.obs_rank ? parseInt(r.obs_rank) : null
      })),
      count: result.rows.length
    });
  } catch(e) {
    console.error('/db/floor-trend error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/token-sales ───────────────────────────────────────────────────────
// Sale history for a specific token — used by price history chart in modal.
// Query params:
//   token_id — required
//   limit    — default 200
// Returns: { ok, sales: [{token_id, price_eth, currency, buyer, seller, tx_hash, sale_ts}] }
app.get('/db/token-sales', auth, async (req, res) => {
  try {
    const tokenId = parseInt(req.query.token_id);
    if (isNaN(tokenId) || tokenId < 0 || tokenId > 10_000_000) { // generous, collection-agnostic bound — was hardcoded to OCAS's ~10k supply and also rejected token id 0 (breaks 0-indexed collections like CryptoPunks)
      return res.status(400).json({ ok: false, error: 'invalid token_id' });
    }
    const limit = Math.min(parseInt(req.query.limit || '200'), 500);
    // jv: "for some argonauts tokens it's showing sales for OCAS." This
    // query had no collection_slug filter at all -- WHERE token_id = $1
    // alone, on a table that spans every collection. dbFetch() on the
    // frontend already auto-injects slug on every single call (confirmed
    // directly in js/api.js), so the caller was always sending it
    // correctly; this endpoint simply never read it. Since OCAS and
    // Argonauts both have roughly 10,000 tokens, most numeric IDs exist in
    // both -- any token id present in both collections would return sales
    // mixed together from whichever rows matched, regardless of which
    // collection's modal was actually asking. slug defaults to OCAS_SLUG,
    // matching every other endpoint in this file's own existing
    // req.query.slug || OCAS_SLUG convention, so this doesn't change
    // behavior for any caller that predates this fix and never sent one.
    const slug = (req.query.slug || OCAS_SLUG).toLowerCase();

    const result = await pool.query(
      `SELECT token_id, price_eth, currency, buyer, seller, tx_hash, sale_ts
       FROM sales
       WHERE token_id = $1 AND collection_slug = $2
       ORDER BY sale_ts ASC
       LIMIT $3`,
      [tokenId, slug, limit]
    );

    res.set('Cache-Control', 'public, max-age=120, s-maxage=120');
    res.json({
      ok: true,
      sales: result.rows.map(r => ({
        token_id:  parseInt(r.token_id),
        price_eth: parseFloat(r.price_eth),
        currency:  r.currency || 'ETH',
        buyer:     r.buyer  || null,
        seller:    r.seller || null,
        tx_hash:   r.tx_hash || null,
        sale_ts:   r.sale_ts,
      })),
      count: result.rows.length
    });
  } catch (e) {
    console.error('/db/token-sales error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});



// ── GET /db/sales-search ──────────────────────────────────────────────────────
// Full, non-paginated sales history matching a free-text trait search
// and/or an exact trait count -- backs the Sales tab's trait search box and
// trait-count filter, reading directly from this collection's own sales
// history rather than being limited to whatever's currently loaded from
// OpenSea's own paginated feed.
// Query params:
//   q           — free-text substring, matched against trait NAME or VALUE
//                 (e.g. "gold" matches a "Crown: Gold Chain" trait) — optional
//   trait_count — exact trait count match — optional
//   limit       — default 100, max 500
//   sort        — "desc" (newest first, default) or "asc"
// At least one of q/trait_count is required.
// Returns: { ok, sales: [{token_id, price_eth, currency, sale_ts, buyer, seller}], count }
app.get('/db/sales-search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const traitCount = req.query.trait_count ? parseInt(req.query.trait_count) : null;
    // jv: sales tab shows "OpenSea API failed: 401 — Invalid API key" for
    // the unfiltered/live view, while applying a trait-count filter (which
    // already routes through this exact endpoint instead) works fine --
    // confirmed this endpoint queries this repo's own already-synced sales
    // table, with no dependency on the Cloudflare Worker or its separate,
    // broken OPENSEA_API_KEY secret at all. Relaxing the previous
    // q-or-trait_count requirement so the frontend can fall back to this
    // same, healthy endpoint for the unfiltered case too (most recent
    // sales for the slug, no filter applied) rather than being stuck with
    // no working data source at all whenever that worker's key is down.
    const limit = Math.min(parseInt(req.query.limit || '100'), 500);
    const sort  = req.query.sort === 'asc' ? 'ASC' : 'DESC';
    const slug  = (req.query.slug || OCAS_SLUG).toLowerCase();

    const conditions = ['s.collection_slug = $1'];
    const params = [slug];
    let p = 2;
    if (q) {
      conditions.push(`EXISTS (
        SELECT 1 FROM token_traits tt
        WHERE tt.token_id = s.token_id AND tt.collection_slug = s.collection_slug
        AND (tt.trait_name ILIKE $${p} OR tt.trait_value ILIKE $${p})
      )`);
      params.push(`%${q}%`);
      p++;
    }
    if (traitCount != null) {
      conditions.push(`EXISTS (
        SELECT 1 FROM tokens t
        WHERE t.id = s.token_id AND t.collection_slug = s.collection_slug AND t.trait_count = $${p}
      )`);
      params.push(traitCount);
      p++;
    }
    params.push(limit);

    const result = await pool.query(
      `SELECT DISTINCT s.token_id, s.price_eth, s.currency, s.sale_ts, s.buyer, s.seller
       FROM sales s
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.sale_ts ${sort}
       LIMIT $${p}`,
      params
    );

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      q: q || null,
      trait_count: traitCount,
      sales: result.rows.map(r => ({
        token_id:  parseInt(r.token_id),
        price_eth: parseFloat(r.price_eth),
        currency:  r.currency || 'ETH',
        sale_ts:   r.sale_ts,
        buyer:     r.buyer  || null,
        seller:    r.seller || null,
      })),
      count: result.rows.length
    });
  } catch (e) {
    console.error('/db/sales-search error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// jv: "Trait Pulse" -- serves the pre-computed rankings from
// trait_pulse_cache (lib/trait-pulse.js does the actual computation, on a
// schedule; this endpoint only ever reads the cache, never computes live).
// ?window=1h|6h|24h|7d (default 1h), ?limit= (default 20, max 100).
app.get('/db/trait-pulse', auth, async (req, res) => {
  try {
    const slug = (req.query.slug || OCAS_SLUG).toLowerCase();
    const windowKey = ['1h','6h','24h','7d'].includes(req.query.window) ? req.query.window : '1h';
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);

    const result = await pool.query(
      `SELECT trait_name, trait_value, supply, sales_count, velocity_multiplier,
              listed_count, listed_count_prior, listing_pressure_pct,
              trait_floor_eth, trait_floor_eth_prior, floor_change_pct,
              heat_score, computed_at
       FROM trait_pulse_cache
       WHERE collection_slug = $1 AND window_key = $2
       ORDER BY heat_score DESC
       LIMIT $3`,
      [slug, windowKey, limit]
    );

    res.set('Cache-Control', 'public, max-age=120, s-maxage=120');
    res.json({
      ok: true,
      slug,
      window: windowKey,
      computed_at: result.rows[0]?.computed_at || null,
      traits: result.rows.map(r => ({
        trait_name:  r.trait_name,
        trait_value: r.trait_value,
        supply:      parseInt(r.supply),
        sales_count: parseInt(r.sales_count),
        velocity_multiplier: parseFloat(r.velocity_multiplier),
        listed_count: r.listed_count != null ? parseInt(r.listed_count) : null,
        listed_count_prior: r.listed_count_prior != null ? parseInt(r.listed_count_prior) : null,
        listing_pressure_pct: r.listing_pressure_pct != null ? parseFloat(r.listing_pressure_pct) : null,
        trait_floor_eth: r.trait_floor_eth != null ? parseFloat(r.trait_floor_eth) : null,
        trait_floor_eth_prior: r.trait_floor_eth_prior != null ? parseFloat(r.trait_floor_eth_prior) : null,
        floor_change_pct: r.floor_change_pct != null ? parseFloat(r.floor_change_pct) : null,
        heat_score: parseFloat(r.heat_score),
      })),
      count: result.rows.length
    });
  } catch (e) {
    console.error('/db/trait-pulse error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// Sales history filtered by a trait value — full collection history, no pagination cap.
// Query params:
//   trait   — trait name  e.g. "Type"
//   value   — trait value e.g. "Zombie"
//   limit   — default 50, max 200
//   sort    — "desc" (newest first, default) or "asc"
// Returns: { ok, sales: [{token_id, price_eth, currency, sale_ts, buyer, seller}], count }
app.get('/db/trait-sales', auth, async (req, res) => {
  try {
    const trait = (req.query.trait || '').trim();
    const value = (req.query.value || '').trim();
    if (!trait || !value) {
      return res.status(400).json({ ok: false, error: 'trait and value are required' });
    }
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const sort  = req.query.sort === 'asc' ? 'ASC' : 'DESC';
    // jv: same cross-collection bug class as /db/token-sales and
    // /db/floor-trend above -- token_traits AND sales both span every
    // collection, and this join matched purely on token_id with no
    // collection_slug anywhere. Two collections sharing the same trait
    // name/value (e.g. a common "Background: Blue") would have their sales
    // mixed together here. slug defaults to OCAS_SLUG, matching this
    // file's existing convention.
    const slug = (req.query.slug || OCAS_SLUG).toLowerCase();

    // Join sales with token_traits — case-insensitive match on both trait and value
    const result = await pool.query(
      `SELECT s.token_id, s.price_eth, s.currency, s.sale_ts, s.buyer, s.seller
       FROM sales s
       JOIN token_traits tt ON tt.token_id = s.token_id AND tt.collection_slug = s.collection_slug
       WHERE s.collection_slug = $4
         AND LOWER(tt.trait_name)  = LOWER($1)
         AND LOWER(tt.trait_value) = LOWER($2)
       ORDER BY s.sale_ts ${sort}
       LIMIT $3`,
      [trait, value, limit, slug]
    );

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      trait, value,
      sales: result.rows.map(r => ({
        token_id:  parseInt(r.token_id),
        price_eth: parseFloat(r.price_eth),
        currency:  r.currency || 'ETH',
        sale_ts:   r.sale_ts,
        buyer:     r.buyer  || null,
        seller:    r.seller || null,
      })),
      count: result.rows.length
    });
  } catch (e) {
    console.error('/db/trait-sales error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── GET /db/floor-history ─────────────────────────────────────────────────────
// Floor price timeline — used for 24h change on TraitView.
// Query params:
//   hours  — look back window, default 48, max 168 (7 days)
// Returns: { ok, history: [{floor_eth, token_id, recorded_at}], current, ref_24h }
app.get('/db/floor-history', auth, async (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours || '48'), 9600);
    const result = await pool.query(
      `SELECT floor_eth, token_id, recorded_at
       FROM floor_history
       WHERE recorded_at > NOW() - ($1 || ' hours')::INTERVAL
       ORDER BY recorded_at DESC`,
      [hours]
    );
    const rows = result.rows.map(r => ({
      floor_eth:   parseFloat(r.floor_eth),
      token_id:    r.token_id ? parseInt(r.token_id) : null,
      recorded_at: r.recorded_at,
    }));

    // Current floor = most recent entry
    const current = rows.length ? rows[0].floor_eth : null;

    // Floor 24h ago = most recent entry at or before NOW()-24h
    const ref24hResult = await pool.query(
      `SELECT floor_eth FROM floor_history
       WHERE recorded_at <= NOW() - INTERVAL '24 hours'
       ORDER BY recorded_at DESC LIMIT 1`
    );
    const ref_24h = ref24hResult.rows.length
      ? parseFloat(ref24hResult.rows[0].floor_eth)
      : null;

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({ ok: true, history: rows, current, ref_24h, count: rows.length });
  } catch(e) {
    console.error('/db/floor-history error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/floor-before-sweep ────────────────────────────────────────────────
// Returns the true floor BEFORE and AFTER removing swept token IDs.
// Used by the Discord bot for accurate sweep floor impact.
// Query params:
//   swept_ids — comma-separated token IDs that were swept
// Returns: { ok, floor_before, floor_after, swept_count }
app.get('/db/floor-before-sweep', auth, async (req, res) => {
  try {
    const sweptParam = (req.query.swept_ids || '').trim();
    if (!sweptParam) {
      return res.status(400).json({ ok: false, error: 'swept_ids required' });
    }
    const sweptIds = sweptParam.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    if (!sweptIds.length) {
      return res.status(400).json({ ok: false, error: 'no valid token IDs' });
    }
    // jv: same cross-collection bug class as several other endpoints fixed
    // tonight -- neither query here had a collection_slug filter at all,
    // meaning floor_before/floor_after were computed across EVERY
    // collection's listings combined, not just the requesting one. A much
    // lower floor anywhere else on this service would silently corrupt
    // this collection's own sweep-impact numbers. slug defaults to
    // OCAS_SLUG, matching this file's existing convention.
    const slug = (req.query.slug || OCAS_SLUG).toString();

    // Floor before = current minimum across ALL active listings for this collection
    const beforeResult = await pool.query(
      `SELECT MIN(price_eth) AS floor_eth FROM listings WHERE collection_slug = $1`,
      [slug]
    );
    const floor_before = beforeResult.rows[0]?.floor_eth
      ? parseFloat(beforeResult.rows[0].floor_eth)
      : null;

    // Floor after = minimum excluding swept token IDs, still this collection only
    const afterResult = await pool.query(
      `SELECT MIN(price_eth) AS floor_eth FROM listings
       WHERE collection_slug = $1 AND token_id != ALL($2::int[])`,
      [slug, sweptIds]
    );
    const floor_after = afterResult.rows[0]?.floor_eth
      ? parseFloat(afterResult.rows[0].floor_eth)
      : null;

    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, floor_before, floor_after, swept_count: sweptIds.length });
  } catch(e) {
    console.error('/db/floor-before-sweep error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});



// ── GET /db/trait-index ──────────────────────────────────────────────────────
// Full trait value index used by the Discord bot for phrase-aware /ocas search.
// Query params:
//   slug — optional collection_slug filter.
//     - omitted: old unscoped behavior, reads token_traits with no filter.
//     - 'on-chain-all-stars' (or omitted on legacy callers): reads token_traits,
//       scoped, since that table has real per-token OCAS data.
//     - any other slug: reads collection_traits instead. token_traits has no
//       real per-token data for non-OCAS collections yet (nothing writes it),
//       but collection_traits IS populated for any collection added via
//       /config — it just can't map a trait back to specific token IDs, only
//       say "this trait exists, with this many tokens." That's exactly what
//       this endpoint needs for phrase parsing (it never resolves to a
//       token ID itself — chooseTraitGroupsFromQuery just needs to know which
//       trait_name/trait_value pairs are real, so /traitfind can match typed
//       search text against them and pass the resolved pair to
//       /db/multi-trait-tokens separately).
// Returns: { ok, traits: [{trait_name, trait_value, token_count}] }
app.get('/db/trait-index', auth, async (req, res) => {
  try {
    const slug = req.query.slug ? String(req.query.slug).trim() : OCAS_SLUG;
    const isOcas = slug === OCAS_SLUG || slug.toLowerCase().includes('on-chain-all-stars');

    if (!isOcas) {
      const result = await pool.query(
        `SELECT trait_name, trait_value, token_count FROM collection_traits WHERE slug=$1 ORDER BY LENGTH(trait_value) DESC, trait_value ASC`,
        [slug]
      );
      res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
      return res.json({
        ok: true,
        traits: result.rows.map(r => ({
          trait_name:  r.trait_name,
          trait_value: r.trait_value,
          token_count: parseInt(r.token_count) || 0
        })),
        count: result.rows.length
      });
    }

    const params = [];
    let slugCond = '';
    if (slug) { params.push(slug); slugCond = ` AND tt.collection_slug = $${params.length}`; }
    const result = await pool.query(`
      SELECT trait_name, trait_value, COUNT(*)::int AS token_count
      FROM token_traits tt
      WHERE trait_name IS NOT NULL
        AND trait_value IS NOT NULL
        AND TRIM(trait_value) <> ''
        ${slugCond}
        AND NOT EXISTS (
          SELECT 1 FROM burn_event_inputs active_burned
          JOIN burn_events active_be ON active_be.id = active_burned.burn_event_id
          WHERE active_burned.burned_token_id = tt.token_id
            AND active_burned.burned_token_id != active_be.survivor_token_id
        )
      GROUP BY trait_name, trait_value
      ORDER BY LENGTH(trait_value) DESC, trait_value ASC
    `, params);

    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.json({
      ok: true,
      traits: result.rows.map(r => ({
        trait_name:  r.trait_name,
        trait_value: r.trait_value,
        token_count: parseInt(r.token_count)
      })),
      count: result.rows.length
    });
  } catch(e) {
    console.error('/db/trait-index error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

function parseTraitMatchesParam(req) {
  if (req.query.matches) {
    const parsed = JSON.parse(req.query.matches);
    if (!Array.isArray(parsed)) throw new Error('matches must be an array');
    return parsed
      .map(m => ({ trait_name: String(m.trait_name || '').trim(), trait_value: String(m.trait_value || '').trim() }))
      .filter(m => m.trait_name && m.trait_value);
  }

  // Backwards-compatible object format: {"Type":["Zombie"],"Clothes":["Hoodie"]}
  if (req.query.traits) {
    const obj = JSON.parse(req.query.traits);
    const out = [];
    for (const [name, vals] of Object.entries(obj || {})) {
      const arr = Array.isArray(vals) ? vals : [vals];
      for (const value of arr) {
        if (name && value) out.push({ trait_name: String(name).trim(), trait_value: String(value).trim() });
      }
    }
    return out;
  }

  return [];
}

function parseTraitGroupsParam(req) {
  if (req.query.groups) {
    const parsed = JSON.parse(req.query.groups);
    if (!Array.isArray(parsed)) throw new Error('groups must be an array');
    return parsed.map(group => {
      const arr = Array.isArray(group) ? group : [group];
      return arr
        .map(m => ({ trait_name: String(m.trait_name || '').trim(), trait_value: String(m.trait_value || '').trim() }))
        .filter(m => m.trait_name && m.trait_value);
    }).filter(group => group.length);
  }
  const matches = parseTraitMatchesParam(req);
  return matches.map(m => [m]);
}

// ── GET /db/multi-trait-tokens ───────────────────────────────────────────────
// Tokens matching multiple exact trait pairs using AND logic, even if trait names repeat.
// Query params:
//   matches     — JSON array: [{trait_name, trait_value}, ...]
//   traits      — optional legacy JSON object
//   listed      — "1" for active listings only
//   trait_count — optional exact trait count
//   rank_min/rank_max/rank_type — optional rank filter
//   slug        — optional collection_slug filter. If omitted, behaves exactly
//                 as before this param existed (no collection filtering at
//                 all) — only pass this once a caller is deliberately
//                 collection-aware, since tokens/token_traits/listings can
//                 all hold rows from more than one collection now.
//   limit       — default 100, max 10000
app.get('/db/multi-trait-tokens', auth, async (req, res) => {
  try {
    const groups = parseTraitGroupsParam(req);
    const matches = groups.flat();
    const listedOnly = req.query.listed === '1';
    const traitCount = req.query.trait_count ? parseInt(req.query.trait_count) : null;
    const rankMin = req.query.rank_min ? parseInt(req.query.rank_min) : null;
    const rankMax = req.query.rank_max ? parseInt(req.query.rank_max) : null;
    const rankType = req.query.rank_type === 'obs' ? 'obs' : 'os';
    const rankCol = rankType === 'obs' ? 't.obs_rank' : 't.os_rank';
    const slug = req.query.slug ? String(req.query.slug).trim() : OCAS_SLUG;
    const limit = Math.min(parseInt(req.query.limit || '100'), 10000);
    // Non-OCAS collections have no rows in `tokens` (backfill only writes
    // token_traits). For listedOnly queries on non-OCAS slugs, drive off
    // listings instead so we see all listed tokens regardless.
    const isOcasSlug = slug === OCAS_SLUG;
    const useListingsDriven = listedOnly && !isOcasSlug;

    if (!matches.length && !traitCount && rankMin === null && rankMax === null) {
      return res.status(400).json({ ok: false, error: 'provide matches, trait_count, or rank filter' });
    }

    let query, params = [], p = 1;

    if (useListingsDriven) {
      // ── Listings-driven path (non-OCAS collections) ──────────────────────
      // Drive off listings table so all listed tokens are visible even when
      // the tokens table has no row for this collection.
      query = `SELECT l.token_id AS id, NULL::int AS obs_rank, NULL::int AS os_rank,
        NULL::float AS os_score, NULL::float AS rarity_score, NULL::int AS trait_count,
        l.price_eth, l.url,
        jsonb_build_object(
          '__attributes',
          COALESCE(
            jsonb_agg(
              jsonb_build_object('trait_type', tt.trait_name, 'value', tt.trait_value)
              ORDER BY COALESCE(tt.trait_index, 0), tt.trait_name
            ) FILTER (WHERE tt.trait_name IS NOT NULL),
            '[]'::jsonb
          )
        ) AS traits
        FROM listings l
        LEFT JOIN token_traits tt ON tt.token_id = l.token_id AND tt.collection_slug = $${p++}`;
      params.push(slug);

      const conditions = [`l.collection_slug = $${p++}`];
      params.push(slug);
      groups.forEach((group, gi) => {
        const ors = [];
        group.forEach(m => {
          ors.push(`(LOWER(g${gi}.trait_name) = LOWER($${p++}) AND LOWER(g${gi}.trait_value) = LOWER($${p++}))`);
          params.push(m.trait_name, m.trait_value);
        });
        conditions.push(`EXISTS (SELECT 1 FROM token_traits g${gi} WHERE g${gi}.token_id = l.token_id AND g${gi}.collection_slug = $${p++} AND (${ors.join(' OR ')}))`);
        params.push(slug);
      });
      if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
      query += ` GROUP BY l.token_id, l.price_eth, l.url ORDER BY l.price_eth ASC`;
      query += ` LIMIT $${p++}`;
      params.push(limit);
    } else {
      // ── Tokens-driven path (OCAS, or non-listed queries) ─────────────────
      query = `SELECT t.id, t.obs_rank, t.os_rank, t.os_score, t.rarity_score, t.trait_count`;
      if (listedOnly) query += `, l.price_eth, l.url`;
      query += `,
        jsonb_build_object(
          '__attributes',
          COALESCE(
            jsonb_agg(
              jsonb_build_object('trait_type', tt.trait_name, 'value', tt.trait_value)
              ORDER BY COALESCE(tt.trait_index, 0), tt.trait_name
            ) FILTER (WHERE tt.trait_name IS NOT NULL),
            '[]'::jsonb
          )
        ) AS traits`;
      query += ` FROM tokens t`;

      if (listedOnly) {
        query += ` JOIN listings l ON l.token_id = t.id AND l.collection_slug = $${p++}`;
        params.push(slug);
      }
      query += ` LEFT JOIN token_traits tt ON tt.token_id = t.id AND tt.collection_slug = $${p++}`;
      params.push(slug);

      const conditions = [ACTIVE_TOKEN_CONDITION, `t.collection_slug = $${p++}`];
      params.push(slug);
      groups.forEach((group, i) => {
        const ors = [];
        group.forEach(m => {
          ors.push(`(LOWER(g${i}.trait_name) = LOWER($${p++}) AND LOWER(g${i}.trait_value) = LOWER($${p++}))`);
          params.push(m.trait_name, m.trait_value);
        });
        conditions.push(`EXISTS (SELECT 1 FROM token_traits g${i} WHERE g${i}.token_id = t.id AND g${i}.collection_slug = $${p++} AND (${ors.join(' OR ')}))`);
        params.push(slug);
      });
      if (traitCount !== null && !isNaN(traitCount)) { conditions.push(`t.trait_count = $${p++}`); params.push(traitCount); }
      if (rankMin !== null && !isNaN(rankMin)) { conditions.push(`${rankCol} >= $${p++}`); params.push(rankMin); }
      if (rankMax !== null && !isNaN(rankMax)) { conditions.push(`${rankCol} <= $${p++}`); params.push(rankMax); }
      if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;

      query += listedOnly
        ? ` GROUP BY t.id, t.obs_rank, t.os_rank, t.os_score, t.rarity_score, t.trait_count, l.price_eth, l.url ORDER BY l.price_eth ASC, t.obs_rank ASC`
        : ` GROUP BY t.id, t.obs_rank, t.os_rank, t.os_score, t.rarity_score, t.trait_count ORDER BY t.obs_rank ASC`;
      query += ` LIMIT $${p++}`;
      params.push(limit);
    }

    const result = await pool.query(query, params);
    // Never cache listing results — prices and availability change frequently
    res.set('Cache-Control', listedOnly ? 'no-store' : 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      matches,
      groups,
      tokens: result.rows.map(r => ({
        id: parseInt(r.id),
        obs_rank: r.obs_rank ? parseInt(r.obs_rank) : null,
        os_rank: r.os_rank ? parseInt(r.os_rank) : null,
        os_score: r.os_score ? parseFloat(r.os_score) : null,
        rarity_score: r.rarity_score ? parseFloat(r.rarity_score) : null,
        trait_count: r.trait_count ? parseInt(r.trait_count) : null,
        price_eth: r.price_eth != null ? parseFloat(r.price_eth) : null,
        url: r.url || null,
        traits: r.traits || {},
      })),
      count: result.rows.length
    });
  } catch(e) {
    console.error('/db/multi-trait-tokens error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/multi-trait-floor ────────────────────────────────────────────────
// Cheapest listed token matching multiple exact trait pairs using AND logic.
// Query params: matches JSON array or legacy traits JSON object, optional trait_count/rank filters.
app.get('/db/multi-trait-floor', auth, async (req, res) => {
  try {
    const groups = parseTraitGroupsParam(req);
    const matches = groups.flat();
    const traitCount = req.query.trait_count ? parseInt(req.query.trait_count) : null;
    const rankMin = req.query.rank_min ? parseInt(req.query.rank_min) : null;
    const rankMax = req.query.rank_max ? parseInt(req.query.rank_max) : null;
    const rankType = req.query.rank_type === 'obs' ? 'obs' : 'os';
    const rankCol = rankType === 'obs' ? 't.obs_rank' : 't.os_rank';
    // jv: same cross-collection bug class as several other endpoints fixed
    // tonight -- no collection_slug filter anywhere in this query, and the
    // per-group token_traits EXISTS subquery matched purely on token_id
    // too. slug defaults to OCAS_SLUG, matching this file's convention.
    const slug = (req.query.slug || OCAS_SLUG).toString();

    if (!matches.length && !traitCount && rankMin === null && rankMax === null) {
      return res.status(400).json({ ok: false, error: 'provide matches, trait_count, or rank filter' });
    }

    let query = `SELECT l.token_id, l.price_eth, l.url,
                        t.trait_count, t.os_rank, t.obs_rank, t.os_score, t.rarity_score
                 FROM listings l
                 JOIN tokens t ON t.id = l.token_id AND t.collection_slug = l.collection_slug`;
    const params = [slug];
    let p = 2;

    const conditions = [ACTIVE_TOKEN_CONDITION, `t.collection_slug = $1`];
    groups.forEach((group, i) => {
      const ors = [];
      group.forEach(m => {
        ors.push(`(LOWER(g${i}.trait_name) = LOWER($${p++}) AND LOWER(g${i}.trait_value) = LOWER($${p++}))`);
        params.push(m.trait_name, m.trait_value);
      });
      conditions.push(`EXISTS (SELECT 1 FROM token_traits g${i} WHERE g${i}.token_id = t.id AND g${i}.collection_slug = t.collection_slug AND (${ors.join(' OR ')}))`);
    });
    if (traitCount !== null && !isNaN(traitCount)) { conditions.push(`t.trait_count = $${p++}`); params.push(traitCount); }
    if (rankMin !== null && !isNaN(rankMin)) { conditions.push(`${rankCol} >= $${p++}`); params.push(rankMin); }
    if (rankMax !== null && !isNaN(rankMax)) { conditions.push(`${rankCol} <= $${p++}`); params.push(rankMax); }
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ` ORDER BY l.price_eth ASC LIMIT 1`;

    const result = await pool.query(query, params);
    const r = result.rows[0];
    res.set('Cache-Control', 'public, max-age=30, s-maxage=30');
    res.json({
      ok: true,
      matches,
      groups,
      floor: r ? {
        token_id: parseInt(r.token_id),
        price_eth: parseFloat(r.price_eth),
        url: r.url,
        trait_count: r.trait_count ? parseInt(r.trait_count) : null,
        os_rank: r.os_rank ? parseInt(r.os_rank) : null,
        obs_rank: r.obs_rank ? parseInt(r.obs_rank) : null,
        os_score: r.os_score ? parseFloat(r.os_score) : null,
        rarity_score: r.rarity_score ? parseFloat(r.rarity_score) : null,
      } : null
    });
  } catch(e) {
    console.error('/db/multi-trait-floor error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── GET /db/rank-sales ────────────────────────────────────────────────────────
// Sales history filtered by OS rank range.
// Query params:
//   rank_min — minimum OS rank (default 1)
//   rank_max — maximum OS rank (default 100)
//   limit    — default 25, max 100
//   sort     — "desc" newest first (default) or "asc"
// Returns: { ok, rank_min, rank_max, sales: [{token_id, os_rank, price_eth, currency, sale_ts, buyer, seller}], count }
app.get('/db/rank-sales', auth, async (req, res) => {
  try {
    const rankMin = req.query.rank_min ? parseInt(req.query.rank_min) : 1;
    const rankMax = req.query.rank_max ? parseInt(req.query.rank_max) : 100;
    const limit   = Math.min(parseInt(req.query.limit || '25'), 100);
    const sort    = req.query.sort === 'asc' ? 'ASC' : 'DESC';
    // jv: same cross-collection bug class as the three fixes above --
    // sales/tokens/token_traits all span every collection, and every join
    // here matched purely on token_id. Every collection's own rank range
    // starts back at 1, so this would mix sales from an unrelated
    // collection whenever its os_rank happened to fall in the requested
    // range too. slug defaults to OCAS_SLUG, matching this file's existing
    // convention.
    const slug = (req.query.slug || OCAS_SLUG).toLowerCase();

    const result = await pool.query(
      `SELECT s.token_id, t.os_rank, t.obs_rank, s.price_eth, s.currency, s.sale_ts, s.buyer, s.seller,
              jsonb_build_object(
                '__attributes',
                COALESCE(
                  jsonb_agg(
                    jsonb_build_object('trait_type', tt.trait_name, 'value', tt.trait_value)
                    ORDER BY COALESCE(tt.trait_index, 0), tt.trait_name
                  ) FILTER (WHERE tt.trait_name IS NOT NULL),
                  '[]'::jsonb
                )
              ) AS traits
       FROM sales s
       JOIN tokens t ON t.id = s.token_id AND t.collection_slug = s.collection_slug
       LEFT JOIN token_traits tt ON tt.token_id = s.token_id AND tt.collection_slug = s.collection_slug
       WHERE s.collection_slug = $4 AND t.os_rank >= $1 AND t.os_rank <= $2
       GROUP BY s.token_id, t.os_rank, t.obs_rank, s.price_eth, s.currency, s.sale_ts, s.buyer, s.seller
       ORDER BY s.sale_ts ${sort}
       LIMIT $3`,
      [rankMin, rankMax, limit, slug]
    );

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      rank_min: rankMin,
      rank_max: rankMax,
      sales: result.rows.map(r => ({
        token_id:  parseInt(r.token_id),
        os_rank:   r.os_rank   ? parseInt(r.os_rank)   : null,
        obs_rank:  r.obs_rank  ? parseInt(r.obs_rank)  : null,
        price_eth: parseFloat(r.price_eth),
        currency:  r.currency || 'ETH',
        sale_ts:   r.sale_ts,
        buyer:     r.buyer  || null,
        seller:    r.seller || null,
        traits:    r.traits || {},
      })),
      count: result.rows.length
    });
  } catch(e) {
    console.error('/db/rank-sales error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/rank-listings ─────────────────────────────────────────────────────
// Currently listed tokens filtered by OS rank range, sorted by price.
// Query params:
//   rank_min — minimum OS rank (e.g. 1)
//   rank_max — maximum OS rank (e.g. 100)
//   rank_type — "os" (default) or "obs" (TraitView rank)
//   limit    — default 25, max 100
// Returns: { ok, listings: [{token_id, os_rank, obs_rank, price_eth, url}], count }
app.get('/db/rank-listings', auth, async (req, res) => {
  try {
    const rankMin  = req.query.rank_min ? parseInt(req.query.rank_min) : 1;
    const rankMax  = req.query.rank_max ? parseInt(req.query.rank_max) : 100;
    const rankType = req.query.rank_type === 'obs' ? 'obs' : 'os';
    const limit    = Math.min(parseInt(req.query.limit || '25'), 100);
    const rankCol  = rankType === 'obs' ? 't.obs_rank' : 't.os_rank';
    // jv: same cross-collection bug class as several other endpoints fixed
    // tonight -- no collection_slug filter anywhere in this query at all.
    // slug defaults to OCAS_SLUG, matching this file's existing convention.
    const slug = (req.query.slug || OCAS_SLUG).toString();

    // Include traits so the Discord bot doesn't need extra /db/token calls per result
    const result = await pool.query(
      `SELECT t.id AS token_id, t.obs_rank, t.os_rank, t.os_score, t.trait_count,
              l.price_eth, l.url,
              jsonb_build_object(
                '__attributes',
                COALESCE(
                  jsonb_agg(
                    jsonb_build_object('trait_type', tt.trait_name, 'value', tt.trait_value)
                    ORDER BY COALESCE(tt.trait_index, 0), tt.trait_name
                  ) FILTER (WHERE tt.trait_name IS NOT NULL),
                  '[]'::jsonb
                )
              ) AS traits
       FROM tokens t
       JOIN listings l ON l.token_id = t.id AND l.collection_slug = t.collection_slug
       LEFT JOIN token_traits tt ON tt.token_id = t.id AND tt.collection_slug = t.collection_slug
       WHERE t.collection_slug = $4 AND ${rankCol} >= $1 AND ${rankCol} <= $2
         AND ${ACTIVE_TOKEN_CONDITION}
       GROUP BY t.id, t.obs_rank, t.os_rank, t.os_score, t.trait_count, l.price_eth, l.url
       ORDER BY l.price_eth ASC
       LIMIT $3`,
      [rankMin, rankMax, limit, slug]
    );

    res.set('Cache-Control', 'public, max-age=30, s-maxage=30');
    res.json({
      ok: true,
      rank_type: rankType,
      rank_min: rankMin,
      rank_max: rankMax,
      listings: result.rows.map(r => ({
        token_id:    parseInt(r.token_id),
        obs_rank:    r.obs_rank ? parseInt(r.obs_rank) : null,
        os_rank:     r.os_rank     ? parseInt(r.os_rank)    : null,
        os_score:    r.os_score    ? parseFloat(r.os_score) : null,
        trait_count: r.trait_count ? parseInt(r.trait_count) : null,
        price_eth:   parseFloat(r.price_eth),
        url:         r.url,
        traits:      r.traits || {},
      })),
      count: result.rows.length
    });
  } catch(e) {
    console.error('/db/rank-listings error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── GET /db/os-ranks ──────────────────────────────────────────────────────────
// Lightweight endpoint — returns os_rank for all tokens.
// Used by TraitView to populate OS_RANK_MAP on init.
// Returns: { ok, ranks: [[id, os_rank], ...] }  (compact array format)
// Confirmed live: this query had ZERO collection scoping at all -- always
// returned every token across every collection with an os_rank value
// (in practice, only ever OCAS's, since no other collection has ever had
// this populated), regardless of which collection was actually requesting.
// TraitView's mobile fast-path trusts OS_RANK_MAP once it's non-empty,
// so viewing Argonauts (or any other collection) silently pulled in
// OCAS's own token IDs and ranks instead -- those then failed to match
// the actual collection's live listings, producing "No matches" until
// the user's next action happened to bypass this fast path entirely.
app.get('/db/os-ranks', auth, async (req, res) => {
  try {
    const slug = (req.query.slug || OCAS_SLUG).toString();
    const result = await pool.query(
      `SELECT id, os_rank FROM tokens WHERE os_rank IS NOT NULL AND collection_slug = $1 ORDER BY os_rank ASC`,
      [slug]
    );
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.json({
      ok: true,
      ranks: result.rows.map(r => [parseInt(r.id), parseInt(r.os_rank)]),
      count: result.rows.length
    });
  } catch(e) {
    console.error('/db/os-ranks error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── GET /db/trait-count-floor ─────────────────────────────────────────────────
// Cheapest listed token with a specific trait count.
// One DB query — no bot-side scanning needed.
// Query params: trait_count (required)
// Returns: { ok, floor: {token_id, price_eth, url, trait_count, os_rank, obs_rank} | null }
app.get('/db/trait-count-floor', auth, async (req, res) => {
  try {
    const traitCount = parseInt(req.query.trait_count);
    if (!traitCount || isNaN(traitCount)) {
      return res.status(400).json({ ok: false, error: 'trait_count is required' });
    }
    // jv: same cross-collection bug class as several other endpoints fixed
    // tonight -- no collection_slug filter anywhere in this query. slug
    // defaults to OCAS_SLUG, matching this file's existing convention.
    const slug = (req.query.slug || OCAS_SLUG).toString();
    const result = await pool.query(`
      SELECT l.token_id, l.price_eth, l.url,
             t.trait_count, t.os_rank, t.obs_rank
      FROM listings l
      JOIN tokens t ON t.id = l.token_id AND t.collection_slug = l.collection_slug
      WHERE l.collection_slug = $2 AND t.trait_count = $1
      ORDER BY l.price_eth ASC
      LIMIT 1
    `, [traitCount, slug]);

    res.set('Cache-Control', 'public, max-age=30, s-maxage=30');
    res.json({
      ok: true,
      floor: result.rows.length ? {
        token_id:    parseInt(result.rows[0].token_id),
        price_eth:   parseFloat(result.rows[0].price_eth),
        url:         result.rows[0].url,
        trait_count: parseInt(result.rows[0].trait_count),
        os_rank:     result.rows[0].os_rank  ? parseInt(result.rows[0].os_rank)  : null,
        obs_rank:    result.rows[0].obs_rank ? parseInt(result.rows[0].obs_rank) : null,
      } : null
    });
  } catch(e) {
    console.error('/db/trait-count-floor error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Wallet analytics helpers ─────────────────────────────────────────────────
function isEthAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || '').trim());
}
function cleanAddress(addr) {
  return normalizeEthAddress(addr);
}
// jv: "figure that out" -- re: combining Wallet Analytics (P&L, cost
// basis, top tokens) across every Discord-linked wallet, not just the
// one connected in the browser. Every /db/wallet/:address/* endpoint
// below took exactly one address in the path; this lets the frontend
// pass a comma-separated list instead (:address stays one URL segment
// either way, just potentially multi-valued), parsed into a clean,
// deduplicated array here once rather than reimplementing this same
// split/clean/validate logic in each of the 5 endpoints. Returns null
// if ANY segment is invalid, so a typo'd address fails the whole
// request loudly instead of silently querying a partial, wrong set.
function parseWalletAddresses(param) {
  const parts = String(param || '').split(',').map(s => cleanAddress(s.trim())).filter(Boolean);
  if (!parts.length || !parts.every(isEthAddress)) return null;
  return [...new Set(parts)];
}
function intParam(value, fallback, max) {
  const n = parseInt(value || fallback, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}
function isMissingWalletAnalyticsTable(e) {
  return e?.code === '42P01' || /nft_transfers|wallet_token_intervals|wallet_daily_snapshots|wallet_analytics_cache/i.test(e?.message || '');
}
function emptyWalletResponse(address, extra = {}) {
  return { ok: true, address, synced: false, ...extra };
}

function isMissingBurnTable(e) {
  return e?.code === '42P01' || /burn_events|burn_event_inputs/i.test(e?.message || '');
}
function isMissingBurnRankData(e) {
  return e?.code === '42P01' || e?.code === '42703' || /tokens|os_rank|obs_rank/i.test(e?.message || '');
}
function burnLimitParam(value, fallback = 25, max = 100) {
  const n = parseInt(value || fallback, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}
function burnNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function burnIdArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(v => parseInt(v, 10)).filter(Number.isFinite);
}
function burnEventJson(row) {
  const inputTokenIds = burnIdArray(row.input_token_ids);
  return {
    burn_event_id: burnNum(row.burn_event_id),
    tx_hash: row.tx_hash || null,
    log_index: burnNum(row.log_index),
    block_number: burnNum(row.block_number),
    burn_ts: row.burned_at || row.burn_ts || null,
    wallet: row.burner_wallet || row.wallet || null,
    created_token_id: burnNum(row.survivor_token_id || row.created_token_id),
    input_token_ids: inputTokenIds,
    input_count: burnNum(row.input_count) ?? inputTokenIds.length,
    points_used: burnNum(row.points_used),
    snapshot_image: row.snapshot_image || null,
  };
}
// Batch-fetch pre-burn snapshot images for a set of (likely destroyed) input
// token IDs, keyed by token_id. Uses token_image_snapshots — the same table
// the bot's Discord /burnhistory command reads for "what did this token look
// like right before it was destroyed" (see lib/images.js's
// fetchSnapshotImageForToken). token_image_snapshots is OCAS-only and
// priority-protected so a 'burn-start-input' row, once written, is never
// overwritten by a lower-priority source — so this is safe to treat as a
// permanent historical record, not something that could silently go stale.
// NOTE: column names here (image_data, source) match every real read/write
// site in lib/images.js — lib/db.js's CREATE TABLE stub uses different names
// (image_url/image_source) and is known-stale; verify with \d token_image_snapshots
// before relying on this in production.
async function fetchInputSnapshots(tokenIds) {
  const ids = burnIdArray(tokenIds);
  if (!ids.length) return {};
  try {
    // token_image_snapshots is normally the correct bulk-archived pre-burn
    // state for the original 10,000 tokens, but its rows can get
    // overwritten by the burn-poller's own "burn-start-input" write path
    // (source column confirms this) for tokens that are simultaneously an
    // input AND the resulting survivor of the same burn transaction --
    // that write captures "state at the moment of being fed in", not the
    // true original mint state, and for a self-referential burn those two
    // moments coincide, silently corrupting what should be a fixed
    // historical record. token_original_snapshots doesn't have this
    // problem (populated via a real backfill, not live burn processing),
    // so prefer it wherever it has a row, falling back to
    // token_image_snapshots only where it doesn't -- can only improve
    // accuracy, never lose data that was already being shown.
    const [originalRes, imageRes] = await Promise.all([
      pool.query(
        `SELECT token_id, image_data FROM token_original_snapshots WHERE token_id = ANY($1::int[]) AND image_data IS NOT NULL`,
        [ids]
      ),
      pool.query(
        `SELECT token_id, image_data FROM token_image_snapshots WHERE token_id = ANY($1::int[]) AND image_data IS NOT NULL`,
        [ids]
      ),
    ]);
    const map = {};
    for (const r of imageRes.rows) map[String(r.token_id)] = r.image_data; // fallback layer first
    for (const r of originalRes.rows) map[String(r.token_id)] = r.image_data; // preferred layer overwrites it where present
    return map;
  } catch (e) {
    console.warn('[fetchInputSnapshots]', e.message);
    return {};
  }
}

// Bulk map of survivor_token_id -> its CURRENT (latest) image, straight from
// burn_state_snapshots. This is the one ground-truth source that's actually
// kept correct as of the most recent burn a token won -- confirmed directly
// via /db/token/:id/burn-history working correctly for tokens where other
// image paths were wrong. tokens.image_url (used previously by /db/all-traits)
// is written live by lib/burn-poller.js at burn-finalization time, but has
// confirmed historical gaps (see check-live-metadata-gaps.js,
// backfill-missing-survivor-images.js) -- so treat it as a secondary
// fallback, not the primary source, wherever a token needs its current image.
// tokenIds: optional array to scope the query (e.g. one wallet's holdings);
// omit for the full collection-wide map.
async function getSurvivorImageMap(tokenIds = null) {
  const scoped = Array.isArray(tokenIds) && tokenIds.length > 0;
  const sql = `
    SELECT DISTINCT ON (be.survivor_token_id) be.survivor_token_id AS token_id, bss.image_data
    FROM burn_events be
    JOIN burn_state_snapshots bss ON bss.burn_event_id = be.id AND bss.token_id = be.survivor_token_id
    WHERE bss.image_data IS NOT NULL
      ${scoped ? 'AND be.survivor_token_id = ANY($1::int[])' : ''}
    ORDER BY be.survivor_token_id, be.burned_at DESC, be.id DESC
  `;
  const result = await pool.query(sql, scoped ? [tokenIds.map(id => parseInt(id))] : []);
  const map = {};
  for (const r of result.rows) map[parseInt(r.token_id)] = r.image_data;
  return map;
}
function burnEndpointError(res, route, e, fallback = {}) {
  console.error(`${route} error:`, e.message);
  if (isMissingBurnTable(e)) {
    return res.status(500).json({ ok: false, error: 'burn analytics tables are not available', ...fallback });
  }
  return res.status(500).json({ ok: false, error: e.message, ...fallback });
}

// ── GET /db/token/:id/burn-history ───────────────────────────────────────────
// Full lifecycle timeline for a token: original mint state (position 0), then
// one entry per burn it ever survived (position 1..N, each using the
// corrected burn_state_snapshots data from the 2026-07-06 repair), plus
// whether it was later destroyed as fuel in a subsequent burn. Powers the
// TraitView modal's pre-burn history toggle.
app.get('/db/token/:id/burn-history', auth, async (req, res) => {
  const tokenId = parseInt(req.params.id, 10);
  if (!Number.isFinite(tokenId)) return res.status(400).json({ ok: false, error: 'invalid token id' });
  // token_original_snapshots/burn_state_snapshots store the full internal
  // trait object, which includes __image and __attributes (used elsewhere
  // for image resolution and preserving raw attribute order). Neither
  // belongs in what the client displays as "traits" -- image is already
  // returned as its own top-level field on each timeline entry, and
  // __attributes is a duplicate array form. Strip both before sending.
  const cleanTraits = (t) => {
    if (!t || typeof t !== 'object') return t;
    const { __image, __attributes, ...rest } = t;
    return rest;
  };
  try {
    const survivorEvents = await pool.query(
      `SELECT id, tx_hash, burned_at FROM burn_events WHERE survivor_token_id=$1 ORDER BY burned_at ASC, id ASC`,
      [tokenId]
    );

    const mint = await pool.query(
      `SELECT image_data, traits_json FROM token_original_snapshots WHERE token_id=$1`,
      [tokenId]
    );

    const timeline = [];
    if (mint.rows.length) {
      const m = mint.rows[0];
      const traitsObj = typeof m.traits_json === 'string' ? JSON.parse(m.traits_json) : m.traits_json;
      timeline.push({
        position: 0,
        label: 'Original Mint',
        burn_event_id: null,
        tx_hash: null,
        burned_at: null,
        traits: cleanTraits(traitsObj),
        image: m.image_data || null,
      });
    }

    if (survivorEvents.rows.length) {
      const eventIds = survivorEvents.rows.map(r => r.id);
      const snaps = await pool.query(
        `SELECT burn_event_id, image_data, traits_json FROM burn_state_snapshots WHERE token_id=$1 AND burn_event_id = ANY($2::int[])`,
        [tokenId, eventIds]
      );
      const snapMap = {};
      for (const s of snaps.rows) snapMap[s.burn_event_id] = s;

      survivorEvents.rows.forEach((ev, i) => {
        const snap = snapMap[ev.id];
        const traitsObj = snap?.traits_json ? (typeof snap.traits_json === 'string' ? JSON.parse(snap.traits_json) : snap.traits_json) : null;
        timeline.push({
          position: i + 1,
          label: `After Burn ${i + 1}`,
          burn_event_id: ev.id,
          tx_hash: ev.tx_hash,
          burned_at: ev.burned_at,
          traits: cleanTraits(traitsObj),
          image: snap?.image_data || null,
        });
      });
    }

    // Was this token later fed as fuel into a DIFFERENT burn (genuinely
    // destroyed, not just a survivor of its own history)?
    const destroyed = await pool.query(`
      SELECT be.id AS burn_event_id, be.tx_hash, be.burned_at, be.survivor_token_id
      FROM burn_event_inputs bei
      JOIN burn_events be ON be.id = bei.burn_event_id
      WHERE bei.burned_token_id = $1 AND bei.burned_token_id != be.survivor_token_id
      ORDER BY be.burned_at DESC LIMIT 1
    `, [tokenId]);

    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      ok: true,
      token_id: tokenId,
      timeline,
      survivor_count: survivorEvents.rows.length,
      destroyed_in: destroyed.rows[0] ? {
        burn_event_id: destroyed.rows[0].burn_event_id,
        tx_hash: destroyed.rows[0].tx_hash,
        burned_at: destroyed.rows[0].burned_at,
        survivor_token_id: destroyed.rows[0].survivor_token_id,
      } : null,
    });
  } catch (e) {
    // Argonauts (and any other collection onboarded without OCAS's burn/
    // rebirth game) gets its burn_events table from this same schema-init
    // function, which only ever defines the small columns actually used
    // there (id, tx_hash, block_number, burned_token_id, survivor_token_id,
    // burn_type, created_at) -- OCAS's real production table has many more
    // (burner_wallet, burned_at, points_used, etc.) added out-of-band over
    // time and never backported here. Querying burned_at against one of
    // those other, burn-game-less collections throws "column does not
    // exist" (42703) -- correctly meaning "this collection has no burn
    // game, so this token was never part of one," same as a real 0-row
    // result would for OCAS itself. Treat it as exactly that instead of a
    // 500, so the modal's pre-burn toggle stays silent rather than erroring
    // on every open for every non-OCAS collection.
    if (e?.code === '42703') {
      return res.json({ ok: true, token_id: tokenId, timeline: [], survivor_count: 0, destroyed_in: null });
    }
    console.error('/db/token/:id/burn-history error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/survivor-counts ───────────────────────────────────────────────────
// Bulk map of token_id -> number of times it has ever been a burn survivor.
// Loaded once at page init (like OS ranks) so the grid/modal can show a
// "Survivor" / "Survivor x2" badge without a per-token API call.
let _survivorCountsCache = null;
let _survivorCountsCacheTs = 0;
const SURVIVOR_COUNTS_TTL = 5 * 60 * 1000;
app.get('/db/survivor-counts', auth, async (req, res) => {
  try {
    const now = Date.now();
    if (_survivorCountsCache && (now - _survivorCountsCacheTs) < SURVIVOR_COUNTS_TTL) {
      return res.json(_survivorCountsCache);
    }
    const result = await pool.query(
      `SELECT survivor_token_id, COUNT(*)::int AS c FROM burn_events GROUP BY survivor_token_id`
    );
    const counts = {};
    for (const r of result.rows) counts[r.survivor_token_id] = r.c;
    _survivorCountsCache = { ok: true, counts };
    _survivorCountsCacheTs = now;
    res.json(_survivorCountsCache);
  } catch (e) {
    console.error('/db/survivor-counts error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/survivor-images ────────────────────────────────────────────────
// Bulk map of token_id -> current (latest) image for every token that has
// ever been a burn survivor, sourced from burn_state_snapshots -- the same
// ground-truth data /db/token/:id/burn-history already uses. Exists because
// the grid/wallet's default image source is a static, build-time manifest
// of each token's ORIGINAL appearance, and the fallback for survivors was a
// live OpenSea lookup that depends on OpenSea having already re-indexed the
// updated tokenURI -- confirmed unreliable directly (token #4527 still
// served pre-burn art from OpenSea after two burns). Same TTL-cache pattern
// as /db/survivor-counts so the grid/wallet can load this once at init
// instead of a per-token call.
let _survivorImagesCache = null;
let _survivorImagesCacheTs = 0;
const SURVIVOR_IMAGES_TTL = 5 * 60 * 1000;
app.get('/db/survivor-images', auth, async (req, res) => {
  try {
    const now = Date.now();
    if (_survivorImagesCache && (now - _survivorImagesCacheTs) < SURVIVOR_IMAGES_TTL) {
      return res.json(_survivorImagesCache);
    }
    const images = await getSurvivorImageMap();
    _survivorImagesCache = { ok: true, images };
    _survivorImagesCacheTs = now;
    res.json(_survivorImagesCache);
  } catch (e) {
    console.error('/db/survivor-images error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.get('/db/wallet/:address/favorites', auth, async (req, res) => {
  const address = cleanAddress(req.params.address);
  if (!isEthAddress(address)) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  const slug = (req.query.slug || OCAS_SLUG).toString();
  try {
    const r = await pool.query(
      `SELECT token_ids FROM wallet_favorites WHERE LOWER(wallet_address)=LOWER($1) AND collection_slug=$2`,
      [address, slug]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, address, slug, tokenIds: r.rows[0]?.token_ids || [] });
  } catch (e) {
    console.error('/db/wallet/:address/favorites GET error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PUT /db/wallet/:address/favorites — body: { slug, tokenIds:[1,2,3] } ────
// Full-array replace, matching the existing localStorage saveFavorites() model
// exactly (always writes the whole current set, not incremental add/remove).
app.put('/db/wallet/:address/favorites', auth,
  rateLimit({ max: 30, windowMs: 60 * 60 * 1000, keyFn: req => 'favwrite:' + String(req.params.address || '').toLowerCase() }),
  async (req, res) => {
  const address = cleanAddress(req.params.address);
  if (!isEthAddress(address)) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  const slug = (req.body?.slug || OCAS_SLUG).toString();
  const tokenIds = Array.isArray(req.body?.tokenIds)
    ? [...new Set(req.body.tokenIds.map(Number).filter(n => Number.isFinite(n) && n > 0))]
    : [];
  try {
    await pool.query(
      `INSERT INTO wallet_favorites (wallet_address, collection_slug, token_ids, updated_at)
       VALUES (LOWER($1), $2, $3::jsonb, NOW())
       ON CONFLICT (wallet_address, collection_slug) DO UPDATE SET token_ids=EXCLUDED.token_ids, updated_at=NOW()`,
      [address, slug, JSON.stringify(tokenIds)]
    );
    res.json({ ok: true, address, slug, count: tokenIds.length });
  } catch (e) {
    console.error('/db/wallet/:address/favorites PUT error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// Current derived wallet summary. Returns empty data if wallet sync has not run.
app.get('/db/wallet/:address/summary', auth, async (req, res) => {
  const addresses = parseWalletAddresses(req.params.address);
  if (!addresses) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  const address = addresses[0]; // kept for the response's own `address` field and error paths below
  // Confirmed live: jv reported never getting any wallet holdings for
  // Argonauts. Traced to this route specifically -- the note below (from
  // 2026-07-02) already flagged this exact hardcoding as a known gap, but
  // it was never actually applied here despite the fix landing on other
  // endpoints (/db/traits-fast, /db/all-traits) the same day. The frontend's
  // dbFetch() helper already sends the active collection's own slug on
  // every request (confirmed in traitview/js/api.js) -- this route just
  // never read it, so every wallet summary was silently computed against
  // OCAS's own token/listing/interval rows regardless of which collection's
  // site the request actually came from. Same (req.query.slug || OCAS_SLUG)
  // convention already used elsewhere in this file (e.g. /db/traits-fast).
  const slug = (req.query.slug || OCAS_SLUG).toString();
  try {
    // Removed the wallet_analytics_cache short-circuit that used to sit
    // here. That table has no collection_slug column at all, keyed only by
    // wallet_address -- so any wallet with a pre-existing cached row from
    // earlier OCAS-only testing would keep getting that stale, OCAS-scoped
    // row served back regardless of the slug fix below, since this check
    // ran and returned before the fixed query ever executed. A previous
    // session's own diagnostic script (diag-check-wallet-cache.js) was
    // built to detect exactly this failure mode for a different symptom,
    // which is exactly what jv just hit here: traits worked (no such cache
    // check exists on that route) while summary silently kept serving an
    // old cached response. Safe to drop entirely -- nothing in this
    // codebase currently writes to this table, so removing the read here
    // doesn't lose any live functionality, only a footgun.
    const current = await pool.query(`
      SELECT w.token_id, t.os_rank, t.obs_rank, l.price_eth, w.cost_eth
      FROM wallet_token_intervals w
      LEFT JOIN tokens t ON t.id = w.token_id AND t.collection_slug = w.collection_slug
      LEFT JOIN listings l ON l.token_id = w.token_id AND l.collection_slug = w.collection_slug
      WHERE w.wallet_address = ANY($1::text[]) AND w.collection_slug = $2 AND w.disposed_at IS NULL
      ORDER BY COALESCE(t.os_rank, t.obs_rank, 999999) ASC
      LIMIT 10000
    `, [addresses, slug]);

    const owned = current.rows;
    const ranks = owned.map(r => parseInt(r.os_rank || r.obs_rank)).filter(Number.isFinite);
    const listed = owned.filter(r => r.price_eth != null);
    const floor = await pool.query('SELECT MIN(price_eth) AS floor_eth FROM listings WHERE collection_slug = $1', [slug]);
    const floorEth = floor.rows[0]?.floor_eth ? parseFloat(floor.rows[0].floor_eth) : null;
    const estimated = floorEth == null ? null : owned.length * floorEth;

    // P&L: realized (closed positions with an actual sale) and unrealized
    // (current holdings' cost basis vs current estimated floor value).
    // Was completely missing from this endpoint before.
    const realizedRes = await pool.query(`
      SELECT COALESCE(SUM(sale_eth - cost_eth), 0) AS realized_pnl, COUNT(*)::int AS sold_count
      FROM wallet_token_intervals
      WHERE wallet_address = ANY($1::text[]) AND collection_slug = $2
        AND disposed_at IS NOT NULL AND sale_eth IS NOT NULL AND sale_eth > 0
    `, [addresses, slug]);
    const realizedPnl = parseFloat(realizedRes.rows[0]?.realized_pnl || 0);
    const soldCount = parseInt(realizedRes.rows[0]?.sold_count || 0);
    const totalCostBasis = owned.reduce((s, r) => s + (parseFloat(r.cost_eth) || 0), 0);
    const unrealizedPnl = (estimated != null && totalCostBasis > 0) ? (estimated - totalCostBasis) : null;

    // Current image for any owned token that's a burn survivor. The
    // frontend's default image source is a static, build-time-generated
    // manifest of each token's ORIGINAL appearance -- it has no way to
    // know a token evolved via a burn. It was falling back to a live
    // OpenSea lookup to catch this, but that depends on OpenSea's indexer
    // having already re-crawled the updated tokenURI, which lags or never
    // happens for infrequently-viewed tokens -- confirmed directly (token
    // #4527: OpenSea still served pre-burn art after two burns). This
    // reads the same burn_state_snapshots data /db/token/:id/burn-history
    // already uses (proven correct there), so top_tokens can carry the
    // real current image with zero dependency on a third party.
    const topSlice = owned.slice(0, 250);
    let survivorImageMap = {};
    if (topSlice.length) {
      try {
        survivorImageMap = await getSurvivorImageMap(topSlice.map(r => parseInt(r.token_id)));
      } catch (e) {
        console.warn('[/db/wallet/:address/summary] survivor image lookup failed (non-fatal):', e.message);
      }
    }

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      address,
      synced: true,
      cached: false,
      summary: {
        owned_count: owned.length,
        best_rank: ranks.length ? Math.min(...ranks) : null,
        listed_count: listed.length,
        estimated_floor_value: estimated,
        floor_eth: floorEth,
        realized_pnl: realizedPnl,
        sold_count: soldCount,
        unrealized_pnl: unrealizedPnl,
        total_cost_basis: totalCostBasis > 0 ? totalCostBasis : null,
        top_tokens: topSlice.map(r => ({
          token_id: parseInt(r.token_id),
          os_rank: r.os_rank ? parseInt(r.os_rank) : null,
          obs_rank: r.obs_rank ? parseInt(r.obs_rank) : null,
          price_eth: r.price_eth != null ? parseFloat(r.price_eth) : null,
          cost_eth: r.cost_eth != null ? parseFloat(r.cost_eth) : null,
          image: survivorImageMap[parseInt(r.token_id)] || null,
        })),
      },
    });
  } catch (e) {
    if (isMissingWalletAnalyticsTable(e)) return res.json(emptyWalletResponse(address, { summary: { owned_count: 0, best_rank: null, listed_count: 0, estimated_floor_value: null } }));
    console.error('/db/wallet/:address/summary error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/wallet/:address/transfers ────────────────────────────────────────
app.get('/db/wallet/:address/transfers', auth, async (req, res) => {
  const addresses = parseWalletAddresses(req.params.address);
  if (!addresses) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  const address = addresses[0];
  const limit = intParam(req.query.limit, 100, 1000);
  const offset = intParam(req.query.offset, 0, 10000);
  // Same hardcoded-to-OCAS bug as /db/wallet/:address/summary above, same
  // fix pattern -- resolve the actual requested collection's own contract
  // rather than assuming OCAS_CONTRACT/OCAS_SLUG.
  const slug = (req.query.slug || OCAS_SLUG).toString();
  try {
    const collRes = await pool.query('SELECT contract FROM collections WHERE slug = $1', [slug]);
    const contract = collRes.rows[0]?.contract || OCAS_CONTRACT;
    const result = await pool.query(`
      SELECT nt.contract, nt.token_id, nt.from_address, nt.to_address, nt.tx_hash, nt.log_index,
             nt.block_number, COALESCE(nt.block_ts, nt.transferred_at) AS block_ts, nt.event_type,
             s.price_eth AS sale_price, s.buyer, s.seller
      FROM nft_transfers nt
      LEFT JOIN sales s ON s.tx_hash = nt.tx_hash AND s.token_id = nt.token_id
      WHERE nt.contract = $1 AND nt.collection_slug = $2 AND (nt.from_address = ANY($3::text[]) OR nt.to_address = ANY($3::text[]))
      ORDER BY nt.block_number DESC, nt.log_index DESC
      LIMIT $4 OFFSET $5
    `, [contract, slug, addresses, limit, offset]);

    // Burns live in their own purpose-built tables (burn_events/burn_event_inputs),
    // separate from nft_transfers entirely -- pull them directly rather than
    // depend on nft_transfers.event_type, which isn't reliably populated for
    // every wallet's historical rows.
    const burnRes = await pool.query(`
      SELECT be.id AS burn_event_id, be.tx_hash, be.block_number, be.log_index, be.burned_at, be.survivor_token_id,
             be.points_used, be.burner_wallet, bei.burned_token_id
      FROM burn_events be
      JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
      WHERE LOWER(be.burner_wallet) = ANY($1::text[])
      ORDER BY be.block_number DESC
      LIMIT $2
    `, [addresses, limit]).catch(() => ({ rows: [] })); // tolerate if burn tables aren't present in some env

    // Same reasoning as everywhere else burn rows get displayed: a destroyed
    // input token no longer represents its original self, so a "current"
    // image lookup is wrong for it -- use its actual pre-burn snapshot.
    const burnInputIds = burnRes.rows.map(r => r.burned_token_id).filter(Boolean);
    const burnInputSnapshots = await fetchInputSnapshots(burnInputIds);

    res.set('Cache-Control', 'public, max-age=30, s-maxage=30');
    const transferRows = result.rows.map(r => ({
      contract: r.contract,
      token_id: parseInt(r.token_id),
      from_address: r.from_address,
      to_address: r.to_address,
      tx_hash: r.tx_hash,
      log_index: parseInt(r.log_index),
      block_number: parseInt(r.block_number),
      block_ts: r.block_ts,
      // Only override with 'sale' when a real sales-table match exists.
      // Otherwise pass event_type through as-is (including null/blank) --
      // the frontend already has a from/to zero-address fallback classifier
      // for mint/burn that a hardcoded 'transfer' default here was silently
      // preventing from ever running.
      event_type: r.sale_price != null ? 'sale' : (r.event_type || null),
      sale_price: r.sale_price != null ? parseFloat(r.sale_price) : null,
      buyer: r.buyer || null,
      seller: r.seller || null,
    }));
    const burnRows = burnRes.rows.map(r => ({
      contract: OCAS_CONTRACT,
      token_id: parseInt(r.burned_token_id),
      from_address: r.burner_wallet || address,
      to_address: null,
      tx_hash: r.tx_hash,
      log_index: r.log_index != null ? parseInt(r.log_index) : 0,
      block_number: parseInt(r.block_number),
      block_ts: r.burned_at,
      event_type: 'burn',
      sale_price: null,
      buyer: null,
      seller: null,
      survivor_token_id: r.survivor_token_id != null ? parseInt(r.survivor_token_id) : null,
      points_used: r.points_used != null ? parseInt(r.points_used) : null,
      burn_event_id: burnNum(r.burn_event_id),
      snapshot_image: burnInputSnapshots[r.burned_token_id] || null,
    }));
    const merged = [...transferRows, ...burnRows]
      .sort((a, b) => new Date(b.block_ts || 0) - new Date(a.block_ts || 0))
      .slice(0, limit);

    res.json({
      ok: true,
      address,
      contract: OCAS_CONTRACT,
      synced: true,
      transfers: merged,
      count: merged.length,
      limit,
      offset,
    });
  } catch (e) {
    if (isMissingWalletAnalyticsTable(e)) return res.json(emptyWalletResponse(address, { transfers: [], count: 0, limit, offset }));
    console.error('/db/wallet/:address/transfers error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/wallet/:address/burn-stats ───────────────────────────────────────
// Personal burn history/stats for a wallet, from the authoritative burn_events
// / burn_event_inputs tables (confirmed live schema, not the CREATE TABLE
// statement in lib/db.js which is missing several real columns).
app.get('/db/wallet/:address/burn-stats', auth, async (req, res) => {
  const addresses = parseWalletAddresses(req.params.address);
  if (!addresses) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  const address = addresses[0];
  try {
    const eventsRes = await pool.query(`
      SELECT id, tx_hash, block_number, burned_at, survivor_token_id, points_used,
             result_is_angel, boost_chance, result_body_type, burn_type
      FROM burn_events
      WHERE LOWER(burner_wallet) = ANY($1::text[])
      ORDER BY block_number DESC
    `, [addresses]);
    const events = eventsRes.rows;
    if (!events.length) {
      return res.json({
        ok: true, address, burnCount: 0, tokensConsumed: 0,
        survivorsCreated: 0, totalPoints: 0, angelCount: 0, events: [], input_snapshots: {},
      });
    }
    const eventIds = events.map(e => e.id);
    const inputsRes = await pool.query(
      `SELECT burn_event_id, burned_token_id FROM burn_event_inputs WHERE burn_event_id = ANY($1)`,
      [eventIds]
    );
    const inputsByEvent = {};
    for (const row of inputsRes.rows) {
      (inputsByEvent[row.burn_event_id] ||= []).push(parseInt(row.burned_token_id));
    }
    const totalPoints = events.reduce((s, e) => s + (parseInt(e.points_used) || 0), 0);
    const angelCount = events.filter(e => e.result_is_angel).length;
    const survivorsCreated = new Set(events.map(e => e.survivor_token_id).filter(Boolean)).size;

    // Same reasoning as /db/burn-latest and /db/burn-best: the survivor's
    // thumbnail here needs THIS event's post-burn snapshot (not a current
    // lookup, since this same survivor may show up in several of the
    // wallet's own burn rows, each a different point in its history), and
    // the destroyed input tokens need their pre-burn snapshot since a
    // "current" lookup is meaningless for a token that no longer exists as
    // its original self. This endpoint never had either wired in before.
    const survivorSnapsRes = await pool.query(
      `SELECT burn_event_id, image_data FROM burn_state_snapshots WHERE burn_event_id = ANY($1::int[])`,
      [eventIds]
    );
    const survivorSnapMap = {};
    for (const r of survivorSnapsRes.rows) survivorSnapMap[r.burn_event_id] = r.image_data;

    const allInputIds = inputsRes.rows.map(r => r.burned_token_id);

    // A token fed into a burn isn't necessarily destroyed -- it can BE the
    // survivor, evolving instead (confirmed directly: token #2941 here has
    // survived twice, with a genuinely different look each time per its own
    // History tab). A plain token_id-keyed "pre-burn" lookup breaks for any
    // such token, since it's had more than one true "pre-burn" moment in its
    // life, not just one. The correct image for token X as an input to event
    // E is whatever it looked like the last time it became a survivor,
    // before E -- burn_state_snapshots already stores exactly that, per
    // (token_id, burn_event_id), it just wasn't being consulted here.
    const priorSnapsRes = await pool.query(
      `SELECT bss.token_id, bss.burn_event_id, bss.image_data, be.block_number
       FROM burn_state_snapshots bss
       JOIN burn_events be ON be.id = bss.burn_event_id
       WHERE bss.token_id = ANY($1::int[])`,
      [allInputIds]
    );
    const priorSnapsByToken = {};
    for (const r of priorSnapsRes.rows) {
      (priorSnapsByToken[r.token_id] ||= []).push({ blockNumber: parseInt(r.block_number), image: r.image_data });
    }
    for (const list of Object.values(priorSnapsByToken)) list.sort((a, b) => a.blockNumber - b.blockNumber);

    function resolveInputImage(tokenId, currentEventBlockNumber, fallbackMap) {
      const candidates = priorSnapsByToken[tokenId] || [];
      // Most recent prior survivor-state strictly before this event -- that
      // is what this token actually looked like right before being fed in.
      let best = null;
      for (const c of candidates) {
        if (c.blockNumber < currentEventBlockNumber && (!best || c.blockNumber > best.blockNumber)) best = c;
      }
      if (best) return best.image;
      // Never survived a prior burn -- this is its first and only
      // burn-related appearance, so the plain mint-time/first snapshot is
      // correct as-is.
      return fallbackMap[tokenId] || null;
    }

    const originalSnapshots = await fetchInputSnapshots(allInputIds);
    const inputSnapshots = {};
    for (const e of events) {
      for (const tokenId of (inputsByEvent[e.id] || [])) {
        inputSnapshots[`${e.id}:${tokenId}`] = resolveInputImage(tokenId, parseInt(e.block_number), originalSnapshots);
      }
    }

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      address,
      burnCount: events.length,
      tokensConsumed: inputsRes.rows.length,
      survivorsCreated,
      totalPoints,
      angelCount,
      input_snapshots: inputSnapshots,
      events: events.slice(0, 100).map(e => ({
        burnEventId: e.id,
        txHash: e.tx_hash,
        blockNumber: parseInt(e.block_number),
        burnedAt: e.burned_at,
        survivorTokenId: e.survivor_token_id != null ? parseInt(e.survivor_token_id) : null,
        survivorSnapshotImage: survivorSnapMap[e.id] || null,
        pointsUsed: e.points_used != null ? parseInt(e.points_used) : null,
        isAngel: !!e.result_is_angel,
        bodyType: e.result_body_type || null,
        burnType: e.burn_type || null,
        burnedTokenIds: inputsByEvent[e.id] || [],
      })),
    });
  } catch (e) {
    console.error('/db/wallet/:address/burn-stats error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/wallet/:address/history ──────────────────────────────────────────
app.get('/db/wallet/:address/history', auth, async (req, res) => {
  const addresses = parseWalletAddresses(req.params.address);
  if (!addresses) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  const address = addresses[0];
  const days = intParam(req.query.days, 90, 365);
  try {
    // wallet_daily_snapshots is one row per wallet per day -- a plain
    // `wallet_address = ANY($1)` swap here would return N rows per date
    // (one per linked wallet) instead of one combined row for the
    // frontend's chart, which expects exactly one point per date. GROUP BY
    // date and SUM the per-wallet counts/values (best_rank uses MIN, since
    // a lower rank number is better -- this wallet SET's best rank is
    // whichever single wallet's best rank was lowest that day, not a sum).
    const result = await pool.query(`
      SELECT snapshot_date,
             SUM(owned_count)::int AS owned_count,
             MIN(best_rank) AS best_rank,
             SUM(listed_count)::int AS listed_count,
             SUM(estimated_floor_value) AS estimated_floor_value
      FROM wallet_daily_snapshots
      WHERE wallet_address = ANY($1::text[])
        AND snapshot_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
      GROUP BY snapshot_date
      ORDER BY snapshot_date ASC
    `, [addresses, days]);
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      ok: true,
      address,
      synced: true,
      history: result.rows.map(r => ({
        snapshot_date: r.snapshot_date,
        owned_count: parseInt(r.owned_count),
        best_rank: r.best_rank ? parseInt(r.best_rank) : null,
        listed_count: parseInt(r.listed_count),
        estimated_floor_value: r.estimated_floor_value != null ? parseFloat(r.estimated_floor_value) : null,
      })),
      count: result.rows.length,
      days,
    });
  } catch (e) {
    if (isMissingWalletAnalyticsTable(e)) return res.json(emptyWalletResponse(address, { history: [], count: 0, days }));
    console.error('/db/wallet/:address/history error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/wallet/:address/traits ───────────────────────────────────────────
app.get('/db/wallet/:address/traits', auth, async (req, res) => {
  const addresses = parseWalletAddresses(req.params.address);
  if (!addresses) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  const address = addresses[0];
  const limit = intParam(req.query.limit, 100, 500);
  // Same hardcoded-to-OCAS bug as /db/wallet/:address/summary, same fix.
  const slug = (req.query.slug || OCAS_SLUG).toString();
  try {
    const result = await pool.query(`
      SELECT tt.trait_name, tt.trait_value, COUNT(*)::int AS count,
             ARRAY_AGG(w.token_id ORDER BY COALESCE(t.os_rank, t.obs_rank, 999999) ASC) AS token_ids
      FROM wallet_token_intervals w
      JOIN token_traits tt ON tt.token_id = w.token_id AND tt.collection_slug = w.collection_slug
      LEFT JOIN tokens t ON t.id = w.token_id AND t.collection_slug = w.collection_slug
      WHERE w.wallet_address = ANY($1::text[]) AND w.collection_slug = $3 AND w.disposed_at IS NULL
      GROUP BY tt.trait_name, tt.trait_value
      ORDER BY count DESC, tt.trait_name ASC, tt.trait_value ASC
      LIMIT $2
    `, [addresses, limit, slug]);
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      ok: true,
      address,
      synced: true,
      traits: result.rows.map(r => ({
        trait_name: r.trait_name,
        trait_value: r.trait_value,
        count: parseInt(r.count),
        token_ids: (r.token_ids || []).map(Number).filter(Number.isFinite),
      })),
      count: result.rows.length,
    });
  } catch (e) {
    if (isMissingWalletAnalyticsTable(e)) return res.json(emptyWalletResponse(address, { traits: [], count: 0 }));
    console.error('/db/wallet/:address/traits error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/token/:id/history ────────────────────────────────────────────────
app.get('/db/token/:id/history', auth, async (req, res) => {
  const tokenId = parseInt(req.params.id, 10);
  if (isNaN(tokenId) || tokenId < 0 || tokenId > 10_000_000) return res.status(400).json({ ok: false, error: 'invalid token id' }); // generous, collection-agnostic bound — see /db/token/:id above for why
  const limit = intParam(req.query.limit, 100, 200);
  // Same hardcoded-to-OCAS bug as /db/wallet/:address/transfers had, same fix:
  // resolve the actual requested collection's own contract via the collections
  // registry rather than assuming OCAS_CONTRACT/OCAS_SLUG regardless of slug.
  const slug = (req.query.slug || OCAS_SLUG).toString();
  try {
    const collRes = await pool.query('SELECT contract FROM collections WHERE slug = $1', [slug]);
    const contract = collRes.rows[0]?.contract || OCAS_CONTRACT;
    const result = await pool.query(`
      SELECT contract, token_id, from_address, to_address, tx_hash, log_index, block_number,
             COALESCE(block_ts, transferred_at) AS block_ts, event_type
      FROM nft_transfers
      WHERE contract = $1 AND collection_slug = $2 AND token_id = $3
      ORDER BY block_number ASC, log_index ASC
      LIMIT $4
    `, [contract, slug, tokenId, limit]);
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      ok: true,
      token_id: tokenId,
      contract,
      synced: true,
      history: result.rows.map(r => ({
        contract: r.contract,
        token_id: parseInt(r.token_id),
        from_address: r.from_address,
        to_address: r.to_address,
        tx_hash: r.tx_hash,
        log_index: parseInt(r.log_index),
        block_number: parseInt(r.block_number),
        block_ts: r.block_ts,
        event_type: r.event_type,
      })),
      count: result.rows.length,
    });
  } catch (e) {
    if (isMissingWalletAnalyticsTable(e) || e?.code === '42703') return res.json({ ok: true, token_id: tokenId, synced: false, history: [], count: 0 });
    console.error('/db/token/:id/history error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Burn analytics endpoints ─────────────────────────────────────────────────
// GET /db/burn-stats
app.get('/db/burn-stats', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (
          SELECT COUNT(DISTINCT bei.burned_token_id)::int
          FROM burn_event_inputs bei
          JOIN burn_events be ON be.id = bei.burn_event_id
          WHERE bei.burned_token_id != be.survivor_token_id
        ) AS tokens_burned,
        (SELECT COUNT(*)::int FROM burn_events) AS tokens_created
    `);
    const tokensBurned = parseInt(result.rows[0]?.tokens_burned || 0, 10);
    const tokensCreated = parseInt(result.rows[0]?.tokens_created || 0, 10);
    // NOTE (2026-07-02): previously subtracted tokensCreated too
    // (10000 - (tokensBurned - tokensCreated)), as if each burn event
    // minted a brand new token back into supply. It doesn't — the
    // survivor is one of the existing input tokens transformed in place,
    // already counted in the original 10000, not a new mint. That extra
    // subtraction inflated estimated_supply by exactly tokensCreated
    // (confirmed: showed 8911 instead of the correct 8599 = 10000-1401,
    // which matches both OpenSea and commands/burn.js's /burnstats,
    // whose formula (10000 - burned) is what this now matches exactly.

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      tokens_burned: tokensBurned,
      tokens_created: tokensCreated,
      supply_reduced_by: tokensBurned,
      estimated_supply: 10000 - tokensBurned,
    });
  } catch (e) {
    burnEndpointError(res, '/db/burn-stats', e, {
      tokens_burned: null,
      tokens_created: null,
      supply_reduced_by: null,
      estimated_supply: null,
    });
  }
});

// GET /db/burn-latest
app.get('/db/burn-latest', auth, async (req, res) => {
  const limit = burnLimitParam(req.query.limit, 25, 100);
  try {
    const result = await pool.query(`
      SELECT be.id AS burn_event_id, be.tx_hash, be.log_index, be.block_number, be.burner_wallet,
             be.survivor_token_id, be.burned_at, be.points_used, bs.image_data AS snapshot_image,
             COALESCE(
               array_agg(DISTINCT bei.burned_token_id ORDER BY bei.burned_token_id)
                 FILTER (WHERE bei.burned_token_id IS NOT NULL AND bei.burned_token_id != be.survivor_token_id),
               '{}'
             ) AS input_token_ids,
             (COUNT(DISTINCT bei.burned_token_id)
               FILTER (WHERE bei.burned_token_id IS NOT NULL AND bei.burned_token_id != be.survivor_token_id))::int AS input_count
      FROM burn_events be
      LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
      LEFT JOIN burn_state_snapshots bs ON bs.burn_event_id = be.id AND bs.token_id = be.survivor_token_id
      GROUP BY be.id, bs.image_data
      ORDER BY be.burned_at DESC NULLS LAST, be.block_number DESC NULLS LAST, be.log_index DESC NULLS LAST
      LIMIT $1
    `, [limit]);

    const burns = result.rows.map(burnEventJson);
    // Pre-burn images for the destroyed input tokens shown in each row's
    // gallery — these tokens no longer exist as their original selves, so
    // a "current" image lookup would be wrong/blank. See fetchInputSnapshots.
    const allInputIds = burns.flatMap(b => b.input_token_ids);
    const inputSnapshots = await fetchInputSnapshots(allInputIds);

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({ ok: true, burns, input_snapshots: inputSnapshots, count: result.rows.length });
  } catch (e) {
    burnEndpointError(res, '/db/burn-latest', e, { burns: [], input_snapshots: {}, count: 0 });
  }
});

// GET /db/burn-leaderboard
app.get('/db/burn-leaderboard', auth, async (req, res) => {
  const limit = burnLimitParam(req.query.limit, 25, 100);
  try {
    const result = await pool.query(`
      WITH per_burn AS (
        SELECT be.id, be.burner_wallet,
               (COUNT(DISTINCT bei.burned_token_id)
                 FILTER (WHERE bei.burned_token_id IS NOT NULL AND bei.burned_token_id != be.survivor_token_id))::int AS input_count
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        GROUP BY be.id
      )
      SELECT burner_wallet,
             COUNT(id)::int AS burn_events,
             COALESCE(SUM(input_count), 0)::int AS tokens_burned,
             COALESCE(MAX(input_count), 0)::int AS biggest_burn
      FROM per_burn
      GROUP BY burner_wallet
      ORDER BY tokens_burned DESC, burn_events DESC, burner_wallet ASC
      LIMIT $1
    `, [limit]);

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      leaders: result.rows.map(r => ({
        wallet: r.burner_wallet || null,
        burn_events: parseInt(r.burn_events || 0, 10),
        tokens_burned: parseInt(r.tokens_burned || 0, 10),
        biggest_burn: parseInt(r.biggest_burn || 0, 10),
      })),
      count: result.rows.length,
    });
  } catch (e) {
    burnEndpointError(res, '/db/burn-leaderboard', e, { leaders: [], count: 0 });
  }
});

// ── GET /db/burned-ticker ─────────────────────────────────────────────────────
// Powers the header burn ticker. Returns ALL burned OCAS token IDs -- no
// embedded image data, just a plain list of numbers, so this stays tiny
// (a few KB) even as the total burn count keeps growing. The frontend
// renders each one as a real <img src="/render/burned-snapshot/:id">,
// letting the browser's own lazy-loading and long-lived HTTP caching do
// the actual heavy lifting instead of shipping every image's bytes
// through this one response.
app.get('/db/burned-ticker', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (bei.burned_token_id) bei.burned_token_id, be.burned_at
      FROM burn_event_inputs bei
      JOIN burn_events be ON be.id = bei.burn_event_id
      JOIN token_image_snapshots tis ON tis.token_id = bei.burned_token_id
      WHERE bei.burned_token_id != be.survivor_token_id
        AND tis.image_data IS NOT NULL
      ORDER BY bei.burned_token_id, be.burned_at DESC
    `);
    const ids = result.rows
      .sort((a, b) => new Date(b.burned_at) - new Date(a.burned_at))
      .map(r => burnNum(r.burned_token_id));
    res.set('Cache-Control', 'public, max-age=120, s-maxage=120');
    res.json({ ok: true, token_ids: ids, count: ids.length });
  } catch (e) {
    burnEndpointError(res, '/db/burned-ticker', e, { token_ids: [] });
  }
});

// ── GET /render/burned-snapshot/:tokenId ─────────────────────────────────────
// Serves a single burned token's pre-burn snapshot as a real image response
// (not JSON), so it can be used directly as an <img src>. A burn snapshot is
// a permanent historical fact -- it never changes once written -- so this is
// cached essentially forever. After the first time anyone, anywhere, loads
// a given token, every future load (same visitor or a different one) comes
// from cache instantly rather than hitting the database again.
app.get('/render/burned-snapshot/:tokenId', auth, async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (!Number.isFinite(tokenId)) return res.status(400).send('invalid token id');
    const result = await pool.query(
      `SELECT image_data FROM token_image_snapshots WHERE token_id=$1 AND image_data IS NOT NULL`,
      [tokenId]
    );
    if (!result.rows.length) return res.status(404).send('not found');
    const raw = String(result.rows[0].image_data || '').trim();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');

    // This field isn't stored in one consistent format -- same multi-format
    // detection the frontend already does in several places for this exact
    // kind of value (raw <svg> markup vs. a complete data: URI vs. some
    // other URL). The original version only handled the raw-<svg> case,
    // which sent an already-complete data: URI string as the literal HTTP
    // body with an image/svg+xml header -- not valid SVG content, hence
    // broken images.
    if (raw.startsWith('<svg')) {
      res.set('Content-Type', 'image/svg+xml');
      return res.send(raw);
    }
    const dataMatch = raw.match(/^data:([^,]+),(.+)$/s);
    if (dataMatch) {
      const [, meta, payload] = dataMatch;
      const isBase64 = /;base64$/i.test(meta);
      const mime = meta.replace(/;base64$/i, '').split(';')[0] || 'image/svg+xml';
      const buf = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
      res.set('Content-Type', mime || 'image/svg+xml');
      return res.send(buf);
    }
    // Some other URL format (ipfs://, http(s)://, etc.) -- redirect rather
    // than try to proxy/fetch it ourselves.
    const url = raw.startsWith('ipfs://') ? raw.replace('ipfs://', 'https://ipfs.io/ipfs/') : raw;
    return res.redirect(302, url);
  } catch (e) {
    console.error('/render/burned-snapshot error:', e.message);
    res.status(500).send('error');
  }
});

app.get('/db/burn-best', auth, async (req, res) => {
  try {
    const biggest = await pool.query(`
      SELECT be.id AS burn_event_id, be.tx_hash, be.log_index, be.block_number, be.burner_wallet,
             be.survivor_token_id, be.burned_at, be.points_used, bs.image_data AS snapshot_image,
             COALESCE(
               array_agg(DISTINCT bei.burned_token_id ORDER BY bei.burned_token_id)
                 FILTER (WHERE bei.burned_token_id IS NOT NULL AND bei.burned_token_id != be.survivor_token_id),
               '{}'
             ) AS input_token_ids,
             (COUNT(DISTINCT bei.burned_token_id)
               FILTER (WHERE bei.burned_token_id IS NOT NULL AND bei.burned_token_id != be.survivor_token_id))::int AS input_count
      FROM burn_events be
      LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
      LEFT JOIN burn_state_snapshots bs ON bs.burn_event_id = be.id AND bs.token_id = be.survivor_token_id
      GROUP BY be.id, bs.image_data
      ORDER BY input_count DESC, be.burned_at DESC NULLS LAST, be.block_number DESC NULLS LAST
      LIMIT 10
    `);

    const topPoints = await pool.query(`
      SELECT be.id AS burn_event_id, be.tx_hash, be.log_index, be.block_number, be.burner_wallet,
             be.survivor_token_id, be.burned_at, be.points_used, bs.image_data AS snapshot_image,
             COALESCE(
               array_agg(DISTINCT bei.burned_token_id ORDER BY bei.burned_token_id)
                 FILTER (WHERE bei.burned_token_id IS NOT NULL AND bei.burned_token_id != be.survivor_token_id),
               '{}'
             ) AS input_token_ids,
             (COUNT(DISTINCT bei.burned_token_id)
               FILTER (WHERE bei.burned_token_id IS NOT NULL AND bei.burned_token_id != be.survivor_token_id))::int AS input_count
      FROM burn_events be
      LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
      LEFT JOIN burn_state_snapshots bs ON bs.burn_event_id = be.id AND bs.token_id = be.survivor_token_id
      WHERE be.points_used IS NOT NULL
      GROUP BY be.id, bs.image_data
      ORDER BY be.points_used DESC, be.burned_at DESC NULLS LAST, be.block_number DESC NULLS LAST
      LIMIT 10
    `);

    let rarestBurnedInputs = [];
    let bestCreatedTokens = [];
    try {
      const rarest = await pool.query(`
        SELECT be.id AS burn_event_id, be.tx_hash, be.block_number, be.burner_wallet, be.burned_at,
               be.result_is_angel,
               bei.burned_token_id,
               t.os_rank, t.obs_rank,
               COALESCE(t.os_rank, t.obs_rank) AS rank,
               tis.image_data AS snapshot_image,
               tis.traits_json->>'Type' AS type_trait
        FROM burn_event_inputs bei
        JOIN burn_events be ON be.id = bei.burn_event_id
        LEFT JOIN tokens t ON t.id = bei.burned_token_id
        LEFT JOIN token_image_snapshots tis ON tis.token_id = bei.burned_token_id
        WHERE bei.burned_token_id != be.survivor_token_id
        ORDER BY COALESCE(t.os_rank, t.obs_rank, 999999) ASC, be.burned_at DESC NULLS LAST
        LIMIT 25
      `);
      rarestBurnedInputs = rarest.rows.map(r => ({
        burn_event_id: burnNum(r.burn_event_id),
        tx_hash: r.tx_hash || null,
        block_number: burnNum(r.block_number),
        wallet: r.burner_wallet || null,
        burn_ts: r.burned_at || null,
        token_id: burnNum(r.burned_token_id),
        os_rank: burnNum(r.os_rank),
        obs_rank: burnNum(r.obs_rank),
        rank: burnNum(r.rank),
        // This token no longer exists as its original self — show its last
        // known appearance rather than attempting a "current" image lookup.
        snapshot_image: r.snapshot_image || null,
        type_trait: r.type_trait || null,
        is_angel: !!r.result_is_angel,
      }));

      const created = await pool.query(`
        SELECT sub.*, tt.trait_value AS type_trait FROM (
          SELECT DISTINCT ON (be.survivor_token_id)
                 be.tx_hash, be.block_number, be.burner_wallet, be.burned_at,
                 be.survivor_token_id, be.result_is_angel,
                 t.os_rank, t.obs_rank,
                 COALESCE(t.os_rank, t.obs_rank) AS rank
          FROM burn_events be
          LEFT JOIN tokens t ON t.id = be.survivor_token_id
          ORDER BY be.survivor_token_id, be.burned_at DESC
        ) sub
        LEFT JOIN token_traits tt ON tt.token_id = sub.survivor_token_id AND tt.trait_name = 'Type' AND tt.collection_slug = 'on-chain-all-stars'
        ORDER BY COALESCE(rank, 999999) ASC
        LIMIT 25
      `);
      bestCreatedTokens = created.rows.map(r => ({
        tx_hash: r.tx_hash || null,
        block_number: burnNum(r.block_number),
        wallet: r.burner_wallet || null,
        burn_ts: r.burned_at || null,
        token_id: burnNum(r.survivor_token_id),
        os_rank: burnNum(r.os_rank),
        obs_rank: burnNum(r.obs_rank),
        rank: burnNum(r.rank),
        type_trait: r.type_trait || null,
        is_angel: !!r.result_is_angel,
      }));
    } catch (rankError) {
      if (!isMissingBurnRankData(rankError)) throw rankError;
      console.warn('/db/burn-best rank data unavailable:', rankError.message);
    }

    const biggestBurns = biggest.rows.map(burnEventJson);
    const topPointsBurns = topPoints.rows.map(burnEventJson);
    // Same reasoning as /db/burn-latest — these input galleries show
    // destroyed tokens, so they need pre-burn snapshots, not a current lookup.
    const allInputIds = [...biggestBurns, ...topPointsBurns].flatMap(b => b.input_token_ids);
    const inputSnapshots = await fetchInputSnapshots(allInputIds);

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      biggest_burns: biggestBurns,
      top_points_burns: topPointsBurns,
      input_snapshots: inputSnapshots,
      rarest_burned_inputs: rarestBurnedInputs,
      best_created_tokens: bestCreatedTokens,
    });
  } catch (e) {
    burnEndpointError(res, '/db/burn-best', e, {
      biggest_burns: [],
      input_snapshots: {},
      rarest_burned_inputs: [],
      best_created_tokens: [],
    });
  }
});

// GET /db/burn-activity
app.get('/db/burn-activity', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT to_char(be.burned_at::date, 'YYYY-MM-DD') AS date,
             COUNT(DISTINCT be.id)::int AS burn_events,
             (COUNT(DISTINCT bei.burned_token_id)
               FILTER (WHERE bei.burned_token_id IS NOT NULL AND bei.burned_token_id != be.survivor_token_id))::int AS tokens_burned,
             COUNT(DISTINCT be.id)::int AS tokens_created
      FROM burn_events be
      LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
      WHERE be.burned_at IS NOT NULL
      GROUP BY be.burned_at::date
      ORDER BY be.burned_at::date ASC
    `);

    const activity = result.rows.map(r => {
      const tokensBurned = parseInt(r.tokens_burned || 0, 10);
      const tokensCreated = parseInt(r.tokens_created || 0, 10);
      return {
        date: r.date,
        burn_events: parseInt(r.burn_events || 0, 10),
        tokens_burned: tokensBurned,
        tokens_created: tokensCreated,
        supply_reduced_by: tokensBurned - tokensCreated,
      };
    });

    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ ok: true, activity, count: activity.length });
  } catch (e) {
    burnEndpointError(res, '/db/burn-activity', e, { activity: [], count: 0 });
  }
});


// ── TraitView↔Discord verification endpoints ──────────────────────────────────

// POST /tv/claim-code — TraitView calls this to claim a code generated by the bot
// Returns { discord_id, wallet, guild_id } if valid
app.post('/tv/claim-code', auth,
  rateLimit({ max: 10, windowMs: 5 * 60 * 1000, keyFn: req => 'claim:' + req.ip }),
  async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });

  try {
    const row = await pool.query(
      `SELECT discord_id, wallet, guild_id, expires_at, claimed_at
       FROM tv_verify_codes WHERE code=$1`,
      [code.trim().toUpperCase()]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'invalid_code' });
    const entry = row.rows[0];
    if (entry.claimed_at) return res.status(410).json({ error: 'code_already_used' });
    if (new Date(entry.expires_at) < new Date()) return res.status(410).json({ error: 'code_expired' });

    // Claim it atomically
    await pool.query(
      `UPDATE tv_verify_codes SET claimed_at=NOW() WHERE code=$1`,
      [code.trim().toUpperCase()]
    );

    // Upsert traitview_links
    await pool.query(
      `INSERT INTO traitview_links (discord_id, guild_id, wallet, linked_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (discord_id, guild_id) DO UPDATE SET wallet=$3, linked_at=NOW()`,
      [entry.discord_id, entry.guild_id, entry.wallet]
    );

    console.log(`[TVVerify] Linked discord=${entry.discord_id} wallet=${entry.wallet.slice(0,8)} guild=${entry.guild_id}`);
    res.json({ ok: true, discord_id: entry.discord_id, wallet: entry.wallet, guild_id: entry.guild_id });
  } catch (e) {
    console.error('[TVVerify] claim-code error:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /tv/link-status?discord_id=... — check if a Discord user has linked TraitView
app.get('/tv/link-status', auth, async (req, res) => {
  const { discord_id, guild_id } = req.query;
  if (!discord_id) return res.status(400).json({ error: 'discord_id required' });

  try {
    const row = await pool.query(
      `SELECT wallet, linked_at FROM traitview_links
       WHERE discord_id=$1 AND guild_id=$2`,
      [discord_id, guild_id || 'global']
    );
    if (!row.rows.length) return res.json({ linked: false });
    res.json({ linked: true, wallet: row.rows[0].wallet, linked_at: row.rows[0].linked_at });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /tv/link-status-by-wallet — reverse lookup, checks live on every wallet
// connection instead of caching link status client-side. A wallet could be
// linked in multiple guilds; returns the most recently linked one.
app.get('/tv/link-status-by-wallet', auth,
  rateLimit({ max: 30, windowMs: 60 * 1000, keyFn: req => 'linklookup:' + req.ip }),
  async (req, res) => {
  const wallet = cleanAddress(req.query.wallet || '');
  if (!isEthAddress(wallet)) return res.status(400).json({ error: 'valid wallet address required' });

  try {
    const row = await pool.query(
      `SELECT discord_id, guild_id, linked_at FROM traitview_links
       WHERE LOWER(wallet)=LOWER($1)
       ORDER BY linked_at DESC LIMIT 1`,
      [wallet]
    );

    let discordId, guildId = null, linkedAt = null;

    if (row.rows.length) {
      discordId = row.rows[0].discord_id;
      guildId = row.rows[0].guild_id;
      linkedAt = row.rows[0].linked_at;
    } else {
      // jv confirmed live: "on desktop, it's not picking up that I have 2
      // wallets verified through the bot... I did the verification through
      // mobile." Root cause -- traitview_links (this website's own separate
      // verification record, populated only by claiming a code through
      // /tv/claim-code) upserts on (discord_id, guild_id) alone, so it can
      // only ever store ONE wallet per user at a time -- whichever wallet
      // happened to be attached to the most recently claimed code. If the
      // wallet connected on a different device/browser is a DIFFERENT one
      // of the user's genuinely bot-linked wallets (linked_wallets, the
      // bot's real multi-wallet source of truth, has no such single-wallet
      // limit), the lookup above finds nothing and returns linked:false --
      // even though this wallet is, in fact, one of theirs. Falling back to
      // resolving discord_id directly from linked_wallets by wallet address
      // when traitview_links has no row for this specific one, rather than
      // requiring every one of a user's wallets to also happen to be the
      // one traitview_links most recently recorded.
      const fallback = await pool.query(
        `SELECT discord_id FROM linked_wallets WHERE LOWER(wallet)=LOWER($1) ORDER BY linked_at DESC LIMIT 1`,
        [wallet]
      ).catch(() => ({ rows: [] }));
      if (!fallback.rows.length) return res.json({ linked: false });
      discordId = fallback.rows[0].discord_id;
    }

    // linked_wallets (the bot's actual multi-wallet source of truth) is
    // keyed by discord_id -- once known (either path above), every wallet
    // ever linked to this same Discord account, across every guild
    // they've verified in, is a second, cheap lookup away. Deduplicated
    // since the same wallet can appear under multiple guild_ids if
    // verification cascaded across servers.
    const linkedRows = await pool.query(
      `SELECT DISTINCT wallet FROM linked_wallets WHERE discord_id=$1`,
      [discordId]
    ).catch(() => ({ rows: [] }));
    const linkedWallets = linkedRows.rows.map(r => r.wallet);

    res.json({
      linked: true,
      discord_id: discordId,
      guild_id: guildId,
      linked_at: linkedAt,
      linkedWallets: linkedWallets.length ? linkedWallets : [wallet.toLowerCase()],
    });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});


// ── GET /db/collections ───────────────────────────────────────────────────────
// Lists the collections registry. Read-only for now — the onboarding
// trigger that inserts new rows (search an unknown slug -> kick off backfill)
// is a later phase; this just exposes what's already in the table.
app.get('/db/collections', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT slug, contract, chain, name, status, token_standard, total_supply,
             is_animated, has_svg_images, error_message,
             traits_synced_at, market_synced_at, created_at, updated_at,
             opensea_url, website_url, twitter_url, avatar_image_url, banner_image_url
      FROM collections
      ORDER BY (slug = $1) DESC, created_at ASC
    `, [OCAS_SLUG]);
    res.json({ ok: true, collections: result.rows });
  } catch (e) {
    console.error('[/db/collections]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── GET /db/traits-fast ───────────────────────────────────────────────────────
// Serves traits_fast.json structure computed live from DB, excluding burned tokens.
// Cached in memory for 5 minutes, per collection_slug.
// Returns: { ok, rank: [[id, score], ...], domain: {trait: [values]},
//            buckets: {count: [ids]}, freq: {trait: {value: count}}, survivorCount }
const _traitsFastCache = new Map(); // slug -> { data, ts }
const TRAITS_FAST_TTL = 5 * 60 * 1000;

app.get('/db/traits-fast', auth, async (req, res) => {
  try {
    const slug = (req.query.slug || OCAS_SLUG).toString().toLowerCase();
    const isOcas = slug === OCAS_SLUG;
    const now = Date.now();
    const cached = _traitsFastCache.get(slug);
    if (cached && (now - cached.ts) < TRAITS_FAST_TTL) {
      return res.json(cached.data);
    }

    // Burn mechanic only exists for OCAS — burn_event_inputs/burn_events have
    // no collection_slug column, so this must never run for other slugs, or a
    // numerically-colliding token_id in another collection (e.g. Fluxeto #81)
    // could get wrongly excluded as "burned". See the cross-collection image
    // collision bug fixed 2026-06-28 for the same underlying class of issue.
    const BURNED_EXCL = isOcas ? `NOT EXISTS (
      SELECT 1 FROM burn_event_inputs bei
      JOIN burn_events be ON be.id = bei.burn_event_id
      WHERE bei.burned_token_id = t.id
      AND bei.burned_token_id != be.survivor_token_id
    )` : 'TRUE';

    const BURNED_EXCL_TT = isOcas ? `NOT EXISTS (
      SELECT 1 FROM burn_event_inputs bei
      JOIN burn_events be ON be.id = bei.burn_event_id
      WHERE bei.burned_token_id = tt.token_id
      AND bei.burned_token_id != be.survivor_token_id
    )` : 'TRUE';

    // 1. Surviving tokens sorted by obs_rank ASC (pre-computed rank in DB)
    // Falls back to id order if obs_rank not available
    const [rankRes, traitRes] = await Promise.all([
      pool.query(`
        SELECT t.id, t.obs_rank, t.trait_count
        FROM tokens t
        WHERE t.collection_slug = $1 AND ${BURNED_EXCL}
        ORDER BY t.obs_rank ASC NULLS LAST, t.id ASC
      `, [slug]),
      // 2. Trait frequencies for surviving tokens
      pool.query(`
        SELECT tt.trait_name, tt.trait_value, COUNT(*)::int AS freq
        FROM token_traits tt
        JOIN tokens t ON t.id = tt.token_id AND t.collection_slug = tt.collection_slug
        WHERE tt.collection_slug = $1 AND ${BURNED_EXCL_TT}
        GROUP BY tt.trait_name, tt.trait_value
        ORDER BY tt.trait_name, tt.trait_value
      `, [slug])
    ]);

    // rank array: [[id, obsRank], ...] sorted by obs_rank ASC
    // TraitView uses index position for OBS rank so order matters
    const rank = rankRes.rows.map(r => [parseInt(r.id), r.obs_rank ? parseInt(r.obs_rank) : 9999]);

    // freq: { "Type": { "Human 1": 450, ... }, ... }
    // domain: { "Type": ["Human 1", ...], ... }
    const freq = {};
    const domain = {};
    for (const { trait_name: k, trait_value: v, freq: count } of traitRes.rows) {
      if (!freq[k]) freq[k] = {};
      freq[k][v] = count;
      if (!domain[k]) domain[k] = [];
      domain[k].push(v);
    }

    // buckets: { "1": [id, ...], "4": [...] }
    // trait_count may not exist on older schema — fall back to counting from traitRes
    const traitCountMap = {};
    for (const { token_id, trait_name } of traitRes.rows) {
      traitCountMap[token_id] = (traitCountMap[token_id] || 0) + 1;
    }
    const buckets = {};
    for (const { id, trait_count: tc } of rankRes.rows) {
      const count = tc != null ? tc : (traitCountMap[parseInt(id)] || 0);
      const key = String(count);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(parseInt(id));
    }

    const data = { ok: true, rank, domain, freq, buckets, survivorCount: rankRes.rows.length };
    _traitsFastCache.set(slug, { data, ts: now });
    res.json(data);
  } catch (e) {
    console.error('[/db/traits-fast]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── GET /db/all-traits ────────────────────────────────────────────────────────
// Returns all surviving tokens' traits in chunk-compatible format.
// Used by TraitView to replace static chunk files with live DB data.
// Server-side cache: 5 minutes per collection_slug.
// Returns: { ok, tokens: { "1": { traits: {...} }, ... }, survivorCount }
const _allTraitsCache = new Map(); // slug -> { data, ts }
const ALL_TRAITS_TTL = 5 * 60 * 1000;

app.get('/db/all-traits', auth, async (req, res) => {
  try {
    const slug = (req.query.slug || OCAS_SLUG).toString().toLowerCase();
    const isOcas = slug === OCAS_SLUG;
    const now = Date.now();
    const cached = _allTraitsCache.get(slug);
    if (cached && (now - cached.ts) < ALL_TRAITS_TTL) {
      return res.json(cached.data);
    }

    // Burn mechanic only exists for OCAS — see note in /db/traits-fast above.
    // Gate explicitly on isOcas rather than relying on absence of burn rows,
    // since a numerically colliding token_id in another collection must
    // never be excluded.
    const survivorsRes = isOcas
      ? await pool.query(`
          SELECT t.id, t.image_url, t.is_burned
          FROM tokens t
          WHERE t.collection_slug = $1 AND NOT EXISTS (
            SELECT 1 FROM burn_event_inputs bei
            JOIN burn_events be ON be.id = bei.burn_event_id
            WHERE bei.burned_token_id = t.id
            AND bei.burned_token_id != be.survivor_token_id
          )
          ORDER BY t.id
        `, [slug])
      : await pool.query(`
          SELECT t.id, t.image_url, t.is_burned
          FROM tokens t
          WHERE t.collection_slug = $1
          ORDER BY t.id
        `, [slug]);

    const survivorIds = new Set(survivorsRes.rows.map(r => parseInt(r.id)));
    const imageUrlById = new Map(survivorsRes.rows.map(r => [parseInt(r.id), r.image_url || null]));
    // is_burned (lib/burn-detect.js) — generic, contract-agnostic "sent to a
    // known dead address" flag, refreshed every 6h for every ready collection.
    // Separate concept from OCAS's own burn_events survivor mechanic (already
    // excluded from this response entirely, above) -- this just tags tokens
    // still present in the response so the frontend can badge/filter them.
    const isBurnedById = new Map(survivorsRes.rows.map(r => [parseInt(r.id), !!r.is_burned]));

    // Confirmed live: this endpoint's own comment below already documented
    // this exact gap ("token_svg_cache, read separately by the frontend")
    // but no such separate mechanism actually existed anywhere -- the
    // frontend's multi-collection support work surfaced this directly:
    // Argonauts tokens whose image is SVG-based (tokens.image_url
    // deliberately set to NULL for those -- see refreshSingleTokenMetadata
    // in lib/metadata-update-poller.js, which clears it precisely so
    // token_svg_cache is what display code reaches for) never had an image
    // at all in this response, only tokens with a raster URL did. Fixed by
    // querying token_svg_cache directly here instead of relying on a
    // frontend mechanism that was never built.
    const svgCacheRes = isOcas
      ? { rows: [] } // OCAS doesn't use token_svg_cache at all -- no-op query avoided entirely
      : await pool.query(
          `SELECT token_id, image_data FROM token_svg_cache WHERE collection_slug = $1 AND token_id = ANY($2::int[])`,
          [slug, [...survivorIds]]
        ).catch(e => {
          console.warn('[/db/all-traits] token_svg_cache lookup failed (non-fatal):', e.message);
          return { rows: [] };
        });
    const svgCacheById = new Map(svgCacheRes.rows.map(r => [parseInt(r.token_id), r.image_data || null]));

    // burn_state_snapshots is OCAS-only ground truth for post-burn survivor
    // images — skip entirely for other collections; tokens.image_url (or
    // token_svg_cache, queried directly above -- was "read separately by
    // the frontend" until that mechanism was confirmed to never actually
    // exist) is the only source.
    const survivorSnapshotImages = isOcas
      ? await getSurvivorImageMap([...survivorIds]).catch(e => {
          console.warn('[/db/all-traits] survivor snapshot image lookup failed (non-fatal):', e.message);
          return {};
        })
      : {};

    // Get all traits for surviving tokens in one query
    const traitsRes = await pool.query(`
      SELECT tt.token_id, tt.trait_name, tt.trait_value
      FROM token_traits tt
      WHERE tt.collection_slug = $2 AND tt.token_id = ANY($1::int[])
      ORDER BY tt.token_id, COALESCE(tt.trait_index, 0), tt.trait_name
    `, [[...survivorIds], slug]);

    // Build tokens object: { "1": { traits: { "Type": "Human 6", ... }, image: "..." }, ... }
    const tokens = {};

    // Initialize all survivors with empty traits + current image (snapshot
    // preferred for OCAS; tokens.image_url preferred otherwise, falling back
    // to token_svg_cache for tokens whose image is SVG-based)
    for (const id of survivorIds) {
      tokens[String(id)] = { traits: {}, image: survivorSnapshotImages[id] || imageUrlById.get(id) || svgCacheById.get(id) || null, burned: isBurnedById.get(id) || false };
    }

    // Populate traits
    for (const { token_id, trait_name, trait_value } of traitsRes.rows) {
      const key = String(token_id);
      if (tokens[key]) {
        tokens[key].traits[trait_name] = trait_value;
      }
    }

    const data = { ok: true, tokens, survivorCount: survivorIds.size, _debugVersion: 'svgcache-fix-610b9c5', _debugSvgCacheRows: svgCacheRes.rows.length, _debugSvgCacheHits: [...svgCacheById.values()].filter(v => v != null).length };
    _allTraitsCache.set(slug, { data, ts: now });

    res.json(data);
  } catch (e) {
    console.error('[/db/all-traits]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────

// ── GET /render/svg-token ─────────────────────────────────────────────────────
// Renders an on-chain SVG token to PNG using Sharp. Moved here from the bot
// process because Sharp's native libvips memory was not being released in
// the long-running Discord bot process, causing OOM crashes after several
// hours. This service is stateless and can be restarted independently.
// Query params: svgUrl (or svgData for data: URIs)
// Returns: image/png binary
// renderSvgTextToPng (and its sharp global config) moved to lib/svg-render.js
// so it's reachable in-process by lib/images.js's extractPngFromSvg when
// that code runs within this same service — not just via this route's own
// HTTP interface.
const { renderSvgTextToPng } = require('./lib/svg-render');

app.get('/render/svg-token', auth, async (req, res) => {
  try {
    const svgSource = req.query.svgUrl || req.query.svgData;
    if (!svgSource) return res.status(400).json({ ok: false, error: 'missing svgUrl or svgData' });

    // Clamped to a sane range -- prevents an absurd request (e.g. size=100000)
    // from exhausting memory/CPU on this shared service. Defaults to 500,
    // matching the previous hardcoded behavior for any caller not specifying one.
    let size = parseInt(req.query.size) || 500;
    size = Math.max(50, Math.min(3000, size));

    let svgText;
    if (svgSource.startsWith('data:image/svg')) {
      const b64 = svgSource.split(',')[1];
      if (!b64) return res.status(400).json({ ok: false, error: 'empty svg data' });
      svgText = Buffer.from(b64, 'base64').toString('utf-8');
    } else {
      const r = await fetch(svgSource);
      if (!r.ok) return res.status(502).json({ ok: false, error: `SVG fetch ${r.status}` });
      svgText = await r.text();
    }

    let finalBuf;
    try {
      finalBuf = await renderSvgTextToPng(svgText, size);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'SVG render failed: ' + e.message });
    }

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600'); // browser/CDN cache 1hr
    res.send(finalBuf);
  } catch (e) {
    console.error('[/render/svg-token]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /render/svg-token — same rendering, but for svgData (base64 data
// URIs) specifically instead of the GET route's query-string parameter.
// Confirmed live: a large on-chain-generated SVG (e.g. one with an embedded
// base64 PNG, same pattern this endpoint already handles via pngMatch above)
// pushed the GET request's query string past whatever length limit sits in
// front of this service, failing with HTTP 431 (Request Header Fields Too
// Large) — a GET request's entire URL, including its query string, is part
// of the request line, which has much tighter length limits than a POST
// body does almost everywhere. svgUrl stays on the GET route unchanged,
// since a URL itself is always short regardless of how large the SVG behind
// it is — only svgData (which embeds the actual content) needed to move.
// Route-specific body-size limit isn't needed here — the global
// express.json() limit above was raised to 5mb specifically to cover this
// route, avoiding a second, redundant json() call on the same request (see
// that comment for why stacking two would be unsafe).
app.post('/render/svg-token', auth, async (req, res) => {
  try {
    const svgData = req.body?.svgData;
    if (!svgData) return res.status(400).json({ ok: false, error: 'missing svgData in request body' });
    if (!svgData.startsWith('data:image/svg')) return res.status(400).json({ ok: false, error: 'svgData must be a data:image/svg URI' });

    let size = parseInt(req.body?.size) || 500;
    size = Math.max(50, Math.min(3000, size));

    const b64 = svgData.split(',')[1];
    if (!b64) return res.status(400).json({ ok: false, error: 'empty svg data' });
    const svgText = Buffer.from(b64, 'base64').toString('utf-8');

    let finalBuf;
    try {
      finalBuf = await renderSvgTextToPng(svgText, size);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'SVG render failed: ' + e.message });
    }

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(finalBuf);
  } catch (e) {
    console.error('[POST /render/svg-token]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/sales-stream ─────────────────────────────────────────────────────
// Server-Sent Events endpoint TraitView connects to for live sale feedback.
// See lib/sale-stream.js for the full architecture explanation -- this
// route itself is deliberately thin, just handing off to that module.
// Not wired through the auth() middleware used elsewhere in this file: SSE
// requests come from an EventSource in the browser, which can't set custom
// headers, so this relies on the same ?key= query-param path auth() itself
// already supports for exactly this reason -- but delegates the actual
// check to auth() rather than duplicating that logic here.
app.get('/db/sales-stream', auth, saleStream.handleSseRequest);

// Runs the same idempotent CREATE TABLE/INDEX IF NOT EXISTS migrations used
// elsewhere -- ensures a brand-new database gets its full schema automatically
// on first deploy, and self-heals if any table/index was ever missing,
// instead of relying on a separate manual step that's easy to forget.

// ── TEMP DIAGNOSTIC — jv reported OCAS live listings showing fewer than
// OpenSea actually has. Compares the DB's current listing count/freshness
// against a live, direct call to OpenSea's own listings endpoint (same one
// sync-listings.js uses) to see whether the gap is a stale/incomplete sync,
// or something else (e.g. this endpoint itself not returning everything
// OpenSea's own website shows). No auth, read-only -- meant to be opened
// directly in a mobile browser. Remove once this is settled.
app.get('/diag/listings-compare', async (req, res) => {
  const slug = (req.query.slug || 'on-chain-all-stars').toString();
  try {
    const dbResult = await pool.query(
      `SELECT COUNT(*)::int AS count, MIN(updated_at) AS oldest_updated, MAX(updated_at) AS newest_updated
       FROM listings WHERE collection_slug = $1`,
      [slug]
    );
    const dbRow = dbResult.rows[0];

    if (!process.env.OPENSEA_KEY) {
      return res.json({ ok: true, slug, db: dbRow, opensea_live: { error: 'OPENSEA_KEY not configured on this service' } });
    }

    let next = null, pages = 0, totalRaw = 0;
    const uniqueTokenIds = new Set();
    let firstPageKeys = null;
    do {
      const qs = new URLSearchParams({ chain: 'ethereum', limit: '100' });
      if (next) qs.set('next', next);
      const r = await fetch(`https://api.opensea.io/api/v2/listings/collection/${slug}/all?${qs}`, {
        headers: { 'x-api-key': process.env.OPENSEA_KEY, 'Accept': 'application/json' }
      });
      if (!r.ok) { return res.json({ ok: true, slug, db: dbRow, opensea_live: { error: `HTTP ${r.status} on page ${pages}`, pagesCompleted: pages } }); }
      const body = await r.json();
      if (pages === 0) firstPageKeys = Object.keys(body);
      const listings = body.listings || [];
      totalRaw += listings.length;
      for (const listing of listings) {
        const cands = [
          listing?.criteria?.nft?.identifier, listing?.nft?.identifier, listing?.asset?.token_id,
          listing?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria,
          listing?.protocol_data?.parameters?.consideration?.[0]?.identifierOrCriteria,
        ];
        for (let c of cands) {
          if (!c) continue;
          c = String(c);
          const parts = c.includes('/') ? c.split('/') : c.split(':');
          const last = parts[parts.length - 1];
          if (last && /^\d+$/.test(last)) { uniqueTokenIds.add(parseInt(last, 10)); break; }
        }
      }
      next = body.next || null;
      pages++;
      if (pages >= 150) break;
      if (next) await new Promise(r2 => setTimeout(r2, 80));
    } while (next);

    res.json({
      ok: true,
      slug,
      db: dbRow,
      opensea_live: {
        pagesCompleted: pages,
        totalRawListingsSeen: totalRaw,
        uniqueTokenIdsSeen: uniqueTokenIds.size,
        completedFully: next === null,
        firstPageResponseKeys: firstPageKeys,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── TEMP DIAGNOSTIC — checking whether Argonauts (or any non-OCAS
// collection) actually has obs_rank populated in the DB, or whether it's
// NULL for every row (meaning /db/traits-fast's ORDER BY obs_rank falls
// back entirely to id order -- TV Rank effectively becoming "rank = token
// ID", not a real rarity computation at all). Remove once this is settled.
app.get('/diag/obs-rank-check', async (req, res) => {
  const slug = (req.query.slug || 'argonauts').toString();
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(obs_rank)::int AS with_obs_rank,
              MIN(obs_rank)::int AS min_rank, MAX(obs_rank)::int AS max_rank
       FROM tokens WHERE collection_slug = $1`,
      [slug]
    );
    res.json({ ok: true, slug, ...r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/collections/recompute-ranks — (re)run TV Rank for an already-
// onboarded collection ────────────────────────────────────────────────────
// Same admin gating as /db/collections/onboard, same reasoning (this key is
// already visible in TraitView's public frontend JS via devtools, so it
// can't gate anything on its own). Exists specifically because Argonauts
// (and potentially other collections onboarded before computeObsRanks()
// existed) already went through onboarding with obs_rank left entirely
// NULL -- this lets that be fixed without a full re-onboard. Safe to call
// repeatedly; always a full recompute from current token_traits.
app.get('/db/collections/recompute-ranks', async (req, res) => {
  if (!ADMIN_ONBOARD_SECRET || req.query.admin_key !== ADMIN_ONBOARD_SECRET) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const slug = String(req.query.slug || '').toLowerCase().trim();
  if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });
  const isOcas = slug === OCAS_SLUG;
  try {
    const result = await computeObsRanks(pool, slug, { isOcas });
    res.json({ ok: true, slug, ...result });
  } catch (e) {
    console.error(`[/db/collections/recompute-ranks] ${slug} failed:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/collections/refresh-burned-status — bulk on-chain ownership
// check for tokens sent to a known dead address ─────────────────────────────
// jv: Argonauts has no protocol-level burn mechanic -- a third-party account
// independently sent ~15 tokens (and possibly more over time) to a dead
// address on their own. See lib/burn-detect.js for why this needs its own,
// separate mechanism from OCAS's burn_events tracking. Same admin gating as
// the endpoints above. Chains straight into a rank recompute afterward,
// since a token's burned status changing is exactly the kind of thing that
// should shift every other token's rank too, same as any other trait-data
// change -- running this without following it with a recompute would just
// leave ranks stale relative to whatever this just found.
app.get('/db/collections/refresh-burned-status', async (req, res) => {
  if (!ADMIN_ONBOARD_SECRET || req.query.admin_key !== ADMIN_ONBOARD_SECRET) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const slug = String(req.query.slug || '').toLowerCase().trim();
  if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });
  try {
    const colRes = await pool.query(`SELECT contract, chain FROM collections WHERE slug = $1`, [slug]);
    if (!colRes.rows[0]) return res.status(404).json({ ok: false, error: `no collection on file for slug "${slug}"` });
    const { contract, chain } = colRes.rows[0];
    const burnResult = await refreshBurnedStatus(pool, { slug, contract, chain: chain || 'ethereum' });
    const rankResult = await computeObsRanks(pool, slug, { isOcas: slug === OCAS_SLUG });
    res.json({ ok: true, slug, ...burnResult, ranked: rankResult.tokenCount });
  } catch (e) {
    console.error(`[/db/collections/refresh-burned-status] ${slug} failed:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/collections/backfill-links — fetch/update OpenSea/Website/
// Twitter for an already-onboarded collection ───────────────────────────────
// jv: hamburger menu links were hardcoded to OCAS for every collection.
// New onboardings pick these up automatically (see lib/collection-onboard.js),
// but Argonauts itself onboarded before these three columns existed at all --
// this is specifically for backfilling it (and anything else onboarded
// before now) without a full re-onboard. Same admin gating as the endpoints
// above; safe to call repeatedly.
app.get('/db/collections/backfill-links', async (req, res) => {
  if (!ADMIN_ONBOARD_SECRET || req.query.admin_key !== ADMIN_ONBOARD_SECRET) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const slug = String(req.query.slug || '').toLowerCase().trim();
  if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });
  try {
    const result = await backfillCollectionLinks(pool, slug);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(`[/db/collections/backfill-links] ${slug} failed:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── TEMP DIAGNOSTIC — recompute-ranks reported 9167 for Argonauts against a
// total of 9168 tokens on file. computeObsRanks() only ranks tokens that
// have at least one token_traits row, so this finds whichever token has
// none at all (a metadata fetch failure, most likely) to confirm that's
// really the gap rather than something else. Remove once this is settled.
app.get('/diag/tokens-missing-traits', async (req, res) => {
  const slug = (req.query.slug || 'argonauts').toString();
  try {
    const r = await pool.query(
      `SELECT t.id FROM tokens t
       WHERE t.collection_slug = $1
       AND NOT EXISTS (SELECT 1 FROM token_traits tt WHERE tt.token_id = t.id AND tt.collection_slug = t.collection_slug)
       ORDER BY t.id`,
      [slug]
    );
    const missingIds = r.rows.map(row => row.id);

    // For each missing token: pull its own tokens-table row (does it even
    // exist as real data, or is it a bare placeholder row with nothing but
    // an id?) and try a direct OpenSea lookup (does this token ID actually
    // exist as a real, minted NFT at all, independent of anything in this
    // DB) -- settles whether this is a real gap or just an artifact of how
    // the range-based backfill iterates (e.g. starting from 0 even though
    // minting actually starts at 1).
    const details = [];
    for (const id of missingIds) {
      const rowRes = await pool.query(`SELECT * FROM tokens WHERE id=$1 AND collection_slug=$2`, [id, slug]);
      const colRes = await pool.query(`SELECT contract, chain FROM collections WHERE slug=$1`, [slug]);
      let openSeaExists = null;
      if (colRes.rows[0] && process.env.OPENSEA_API_KEY) {
        try {
          const osRes = await fetch(
            `https://api.opensea.io/api/v2/chain/${colRes.rows[0].chain || 'ethereum'}/contract/${colRes.rows[0].contract}/nfts/${id}`,
            { headers: { 'X-API-KEY': process.env.OPENSEA_API_KEY } }
          );
          openSeaExists = osRes.ok;
        } catch (e) {
          openSeaExists = `fetch error: ${e.message}`;
        }
      }
      details.push({ id, dbRow: rowRes.rows[0] || null, existsOnOpenSea: openSeaExists });
    }

    res.json({ ok: true, slug, missingCount: missingIds.length, details });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`TraitView API running on port ${PORT}`);
    console.log(`Auth: ${API_SECRET ? 'enabled' : (REQUIRE_API_AUTH ? 'REQUIRED BUT MISSING' : 'DISABLED (dev only; set API_SECRET to enable)')}`);
  });
  // Live sale feed: subscribe to every fully-onboarded collection's
  // item_sold events right away, so the stream is already running before
  // any TraitView client connects -- not lazily on first request, which
  // would miss whatever sold in the gap before the first viewer showed up.
  saleStream.subscribeToAllReadyCollections();
}).catch(e => {
  console.error('[Migrations] Failed to run on startup:', e.message);
  // Still start the server even if migrations failed -- an existing,
  // already-correct database shouldn't be taken down by a migration hiccup.
  app.listen(PORT, () => {
    console.log(`TraitView API running on port ${PORT} (migrations may be incomplete, check logs above)`);
  });
  saleStream.subscribeToAllReadyCollections();
});

