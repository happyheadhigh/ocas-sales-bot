'use strict';

// ── Stackers analytics snapshot job ───────────────────────────────────────────
// Iterates every known Stacker token, reads its current on-chain state, and
// aggregates: tier distribution, active count, chosen-asset popularity, and
// total vault value per asset.
//
// None of the three Stackers contracts expose collection-wide totals
// directly — every read is per-token, so getting an aggregate picture means
// actually reading every token. Takes real time for a collection this size
// (one eth_call round-trip per token, with a small gap between each —
// deliberately gentle rather than firing thousands of calls at once).
//
// Checkpoints its progress periodically (every 500 tokens) rather than only
// writing once at the very end. Confirmed live: a bot restart mid-run
// (which happens often in this environment — any redeploy kills whatever's
// in flight) previously meant losing all progress and writing nothing at
// all, even after 500+ tokens had already been successfully processed. Now
// a single row gets created immediately and updated in place as progress is
// made — a restart at worst loses the last partial batch, not the whole
// run. tokens_processed vs total_tokens tells callers whether a given row
// represents a complete picture or a checkpoint from an interrupted run;
// callers must check this and label accordingly.

const { getStackerInfo, STACKERS_SLUG } = require('./stackers');

const SNAPSHOT_DELAY_MS  = 150; // raised from 50 after a live run hit a brief rate-limit cluster — this account's throughput has proven tighter than typical across several pollers tonight, not just this one
const CHECKPOINT_EVERY   = 500;

