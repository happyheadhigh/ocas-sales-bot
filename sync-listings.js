/**
 * TraitView Listings Sync
 * 
 * Fetches current OpenSea listings/sales for every collection currently
 * configured across all guilds (plus OCAS, always, as the bot's primary
 * collection) and upserts into Postgres, scoped by collection_slug.
 * 
 * Runs as a cron job on Railway alongside the bot.
 * Listings: every 1 minute, per collection (sequentially, with a short
 * delay between collections to stay easy on OpenSea's rate limits).
 * Sales: every 15 minutes, per collection.
 *
 * Collections to sync are discovered by scanning every guild's stored
 * config (server_configs table) for collectionSlug/contract (primary) and
 * collections[] (extras), de-duplicated by slug. This is a standalone
 * process separate from the bot itself, so it queries server_configs
 * directly rather than depending on the bot's in-memory config state.
 *
 * Can also be triggered manually via the API: GET /db/listings/sync?key=SECRET
 */

const { Pool } = require('pg');

const OPENSEA_API_KEY = process.env.OPENSEA_KEY || process.env.OPENSEA_API_KEY;
const DATABASE_URL    = process.env.DATABASE_URL;

// Guard: don't crash the container if env vars missing
void (function() {
const OCAS_SLUG        = 'on-chain-all-stars';
const OCAS_CONTRACT    = '0x078be86f3104a32313a47815792230a3808642cc';
const SYNC_INTERVAL    = 60 * 1000; // 1 minute
const COLLECTION_DELAY = 1500;      // ms between collections within one sync pass, easy on OpenSea rate limits

if (!DATABASE_URL) {
  console.error('[sync] Missing DATABASE_URL — listings sync disabled');
  module.exports = { syncListings: () => Promise.resolve(), syncSales: () => Promise.resolve(), syncAllListings: () => Promise.resolve(), syncAllSales: () => Promise.resolve(), discoverCollections: () => Promise.resolve([]) };
  return;
}
if (!OPENSEA_API_KEY) {
  console.error('[sync] Missing OPENSEA_API_KEY — listings sync disabled');
  module.exports = { syncListings: () => Promise.resolve(), syncSales: () => Promise.resolve(), syncAllListings: () => Promise.resolve(), syncAllSales: () => Promise.resolve(), discoverCollections: () => Promise.resolve([]) };
  return;
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 3,
});

// ── Discover every collection currently configured across all guilds ────────
// Always includes OCAS, since it's the bot's primary collection and isn't
// necessarily present in any guild's "extras" list. De-duplicated by slug
// (case-insensitive) — first contract address seen for a slug wins.
async function discoverCollections() {
  const map = new Map();
  map.set(OCAS_SLUG, { slug: OCAS_SLUG, contract: OCAS_CONTRACT });

  try {
    const result = await pool.query('SELECT guild_id, config FROM server_configs');
    for (const row of result.rows) {
      let cfg;
      try { cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config; }
      catch { continue; }
      if (!cfg) continue;

      if (cfg.collectionSlug && cfg.contract) {
        const slug = String(cfg.collectionSlug).toLowerCase();
        if (!map.has(slug)) map.set(slug, { slug, contract: cfg.contract });
      }
      for (const extra of (cfg.collections || [])) {
        if (!extra?.slug || !extra?.contract) continue;
        const slug = String(extra.slug).toLowerCase();
        if (!map.has(slug)) map.set(slug, { slug, contract: extra.contract });
      }
    }
  } catch (e) {
    console.error('[sync] discoverCollections query failed, falling back to OCAS only:', e.message);
  }

  return Array.from(map.values());
}

// ── Ensure floor_history table exists ─────────────────────────────────────────
async function ensureFloorHistoryTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS floor_history (
        id          SERIAL PRIMARY KEY,
        floor_eth   NUMERIC(18,8) NOT NULL,
        token_id    INTEGER,
        collection_slug TEXT,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // CREATE TABLE IF NOT EXISTS above silently does nothing for
    // collection_slug on a table that already existed without it — explicit
    // ALTER needed, same pattern/lesson as lib/db.js's listings/sales fix.
    await pool.query(`ALTER TABLE floor_history ADD COLUMN IF NOT EXISTS collection_slug TEXT`);
    await pool.query(`UPDATE floor_history SET collection_slug = 'on-chain-all-stars' WHERE collection_slug IS NULL`).catch(()=>{});
    await pool.query(`
      CREATE INDEX IF NOT EXISTS floor_history_recorded_at_idx ON floor_history(recorded_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS floor_history_collection_slug_idx ON floor_history(collection_slug)
    `);
  } catch(e) { console.error('[sync] ensureFloorHistoryTable error:', e.message); }
}
ensureFloorHistoryTable();

