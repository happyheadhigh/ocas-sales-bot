/**
 * TraitView Listings Sync
 * 
 * Fetches current OpenSea listings for OCAS and upserts into Postgres.
 * Run as a cron job on Railway alongside the bot.
 * 
 * Runs every 3 minutes via setInterval.
 * Can also be triggered manually via the API: GET /db/listings/sync?key=SECRET
 */

const { Pool } = require('pg');

const OPENSEA_API_KEY = process.env.OPENSEA_KEY || process.env.OPENSEA_API_KEY;
const DATABASE_URL    = process.env.DATABASE_URL;

// Guard: don't crash the container if env vars missing
void (function() {
const SLUG            = 'on-chain-all-stars';
const CONTRACT        = '0x078be86f3104a32313a47815792230a3808642cc';
const SYNC_INTERVAL   = 60 * 1000; // 1 minute

if (!DATABASE_URL) {
  console.error('[sync] Missing DATABASE_URL — listings sync disabled');
  module.exports = { syncListings: () => Promise.resolve() };
  return;
}
if (!OPENSEA_API_KEY) {
  console.error('[sync] Missing OPENSEA_API_KEY — listings sync disabled');
  module.exports = { syncListings: () => Promise.resolve() };
  return;
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 3,
});

// ── Ensure floor_history table exists ─────────────────────────────────────────
async function ensureFloorHistoryTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS floor_history (
        id          SERIAL PRIMARY KEY,
        floor_eth   NUMERIC(18,8) NOT NULL,
        token_id    INTEGER,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS floor_history_recorded_at_idx ON floor_history(recorded_at DESC)
    `);
  } catch(e) { console.error('[sync] ensureFloorHistoryTable error:', e.message); }
}
ensureFloorHistoryTable();

async function syncListings() {
  const startTime = Date.now();
  console.log(`[sync] Starting listings sync at ${new Date().toISOString()}`);

  try {
    // Fetch all current listings from OpenSea
    const listingsMap = {}; // token_id -> {price_eth, url}
    let next = null;
    let pages = 0;

    do {
      const qs = new URLSearchParams({ chain: 'ethereum', limit: '100' });
      if (next) qs.set('next', next);

      const resp = await fetch(
        `https://api.opensea.io/api/v2/listings/collection/${SLUG}/all?${qs}`,
        { headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' } }
      );

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.warn(`[sync] OpenSea HTTP ${resp.status} on page ${pages}: ${errText.slice(0, 200)}`);
        break;
      }

      const body = await resp.json();
      if (pages === 0) {
        console.log(`[sync] First page: ${body.listings?.length ?? 0} listings, keys: ${Object.keys(body).join(', ')}`);
        if (body.listings?.length > 0) {
          const sample = body.listings[0];
          console.log(`[sync] Sample listing keys: ${Object.keys(sample).join(', ')}`);
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

      for (const listing of (body.listings || [])) {
        const id = getTokenId(listing);
        const priceEth = getPriceEth(listing);

        if (!id || isNaN(id) || id < 1 || id > 10000) continue;
        if (priceEth == null || isNaN(priceEth) || priceEth <= 0) continue;

        const url = `https://opensea.io/assets/ethereum/${CONTRACT}/${id}`;
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
    console.log(`[sync] Fetched ${entries.length} listings across ${pages} pages`);

    if (entries.length === 0) {
      console.warn('[sync] No listings returned — skipping DB write');
      return;
    }

    // Upsert into Postgres in batches of 100
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Clear stale listings (tokens no longer listed)
      await client.query('DELETE FROM listings');

      // Insert fresh listings
      for (let i = 0; i < entries.length; i += 100) {
        const batch = entries.slice(i, i + 100);
        const vals  = batch.map((_, j) => `($${j*3+1}, $${j*3+2}, $${j*3+3}, NOW())`).join(', ');
        const params = batch.flatMap(([id, d]) => [parseInt(id), d.price_eth, d.url]);

        await client.query(`
          INSERT INTO listings (token_id, price_eth, url, updated_at)
          VALUES ${vals}
          ON CONFLICT (token_id) DO UPDATE
            SET price_eth = EXCLUDED.price_eth,
                url       = EXCLUDED.url,
                updated_at = NOW()
        `, params);
      }

      await client.query('COMMIT');
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[sync] ✓ Upserted ${entries.length} listings in ${elapsed}s`);

      // ── Write floor_history entry if floor has changed ─────────────────────
      // Only writes when MIN(price_eth) changes vs last recorded value.
      // This gives us a true floor timeline for 24h change calculations.
      try {
        const floorResult = await pool.query(
          `SELECT price_eth AS floor_eth, token_id
           FROM listings
           ORDER BY price_eth ASC
           LIMIT 1`
        );
        if (floorResult.rows.length && floorResult.rows[0].floor_eth) {
          const newFloor = parseFloat(floorResult.rows[0].floor_eth);
          const tokenId  = floorResult.rows[0].token_id;
          // Check last recorded floor
          const lastRow = await pool.query(
            `SELECT floor_eth FROM floor_history ORDER BY recorded_at DESC LIMIT 1`
          );
          const lastFloor = lastRow.rows.length ? parseFloat(lastRow.rows[0].floor_eth) : null;
          // Write if floor changed by more than 0.00001 ETH (float tolerance)
          if (lastFloor === null || Math.abs(newFloor - lastFloor) > 0.00001) {
            await pool.query(
              `INSERT INTO floor_history (floor_eth, token_id, recorded_at) VALUES ($1, $2, NOW())`,
              [newFloor, tokenId]
            );
            console.log(`[sync] Floor history: ${lastFloor ?? 'none'} → ${newFloor} ETH (token #${tokenId})`);
          }
        }
      } catch(e) { console.error('[sync] floor_history write error:', e.message); }

    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

  } catch (e) {
    console.error('[sync] Listings sync failed:', e.message);
  }
}

