'use strict';

const { countWornTraits } = require('./collection-backfill');

// ── TV Rank (obs_rank) computation ───────────────────────────────────────────
// jv: "fine tune the trait view rankings more... try the best to mimic OS in
// a way." Researched OpenRarity's actual published methodology (what OpenSea
// itself uses) rather than guessing: the core math -- summing
// -log2(trait frequency) across a token's traits, i.e. information content --
// was ALREADY exactly what TraitView's client-side rarity score computes.
// The two real, documented gaps OpenSea's "Double Sort and Trait Count"
// update specifically calls out:
//   1. Tokens with a 1-of-1 (totally unique) trait value are specifically
//      prioritized to reliably land at the very top, since a naive
//      information-content sum doesn't guarantee that on its own once other
//      tokens have several moderately-rare traits stacked together.
//   2. Trait count itself carries rarity signal, independent of which
//      specific traits a token has -- a token with an unusually uncommon
//      NUMBER of filled trait categories should score for that on its own,
//      as its OWN separate, dominant sort dimension -- not diluted by being
//      summed into the same additive score as every individual trait.
// Neither existed anywhere in this codebase before this session started (#1
// was implemented then; #2 turned out to still be missing -- see below). The
// exact internal combination formula OpenSea/OpenRarity uses for the 1-of-1
// boost isn't published in a way that could be verified against real source,
// so that part is this codebase's own best-effort match to the documented
// INTENT (see hasUniqueTrait's use as the primary sort key below), not a
// byte-for-byte replica of an unpublished internal detail.
//
// jv: "I don't think it's taking into account 0 traits and 1 traits which.
// OS ranking got those specifically are much better rankings." Confirmed
// with hard evidence (8 side-by-side screenshots comparing exact OpenSea
// rank vs this app's own rank for the same tokens): a token with zero worn
// traits ranked #346 on OpenSea (top 3.5%) but #4818 here, near median.
// First fix: trait count as its own separate, absolute sort dimension
// (ahead of individual-trait score) -- but jv's own follow-up test
// (filtering both OpenSea and this app to the same 9 tokens sharing an
// extremely rare "Bones: Alien" trait, only 9 out of ~10,000) showed
// several of those 9 trapped at near-identical rank numbers in the
// thousands, a dead giveaway that treating trait count as an absolute,
// unconditional dimension let a merely moderately uncommon trait count veto
// an individual trait that was, on its own, rare enough to land in
// OpenSea's own top 20 every time. Trait count is now folded back into the
// same weighted-additive score instead (TRAIT_COUNT_WEIGHT below) -- a
// heavy boost rather than an unconditional veto, so a sufficiently extreme
// individual trait can still out-rank a token whose only advantage is
// trait count. Only the 1-of-1 rule (#1 above) stays as its own absolute,
// separate dimension -- that one really is meant to be unconditional.
//
// Separately (and more urgent than the formula itself): this is also the
// FIRST time obs_rank has ever been computed at all for any collection other
// than OCAS's original, static, legacy DB import. Argonauts had zero rows
// with obs_rank populated -- confirmed directly via a diagnostic query
// (with_obs_rank: 0 out of 9168) -- meaning /db/traits-fast's
// `ORDER BY obs_rank ASC NULLS LAST, id ASC` was silently degenerating to
// pure token-ID order the entire time, not any rarity computation at all.

/**
 * Computes and writes obs_rank + rarity_score for every surviving token in a
 * collection. Safe to call repeatedly (e.g. after every trait backfill, or a
 * burn event) -- always a full recompute from current token_traits, never an
 * incremental patch, so it can never drift from what the data actually says.
 *
 * @param {import('pg').Pool} pgPool
 * @param {string} slug
 * @param {{isOcas?: boolean}} [opts] - isOcas gates the burn-exclusion join,
 *   matching /db/traits-fast's own logic exactly (burn_event_inputs/
 *   burn_events have no collection_slug column at all, so this join must
 *   never run for any other slug -- see the cross-collection collision class
 *   of bug documented elsewhere in this codebase).
 * @returns {Promise<{tokenCount: number}>}
 */
