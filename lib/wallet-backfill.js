'use strict';
/**
 * lib/wallet-backfill.js
 *
 * Wallet transfer backfill using Alchemy alchemy_getAssetTransfers.
 * - backfillWallet(wallet, pgPool, alchemyKey, contract, slug)
 *   One-time fetch of full transfer history for one wallet + contract.
 *   Called on verification (OCAS contract) and when collection is added.
 *
 * - backfillServerWallets(guildId, contract, slug, pgPool, alchemyKey)
 *   Backfills all verified wallets in a server for a new collection.
 *   Skips wallets already backfilled for that contract.
 *
 * - syncWalletForUser(discordId, guildId, pgPool, alchemyKey)
 *   User-triggered re-sync from /me → Wallet → Sync button.
 *   Re-fetches all configured collections for that server.
 *
 * All functions are fire-and-forget safe — never throw.
 */

const fetch = require('node-fetch');

const OCAS_CONTRACT  = '0x078be86f3104a32313a47815792230a3808642cc';
const OCAS_SLUG      = 'on-chain-all-stars';
const ALCHEMY_BASE   = 'https://eth-mainnet.g.alchemy.com/v2';

// ── Ensure tables exist ───────────────────────────────────────────────────────
async function ensureTables(pgPool) {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS nft_transfers (
      id             SERIAL PRIMARY KEY,
      token_id       INT,
      from_address   TEXT,
      to_address     TEXT,
      value_eth      NUMERIC(18,8) DEFAULT 0,
      block_number   INT,
      transferred_at TIMESTAMPTZ,
      tx_hash        TEXT,
      log_index      INT DEFAULT 0,
      collection_slug TEXT DEFAULT 'on-chain-all-stars'
    )
  `).catch(()=>{});
  await pgPool.query(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS token_id INT`).catch(()=>{});
  await pgPool.query(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS from_address TEXT`).catch(()=>{});
  await pgPool.query(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS to_address TEXT`).catch(()=>{});
  await pgPool.query(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS value_eth NUMERIC(18,8) DEFAULT 0`).catch(()=>{});
  await pgPool.query(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS block_number INT`).catch(()=>{});
  await pgPool.query(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ`).catch(()=>{});
  await pgPool.query(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS tx_hash TEXT`).catch(()=>{});
  await pgPool.query(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS log_index INT DEFAULT 0`).catch(()=>{});
  await pgPool.query(`UPDATE nft_transfers SET log_index=0 WHERE log_index IS NULL`).catch(()=>{});
  await pgPool.query(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS collection_slug TEXT DEFAULT 'on-chain-all-stars'`).catch(()=>{});
  await pgPool.query(`UPDATE nft_transfers SET collection_slug='on-chain-all-stars' WHERE collection_slug IS NULL`).catch(()=>{});
  await pgPool.query(`ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS contract TEXT`).catch(()=>{});
  await pgPool.query(`UPDATE nft_transfers SET contract='0x078be86f3104a32313a47815792230a3808642cc' WHERE contract IS NULL`).catch(()=>{});
  await pgPool.query(`CREATE INDEX IF NOT EXISTS nft_transfers_to_idx ON nft_transfers(to_address, collection_slug)`).catch(()=>{});
  await pgPool.query(`CREATE INDEX IF NOT EXISTS nft_transfers_from_idx ON nft_transfers(from_address, collection_slug)`).catch(()=>{});

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS wallet_token_intervals (
      id              SERIAL PRIMARY KEY,
      wallet_address  TEXT,
      token_id        INT,
      acquired_at     TIMESTAMPTZ,
      disposed_at     TIMESTAMPTZ,
      cost_eth        NUMERIC(18,8) DEFAULT 0,
      sale_eth        NUMERIC(18,8),
      collection_slug TEXT DEFAULT 'on-chain-all-stars'
    )
  `).catch(()=>{});
  await pgPool.query(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS wallet_address TEXT`).catch(()=>{});
  await pgPool.query(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS token_id INT`).catch(()=>{});
  await pgPool.query(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS acquired_at TIMESTAMPTZ`).catch(()=>{});
  await pgPool.query(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS disposed_at TIMESTAMPTZ`).catch(()=>{});
  await pgPool.query(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS cost_eth NUMERIC(18,8) DEFAULT 0`).catch(()=>{});
  await pgPool.query(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS sale_eth NUMERIC(18,8)`).catch(()=>{});
  await pgPool.query(`ALTER TABLE wallet_token_intervals ADD COLUMN IF NOT EXISTS collection_slug TEXT DEFAULT 'on-chain-all-stars'`).catch(()=>{});
  await pgPool.query(`UPDATE wallet_token_intervals SET collection_slug='on-chain-all-stars' WHERE collection_slug IS NULL`).catch(()=>{});
  await pgPool.query(`CREATE INDEX IF NOT EXISTS wti_wallet_idx ON wallet_token_intervals(wallet_address, collection_slug)`).catch(()=>{});
}

// ── Fetch all transfers for a wallet+contract from Alchemy ────────────────────
async function fetchTransfers(wallet, contract, alchemyKey) {
  const url = `${ALCHEMY_BASE}/${alchemyKey}`;
  const transfers = [];

  for (const direction of ['to', 'from']) {
    let pageKey = null;
    let page = 0;

    while (page < 20) {
      const body = {
        id: 1, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers',
        params: [{
          fromBlock: '0x0', toBlock: 'latest',
          contractAddresses: [contract],
          category: ['erc721'],
          withMetadata: true,
          excludeZeroValue: false,
          maxCount: '0x3e8',
          ...(direction === 'to' ? { toAddress: wallet } : { fromAddress: wallet }),
          ...(pageKey ? { pageKey } : {}),
        }],
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { console.warn(`[WalletBackfill] Alchemy HTTP ${res.status}`); break; }

      const data = await res.json();
      const result = data?.result;
      if (!result) {
        if(data?.error) console.warn(`[WalletBackfill] Alchemy error for ${wallet}:`, JSON.stringify(data.error));
        else console.warn(`[WalletBackfill] No result for ${wallet} (${direction}), page ${page}`);
        break;
      }
      console.log(`[WalletBackfill] ${wallet} (${direction}) page ${page}: ${result.transfers?.length||0} transfers`);

      for (const t of (result.transfers || [])) {
        const tokenId = t.erc721TokenId ? parseInt(t.erc721TokenId, 16) : (t.tokenId ? parseInt(t.tokenId, 16) : null);
        if (!tokenId) continue;
        transfers.push({
          tokenId,
          from: (t.from || '').toLowerCase(),
          to: (t.to || '').toLowerCase(),
          valueEth: t.value || 0,
          blockNum: t.blockNum ? parseInt(t.blockNum, 16) : null,
          timestamp: t.metadata?.blockTimestamp || null,
          hash: (t.hash || '').toLowerCase(),
        });
      }

      pageKey = result.pageKey || null;
      if (!pageKey) break;
      page++;
    }
  }

  return transfers;
}

// ── Derive wallet_token_intervals from nft_transfers for one wallet+collection ─
async function deriveIntervals(wallet, slug, pgPool) {
  wallet = wallet.toLowerCase();
  const res = await pgPool.query(
    `SELECT token_id, from_address, to_address, value_eth, transferred_at
     FROM nft_transfers
     WHERE (to_address=$1 OR from_address=$1) AND collection_slug=$2
     ORDER BY transferred_at ASC NULLS LAST, id ASC`,
    [wallet, slug]
  );

  const open = new Map();
  const intervals = [];

  for (const row of res.rows) {
    const tokenId   = parseInt(row.token_id);
    const isReceive = row.to_address === wallet;
    const isSend    = row.from_address === wallet;

    if (isReceive) {
      open.set(tokenId, { acquired_at: row.transferred_at, cost_eth: parseFloat(row.value_eth || 0) });
    } else if (isSend && open.has(tokenId)) {
      const interval = open.get(tokenId);
      intervals.push({ ...interval, token_id: tokenId, disposed_at: row.transferred_at, sale_eth: parseFloat(row.value_eth || 0) });
      open.delete(tokenId);
    }
  }
  for (const [tokenId, interval] of open.entries()) {
    intervals.push({ ...interval, token_id: tokenId, disposed_at: null, sale_eth: null });
  }

  await pgPool.query(`DELETE FROM wallet_token_intervals WHERE wallet_address=$1 AND collection_slug=$2`, [wallet, slug]).catch(()=>{});

  for (const iv of intervals) {
    await pgPool.query(
      `INSERT INTO wallet_token_intervals (wallet_address, token_id, acquired_at, disposed_at, cost_eth, sale_eth, collection_slug)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (wallet_address, token_id, acquired_at, collection_slug) DO NOTHING`,
      [wallet, iv.token_id, iv.acquired_at, iv.disposed_at, iv.cost_eth, iv.sale_eth, slug]
    ).catch(()=>{});
  }

  const held = intervals.filter(i => !i.disposed_at).length;
  const sold = intervals.filter(i => i.disposed_at).length;
  console.log(`[WalletBackfill] ${wallet} (${slug}): ${held} held, ${sold} sold`);
  return { held, sold };
}

// ── Backfill one wallet for one contract/slug ─────────────────────────────────
async function backfillWallet(wallet, pgPool, alchemyKey, contract = OCAS_CONTRACT, slug = OCAS_SLUG) {
  if (!alchemyKey) { console.warn('[WalletBackfill] No ALCHEMY_API_KEY'); return; }
  wallet = wallet.toLowerCase();
  contract = contract.toLowerCase();
  console.log(`[WalletBackfill] backfillWallet called: wallet=${wallet.slice(0,8)} slug=${slug}`);

  try { await ensureTables(pgPool); } catch(e) {
    console.warn(`[WalletBackfill] ensureTables failed (non-fatal): ${e.message}`);
  }

  // Skip if already backfilled for this collection
  let alreadyDone = false;
  try {
    const existing = await pgPool.query(
      `SELECT COUNT(*) AS cnt FROM nft_transfers WHERE (to_address=$1 OR from_address=$1) AND collection_slug=$2`,
      [wallet, slug]
    );
    alreadyDone = parseInt(existing.rows[0]?.cnt || 0) > 0;
  } catch(e) {
    console.warn(`[WalletBackfill] Skip-check failed for ${slug} (will proceed with backfill): ${e.message}`);
  }
  if (alreadyDone) {
    console.log(`[WalletBackfill] ${wallet.slice(0,8)} already backfilled for ${slug} — skipping`);
    return;
  }

  console.log(`[WalletBackfill] Starting backfill: wallet=${wallet.slice(0,8)} slug=${slug} contract=${contract.slice(0,8)}`);
  const transfers = await fetchTransfers(wallet, contract, alchemyKey);
  console.log(`[WalletBackfill] ${wallet.slice(0,8)}: ${transfers.length} transfers found for ${slug}`);

  if (!transfers.length) return;

  let written = 0;
  for (const t of transfers) {
    if (!t.tokenId) continue;
    // Use INSERT ... WHERE NOT EXISTS to avoid NULL unique constraint issues
    try {
      const hash = t.hash || null;
      const txKey = hash || String(t.tokenId);
      const fromAddr = t.from || "";
      const toAddr = t.to || "";
      const sql = "INSERT INTO nft_transfers (contract, token_id, from_address, to_address, tx_hash, log_index, block_number, value_eth, transferred_at, collection_slug) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE NOT EXISTS (SELECT 1 FROM nft_transfers WHERE tx_hash=$5 AND token_id=$2 AND contract=$1)";
      const params = [contract, t.tokenId, fromAddr, toAddr, txKey, 0, t.blockNum || 0, t.valueEth || 0, t.timestamp || null, slug];
      const result = await pgPool.query(sql, params);
      if (result.rowCount > 0) written++;
    } catch(e) {
      console.warn(`[WalletBackfill] INSERT failed for token ${t.tokenId} (${slug}): ${e.message}`);
    }
  }
  console.log(`[WalletBackfill] Wrote ${written}/${transfers.length} transfers for ${slug}`);

  await deriveIntervals(wallet, slug, pgPool).catch(e => {
    console.error(`[WalletBackfill] deriveIntervals failed for ${slug}: ${e.message}`);
  });
}

// ── Backfill all verified wallets in a server for a new collection ─────────────
async function backfillServerWallets(guildId, contract, slug, pgPool, alchemyKey) {
  if (!alchemyKey) { console.warn('[WalletBackfill] No ALCHEMY_API_KEY'); return; }
  if (!contract || !slug) return;

  try {
    await ensureTables(pgPool);

    // Get all verified wallets in this server
    const res = await pgPool.query(
      `SELECT DISTINCT wallet FROM user_registrations WHERE guild_id=$1 AND verified=true AND wallet IS NOT NULL`,
      [guildId]
    );

    if (!res.rows.length) {
      console.log(`[WalletBackfill] No verified wallets in guild ${guildId} for ${slug}`);
      return;
    }

    console.log(`[WalletBackfill] Backfilling ${res.rows.length} wallet(s) in guild ${guildId} for ${slug}`);

    for (const row of res.rows) {
      await backfillWallet(row.wallet, pgPool, alchemyKey, contract, slug).catch(e => {
        console.warn(`[WalletBackfill] Failed for ${row.wallet}:`, e.message);
      });
      // Small delay between wallets to avoid hammering Alchemy
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[WalletBackfill] Server backfill complete for ${slug} in guild ${guildId}`);
  } catch (e) {
    console.error('[WalletBackfill] backfillServerWallets error:', e.message);
  }
}

