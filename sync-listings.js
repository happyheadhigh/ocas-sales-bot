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
const SYNC_INTERVAL   = 3 * 60 * 1000; // 3 minutes

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

// Export for use in api.js trigger endpoint
module.exports = { syncListings };
})(); // end guard IIFE
