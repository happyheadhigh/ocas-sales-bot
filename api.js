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

// Loaded at module level (not lazily inside a route handler) specifically
// so its setInterval-driven sync loops actually start the moment this
// process boots. Previously this was require()'d only inside the manual
// /db/listings/sync handler, which meant sync-listings.js's top-level code
// — including both setInterval calls — never ran at all unless someone
// manually hit that endpoint at least once. That's the real reason no
// [sync] log lines were ever appearing, on this version or the version
// before today's rewrite.
const syncListingsModule = require('./sync-listings');

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

app.use(express.json());

// ── CORS — allow Cloudflare Worker and traitview.com ─────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    if (!tokenId || tokenId < 1 || tokenId > 10000) {
      return res.status(400).json({ ok: false, error: 'invalid token id' });
    }
    // Defaults to OCAS when no slug is provided so any caller not yet updated
    // to pass one keeps its exact current behavior. Without this scoping,
    // token_id collisions across collections (e.g. cryptopunks #9228 and
    // on-chain-all-stars #9228 both existing in these tables) get merged
    // together into one result — confirmed root cause of the 2026-07-01
    // /traitfind garbled-trait bug.
    const slug = (req.query.slug || OCAS_SLUG).toString();

    const [tokenRes, traitsRes] = await Promise.all([
      pool.query(`SELECT id, obs_rank, os_rank, os_score, rarity_score, trait_count FROM tokens WHERE id = $1 AND collection_slug = $2`, [tokenId, slug]),
      pool.query(`SELECT trait_name, trait_value, COALESCE(trait_index,0) AS trait_index FROM token_traits WHERE token_id = $1 AND collection_slug = $2 ORDER BY COALESCE(trait_index,0), trait_name`, [tokenId, slug])
    ]);

    if (!tokenRes.rows.length) return res.status(404).json({ ok: false, error: 'not found' });

    const t = tokenRes.rows[0];
    const traits = traitsFromRows(traitsRes.rows);
    const actualTraitCount = traits.__attributes?.length || parseInt(t.trait_count || 0);

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
    if (!tokenId || tokenId < 1 || tokenId > 10000) {
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
    const hours = Math.min(parseInt(req.query.hours || '48'), 168);
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
    const slug = req.query.slug ? String(req.query.slug).trim() : null;
    const isOcas = !slug || slug.toLowerCase().includes('on-chain-all-stars');

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
    const slug = req.query.slug ? String(req.query.slug).trim() : null;
    const limit = Math.min(parseInt(req.query.limit || '100'), 10000);
    // Non-OCAS collections have no rows in `tokens` (backfill only writes
    // token_traits). For listedOnly queries on non-OCAS slugs, drive off
    // listings instead so we see all listed tokens regardless.
    const isOcasSlug = !slug || slug === 'on-chain-all-stars';
    const useListingsDriven = listedOnly && slug && !isOcasSlug;

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
        query += ` JOIN listings l ON l.token_id = t.id` + (slug ? ` AND l.collection_slug = $${p++}` : ``);
        if (slug) params.push(slug);
      }
      query += ` LEFT JOIN token_traits tt ON tt.token_id = t.id` + (slug ? ` AND tt.collection_slug = $${p++}` : ``);
      if (slug) params.push(slug);

      const conditions = [ACTIVE_TOKEN_CONDITION];
      if (slug) { conditions.push(`t.collection_slug = $${p++}`); params.push(slug); }
      groups.forEach((group, i) => {
        const ors = [];
        group.forEach(m => {
          ors.push(`(LOWER(g${i}.trait_name) = LOWER($${p++}) AND LOWER(g${i}.trait_value) = LOWER($${p++}))`);
          params.push(m.trait_name, m.trait_value);
        });
        const slugCond = slug ? ` AND g${i}.collection_slug = $${p++}` : ``;
        conditions.push(`EXISTS (SELECT 1 FROM token_traits g${i} WHERE g${i}.token_id = t.id AND (${ors.join(' OR ')})${slugCond})`);
        if (slug) params.push(slug);
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
function burnEndpointError(res, route, e, fallback = {}) {
  console.error(`${route} error:`, e.message);
  if (isMissingBurnTable(e)) {
    return res.status(500).json({ ok: false, error: 'burn analytics tables are not available', ...fallback });
  }
  return res.status(500).json({ ok: false, error: e.message, ...fallback });
}

// ── GET /db/wallet/:address/summary ──────────────────────────────────────────
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
        top_tokens: owned.slice(0, 250).map(r => ({
          token_id: parseInt(r.token_id),
          os_rank: r.os_rank ? parseInt(r.os_rank) : null,
          obs_rank: r.obs_rank ? parseInt(r.obs_rank) : null,
          price_eth: r.price_eth != null ? parseFloat(r.price_eth) : null,
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
  const limit = intParam(req.query.limit, 100, 200);
  const offset = intParam(req.query.offset, 0, 10000);
  try {
    const result = await pool.query(`
      SELECT nt.contract, nt.token_id, nt.from_address, nt.to_address, nt.tx_hash, nt.log_index,
             nt.block_number, nt.block_ts, nt.event_type,
             s.price_eth AS sale_price, s.buyer, s.seller
      FROM nft_transfers nt
      LEFT JOIN sales s ON s.tx_hash = nt.tx_hash AND s.token_id = nt.token_id
      WHERE nt.contract = $1 AND nt.collection_slug = $2 AND (nt.from_address = $3 OR nt.to_address = $3)
      ORDER BY nt.block_number DESC, nt.log_index DESC
      LIMIT $4 OFFSET $5
    `, [OCAS_CONTRACT, OCAS_SLUG, address, limit, offset]);
    res.set('Cache-Control', 'public, max-age=30, s-maxage=30');
    res.json({
      ok: true,
      address,
      contract: OCAS_CONTRACT,
      synced: true,
      transfers: result.rows.map(r => ({
        contract: r.contract,
        token_id: parseInt(r.token_id),
        from_address: r.from_address,
        to_address: r.to_address,
        tx_hash: r.tx_hash,
        log_index: parseInt(r.log_index),
        block_number: parseInt(r.block_number),
        block_ts: r.block_ts,
        // event_type from nft_transfers is reliable for mint/burn/transfer
        // (confirmed populated: ~19k transfer, ~10k mint, ~360 burn on
        // staging). No 'sale' classification exists there though, so a
        // sales-table match upgrades a plain transfer to a sale with price.
        event_type: r.sale_price != null ? 'sale' : (r.event_type || 'transfer'),
        sale_price: r.sale_price != null ? parseFloat(r.sale_price) : null,
        buyer: r.buyer || null,
        seller: r.seller || null,
      })),
      count: result.rows.length,
      limit,
      offset,
    });
  } catch (e) {
    if (isMissingWalletAnalyticsTable(e)) return res.json(emptyWalletResponse(address, { transfers: [], count: 0, limit, offset }));
    console.error('/db/wallet/:address/transfers error:', e.message);
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
  if (!tokenId || tokenId < 1 || tokenId > 10000) return res.status(400).json({ ok: false, error: 'invalid token id' });
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
      SELECT be.tx_hash, be.log_index, be.block_number, be.burner_wallet,
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

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({ ok: true, burns: result.rows.map(burnEventJson), count: result.rows.length });
  } catch (e) {
    burnEndpointError(res, '/db/burn-latest', e, { burns: [], count: 0 });
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

// GET /db/burn-best
app.get('/db/burn-best', auth, async (req, res) => {
  try {
    const biggest = await pool.query(`
      SELECT be.tx_hash, be.log_index, be.block_number, be.burner_wallet,
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

    let rarestBurnedInputs = [];
    let bestCreatedTokens = [];
    try {
      const rarest = await pool.query(`
        SELECT be.tx_hash, be.block_number, be.burner_wallet, be.burned_at,
               bei.burned_token_id,
               t.os_rank, t.obs_rank,
               COALESCE(t.os_rank, t.obs_rank) AS rank
        FROM burn_event_inputs bei
        JOIN burn_events be ON be.id = bei.burn_event_id
        LEFT JOIN tokens t ON t.id = bei.burned_token_id
        WHERE bei.burned_token_id != be.survivor_token_id
        ORDER BY COALESCE(t.os_rank, t.obs_rank, 999999) ASC, be.burned_at DESC NULLS LAST
        LIMIT 25
      `);
      rarestBurnedInputs = rarest.rows.map(r => ({
        tx_hash: r.tx_hash || null,
        block_number: burnNum(r.block_number),
        wallet: r.burner_wallet || null,
        burn_ts: r.burned_at || null,
        token_id: burnNum(r.burned_token_id),
        os_rank: burnNum(r.os_rank),
        obs_rank: burnNum(r.obs_rank),
        rank: burnNum(r.rank),
      }));

      const created = await pool.query(`
        SELECT be.tx_hash, be.block_number, be.burner_wallet, be.burned_at,
               be.survivor_token_id,
               t.os_rank, t.obs_rank,
               COALESCE(t.os_rank, t.obs_rank) AS rank
        FROM burn_events be
        LEFT JOIN tokens t ON t.id = be.survivor_token_id
        ORDER BY COALESCE(t.os_rank, t.obs_rank, 999999) ASC, be.burned_at DESC NULLS LAST
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
      }));
    } catch (rankError) {
      if (!isMissingBurnRankData(rankError)) throw rankError;
      console.warn('/db/burn-best rank data unavailable:', rankError.message);
    }

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      ok: true,
      biggest_burns: biggest.rows.map(burnEventJson),
      rarest_burned_inputs: rarestBurnedInputs,
      best_created_tokens: bestCreatedTokens,
    });
  } catch (e) {
    burnEndpointError(res, '/db/burn-best', e, {
      biggest_burns: [],
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
app.post('/tv/claim-code', auth, async (req, res) => {
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
app.get('/tv/link-status-by-wallet', auth, async (req, res) => {
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


// ── GET /db/traits-fast ───────────────────────────────────────────────────────
// Serves traits_fast.json structure computed live from DB, excluding burned tokens.
// Cached in memory for 5 minutes.
// Returns: { ok, rank: [[id, score], ...], domain: {trait: [values]},
//            buckets: {count: [ids]}, freq: {trait: {value: count}}, survivorCount }
let _traitsFastCache = null;
let _traitsFastCacheTs = 0;
const TRAITS_FAST_TTL = 5 * 60 * 1000;

app.get('/db/traits-fast', auth, async (req, res) => {
  try {
    const now = Date.now();
    if (_traitsFastCache && (now - _traitsFastCacheTs) < TRAITS_FAST_TTL) {
      return res.json(_traitsFastCache);
    }

    const BURNED_EXCL = `NOT EXISTS (
      SELECT 1 FROM burn_event_inputs bei
      JOIN burn_events be ON be.id = bei.burn_event_id
      WHERE bei.burned_token_id = t.id
      AND bei.burned_token_id != be.survivor_token_id
    )`;

    const BURNED_EXCL_TT = `NOT EXISTS (
      SELECT 1 FROM burn_event_inputs bei
      JOIN burn_events be ON be.id = bei.burn_event_id
      WHERE bei.burned_token_id = tt.token_id
      AND bei.burned_token_id != be.survivor_token_id
    )`;

    // 1. Surviving tokens sorted by obs_rank ASC (pre-computed rank in DB)
    // Falls back to id order if obs_rank not available
    // NOTE: hardcoded to OCAS_SLUG for now — TraitView itself isn't
    // multi-collection aware yet (no slug param sent), so without this
    // filter, other configured collections' tokens/traits merge in here
    // too (confirmed: Fluxeto traits appearing in TraitView's OCAS filter
    // panel, same root cause as the /traitfind cross-collection bug fixed
    // 2026-07-01 — the JOIN below also previously matched on token_id
    // alone with no collection_slug check on either side).
    const [rankRes, traitRes] = await Promise.all([
      pool.query(`
        SELECT t.id, t.obs_rank, t.trait_count
        FROM tokens t
        WHERE t.collection_slug = $1 AND ${BURNED_EXCL}
        ORDER BY t.obs_rank ASC NULLS LAST, t.id ASC
      `, [OCAS_SLUG]),
      // 2. Trait frequencies for surviving tokens
      pool.query(`
        SELECT tt.trait_name, tt.trait_value, COUNT(*)::int AS freq
        FROM token_traits tt
        JOIN tokens t ON t.id = tt.token_id AND t.collection_slug = tt.collection_slug
        WHERE tt.collection_slug = $1 AND ${BURNED_EXCL_TT}
        GROUP BY tt.trait_name, tt.trait_value
        ORDER BY tt.trait_name, tt.trait_value
      `, [OCAS_SLUG])
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

    _traitsFastCache = { ok: true, rank, domain, freq, buckets, survivorCount: rankRes.rows.length };
    _traitsFastCacheTs = now;
    res.json(_traitsFastCache);
  } catch (e) {
    console.error('[/db/traits-fast]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── GET /db/all-traits ────────────────────────────────────────────────────────
// Returns all surviving tokens' traits in chunk-compatible format.
// Used by TraitView to replace static chunk files with live DB data.
// Server-side cache: 5 minutes. One DB query per 5 min regardless of visitors.
// Returns: { ok, tokens: { "1": { traits: {...} }, ... }, survivorCount }
let _allTraitsCache = null;
let _allTraitsCacheTs = 0;
const ALL_TRAITS_TTL = 5 * 60 * 1000;

app.get('/db/all-traits', auth, async (req, res) => {
  try {
    const now = Date.now();
    if (_allTraitsCache && (now - _allTraitsCacheTs) < ALL_TRAITS_TTL) {
      return res.json(_allTraitsCache);
    }

    // Get all surviving token IDs
    // NOTE: hardcoded to OCAS_SLUG for now — same reasoning as /db/traits-fast above.
    const survivorsRes = await pool.query(`
      SELECT t.id, t.image_url
      FROM tokens t
      WHERE t.collection_slug = $1 AND NOT EXISTS (
        SELECT 1 FROM burn_event_inputs bei
        JOIN burn_events be ON be.id = bei.burn_event_id
        WHERE bei.burned_token_id = t.id
        AND bei.burned_token_id != be.survivor_token_id
      )
      ORDER BY t.id
    `, [OCAS_SLUG]);

    const survivorIds = new Set(survivorsRes.rows.map(r => parseInt(r.id)));
    const imageUrlById = new Map(survivorsRes.rows.map(r => [parseInt(r.id), r.image_url || null]));

    // Get all traits for surviving tokens in one query
    const traitsRes = await pool.query(`
      SELECT tt.token_id, tt.trait_name, tt.trait_value
      FROM token_traits tt
      WHERE tt.collection_slug = $2 AND tt.token_id = ANY($1::int[])
      ORDER BY tt.token_id, COALESCE(tt.trait_index, 0), tt.trait_name
    `, [[...survivorIds], OCAS_SLUG]);

    // Build tokens object: { "1": { traits: { "Type": "Human 6", ... }, image: "..." }, ... }
    const tokens = {};

    // Initialize all survivors with empty traits + whatever image_url is on file
    // (only populated for tokens that have gone through a burn finalization
    // since the 2026-07-02 fix — most tokens will have image:null here, which
    // is fine, TraitView already falls back to its own static image source)
    for (const id of survivorIds) {
      tokens[String(id)] = { traits: {}, image: imageUrlById.get(id) || null };
    }

    // Populate traits
    for (const { token_id, trait_name, trait_value } of traitsRes.rows) {
      const key = String(token_id);
      if (tokens[key]) {
        tokens[key].traits[trait_name] = trait_value;
      }
    }

    _allTraitsCache = { ok: true, tokens, survivorCount: survivorIds.size };
    _allTraitsCacheTs = now;

    res.json(_allTraitsCache);
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

app.get('/render/svg-token', auth, async (req, res) => {
  try {
    const svgSource = req.query.svgUrl || req.query.svgData;
    if (!svgSource) return res.status(400).json({ ok: false, error: 'missing svgUrl or svgData' });

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

    const SIZE = 500;
    let bgBuf;
    try {
      bgBuf = await sharp(Buffer.from(svgText))
        .resize(SIZE, SIZE, { kernel: 'nearest', fit: 'fill' })
        .png()
        .toBuffer();
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'SVG render failed: ' + e.message });
    }

    // Extract embedded character PNG and composite, same as original extractPngFromSvg
    const pngMatch = svgText.match(/src=["']data:image\/png;base64,([A-Za-z0-9+/=\s]+)["']/);
    let finalBuf = bgBuf;
    if (pngMatch) {
      try {
        const rawPng = Buffer.from(pngMatch[1].replace(/\s/g, ''), 'base64');
        const charBuf = await sharp(rawPng).resize(SIZE, SIZE, { kernel: 'nearest' }).png().toBuffer();
        finalBuf = await sharp(bgBuf).composite([{ input: charBuf, blend: 'over' }]).png().toBuffer();
      } catch (e) {
        console.warn('[/render/svg-token] char composite failed, using full SVG render:', e.message);
      }
    }

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600'); // browser/CDN cache 1hr
    res.send(finalBuf);
  } catch (e) {
    console.error('[/render/svg-token]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`TraitView API running on port ${PORT}`);
  console.log(`Auth: ${API_SECRET ? 'enabled' : (REQUIRE_API_AUTH ? 'REQUIRED BUT MISSING' : 'DISABLED (dev only; set API_SECRET to enable)')}`);
});