async function computeObsRanks(pgPool, slug, opts = {}) {
  const isOcas = !!opts.isOcas;

  const BURNED_EXCL_TT = isOcas ? `NOT EXISTS (
    SELECT 1 FROM burn_event_inputs bei
    JOIN burn_events be ON be.id = bei.burn_event_id
    WHERE bei.burned_token_id = tt.token_id
    AND bei.burned_token_id != be.survivor_token_id
  )` : 'TRUE';

  // Separate, additional exclusion (lib/burn-detect.js's is_burned flag) --
  // applies universally, alongside OCAS's own burn_events check above, not
  // instead of it. Covers collections with no protocol-level burn mechanic
  // at all (a token simply ends up owned by a known dead address, detected
  // via bulk on-chain ownership rather than any collection-specific event).
  const NOT_MARKED_BURNED = `NOT EXISTS (
    SELECT 1 FROM tokens t
    WHERE t.id = tt.token_id AND t.collection_slug = tt.collection_slug AND t.is_burned = TRUE
  )`;

  // jv: "Burned tokens are getting ranked and they should not be ranked.
  // The 'burned' trait should not be computed into the traits. Once a
  // token is burned, it's gone forever out of the collection and should
  // not count towards the collection or ranking." Confirmed live on
  // Argonauts #3339 (owned by 0x0000...dead) -- it still got a real,
  // computed Rank 30 after a fresh recompute. Root cause: is_burned
  // (lib/burn-detect.js, above) only gets set true once its own 6-hour
  // Alchemy ownership poll has actually run and caught this specific
  // transfer -- it hadn't yet for this token, so NOT_MARKED_BURNED alone
  // let it straight through as a normal, scorable token. Argonauts'
  // on-chain renderer already stamps a "Fate: Burned" attribute onto any
  // dead token's own metadata the moment it's queried (see
  // lib/collection-backfill.js's NON_WORN_TRAIT_CATEGORIES comment) --
  // that's ground truth sourced straight from the contract itself on
  // every backfill, independent of the separate poller's own schedule/
  // reliability, so it's a second, more immediate signal to exclude on.
  // Safe to check unconditionally for every collection: no other slug
  // uses a "Fate" trait category, let alone one valued "Burned".
  const NOT_FATE_BURNED = `NOT EXISTS (
    SELECT 1 FROM token_traits tt2
    WHERE tt2.token_id = tt.token_id AND tt2.collection_slug = tt.collection_slug
    AND LOWER(tt2.trait_name) = 'fate' AND LOWER(tt2.trait_value) = 'burned'
  )`;

  const traitRes = await pgPool.query(
    `SELECT tt.token_id, tt.trait_name, tt.trait_value
     FROM token_traits tt
     WHERE tt.collection_slug = $1 AND ${BURNED_EXCL_TT} AND ${NOT_MARKED_BURNED} AND ${NOT_FATE_BURNED}`,
    [slug]
  );

  if (!traitRes.rows.length) {
    console.warn(`[rank-compute] [${slug}] No token_traits rows found -- nothing to rank`);
    return { tokenCount: 0 };
  }

  // token_id -> [[trait_name, trait_value], ...]
  const tokenTraits = new Map();
  for (const { token_id, trait_name, trait_value } of traitRes.rows) {
    if (!tokenTraits.has(token_id)) tokenTraits.set(token_id, []);
    tokenTraits.get(token_id).push([trait_name, trait_value]);
  }

  const tokenCount = tokenTraits.size;

  // Frequency of each (trait_name, trait_value) pair, keyed as "name\u0000value"
  // to avoid collisions between e.g. trait_name="Hat" value="Blue Hat" and a
  // differently-named category that happens to share a value string.
  const pairFreq = new Map();
  // Frequency of each distinct trait-count value across the whole collection --
  // this IS the "Trait Count" heuristic: how many tokens have exactly N traits,
  // treated as its own rarity dimension separate from which N traits they are.
  const traitCountFreq = new Map();

  for (const [, traits] of tokenTraits) {
    for (const [name, value] of traits) {
      const key = `${name}\u0000${value}`;
      pairFreq.set(key, (pairFreq.get(key) || 0) + 1);
    }
    // jv confirmed live on Argonauts #2280: this was traits.length -- the
    // raw, uncorrected count (every token_traits row, no per-collection
    // exclusion at all). computeObsRanks() runs automatically right after
    // EVERY backfill (predetermined-traits.js included), and its own
    // UPDATE below (trait_count = u.trait_count) unconditionally
    // overwrites tokens.trait_count as a side effect of computing ranks --
    // so this was silently undoing the corrected value within the SAME
    // run that had just written it, every single time, which is exactly
    // why re-running the backfill repeatedly never actually fixed
    // anything. countWornTraits() needs {trait_type, value} objects, not
    // the [name, value] pairs this array already uses -- mapped inline
    // rather than changing tokenTraits' shape everywhere else in this
    // function. This also means the "trait count as its own rarity
    // dimension" scoring below was using the inflated raw number too, not
    // just the stored column -- a real (if usually small) ranking quality
    // fix, not only a data-consistency one.
    const n = countWornTraits(slug, traits.map(([trait_type, value]) => ({ trait_type, value })));
    traitCountFreq.set(n, (traitCountFreq.get(n) || 0) + 1);
  }

  // jv: "We are getting much much closer but I think the low trait
  // count may be getting a little too much weight especially over a
  // trait like alien bones where there is only 9 in the whole
  // collection." A fixed, named constant rather than a magic number
  // inline -- deliberately tunable if further comparison against
  // OpenSea's own ranks (jv's own methodology throughout this whole
  // investigation) shows it still needs adjusting either direction.
  //
  // First live recompute at weight=4 (this constant had never actually
  // been run against production data until this pass) surfaced the same
  // failure mode from the other direction: jv found Argonaut #2400
  // (Palette: Seafoam 1.4%, Bones: Floral 5.0%, zero worn traits) at
  // Rank 6 -- "Floral traits should not be higher than aliens,
  // radioactives, or golds." Floral/Seafoam are common-tier base-trait
  // values (5.0%/1.4% frequency), nowhere near as rare as a true
  // Bones: Alien (9 of ~10,000, ~0.09%) -- at weight=4 the zero-worn-
  // trait bonus alone was enough to out-score that kind of genuinely
  // extreme individual trait. Halved to 2 so a truly rare worn trait
  // can still win out over trait-count alone rewarding a merely bare,
  // common-valued token. Still just this one named constant to retune
  // again if jv's next side-by-side (same Bones: Alien methodology, plus
  // this Floral/Seafoam case) shows it needs to move further.
  const TRAIT_COUNT_WEIGHT = 2;

  const scored = [];
  for (const [tokenId, traits] of tokenTraits) {
    let score = 0;
    let hasUniqueTrait = false;

    for (const [name, value] of traits) {
      const key = `${name}\u0000${value}`;
      const freq = pairFreq.get(key) || 1;
      if (freq === 1) hasUniqueTrait = true;
      const p = freq / tokenCount;
      score += -Math.log2(Math.max(p, 1e-12));
    }

    const n = countWornTraits(slug, traits.map(([trait_type, value]) => ({ trait_type, value })));
    const tcFreq = traitCountFreq.get(n) || 1;
    const tcP = tcFreq / tokenCount;
    score += TRAIT_COUNT_WEIGHT * -Math.log2(Math.max(tcP, 1e-12));

    scored.push({ tokenId, score, hasUniqueTrait, traitCount: n });
  }

  // jv: "Thinking we might need to reevaluate the ranking logic. I
  // don't think it's taking into account 0 traits and 1 traits which.
  // OS ranking got those specifically are much better rankings."
  // Confirmed with hard evidence (8 side-by-side screenshots comparing
  // exact OpenSea rank vs this app's own rank for the same tokens): a
  // token with zero worn traits ranked #346 on OpenSea (top 3.5%) but
  // #4818 here, near median -- a discrepancy of over 4,400 positions.
  //
  // First fix (this session, superseded by the weighting above):
  // switched to a strict lexicographic sort -- 1-of-1 trait first,
  // then trait-count rarity as an absolute, unconditional dimension,
  // then individual-trait score only as the final tiebreaker. That
  // overcorrected: jv's own follow-up test (filtering both OpenSea and
  // this app to the same 9 tokens sharing an extremely rare "Bones:
  // Alien" trait, only 9 out of ~10,000) showed several of those 9
  // trapped at near-identical rank numbers in the thousands -- a dead
  // giveaway that the strict hierarchy was letting a merely moderately
  // uncommon trait count veto an individual trait that was, on its
  // own, rare enough to land in OpenSea's own top 20 every time.
  //
  // Trait count is folded back into the same weighted-additive score
  // now (see TRAIT_COUNT_WEIGHT above) instead of being a separate,
  // absolute sort dimension -- a heavy boost rather than an
  // unconditional veto, so a sufficiently extreme individual trait can
  // still out-rank a token whose only advantage is trait count. Only
  // the 1-of-1 rule stays as an absolute, separate dimension -- that
  // one really is meant to be unconditional (OpenSea's own documented
  // intent is guaranteeing a 1-of-1 always lands at the very top, not
  // "usually").
  scored.sort((a, b) => {
    if (a.hasUniqueTrait !== b.hasUniqueTrait) return a.hasUniqueTrait ? -1 : 1;
    return b.score - a.score;
  });

  // Bulk update via unnest() rather than one UPDATE per token (9,168+ rows
  // for Argonauts alone) -- a single round trip instead of thousands.
  const ids = [];
  const ranks = [];
  const scores = [];
  const traitCounts = [];
  scored.forEach((row, i) => {
    ids.push(row.tokenId);
    ranks.push(i + 1);
    scores.push(row.score);
    traitCounts.push(row.traitCount);
  });

  await pgPool.query(
    `UPDATE tokens AS t SET
       obs_rank = u.rank,
       rarity_score = u.score,
       trait_count = u.trait_count
     FROM (
       SELECT * FROM unnest($2::int[], $3::int[], $4::numeric[], $5::int[])
         AS u(token_id, rank, score, trait_count)
     ) AS u
     WHERE t.id = u.token_id AND t.collection_slug = $1`,
    [slug, ids, ranks, scores, traitCounts]
  );

  console.log(`[rank-compute] [${slug}] Ranked ${tokenCount} tokens (${scored.filter(r => r.hasUniqueTrait).length} with a 1-of-1 trait)`);
  return { tokenCount };
}

// slug -> setTimeout handle. Shared across every caller that can trigger a
// trait change for a collection (the OpenSea Stream metadata-update handler,
// the EIP-4906 on-chain poller, its catch-up/full-verification variants) --
// a single, shared debounce means a burst of changes from ANY of these
// sources, or several of them firing close together, still only triggers one
// recompute once things settle, not one per source.
const _rankRecomputeDebounce = new Map();
const RANK_RECOMPUTE_DEBOUNCE_MS = 30_000;
function scheduleRankRecompute(pgPool, slug, isOcas){
  const existing = _rankRecomputeDebounce.get(slug);
  if(existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    _rankRecomputeDebounce.delete(slug);
    computeObsRanks(pgPool, slug, { isOcas }).catch(e => {
      console.warn(`[rank-compute] [${slug}] Debounced recompute failed:`, e.message);
    });
  }, RANK_RECOMPUTE_DEBOUNCE_MS);
  _rankRecomputeDebounce.set(slug, handle);
}

module.exports = { computeObsRanks, scheduleRankRecompute };
