'use strict';
/**
 * lib/collection-transfers.js
 *
 * jv: "Next step would be to getting more insight into the collection
 * holdings as a whole. Wallet hold time, top minter, top p&l, which wallet
 * is holding the most of what traits, which wallet bought the most, which
 * sold, which wallets sold for a total losses, etc"
 *
 * nft_transfers only covers verified users' wallets. Hold time and minters
 * need EVERY transfer of the collection, so this keeps a collection-wide
 * copy (collection_transfers) via Alchemy alchemy_getAssetTransfers
 * filtered by contract only. First run backfills from block 0 (a few
 * hundred pages at most for a 10k collection), later runs only fetch from
 * the last stored block. Duplicates are ignored via (slug, unique_id).
 *
 * bot_state `ctx_complete:<slug>` = '1' once a run reached the chain tip,
 * so /db/holder-stats can say whether hold times are complete yet.
 */
const fetch = require('node-fetch');
const { pgPool } = require('./db');
const { SUPPORTED_CHAINS } = require('./collection-backfill');

const INTERVAL_MS = 3 * 60_000; // (was 10 -- wallet alerts for mints/transfers ride on this)
const MAX_PAGES_PER_RUN = 150; // 150k transfers per collection per run
let _running = false;

async function ensureTable(){
  await pgPool.query(`CREATE TABLE IF NOT EXISTS collection_transfers (
    collection_slug TEXT NOT NULL,
    unique_id       TEXT NOT NULL,
    token_id        BIGINT,
    from_address    TEXT,
    to_address      TEXT,
    block_number    BIGINT,
    ts              TIMESTAMPTZ,
    tx_hash         TEXT,
    PRIMARY KEY (collection_slug, unique_id)
  )`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS collection_transfers_slug_block_idx ON collection_transfers(collection_slug, block_number)`);
  // Wallet History lookups (/db/wallet-activity) filter by either side.
  await pgPool.query(`CREATE INDEX IF NOT EXISTS collection_transfers_from_idx ON collection_transfers(collection_slug, from_address)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS collection_transfers_to_idx ON collection_transfers(collection_slug, to_address)`);
}

async function alchemyPage(url, params){
  let lastErr;
  for(let attempt = 0; attempt < 4; attempt++){
    try{
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers', params: [params] }),
      });
      if(res.ok){
        const j = await res.json();
        if(j.error) throw new Error(j.error.message || 'alchemy error');
        return j.result || {};
      }
      lastErr = new Error(`Alchemy HTTP ${res.status}`);
      if(res.status !== 429 && res.status < 500) break;
    }catch(e){ lastErr = e; }
    await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
  }
  throw lastErr || new Error('alchemy request failed');
}

function parseTokenId(t){
  const raw = t.erc721TokenId || t.tokenId || (t.erc1155Metadata && t.erc1155Metadata[0] && t.erc1155Metadata[0].tokenId);
  if(!raw) return null;
  try{
    const n = BigInt(raw);
    return n <= 9007199254740991n ? Number(n) : null;
  }catch{ return null; }
}

async function syncCollectionTransfers(col, alchemyKey){
  const { slug, contract } = col;
  const sub = SUPPORTED_CHAINS[col.chain || 'ethereum'];
  if(!sub || !contract) return;
  const url = `https://${sub}.g.alchemy.com/v2/${alchemyKey}`;

  const last = await pgPool.query(`SELECT MAX(block_number) AS b FROM collection_transfers WHERE collection_slug=$1`, [slug]);
  const fromBlock = last.rows[0].b != null ? '0x' + Number(last.rows[0].b).toString(16) : '0x0';

  let pageKey = null, pages = 0, inserted = 0, reachedTip = false;
  while(pages < MAX_PAGES_PER_RUN){
    const result = await alchemyPage(url, {
      fromBlock, toBlock: 'latest', contractAddresses: [contract],
      category: ['erc721', 'erc1155'], withMetadata: true, excludeZeroValue: false,
      maxCount: '0x3e8', order: 'asc', ...(pageKey ? { pageKey } : {}),
    });
    const rows = [];
    for(const t of (result.transfers || [])){
      const tokenId = parseTokenId(t);
      if(tokenId == null || !t.uniqueId) continue;
      rows.push([
        t.uniqueId, tokenId,
        (t.from || '').toLowerCase(), (t.to || '').toLowerCase(),
        t.blockNum ? parseInt(t.blockNum, 16) : null,
        (t.metadata && t.metadata.blockTimestamp) || null,
        t.hash || null,
      ]);
    }
    if(rows.length){
      const cols = [[], [], [], [], [], [], []];
      for(const r of rows) r.forEach((v, i) => cols[i].push(v));
      const res = await pgPool.query(
        `INSERT INTO collection_transfers (collection_slug, unique_id, token_id, from_address, to_address, block_number, ts, tx_hash)
         SELECT $1, * FROM UNNEST($2::text[], $3::bigint[], $4::text[], $5::text[], $6::bigint[], $7::timestamptz[], $8::text[])
         ON CONFLICT DO NOTHING`,
        [slug, ...cols]);
      inserted += res.rowCount || 0;
      // Watched-wallet alerts for fresh moves (notifyWalletMoves ignores
      // anything older than 30 min, so the first backfill never alerts).
      try{
        require('./push').notifyWalletMoves(slug, rows.map(r => ({
          tokenId: r[1], from: r[2], to: r[3], tx: (r[6] || '').toLowerCase(), ts: r[5] ? Date.parse(r[5]) : null })));
      }catch(e){ console.warn('[collection-transfers] push hook:', e.message); }
    }
    pages++;
    pageKey = result.pageKey || null;
    if(!pageKey){ reachedTip = true; break; }
    await new Promise(r => setTimeout(r, 150));
  }
  if(reachedTip){
    await pgPool.query(`INSERT INTO bot_state (key, value) VALUES ($1,'1') ON CONFLICT (key) DO UPDATE SET value='1'`, [`ctx_complete:${slug}`]);
  }
  if(inserted || pages > 1) console.log(`[collection-transfers] ${slug}: +${inserted} transfers over ${pages} page(s)${reachedTip ? '' : ' (more to fetch next run)'}`);
}

async function syncAllCollectionTransfers(){
  if(_running) return;
  _running = true;
  try{
    const key = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
    if(!key) return;
    await ensureTable();
    const res = await pgPool.query(`SELECT slug, contract, chain FROM collections WHERE status='ready' AND contract IS NOT NULL`);
    for(const col of res.rows){
      await syncCollectionTransfers(col, key).catch(e => console.warn(`[collection-transfers] ${col.slug} failed:`, e.message));
    }
  }finally{ _running = false; }
}

function startCollectionTransferSync(){
  setTimeout(() => syncAllCollectionTransfers().catch(e => console.error('[collection-transfers] initial run failed:', e.message)), 60_000);
  setInterval(() => syncAllCollectionTransfers().catch(e => console.error('[collection-transfers] run failed:', e.message)), INTERVAL_MS);
  console.log('[collection-transfers] started');
}

module.exports = { startCollectionTransferSync, syncAllCollectionTransfers, syncCollectionTransfers, ensureTable };