// Run immediately on startup, then every 3 minutes
syncListings();
setInterval(syncListings, SYNC_INTERVAL);

console.log(`[sync] Listings sync running — interval: ${SYNC_INTERVAL/1000}s`);

// ── Sync recent sales from OpenSea into DB ───────────────────────────────────
async function syncSales() {
  console.log(`[sync] Starting sales sync at ${new Date().toISOString()}`);
  try {
    let allSales = [];
    let cursor = null;
    let pages = 0;

    do {
      const qs = new URLSearchParams({ event_type: 'sale', limit: '100' });
      if (cursor) qs.set('next', cursor);

      const resp = await fetch(
        `https://api.opensea.io/api/v2/events/collection/${SLUG}?${qs}`,
        { headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' } }
      );

      if (!resp.ok) {
        console.warn(`[sync-sales] OpenSea HTTP ${resp.status} on page ${pages}`);
        break;
      }

      const body = await resp.json();
      const events = body.asset_events || [];

      for (const ev of events) {
        const rawId = ev?.nft?.identifier || ev?.asset?.token_id;
        if (!rawId) continue;
        const token_id = parseInt(rawId, 10);
        if (isNaN(token_id) || token_id < 1 || token_id > 10000) continue;

        const priceWei = ev?.payment?.quantity || ev?.total_price;
        if (!priceWei) continue;
        const price_eth = parseFloat(priceWei) / 1e18;
        if (isNaN(price_eth) || price_eth <= 0 || price_eth > 1000) continue;

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
      console.log('[sync-sales] No sales to sync');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < allSales.length; i += 100) {
        const batch = allSales.slice(i, i + 100);
        const vals = batch.map((_, j) =>
          `($${j*7+1},$${j*7+2},$${j*7+3},$${j*7+4},$${j*7+5},$${j*7+6},$${j*7+7})`
        ).join(', ');
        const params = batch.flatMap(s => [
          s.token_id, s.price_eth, s.currency, s.buyer, s.seller, s.sale_ts, s.tx_hash
        ]);
        await client.query(`
          INSERT INTO sales (token_id, price_eth, currency, buyer, seller, sale_ts, tx_hash)
          VALUES ${vals}
          ON CONFLICT (token_id, sale_ts) DO NOTHING
        `, params);
      }
      await client.query('COMMIT');
      console.log(`[sync-sales] ✓ Upserted ${allSales.length} sales`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[sync-sales] DB write failed:', e.message);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[sync-sales] Failed:', e.message);
  }
}

// Run sales sync on startup then every 15 minutes
syncSales();
setInterval(syncSales, 15 * 60 * 1000);

// Export for use in api.js trigger endpoint
module.exports = { syncListings, syncSales };
})(); // end guard IIFE