async function syncListings(collection) {
  const { slug, contract } = collection;
  const startTime = Date.now();
  console.log(`[sync] Starting listings sync for ${slug} at ${new Date().toISOString()}`);

  try {
    // Fetch all current listings from OpenSea
    const listingsMap = {}; // token_id -> {price_eth, url}
    let next = null;
    let pages = 0;

    do {
      const qs = new URLSearchParams({ chain: 'ethereum', limit: '100' });
      if (next) qs.set('next', next);

      const resp = await fetch(
        `https://api.opensea.io/api/v2/listings/collection/${slug}/all?${qs}`,
        { headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' } }
      );

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.warn(`[sync] [${slug}] OpenSea HTTP ${resp.status} on page ${pages}: ${errText.slice(0, 200)}`);
        break;
      }

      const body = await resp.json();
      if (pages === 0) {
        console.log(`[sync] [${slug}] First page: ${body.listings?.length ?? 0} listings, keys: ${Object.keys(body).join(', ')}`);
        if (body.listings?.length > 0) {
          const sample = body.listings[0];
          console.log(`[sync] [${slug}] Sample listing keys: ${Object.keys(sample).join(', ')}`);
        }
      }

      // Extract token ID using same robust logic as the Cloudflare Worker
      function getTokenId(listing) {
        const cands = [
          listing?.criteria?.nft?.identifier,
          listing?.nft?.identifier,
          listing?.asset?.token_id,
          listing?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria,
          listing?.protocol_data?.parameters?.consideration?.[0]?.identifierOrCriteria,
        ];
        for (let c of cands) {
          if (!c) continue;
          c = String(c);
          const parts = c.includes('/') ? c.split('/') : c.split(':');
          const last = parts[parts.length - 1];
          if (last && /^\d+$/.test(last)) return parseInt(last, 10);
        }
        return null;
      }

      function getPriceEth(listing) {
        const wei = listing?.price?.current?.value || listing?.price?.value || null;
        const dec = listing?.price?.current?.decimal ?? listing?.price?.decimal
          ?? (wei ? Number(wei) / 1e18 : null);
        return dec != null ? parseFloat(dec) : null;
      }

      // Generous, collection-agnostic sanity bound against malformed parses —
      // not a real business rule about collection size (the old 10000 cap
      // was OCAS/CryptoPunks-coincidental, not meaningful for collections of
      // other sizes).
      const MAX_PLAUSIBLE_TOKEN_ID = 10_000_000;

      for (const listing of (body.listings || [])) {
        const id = getTokenId(listing);
        const priceEth = getPriceEth(listing);

        if (!id || isNaN(id) || id < 0 || id > MAX_PLAUSIBLE_TOKEN_ID) continue;
        if (priceEth == null || isNaN(priceEth) || priceEth <= 0) continue;

        const url = `https://opensea.io/assets/ethereum/${contract}/${id}`;
        if (!listingsMap[id] || priceEth < listingsMap[id].price_eth) {
          listingsMap[id] = { price_eth: priceEth, url };
        }
      }

      next = body.next || null;
      pages++;

      if (pages >= 25) break; // safety cap (25 × 100 = 2500 listings max)
      if (next) await new Promise(r => setTimeout(r, 80)); // rate limit

    } while (next);

    const entries = Object.entries(listingsMap);
    console.log(`[sync] [${slug}] Fetched ${entries.length} listings across ${pages} pages`);

    if (entries.length === 0) {
      console.warn(`[sync] [${slug}] No listings returned — skipping DB write`);
      return;
    }

    // Upsert into Postgres in batches of 100
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Clear stale listings for THIS collection only — never wipe other
      // collections' rows. This was the critical bug: the old version had
      // no WHERE clause here at all, wiping every collection's listings on
      // every sync cycle regardless of which collection it was syncing.
      await client.query('DELETE FROM listings WHERE collection_slug = $1', [slug]);

      // Insert fresh listings, scoped by collection_slug
      for (let i = 0; i < entries.length; i += 100) {
        const batch = entries.slice(i, i + 100);
        const vals  = batch.map((_, j) => `($${j*4+1}, $${j*4+2}, $${j*4+3}, $${j*4+4}, NOW())`).join(', ');
        const params = batch.flatMap(([id, d]) => [parseInt(id), d.price_eth, d.url, slug]);

        await client.query(`
          INSERT INTO listings (token_id, price_eth, url, collection_slug, updated_at)
          VALUES ${vals}
          ON CONFLICT (token_id, collection_slug) DO UPDATE
            SET price_eth = EXCLUDED.price_eth,
                url       = EXCLUDED.url,
                updated_at = NOW()
        `, params);
      }

      await client.query('COMMIT');
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[sync] [${slug}] ✓ Upserted ${entries.length} listings in ${elapsed}s`);

      // ── Write floor_history entry if floor has changed ─────────────────────
      // Only writes when MIN(price_eth) changes vs last recorded value.
      // This gives us a true floor timeline for 24h change calculations.
      // Scoped to this collection — floor_history is OCAS-only in practice
      // today (nothing reads non-OCAS floor history yet), but scoping the
      // write now avoids a different collection's listing accidentally
      // appearing as "the floor" in a query that assumes OCAS.
      try {
        const floorResult = await pool.query(
          `SELECT price_eth AS floor_eth, token_id
           FROM listings
           WHERE collection_slug = $1
           ORDER BY price_eth ASC
           LIMIT 1`,
          [slug]
        );
        if (floorResult.rows.length && floorResult.rows[0].floor_eth) {
          const newFloor = parseFloat(floorResult.rows[0].floor_eth);
          const tokenId  = floorResult.rows[0].token_id;
          // Check last recorded floor for this collection
          const lastRow = await pool.query(
            `SELECT floor_eth FROM floor_history WHERE collection_slug = $1 ORDER BY recorded_at DESC LIMIT 1`,
            [slug]
          );
          const lastFloor = lastRow.rows.length ? parseFloat(lastRow.rows[0].floor_eth) : null;
          // Write if floor changed by more than 0.00001 ETH (float tolerance)
          if (lastFloor === null || Math.abs(newFloor - lastFloor) > 0.00001) {
            await pool.query(
              `INSERT INTO floor_history (floor_eth, token_id, collection_slug, recorded_at) VALUES ($1, $2, $3, NOW())`,
              [newFloor, tokenId, slug]
            );
            console.log(`[sync] [${slug}] Floor history: ${lastFloor ?? 'none'} → ${newFloor} ETH (token #${tokenId})`);
          }
        }
      } catch(e) { console.error(`[sync] [${slug}] floor_history write error:`, e.message); }

    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

  } catch (e) {
    console.error(`[sync] [${slug}] Listings sync failed:`, e.message);
  }
}

