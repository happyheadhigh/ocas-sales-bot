'use strict';
/**
 * lib/wallet-backfill.js
 *
 * One-time (and incremental) wallet transfer backfill using Alchemy.
 * Called when a wallet verifies — fetches full transfer history for the
 * OCAS contract, writes to nft_transfers, then derives wallet_token_intervals.
 *
 * Fire-and-forget: caller does not await. Errors are logged, never thrown.
 */

const fetch = require('node-fetch');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const ALCHEMY_BASE  = `https://eth-mainnet.g.alchemy.com/v2`;

// Fetch all asset transfers for a wallet+contract from Alchemy
// Returns array of { tokenId, from, to, value, blockNum, timestamp, hash }
async function fetchTransfers(wallet, alchemyKey) {
  const url = `${ALCHEMY_BASE}/${alchemyKey}`;
  const transfers = [];

  // Fetch both inbound and outbound transfers
  for (const direction of ['to', 'from']) {
    let pageKey = null;
    let page = 0;
    const MAX_PAGES = 20;

    while (page < MAX_PAGES) {
      const body = {
        id: 1, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers',
        params: [{
          fromBlock: '0x0',
          toBlock: 'latest',
          contractAddresses: [OCAS_CONTRACT],
          category: ['erc721'],
          withMetadata: true,
          excludeZeroValue: false,
          maxCount: '0x3e8', // 1000 per page
          ...(direction === 'to' ? { toAddress: wallet } : { fromAddress: wallet }),
          ...(pageKey ? { pageKey } : {}),
        }],
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        console.warn(`[WalletBackfill] Alchemy HTTP ${res.status} for ${wallet} (${direction})`);
        break;
      }

      const data = await res.json();
      const result = data?.result;
      if (!result) break;

      for (const t of (result.transfers || [])) {
        const tokenId = t.tokenId ? parseInt(t.tokenId, 16) : null;
        if (!tokenId) continue;
        transfers.push({
          tokenId,
          from: (t.from || '').toLowerCase(),
          to: (t.to || '').toLowerCase(),
          valueEth: t.value || 0,
          blockNum: t.blockNum ? parseInt(t.blockNum, 16) : null,
          timestamp: t.metadata?.blockTimestamp || null,
          hash: (t.hash || '').toLowerCase(),
          direction,
        });
      }

      pageKey = result.pageKey || null;
      if (!pageKey) break;
      page++;
    }
  }

  return transfers;
}

