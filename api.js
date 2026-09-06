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

// Loaded at module level (not lazily inside a route handler) specifically
// so its setInterval-driven sync loops actually start the moment this
// process boots. Previously this was require()'d only inside the manual
// /db/listings/sync handler, which meant sync-listings.js's top-level code
// — including both setInterval calls — never ran at all unless someone
// manually hit that endpoint at least once. That's the real reason no
// [sync] log lines were ever appearing, on this version or the version
// before today's rewrite.
const syncListingsModule = require('./sync-listings');
const { onboardCollection } = require('./lib/collection-onboard');
const { fixCollectionImages, fetchRawTokenUri, diagnoseIpfsGateways } = require('./lib/collection-backfill');
const { takeStackersSnapshot } = require('./lib/stackers-analytics');

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

    const traitEntries = Object.entries(traitFilters).filter(([, vals]) => vals?.length > 0);
    const traitCountFilter = req.query.trait_count ? parseInt(req.query.trait_count) : null;

    let query = `SELECT t.id, t.obs_rank FROM tokens t`;
    const params = [];
    let p = 1;

    // One JOIN per trait name — AND logic across names, OR within values
    traitEntries.forEach(([name, vals], i) => {
      query += ` JOIN token_traits tt${i} ON tt${i}.token_id = t.id`
             + ` AND tt${i}.trait_name = $${p++}`
             + ` AND tt${i}.trait_value = ANY($${p++}::text[])`;
      params.push(name, Array.isArray(vals) ? vals : [vals]);
    });

    if (listedOnly) query += ` JOIN listings l ON l.token_id = t.id`;

    const conditions = [ACTIVE_TOKEN_CONDITION];
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
      pool.query(`SELECT id, obs_rank, os_rank, os_score, rarity_score, trait_count, image_url FROM tokens WHERE id = $1 AND collection_slug = $2`, [tokenId, slug]),
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

    const result = await pool.query(`
      SELECT t.id, t.obs_rank, l.price_eth, l.url
      FROM tokens t
      JOIN token_traits tt ON tt.token_id = t.id
      JOIN listings l ON l.token_id = t.id
      WHERE tt.trait_name = $1 AND tt.trait_value = $2
        AND NOT EXISTS (
          SELECT 1 FROM burn_event_inputs active_burned
          JOIN burn_events active_be ON active_be.id = active_burned.burn_event_id
          WHERE active_burned.burned_token_id = t.id
            AND active_burned.burned_token_id != active_be.survivor_token_id
        )
      ORDER BY l.price_eth ASC
      LIMIT 1
    `, [trait_name, trait_value]);

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

