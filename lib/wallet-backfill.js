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

const _syncLocks = new Set(); // prevent duplicate concurrent syncs
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
  // Drop old unique constraints that block multi-collection inserts
  await pgPool.query(`ALTER TABLE wallet_token_intervals DROP CONSTRAINT IF EXISTS wallet_token_intervals_wallet_token_unique`).catch(()=>{});
  await pgPool.query(`ALTER TABLE wallet_token_intervals DROP CONSTRAINT IF EXISTS wti_wallet_token_acq_unique`).catch(()=>{});
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
          logIndex: (() => {
            const raw = t.logIndex ?? t.log_index ?? t.rawContract?.logIndex ?? t.rawContract?.log_index;
            if (raw == null) return null;
            const n = typeof raw === 'number'
              ? raw
              : parseInt(String(raw), String(raw).startsWith('0x') ? 16 : 10);
            return Number.isFinite(n) ? n : null;
          })(),
        });
      }

      pageKey = result.pageKey || null;
      if (!pageKey) break;
      page++;
    }
  }

  return transfers;
}

// ── Enrich cost basis from sales table + OpenSea per-token sale history ──────────
// Priority: 1) sales table (already cached), 2) OpenSea API (fetch + cache), 3) skip
async function enrichCostBasis(wallet, slug, pgPool, openSeaKey) {
  wallet = wallet.toLowerCase();

  // Get all tokens that need cost basis (cost_eth = 0, regardless of held/sold status)
  let tokens;
  try {
    const res = await pgPool.query(
      `SELECT DISTINCT token_id
       FROM wallet_token_intervals
       WHERE wallet_address=$1 AND collection_slug=$2
       AND (cost_eth IS NULL OR cost_eth = 0)`,
      [wallet, slug]
    );
    tokens = res.rows.map(r => parseInt(r.token_id));
    console.log(`[CostBasis] ${wallet.slice(0,8)} (${slug}): ${tokens.length} tokens need cost basis`);
  } catch(e) {
    console.warn(`[CostBasis] query failed for ${slug}: ${e.message}`);
    return;
  }

  if(!tokens.length) {
    console.log(`[CostBasis] All tokens already have cost basis for ${slug}`);
    return;
  }

  console.log(`[CostBasis] Enriching cost basis for ${tokens.length} token(s) in ${slug}`);
  let enriched = 0;

  for(const tokenId of tokens) {
    try {
      // 1. Check sales table first (free, already cached)
      const cached = await pgPool.query(
        `SELECT price_eth FROM sales
         WHERE token_id=$1 AND collection_slug=$2 AND LOWER(buyer)=$3
         ORDER BY sale_ts DESC`,
        [tokenId, slug, wallet]
      );

      let priceEth = null;

      if(cached.rows.length) {
        // Found in DB — use it directly
        priceEth = parseFloat(cached.rows[0].price_eth);
        console.log(`[CostBasis] token ${tokenId} (${slug}): Ξ${priceEth} from DB cache`);
      } else if(openSeaKey) {
        // 2. Not in DB — fetch from OpenSea and cache result
        await new Promise(r => setTimeout(r, 200)); // rate limit buffer

        const qs = new URLSearchParams({
          event_type: 'sale',
          token_ids: tokenId.toString(),
        }).toString();

        const res = await fetch(
          `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?${qs}`,
          { headers: { 'X-API-KEY': openSeaKey, 'Accept': 'application/json' } }
        );

        if(!res.ok) {
          console.warn(`[CostBasis] OpenSea ${res.status} for token ${tokenId}`);
          continue;
        }

        const data = await res.json();
        const events = data?.asset_events || [];

        // Cache all sale events for this token to benefit other wallets
        for(const ev of events) {
          const buyer = (ev?.buyer || '').toLowerCase();
          const seller = (ev?.seller || '').toLowerCase();
          const priceWei = ev?.payment?.quantity || ev?.total_price;
          if(!priceWei) continue;
          const price = parseFloat(priceWei) / 1e18;
          if(isNaN(price) || price <= 0) continue;
          const saleTs = ev?.closing_date
            ? new Date(ev.closing_date * 1000).toISOString()
            : ev?.event_timestamp || new Date().toISOString();
          const txHash = ev?.transaction || null;

          // Write to sales table as cache (skip if already exists)
          await pgPool.query(
            `INSERT INTO sales (token_id, price_eth, currency, buyer, seller, sale_ts, tx_hash, collection_slug)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (token_id, sale_ts, collection_slug) DO NOTHING`,
            [tokenId, price, ev?.payment?.symbol || 'ETH', buyer, seller, saleTs, txHash, slug]
          ).catch(()=>{});

          // If this wallet was the buyer, that's our cost basis
          if(buyer === wallet && !priceEth) {
            priceEth = price;
            console.log(`[CostBasis] token ${tokenId} (${slug}): Ξ${priceEth} from OpenSea`);
          }
        }
      }

      // 3. Update cost_eth in wallet_token_intervals
      if(priceEth && priceEth > 0) {
        await pgPool.query(
          `UPDATE wallet_token_intervals SET cost_eth=$1
           WHERE wallet_address=$2 AND token_id=$3 AND collection_slug=$4`,
          [priceEth, wallet, tokenId, slug]
        );
        enriched++;
      }
    } catch(e) {
      console.warn(`[CostBasis] failed for token ${tokenId} (${slug}): ${e.message}`);
    }
  }

  console.log(`[CostBasis] Enriched ${enriched}/${tokens.length} tokens for ${slug}`);
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

  // Load truly burned token IDs from burn_event_inputs (OCAS-specific)
  // These are tokens that were consumed — NOT survivors
  let trulyBurnedIds = new Set();
  try {
    const burnRes = await pgPool.query(
      `SELECT bei.burned_token_id
       FROM burn_event_inputs bei
       JOIN burn_events be ON be.id = bei.burn_event_id
       WHERE be.burner_wallet = $1`,
      [wallet]
    );
    trulyBurnedIds = new Set(burnRes.rows.map(r => parseInt(r.burned_token_id)));
    if(trulyBurnedIds.size) console.log(`[deriveIntervals] ${wallet.slice(0,8)} (${slug}): ${trulyBurnedIds.size} truly burned token IDs from DB`);
  } catch(e) {
    console.warn('[deriveIntervals] burn_event_inputs lookup failed (non-fatal):', e.message);
  }

  // Known burn destinations for collections without burn_event_inputs data
  const BURN_ADDRS = new Set([
    '0x1095c73c337cc5e03f9e1d426c524cc3e32a50f6', // ocas burn contract
    '0x000000000000000000000000000000000000dead', // standard burn
    '0x0000000000000000000000000000000000000000', // zero address
  ]);

  const open        = new Map(); // tokenId -> { acquired_at, cost_eth }
  const pendingBurn = new Map(); // tokenId -> { interval } — sent to burn contract, awaiting verdict
  const intervals   = [];

  for (const row of res.rows) {
    const tokenId  = parseInt(row.token_id);
    const toAddr   = (row.to_address || '').toLowerCase();
    const fromAddr = (row.from_address || '').toLowerCase();
    const isReceive = toAddr === wallet;
    const isBurn    = fromAddr === wallet && BURN_ADDRS.has(toAddr) && (trulyBurnedIds.size === 0 || trulyBurnedIds.has(tokenId));
    const isSend    = fromAddr === wallet && !isBurn;

    if (isReceive) {
      if (pendingBurn.has(tokenId)) {
        // Token came back from burn contract — it's a survivor, restore to held
        const prev = pendingBurn.get(tokenId);
        open.set(tokenId, prev.entry); // restore original acquisition
        pendingBurn.delete(tokenId);
      } else {
        // Normal receive — new acquisition
        const costEth = parseFloat(row.value_eth || 0);
        open.set(tokenId, { acquired_at: row.transferred_at, cost_eth: costEth });
      }
    } else if (isBurn && open.has(tokenId)) {
      // Sent to burn contract — park in pendingBurn, wait to see if it comes back
      const entry = open.get(tokenId);
      pendingBurn.set(tokenId, { entry, sent_at: row.transferred_at });
      open.delete(tokenId);
    } else if (isSend && open.has(tokenId)) {
      // Normal secondary market sale
      const entry = open.get(tokenId);
      intervals.push({ ...entry, token_id: tokenId, disposed_at: row.transferred_at, sale_eth: parseFloat(row.value_eth || 0), is_burn: false });
      open.delete(tokenId);
    }
  }

  // Whatever remains in pendingBurn never came back — truly burned
  for (const [tokenId, { entry, sent_at }] of pendingBurn.entries()) {
    intervals.push({ ...entry, token_id: tokenId, disposed_at: sent_at, sale_eth: null, is_burn: true });
  }
  // Still in open = currently held
  for (const [tokenId, interval] of open.entries()) {
    intervals.push({ ...interval, token_id: tokenId, disposed_at: null, sale_eth: null, is_burn: false });
  }

  // Delete then re-insert — avoids all constraint issues
  await pgPool.query(`DELETE FROM wallet_token_intervals WHERE wallet_address=$1 AND collection_slug=$2`, [wallet, slug]).catch(()=>{});

  for (const iv of intervals) {
    try {
      await pgPool.query(
        `INSERT INTO wallet_token_intervals (wallet_address, token_id, acquired_at, disposed_at, cost_eth, sale_eth, collection_slug)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [wallet, iv.token_id, iv.acquired_at, iv.disposed_at, iv.cost_eth, iv.is_burn ? null : iv.sale_eth, slug]
      );
    } catch(e) {
      console.warn(`[deriveIntervals] INSERT failed token ${iv.token_id} (${slug}): ${e.message}`);
    }
  }

  const held   = intervals.filter(i => !i.disposed_at).length;
  const sold   = intervals.filter(i => i.disposed_at && !i.is_burn).length;
  const burned = intervals.filter(i => i.is_burn).length;
  console.log(`[WalletBackfill] ${wallet} (${slug}): ${held} held, ${sold} sold, ${burned} burned`);
  return { held, sold, burned };
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
  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    if (!t.tokenId) continue;
    // Use a real log index when Alchemy provides one. If it does not,
    // use a stable per-sync fallback index so multi-token transfers in
    // one tx do not collide on the legacy (tx_hash, log_index) constraint.
    try {
      const hash = t.hash || null;
      const txKey = hash || `${contract}:${slug}:${t.tokenId}:${i}`;
      const fromAddr = t.from || "";
      const toAddr = t.to || "";
      const logIndex = Number.isFinite(t.logIndex) ? t.logIndex : i;
      const sql = "INSERT INTO nft_transfers (contract, token_id, from_address, to_address, tx_hash, log_index, block_number, value_eth, transferred_at, collection_slug) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE NOT EXISTS (SELECT 1 FROM nft_transfers WHERE tx_hash=$5 AND log_index=$6)";
      const params = [contract, t.tokenId, fromAddr, toAddr, txKey, logIndex, t.blockNum || 0, t.valueEth || 0, t.timestamp || null, slug];
      const result = await pgPool.query(sql, params);
      if (result.rowCount > 0) written++;
    } catch(e) {
      console.warn(`[WalletBackfill] INSERT failed for token ${t.tokenId} (${slug}): ${e.message}`);
    }
  }
  console.log(`[WalletBackfill] Wrote ${written}/${transfers.length} transfers for ${slug}`);

  // Derive intervals first (creates wallet_token_intervals rows with cost_eth=0)
  const intervals = await deriveIntervals(wallet, slug, pgPool).catch(e => {
    console.error(`[WalletBackfill] deriveIntervals failed for ${slug}: ${e.message}`);
    return { held: 0, sold: 0 };
  });

  // Then enrich cost basis on the freshly created intervals rows
  await enrichCostBasis(wallet, slug, pgPool, process.env.OPENSEA_KEY).catch(e => {
    console.warn(`[WalletBackfill] enrichCostBasis failed for ${slug}: ${e.message}`);
  });

  return intervals;
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
  const _lockKey = `sync:${discordId}:${guildId}`;
  if (_syncLocks.has(_lockKey)) {
    console.log(`[WalletSync] Skipping duplicate — already syncing discord=${discordId}`);
    return { ok: false, error: 'already_syncing' };
  }
  _syncLocks.add(_lockKey);
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
        const result = await backfillWallet(wallet, pgPool, alchemyKey, col.contract, col.slug);
        const heldCount = result?.held || 0;
        console.log(`[SyncWallet] ${col.slug}: ${heldCount} held after backfill`);

        await pgPool.query(
          `UPDATE wallet_sync_status SET status='done', completed_at=NOW(), token_count=$3
           WHERE discord_id=$1 AND wallet=$2 AND slug=$4`,
          [discordId, wallet, heldCount, col.slug]
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
