/**
 * OCAS Sales Backfill
 * 
 * One-time script to pull ALL historical sales from Alchemy back to mint.
 * Uses alchemy_getAssetTransfers (ERC-721) + WETH transfer matching.
 * 
 * Run once on Railway:
 *   node backfill-sales.js
 * 
 * Safe to re-run — uses ON CONFLICT DO NOTHING on (token_id, sale_ts).
 */

const { Pool } = require('pg');

const DATABASE_URL   = process.env.DATABASE_URL;
const ALCHEMY_KEY    = process.env.ALCHEMY_API_KEY;
const CONTRACT       = '0x078be86f3104a32313a47815792230a3808642cc';
const WETH_CONTRACT  = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ZERO           = '0x0000000000000000000000000000000000000000';
const ALCHEMY_URL    = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

if (!DATABASE_URL || !ALCHEMY_KEY) {
  console.error('Missing DATABASE_URL or ALCHEMY_API_KEY');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 3,
});

// ── Ensure sales table exists with all columns ────────────────────────────────
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id         SERIAL PRIMARY KEY,
      token_id   INTEGER NOT NULL,
      price_eth  NUMERIC(18,8) NOT NULL,
      currency   VARCHAR(10) DEFAULT 'ETH',
      buyer      VARCHAR(42),
      seller     VARCHAR(42),
      tx_hash    VARCHAR(66),
      sale_ts    TIMESTAMPTZ NOT NULL,
      UNIQUE (token_id, sale_ts)
    )
  `);
  // Add missing columns if table existed without them
  const cols = ['buyer VARCHAR(42)', 'seller VARCHAR(42)', 'tx_hash VARCHAR(66)'];
  for (const col of cols) {
    const [name] = col.split(' ');
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS sales_token_id_idx ON sales(token_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sales_sale_ts_idx ON sales(sale_ts)`);
  console.log('✓ sales table ready');
}

// ── Fetch from Alchemy ────────────────────────────────────────────────────────
async function alchemyPost(params) {
  const r = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers', params: [params] })
  });
  const d = await r.json();
  return d?.result;
}