// Write transfers to DB and derive wallet_token_intervals
async function backfillWallet(wallet, pgPool, alchemyKey) {
  if (!alchemyKey) {
    console.warn('[WalletBackfill] No ALCHEMY_API_KEY — skipping backfill for', wallet);
    return;
  }

  wallet = wallet.toLowerCase();
  console.log(`[WalletBackfill] Starting backfill for ${wallet}`);

  try {
    // Ensure tables exist
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS nft_transfers (
        id           SERIAL PRIMARY KEY,
        token_id     INT NOT NULL,
        from_address TEXT NOT NULL,
        to_address   TEXT NOT NULL,
        value_eth    NUMERIC(18,8) DEFAULT 0,
        block_number INT,
        transferred_at TIMESTAMPTZ,
        tx_hash      TEXT,
        collection_slug TEXT DEFAULT 'on-chain-all-stars',
        UNIQUE(tx_hash, token_id)
      )
    `).catch(()=>{});

    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS nft_transfers_to_idx ON nft_transfers(to_address)
    `).catch(()=>{});
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS nft_transfers_from_idx ON nft_transfers(from_address)
    `).catch(()=>{});

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS wallet_token_intervals (
        id             SERIAL PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        token_id       INT NOT NULL,
        acquired_at    TIMESTAMPTZ,
        disposed_at    TIMESTAMPTZ,
        cost_eth       NUMERIC(18,8) DEFAULT 0,
        sale_eth       NUMERIC(18,8),
        collection_slug TEXT DEFAULT 'on-chain-all-stars',
        UNIQUE(wallet_address, token_id, acquired_at)
      )
    `).catch(()=>{});

    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS wti_wallet_idx ON wallet_token_intervals(wallet_address)
    `).catch(()=>{});

    // Check if already backfilled
    const existing = await pgPool.query(
      `SELECT COUNT(*) AS cnt FROM nft_transfers WHERE (to_address=$1 OR from_address=$1)`,
      [wallet]
    );
    const alreadyHas = parseInt(existing.rows[0]?.cnt || 0);
    if (alreadyHas > 0) {
      console.log(`[WalletBackfill] ${wallet} already has ${alreadyHas} transfers — skipping full backfill`);
      return;
    }

    const transfers = await fetchTransfers(wallet, alchemyKey);
    console.log(`[WalletBackfill] ${wallet}: fetched ${transfers.length} transfers`);

    if (!transfers.length) return;

    // Upsert transfers
    let written = 0;
    for (const t of transfers) {
      if (!t.hash || !t.tokenId) continue;
      await pgPool.query(
        `INSERT INTO nft_transfers (token_id, from_address, to_address, value_eth, block_number, transferred_at, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tx_hash, token_id) DO NOTHING`,
        [t.tokenId, t.from, t.to, t.valueEth, t.blockNum, t.timestamp, t.hash]
      ).catch(()=>{});
      written++;
    }
    console.log(`[WalletBackfill] ${wallet}: wrote ${written} transfers`);

    // Derive wallet_token_intervals from transfer history
    await deriveIntervals(wallet, pgPool);

  } catch (e) {
    console.error(`[WalletBackfill] Error for ${wallet}:`, e.message);
  }
}

// Rebuild wallet_token_intervals for a wallet from nft_transfers
async function deriveIntervals(wallet, pgPool) {
  wallet = wallet.toLowerCase();

  // Get all transfers involving this wallet, sorted by time
  const res = await pgPool.query(
    `SELECT token_id, from_address, to_address, value_eth, transferred_at
     FROM nft_transfers
     WHERE (to_address=$1 OR from_address=$1)
     ORDER BY transferred_at ASC NULLS LAST, id ASC`,
    [wallet]
  );

  // Track open intervals per token
  const open = new Map(); // tokenId -> { acquired_at, cost_eth }
  const intervals = [];

  for (const row of res.rows) {
    const tokenId = parseInt(row.token_id);
    const isReceive = row.to_address === wallet;
    const isSend    = row.from_address === wallet;

    if (isReceive) {
      // Bought/received
      open.set(tokenId, {
        acquired_at: row.transferred_at,
        cost_eth: parseFloat(row.value_eth || 0),
      });
    } else if (isSend && open.has(tokenId)) {
      // Sold/sent
      const interval = open.get(tokenId);
      intervals.push({
        ...interval,
        token_id: tokenId,
        disposed_at: row.transferred_at,
        sale_eth: parseFloat(row.value_eth || 0),
      });
      open.delete(tokenId);
    }
  }

  // Still-held tokens (no disposal)
  for (const [tokenId, interval] of open.entries()) {
    intervals.push({ ...interval, token_id: tokenId, disposed_at: null, sale_eth: null });
  }

  // Clear existing intervals for this wallet and re-insert
  await pgPool.query(
    `DELETE FROM wallet_token_intervals WHERE wallet_address=$1`, [wallet]
  ).catch(()=>{});

  for (const iv of intervals) {
    await pgPool.query(
      `INSERT INTO wallet_token_intervals (wallet_address, token_id, acquired_at, disposed_at, cost_eth, sale_eth)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (wallet_address, token_id, acquired_at) DO NOTHING`,
      [wallet, iv.token_id, iv.acquired_at, iv.disposed_at, iv.cost_eth, iv.sale_eth]
    ).catch(()=>{});
  }

  const held = intervals.filter(i => !i.disposed_at).length;
  const sold = intervals.filter(i => i.disposed_at).length;
  console.log(`[WalletBackfill] ${wallet}: derived ${held} held, ${sold} sold intervals`);
}

// Update intervals incrementally when a new sale event comes in
// Called from pollSales when a verified wallet sells or buys
async function updateIntervalForTransfer(wallet, tokenId, direction, valueEth, timestamp, pgPool) {
  wallet = wallet.toLowerCase();
  try {
    if (direction === 'receive') {
      await pgPool.query(
        `INSERT INTO wallet_token_intervals (wallet_address, token_id, acquired_at, cost_eth)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (wallet_address, token_id, acquired_at) DO NOTHING`,
        [wallet, tokenId, timestamp, valueEth]
      ).catch(()=>{});
    } else if (direction === 'send') {
      await pgPool.query(
        `UPDATE wallet_token_intervals
         SET disposed_at=$3, sale_eth=$4
         WHERE wallet_address=$1 AND token_id=$2 AND disposed_at IS NULL`,
        [wallet, tokenId, timestamp, valueEth]
      ).catch(()=>{});
    }
  } catch(e) {
    console.warn('[updateIntervalForTransfer]', e.message);
  }
}

module.exports = { backfillWallet, deriveIntervals, updateIntervalForTransfer };
