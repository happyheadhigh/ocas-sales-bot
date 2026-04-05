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
function auth(req, res, next) {
  if (!API_SECRET) return next(); // no secret set = open (dev only)
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
      pool.query(`SELECT id, obs_rank, rarity_score, trait_count FROM tokens WHERE id = $1`, [tokenId]),
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

// ── POST /db/listings/sync ───────────────────────────────────────────────────
// Sync current listings from OpenSea into DB.
// Called periodically (or manually). Requires API_SECRET.
app.get('/db/listings/sync', auth, async (req, res) => {
  res.json({ ok: true, message: 'Sync endpoint ready — wire up OpenSea fetch here' });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TraitView API running on port ${PORT}`);
  console.log(`Auth: ${API_SECRET ? 'enabled' : 'DISABLED (set API_SECRET to enable)'}`);
});
