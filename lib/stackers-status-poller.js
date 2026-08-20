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
const { getProvider, getContracts, getStackerStatusOnly, getStackerInfo } = require('./stackers');
const { AdaptiveChunkSizer, looksLikeRangeError } = require('./adaptive-block-chunk');

const STATUS_CURSOR_KEY    = 'stackers_status_last_block';
const SAFETY_MARGIN_BLOCKS = 2;
// Adaptive now — see lib/adaptive-block-chunk.js. Separate sizer instance
// from the fusion poller's since this makes 4 queries per chunk instead of
// 1 (see MAX_CHUNKS_PER_CYCLE note below) and could plausibly hit a
// different practical ceiling even on the same account/network.
const chunkSizer = new AdaptiveChunkSizer({ initial: 2000, floor: 10, label: 'StackersStatus' });
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

// Refreshes vault balance specifically — triggered by the live Credited/
// Claimed events (lib/stackers-live-events.js). Deliberately re-reads the
// real balance via getStackerInfo rather than trusting either event's own
// "amount" field as the new total — genuinely unconfirmed whether that
// field represents a delta or an absolute value, and a live, targeted read
// sidesteps that ambiguity entirely rather than guessing at it.
async function refreshVaultBalance(pgPool, tokenId){
  const info = await getStackerInfo(tokenId);
  // Same BigInt-stripping already applied to stackers_vault_listings
  // earlier tonight — amountRaw is a native BigInt from ethers.js and
  // JSON.stringify cannot serialize it at all, throwing outright. Nothing
  // downstream needs the raw value, only amountFormatted for display.
  const displayBalances = info.balances.map(b => ({ symbol: b.symbol, amountFormatted: b.amountFormatted }));
  await pgPool.query(
    `INSERT INTO stackers_token_status (token_id, vault_balances, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (token_id) DO UPDATE SET vault_balances=$2, updated_at=NOW()`,
    [tokenId, JSON.stringify(displayBalances)]
  );
}

