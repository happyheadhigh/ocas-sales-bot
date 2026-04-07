/**
 * OCAS Sales Backfill — OpenSea Events
 * 
 * Fetches ALL historical sales from OpenSea events API by paginating
 * all the way back to the collection's first sale.
 * 
 * Run once: node backfill-sales.js
 * Safe to re-run — ON CONFLICT (token_id, sale_ts) DO NOTHING
 */

const { Pool } = require('pg');

const DATABASE_URL   = process.env.DATABASE_URL;
const OPENSEA_KEY    = process.env.OPENSEA_KEY || process.env.OPENSEA_API_KEY;
const SLUG           = 'on-chain-all-stars';

if (!DATABASE_URL || !OPENSEA_KEY) {
  console.error('Missing DATABASE_URL or OPENSEA_KEY / OPENSEA_API_KEY');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 3,
});

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id        SERIAL PRIMARY KEY,
      token_id  INTEGER NOT NULL,
      price_eth NUMERIC(18,8) NOT NULL,
      currency  VARCHAR(10) DEFAULT 'ETH',
      buyer     VARCHAR(42),
      seller    VARCHAR(42),
      tx_hash   VARCHAR(66),
      sale_ts   TIMESTAMPTZ NOT NULL,
      UNIQUE (token_id, sale_ts)
    )
  `);
  // Add columns if table existed without them
  for (const col of ['buyer VARCHAR(42)', 'seller VARCHAR(42)', 'tx_hash VARCHAR(66)']) {
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS sales_token_id_idx ON sales(token_id)`).catch(() => {});
  console.log('✓ sales table ready');
}

async function fetchPage(cursor) {
  const qs = new URLSearchParams({ event_type: 'sale', limit: '100' });
  if (cursor) qs.set('next', cursor);

  const r = await fetch(
    `https://api.opensea.io/api/v2/events/collection/${SLUG}?${qs}`,
    { headers: { 'x-api-key': OPENSEA_KEY, 'Accept': 'application/json' } }
  );

  if (r.status === 429) {
    console.log('  Rate limited — waiting 10s...');
    await new Promise(r => setTimeout(r, 10000));
    return fetchPage(cursor); // retry
  }

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`OpenSea HTTP ${r.status}: ${text.slice(0, 200)}`);
  }

  return r.json();
}

async function insertBatch(sales) {
  if (!sales.length) return 0;
  const vals = sales.map((_, j) =>
    `($${j*7+1},$${j*7+2},$${j*7+3},$${j*7+4},$${j*7+5},$${j*7+6},$${j*7+7})`
  ).join(', ');
  const params = sales.flatMap(s => [
    s.token_id, s.price_eth, s.currency, s.buyer, s.seller, s.tx_hash, s.sale_ts
  ]);
  const result = await pool.query(`
    INSERT INTO sales (token_id, price_eth, currency, buyer, seller, tx_hash, sale_ts)
    VALUES ${vals}
    ON CONFLICT (token_id, sale_ts) DO NOTHING
  `, params);
  return result.rowCount;
}

function parseSale(ev) {
  const rawId = ev?.nft?.identifier || ev?.asset?.token_id;
  if (!rawId) return null;
  const token_id = parseInt(rawId, 10);
  if (isNaN(token_id) || token_id < 1 || token_id > 10000) return null;

  const priceWei = ev?.payment?.quantity || ev?.total_price;
  if (!priceWei) return null;
  const price_eth = parseFloat(priceWei) / 1e18;
  if (isNaN(price_eth) || price_eth <= 0 || price_eth > 1000) return null;

  // Detect WETH vs ETH by token address
  const addr = (ev?.payment?.address || ev?.payment?.token_address || '').toLowerCase();
  const currency = addr === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' ? 'WETH' : 
                   (ev?.payment?.symbol || 'ETH');

  const ts = ev?.closing_date || ev?.event_timestamp;
  if (!ts) return null;
  const sale_ts = new Date(ts * 1000).toISOString();

  return {
    token_id,
    price_eth: price_eth.toFixed(8),
    currency,
    buyer:   ev?.buyer  || ev?.winner_account?.address || null,
    seller:  ev?.seller || ev?.from_account?.address   || null,
    tx_hash: ev?.transaction || null,
    sale_ts,
  };
}

async function backfill() {
  await ensureTable();

  let cursor = null;
  let page = 0;
  let totalFetched = 0;
  let totalInserted = 0;
  let batch = [];

  console.log('Starting OpenSea sales backfill — paginating all the way back...\n');

  do {
    const body = await fetchPage(cursor);
    const events = body.asset_events || [];
    cursor = body.next || null;
    page++;

    for (const ev of events) {
      const sale = parseSale(ev);
      if (sale) {
        batch.push(sale);
        totalFetched++;
      }
    }

    // Insert every 500 records
    if (batch.length >= 500) {
      const inserted = await insertBatch(batch);
      totalInserted += inserted;
      batch = [];
      process.stdout.write(`\r  Page ${page} | Fetched: ${totalFetched} | Inserted: ${totalInserted}    `);
    } else {
      process.stdout.write(`\r  Page ${page} | Fetched: ${totalFetched} | Inserted: ${totalInserted}    `);
    }

    // Small delay to avoid rate limiting
    if (cursor) await new Promise(r => setTimeout(r, 250));

  } while (cursor);

  // Insert remaining
  if (batch.length) {
    const inserted = await insertBatch(batch);
    totalInserted += inserted;
  }

  console.log(`\n\n✓ Backfill complete: ${totalFetched} sales fetched, ${totalInserted} new rows inserted`);
  await pool.end();
}

backfill().catch(e => {
  console.error('\nBackfill failed:', e.message);
  process.exit(1);
});
