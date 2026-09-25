'use strict';
/* jv: "There has been some trades on Gondi with argonauts already... I would
   love that integrated into traitview and also integrate Gondi into future
   collections as well if they are supported there" + "what about trades
   that happen on gondi? and past trades and sales"

   Covers every 'ready' Ethereum collection in the collections table
   (Gondi is mainnet-only); collections Gondi doesn't index are skipped, so
   future collections get this automatically.

   SALES: Gondi's listSales covers every marketplace (12,235 Argonauts sales,
   newest pages all OpenSea). OpenSea sales are already synced from OpenSea,
   so only NON-OpenSea sales are written, into the same `sales` table the
   Sale Chart reads, tagged with the marketplace it actually happened on
   (sales.marketplace = 'blur', 'looksrare', ... or 'gondi' for Gondi's own). Duplicates are
   rejected by the existing UNIQUE(tx_hash, token_id).

   TRADES (Gondi P2P "deals", listEvents TRADE_EXECUTED): all stored in
   gondi_trades. A trade that is exactly ONE NFT of this collection on one
   side for only ETH/WETH on the other is effectively a sale (probe: deal
   1104 = #2959 for 1.35 WETH) -> also written to `sales` as
   marketplace 'gondi-trade'. Anything else (NFTs on both sides, e.g.
   #8730 for #935 + #8879 + 20 WETH) has no single price -> gondi_trades only.

   First pass per restart walks full history; later passes only fetch
   activity from the last 2 days (overlap is harmless: inserts are
   idempotent). Every Gondi request has a 15s timeout (lib/gondi-api.js). */
const { pgPool } = require('./db');
const { gondiCollectionIds, gondiSalesPage, gondiEventsPage } = require('./gondi-api');

const INTERVAL_MS = 10 * 60_000;
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ETH  = '0x0000000000000000000000000000000000000000';
const _gondiIdCache = new Map();       // contract(lower) -> id | null
const _fullPassDone = new Set();       // slugs that finished a full-history pass since restart

async function gondiIdFor(contract){
  const k = contract.toLowerCase();
  if(_gondiIdCache.has(k)) return _gondiIdCache.get(k);
  const cols = await gondiCollectionIds(contract);
  const id = cols[0] ? cols[0].id : null;
  _gondiIdCache.set(k, id);
  return id;
}

const weiToEth = w => { try{ return Number(BigInt(w)) / 1e18; }catch(_){ return null; } };
const isOn = (nft, contract) => (nft?.collection?.contractData?.contractAddress || '').toLowerCase() === contract.toLowerCase();