async function syncAllListings() {
  const collections = await discoverCollections();
  console.log(`[sync] Syncing listings for ${collections.length} collection(s): ${collections.map(c => c.slug).join(', ')}`);
  for (const collection of collections) {
    await syncListings(collection);
    if (collections.length > 1) await new Promise(r => setTimeout(r, COLLECTION_DELAY));
  }
}

// Run immediately on startup, then every 3 minutes
syncAllListings();
setInterval(syncAllListings, SYNC_INTERVAL);

console.log(`[sync] Listings sync running — interval: ${SYNC_INTERVAL/1000}s`);

// ── Sync recent sales from OpenSea into DB ───────────────────────────────────
async function syncSales(collection) {
  const { slug } = collection;
  console.log(`[sync-sales] Starting sales sync for ${slug} at ${new Date().toISOString()}`);
  try {
    let allSales = [];
    let cursor = null;
    let pages = 0;

    // Generous, collection-agnostic sanity bounds against malformed parses —
    // not real business rules about collection size/price (the old bounds,
    // 10000 token id / 1000 ETH, were OCAS-scaled coincidences).
    const MAX_PLAUSIBLE_TOKEN_ID = 10_000_000;
    const MAX_PLAUSIBLE_PRICE_ETH = 100_000;

    do {
      const qs = new URLSearchParams({ event_type: 'sale', limit: '100' });
      if (cursor) qs.set('next', cursor);

      const resp = await fetch(
        `https://api.opensea.io/api/v2/events/collection/${slug}?${qs}`,
        { headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' } }
      );

      if (!resp.ok) {
        console.warn(`[sync-sales] [${slug}] OpenSea HTTP ${resp.status} on page ${pages}`);
        break;
      }

      const body = await resp.json();
      const events = body.asset_events || [];

      for (const ev of events) {
        const rawId = ev?.nft?.identifier || ev?.asset?.token_id;
        if (!rawId) continue;
        const token_id = parseInt(rawId, 10);
        if (isNaN(token_id) || token_id < 0 || token_id > MAX_PLAUSIBLE_TOKEN_ID) continue;

        const priceWei = ev?.payment?.quantity || ev?.total_price;
        if (!priceWei) continue;
        const price_eth = parseFloat(priceWei) / 1e18;
        if (isNaN(price_eth) || price_eth <= 0 || price_eth > MAX_PLAUSIBLE_PRICE_ETH) continue;

        const currency = ev?.payment?.symbol || 'ETH';
        const buyer  = ev?.buyer  || ev?.winner_account?.address || null;
        const seller = ev?.seller || ev?.from_account?.address   || null;
        const sale_ts = ev?.closing_date
          ? new Date(ev.closing_date * 1000).toISOString()
          : ev?.event_timestamp || new Date().toISOString();
        const tx_hash = ev?.transaction || null;

        allSales.push({ token_id, price_eth, currency, buyer, seller, sale_ts, tx_hash });
      }

      cursor = body.next || null;
      pages++;
      if (pages >= 10) break; // last 1000 sales
      if (cursor) await new Promise(r => setTimeout(r, 80));
    } while (cursor);

    if (allSales.length === 0) {
      console.log(`[sync-sales] [${slug}] No sales to sync`);
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < allSales.length; i += 100) {
        const batch = allSales.slice(i, i + 100);
        const vals = batch.map((_, j) =>
          `($${j*8+1},$${j*8+2},$${j*8+3},$${j*8+4},$${j*8+5},$${j*8+6},$${j*8+7},$${j*8+8})`
        ).join(', ');
        const params = batch.flatMap(s => [
          s.token_id, s.price_eth, s.currency, s.buyer, s.seller, s.sale_ts, s.tx_hash, slug
        ]);
        await client.query(`
          INSERT INTO sales (token_id, price_eth, currency, buyer, seller, sale_ts, tx_hash, collection_slug)
          VALUES ${vals}
          ON CONFLICT (token_id, sale_ts, collection_slug) DO NOTHING
        `, params);
      }
      await client.query('COMMIT');
      console.log(`[sync-sales] [${slug}] ✓ Upserted ${allSales.length} sales`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`[sync-sales] [${slug}] DB write failed:`, e.message);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(`[sync-sales] [${slug}] Failed:`, e.message);
  }
}

async function syncAllSales() {
  const collections = await discoverCollections();
  console.log(`[sync-sales] Syncing sales for ${collections.length} collection(s): ${collections.map(c => c.slug).join(', ')}`);
  for (const collection of collections) {
    await syncSales(collection);
    if (collections.length > 1) await new Promise(r => setTimeout(r, COLLECTION_DELAY));
  }
}

// Run sales sync on startup then every 15 minutes
syncAllSales();
setInterval(syncAllSales, 15 * 60 * 1000);

// ── One-time full sales history seed for a newly onboarded collection ───────
// Distinct from syncSales above: that one is deliberately capped at ~1000
// recent events for the ongoing rolling sync (every 15 min), which is the
// right bound for "stay current" but wrong for "give a brand-new collection
// its actual trading history" — a collection could easily have many
// thousands of historical sales going back to mint. This walks the full
// event history with a much higher safety cap (50,000 sales) rather than no
// cap at all, so a pathological collection can't run forever unnoticed —
// hitting the cap logs clearly rather than failing silently.
async function seedFullSalesHistory(collection) {
  const { slug } = collection;
  console.log(`[seed] Starting FULL sales history pull for ${slug} at ${new Date().toISOString()}`);

  const MAX_PLAUSIBLE_TOKEN_ID = 10_000_000;
  const MAX_PLAUSIBLE_PRICE_ETH = 100_000;
  const MAX_PAGES = 2000; // 2000 * 100 = 200,000 sales safety cap — raised from 50,000, which would have quietly truncated a ~44k-token collection trading at anywhere near OnChainHoodies' ~1.2 sales/token ratio

  let cursor = null;
  let pages = 0;
  let totalWritten = 0;

  try {
    do {
      const qs = new URLSearchParams({ event_type: 'sale', limit: '100' });
      if (cursor) qs.set('next', cursor);

      const resp = await fetch(
        `https://api.opensea.io/api/v2/events/collection/${slug}?${qs}`,
        { headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' } }
      );

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`OpenSea HTTP ${resp.status} on page ${pages}: ${errText.slice(0, 200)}`);
      }

      const body = await resp.json();
      const events = body.asset_events || [];
      const pageSales = [];

      for (const ev of events) {
        const rawId = ev?.nft?.identifier || ev?.asset?.token_id;
        if (!rawId) continue;
        const token_id = parseInt(rawId, 10);
        if (isNaN(token_id) || token_id < 0 || token_id > MAX_PLAUSIBLE_TOKEN_ID) continue;

        const priceWei = ev?.payment?.quantity || ev?.total_price;
        if (!priceWei) continue;
        const price_eth = parseFloat(priceWei) / 1e18;
        if (isNaN(price_eth) || price_eth <= 0 || price_eth > MAX_PLAUSIBLE_PRICE_ETH) continue;

        const currency = ev?.payment?.symbol || 'ETH';
        const buyer  = ev?.buyer  || ev?.winner_account?.address || null;
        const seller = ev?.seller || ev?.from_account?.address   || null;
        const sale_ts = ev?.closing_date
          ? new Date(ev.closing_date * 1000).toISOString()
          : ev?.event_timestamp || new Date().toISOString();
        const tx_hash = ev?.transaction || null;

        pageSales.push({ token_id, price_eth, currency, buyer, seller, sale_ts, tx_hash });
      }

      if (pageSales.length) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (let i = 0; i < pageSales.length; i += 100) {
            const batch = pageSales.slice(i, i + 100);
            const vals = batch.map((_, j) =>
              `($${j*8+1},$${j*8+2},$${j*8+3},$${j*8+4},$${j*8+5},$${j*8+6},$${j*8+7},$${j*8+8})`
            ).join(', ');
            const params = batch.flatMap(s => [
              s.token_id, s.price_eth, s.currency, s.buyer, s.seller, s.sale_ts, s.tx_hash, slug
            ]);
            await client.query(`
              INSERT INTO sales (token_id, price_eth, currency, buyer, seller, sale_ts, tx_hash, collection_slug)
              VALUES ${vals}
              ON CONFLICT (token_id, sale_ts, collection_slug) DO NOTHING
            `, params);
          }
          await client.query('COMMIT');
          totalWritten += pageSales.length;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      }

      cursor = body.next || null;
      pages++;
      if (pages % 20 === 0) console.log(`[seed] [${slug}] ...${pages} pages, ${totalWritten} sales written so far`);
      if (pages >= MAX_PAGES) {
        console.warn(`[seed] [${slug}] Hit the ${MAX_PAGES}-page safety cap (${MAX_PAGES * 100} events) — history pull stopped early, not necessarily complete`);
        break;
      }
      if (cursor) await new Promise(r => setTimeout(r, 80));
    } while (cursor);

    console.log(`[seed] [${slug}] ✓ Full sales history pull complete: ${totalWritten} sales across ${pages} pages`);
    return { ok: true, salesWritten: totalWritten, pages };
  } catch (e) {
    console.error(`[seed] [${slug}] Sales history pull failed after ${pages} pages, ${totalWritten} sales written:`, e.message);
    throw e;
  }
}