// ── User-triggered re-sync from /me ──────────────────────────────────────────
async function syncWalletForUser(discordId, guildId, pgPool, alchemyKey, getConfig) {
  console.log(`[WalletSync] Starting for discord=${discordId} guild=${guildId} hasAlchemyKey=${!!alchemyKey}`);
  if (!alchemyKey) {
    console.warn('[WalletSync] No Alchemy key — aborting');
    return { error: 'No Alchemy key configured.' };
  }

  try {
    // Get verified wallet for this user
    const reg = await pgPool.query(
      `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND guild_id=$2 AND verified=true LIMIT 1`,
      [discordId, guildId]
    );
    console.log(`[WalletSync] Wallet lookup: ${reg.rows.length} row(s) found`);
    if (!reg.rows.length) {
      // Try global lookup
      const globalReg = await pgPool.query(
        `SELECT wallet, guild_id FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
        [discordId]
      );
      console.log(`[WalletSync] Global wallet lookup: ${globalReg.rows.length} row(s)`);
      if (!globalReg.rows.length) return { error: 'No verified wallet found.' };
      // Use global wallet but log it
      const wallet = globalReg.rows[0].wallet.toLowerCase();
      console.log(`[WalletSync] Using wallet from global lookup: ${wallet.slice(0,8)}... (guild=${globalReg.rows[0].guild_id})`);
      // Continue with this wallet — re-enter with correct data
      return syncWalletForUser(discordId, globalReg.rows[0].guild_id, pgPool, alchemyKey, getConfig);
    }
    const wallet = reg.rows[0].wallet.toLowerCase();
    console.log(`[WalletSync] Using wallet: ${wallet.slice(0,8)}...`);

    // Get all collections configured in this server
    const config = getConfig ? (getConfig(guildId) || {}) : {};
    const collections = [];
    if (config.contract) collections.push({ contract: config.contract, slug: config.collectionSlug || config.slug || OCAS_SLUG, name: config.contractName || config.collectionSlug || config.slug || OCAS_SLUG });
    for (const c of config.collections || []) {
      if (c.contract && c.slug) collections.push({ contract: c.contract, slug: c.slug, name: c.name || c.slug });
    }
    // Always include OCAS
    if (!collections.find(c => c.contract?.toLowerCase() === OCAS_CONTRACT || c.slug === OCAS_SLUG)) {
      collections.push({ contract: OCAS_CONTRACT, slug: OCAS_SLUG, name: 'On-Chain All Stars' });
    }
    // Deduplicate by slug
    const seen = new Set();
    const uniqueCollections = collections.filter(c => {
      if(!c.slug || seen.has(c.slug)) return false;
      seen.add(c.slug);
      return true;
    });
    console.log(`[WalletSync] Collections to sync: ${uniqueCollections.map(c => c.slug).join(', ')}`);

    // Mark all collections as pending in sync status — wrapped in try/catch so it never blocks backfill
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS wallet_sync_status (
          id SERIAL PRIMARY KEY, discord_id TEXT, wallet TEXT, slug TEXT,
          status TEXT DEFAULT 'pending', token_count INT DEFAULT 0,
          started_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ,
          UNIQUE(discord_id, wallet, slug)
        )
      `);
      for (const col of uniqueCollections) {
        await pgPool.query(
          `INSERT INTO wallet_sync_status (discord_id, wallet, slug, status, started_at)
           VALUES ($1,$2,$3,'syncing',NOW())
           ON CONFLICT (discord_id, wallet, slug) DO UPDATE SET status='syncing', started_at=NOW(), completed_at=NULL`,
          [discordId, wallet, col.slug]
        );
      }
      console.log(`[WalletSync] Status table updated for ${uniqueCollections.length} collection(s)`);
    } catch(e) {
      console.warn('[WalletSync] Status table update failed (non-fatal):', e.message);
    }
    // Always include OCAS
    if (!collections.find(c => c.contract === OCAS_CONTRACT)) {
      collections.push({ contract: OCAS_CONTRACT, slug: OCAS_SLUG });
    }

    let synced = 0;
    for (const col of uniqueCollections) {
      try {
        // Force re-backfill
        await pgPool.query(
          `DELETE FROM nft_transfers WHERE (to_address=$1 OR from_address=$1) AND collection_slug=$2`,
          [wallet, col.slug]
        ).catch(()=>{});
        await backfillWallet(wallet, pgPool, alchemyKey, col.contract, col.slug).catch(()=>{});

        // Count tokens held after backfill
        const cnt = await pgPool.query(
          `SELECT COUNT(*) AS n FROM wallet_token_intervals WHERE wallet_address=$1 AND collection_slug=$2 AND disposed_at IS NULL`,
          [wallet, col.slug]
        ).catch(()=>({ rows:[{ n:0 }] }));

        await pgPool.query(
          `UPDATE wallet_sync_status SET status='done', completed_at=NOW(), token_count=$3
           WHERE discord_id=$1 AND wallet=$2 AND slug=$4`,
          [discordId, wallet, parseInt(cnt.rows[0]?.n||0), col.slug]
        ).catch(()=>{});
        synced++;
      } catch(e) {
        await pgPool.query(
          `UPDATE wallet_sync_status SET status='error', completed_at=NOW()
           WHERE discord_id=$1 AND wallet=$2 AND slug=$3`,
          [discordId, wallet, col.slug]
        ).catch(()=>{});
        console.warn(`[SyncWallet] Failed ${col.slug}:`, e.message);
      }
    }

    return { ok: true, wallet, synced, collections: uniqueCollections.map(c => c.slug) };
  } catch (e) {
    console.error('[syncWalletForUser]', e.message);
    return { error: e.message };
  }
}