// ── GET /db/stackers/snapshot — manually trigger a Stackers analytics
// snapshot. The scheduled job (bot.js) only runs once every 24h on purpose
// — it iterates every token and takes real minutes, so it deliberately
// doesn't run on every bot restart. Without a manual trigger there'd be no
// way to actually test /stackerstats until a full day had passed. Runs in
// the background — check server logs for progress ([StackersAnalytics] lines).
app.get('/db/stackers/snapshot', auth, async (req, res) => {
  try {
    res.json({ ok: true, message: 'Stackers snapshot started — running in background, check server logs ([StackersAnalytics] lines) for progress' });
    takeStackersSnapshot(pool).catch(e => {
      console.error('[/db/stackers/snapshot] background snapshot failed:', e.message);
    });
  } catch(e) {
    console.error('/db/stackers/snapshot error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/backfill-image-cache — proactively caches every
// Stacker token's image, so /download can serve from Postgres instead of
// a live IPFS fetch on every request. Safe to re-run — skips tokens
// already cached. Runs in the background, same pattern as the snapshot
// trigger; check server logs ([StackersImageCache] lines) for progress.
app.get('/db/stackers/backfill-image-cache', auth, async (req, res) => {
  try {
    const { backfillStackerImageCache } = require('./lib/stackers-image-cache');
    res.json({ ok: true, message: 'Stackers image cache backfill started — running in background, check server logs ([StackersImageCache] lines) for progress' });
    backfillStackerImageCache(pool).catch(e => {
      console.error('[/db/stackers/backfill-image-cache] background backfill failed:', e.message);
    });
  } catch(e) {
    console.error('/db/stackers/backfill-image-cache error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/backfill-token-status — one-time seed for the
// event-driven tier/active/split cache. The status poller only tracks
// changes going forward from whenever it first starts; tokens already
// activated/tiered/split before that need this initial full read once.
// Deliberately skips vault balance entirely (getStackerStatusOnly, not
// getStackerInfo), so this is meaningfully faster than the full analytics
// snapshot. Safe to re-run — only touches tokens not already in the cache.
app.get('/db/stackers/backfill-token-status', auth, async (req, res) => {
  try {
    const { backfillTokenStatus } = require('./lib/stackers-status-poller');
    const force = req.query.force === 'true';
    res.json({ ok: true, message: `Stackers token-status backfill started${force ? ' (force mode)' : ''} — running in background, check server logs ([StackersStatus] lines) for progress` });
    backfillTokenStatus(pool, force).catch(e => {
      console.error('[/db/stackers/backfill-token-status] background backfill failed:', e.message);
    });
  } catch(e) {
    console.error('/db/stackers/backfill-token-status error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/backfill-vault-balances — one-time seed for vault
// balance specifically, kept separate from the tier/status backfill above.
// The live listener (Credited/Claimed events) only tracks changes going
// forward; tokens with existing balance before it first started need this
// initial read once. Safe to re-run — skips tokens that already have
// vault_balances populated unless ?force=true.
app.get('/db/stackers/backfill-vault-balances', auth, async (req, res) => {
  try {
    const { backfillVaultBalances } = require('./lib/stackers-status-poller');
    const force = req.query.force === 'true';
    res.json({ ok: true, message: `Stackers vault-balance backfill started${force ? ' (force mode)' : ''} — running in background, check server logs ([StackersStatus] lines) for progress` });
    backfillVaultBalances(pool, force).catch(e => {
      console.error('[/db/stackers/backfill-vault-balances] background backfill failed:', e.message);
    });
  } catch(e) {
    console.error('/db/stackers/backfill-vault-balances error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/take-vault-snapshot — manually trigger a live vault
// snapshot. Unlike the other backfill triggers, this is a pure aggregation
// of already-live data (no on-chain reads at all), so it's essentially
// instant -- returns the actual snapshot result directly rather than
// running in the background, since there's no meaningful wait involved.
app.get('/db/stackers/take-vault-snapshot', auth, async (req, res) => {
  try {
    const { takeLiveVaultSnapshot } = require('./lib/stackers-analytics');
    const totals = await takeLiveVaultSnapshot(pool);
    res.json({ ok: true, vaultTotals: totals });
  } catch(e) {
    console.error('/db/stackers/take-vault-snapshot error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/wallet-full-status-debug/:wallet — full tier/active/
// split/vault detail for every Stacker a wallet holds, not just vault
// totals. Reuses getHeldTokenIds (a single OpenSea call, not Alchemy RPC)
// for the real, current owner list, then pulls per-token detail from the
// already-live stackers_token_status data -- no on-chain reads for that
// part at all. Built for strategy planning, where knowing each token's
// current tier/active state (not just its vault balance) is what actually
// matters for deciding what to burn or stake next.
app.get('/db/stackers/wallet-full-status-debug/:wallet', auth, async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if(!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return res.status(400).json({ ok: false, error: 'valid wallet address required' });

    const { getHeldTokenIds } = require('./lib/stackers-wallet-vault');
    const tokenIds = await getHeldTokenIds(wallet.toLowerCase());

    if(!tokenIds.length){
      return res.json({ ok: true, wallet, tokenCount: 0, tokens: [] });
    }

    const statusRes = await pool.query(
      `SELECT token_id, tier_index, is_active, split, vault_balances FROM stackers_token_status WHERE token_id = ANY($1)`,
      [tokenIds]
    );
    const statusByToken = new Map(statusRes.rows.map(r => [r.token_id, r]));

    const TIER_MULTIPLIERS = [1.0, 1.4, 1.9, 2.5, 3.5]; // confirmed from Stackers' own docs table, indexed by tier_index

    const tokens = tokenIds.map(tokenId => {
      const status = statusByToken.get(tokenId);
      if(!status){
        return { tokenId, hasStatusData: false };
      }
      return {
        tokenId,
        hasStatusData: true,
        isActive: status.is_active,
        tierIndex: status.tier_index,
        multiplier: status.tier_index !== null ? TIER_MULTIPLIERS[status.tier_index] : null,
        split: status.split,
        vaultBalances: status.vault_balances,
      };
    });

    res.json({ ok: true, wallet, tokenCount: tokenIds.length, tokens });
  } catch(e) {
    console.error(`/db/stackers/wallet-full-status-debug/${req.params.wallet} error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/round-history-debug — real recorded RoundSettled
// data, as it accumulates via the live listener. Exists to verify this is
// actually working and building up real history, and to give a quick
// sanity check on the numbers (average pot/weight) rather than needing to
// query the table directly.
app.get('/db/stackers/round-history-debug', auth, async (req, res) => {
  try {
    const { getRecentRoundHistory } = require('./lib/stackers-analytics');
    const hours = parseInt(req.query.hours, 10) || 24;
    const rows = await getRecentRoundHistory(pool, hours);

    let avgPotWei = null, avgWeight = null;
    if(rows.length){
      const totalPot = rows.reduce((sum, r) => sum + BigInt(r.pot_wei), 0n);
      const totalWeight = rows.reduce((sum, r) => sum + BigInt(r.total_weight), 0n);
      avgPotWei = (totalPot / BigInt(rows.length)).toString();
      avgWeight = (totalWeight / BigInt(rows.length)).toString();
    }

    res.json({
      ok: true,
      hoursRequested: hours,
      roundsRecorded: rows.length,
      averagePotWei: avgPotWei,
      averageTotalWeight: avgWeight,
      rounds: rows,
    });
  } catch(e) {
    console.error('/db/stackers/round-history-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/engine-assets-debug — lists every asset the engine
// currently knows about (assetCount + assets(idx) for each index), and
// separately what's actually showing up in the live tier/asset cache's
// split data. Distinguishes "a real asset exists that isn't showing" from
// "an asset was added to the engine but no token has chosen it in their
// split yet" — asset popularity counts chosen splits, not the engine's
// available list, so those are two genuinely different things.
app.get('/db/stackers/engine-assets-debug', auth, async (req, res) => {
  try {
    const { getContracts, resolveAsset, getProvider } = require('./lib/stackers');
    const { engine } = getContracts();
    const provider = getProvider();

    const count = Number(await engine.assetCount());
    const engineAssets = [];
    for(let i = 0; i < count; i++){
      const raw = await engine.assets(i);
      const token1 = raw[0];
      const isStock = raw[raw.length - 1];
      const { symbol } = await resolveAsset(token1, provider).catch(() => ({ symbol: `unknown(${token1})` }));
      engineAssets.push({
        idx: i,
        symbol,
        isStock,
        raw: raw.map(v => v?.toString?.() ?? v), // full raw tuple, for verifying field order if the interpreted symbol/isStock look wrong
      });
    }

    const cachedRes = await pool.query(`SELECT split FROM stackers_token_status WHERE split IS NOT NULL`);
    const chosenSymbols = new Set();
    for(const row of cachedRes.rows){
      for(const s of (row.split || [])){
        if(s?.symbol) chosenSymbols.add(s.symbol);
      }
    }

    res.json({
      ok: true,
      engineAssetCount: count,
      engineAssets,
      symbolsChosenByAnyToken: Array.from(chosenSymbols).sort(),
      registeredButNeverChosen: engineAssets.map(a => a.symbol).filter(s => !chosenSymbols.has(s)),
    });
  } catch(e) {
    console.error('/db/stackers/engine-assets-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/token-split-debug/:tokenId — raw splitOf() and
// vault balance for one specific token, unresolved where symbol lookup
// might fail silently. Exists because a real, personally-confirmed case
// (actively earning STACK) contradicted the engine-assets-debug picture
// (STACK not registered as asset idx 0-12) even on a fresh recheck --
// rather than guess further, this looks at the actual raw data for a
// specific token directly.
app.get('/db/stackers/token-split-debug/:tokenId', auth, async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if(!tokenId) return res.status(400).json({ ok: false, error: 'valid tokenId required' });
    const { getContracts, resolveAsset, getProvider } = require('./lib/stackers');
    const { engine, vault } = getContracts();
    const provider = getProvider();

    const splitRaw = await engine.splitOf(tokenId);
    const [assetIdxs, weightsBps, count] = splitRaw;
    const splitDetail = [];
    for(let i = 0; i < Number(count); i++){
      const idx = Number(assetIdxs[i]);
      let symbol = null, tokenAddress = null, resolveError = null;
      try{
        tokenAddress = await vault.assetToken(idx);
        const resolved = await resolveAsset(tokenAddress, provider);
        symbol = resolved.symbol;
      }catch(e){
        resolveError = e.message;
      }
      splitDetail.push({ assetIdx: idx, weightBps: Number(weightsBps[i]), symbol, tokenAddress, resolveError });
    }

    const balancesRaw = await vault.balancesOf(tokenId);
    const [balanceTokens, balanceAmounts] = balancesRaw;
    const balanceDetail = [];
    for(let i = 0; i < balanceTokens.length; i++){
      if(balanceAmounts[i] === 0n) continue;
      let symbol = null;
      try{
        const resolved = await resolveAsset(balanceTokens[i], provider);
        symbol = resolved.symbol;
      }catch{}
      balanceDetail.push({ tokenAddress: balanceTokens[i], symbol, amountRaw: balanceAmounts[i].toString() });
    }

    res.json({
      ok: true,
      tokenId,
      rawSplitCount: Number(count),
      splitDetail,
      nonZeroVaultBalances: balanceDetail,
    });
  } catch(e) {
    console.error(`/db/stackers/token-split-debug/${req.params.tokenId} error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/token-history-debug/:tokenId — a mobile-friendly
// alternative to reading a block explorer directly. Searches recent
// SplitSet events for one specific token, returning clean JSON: what was
// actually set, when, and the transaction hash for independent
// verification. Confirmed 10-block eth_getLogs cap on this account means a
// deep lookback needs many sequential calls -- defaults to a bounded
// window that should complete within a normal request rather than timing
// out, and reports the actual block/time range covered so a "nothing
// found" result is interpretable (genuinely never happened vs. simply
// outside the window searched), not just a blind yes/no. ?blocks= can
// widen the window if the default isn't deep enough.
// (redeploy-trigger marker: forcing a fresh commit after two prior pushes
// apparently didn't trigger Railway's auto-deploy webhook)
app.get('/db/stackers/token-history-debug/:tokenId', auth, async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if(!tokenId) return res.status(400).json({ ok: false, error: 'valid tokenId required' });
    const lookback = Math.min(parseInt(req.query.blocks, 10) || 1500, 5000);

    const { getContracts, getProvider } = require('./lib/stackers');
    const { engine } = getContracts();
    const provider = getProvider();

    const latest = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - lookback);

    const [latestBlockInfo, fromBlockInfo] = await Promise.all([
      provider.getBlock(latest),
      provider.getBlock(fromBlock),
    ]);
    const hoursSpanned = ((latestBlockInfo.timestamp - fromBlockInfo.timestamp) / 3600).toFixed(1);

    const CHUNK = 10; // confirmed cap on this account
    const events = [];
    for(let start = fromBlock; start <= latest; start += CHUNK){
      const end = Math.min(start + CHUNK - 1, latest);
      const chunkEvents = await engine.queryFilter(engine.filters.SplitSet(tokenId), start, end);
      events.push(...chunkEvents);
    }

    const eventDetail = await Promise.all(events.map(async e => {
      const block = await provider.getBlock(e.blockNumber);
      return {
        blockNumber: e.blockNumber,
        timestamp: new Date(block.timestamp * 1000).toISOString(),
        count: Number(e.args.count),
        txHash: e.transactionHash,
        explorerUrl: `https://robinhoodchain.blockscout.com/tx/${e.transactionHash}`,
      };
    }));

    res.json({
      ok: true,
      tokenId,
      searchedBlocks: `${fromBlock}-${latest}`,
      approxHoursSpanned: hoursSpanned,
      splitSetEventsFound: eventDetail.length,
      events: eventDetail,
    });
  } catch(e) {
    console.error(`/db/stackers/token-history-debug/${req.params.tokenId} error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/block-time-debug — precise seconds-per-block for
// Robinhood Chain. Exists because token-history-debug's default 1500-block
// lookback came back approxHoursSpanned: 0.0 live -- meaning this chain
// produces blocks much faster than assumed when that default was picked,
// and that search was nowhere near deep enough to be conclusive. Uses a
// wide, well-separated sample (10,000 blocks apart) for an accurate
// average rather than local variance from just two adjacent blocks.
app.get('/db/stackers/block-time-debug', auth, async (req, res) => {
  try {
    const { getProvider } = require('./lib/stackers');
    const provider = getProvider();

    const latest = await provider.getBlockNumber();
    const sampleBack = 10000;
    const earlier = Math.max(0, latest - sampleBack);

    const [latestBlock, earlierBlock] = await Promise.all([
      provider.getBlock(latest),
      provider.getBlock(earlier),
    ]);

    const blockSpan = latest - earlier;
    const secondsSpan = latestBlock.timestamp - earlierBlock.timestamp;
    const secondsPerBlock = secondsSpan / blockSpan;
    const blocksPerHour = 3600 / secondsPerBlock;

    res.json({
      ok: true,
      sampledBlocks: `${earlier}-${latest}`,
      secondsSpan,
      secondsPerBlock: secondsPerBlock.toFixed(3),
      blocksPerHour: Math.round(blocksPerHour),
      blocksNeededFor12Hours: Math.round(blocksPerHour * 12),
      blocksNeededFor24Hours: Math.round(blocksPerHour * 24),
    });
  } catch(e) {
    console.error('/db/stackers/block-time-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/wallet-tx-debug/:wallet — a wallet's recent
// transactions to the Stackers engine contract, via Blockscout's own
// indexed API rather than scanning raw blocks via RPC. Exists because
// token-history-debug's RPC approach turned out completely impractical on
// this chain (block-time-debug confirmed ~0.1s/block, meaning a real
// 12-hour search would need 40,000+ sequential eth_getLogs calls at the
// confirmed 10-block cap) -- Blockscout's API is a pre-built, indexed
// database, a genuinely different mechanism that doesn't have this
// problem at all. Tries the modern v2 API first, falls back to the
// legacy etherscan-compatible format if that fails, since it's genuinely
// unconfirmed which this specific instance supports.
app.get('/db/stackers/wallet-tx-debug/:wallet', auth, async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if(!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return res.status(400).json({ ok: false, error: 'valid wallet address required' });
    const { ENGINE_ADDRESS } = require('./lib/stackers');
    const engineAddr = ENGINE_ADDRESS.toLowerCase();

    let source = null;
    let allTxs = [];

    // Try the modern v2 API first
    try{
      const v2Url = `https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet}/transactions`;
      const r = await fetch(v2Url, { headers: { 'Accept': 'application/json' } });
      if(r.ok){
        const data = await r.json();
        if(Array.isArray(data.items)){
          source = 'v2';
          allTxs = data.items.map(tx => ({
            hash: tx.hash,
            to: (tx.to?.hash || '').toLowerCase(),
            timestamp: tx.timestamp,
            status: tx.status,
            methodCalled: tx.method || null,
          }));
        }
      }
    }catch{}

    // Fall back to the legacy etherscan-compatible format
    if(!source){
      const legacyUrl = `https://robinhoodchain.blockscout.com/api?module=account&action=txlist&address=${wallet}&sort=desc`;
      const r = await fetch(legacyUrl, { headers: { 'Accept': 'application/json' } });
      if(r.ok){
        const data = await r.json();
        if(Array.isArray(data.result)){
          source = 'legacy';
          allTxs = data.result.map(tx => ({
            hash: tx.hash,
            to: (tx.to || '').toLowerCase(),
            timestamp: new Date(Number(tx.timeStamp) * 1000).toISOString(),
            status: tx.isError === '1' ? 'error' : 'ok',
            methodCalled: tx.methodId || null,
          }));
        }
      }
    }

    if(!source){
      return res.status(502).json({ ok: false, error: 'Neither Blockscout API format returned usable data — may need to check the site directly' });
    }

    const txsToEngine = allTxs
      .filter(tx => tx.to === engineAddr)
      .slice(0, 20)
      .map(tx => ({ ...tx, explorerUrl: `https://robinhoodchain.blockscout.com/tx/${tx.hash}` }));

    res.json({
      ok: true,
      wallet,
      apiSource: source,
      totalTxsReturned: allTxs.length,
      txsToEngineContract: txsToEngine,
    });
  } catch(e) {
    console.error(`/db/stackers/wallet-tx-debug/${req.params.wallet} error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/contract-abi-debug/:address — fetches the actual
// verified ABI from Blockscout for a given contract, rather than guessing
// a struct's field layout from raw undecoded bytes. Exists specifically
// because the new engine's assets() call returned real data that our old
// ABI's expected 8-field struct couldn't decode -- Stackers' docs mark
// this contract as "(live, verified)," so the real, authoritative
// structure should be fetchable directly instead of reverse-engineered.
app.get('/db/stackers/contract-abi-debug/:address', auth, async (req, res) => {
  try {
    const address = req.params.address;
    if(!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ ok: false, error: 'valid contract address required' });

    let source = null;
    let abi = null;
    const attempts = [];
    let abiAddress = address; // may get reassigned to a resolved proxy implementation below

    async function tryFetchAbi(addr){
      // Modern v2 API first
      try{
        const v2Url = `https://robinhoodchain.blockscout.com/api/v2/smart-contracts/${addr}`;
        const r = await fetch(v2Url, { headers: { 'Accept': 'application/json' } });
        const bodyText = await r.text();
        attempts.push({ format: 'v2', url: v2Url, status: r.status, bodyPreview: bodyText.slice(0, 500) });
        if(r.ok){
          const data = JSON.parse(bodyText);
          if(data.abi) return { source: 'v2', abi: data.abi };
        }
      }catch(e){
        attempts.push({ format: 'v2', error: e.message });
      }
      // Legacy etherscan-compatible format
      try{
        const legacyUrl = `https://robinhoodchain.blockscout.com/api?module=contract&action=getabi&address=${addr}`;
        const r = await fetch(legacyUrl, { headers: { 'Accept': 'application/json' } });
        const bodyText = await r.text();
        attempts.push({ format: 'legacy', url: legacyUrl, status: r.status, bodyPreview: bodyText.slice(0, 500) });
        if(r.ok){
          const data = JSON.parse(bodyText);
          if(data.status === '1' && data.result) return { source: 'legacy', abi: JSON.parse(data.result) };
        }
      }catch(e){
        attempts.push({ format: 'legacy', error: e.message });
      }
      return null;
    }

    let result = await tryFetchAbi(address);

    // Direct ABI fetch failed — check if this is an EIP-1967 proxy before
    // giving up. Confirmed live on the new Stackers NFT contract: Blockscout
    // reports "not verified" and the v2 API returns raw proxy bytecode
    // (references the proxiableUUID() selector 0x52d1902d -- a UUPS-specific
    // function; earlier called this "implementation()" in error, a wrong
    // selector name, though the storage slot checked below is correct
    // regardless of the mislabel) instead of an ABI. The implementation
    // address lives in a standard, well-known storage slot regardless of
    // verification status -- reading it directly via eth_getStorageAt
    // doesn't depend on Blockscout having indexed/linked the proxy at all.
    // Also checks the EIP-1967 BEACON slot as a fallback, in case this is a
    // beacon proxy (implementation address stored on a separate beacon
    // contract) rather than a direct-implementation proxy.
    //
    // Confirmed real bug in an earlier version of this check: the
    // diagnostic attempt was only ever logged in the SUCCESS branch, so a
    // failure for ANY reason (missing ALCHEMY_KEY on this specific
    // deployment, an RPC error, or a genuinely zero slot) left zero trace
    // in the response -- impossible to tell which of those actually
    // happened. Now logs unconditionally regardless of outcome.
    let resolvedImplementation = null;
    if(!result){
      const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
      if(!ALCHEMY_KEY){
        attempts.push({ format: 'eip1967-proxy-detect', skipped: true, reason: 'No ALCHEMY_API_KEY/ALCHEMY_KEY set on this deployment' });
      } else {
        const SLOTS = {
          implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
          beacon:         '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
        };
        const rpcUrl = `https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
        for(const [slotName, slot] of Object.entries(SLOTS)){
          if(resolvedImplementation) break;
          try{
            const r = await fetch(rpcUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getStorageAt', params: [address, slot, 'latest'] }),
            });
            const j = await r.json();
            const slotValue = j.result;
            const isZero = !slotValue || slotValue === '0x' + '0'.repeat(64);
            attempts.push({ format: 'eip1967-proxy-detect', slotChecked: slotName, slot, httpStatus: r.status, rpcError: j.error || null, slotValue, isZero });
            if(!isZero){
              const candidate = '0x' + slotValue.slice(-40);
              // The beacon slot points at a BEACON contract, not the
              // implementation itself — the beacon exposes its own
              // implementation() to look up the real target.
              if(slotName === 'beacon'){
                const beaconR = await fetch(rpcUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: candidate, data: '0x5c60da1b' }, 'latest'] }),
                });
                const beaconJ = await beaconR.json();
                attempts.push({ format: 'eip1967-proxy-detect', beaconAddress: candidate, beaconCallResult: beaconJ.result, beaconCallError: beaconJ.error || null });
                if(beaconJ.result && beaconJ.result !== '0x') resolvedImplementation = '0x' + beaconJ.result.slice(-40);
              } else {
                resolvedImplementation = candidate;
              }
            }
          }catch(e){
            attempts.push({ format: 'eip1967-proxy-detect', slotChecked: slotName, error: e.message });
          }
        }
        if(resolvedImplementation){
          result = await tryFetchAbi(resolvedImplementation);
          if(result) abiAddress = resolvedImplementation;
        }
      }
    }

    if(result){ source = result.source; abi = result.abi; }

    if(!source){
      return res.status(502).json({
        ok: false,
        error: resolvedImplementation
          ? `Detected EIP-1967 proxy pointing to ${resolvedImplementation}, but could not fetch a verified ABI for that implementation address either`
          : 'Could not fetch a verified ABI from either Blockscout API format, and this does not appear to be a standard EIP-1967 proxy',
        resolvedImplementation,
        attempts,
      });
    }

    // Default: just the assets-related functions/events, to keep this
    // readable — the full ABI can be large and most of it isn't relevant
    // for most checks. ?eventsOnly=true instead returns every event the
    // contract emits, unfiltered by name — needed to see the real full
    // picture (e.g. checking for vault-balance-related events) rather than
    // guessing which name patterns might be relevant. ?functionsOnly=true
    // is the same idea for functions — needed to check whether specific
    // functions our code calls (tierBurned, isActive, splitOf, balancesOf)
    // still exist with matching signatures on a migrated contract, not
    // just ones with "asset"/"split" in the name.
    let relevant;
    if(req.query.eventsOnly === 'true'){
      relevant = abi.filter(item => item.type === 'event');
    } else if(req.query.functionsOnly === 'true'){
      relevant = abi.filter(item => item.type === 'function');
    } else {
      relevant = abi.filter(item =>
        (item.name || '').toLowerCase().includes('asset') || (item.name || '').toLowerCase().includes('split')
      );
    }

    res.json({
      ok: true,
      address,
      abiFetchedFrom: abiAddress,
      wasProxy: abiAddress !== address,
      apiSource: source,
      fullAbiLength: abi.length,
      relevantEntries: relevant,
    });
  } catch(e) {
    console.error(`/db/stackers/contract-abi-debug/${req.params.address} error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/raw-logs-check/:address — checks which of our expected
// event signatures actually appear in real, on-chain event logs, entirely
// independent of Blockscout's verification status. Confirmed live: BOTH the
// new Stackers NFT proxy and its resolved implementation are unverified on
// Blockscout, a dead end for the ABI-fetch approach above. Logs are always
// emitted under the calling (proxy) address regardless of delegatecall, so
// querying eth_getLogs against the proxy address directly and comparing the
// real topic0 values against our own code's expected event signatures
// answers the actual question ("does this event still exist, unchanged")
// without needing any verified source at all.
app.get('/db/stackers/raw-logs-check/:address', auth, async (req, res) => {
  try {
    const address = req.params.address;
    if(!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ ok: false, error: 'valid contract address required' });

    // Generalized beyond Stackers/Robinhood Chain specifically -- chain and
    // events are now both parameters instead of hardcoded, so this same
    // endpoint works for checking any contract on any of our supported
    // chains for any event signatures, not just this one original use case.
    const CHAIN_SUBDOMAINS = { ethereum: 'eth-mainnet', base: 'base-mainnet', polygon: 'polygon-mainnet', robinhood: 'robinhood-mainnet' };
    const chain = (req.query.chain || 'robinhood').toLowerCase();
    const subdomain = CHAIN_SUBDOMAINS[chain];
    if(!subdomain) return res.status(400).json({ ok: false, error: `Unsupported chain "${chain}". Supported: ${Object.keys(CHAIN_SUBDOMAINS).join(', ')}` });

    const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
    if(!ALCHEMY_KEY) return res.status(500).json({ ok: false, error: 'Missing ALCHEMY_API_KEY/ALCHEMY_KEY' });
    const rpcUrl = `https://${subdomain}.g.alchemy.com/v2/${ALCHEMY_KEY}`;

    async function rpc(method, params){
      const r = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if(j.error) throw new Error(`${method} RPC error: ${JSON.stringify(j.error)}`);
      return j.result;
    }

    // ?events=Sig1(types),Sig2(types) — comma-separated, defaults to the
    // original Stackers check for backward compatibility with any existing
    // use of this endpoint without the new param.
    const eventsParam = req.query.events
      ? req.query.events.split(',').map(s => s.trim()).filter(Boolean)
      : [
          'Activated(uint256,address,uint256)',
          'Deactivated(uint256)',
          'TierUpgraded(uint256,uint8,uint256)',
          'SplitSet(uint256,uint8)',
          'RoundSettled(uint256,uint256,uint256)',
        ];
    const EXPECTED_EVENTS = {};
    const { id: ethersId } = require('ethers'); // this project uses ethers v6 (confirmed via package.json) -- id() computes keccak256(toUtf8Bytes(sig)) in one call, the v6-native equivalent of v5's utils.id()
    for(const sig of eventsParam){
      EXPECTED_EVENTS[sig] = ethersId(sig);
    }

    const latestHex = await rpc('eth_blockNumber', []);
    const latestBlock = parseInt(latestHex, 16);

    // Window sizes tuned for Robinhood Chain's fast ~10 blocks/sec by
    // default -- Ethereum runs roughly 120x slower (~12s/block), so the
    // same block-count windows cover far less wall-clock time there. An
    // explicit ?fromBlock= always overrides the windowed search entirely,
    // useful when checking whether an older contract has EVER emitted a
    // given event (e.g. an EIP-4906 MetadataUpdate check on a collection
    // that could have been deployed months before any of these windows
    // would reach).
    let windowsChecked = [];
    let foundTopics = new Set();
    if(req.query.fromBlock){
      const fromBlock = parseInt(req.query.fromBlock);
      if(isNaN(fromBlock) || fromBlock < 0) return res.status(400).json({ ok: false, error: 'fromBlock must be a non-negative integer' });
      // Chunked to stay under typical eth_getLogs range limits (commonly
      // ~10-50k blocks per call depending on provider) -- an arbitrary
      // fromBlock could span millions of blocks on a long-lived Ethereum
      // contract.
      const CHUNK = 10000;
      let cursor = fromBlock;
      let callsMade = 0;
      const MAX_CALLS = 50; // hard cap so a very old fromBlock can't run away
      while(cursor <= latestBlock && callsMade < MAX_CALLS){
        const chunkTo = Math.min(cursor + CHUNK - 1, latestBlock);
        const logs = await rpc('eth_getLogs', [{
          address, fromBlock: '0x' + cursor.toString(16), toBlock: '0x' + chunkTo.toString(16),
        }]);
        for(const log of logs) foundTopics.add(log.topics[0]);
        windowsChecked.push({ fromBlock: cursor, toBlock: chunkTo, logsFound: logs.length });
        callsMade++;
        cursor = chunkTo + 1;
      }
      if(cursor <= latestBlock){
        windowsChecked.push({ note: `stopped after ${MAX_CALLS} chunks (${MAX_CALLS * CHUNK} blocks) — did not reach latestBlock, results may be incomplete` });
      }
    } else {
      const WINDOWS = [10000, 50000, 200000];
      for(const windowSize of WINDOWS){
        const fromBlock = Math.max(0, latestBlock - windowSize);
        const logs = await rpc('eth_getLogs', [{
          address, fromBlock: '0x' + fromBlock.toString(16), toBlock: latestHex,
        }]);
        for(const log of logs) foundTopics.add(log.topics[0]);
        windowsChecked.push({ windowSize, fromBlock, toBlock: latestBlock, logsFound: logs.length });
        if(logs.length > 0) break; // no need to widen further once we've seen real activity
      }
    }

    const matches = {};
    for(const [sig, topic0] of Object.entries(EXPECTED_EVENTS)){
      matches[sig] = { topic0, seenInLogs: foundTopics.has(topic0) };
    }

    res.json({
      ok: true,
      address,
      chain,
      latestBlock,
      windowsChecked,
      totalUniqueTopicsSeen: foundTopics.size,
      allTopicsSeen: [...foundTopics],
      expectedEventMatches: matches,
    });
  } catch(e) {
    console.error(`/db/stackers/raw-logs-check/${req.params.address} error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/raw-function-probe/:address — checks whether specific
// functions our code actually calls still exist with matching signatures,
// entirely independent of Blockscout's verification status (same reasoning
// as raw-logs-check above, applied to function calls instead of events).
// Confirmed live: the new Stackers NFT proxy AND its resolved implementation
// are both unverified on Blockscout, so this is the only way to check
// whether tierBurned/isActive/splitOf/balancesOf still work before
// completing the address migration -- a function call reverting outright
// (not just returning different data) would be a much worse failure mode
// than the event-name changes already confirmed on the engine, since these
// specific functions are what the Stackers analytics snapshot job
// (lib/stackers-analytics.js, runs every 15 min) actually depends on for
// every stat it produces.
app.get('/db/stackers/raw-function-probe/:address', auth, async (req, res) => {
  try {
    const address = req.params.address;
    if(!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ ok: false, error: 'valid contract address required' });

    const tokenId = req.query.tokenId || '1';
    const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
    if(!ALCHEMY_KEY) return res.status(500).json({ ok: false, error: 'Missing ALCHEMY_API_KEY/ALCHEMY_KEY' });
    const rpcUrl = `https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

    const { Interface } = require('ethers'); // v6 (confirmed via package.json) -- Interface.encodeFunctionData/decodeFunctionResult verified working locally before deploying this

    // Exact signatures pulled directly from our own existing ABI files
    // (lib/stackers-abis/nft.json, engine.json, vault.json) -- confirmed
    // each selector two independent ways (pycryptodome keccak256 + ethers
    // v6's own id()) before using them here, matching the same discipline
    // as the event-topic check, after hand-typed hex constants caused two
    // real bugs earlier tonight.
    const CANDIDATES = [
      { name: 'tierBurned', sig: 'function tierBurned(uint256) view returns (uint256)' },
      { name: 'isActive',   sig: 'function isActive(uint256) view returns (bool)' },
      { name: 'splitOf',    sig: 'function splitOf(uint256) view returns (uint8[3],uint16[3],uint8)' },
      { name: 'balancesOf', sig: 'function balancesOf(uint256) view returns (address[],uint256[])' },
    ];

    const results = [];
    for(const { name, sig } of CANDIDATES){
      const iface = new Interface([sig]);
      const calldata = iface.encodeFunctionData(name, [tokenId]);
      try{
        const r = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: calldata }, 'latest'] }),
        });
        const j = await r.json();
        if(j.error){
          results.push({ name, sig, reverted: true, error: j.error.message || JSON.stringify(j.error) });
          continue;
        }
        const raw = j.result;
        let decoded = null, decodeError = null;
        try{
          decoded = iface.decodeFunctionResult(name, raw).toString();
        }catch(e){
          // A successful call with data that doesn't match our expected
          // return shape (rather than an outright revert) still needs to be
          // surfaced clearly -- it means SOMETHING responded at this
          // selector, but not necessarily the function we think it is.
          decodeError = e.message;
        }
        results.push({ name, sig, reverted: false, rawResult: raw, rawByteLength: (raw.length - 2) / 2, decoded, decodeError });
      }catch(e){
        results.push({ name, sig, reverted: true, error: e.message });
      }
    }

    res.json({ ok: true, address, tokenId, results });
  } catch(e) {
    console.error(`/db/stackers/raw-function-probe/${req.params.address} error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/asset-count-only-debug — just assetCount(), nothing
// else. Exists because assets(idx) on the new engine returned real data
// our old ABI's 8-field struct couldn't decode, and the new contract isn't
// verified yet (confirmed directly: Blockscout returns "Contract source
// code not verified"), so the real struct layout can't be pulled
// authoritatively right now. assetCount() itself is a simple uint8 with no
// struct to get wrong — far lower risk of a bad guess than reverse-
// engineering assets()'s full layout from raw bytes would be.
app.get('/db/stackers/asset-count-only-debug', auth, async (req, res) => {
  try {
    const { getContracts } = require('./lib/stackers');
    const { engine } = getContracts();
    const count = await engine.assetCount();
    res.json({ ok: true, assetCount: Number(count) });
  } catch(e) {
    console.error('/db/stackers/asset-count-only-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/version-debug — which commit is actually running right now.
// Exists because "just wait for deployment" was already guessed once and
// turned out wrong -- a live check reported the old Vault Listing Alerts
// wording even after the fix was confirmed pushed to GitHub. Railway
// injects git commit info as environment variables automatically, so this
// reports that directly rather than guessing about deployment timing again.
app.get('/db/version-debug', auth, async (req, res) => {
  res.json({
    ok: true,
    railwayGitCommitSha: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    railwayGitCommitMessage: process.env.RAILWAY_GIT_COMMIT_MESSAGE || null,
    railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
    serverTimeNow: new Date().toISOString(),
  });
});

// ── GET /db/stackers/poller-status-debug — real cursor position for both
// Stackers pollers vs. the current chain head. Exists to answer a
// concrete question directly: is a poller still working through a real
// backlog (expected, temporary, will resolve on its own) or has it
// genuinely stopped advancing (a real problem worth digging into), rather
// than guessing from a missing alert alone.
app.get('/db/stackers/poller-status-debug', auth, async (req, res) => {
  try {
    const { dbLoad } = require('./lib/db');
    const { getProvider } = require('./lib/stackers');
    const provider = getProvider();

    const [fusionCursorRaw, statusCursorRaw, latest] = await Promise.all([
      dbLoad('stackers_fusion_last_block').catch(() => null),
      dbLoad('stackers_status_last_block').catch(() => null),
      provider.getBlockNumber(),
    ]);

    const fusionCursor = fusionCursorRaw ? parseInt(fusionCursorRaw, 10) : null;
    const statusCursor = statusCursorRaw ? parseInt(statusCursorRaw, 10) : null;
    const secondsPerBlock = 0.1; // confirmed live earlier tonight

    res.json({
      ok: true,
      latestBlock: latest,
      fusionPoller: fusionCursor === null ? null : {
        cursor: fusionCursor,
        blocksBehind: latest - fusionCursor,
        approxMinutesBehind: ((latest - fusionCursor) * secondsPerBlock / 60).toFixed(1),
      },
      statusPoller: statusCursor === null ? null : {
        cursor: statusCursor,
        blocksBehind: latest - statusCursor,
        approxMinutesBehind: ((latest - statusCursor) * secondsPerBlock / 60).toFixed(1),
      },
    });
  } catch(e) {
    console.error('/db/stackers/poller-status-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/vault-listings-funnel-debug — breaks down exactly
// where the /stackers listings count narrows, step by step. Exists
// because a small result count (6 tokens) raised a real question of
// whether that's genuinely correct or a bug somewhere in the join/filter
// -- rather than guess either way, this shows the real number at each
// stage: total listed, of those how many have any status row at all, of
// those how many have vault_balances populated, of those how many are
// actually non-empty (the real filter used), and for context how many
// listed tokens are marked active at all (since an inactive token has no
// way to be earning anything in the first place).
app.get('/db/stackers/vault-listings-funnel-debug', auth, async (req, res) => {
  try {
    const { STACKERS_SLUG } = require('./lib/stackers');

    const totalListed = await pool.query(
      `SELECT COUNT(*) FROM listings WHERE collection_slug = $1`, [STACKERS_SLUG]
    );
    const hasAnyStatusRow = await pool.query(
      `SELECT COUNT(*) FROM listings l JOIN stackers_token_status s ON s.token_id = l.token_id WHERE l.collection_slug = $1`,
      [STACKERS_SLUG]
    );
    const hasNonNullBalances = await pool.query(
      `SELECT COUNT(*) FROM listings l JOIN stackers_token_status s ON s.token_id = l.token_id WHERE l.collection_slug = $1 AND s.vault_balances IS NOT NULL`,
      [STACKERS_SLUG]
    );
    const hasNonEmptyBalances = await pool.query(
      `SELECT COUNT(*) FROM listings l JOIN stackers_token_status s ON s.token_id = l.token_id WHERE l.collection_slug = $1 AND s.vault_balances IS NOT NULL AND jsonb_array_length(s.vault_balances) > 0`,
      [STACKERS_SLUG]
    );
    const isActive = await pool.query(
      `SELECT COUNT(*) FROM listings l JOIN stackers_token_status s ON s.token_id = l.token_id WHERE l.collection_slug = $1 AND s.is_active = true`,
      [STACKERS_SLUG]
    );

    res.json({
      ok: true,
      totalCurrentlyListed: parseInt(totalListed.rows[0].count, 10),
      listedWithAnyStatusRow: parseInt(hasAnyStatusRow.rows[0].count, 10),
      listedWithNonNullVaultBalances: parseInt(hasNonNullBalances.rows[0].count, 10),
      listedWithNonEmptyVaultBalances: parseInt(hasNonEmptyBalances.rows[0].count, 10),
      listedAndActive: parseInt(isActive.rows[0].count, 10),
    });
  } catch(e) {
    console.error('/db/stackers/vault-listings-funnel-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/trait-check-debug — checks whether Stackers trait
// data exists in token_traits at all, and specifically whether a "Fused"
// trait is present. Exists because a genuinely better data source might
// already exist (Fused as a real OpenSea-filterable trait, confirmed via
// screenshot) rather than needing forward-only event tracking from
// scratch -- checking before building on an assumption either way.
app.get('/db/stackers/trait-check-debug', auth, async (req, res) => {
  try {
    const totalRows = await pool.query(
      `SELECT COUNT(*) FROM token_traits WHERE collection_slug = 'stackersxyz'`
    );
    const distinctTraitNames = await pool.query(
      `SELECT DISTINCT trait_name FROM token_traits WHERE collection_slug = 'stackersxyz' ORDER BY trait_name`
    );
    const fusedValues = await pool.query(
      `SELECT trait_value, COUNT(*) FROM token_traits WHERE collection_slug = 'stackersxyz' AND trait_name ILIKE '%fused%' GROUP BY trait_value`
    );
    const fusedSample = await pool.query(
      `SELECT token_id, trait_value FROM token_traits WHERE collection_slug = 'stackersxyz' AND trait_name ILIKE '%fused%' AND trait_value != 'No' LIMIT 5`
    );

    res.json({
      ok: true,
      totalStackersTraitRows: parseInt(totalRows.rows[0].count, 10),
      distinctTraitNames: distinctTraitNames.rows.map(r => r.trait_name),
      fusedTraitValueCounts: fusedValues.rows,
      fusedSample: fusedSample.rows,
    });
  } catch(e) {
    console.error('/db/stackers/trait-check-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/fusion-trait-debug — checks the real shape of
// Burned, $STACK Burned, and Rarity traits before building anything on
// them. Includes the specific tokens from a real reference screenshot
// ── GET /db/collection-registry-debug/:slug — checks whether a collection's
// onboarding actually completed and what chain got stored for it. Built to
// answer a real, live question: is a wrong-chain link caused by the chain
// lookup logic itself, or by the collections row simply not existing yet
// because onboarding never fully completed for this slug.
app.get('/db/collection-registry-debug/:slug', auth, async (req, res) => {
  try {
    const slug = req.params.slug;
    const collRow = await pool.query(
      `SELECT slug, contract, chain, name, total_supply, token_standard, updated_at FROM collections WHERE slug=$1`,
      [slug]
    );
    const backfillRow = await pool.query(
      `SELECT slug, status, started_at, finished_at, tokens_written, error FROM collection_backfill_status WHERE slug=$1`,
      [slug]
    );
    const traitCount = await pool.query(
      `SELECT COUNT(*) FROM token_traits WHERE collection_slug=$1`,
      [slug]
    );
    res.json({
      ok: true,
      collectionsRow: collRow.rows[0] || null,
      backfillStatus: backfillRow.rows[0] || null,
      tokenTraitsRowCount: parseInt(traitCount.rows[0].count, 10),
    });
  } catch(e) {
    console.error('/db/collection-registry-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/eip4906-check/:chain/:contract — checks whether a contract
// actually declares EIP-4906 support (MetadataUpdate/BatchMetadataUpdate
// events) via the standard EIP-165 supportsInterface(0x49064906) call.
// Built to independently verify a specific external claim before building
// any architecture around it: does this contract genuinely support the
// standard, or does it just happen to define events with matching names/
// signatures without ever emitting them or declaring the interface at all.
// A contract can define an event without implementing supportsInterface
// correctly, so this check and a raw event-log check (raw-logs-check) are
// complementary, not redundant — this confirms the contract SAYS it
// supports the standard; that one confirms it has ACTUALLY fired the event
// in practice.
app.get('/db/eip4906-check/:chain/:contract', auth, async (req, res) => {
  try {
    const { chain, contract } = req.params;
    if(!/^0x[0-9a-fA-F]{40}$/.test(contract)) return res.status(400).json({ ok: false, error: 'valid contract address required' });

    const CHAIN_SUBDOMAINS = { ethereum: 'eth-mainnet', base: 'base-mainnet', polygon: 'polygon-mainnet', robinhood: 'robinhood-mainnet' };
    const subdomain = CHAIN_SUBDOMAINS[(chain || 'ethereum').toLowerCase()];
    if(!subdomain) return res.status(400).json({ ok: false, error: `Unsupported chain "${chain}". Supported: ${Object.keys(CHAIN_SUBDOMAINS).join(', ')}` });

    const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
    if(!ALCHEMY_KEY) return res.status(500).json({ ok: false, error: 'Missing ALCHEMY_API_KEY/ALCHEMY_KEY' });
    const rpcUrl = `https://${subdomain}.g.alchemy.com/v2/${ALCHEMY_KEY}`;

    // supportsInterface(bytes4) selector 0x01ffc9a7 -- the well-known,
    // standardized EIP-165 selector, independently verified via keccak256
    // before use rather than trusted from memory (same discipline as every
    // other selector/topic0 computed tonight, after two real bugs earlier
    // from hand-typed hex constants).
    // EIP-4906's own interface ID is 0x49064906, right-padded to a full
    // 32-byte word as the bytes4 parameter.
    const calldata = '0x01ffc9a7' + '4906490600000000000000000000000000000000000000000000000000000000';

    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data: calldata }, 'latest'] }),
    });
    const j = await r.json();

    if(j.error){
      // A revert here is itself informative -- many older/simpler contracts
      // don't implement supportsInterface at all and revert on any call to
      // it, which is different from implementing it and returning false.
      return res.json({ ok: true, contract, chain, supportsEip4906: false, note: 'Call reverted or errored -- contract likely does not implement supportsInterface (EIP-165) at all, which is different from implementing it and returning false', rpcError: j.error });
    }

    const result = (j.result || '').toLowerCase();
    // ABI-encoded bool: 32 bytes, all zero except the last byte (0 or 1).
    const supportsEip4906 = result.endsWith('01') && result !== '0x';

    res.json({ ok: true, contract, chain, supportsEip4906, rawResult: j.result });
  } catch(e) {
    console.error('/db/eip4906-check error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/metadata-catchup/:slug — one-time historical scan for a
// collection's own MetadataUpdate/BatchMetadataUpdate events, refreshing
// every affected token once. The regular poller (lib/metadata-update-poller.js)
// deliberately only watches forward from a small lookback window — it never
// backfills history on its own. This exists specifically for tokens that
// already changed before the poller existed (confirmed live: argonauts
// #4210's updated glasses trait never got picked up by the regular cycle,
// since nothing "new" happens to it going forward unless the project
// pushes another change to that same token).
//
// Requires ?fromBlock= explicitly — deliberately no default to 0, since
// scanning a contract's entire history unconditionally could be an
// enormous number of chunked eth_getLogs calls for an old contract. Use
// /db/stackers/raw-logs-check first (with ?events=MetadataUpdate(uint256),
// BatchMetadataUpdate(uint256,uint256) and a wide fromBlock=) to find out
// how far back this contract's first relevant event actually goes before
// running this.
app.get('/db/metadata-catchup/:slug', auth, async (req, res) => {
  try {
    const { slug } = req.params;
    const fromBlock = parseInt(req.query.fromBlock);
    if(isNaN(fromBlock) || fromBlock < 0) return res.status(400).json({ ok: false, error: 'valid ?fromBlock= required (non-negative integer) — see endpoint comment for how to determine it first' });

    const { pgPool } = require('./lib/db');
    const colRes = await pgPool.query('SELECT slug, contract, chain FROM collections WHERE slug=$1', [slug]);
    if(!colRes.rows.length) return res.status(404).json({ ok: false, error: `No collection found with slug "${slug}"` });
    const col = colRes.rows[0];

    const { catchUpMetadataHistory } = require('./lib/metadata-update-poller');
    const result = await catchUpMetadataHistory({ slug: col.slug, contract: col.contract, chain: col.chain, fromBlock });
    res.json(result);
  } catch(e) {
    console.error('/db/metadata-catchup error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/alchemy-nft-test/:chain/:contract — calls Alchemy's
// getNFTsForContract directly for a given chain/contract and shows the raw
// result. Built to answer a real, live question: is the backfill writing
// zero tokens because Alchemy's NFT API genuinely returns nothing for this
// specific, recently-migrated contract (its indexer hasn't caught up yet),
// or because something in our own backfill code is the actual problem.
app.get('/db/alchemy-nft-test/:chain/:contract', auth, async (req, res) => {
  try {
    const { chain, contract } = req.params;
    const SUPPORTED = { ethereum: 'eth-mainnet', base: 'base-mainnet', polygon: 'polygon-mainnet', robinhood: 'robinhood-mainnet', ink: 'ink-mainnet' };
    const subdomain = SUPPORTED[chain];
    if(!subdomain) return res.status(400).json({ ok: false, error: `Unsupported chain "${chain}"` });

    const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
    if(!ALCHEMY_KEY) return res.status(500).json({ ok: false, error: 'Missing ALCHEMY_API_KEY/ALCHEMY_KEY' });

    const url = new URL(`https://${subdomain}.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTsForContract`);
    url.searchParams.set('contractAddress', contract);
    url.searchParams.set('withMetadata', 'true');
    url.searchParams.set('limit', req.query.tokenId ? '1' : '5');
    // Confirmed live: a manual re-backfill with forceRefresh=true (added
    // last commit) still showed stale traits even after running it twice --
    // this directly checks whether ALCHEMY ITSELF is still serving stale
    // data for one specific token with refreshCache explicitly set, rather
    // than inferring it from our own backfill's downstream behavior.
    // ?tokenId= targets one exact token via startToken instead of always
    // returning the collection's first 5. ?refreshCache=true/false lets
    // both be tested directly against the same token for comparison.
    if(req.query.tokenId) url.searchParams.set('startToken', String(req.query.tokenId));
    if(req.query.refreshCache != null) url.searchParams.set('refreshCache', req.query.refreshCache === 'true' ? 'true' : 'false');

    const r = await fetch(url.toString());
    const bodyText = await r.text();
    let body;
    try { body = JSON.parse(bodyText); } catch(_) { body = { rawText: bodyText.slice(0, 500) }; }

    res.json({
      ok: true,
      httpStatus: r.status,
      subdomain,
      contract,
      requestedTokenId: req.query.tokenId || null,
      requestedRefreshCache: req.query.refreshCache || null,
      nftsReturned: Array.isArray(body?.nfts) ? body.nfts.length : null,
      totalCount: body?.totalCount ?? null,
      pageKey: body?.pageKey ?? null,
      firstNftSample: body?.nfts?.[0] || null,
      rawBodyIfNoNftsField: body?.nfts ? undefined : body,
    });
  } catch(e) {
    console.error('/db/alchemy-nft-test error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/ipfs-resolve-test — check where a single token's image/metadata
// actually lives, WITHOUT running any part of a real backfill ─────────────
// Two ways to call it:
//   ?uri=ipfs://<cid>/<path>              — test gateways directly against a
//                                            known URI (e.g. copied from a
//                                            backfill's own log output)
//   ?chain=robinhood&contract=0x..&tokenId=5 — resolves the real on-chain
//                                              tokenURI first via eth_call,
//                                              then tests gateways against it
// Tests every gateway INDIVIDUALLY (not racing to first success like the
// real backfill does) so it reports each one's own outcome + response time —
// this answers "which gateway(s) actually work for this content" directly,
// in one request, instead of inferring it from a multi-minute page-by-page
// backfill run.
app.get('/db/ipfs-resolve-test', auth, async (req, res) => {
  try {
    const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
    const SUPPORTED = { ethereum: 'eth-mainnet', base: 'base-mainnet', polygon: 'polygon-mainnet', robinhood: 'robinhood-mainnet' };

    let uri = req.query.uri ? String(req.query.uri) : null;
    let tokenUriSource = uri ? 'provided directly' : null;

    if(!uri){
      const { chain, contract, tokenId } = req.query;
      if(!chain || !contract || !tokenId){
        return res.status(400).json({ ok: false, error: 'Provide either ?uri=ipfs://... OR ?chain=&contract=&tokenId=' });
      }
      const subdomain = SUPPORTED[String(chain)];
      if(!subdomain) return res.status(400).json({ ok: false, error: `Unsupported chain "${chain}"` });
      if(!ALCHEMY_KEY) return res.status(500).json({ ok: false, error: 'Missing ALCHEMY_API_KEY/ALCHEMY_KEY' });
      try{
        uri = await fetchRawTokenUri(String(contract), parseInt(tokenId), ALCHEMY_KEY, subdomain);
        tokenUriSource = `resolved on-chain via eth_call on ${subdomain}`;
      }catch(e){
        return res.status(502).json({ ok: false, error: `Failed to resolve on-chain tokenURI: ${e.message}` });
      }
    }

    const diagnosis = await diagnoseIpfsGateways(uri, ALCHEMY_KEY, req.query.chain ? SUPPORTED[String(req.query.chain)] : 'eth-mainnet');
    res.json({ ok: true, tokenUri: uri, tokenUriSource, ...diagnosis });
  } catch(e) {
    console.error('/db/ipfs-resolve-test error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// (#511 absorbed into #107) so actual values can be cross-checked
// against what Stackers' own official bot displayed for that exact fusion.
app.get('/db/stackers/fusion-trait-debug', auth, async (req, res) => {
  try {
    const burnedValues = await pool.query(
      `SELECT trait_value, COUNT(*) FROM token_traits WHERE collection_slug = 'stackersxyz' AND trait_name = 'Burned' GROUP BY trait_value ORDER BY COUNT(*) DESC LIMIT 10`
    );
    const stackBurnedSample = await pool.query(
      `SELECT token_id, trait_value FROM token_traits WHERE collection_slug = 'stackersxyz' AND trait_name = '$STACK Burned' LIMIT 5`
    );
    const rarityValues = await pool.query(
      `SELECT trait_value, COUNT(*) FROM token_traits WHERE collection_slug = 'stackersxyz' AND trait_name = 'Rarity' GROUP BY trait_value ORDER BY COUNT(*) DESC LIMIT 10`
    );
    const referenceTokens = await pool.query(
      `SELECT token_id, trait_name, trait_value FROM token_traits WHERE collection_slug = 'stackersxyz' AND token_id IN (511, 107) AND trait_name IN ('Burned', '$STACK Burned', 'Rarity', 'Fused', 'Multiplier', 'Tier') ORDER BY token_id, trait_name`
    );

    res.json({
      ok: true,
      burnedTraitValueCounts: burnedValues.rows,
      stackBurnedSample: stackBurnedSample.rows,
      rarityValueCounts: rarityValues.rows,
      referenceTokens: referenceTokens.rows,
    });
  } catch(e) {
    console.error('/db/stackers/fusion-trait-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/catchup-fusion, /db/stackers/catchup-status —
// manually-triggered catch-up bursts, separate from the automatic
// background polling rate. Confirmed live the automatic rate alone cannot
// realistically clear the actual backlog (fusion: ~46.7h behind at only
// +2 blocks/min net; status: ~10h behind and actively getting WORSE at
// -298 blocks/min net) -- a permanently higher automatic rate was
// considered but rejected given the confirmed rate-limit sensitivity on
// this account; a bounded, one-time burst is a safer way to actually
// clear the backlog without raising the permanent baseline risk.
// Loops repeatedly (no delay between iterations, unlike the 60s automatic
// cadence) until caught up or a time budget is hit, logging progress
// periodically. Runs in the background; check server logs for progress.
const CATCHUP_TIME_BUDGET_MS = 60 * 60 * 1000; // 1 hour ceiling per trigger
const CATCHUP_CHUNK_CAP = 500; // 5000 blocks per poll-function call during the burst

app.get('/db/stackers/catchup-fusion', auth, async (req, res) => {
  try {
    const { pollFusionEvents } = require('./lib/stackers-fusion-poller');
    res.json({ ok: true, message: 'Fusion catch-up burst started — running in background for up to 1 hour, check server logs ([StackersFusion] lines) for progress' });
    (async () => {
      const startedAt = Date.now();
      let iterations = 0;
      while(Date.now() - startedAt < CATCHUP_TIME_BUDGET_MS){
        await pollFusionEvents(CATCHUP_CHUNK_CAP).catch(e => console.error('[FusionCatchup] iteration failed:', e.message));
        iterations++;
        if(iterations % 5 === 0) console.log(`[FusionCatchup] ${iterations} iterations completed so far`);
      }
      console.log(`[FusionCatchup] Time budget reached after ${iterations} iterations`);
    })();
  } catch(e) {
    console.error('/db/stackers/catchup-fusion error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/db/stackers/catchup-status', auth, async (req, res) => {
  try {
    const { pollTokenStatusEvents } = require('./lib/stackers-status-poller');
    res.json({ ok: true, message: 'Status catch-up burst started — running in background for up to 1 hour, check server logs ([StackersStatus] lines) for progress' });
    (async () => {
      const startedAt = Date.now();
      let iterations = 0;
      while(Date.now() - startedAt < CATCHUP_TIME_BUDGET_MS){
        await pollTokenStatusEvents(pool, CATCHUP_CHUNK_CAP).catch(e => console.error('[StatusCatchup] iteration failed:', e.message));
        iterations++;
        if(iterations % 5 === 0) console.log(`[StatusCatchup] ${iterations} iterations completed so far`);
      }
      console.log(`[StatusCatchup] Time budget reached after ${iterations} iterations`);
    })();
  } catch(e) {
    console.error('/db/stackers/catchup-status error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/websocket-debug — checks whether this Alchemy
// account actually supports a live WebSocket connection to Robinhood
// Chain, before committing to building anything on top of it (a live
// eth_subscribe-based listener would sidestep the eth_getLogs block-range
// limitation entirely, rather than continuing to work around it). Same
// host as the existing HTTP RPC endpoint, wss:// instead of https:// --
// Alchemy's standard convention. Times out after 10s rather than hanging
// the request indefinitely, and always cleans up the connection via
// provider.destroy() regardless of success or failure.
app.get('/db/stackers/websocket-debug', auth, async (req, res) => {
  const key = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  if(!key) return res.status(500).json({ ok: false, error: 'Missing ALCHEMY_API_KEY/ALCHEMY_KEY env var' });

  const wssUrl = `wss://robinhood-mainnet.g.alchemy.com/v2/${key}`;
  let provider = null;

  try{
    const { ethers } = require('ethers');
    provider = new ethers.WebSocketProvider(wssUrl);

    const blockNumber = await Promise.race([
      provider.getBlockNumber(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out after 10s waiting for a response')), 10000)),
    ]);

    res.json({ ok: true, connected: true, blockNumber });
  }catch(e){
    console.error('/db/stackers/websocket-debug error:', e.message);
    res.status(500).json({ ok: false, connected: false, error: e.message });
  }finally{
    if(provider){
      provider.destroy().catch(()=>{});
    }
  }
});


// ── GET /db/schema-debug/:table — direct ground-truth check of a table's
// real, live columns. Exists specifically because code across this
// codebase disagrees about the sales table's actual price column name
// (price_eth vs sale_price) -- rather than guess which is real, checking
// the live database directly.
app.get('/db/schema-debug/:table', auth, async (req, res) => {
  try {
    const table = String(req.params.table || '').toLowerCase();
    if(!/^[a-z_]+$/.test(table)) return res.status(400).json({ ok: false, error: 'invalid table name' });
    const result = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    res.json({ ok: true, table, columns: result.rows });
  } catch(e) {
    console.error(`/db/schema-debug/${req.params.table} error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/cost-basis-debug/:wallet — diagnoses a real cost-basis
// gap (confirmed real secondary purchases showing Spent: Ξ0.0000). Checks
// wallet_token_intervals (what we think this wallet holds and its current
// cost_eth), our own sales table (does our cache have a matching row for
// this wallet as buyer — using price_eth/currency, confirmed via
// /db/schema-debug/sales to be the real live columns), and a live OpenSea
// sale-events lookup for the first held token (does OpenSea itself have
// the record, independent of whether it made it into our own cache) — to
// see which specific layer is actually failing rather than guessing.
app.get('/db/stackers/cost-basis-debug/:wallet', auth, async (req, res) => {
  try {
    const wallet = String(req.params.wallet || '').toLowerCase();
    if(!/^0x[0-9a-f]{40}$/.test(wallet)) return res.status(400).json({ ok: false, error: 'valid wallet address required' });

    const intervalsRes = await pool.query(
      `SELECT token_id, cost_eth, acquired_at FROM wallet_token_intervals
       WHERE wallet_address = $1 AND collection_slug = 'stackersxyz' AND disposed_at IS NULL
       ORDER BY token_id`,
      [wallet]
    );

    const tokenIds = intervalsRes.rows.map(r => r.token_id);
    const salesRes = tokenIds.length ? await pool.query(
      `SELECT token_id, price_eth, currency, buyer, seller, sale_ts FROM sales
       WHERE collection_slug = 'stackersxyz' AND token_id = ANY($1) AND LOWER(buyer) = $2`,
      [tokenIds, wallet]
    ) : { rows: [] };

    let liveOpenSeaCheck = null;
    if(tokenIds.length){
      const testToken = tokenIds[0];
      try{
        const qs = new URLSearchParams({ event_type: 'sale', token_ids: testToken.toString() }).toString();
        const osRes = await fetch(`https://api.opensea.io/api/v2/events/collection/stackersxyz?${qs}`, {
          headers: { 'X-API-KEY': process.env.OPENSEA_KEY || '', 'Accept': 'application/json' }
        });
        const osData = osRes.ok ? await osRes.json() : { error: `HTTP ${osRes.status}` };
        liveOpenSeaCheck = { testedTokenId: testToken, status: osRes.status, eventCount: osData?.asset_events?.length ?? null, raw: osData };
      }catch(e){
        liveOpenSeaCheck = { testedTokenId: testToken, error: e.message };
      }
    }

    res.json({
      ok: true,
      wallet,
      heldTokens: intervalsRes.rows,
      matchingSalesInOurDb: salesRes.rows,
      liveOpenSeaCheck,
    });
  } catch(e) {
    console.error(`/db/stackers/cost-basis-debug/${req.params.wallet} error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/snapshots-debug — direct view of stackers_snapshots rows.
// Diagnostic only, not used by any command. Exists specifically to resolve
// a real discrepancy: server logs showed a snapshot completing successfully,
// but /stackerstats (running in the bot service) reported no snapshot exists
// at all — this checks the table directly rather than guessing why.
app.get('/db/stackers/snapshots-debug', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, snapshot_at, total_tokens, tokens_processed, active_tokens FROM stackers_snapshots ORDER BY snapshot_at DESC LIMIT 10`
    );
    res.json({ ok: true, count: result.rows.length, rows: result.rows });
  } catch(e) {
    console.error('/db/stackers/snapshots-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/tier-weights-debug — raw TIER_BURN/TIER_WEIGHT values
// straight from the contract. Diagnostic only. Real live data just showed
// Tier 1 displaying as (0.0x) instead of the expected 1.0x for the base
// tier — meaning the guessed basis-points conversion in formatTierWeight()
// is wrong. This exists to see the actual raw numbers rather than guess at
// a second conversion factor with no evidence.
app.get('/db/stackers/tier-weights-debug', auth, async (req, res) => {
  try {
    const { getContracts, getTierThresholds } = require('./lib/stackers');
    const { nft } = getContracts();
    const thresholds = await getTierThresholds(nft);
    res.json({
      ok: true,
      thresholds: thresholds.map(t => ({
        index: t.index,
        burnThreshold: t.burn.toString(),
        weightRaw: t.weightRaw.toString(),
      })),
    });
  } catch(e) {
    console.error('/db/stackers/tier-weights-debug error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/token-debug/:tokenId — checks whether a token's image
// mismatch is actually a bug or expected behavior. Stackers' NFT contract
// has an artworkOf(tokenId) function and an ArtworkAssigned event, separate
// from the token ID itself -- a common reveal-shuffle pattern where the art
// shown is deliberately decoupled from the token number. Testing directly
// whether a reported tokenId's assigned artwork differs from the tokenId,
// which would explain a served image that looks "wrong" at a glance but is
// actually correct.
app.get('/db/stackers/token-debug/:tokenId', auth, async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if(!tokenId) return res.status(400).json({ ok: false, error: 'valid tokenId required' });
    const { getContracts } = require('./lib/stackers');
    const { nft } = getContracts();
    const [artworkId, fusedArtId, tokenUri] = await Promise.all([
      nft.artworkOf(tokenId).catch(e => `ERROR: ${e.message}`),
      nft.fusedArt(tokenId).catch(e => `ERROR: ${e.message}`),
      nft.tokenURI(tokenId).catch(e => `ERROR: ${e.message}`),
    ]);
    res.json({
      ok: true,
      tokenId,
      artworkOf: artworkId?.toString?.() ?? artworkId,
      fusedArt: fusedArtId?.toString?.() ?? fusedArtId,
      tokenURI: tokenUri,
    });
  } catch(e) {
    console.error(`/db/stackers/token-debug/${req.params.tokenId} error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/stackers/deployment-block-debug — finds the vault contract's
// real deployment block via binary search on eth_getCode (empty before
// deployment, real bytecode after) rather than guessing. Deliberately
// avoids eth_getLogs entirely for this -- getCode queries a single block
// at a time, so it isn't subject to this account's confirmed 10-block
// range cap on eth_getLogs specifically. O(log n) calls regardless of how
// many total blocks exist, so this is cheap and fast either way. Exists to
// answer a concrete question before deciding whether a full historical
// Claimed-event backfill is actually practical: how many blocks would it
// need to cover, and how many 10-block eth_getLogs calls would that mean.
app.get('/db/stackers/deployment-block-debug', auth, async (req, res) => {
  try {
    const { getProvider, VAULT_ADDRESS } = require('./lib/stackers');
    const provider = getProvider();

    const latest = await provider.getBlockNumber();
    const latestCode = await provider.getCode(VAULT_ADDRESS, latest);
    if(latestCode === '0x'){
      return res.status(500).json({ ok: false, error: 'Contract has no code at the latest block — wrong address, or something is off' });
    }

    let low = 0;
    let high = latest;
    let calls = 0;
    while(low < high){
      const mid = Math.floor((low + high) / 2);
      const code = await provider.getCode(VAULT_ADDRESS, mid);
      calls++;
      if(code === '0x'){
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    const deploymentBlock = low;
    const totalBlocks = latest - deploymentBlock;
    const chunksAt10PerCall = Math.ceil(totalBlocks / 10);

    res.json({
      ok: true,
      deploymentBlock,
      latestBlock: latest,
      totalBlocksSinceDeployment: totalBlocks,
      eth_getLogs_calls_needed_at_10_per_call: chunksAt10PerCall,
      binarySearchCallsUsed: calls,
    });
  } catch(e) {
    console.error('/db/stackers/deployment-block-debug error:', e.message);
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
      `SELECT token_id, price_eth, url FROM listings WHERE collection_slug = $1 ORDER BY price_eth ASC`,
      [slug]
    );
    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      listings: result.rows.map(r => ({
        token_id: parseInt(r.token_id),
        price_eth: parseFloat(r.price_eth),
        url: r.url
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
    const result = await pool.query(
      `SELECT s.token_id, s.price_eth, s.currency, s.sale_ts, t.obs_rank
       FROM sales s JOIN tokens t ON t.id = s.token_id
       WHERE s.sale_ts > NOW() - ($1 || ' days')::INTERVAL
       ORDER BY s.sale_ts DESC LIMIT 2000`,
      [days]
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

    const result = await pool.query(
      `SELECT token_id, price_eth, currency, buyer, seller, tx_hash, sale_ts
       FROM sales
       WHERE token_id = $1
       ORDER BY sale_ts ASC
       LIMIT $2`,
      [tokenId, limit]
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



// ── GET /db/trait-sales ───────────────────────────────────────────────────────
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

    // Join sales with token_traits — case-insensitive match on both trait and value
    const result = await pool.query(
      `SELECT s.token_id, s.price_eth, s.currency, s.sale_ts, s.buyer, s.seller
       FROM sales s
       JOIN token_traits tt ON tt.token_id = s.token_id
       WHERE LOWER(tt.trait_name)  = LOWER($1)
         AND LOWER(tt.trait_value) = LOWER($2)
       ORDER BY s.sale_ts ${sort}
       LIMIT $3`,
      [trait, value, limit]
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

    // Floor before = current minimum across ALL active listings
    const beforeResult = await pool.query(
      `SELECT MIN(price_eth) AS floor_eth FROM listings`
    );
    const floor_before = beforeResult.rows[0]?.floor_eth
      ? parseFloat(beforeResult.rows[0].floor_eth)
      : null;

    // Floor after = minimum excluding swept token IDs
    const afterResult = await pool.query(
      `SELECT MIN(price_eth) AS floor_eth FROM listings
       WHERE token_id != ALL($1::int[])`,
      [sweptIds]
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

    if (!matches.length && !traitCount && rankMin === null && rankMax === null) {
      return res.status(400).json({ ok: false, error: 'provide matches, trait_count, or rank filter' });
    }

    let query = `SELECT l.token_id, l.price_eth, l.url,
                        t.trait_count, t.os_rank, t.obs_rank, t.os_score, t.rarity_score
                 FROM listings l
                 JOIN tokens t ON t.id = l.token_id`;
    const params = [];
    let p = 1;

    const conditions = [ACTIVE_TOKEN_CONDITION];
    groups.forEach((group, i) => {
      const ors = [];
      group.forEach(m => {
        ors.push(`(LOWER(g${i}.trait_name) = LOWER($${p++}) AND LOWER(g${i}.trait_value) = LOWER($${p++}))`);
        params.push(m.trait_name, m.trait_value);
      });
      conditions.push(`EXISTS (SELECT 1 FROM token_traits g${i} WHERE g${i}.token_id = t.id AND (${ors.join(' OR ')}))`);
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
       JOIN tokens t ON t.id = s.token_id
       LEFT JOIN token_traits tt ON tt.token_id = s.token_id
       WHERE t.os_rank >= $1 AND t.os_rank <= $2
       GROUP BY s.token_id, t.os_rank, t.obs_rank, s.price_eth, s.currency, s.sale_ts, s.buyer, s.seller
       ORDER BY s.sale_ts ${sort}
       LIMIT $3`,
      [rankMin, rankMax, limit]
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
       JOIN listings l ON l.token_id = t.id
       LEFT JOIN token_traits tt ON tt.token_id = t.id
       WHERE ${rankCol} >= $1 AND ${rankCol} <= $2
         AND ${ACTIVE_TOKEN_CONDITION}
       GROUP BY t.id, t.obs_rank, t.os_rank, t.os_score, t.trait_count, l.price_eth, l.url
       ORDER BY l.price_eth ASC
       LIMIT $3`,
      [rankMin, rankMax, limit]
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
app.get('/db/os-ranks', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, os_rank FROM tokens WHERE os_rank IS NOT NULL ORDER BY os_rank ASC`
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
    const result = await pool.query(`
      SELECT l.token_id, l.price_eth, l.url,
             t.trait_count, t.os_rank, t.obs_rank
      FROM listings l
      JOIN tokens t ON t.id = l.token_id
      WHERE t.trait_count = $1
      ORDER BY l.price_eth ASC
      LIMIT 1
    `, [traitCount]);

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
  const address = cleanAddress(req.params.address);
  if (!isEthAddress(address)) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  try {
    const cache = await pool.query(
      `SELECT summary_json, updated_at FROM wallet_analytics_cache WHERE wallet_address = $1`,
      [address]
    );
    if (cache.rows.length) {
      res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
      return res.json({ ok: true, address, synced: true, cached: true, updated_at: cache.rows[0].updated_at, summary: cache.rows[0].summary_json });
    }

    // NOTE (2026-07-02): hardcoded to OCAS_SLUG for now, same reasoning as
    // /db/traits-fast and /db/all-traits earlier today — this wasn't scoped
    // at all before, so a wallet's holdings/traits/floor across EVERY
    // configured collection were all merged together. The listings JOIN
    // and the floor query were both unscoped too (token_id collisions +
    // absolute cheapest listing across all collections, not just OCAS).
    const current = await pool.query(`
      SELECT w.token_id, t.os_rank, t.obs_rank, l.price_eth, w.cost_eth
      FROM wallet_token_intervals w
      LEFT JOIN tokens t ON t.id = w.token_id AND t.collection_slug = w.collection_slug
      LEFT JOIN listings l ON l.token_id = w.token_id AND l.collection_slug = w.collection_slug
      WHERE w.wallet_address = $1 AND w.collection_slug = $2 AND w.disposed_at IS NULL
      ORDER BY COALESCE(t.os_rank, t.obs_rank, 999999) ASC
      LIMIT 10000
    `, [address, OCAS_SLUG]);

    const owned = current.rows;
    const ranks = owned.map(r => parseInt(r.os_rank || r.obs_rank)).filter(Number.isFinite);
    const listed = owned.filter(r => r.price_eth != null);
    const floor = await pool.query('SELECT MIN(price_eth) AS floor_eth FROM listings WHERE collection_slug = $1', [OCAS_SLUG]);
    const floorEth = floor.rows[0]?.floor_eth ? parseFloat(floor.rows[0].floor_eth) : null;
    const estimated = floorEth == null ? null : owned.length * floorEth;

    // P&L: realized (closed positions with an actual sale) and unrealized
    // (current holdings' cost basis vs current estimated floor value).
    // Was completely missing from this endpoint before.
    const realizedRes = await pool.query(`
      SELECT COALESCE(SUM(sale_eth - cost_eth), 0) AS realized_pnl, COUNT(*)::int AS sold_count
      FROM wallet_token_intervals
      WHERE wallet_address = $1 AND collection_slug = $2
        AND disposed_at IS NOT NULL AND sale_eth IS NOT NULL AND sale_eth > 0
    `, [address, OCAS_SLUG]);
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
  const address = cleanAddress(req.params.address);
  if (!isEthAddress(address)) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  const limit = intParam(req.query.limit, 100, 1000);
  const offset = intParam(req.query.offset, 0, 10000);
  try {
    const result = await pool.query(`
      SELECT nt.contract, nt.token_id, nt.from_address, nt.to_address, nt.tx_hash, nt.log_index,
             nt.block_number, COALESCE(nt.block_ts, nt.transferred_at) AS block_ts, nt.event_type,
             s.price_eth AS sale_price, s.buyer, s.seller
      FROM nft_transfers nt
      LEFT JOIN sales s ON s.tx_hash = nt.tx_hash AND s.token_id = nt.token_id
      WHERE nt.contract = $1 AND nt.collection_slug = $2 AND (nt.from_address = $3 OR nt.to_address = $3)
      ORDER BY nt.block_number DESC, nt.log_index DESC
      LIMIT $4 OFFSET $5
    `, [OCAS_CONTRACT, OCAS_SLUG, address, limit, offset]);

    // Burns live in their own purpose-built tables (burn_events/burn_event_inputs),
    // separate from nft_transfers entirely -- pull them directly rather than
    // depend on nft_transfers.event_type, which isn't reliably populated for
    // every wallet's historical rows.
    const burnRes = await pool.query(`
      SELECT be.id AS burn_event_id, be.tx_hash, be.block_number, be.log_index, be.burned_at, be.survivor_token_id,
             be.points_used, bei.burned_token_id
      FROM burn_events be
      JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
      WHERE LOWER(be.burner_wallet) = LOWER($1)
      ORDER BY be.block_number DESC
      LIMIT $2
    `, [address, limit]).catch(() => ({ rows: [] })); // tolerate if burn tables aren't present in some env

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
      from_address: address,
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
  const address = cleanAddress(req.params.address);
  if (!isEthAddress(address)) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  try {
    const eventsRes = await pool.query(`
      SELECT id, tx_hash, block_number, burned_at, survivor_token_id, points_used,
             result_is_angel, boost_chance, result_body_type, burn_type
      FROM burn_events
      WHERE LOWER(burner_wallet) = LOWER($1)
      ORDER BY block_number DESC
    `, [address]);
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
  const address = cleanAddress(req.params.address);
  if (!isEthAddress(address)) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  const days = intParam(req.query.days, 90, 365);
  try {
    const result = await pool.query(`
      SELECT snapshot_date, owned_count, best_rank, listed_count, estimated_floor_value
      FROM wallet_daily_snapshots
      WHERE wallet_address = $1
        AND snapshot_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
      ORDER BY snapshot_date ASC
    `, [address, days]);
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
  const address = cleanAddress(req.params.address);
  if (!isEthAddress(address)) return res.status(400).json({ ok: false, error: 'invalid wallet address' });
  const limit = intParam(req.query.limit, 100, 500);
  try {
    const result = await pool.query(`
      SELECT tt.trait_name, tt.trait_value, COUNT(*)::int AS count,
             ARRAY_AGG(w.token_id ORDER BY COALESCE(t.os_rank, t.obs_rank, 999999) ASC) AS token_ids
      FROM wallet_token_intervals w
      JOIN token_traits tt ON tt.token_id = w.token_id AND tt.collection_slug = w.collection_slug
      LEFT JOIN tokens t ON t.id = w.token_id AND t.collection_slug = w.collection_slug
      WHERE w.wallet_address = $1 AND w.collection_slug = $3 AND w.disposed_at IS NULL
      GROUP BY tt.trait_name, tt.trait_value
      ORDER BY count DESC, tt.trait_name ASC, tt.trait_value ASC
      LIMIT $2
    `, [address, limit, OCAS_SLUG]);
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
  try {
    const result = await pool.query(`
      SELECT contract, token_id, from_address, to_address, tx_hash, log_index, block_number, block_ts, event_type
      FROM nft_transfers
      WHERE contract = $1 AND token_id = $2
      ORDER BY block_number ASC, log_index ASC
      LIMIT $3
    `, [OCAS_CONTRACT, tokenId, limit]);
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      ok: true,
      token_id: tokenId,
      contract: OCAS_CONTRACT,
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
    if (isMissingWalletAnalyticsTable(e)) return res.json({ ok: true, token_id: tokenId, synced: false, history: [], count: 0 });
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
    if (!row.rows.length) return res.json({ linked: false });
    res.json({ linked: true, discord_id: row.rows[0].discord_id, guild_id: row.rows[0].guild_id, linked_at: row.rows[0].linked_at });
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
             traits_synced_at, market_synced_at, created_at, updated_at
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
          SELECT t.id, t.image_url
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
          SELECT t.id, t.image_url
          FROM tokens t
          WHERE t.collection_slug = $1
          ORDER BY t.id
        `, [slug]);

    const survivorIds = new Set(survivorsRes.rows.map(r => parseInt(r.id)));
    const imageUrlById = new Map(survivorsRes.rows.map(r => [parseInt(r.id), r.image_url || null]));

    // burn_state_snapshots is OCAS-only ground truth for post-burn survivor
    // images — skip entirely for other collections; tokens.image_url (or
    // token_svg_cache, read separately by the frontend) is the only source.
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
    // preferred for OCAS, tokens.image_url as fallback/only-source otherwise)
    for (const id of survivorIds) {
      tokens[String(id)] = { traits: {}, image: survivorSnapshotImages[id] || imageUrlById.get(id) || null };
    }

    // Populate traits
    for (const { token_id, trait_name, trait_value } of traitsRes.rows) {
      const key = String(token_id);
      if (tokens[key]) {
        tokens[key].traits[trait_name] = trait_value;
      }
    }

    const data = { ok: true, tokens, survivorCount: survivorIds.size };
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
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(2);

// Shared rendering logic used by both the GET (svgUrl, always short — no
// size issue) and POST (svgData, can be large — the actual point of the
// POST path) handlers below, so neither duplicates the sharp/compositing
// work.
async function renderSvgTextToPng(svgText, size = 500){
  const SIZE = size;
  const bgBuf = await sharp(Buffer.from(svgText))
    .resize(SIZE, SIZE, { kernel: 'nearest', fit: 'fill' })
    .png()
    .toBuffer();

  // Extract embedded character PNG and composite, same as original extractPngFromSvg
  const pngMatch = svgText.match(/src=["']data:image\/png;base64,([A-Za-z0-9+/=\s]+)["']/);
  let finalBuf = bgBuf;
  if (pngMatch) {
    try {
      const rawPng = Buffer.from(pngMatch[1].replace(/\s/g, ''), 'base64');
      const charBuf = await sharp(rawPng).resize(SIZE, SIZE, { kernel: 'nearest' }).png().toBuffer();
      finalBuf = await sharp(bgBuf).composite([{ input: charBuf, blend: 'over' }]).png().toBuffer();
    } catch (e) {
      console.warn('[render/svg-token] char composite failed, using full SVG render:', e.message);
    }
  }
  return finalBuf;
}

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

// Runs the same idempotent CREATE TABLE/INDEX IF NOT EXISTS migrations used
// elsewhere -- ensures a brand-new database gets its full schema automatically
// on first deploy, and self-heals if any table/index was ever missing,
// instead of relying on a separate manual step that's easy to forget.
runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`TraitView API running on port ${PORT}`);
    console.log(`Auth: ${API_SECRET ? 'enabled' : (REQUIRE_API_AUTH ? 'REQUIRED BUT MISSING' : 'DISABLED (dev only; set API_SECRET to enable)')}`);
  });
}).catch(e => {
  console.error('[Migrations] Failed to run on startup:', e.message);
  // Still start the server even if migrations failed -- an existing,
  // already-correct database shouldn't be taken down by a migration hiccup.
  app.listen(PORT, () => {
    console.log(`TraitView API running on port ${PORT} (migrations may be incomplete, check logs above)`);
  });
});

