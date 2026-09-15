/**
 * lib/auto-backfill.js
 * ─────────────────────────────────────────────────────────────────
 * Orchestrates automatically triggering the per-token trait backfill
 * (lib/collection-backfill.js) when a paid-tier server adds a new
 * collection via /config, or /setup completes for a non-OCAS
 * collection. Handles:
 *
 *   - Skip entirely if this collection_slug already has token_traits
 *     rows (a previous server already backfilled it — detect, don't
 *     redo). This is the cross-server sharing jv asked for: the
 *     first server to add a collection pays the one-time backfill
 *     cost, every server after that gets it for free and instantly.
 *   - A DB-level lock (collection_backfill_status table) so two
 *     servers adding the SAME new collection within moments of each
 *     other can't both kick off a redundant simultaneous backfill —
 *     the second one just sees "already in progress" and returns
 *     immediately without starting its own.
 *   - Runs the actual backfill fire-and-forget (never awaited at the
 *     call site) so it can never block or delay the Discord
 *     interaction reply — same isolation principle as pollSales()'s
 *     writeSalesToDb() from earlier tonight.
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

const { backfillCollectionTraits } = require('./collection-backfill');
const { resolveCollectionForOnboarding } = require('./collection-onboard');
const { fetchAndStoreCollectionTraits } = require('./db');
const { sendActivityWebhook, sendErrorWebhook } = require('./error');
const { computeObsRanks } = require('./rank-compute');
// jv confirmed live on nekoadz: a collection added via /config's
// auto-backfill path could complete a fully successful trait backfill and
// still never appear on TraitView at all, no matter how many times it was
// re-run. Root cause -- this whole file tracks its OWN progress via
// collection_backfill_status (an internal lock table: 'in_progress' /
// 'complete' / 'failed'), but never once touches collections.status, the
// column loadDynamicCollections() (js/config.js) actually gates visibility
// on (`if(row.status !== 'ready') continue`). That column defaults to
// 'pending' and stays there forever unless something explicitly promotes
// it. seedMarketHistory() (sync-listings.js) is that promotion -- already
// proven correct, already used by collection-onboard.js's own onboarding
// flow -- just never wired into this one.
const { seedMarketHistory } = require('../sync-listings');

// Resolves chain via OpenSea and upserts into the collections registry.
// Deliberately separate from the trait-backfill decision below — a
// collection needs to be registered (so /download, wallet verification,
// automatic alert links, and everything else that reads chain from this
// table can find it) regardless of whether its trait data has already
// been backfilled by some earlier run. Safe to call repeatedly (upsert).
async function registerCollectionChain(pgPool, slug){
  const resolved = await resolveCollectionForOnboarding(slug);
  await pgPool.query(`
    INSERT INTO collections (slug, contract, chain, name, total_supply, token_standard)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (slug) DO UPDATE SET
      contract = EXCLUDED.contract,
      chain = EXCLUDED.chain,
      name = EXCLUDED.name,
      total_supply = EXCLUDED.total_supply,
      token_standard = EXCLUDED.token_standard,
      updated_at = NOW()
  `, [resolved.slug, resolved.contract, resolved.chain, resolved.name, resolved.totalSupply, resolved.tokenStandard]);
  if(resolved.chain !== 'ethereum'){
    console.log(`[auto-backfill] [${slug}] Auto-detected chain: ${resolved.chain}`);
  }
  return resolved;
}

async function ensureBackfillTable(pgPool){
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS collection_backfill_status (
      slug        TEXT PRIMARY KEY,
      contract    TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'in_progress',
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      tokens_written INTEGER,
      error       TEXT
    )
  `);
}

const STALE_LOCK_MS = 30 * 60 * 1000; // 30 min — generous, largest realistic collection backfill is a few minutes

// ── Shared backfill lock, used by BOTH the auto-trigger path below AND the
// manual /config re-backfill button ─────────────────────────────────────────
// Confirmed live: deleting and re-adding a collection triggers the
// auto-backfill path, and a manual re-backfill click shortly after (while
// that auto-triggered run was still going) started a SECOND, fully
// concurrent backfill for the same slug — the manual path called
// backfillCollectionTraits() directly, entirely bypassing this lock, which
// only maybeStartBackfill ever checked. Confirmed via that run's own
// numbers: the repair-queue stats came out at exactly 2x the real distinct
// row count, and the log showed a page being "written" before its own
// "fetched" line — the unmistakable signature of two independent loops
// each reaching similar attempt numbers around the same wall-clock moment.
// ON CONFLICT protections meant no data got corrupted, but it meant roughly
// double the necessary Alchemy/OpenSea request volume for that run.
// Extracted here so BOTH triggers share one lock instead of only one of
// them ever checking it.
async function tryClaimBackfillLock(pgPool, slug, contract){
  await ensureBackfillTable(pgPool);
  const claim = await pgPool.query(
    `INSERT INTO collection_backfill_status (slug, contract, status)
     VALUES ($1,$2,'in_progress')
     ON CONFLICT (slug) DO NOTHING`,
    [slug, contract.toLowerCase()]
  );
  if(claim.rowCount > 0) return { claimed: true };

  // Someone already claimed it — check if it's stuck (started long ago,
  // never finished — e.g. bot restarted mid-backfill) and worth
  // re-attempting, vs. genuinely in progress right now.
  const status = await pgPool.query(
    `SELECT status, started_at FROM collection_backfill_status WHERE slug=$1`, [slug]
  );
  const row = status.rows[0];
  const startedMsAgo = row ? (Date.now() - new Date(row.started_at).getTime()) : Infinity;
  if(row?.status === 'in_progress' && startedMsAgo < STALE_LOCK_MS){
    return { claimed: false, reason: 'in-progress', startedMsAgo };
  }
  // Stale, or previously finished (complete/failed) — reclaim the lock.
  // This is what still lets a manual re-backfill genuinely re-run a
  // collection that already completed once, while refusing to start a
  // SECOND one if a run is genuinely active right now.
  await pgPool.query(
    `UPDATE collection_backfill_status SET status='in_progress', started_at=NOW(), finished_at=NULL, error=NULL, contract=$2
     WHERE slug=$1`, [slug, contract.toLowerCase()]
  );
  return { claimed: true };
}

async function releaseBackfillLock(pgPool, slug, { success, tokensWritten, error } = {}){
  if(success){
    await pgPool.query(
      `UPDATE collection_backfill_status SET status='complete', finished_at=NOW(), tokens_written=$2, error=NULL WHERE slug=$1`,
      [slug, tokensWritten || 0]
    ).catch(()=>{});
  }else{
    await pgPool.query(
      `UPDATE collection_backfill_status SET status='failed', finished_at=NOW(), error=$2 WHERE slug=$1`,
      [slug, String(error || '').slice(0, 500)]
    ).catch(()=>{});
  }
}

/**
 * Checks whether a collection needs backfilling and, if so, claims the
 * lock and kicks off the backfill in the background. Returns one of:
 *   { needed: false, reason: 'already-backfilled' }  — skip silently, no message needed
 *   { needed: false, reason: 'in-progress' }          — another trigger already started it
 *   { needed: true }                                  — backfill just started, show the wait message
 *
 * Never throws — any DB/lock error is logged and treated as "don't
 * trigger", since failing safe (no backfill) is much better than
 * crashing the /config or /setup interaction that called this.
 */