// ── Incremental update on sale event ─────────────────────────────────────────
async function updateIntervalForTransfer(wallet, tokenId, direction, valueEth, timestamp, slug, pgPool) {
  wallet = wallet.toLowerCase();
  slug = slug || OCAS_SLUG;
  try {
    if (direction === 'receive') {
      await pgPool.query(
        `INSERT INTO wallet_token_intervals (wallet_address, token_id, acquired_at, cost_eth, collection_slug)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (wallet_address, token_id, acquired_at, collection_slug) DO NOTHING`,
        [wallet, tokenId, timestamp, valueEth, slug]
      ).catch(()=>{});
    } else if (direction === 'send') {
      await pgPool.query(
        `UPDATE wallet_token_intervals
         SET disposed_at=$3, sale_eth=$4
         WHERE wallet_address=$1 AND token_id=$2 AND collection_slug=$5 AND disposed_at IS NULL`,
        [wallet, tokenId, timestamp, valueEth, slug]
      ).catch(()=>{});
    }
  } catch(e) { console.warn('[updateIntervalForTransfer]', e.message); }
}

// ── Get sync status for a user ───────────────────────────────────────────────
async function getSyncStatus(discordId, pgPool) {
  try {
    const res = await pgPool.query(
      `SELECT slug, status, token_count, started_at, completed_at
       FROM wallet_sync_status WHERE discord_id=$1
       ORDER BY started_at DESC`,
      [discordId]
    );
    return res.rows;
  } catch(e) { return []; }
}

module.exports = { backfillWallet, backfillServerWallets, syncWalletForUser, updateIntervalForTransfer, deriveIntervals, getSyncStatus };