async function pollTokenStatusEvents(pgPool, maxChunksOverride){
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

    // Loops through multiple chunks per invocation rather than just one —
    // this chain produces blocks fast enough (confirmed ~598/minute) that
    // processing only one small chunk per 60-second cycle meant falling
    // permanently behind, never catching up. Capped at a moderate number
    // of chunks rather than full real-time parity (4 queries per chunk) —
    // given this exact account's confirmed rate-limit sensitivity earlier
    // tonight, staying meaningfully behind full real-time is a safer
    // tradeoff than risking another incident. Chunk size itself is
    // adaptive now — see chunkSizer above.
    const MAX_CHUNKS_PER_CYCLE = maxChunksOverride || 30;
    let cursor = fromBlock;
    let chunksProcessed = 0;
    let totalEvents = 0;

    while(cursor <= safeLatest && chunksProcessed < MAX_CHUNKS_PER_CYCLE){
      const chunkTo = Math.min(safeLatest, cursor + chunkSizer.size - 1);

      let activatedEvents, deactivatedEvents, tierEvents, splitEvents;
      try{
        [activatedEvents, deactivatedEvents, tierEvents, splitEvents] = await Promise.all([
          nft.queryFilter(nft.filters.Activated(), cursor, chunkTo),
          nft.queryFilter(nft.filters.Deactivated(), cursor, chunkTo),
          nft.queryFilter(nft.filters.TierUpgraded(), cursor, chunkTo),
          engine.queryFilter(engine.filters.SplitSet(), cursor, chunkTo),
        ]);
      }catch(e){
        if(looksLikeRangeError(e) && chunkSizer.shrink()){
          continue; // retry this same cursor position at the new, smaller size
        }
        throw e; // not a range issue (or already at floor) — surface it like before
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
      const needsFullRefresh = new Set([
        ...tierEvents.map(e => e.args.tokenId.toString()),
        ...splitEvents.map(e => e.args.tokenId.toString()),
      ]);
      for(const tokenId of needsFullRefresh){
        await refreshFullStatus(pgPool, tokenId).catch(e =>
          console.warn(`[StackersStatus] Failed to refresh full status for #${tokenId}:`, e.message)
        );
      }

      totalEvents += activatedEvents.length + deactivatedEvents.length + tierEvents.length + splitEvents.length;
      dbSave(STATUS_CURSOR_KEY, String(chunkTo)).catch(e =>
        console.warn('[StackersStatus] Failed to save cursor:', e.message)
      );

      cursor = chunkTo + 1;
      chunksProcessed++;
    }

    if(totalEvents){
      console.log(`[StackersStatus] ${totalEvents} status event(s) across ${chunksProcessed} chunk(s), now at block ${cursor - 1}`);
    }
    const blocksBehind = safeLatest - (cursor - 1);
    if(blocksBehind > MAX_CHUNKS_PER_CYCLE * chunkSizer.size){
      console.log(`[StackersStatus] Still catching up — ~${blocksBehind} blocks behind, will continue next cycle`);
    }
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
async function backfillTokenStatus(pgPool, force = false){
  const { rows } = await pgPool.query(
    `SELECT id FROM tokens WHERE collection_slug = 'stackersxyz' ORDER BY id`
  );
  console.log(`[StackersStatus] Starting backfill for ${rows.length} tokens${force ? ' (force mode -- overwriting existing rows)' : ''}`);
  let seeded = 0, skipped = 0, failed = 0;
  for(const { id: tokenId } of rows){
    try{
      if(!force){
        const existing = await pgPool.query(`SELECT 1 FROM stackers_token_status WHERE token_id = $1`, [tokenId]);
        if(existing.rows.length){ skipped++; continue; }
      }
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

// One-time (or re-runnable) seed for vault balances specifically — the
// live listener (Credited/Claimed events) only tracks changes going
// forward; tokens with existing vault balance before it first started
// need an initial read once. Kept separate from backfillTokenStatus
// rather than merged into it, since adding the balance read back in would
// slow that function down and defeat the reason it uses
// getStackerStatusOnly (deliberately skipping balances) in the first
// place. Checks vault_balances specifically, not just row existence —
// a token may already have a row from the tier/status backfill without
// vault_balances populated yet.
async function backfillVaultBalances(pgPool, force = false){
  const { rows } = await pgPool.query(
    `SELECT id FROM tokens WHERE collection_slug = 'stackersxyz' ORDER BY id`
  );
  console.log(`[StackersStatus] Starting vault-balance backfill for ${rows.length} tokens${force ? ' (force mode -- overwriting existing rows)' : ''}`);
  let seeded = 0, skipped = 0, failed = 0;
  for(const { id: tokenId } of rows){
    try{
      if(!force){
        const existing = await pgPool.query(`SELECT 1 FROM stackers_token_status WHERE token_id = $1 AND vault_balances IS NOT NULL`, [tokenId]);
        if(existing.rows.length){ skipped++; continue; }
      }
      await refreshVaultBalance(pgPool, tokenId);
      seeded++;
    }catch(e){
      failed++;
      if(failed <= 5) console.warn(`[StackersStatus] Vault-balance backfill token ${tokenId} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, 150));
    const done = seeded + skipped + failed;
    if(done > 0 && done % 500 === 0){
      console.log(`[StackersStatus] Vault-balance backfill: ${done}/${rows.length} processed so far (${seeded} seeded, ${skipped} skipped, ${failed} failed)`);
    }
  }
  console.log(`[StackersStatus] Vault-balance backfill complete: ${seeded} seeded, ${skipped} skipped, ${failed} failed`);
  return { total: rows.length, seeded, skipped, failed };
}

module.exports = { pollTokenStatusEvents, backfillTokenStatus, upsertActiveOnly, refreshFullStatus, refreshVaultBalance, backfillVaultBalances };