async function maybeStartBackfill(pgPool, { contract, slug, guildId = null, guildName = null }){
  if(!contract || !slug) return { needed: false, reason: 'missing-contract-or-slug' };
  const lcSlug = slug.toLowerCase();
  // OCAS is never auto-backfilled this way — it already has correct,
  // burn-aware trait data from its original backfill. Mirrors the guard
  // inside backfillCollectionTraits() itself, checked here too so we
  // don't even attempt the lock/status dance for it.
  if(lcSlug === 'on-chain-all-stars') return { needed: false, reason: 'ocas' };

  try{
    await ensureBackfillTable(pgPool);

    // Register in the collections registry unconditionally, before the
    // already-backfilled check below — a collection needs to be findable
    // by chain regardless of whether its trait data was already backfilled
    // by some earlier run. Without this ordering, a collection that already
    // has token_traits rows (added before this registry existed, or
    // backfilled by a different server) would hit the early return just
    // below and never get registered at all — exactly what happened with
    // stackersxyz, confirmed via a live test: zero [auto-backfill] log
    // activity on a fresh /config remove-and-re-add, because it already
    // had trait data and short-circuited before ever reaching runInBackground.
    // Failure here is non-fatal — chain-aware features just fall back to
    // ethereum for this collection, same as before this existed.
    await registerCollectionChain(pgPool, lcSlug).catch(e => {
      console.warn(`[auto-backfill] [${lcSlug}] collections registry registration failed (non-fatal):`, e.message);
    });

    // /traitfind's dropdown reads from collection_traits specifically (sourced
    // from OpenSea's own trait-stats API), not token_traits — a separate table
    // this flow never populated. onboardCollection (the dedicated onboarding
    // endpoint) already does this; this flow didn't, which is exactly what
    // broke /traitfind for stackersxyz ("No trait data found") despite real
    // per-token trait data already existing. Same reasoning as the registry
    // fix above: run this regardless of whether a fresh trait backfill is
    // actually needed below, since this table is a separate concern.
    await fetchAndStoreCollectionTraits(lcSlug, pgPool).catch(e => {
      console.warn(`[auto-backfill] [${lcSlug}] collection_traits sync failed (non-fatal, /traitfind will show empty until this succeeds):`, e.message);
    });

    // Already fully backfilled by any server, any time in the past —
    // the actual signal of truth is real token_traits rows existing,
    // not just the status table (in case the status table is ever out
    // of sync with reality, e.g. manually-run CLI backfills that never
    // touched this table at all — like tonight's CryptoPunks run).
    const existing = await pgPool.query(
      `SELECT 1 FROM token_traits WHERE collection_slug=$1 LIMIT 1`, [lcSlug]
    );
    if(existing.rows.length){
      // jv confirmed live on nekoadz: this path (real trait data already
      // exists, so no fresh backfill runs) never promoted
      // collections.status to 'ready' either -- same gap as the fresh-
      // backfill path below, just a different code branch. Only run
      // seedMarketHistory if the collection isn't already 'ready' --
      // a collection onboarded correctly through the OTHER flow
      // (collection-onboard.js) shouldn't get its sales/listings history
      // needlessly re-seeded just because a second server configured it.
      try{
        const statusRes = await pgPool.query(`SELECT status, contract FROM collections WHERE slug=$1`, [lcSlug]);
        const row = statusRes.rows[0];
        if(row && row.status !== 'ready'){
          sendActivityWebhook(`⏳ Starting seedMarketHistory: "${lcSlug}"`, '(already-backfilled path) Sales history + listings seed beginning now.').catch(()=>{});
          await seedMarketHistory({ slug: lcSlug, contract: row.contract || contract });
          sendActivityWebhook(`✅ seedMarketHistory complete: "${lcSlug}"`, '(already-backfilled path) Status should now be \'ready\'.').catch(()=>{});
        }
      }catch(e){
        console.warn(`[auto-backfill] [${lcSlug}] seedMarketHistory (already-backfilled path) failed (non-fatal):`, e.message);
        sendErrorWebhook(`seedMarketHistory failed: "${lcSlug}"`, e, '(already-backfilled path)').catch(()=>{});
      }
      // This IS real usage worth tracking even though no fresh backfill
      // runs — a fresh backfill only ever reports the FIRST server to add
      // a given collection; every server after that hits this exact path
      // and would otherwise produce zero signal, undercounting actual
      // adoption for any popular collection.
      const guildLabel = guildName ? `${guildName} (${guildId})` : (guildId || 'unknown guild');
      sendActivityWebhook(
        `📋 Collection configured: "${lcSlug}"`,
        `Guild: ${guildLabel}\nAlready indexed by an earlier server — no fresh backfill needed, instant.`
      ).catch(()=>{});
      return { needed: false, reason: 'already-backfilled' };
    }

    // Try to claim the lock. ON CONFLICT DO NOTHING means only the
    // first caller for this slug actually inserts a row — anyone else
    // racing for the same slug gets 0 rowCount and knows to back off.
    const claim = await tryClaimBackfillLock(pgPool, lcSlug, contract);
    if(!claim.claimed){
      return { needed: false, reason: 'in-progress' };
    }

    // Fire-and-forget — never awaited at the call site (see runInBackground below).
    runInBackground(pgPool, { contract, slug: lcSlug, guildId, guildName });
    return { needed: true };

  }catch(e){
    console.error('[auto-backfill] maybeStartBackfill error:', e.message);
    return { needed: false, reason: 'error' };
  }
}

