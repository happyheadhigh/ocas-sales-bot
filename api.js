/**
 * TraitView API Server
 * Runs on Railway alongside the Discord bot.
 * Connects to Railway Postgres and serves HTTP endpoints
 * that the Cloudflare Worker calls.
 * 
 * Deploy: add this file to your Railway bot project.
 * Set environment variables: DATABASE_URL, API_SECRET
 */

const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const OCAS_CONTRACT = normalizeEthAddress(process.env.OCAS_CONTRACT || DEFAULT_OCAS_CONTRACT);

function normalizeEthAddress(addr) {
  const s = String(addr || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : '';
}

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

// ── CORS — allow Cloudflare Worker and traitview.com ─────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

    const conditions = [];
    if (rankMin !== null) { conditions.push(`t.obs_rank >= $${p++}`); params.push(rankMin); }
    if (rankMax !== null) { conditions.push(`t.obs_rank <= $${p++}`); params.push(rankMax); }
    if (traitCountFilter !== null) { conditions.push(`t.trait_count = $${p++}`); params.push(traitCountFilter); }
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;

    query += ` ORDER BY t.obs_rank LIMIT $${p++}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.json({
      ok: true,
      tokens: result.rows.map(r => ({ id: parseInt(r.id), obs_rank: parseInt(r.obs_rank) })),
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

    const [tokenRes, traitsRes] = await Promise.all([
      pool.query(`SELECT id, obs_rank, os_rank, os_score, rarity_score, trait_count FROM tokens WHERE id = $1`, [tokenId]),
      pool.query(`SELECT trait_name, trait_value FROM token_traits WHERE token_id = $1 ORDER BY trait_name`, [tokenId])
    ]);

    if (!tokenRes.rows.length) return res.status(404).json({ ok: false, error: 'not found' });

    const t = tokenRes.rows[0];
    const traits = {};
    traitsRes.rows.forEach(r => { traits[r.trait_name] = r.trait_value; });

    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.json({
      ok: true,
      token: {
        id: parseInt(t.id),
        obs_rank: parseInt(t.obs_rank),
        os_rank:  t.os_rank  ? parseInt(t.os_rank)    : null,
        os_score: t.os_score ? parseFloat(t.os_score) : null,
        rarity_score: parseFloat(t.rarity_score),
        trait_count: parseInt(t.trait_count),
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
      ORDER BY l.price_eth ASC
      LIMIT 1
    `, [trait_name, trait_value]);

    res.set('Cache-Control', 'public, max-age=120, s-maxage=120');
    res.json({
      ok: true,
      floor: result.rows.length ? {
        token_id: parseInt(result.rows[0].id),
        obs_rank: parseInt(result.rows[0].obs_rank),
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

// ── GET /db/listings/sync — manually trigger a sync ──────────────────────────
app.get('/db/listings/sync', auth, async (req, res) => {
  try {
    const { syncListings } = require('./sync-listings');
    res.json({ ok: true, message: 'Sync triggered — running in background' });
    syncListings();
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /db/listings — all current listings from DB ───────────────────────────
app.get('/db/listings', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT token_id, price_eth, url FROM listings ORDER BY price_eth ASC`
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
        obs_rank: parseInt(r.obs_rank)
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
// Returns: { ok, traits: [{trait_name, trait_value, token_count}] }
app.get('/db/trait-index', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT trait_name, trait_value, COUNT(*)::int AS token_count
      FROM token_traits
      WHERE trait_name IS NOT NULL
        AND trait_value IS NOT NULL
        AND TRIM(trait_value) <> ''
      GROUP BY trait_name, trait_value
      ORDER BY LENGTH(trait_value) DESC, trait_value ASC
    `);

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
    const limit = Math.min(parseInt(req.query.limit || '100'), 10000);

    if (!matches.length && !traitCount && rankMin === null && rankMax === null) {
      return res.status(400).json({ ok: false, error: 'provide matches, trait_count, or rank filter' });
    }

    let query = `SELECT t.id, t.obs_rank, t.os_rank, t.os_score, t.rarity_score, t.trait_count`;
    if (listedOnly) query += `, l.price_eth, l.url`;
    query += ` FROM tokens t`;

    const params = [];
    let p = 1;
    if (listedOnly) query += ` JOIN listings l ON l.token_id = t.id`;

    const conditions = [];
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

    query += listedOnly ? ` ORDER BY l.price_eth ASC, t.obs_rank ASC` : ` ORDER BY t.obs_rank ASC`;
    query += ` LIMIT $${p++}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
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

    const conditions = [];
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
              COALESCE(
                json_object_agg(tt.trait_name, tt.trait_value) FILTER (WHERE tt.trait_name IS NOT NULL),
                '{}'::json
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
              COALESCE(
                json_object_agg(tt.trait_name, tt.trait_value) FILTER (WHERE tt.trait_name IS NOT NULL),
                '{}'::json
              ) AS traits
       FROM tokens t
       JOIN listings l ON l.token_id = t.id
       LEFT JOIN token_traits tt ON tt.token_id = t.id
       WHERE ${rankCol} >= $1 AND ${rankCol} <= $2
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
        obs_rank:    parseInt(r.obs_rank),
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

    const current = await pool.query(`
      SELECT w.token_id, t.os_rank, t.obs_rank, l.price_eth
      FROM wallet_token_intervals w
      LEFT JOIN tokens t ON t.id = w.token_id
      LEFT JOIN listings l ON l.token_id = w.token_id
      WHERE w.wallet_address = $1 AND w.disposed_at IS NULL
      ORDER BY COALESCE(t.os_rank, t.obs_rank, 999999) ASC
      LIMIT 10000
    `, [address]);

    const owned = current.rows;
    const ranks = owned.map(r => parseInt(r.os_rank || r.obs_rank)).filter(Number.isFinite);
    const listed = owned.filter(r => r.price_eth != null);
    const floor = await pool.query('SELECT MIN(price_eth) AS floor_eth FROM listings');
    const floorEth = floor.rows[0]?.floor_eth ? parseFloat(floor.rows[0].floor_eth) : null;
    const estimated = floorEth == null ? null : owned.length * floorEth;

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
        top_tokens: owned.slice(0, 12).map(r => ({
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
      SELECT contract, token_id, from_address, to_address, tx_hash, log_index, block_number, block_ts, event_type
      FROM nft_transfers
      WHERE contract = $1 AND (from_address = $2 OR to_address = $2)
      ORDER BY block_number DESC, log_index DESC
      LIMIT $3 OFFSET $4
    `, [OCAS_CONTRACT, address, limit, offset]);
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
        event_type: r.event_type,
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
      JOIN token_traits tt ON tt.token_id = w.token_id
      LEFT JOIN tokens t ON t.id = w.token_id
      WHERE w.wallet_address = $1 AND w.disposed_at IS NULL
      GROUP BY tt.trait_name, tt.trait_value
      ORDER BY count DESC, tt.trait_name ASC, tt.trait_value ASC
      LIMIT $2
    `, [address, limit]);
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

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TraitView API running on port ${PORT}`);
  console.log(`Auth: ${API_SECRET ? 'enabled' : (REQUIRE_API_AUTH ? 'REQUIRED BUT MISSING' : 'DISABLED (dev only; set API_SECRET to enable)')}`);
});