async function syncSales(slug, contract, gondiId, fromTs){
  let after = null, pages = 0, added = 0, seen = 0;
  do{
    const page = await gondiSalesPage(gondiId, fromTs, after, 100);
    pages++;
    for(const { node: n } of (page?.edges || [])){
      seen++;
      if(n.marketPlace === 'MarketPlace.OpenSea') continue;   // already synced from OpenSea
      if(!isOn(n.nft, contract)) continue;
      const tokenId = parseInt(n.nft?.tokenId, 10);
      const price = weiToEth(n.price);
      if(!Number.isFinite(tokenId) || price == null) continue;
      const cur = (n.currencyAddress || '').toLowerCase();
      if(cur !== WETH && cur !== ETH) continue;                // chart is ETH-denominated
      // Tag with where the sale actually HAPPENED (Gondi only indexed it):
      // 'MarketPlace.Blur' -> 'blur'; Gondi's own marketplace (NATIVE) -> 'gondi'.
      const mkRaw = String(n.marketPlace || '').replace(/^MarketPlace\./, '').toLowerCase();
      const mk = (mkRaw === 'native' || mkRaw === 'gondi' || !mkRaw) ? 'gondi' : mkRaw.replace(/_/g, '');
      const r = await pgPool.query(
        `INSERT INTO sales (token_id, price_eth, currency, buyer, seller, sale_ts, tx_hash, collection_slug, marketplace)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [tokenId, price, cur === WETH ? 'WETH' : 'ETH', (n.receiver||'').toLowerCase(), (n.sender||'').toLowerCase(),
         new Date(n.timestamp), n.txHash, slug, mk]
      ).catch(e => { console.warn(`[gondi-activity] ${slug}: sale insert failed ${n.txHash}:`, e.message); return { rowCount: 0 }; });
      added += r.rowCount;
    }
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  }while(after && pages < 400);
  return { pages, seen, added };
}

async function syncTrades(slug, contract, gondiId, fromTs){
  let after = null, pages = 0, stored = 0, asSales = 0;
  do{
    const page = await gondiEventsPage(gondiId, ['TRADE_EXECUTED'], after, 50, fromTs);
    pages++;
    for(const { node: d } of (page?.edges || [])){
      if(d.__typename !== 'Deal' || !d.id) continue;
      const executedAt = d.timestamp || d.updatedDate || d.createdDate;
      const mOurs = (d.makerNfts || []).filter(x => isOn(x, contract));
      const tOurs = (d.takerNfts || []).filter(x => isOn(x, contract));
      // Sale-shaped: exactly one of our NFTs on one side, no NFTs at all on
      // the other, and only ETH/WETH moving the other way.
      const onlyCash = (erc20s, nfts) => (nfts || []).length === 0 && (erc20s || []).length > 0 &&
        (erc20s || []).every(a => [WETH, ETH].includes((a || '').toLowerCase()));
      let sale = null;
      if(mOurs.length === 1 && (d.makerNfts||[]).length === 1 && !(d.makerErc20s||[]).length && onlyCash(d.takerErc20s, d.takerNfts)){
        sale = { tokenId: mOurs[0].tokenId, seller: d.maker, buyer: d.taker, amounts: d.takerErc20sAmounts, cur: d.takerErc20s };
      }else if(tOurs.length === 1 && (d.takerNfts||[]).length === 1 && !(d.takerErc20s||[]).length && onlyCash(d.makerErc20s, d.makerNfts)){
        sale = { tokenId: tOurs[0].tokenId, seller: d.taker, buyer: d.maker, amounts: d.makerErc20sAmounts, cur: d.makerErc20s };
      }
      await pgPool.query(
        `INSERT INTO gondi_trades (deal_id, collection_slug, maker, taker, tx_hash, executed_at, maker_nfts, taker_nfts,
           maker_erc20s, maker_erc20_amounts, taker_erc20s, taker_erc20_amounts, is_sale)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (deal_id, collection_slug) DO UPDATE SET tx_hash = EXCLUDED.tx_hash, executed_at = EXCLUDED.executed_at, is_sale = EXCLUDED.is_sale`,
        [String(d.id), slug, (d.maker||'').toLowerCase(), (d.taker||'').toLowerCase(), d.executedTxHash || null,
         executedAt ? new Date(executedAt) : null,
         JSON.stringify((d.makerNfts||[]).map(x => ({ tokenId: String(x.tokenId), contract: x.collection?.contractData?.contractAddress || null }))),
         JSON.stringify((d.takerNfts||[]).map(x => ({ tokenId: String(x.tokenId), contract: x.collection?.contractData?.contractAddress || null }))),
         JSON.stringify(d.makerErc20s||[]), JSON.stringify(d.makerErc20sAmounts||[]),
         JSON.stringify(d.takerErc20s||[]), JSON.stringify(d.takerErc20sAmounts||[]), !!sale]
      ).then(() => stored++).catch(e => console.warn(`[gondi-activity] ${slug}: trade upsert failed ${d.id}:`, e.message));
      if(sale && d.executedTxHash && executedAt){
        const total = (sale.amounts || []).reduce((s, a) => s + (weiToEth(a) || 0), 0);
        const cur = (sale.cur || []).map(a => (a||'').toLowerCase()).includes(WETH) ? 'WETH' : 'ETH';
        const r = await pgPool.query(
          `INSERT INTO sales (token_id, price_eth, currency, buyer, seller, sale_ts, tx_hash, collection_slug, marketplace)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'gondi-trade') ON CONFLICT DO NOTHING`,
          [parseInt(sale.tokenId, 10), total, cur, (sale.buyer||'').toLowerCase(), (sale.seller||'').toLowerCase(),
           new Date(executedAt), d.executedTxHash, slug]
        ).catch(e => { console.warn(`[gondi-activity] ${slug}: trade-sale insert failed ${d.id}:`, e.message); return { rowCount: 0 }; });
        asSales += r.rowCount;
      }
    }
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  }while(after && pages < 100);
  return { pages, stored, asSales };
}

async function syncGondiActivityForCollection(slug, contract){
  const gondiId = await gondiIdFor(contract);
  if(gondiId == null) return; // not on Gondi -- nothing to do
  const full = !_fullPassDone.has(slug);
  const fromTs = full ? null : Math.floor(Date.now() / 1000) - 2 * 86400;
  try{
    const s = await syncSales(slug, contract, gondiId, fromTs);
    const t = await syncTrades(slug, contract, gondiId, fromTs);
    if(full) _fullPassDone.add(slug);
    console.log(`[gondi-activity] ${slug}${full ? ' (full history)' : ''}: sales seen ${s.seen}, non-OpenSea added ${s.added}; trades stored ${t.stored}, as sales ${t.asSales}`);
  }catch(e){
    console.warn(`[gondi-activity] ${slug}: sync failed:`, e.message);
  }
}

async function syncAllGondiActivity(){
  let rows = [];
  try{
    rows = (await pgPool.query(`SELECT slug, contract FROM collections WHERE status = 'ready' AND COALESCE(chain,'ethereum') = 'ethereum'`)).rows;
  }catch(e){ console.warn('[gondi-activity] collections query failed:', e.message); }
  // Argonauts predates the collections table on some deployments; always include it.
  if(!rows.some(r => r.slug === 'argonauts')) rows.push({ slug: 'argonauts', contract: '0x387C41B0B2F1128dE44dB1Bcf8baad085f26392C' });
  for(const r of rows){
    if(r.contract) await syncGondiActivityForCollection(r.slug, r.contract);
  }
}

let _running = false;
function startGondiActivitySync(){
  const run = async () => {
    if(_running) return; _running = true;
    try{ await syncAllGondiActivity(); } finally { _running = false; }
  };
  setTimeout(run, 20_000); // let startup settle first
  setInterval(run, INTERVAL_MS);
  console.log(`[gondi-activity] started (interval=${INTERVAL_MS}ms)`);
}

module.exports = { startGondiActivitySync, syncAllGondiActivity, syncGondiActivityForCollection };