async function runInBackground(pgPool, { contract, slug, guildId, guildName }){
  let chain = 'ethereum';
  let resolved = null;
  try{
    resolved = await registerCollectionChain(pgPool, slug);
    chain = resolved.chain;
    if(resolved.contract !== contract.toLowerCase()){
      console.warn(`[auto-backfill] [${slug}] OpenSea's contract (${resolved.contract}) differs from the configured contract (${contract}) — backfilling the configured one as before, but using OpenSea's resolved chain (${chain})`);
    }
  }catch(resolveErr){
    console.warn(`[auto-backfill] [${slug}] Chain auto-detection failed (${resolveErr.message}) — defaulting to ethereum, same behavior as before this existed`);
  }

  try{
    const stats = await backfillCollectionTraits(pgPool, { contract, slug, chain, totalSupply: resolved?.totalSupply || null, guildId, guildName });
    // This module's own header comment confirms it's only ever used for a
    // paid-tier server's /config addition or /setup completing for a
    // NON-OCAS collection -- isOcas is always false here, matching how
    // /db/collections/onboard's own call site is gated.
    await computeObsRanks(pgPool, slug, { isOcas: false }).catch(e => {
      console.warn(`[auto-backfill] [${slug}] TV Rank computation failed (non-fatal):`, e.message);
    });
    // jv confirmed live on nekoadz: this is the actual fix for "backfill
    // completed but never showed up on TraitView" -- see the header
    // comment on the seedMarketHistory import above. Non-fatal like the
    // rank step above it: a collection that's missing sales/listings
    // history is still far more useful visible-with-a-gap than invisible
    // forever, so this never blocks completion.
    //
    // jv: "you need a way to connect to railway and read the logs
    // yourself" -- can't (no network path from this environment to
    // Railway, no stored credentials), so making the NEXT run
    // self-diagnosing via the webhook channel instead of needing another
    // log pull. This "about to call" ping fires unconditionally, before
    // anything that could hang or throw -- if a future run ever shows
    // this message but never the success/failure one a few lines below,
    // that alone proves seedMarketHistory itself is the thing hanging,
    // without needing to see a single log line.
    sendActivityWebhook(`⏳ Starting seedMarketHistory: "${slug}"`, 'Sales history + listings seed beginning now.').catch(()=>{});
    try{
      await seedMarketHistory({ slug, contract: resolved?.contract || contract });
      sendActivityWebhook(`✅ seedMarketHistory complete: "${slug}"`, 'Status should now be \'ready\' -- collection should appear on TraitView.').catch(()=>{});
    }catch(e){
      console.warn(`[auto-backfill] [${slug}] seedMarketHistory failed (non-fatal, collection may not appear on TraitView until this succeeds):`, e.message);
      sendErrorWebhook(`seedMarketHistory failed: "${slug}"`, e, 'Collection will not appear on TraitView until this succeeds -- re-run /config or wait for the next auto-backfill attempt.').catch(()=>{});
    }
    await releaseBackfillLock(pgPool, slug, { success: true, tokensWritten: stats.written });
    const completionMsg = `${stats.written} tokens written, ${stats.skipped} skipped, ${stats.pages} pages${stats.queuedForRepair ? `, ${stats.queuedForRepair} queued for background repair` : ''}`;
    console.log(`[auto-backfill] [${slug}] ✓ complete — ${completionMsg}`);
    // jv: "make sure the collection backfill sends me one as well" (a
    // webhook notification, same as the two new slash commands).
    sendActivityWebhook(`✅ Auto-backfill complete: "${slug}"`, completionMsg).catch(()=>{});
  }catch(e){
    await releaseBackfillLock(pgPool, slug, { success: false, error: e.message || e });
    console.error(`[auto-backfill] [${slug}] ✗ failed:`, e.message);
    sendErrorWebhook(`Auto-backfill failed: "${slug}"`, e, `Contract: ${contract}, chain: ${chain}`).catch(()=>{});
  }
}

module.exports = { maybeStartBackfill, tryClaimBackfillLock, releaseBackfillLock };