// ── Main backfill ─────────────────────────────────────────────────────────────
async function backfill() {
  await ensureTable();

  console.log('Fetching all ERC-721 transfers for OCAS...');
  
  const allTransfers = [];
  let pageKey = null;
  let page = 0;

  do {
    const result = await alchemyPost({
      fromBlock: '0x0',
      toBlock: 'latest',
      contractAddresses: [CONTRACT],
      category: ['erc721'],
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: '0x3e8', // 1000
      ...(pageKey ? { pageKey } : {})
    });

    if (!result) { console.warn('Alchemy returned null, stopping'); break; }

    const transfers = result.transfers || [];
    allTransfers.push(...transfers);
    pageKey = result.pageKey || null;
    page++;

    console.log(`  Page ${page}: ${transfers.length} transfers (total: ${allTransfers.length})`);

    if (pageKey) await new Promise(r => setTimeout(r, 200));
  } while (pageKey);

  console.log(`\nTotal ERC-721 transfers: ${allTransfers.length}`);

  // Filter out mints/burns
  const sales = allTransfers.filter(t => t.from !== ZERO && t.to !== ZERO);
  console.log(`Non-mint transfers (potential sales): ${sales.length}`);

  // Get block range for WETH lookup
  const blockNums = sales.map(t => parseInt(t.blockNum, 16)).filter(Boolean);
  const minBlock  = Math.min(...blockNums);
  const maxBlock  = Math.max(...blockNums);
  console.log(`Block range: ${minBlock} → ${maxBlock}`);

  // Fetch WETH transfers in same block range to detect WETH sales
  console.log('Fetching WETH transfers...');
  const wethByHash = {};
  let wethPageKey = null;
  let wethPage = 0;

  do {
    const result = await alchemyPost({
      fromBlock: '0x' + minBlock.toString(16),
      toBlock:   '0x' + maxBlock.toString(16),
      contractAddresses: [WETH_CONTRACT],
      category: ['erc20'],
      withMetadata: false,
      excludeZeroValue: true,
      maxCount: '0x7d0', // 2000
      ...(wethPageKey ? { pageKey: wethPageKey } : {})
    });

    if (!result) break;

    const seenPairs = {};
    for (const t of (result.transfers || [])) {
      if (!t.hash || !t.value) continue;
      const pairKey = `${t.hash}:${t.from}:${t.to}`;
      if (seenPairs[pairKey]) continue;
      seenPairs[pairKey] = true;
      wethByHash[t.hash] = (wethByHash[t.hash] || 0) + Number(t.value);
    }

    wethPageKey = result.pageKey || null;
    wethPage++;
    console.log(`  WETH page ${wethPage}: ${result.transfers?.length || 0} transfers`);
    if (wethPageKey) await new Promise(r => setTimeout(r, 200));
  } while (wethPageKey);

  console.log(`WETH-paying tx hashes found: ${Object.keys(wethByHash).length}`);

  // Count NFTs per tx for bulk purchase price splitting
  const nftCountByHash = {};
  for (const t of sales) {
    nftCountByHash[t.hash] = (nftCountByHash[t.hash] || 0) + 1;
  }

  // Build sale records
  const saleRecords = [];
  for (const t of sales) {
    let tokenId = null;
    if (t.erc721TokenId) tokenId = parseInt(t.erc721TokenId, 16);
    else if (t.tokenId)  tokenId = parseInt(t.tokenId, 16);
    if (!tokenId || isNaN(tokenId) || tokenId < 1 || tokenId > 10000) continue;

    const nativeEth = t.value != null ? Number(t.value) : 0;
    const nftCount  = nftCountByHash[t.hash] || 1;
    const wethEth   = wethByHash[t.hash] ? wethByHash[t.hash] / nftCount : 0;

    let price_eth, currency;
    if (nativeEth > 0)      { price_eth = nativeEth; currency = 'ETH'; }
    else if (wethEth > 0)   { price_eth = wethEth;   currency = 'WETH'; }
    else continue; // skip zero-value transfers (gifts)

    if (price_eth > 1000) continue; // sanity check

    const sale_ts = t.metadata?.blockTimestamp
      ? new Date(t.metadata.blockTimestamp).toISOString()
      : null;
    if (!sale_ts) continue;

    saleRecords.push({
      token_id:  tokenId,
      price_eth: price_eth.toFixed(8),
      currency,
      buyer:    t.to   || null,
      seller:   t.from || null,
      tx_hash:  t.hash || null,
      sale_ts,
    });
  }

  console.log(`\nSale records to insert: ${saleRecords.length}`);

  // Upsert into DB in batches
  const client = await pool.connect();
  let inserted = 0;
  try {
    for (let i = 0; i < saleRecords.length; i += 100) {
      const batch = saleRecords.slice(i, i + 100);
      const vals = batch.map((_, j) =>
        `($${j*7+1},$${j*7+2},$${j*7+3},$${j*7+4},$${j*7+5},$${j*7+6},$${j*7+7})`
      ).join(', ');
      const params = batch.flatMap(s => [
        s.token_id, s.price_eth, s.currency, s.buyer, s.seller, s.tx_hash, s.sale_ts
      ]);
      const result = await client.query(`
        INSERT INTO sales (token_id, price_eth, currency, buyer, seller, tx_hash, sale_ts)
        VALUES ${vals}
        ON CONFLICT (token_id, sale_ts) DO NOTHING
      `, params);
      inserted += result.rowCount;
      process.stdout.write(`\r  Inserted ${inserted}/${saleRecords.length}...`);
    }
    console.log(`\n✓ Backfill complete: ${inserted} sales inserted`);
  } finally {
    client.release();
    await pool.end();
  }
}

backfill().catch(e => {
  console.error('Backfill failed:', e.message);
  process.exit(1);
});
