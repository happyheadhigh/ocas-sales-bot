'use strict';

// ── Stackers analytics snapshot job ───────────────────────────────────────────
// Iterates every known Stacker token, reads its current on-chain state, and
// aggregates: tier distribution, active count, chosen-asset popularity, and
// total vault value per asset. Writes one row to stackers_snapshots.
//
// None of the three Stackers contracts expose collection-wide totals
// directly — every read is per-token, so getting an aggregate picture means
// actually reading every token. Takes real time for a collection this size
// (one eth_call round-trip per token, with a small gap between each —
// deliberately gentle rather than firing thousands of calls at once, same
// reasoning as the pacing used in collection-backfill.js). Intended to run
// infrequently (see the scheduling comment in bot.js), not on-demand.

const { getStackerInfo, STACKERS_SLUG } = require('./stackers');

const SNAPSHOT_DELAY_MS = 150; // raised from 50 after a live run hit a brief rate-limit cluster around token 239 — this account's throughput has proven tighter than typical across several pollers tonight, not just this one

async function takeStackersSnapshot(pgPool){
  const { rows } = await pgPool.query(
    `SELECT id FROM tokens WHERE collection_slug = $1 ORDER BY id`, [STACKERS_SLUG]
  );
  console.log(`[StackersAnalytics] Starting snapshot for ${rows.length} tokens`);

  let activeTokens = 0;
  let totalWeight = 0n;
  const tierDistribution = {}; // { "1": count, "2": count, ... } — 1-indexed to match formatStackersFields' display, "0" = not yet tiered
  const assetPopularity  = {}; // { "AAPLx": count, ... } — how many tokens have this asset anywhere in their split
  const vaultTotals      = {}; // { "AAPLx": "1234.5678", ... } — summed across all tokens

  let processed = 0, failed = 0;
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
    if(processed > 0 && processed % 500 === 0){
      console.log(`[StackersAnalytics] ${processed}/${rows.length} processed so far`);
    }
  }

  console.log(`[StackersAnalytics] Snapshot complete: ${processed} processed, ${failed} failed, ${activeTokens} active`);

  await pgPool.query(
    `INSERT INTO stackers_snapshots (total_tokens, active_tokens, total_weight, tier_distribution, asset_popularity, vault_totals)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [rows.length, activeTokens, totalWeight.toString(), JSON.stringify(tierDistribution), JSON.stringify(assetPopularity), JSON.stringify(vaultTotals)]
  );

  return { totalTokens: rows.length, activeTokens, processed, failed };
}

// Fetches the most recent snapshot, and — if one exists from roughly 24h
// earlier — a comparison point for computing an honest "at today's rate"
// figure. Returns null for the comparison specifically if there isn't
// enough history yet; there's no way to compute a real rate from a single
// point in time, and this deliberately doesn't fabricate one.
async function getLatestSnapshotWithComparison(pgPool){
  const latestRes = await pgPool.query(
    `SELECT * FROM stackers_snapshots ORDER BY snapshot_at DESC LIMIT 1`
  );
  if(!latestRes.rows.length) return { latest: null, comparison: null };
  const latest = latestRes.rows[0];

  // Closest snapshot to ~24h before the latest one, within a loose window
  // (18-30h back) so this doesn't depend on the job running at an exact
  // interval every single time.
  const comparisonRes = await pgPool.query(
    `SELECT * FROM stackers_snapshots
     WHERE snapshot_at <= $1 - INTERVAL '18 hours'
       AND snapshot_at >= $1 - INTERVAL '30 hours'
     ORDER BY snapshot_at DESC LIMIT 1`,
    [latest.snapshot_at]
  );
  return { latest, comparison: comparisonRes.rows[0] || null };
}

module.exports = { takeStackersSnapshot, getLatestSnapshotWithComparison };
