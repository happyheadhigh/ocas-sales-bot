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
async function maybeStartBackfill(pgPool, { contract, slug }){
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
    if(existing.rows.length) return { needed: false, reason: 'already-backfilled' };

    // Try to claim the lock. ON CONFLICT DO NOTHING means only the
    // first caller for this slug actually inserts a row — anyone else
    // racing for the same slug gets 0 rowCount and knows to back off.
    const claim = await pgPool.query(
      `INSERT INTO collection_backfill_status (slug, contract, status)
       VALUES ($1,$2,'in_progress')
       ON CONFLICT (slug) DO NOTHING`,
      [lcSlug, contract.toLowerCase()]
    );
    if(claim.rowCount === 0){
      // Someone already claimed it — check if it's stuck (started long
      // ago, never finished — e.g. bot restarted mid-backfill) and worth
      // re-attempting, vs. genuinely in progress right now.
      const status = await pgPool.query(
        `SELECT status, started_at FROM collection_backfill_status WHERE slug=$1`, [lcSlug]
      );
      const row = status.rows[0];
      const startedMsAgo = row ? (Date.now() - new Date(row.started_at).getTime()) : Infinity;
      const STALE_MS = 30 * 60 * 1000; // 30 min — generous, largest realistic collection backfill is a few minutes
      if(row?.status === 'in_progress' && startedMsAgo < STALE_MS){
        return { needed: false, reason: 'in-progress' };
      }
      // Stale or previously failed — reclaim the lock and retry.
      await pgPool.query(
        `UPDATE collection_backfill_status SET status='in_progress', started_at=NOW(), finished_at=NULL, error=NULL
         WHERE slug=$1`, [lcSlug]
      );
    }

    // Fire-and-forget — never awaited at the call site (see runInBackground below).
    runInBackground(pgPool, { contract, slug: lcSlug });
    return { needed: true };

  }catch(e){
    console.error('[auto-backfill] maybeStartBackfill error:', e.message);
    return { needed: false, reason: 'error' };
  }
}

async function runInBackground(pgPool, { contract, slug }){
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
    const stats = await backfillCollectionTraits(pgPool, { contract, slug, chain, totalSupply: resolved?.totalSupply || null });
    await pgPool.query(
      `UPDATE collection_backfill_status
       SET status='complete', finished_at=NOW(), tokens_written=$2, error=NULL
       WHERE slug=$1`,
      [slug, stats.written]
    ).catch(()=>{});
    console.log(`[auto-backfill] [${slug}] ✓ complete — ${stats.written} tokens written, ${stats.skipped} skipped, ${stats.pages} pages${stats.queuedForRepair ? `, ${stats.queuedForRepair} queued for background repair` : ''}`);
  }catch(e){
    await pgPool.query(
      `UPDATE collection_backfill_status SET status='failed', finished_at=NOW(), error=$2 WHERE slug=$1`,
      [slug, String(e.message || e).slice(0, 500)]
    ).catch(()=>{});
    console.error(`[auto-backfill] [${slug}] ✗ failed:`, e.message);
  }
}

module.exports = { maybeStartBackfill };
