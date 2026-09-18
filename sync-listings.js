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

  const collections = Array.from(map.values());

  // Chain isn't in server_configs at all — same gap already fixed in
  // /download, wallet-backfill, and elsewhere tonight. One batch query
  // against the collections registry (the actual source of truth) rather
  // than a lookup per collection.
  try {
    const chainRes = await pool.query(
      `SELECT slug, chain FROM collections WHERE slug = ANY($1)`,
      [collections.map(c => c.slug)]
    );
    const chainMap = {};
    for (const row of chainRes.rows) chainMap[row.slug] = row.chain;
    for (const c of collections) c.chain = chainMap[c.slug] || 'ethereum';
  } catch (e) {
    console.warn('[sync] discoverCollections chain lookup failed (defaulting to ethereum):', e.message);
    for (const c of collections) c.chain = c.chain || 'ethereum';
  }

  return collections;
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
  const { slug, contract, chain = 'ethereum' } = collection;
  const startTime = Date.now();
  console.log(`[sync] Starting listings sync for ${slug} at ${new Date().toISOString()}`);

  try {
    // Fetch all current listings from OpenSea
    const listingsMap = {}; // token_id -> {price_eth, url}
    let next = null;
    let pages = 0;
    // Confirmed the actual bug jv reported (TraitView missing real, active
    // listings that OpenSea itself shows -- not a price-accuracy issue,
    // confirmed live prices matched for tokens that DID show up). Previously
    // a single transient HTTP error on ANY page immediately broke out of
    // pagination and used whatever had been collected so far -- this
    // endpoint has no reason to be price-sorted (more likely sorted by
    // listing time), so a page lost to a rate limit or timeout could easily
    // be exactly the page holding the actual cheapest listings. Worse, the
    // DB write below is a full DELETE + re-INSERT for this slug, so a
    // partial fetch didn't just fail to add anything new -- it actively
    // replaced a previously-complete set with an incomplete one.
    // completedFully only becomes true if the loop's own `next` cursor runs
    // out (a genuine end of the collection's listings) -- the DB write
    // below is skipped entirely otherwise, leaving whatever the last
    // successful full sync wrote in place until the next cycle (60s later)
    // gets a clean run.
    let completedFully = false;

    do {
      const qs = new URLSearchParams({ chain, limit: '100' });
      if (next) qs.set('next', next);

      // Retry transient failures (rate limits, momentary server errors)
      // instead of giving up on the whole sync the first time OpenSea's API
      // hiccups on any single page -- a real, if occasional, occurrence
      // that shouldn't cost every listing from every OTHER page already
      // fetched successfully.
      let resp = null;
      let body = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        resp = await fetch(
          `https://api.opensea.io/api/v2/listings/collection/${slug}/all?${qs}`,
          { headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' } }
        );
        if (resp.ok) { body = await resp.json(); break; }
        const errText = await resp.text().catch(() => '');
        const retryable = resp.status === 429 || resp.status >= 500;
        console.warn(`[sync] [${slug}] OpenSea HTTP ${resp.status} on page ${pages} (attempt ${attempt}/3): ${errText.slice(0, 200)}`);
        if (!retryable || attempt === 3) break;
        await new Promise(r => setTimeout(r, 500 * attempt)); // 500ms, 1000ms backoff
      }

      if (!body) {
        console.warn(`[sync] [${slug}] Giving up on page ${pages} after retries -- sync incomplete, DB write will be skipped this cycle`);
        break;
      }

      if (pages === 0) {
        console.log(`[sync] [${slug}] First page: ${body.listings?.length ?? 0} listings, keys: ${Object.keys(body).join(', ')}`);
        if (body.listings?.length > 0) {
          const sample = body.listings[0];
          console.log(`[sync] [${slug}] Sample listing keys: ${Object.keys(sample).join(', ')}`);
          // jv confirmed live on nekoadz: listing prices showing as 0.000 on
          // TraitView, matching an earlier "8e-12 ETH" floor-price log this
          // exact bug already produced. getPriceEth() below falls back to
          // assuming 18 decimals (wei/1e18) whenever OpenSea doesn't hand
          // it a pre-computed .decimal -- correct for ETH/WETH, but this
          // chain's own assets have been confirmed elsewhere to NOT
          // reliably use 18 decimals, resolved via an actual on-chain
          // decimals() call rather than assumed -- a strong signal this
          // chain's native/listing currency may not be 18 decimals either.
          // Logging the full raw price object here (not just its top-level
          // keys) so the actual field names/values are visible without
          // needing another log round-trip to guess at OpenSea's response
          // shape for this specific chain.
          if(sample.price) console.log(`[sync] [${slug}] Sample listing price object: ${JSON.stringify(sample.price)}`);
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
        if(wei == null) return null;
        // jv: Nekoadz (Robinhood Chain, USDG) listings showing "Ξ0.0000"
        // on the grid despite the floor pill (a different data source)
        // showing the correct "12.000 USDG". This always fell through to
        // a hardcoded /1e18 (ETH-style) conversion regardless of the
        // listing's real currency -- .decimal (singular) isn't an actual
        // OpenSea field at all, so that check never once matched
        // anything; .decimals (plural, the real decimals COUNT OpenSea
        // returns -- the same field name already correctly read on the
        // sales side's own currency-decimals fix, sync-listings.js
        // above) was never checked. Dividing a 6-decimal USDG raw value
        // by 1e18 instead of 1e6 produces a number so tiny it rounds to
        // 0.0000 at display precision -- looks like "no price" rather
        // than a wrong one, which is why this wasn't obviously broken.
        const decimals = listing?.price?.current?.decimals ?? listing?.price?.decimals ?? 18;
        return parseFloat(wei) / Math.pow(10, decimals);
      }

      // jv: "make the weth and eth wording through the page green for eth
      // and red for weth" -- traced back to here: listings never tracked
      // currency at all, only a numeric price_eth value, unlike sales
      // (which already got this same fix earlier this session). OpenSea's
      // listing price object carries its own currency symbol alongside
      // the value/decimal fields getPriceEth above already reads --
      // extracting it the same way, defaulting to 'ETH' only if truly
      // absent (matching how every existing listing row -- inserted
      // before this column existed -- should be read).
      function getCurrency(listing) {
        return listing?.price?.current?.currency || listing?.price?.currency || 'ETH';
      }

      // Generous, collection-agnostic sanity bound against malformed parses —
      // not a real business rule about collection size (the old 10000 cap
      // was OCAS/CryptoPunks-coincidental, not meaningful for collections of
      // other sizes).
      const MAX_PLAUSIBLE_TOKEN_ID = 10_000_000;

      let droppedThisPage = 0;
      for (const listing of (body.listings || [])) {
        const id = getTokenId(listing);
        const priceEth = getPriceEth(listing);
        const currency = getCurrency(listing);

        if (!id || isNaN(id) || id < 0 || id > MAX_PLAUSIBLE_TOKEN_ID) { droppedThisPage++; continue; }
        if (priceEth == null || isNaN(priceEth) || priceEth <= 0) { droppedThisPage++; continue; }

        const url = `https://opensea.io/assets/${chain}/${contract}/${id}`;
        if (!listingsMap[id] || priceEth < listingsMap[id].price_eth) {
          listingsMap[id] = { price_eth: priceEth, url, currency };
        }
      }
      // Visible in logs if a real fraction of a page is unparseable --
      // distinct from the page-level HTTP retry above, this is about
      // individual listings within an otherwise-successful page failing
      // getTokenId()/getPriceEth()'s own parsing.
      if (droppedThisPage > 0){
        console.warn(`[sync] [${slug}] Dropped ${droppedThisPage}/${body.listings?.length ?? 0} listings on page ${pages} (unparseable id or price)`);
      }

      next = body.next || null;
      pages++;

      // Raised from 25 -> 150 pages (2,500 -> 15,000 raw listings). 25 was
      // never validated against actual collection sizes -- Argonauts alone
      // has ~9,216 total tokens, and this endpoint can return more than one
      // listing entry per token (competing offers, re-listings still
      // present in a page before OpenSea's own indexing catches up), so
      // the raw listing count this loop sees isn't the same as the unique,
      // currently-listed token count it ends up keeping. Combined with the
      // completedFully check below, hitting even this higher cap still
      // means the DB write for this cycle gets skipped rather than writing
      // a silently-incomplete set -- so this is about giving genuinely
      // large or heavily-listed collections room to actually finish, not
      // about removing the safety net itself.
      if (pages >= 150) break;
      if (next) await new Promise(r => setTimeout(r, 80)); // rate limit

    } while (next);

    completedFully = (next == null);

    const entries = Object.entries(listingsMap);
    console.log(`[sync] [${slug}] Fetched ${entries.length} listings across ${pages} pages (completedFully=${completedFully})`);

    if (entries.length === 0) {
      console.warn(`[sync] [${slug}] No listings returned — skipping DB write`);
      return;
    }

    if (!completedFully) {
      console.warn(`[sync] [${slug}] Sync did not complete fully (stopped early after retries or hit the page cap) -- skipping DB write this cycle to avoid replacing a complete set with a partial one. Will retry next cycle.`);
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
        const vals  = batch.map((_, j) => `($${j*5+1}, $${j*5+2}, $${j*5+3}, $${j*5+4}, $${j*5+5}, NOW())`).join(', ');
        const params = batch.flatMap(([id, d]) => [parseInt(id), d.price_eth, d.url, slug, d.currency || 'ETH']);

        await client.query(`
          INSERT INTO listings (token_id, price_eth, url, collection_slug, currency, updated_at)
          VALUES ${vals}
          ON CONFLICT (token_id, collection_slug) DO UPDATE
            SET price_eth = EXCLUDED.price_eth,
                url       = EXCLUDED.url,
                currency  = EXCLUDED.currency,
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

// jv: "The listing totals are off" (794 shown vs. OpenSea's own live 816
// for Argonauts). Investigated the sync itself thoroughly -- pagination
// retries, per-listing parsing, the completedFully guard against writing
// a partial set -- all already correct and already fixed for a prior,
// similar report. What was NOT guarded: setInterval here has no
// reentrancy protection at all. If one full pass (sequentially syncing
// every configured collection, each its own multi-page OpenSea fetch)
// ever takes longer than SYNC_INTERVAL -- plausible with retries, or a
// collection with enough listings to need many pages -- the next tick
// fires a second, fully concurrent syncAllListings() run before the
// first has finished. Two overlapping syncListings() calls for the same
// collection racing their own DELETE+INSERT against each other is
// exactly the kind of gap that could produce a wrong count without ever
// showing up as an error anywhere, since neither run would fail --
// they'd just interleave.
let _syncAllListingsRunning = false;
async function syncAllListings() {
  if(_syncAllListingsRunning){
    console.warn('[sync] syncAllListings still running from a previous tick -- skipping this one rather than overlapping');
    return;
  }
  _syncAllListingsRunning = true;
  try{
    const collections = await discoverCollections();
    console.log(`[sync] Syncing listings for ${collections.length} collection(s): ${collections.map(c => c.slug).join(', ')}`);
    for (const collection of collections) {
      await syncListings(collection);
      if (collections.length > 1) await new Promise(r => setTimeout(r, COLLECTION_DELAY));
    }
  } finally {
    _syncAllListingsRunning = false;
  }
}

// Run immediately on startup, then every 60 seconds (SYNC_INTERVAL) -- a
// tick that finds the previous pass still in flight skips itself instead
// of overlapping it (see the reentrancy guard above).
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
        // jv confirmed live on nekoadz (Robinhood Chain): a sale showing
        // "8 ETH" that was actually 8 of the chain's real native/listing
        // currency. This hardcoded 18 decimals unconditionally regardless
        // of ev.payment.decimals -- same bug class already fixed for
        // listing prices (getPriceEth's 8e-12 ETH incident). Reading the
        // real decimals when OpenSea provides them, same as the already-
        // correct pattern used for sale embeds elsewhere in this codebase
        // (lib/embeds.js: `const dec = event.payment?.decimals ?? 18;`).
        const decimals = ev?.payment?.decimals ?? 18;
        const price_eth = parseFloat(priceWei) / Math.pow(10, decimals);
        if (isNaN(price_eth) || price_eth <= 0 || price_eth > MAX_PLAUSIBLE_PRICE_ETH) continue;

        // jv: "Nekoadz is showing a sale for 8 eth but it's actually 8
        // USDG." This already correctly reads ev.payment.symbol rather
        // than assuming ETH -- if it's still showing "ETH" after this
        // deploys, that means OpenSea's own event payload isn't actually
        // populating .symbol for this chain's sales, not a bug in this
        // read. Logging the full raw payment object once per sync run so
        // the real field structure is visible without guessing further.
        if (!global.__loggedSamplePayment) {
          global.__loggedSamplePayment = true;
          console.log(`[sync-sales] [${slug}] Sample sale payment object: ${JSON.stringify(ev?.payment)}`);
        }
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
          -- jv reported (via cryptoadz-by-gremplin's retry logs): "duplicate
          -- key value violates unique constraint 'sales_tx_hash...'" here,
          -- even though this INSERT already targets ON CONFLICT (token_id,
          -- sale_ts, collection_slug). Root cause: the sales table carries
          -- TWO separate unique constraints -- the original UNIQUE(tx_hash,
          -- token_id) from this table's very first CREATE TABLE, and a
          -- later sales_token_ts_slug_unique index added for this exact
          -- ON CONFLICT clause (see diag-check-conflict-constraints.js,
          -- written for a similar earlier gap). A targeted ON CONFLICT only
          -- suppresses a violation of the ONE constraint it names -- a
          -- conflict on the older, still-active tx_hash+token_id constraint
          -- was never covered by this clause at all. Targetless DO NOTHING
          -- suppresses a violation of ANY unique/exclusion constraint on the
          -- table, so this is safe regardless of which of the two is hit
          -- (or if a third is ever added later).
          ON CONFLICT DO NOTHING
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

// Same reentrancy guard as syncAllListings above -- less likely to matter
// at a 15-minute interval, but the same class of risk exists in principle
// if a pass ever runs long, so guarded the same way for consistency.
let _syncAllSalesRunning = false;
async function syncAllSales() {
  if(_syncAllSalesRunning){
    console.warn('[sync-sales] syncAllSales still running from a previous tick -- skipping this one rather than overlapping');
    return;
  }
  _syncAllSalesRunning = true;
  try{
    const collections = await discoverCollections();
    console.log(`[sync-sales] Syncing sales for ${collections.length} collection(s): ${collections.map(c => c.slug).join(', ')}`);
    for (const collection of collections) {
      await syncSales(collection);
      if (collections.length > 1) await new Promise(r => setTimeout(r, COLLECTION_DELAY));
    }
  } finally {
    _syncAllSalesRunning = false;
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

  // jv: two consecutive retry-failure webhooks an hour apart, both dying at
  // the exact same "page 180" -- confirmed this always restarted from page 1
  // with no delay between requests at all, which is both why it keeps
  // tripping the same rate limit and why every retry wastes the same ~180
  // requests before dying at the same wall again. Resuming from wherever
  // the last attempt actually got to, instead of starting over from zero.
  const priorRes = await pool.query(
    `SELECT sales_seed_cursor, sales_seed_written, sales_seed_pages FROM collections WHERE slug=$1`, [slug]
  ).catch(() => null);
  let cursor = priorRes?.rows[0]?.sales_seed_cursor || null;
  let totalWritten = priorRes?.rows[0]?.sales_seed_written || 0;
  let pages = priorRes?.rows[0]?.sales_seed_pages || 0;
  if(cursor){
    console.log(`[seed] [${slug}] Resuming FULL sales history pull from saved cursor (page ${pages}, ${totalWritten} sales already written) at ${new Date().toISOString()}`);
  } else {
    console.log(`[seed] Starting FULL sales history pull for ${slug} at ${new Date().toISOString()}`);
  }

  const MAX_PLAUSIBLE_TOKEN_ID = 10_000_000;
  const MAX_PLAUSIBLE_PRICE_ETH = 100_000;
  const MAX_PAGES = 2000; // 2000 * 100 = 200,000 sales safety cap — raised from 50,000, which would have quietly truncated a ~44k-token collection trading at anywhere near OnChainHoodies' ~1.2 sales/token ratio

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
        // jv confirmed live on nekoadz (Robinhood Chain): a sale showing
        // "8 ETH" that was actually 8 of the chain's real native/listing
        // currency. This hardcoded 18 decimals unconditionally regardless
        // of ev.payment.decimals -- same bug class already fixed for
        // listing prices (getPriceEth's 8e-12 ETH incident). Reading the
        // real decimals when OpenSea provides them, same as the already-
        // correct pattern used for sale embeds elsewhere in this codebase
        // (lib/embeds.js: `const dec = event.payment?.decimals ?? 18;`).
        const decimals = ev?.payment?.decimals ?? 18;
        const price_eth = parseFloat(priceWei) / Math.pow(10, decimals);
        if (isNaN(price_eth) || price_eth <= 0 || price_eth > MAX_PLAUSIBLE_PRICE_ETH) continue;

        // jv: "Nekoadz is showing a sale for 8 eth but it's actually 8
        // USDG." This already correctly reads ev.payment.symbol rather
        // than assuming ETH -- if it's still showing "ETH" after this
        // deploys, that means OpenSea's own event payload isn't actually
        // populating .symbol for this chain's sales, not a bug in this
        // read. Logging the full raw payment object once per sync run so
        // the real field structure is visible without guessing further.
        if (!global.__loggedSamplePayment) {
          global.__loggedSamplePayment = true;
          console.log(`[sync-sales] [${slug}] Sample sale payment object: ${JSON.stringify(ev?.payment)}`);
        }
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
              ON CONFLICT DO NOTHING
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
      // jv: two consecutive retries both died at the exact same "page 180"
      // rate limit. There was already an 80ms delay here, which clearly
      // wasn't enough spacing to avoid tripping OpenSea's limit across ~180
      // consecutive requests -- raised to 300ms, matching the spacing
      // already used for OpenSea pagination elsewhere in this codebase
      // (lib/poll.js), and persisting progress every page (below) so if it
      // DOES still get rate-limited somewhere, the next attempt resumes
      // from here instead of restarting from page 1 and hitting the exact
      // same wall again.
      await pool.query(
        `UPDATE collections SET sales_seed_cursor = $2, sales_seed_written = $3, sales_seed_pages = $4, updated_at = NOW() WHERE slug = $1`,
        [slug, cursor, totalWritten, pages]
      ).catch(e => console.warn(`[seed] [${slug}] Failed to persist sales-seed cursor (non-fatal, next retry will just restart from page 1):`, e.message));
      if (pages % 20 === 0) console.log(`[seed] [${slug}] ...${pages} pages, ${totalWritten} sales written so far`);
      if (pages >= MAX_PAGES) {
        console.warn(`[seed] [${slug}] Hit the ${MAX_PAGES}-page safety cap (${MAX_PAGES * 100} events) — history pull stopped early, not necessarily complete`);
        break;
      }
      if (cursor) await new Promise(r => setTimeout(r, 300));
    } while (cursor);

    // Pull complete -- clear the saved cursor so a future re-onboard of this
    // same slug (unlikely, but possible) starts fresh rather than "resuming"
    // from a pull that already finished.
    await pool.query(
      `UPDATE collections SET sales_seed_cursor = NULL, sales_seed_written = 0, sales_seed_pages = 0, updated_at = NOW() WHERE slug = $1`,
      [slug]
    ).catch(() => {});
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

    // jv: "there should be an automatic retry, server admins shouldn't have
    // to manually re run it if it fails." Reset retry state on success --
    // this can be reached either as a first-try success or as the eventual
    // successful attempt after one or more scheduled retries
    // (retryFailedMarketHistory, bot.js), so both paths need it cleared.
    await pool.query(
      `UPDATE collections SET status = 'ready', market_synced_at = NOW(), market_retry_count = 0, market_next_retry_at = NULL, updated_at = NOW() WHERE slug = $1`,
      [slug]
    );
    console.log(`[seed] [${slug}] Market history seed complete — status set to ready`);
  } catch (e) {
    // Exponential backoff: 30min, 1hr, 2hr, 4hr, 8hr, capping at 24hr so a
    // persistent failure still gets checked roughly once a day rather than
    // retrying forever at the same short interval and re-hammering
    // whatever's rate-limiting it. market_retry_count is read-then-written
    // here (not an atomic increment) because this whole function only ever
    // runs for one slug at a time, never concurrently with itself.
    const priorRes = await pool.query(`SELECT market_retry_count FROM collections WHERE slug=$1`, [slug]).catch(() => null);
    const priorCount = priorRes?.rows[0]?.market_retry_count || 0;
    const newCount = priorCount + 1;
    // Give up on scheduled retries after 10 attempts (roughly a week at the
    // capped 24hr interval) rather than retrying an actually-broken
    // collection forever -- market_next_retry_at stays NULL from here on,
    // which retryFailedMarketHistory's own query (bot.js) already filters
    // on, so this alone stops it from being picked up again. A manual
    // /config re-run still resets market_retry_count to 0 on its next
    // success, same as any other retry.
    const giveUp = newCount >= 10;
    const backoffMinutes = Math.min(30 * Math.pow(2, priorCount), 24 * 60);
    await pool.query(
      `UPDATE collections SET status = 'failed', error_message = $2, market_retry_count = $3, market_next_retry_at = $4, updated_at = NOW() WHERE slug = $1`,
      [slug, e.message, newCount, giveUp ? null : new Date(Date.now() + backoffMinutes * 60_000)]
    ).catch(dbErr => console.error(`[seed] [${slug}] Also failed to record error status:`, dbErr.message));
    if(giveUp){
      console.error(`[seed] [${slug}] Market history seed failed ${newCount} times -- giving up on automatic retries, needs manual attention:`, e.message);
    } else {
      console.error(`[seed] [${slug}] Market history seed failed (attempt ${newCount}, next retry in ${backoffMinutes}min):`, e.message);
    }
    throw e;
  }
}

// Export for use in api.js trigger endpoint
module.exports = { syncListings, syncSales, syncAllListings, syncAllSales, discoverCollections, seedFullSalesHistory, seedMarketHistory };
})(); // end guard IIFE