// Orchestrates the full one-time onboarding seed for a newly added
// collection: full sales history (above) + current listings snapshot
// (syncListings, unchanged — its existing cap is already right for "current
// active listings"), with the collections registry status updated
// throughout so the frontend/onboarding trigger can poll progress.
async function seedMarketHistory(collection) {
  const { slug } = collection;
  try {
    await pool.query(
      `UPDATE collections SET status = 'backfilling_market', updated_at = NOW() WHERE slug = $1`,
      [slug]
    );

    await seedFullSalesHistory(collection);
    await syncListings(collection);

    await pool.query(
      `UPDATE collections SET status = 'ready', market_synced_at = NOW(), updated_at = NOW() WHERE slug = $1`,
      [slug]
    );
    console.log(`[seed] [${slug}] Market history seed complete — status set to ready`);
  } catch (e) {
    await pool.query(
      `UPDATE collections SET status = 'failed', error_message = $2, updated_at = NOW() WHERE slug = $1`,
      [slug, e.message]
    ).catch(dbErr => console.error(`[seed] [${slug}] Also failed to record error status:`, dbErr.message));
    console.error(`[seed] [${slug}] Market history seed failed:`, e.message);
    throw e;
  }
}

// Export for use in api.js trigger endpoint
module.exports = { syncListings, syncSales, syncAllListings, syncAllSales, discoverCollections, seedFullSalesHistory, seedMarketHistory };
})(); // end guard IIFE