async function takeStackersSnapshot(pgPool){
  const { rows } = await pgPool.query(
    `SELECT id FROM tokens WHERE collection_slug = $1 ORDER BY id`, [STACKERS_SLUG]
  );
  const totalTokens = rows.length;
  console.log(`[StackersAnalytics] Starting snapshot for ${totalTokens} tokens`);

  let activeTokens = 0;
  let totalWeight = 0n;
  const tierDistribution = {}; // { "1": count, "2": count, ... } — 1-indexed to match formatStackersFields' display, "0" = not yet tiered
  const assetPopularity  = {}; // { "AAPLx": count, ... } — how many tokens have this asset anywhere in their split
  const vaultTotals      = {}; // { "AAPLx": "1234.5678", ... } — summed across all tokens

  const insertRes = await pgPool.query(
    `INSERT INTO stackers_snapshots (total_tokens, tokens_processed, active_tokens, total_weight, tier_distribution, asset_popularity, vault_totals)
     VALUES ($1, 0, 0, '0', '{}', '{}', '{}') RETURNING id`,
    [totalTokens]
  );
  const snapshotId = insertRes.rows[0].id;

  let processed = 0, failed = 0;

  const checkpoint = async () => {
    await pgPool.query(
      `UPDATE stackers_snapshots
       SET tokens_processed=$2, active_tokens=$3, total_weight=$4, tier_distribution=$5, asset_popularity=$6, vault_totals=$7
       WHERE id=$1`,
      [snapshotId, processed, activeTokens, totalWeight.toString(), JSON.stringify(tierDistribution), JSON.stringify(assetPopularity), JSON.stringify(vaultTotals)]
    ).catch(e => console.warn('[StackersAnalytics] Checkpoint save failed:', e.message));
  };

  for(const { id: tokenId } of rows){
    try{
      const info = await getStackerInfo(tokenId);
      if(info.isActive) activeTokens++;

      if(info.tier){
        const tierLabel = String(info.tier.index + 1);
        tierDistribution[tierLabel] = (tierDistribution[tierLabel] || 0) + 1;
        totalWeight += info.tier.weight.raw; // summed as the raw on-chain value — the guessed-multiplier conversion happens only at display time, not baked into stored data
      } else {
        tierDistribution['0'] = (tierDistribution['0'] || 0) + 1;
      }

      for(const s of info.split){
        assetPopularity[s.symbol] = (assetPopularity[s.symbol] || 0) + 1;
      }

      for(const b of info.balances){
        const current = parseFloat(vaultTotals[b.symbol] || '0');
        vaultTotals[b.symbol] = (current + parseFloat(b.amountFormatted)).toString();
      }

      processed++;
    }catch(e){
      failed++;
      if(failed <= 5) console.warn(`[StackersAnalytics] Token ${tokenId} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, SNAPSHOT_DELAY_MS));

    if(processed > 0 && processed % CHECKPOINT_EVERY === 0){
      console.log(`[StackersAnalytics] ${processed}/${totalTokens} processed so far`);
      await checkpoint();
    }
  }

  await checkpoint(); // final write — captures whatever's been done since the last periodic checkpoint too

  console.log(`[StackersAnalytics] Snapshot complete: ${processed} processed, ${failed} failed, ${activeTokens} active`);

  return { totalTokens, activeTokens, processed, failed };
}

// Fetches the most recent snapshot (complete or partial — callers must
// check tokens_processed vs total_tokens and label accordingly), and — if
// a COMPLETE historical snapshot exists from roughly 24h earlier — a
// comparison point for computing an honest "at today's rate" figure. Only
// ever compares against complete snapshots specifically; a rate computed
// against partial data would be misleading, not just imprecise. Returns
// null for the comparison if no complete-enough history exists yet — there
// is no way around needing real elapsed time (and real completed runs) for
// that specific number.
async function getLatestSnapshotWithComparison(pgPool){
  const latestRes = await pgPool.query(
    `SELECT * FROM stackers_snapshots ORDER BY snapshot_at DESC LIMIT 1`
  );
  if(!latestRes.rows.length) return { latest: null, comparison: null };
  const latest = latestRes.rows[0];

  const comparisonRes = await pgPool.query(
    `SELECT * FROM stackers_snapshots
     WHERE snapshot_at <= $1::timestamptz - INTERVAL '18 hours'
       AND snapshot_at >= $1::timestamptz - INTERVAL '30 hours'
       AND tokens_processed = total_tokens
     ORDER BY snapshot_at DESC LIMIT 1`,
    [latest.snapshot_at]
  );
  return { latest, comparison: comparisonRes.rows[0] || null };
}

module.exports = { takeStackersSnapshot, getLatestSnapshotWithComparison, takeLiveVaultSnapshot, getVaultAccrualComparison, recordRoundSettled, getRecentRoundHistory };

// ── Round history — real pot/weight data from RoundSettled ─────────────────────
// Records the actual, ground-truth pot size and total collection weight from
// each hourly round, straight from the RoundSettled event
// (lib/stackers-live-events.js). This is what a real earnings estimate needs
// to be grounded in actual recent data rather than a guessed formula --
// rewards depend entirely on trading volume, which is inherently unknowable
// in advance, but recent real rounds are a reasonable basis for an estimate.

// Idempotent by design (ON CONFLICT DO NOTHING, round_number as primary
// key) -- safe against potential duplicate delivery of the same event,
// e.g. a reconnect-triggered catch-up overlapping with a live event.
async function recordRoundSettled(pgPool, round, pot, totalWeight){
  await pgPool.query(
    `INSERT INTO stackers_round_history (round_number, pot_wei, total_weight, recorded_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (round_number) DO NOTHING`,
    [round.toString(), pot.toString(), totalWeight.toString()]
  );
}

// Recent round history for earnings estimation. Averaging multiple rounds
// smooths out any single hour's volume being unusually high or low --
// trading volume is genuinely volatile hour to hour, so one round alone
// would be a poor basis for an estimate.
async function getRecentRoundHistory(pgPool, hours = 24){
  const res = await pgPool.query(
    `SELECT round_number, pot_wei, total_weight, recorded_at FROM stackers_round_history
     WHERE recorded_at >= NOW() - ($1 || ' hours')::interval
     ORDER BY recorded_at DESC`,
    [hours]
  );
  return res.rows;
}

// ── Lightweight live vault-totals snapshot ─────────────────────────────────────
// A pure aggregation of the already-live stackers_token_status.vault_balances
// data (kept current via the Credited/Claimed live event listeners) -- no
// on-chain reads at all, unlike takeStackersSnapshot above. Cheap enough to
// run frequently (hourly rather than every 24h), giving the accrual
// comparison meaningful data within about an hour instead of needing up to
// 48h for two full sweeps to complete under the old design.
async function takeLiveVaultSnapshot(pgPool){
  const res = await pgPool.query(
    `SELECT elem->>'symbol' AS symbol, SUM((elem->>'amountFormatted')::numeric) AS total
     FROM stackers_token_status, jsonb_array_elements(vault_balances) AS elem
     WHERE vault_balances IS NOT NULL AND jsonb_array_length(vault_balances) > 0
     GROUP BY elem->>'symbol'`
  );

  const vaultTotals = {};
  for(const row of res.rows){
    vaultTotals[row.symbol] = row.total;
  }

  await pgPool.query(
    `INSERT INTO stackers_vault_snapshots (vault_totals, snapshot_at) VALUES ($1, NOW())`,
    [JSON.stringify(vaultTotals)]
  );

  // Prunes anything older than 48h — safely past the 24h window the
  // comparison logic ever looks at, so this never removes anything still
  // in use. Runs on every snapshot rather than a separate schedule; cheap
  // enough that there's no reason to manage it independently, and keeps
  // the table from growing unbounded now that snapshots run every 15
  // minutes instead of hourly.
  await pgPool.query(
    `DELETE FROM stackers_vault_snapshots WHERE snapshot_at < NOW() - INTERVAL '48 hours'`
  ).catch(e => console.warn('[StackersAnalytics] Snapshot prune failed:', e.message));

  console.log(`[StackersAnalytics] Live vault snapshot taken: ${Object.keys(vaultTotals).length} asset(s)`);
  return vaultTotals;
}

// Latest live vault snapshot, plus the oldest one available within the
// last 24h as a comparison point -- grows naturally as more snapshot
// history accumulates (a real, if small, comparison within the first
// couple hours; a full ~24h comparison once that much history exists)
// rather than requiring a fixed wait before showing anything at all.
async function getVaultAccrualComparison(pgPool){
  const latestRes = await pgPool.query(
    `SELECT * FROM stackers_vault_snapshots ORDER BY snapshot_at DESC LIMIT 1`
  );
  if(!latestRes.rows.length) return { latest: null, comparison: null };
  const latest = latestRes.rows[0];

  const comparisonRes = await pgPool.query(
    `SELECT * FROM stackers_vault_snapshots
     WHERE snapshot_at < $1::timestamptz
       AND snapshot_at >= $1::timestamptz - INTERVAL '24 hours'
     ORDER BY snapshot_at ASC LIMIT 1`,
    [latest.snapshot_at]
  );
  return { latest, comparison: comparisonRes.rows[0] || null };
}
