'use strict';

// ── Stackers token-status poller ──────────────────────────────────────────────
// Watches Activated/Deactivated/TierUpgraded (NFT contract) and SplitSet
// (engine contract) events on Robinhood Chain, keeping a per-token cache of
// tier, active status, and split genuinely current — event-driven, not a
// periodic sweep. This exists because tier/active/split all have dedicated
// events unlike vault balance (which changes via hourly accrual and has no
// confirmed event mapping yet, so it still needs the slower full snapshot).
// Structurally mirrors lib/stackers-fusion-poller.js — same cursor-based
// block range polling, same two hard-won fixes from burn-poller.js (a
// safety margin below the reported chain head, and a 10-block chunk cap
// confirmed live for this account).
//
// Efficiency note: Activated/Deactivated update is_active directly from the
// event itself — the event name unambiguously tells us the new status, no
// ambiguity, no extra read needed. TierUpgraded/SplitSet instead trigger a
// follow-up getStackerStatusOnly() read rather than trusting the raw event
// parameters' exact encoding — a small efficiency cost for correctness,
// same caution as not trusting an unverified scaling assumption earlier
// tonight (the tier-weight basis-100-vs-10000 mistake).

const { dbLoad, dbSave } = require('./db');
const { getProvider, getContracts, getStackerStatusOnly } = require('./stackers');

const STATUS_CURSOR_KEY    = 'stackers_status_last_block';
const SAFETY_MARGIN_BLOCKS = 2;
const CHUNK_BLOCKS         = 10;
const FIRST_RUN_LOOKBACK   = 500;

async function upsertActiveOnly(pgPool, tokenId, isActive){
  await pgPool.query(
    `INSERT INTO stackers_token_status (token_id, is_active, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (token_id) DO UPDATE SET is_active=$2, updated_at=NOW()`,
    [tokenId, isActive]
  );
}

async function refreshFullStatus(pgPool, tokenId){
  const status = await getStackerStatusOnly(tokenId);
  await pgPool.query(
    `INSERT INTO stackers_token_status (token_id, tier_index, is_active, split, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (token_id) DO UPDATE SET tier_index=$2, is_active=$3, split=$4, updated_at=NOW()`,
    [tokenId, status.tierIndex, status.isActive, JSON.stringify(status.split)]
  );
}

async function pollTokenStatusEvents(pgPool){
  try{
    const provider = getProvider();
    const { nft, engine } = getContracts();

    const lastBlockRaw = await dbLoad(STATUS_CURSOR_KEY).catch(() => null);
    let fromBlock = lastBlockRaw ? parseInt(lastBlockRaw, 10) + 1 : null;

    const latest = await provider.getBlockNumber();

    if(!fromBlock || !Number.isFinite(fromBlock)){
      fromBlock = Math.max(0, latest - FIRST_RUN_LOOKBACK);
      console.log(`[StackersStatus] No cursor found; starting from latest-${FIRST_RUN_LOOKBACK} (${fromBlock})`);
    }

    const safeLatest = Math.max(0, latest - SAFETY_MARGIN_BLOCKS);
    if(fromBlock > safeLatest) return;

    const chunkTo = Math.min(safeLatest, fromBlock + CHUNK_BLOCKS - 1);

    const [activatedEvents, deactivatedEvents, tierEvents, splitEvents] = await Promise.all([
      nft.queryFilter(nft.filters.Activated(), fromBlock, chunkTo),
      nft.queryFilter(nft.filters.Deactivated(), fromBlock, chunkTo),
      nft.queryFilter(nft.filters.TierUpgraded(), fromBlock, chunkTo),
      engine.queryFilter(engine.filters.SplitSet(), fromBlock, chunkTo),
    ]);

    const totalEvents = activatedEvents.length + deactivatedEvents.length + tierEvents.length + splitEvents.length;
    if(totalEvents){
      console.log(`[StackersStatus] ${totalEvents} status event(s) in blocks ${fromBlock}-${chunkTo}`);
    }

    for(const event of activatedEvents){
      const tokenId = event.args.tokenId.toString();
      await upsertActiveOnly(pgPool, tokenId, true).catch(e =>
        console.warn(`[StackersStatus] Failed to record activation for #${tokenId}:`, e.message)
      );
    }

    for(const event of deactivatedEvents){
      const tokenId = event.args.tokenId.toString();
      await upsertActiveOnly(pgPool, tokenId, false).catch(e =>
        console.warn(`[StackersStatus] Failed to record deactivation for #${tokenId}:`, e.message)
      );
    }

    // Tier and split changes both need a live read to be sure the cache
    // reflects genuinely current, verified data rather than an assumed
    // event-parameter encoding.
    const needsFullRefresh = new Set([
      ...tierEvents.map(e => e.args.tokenId.toString()),
      ...splitEvents.map(e => e.args.tokenId.toString()),
    ]);
    for(const tokenId of needsFullRefresh){
      await refreshFullStatus(pgPool, tokenId).catch(e =>
        console.warn(`[StackersStatus] Failed to refresh full status for #${tokenId}:`, e.message)
      );
    }

    dbSave(STATUS_CURSOR_KEY, String(chunkTo)).catch(e =>
      console.warn('[StackersStatus] Failed to save cursor:', e.message)
    );
  }catch(e){
    console.error('[StackersStatus] Poll error:', e.message);
  }
}

// One-time (or re-runnable) seed for tokens not yet in the cache at all —
// the poller above only tracks changes going forward from whenever it
// first starts; tokens that were already activated/tiered/split before
// that need an initial full read once. Uses getStackerStatusOnly, not the
// full getStackerInfo, deliberately skipping vault balance entirely since
// this seed is specifically about the event-trackable fields. Safe to
// re-run — only touches tokens not already in the cache.
async function backfillTokenStatus(pgPool){
  const { rows } = await pgPool.query(
    `SELECT id FROM tokens WHERE collection_slug = 'stackersxyz' ORDER BY id`
  );
  console.log(`[StackersStatus] Starting backfill for ${rows.length} tokens`);
  let seeded = 0, skipped = 0, failed = 0;
  for(const { id: tokenId } of rows){
    try{
      const existing = await pgPool.query(`SELECT 1 FROM stackers_token_status WHERE token_id = $1`, [tokenId]);
      if(existing.rows.length){ skipped++; continue; }
      await refreshFullStatus(pgPool, tokenId);
      seeded++;
    }catch(e){
      failed++;
      if(failed <= 5) console.warn(`[StackersStatus] Backfill token ${tokenId} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, 150));
    const done = seeded + skipped + failed;
    if(done > 0 && done % 500 === 0){
      console.log(`[StackersStatus] ${done}/${rows.length} processed so far (${seeded} seeded, ${skipped} skipped, ${failed} failed)`);
    }
  }
  console.log(`[StackersStatus] Backfill complete: ${seeded} seeded, ${skipped} skipped, ${failed} failed`);
  return { total: rows.length, seeded, skipped, failed };
}

module.exports = { pollTokenStatusEvents, backfillTokenStatus };
