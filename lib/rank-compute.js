'use strict';

// ── TV Rank (obs_rank) computation ───────────────────────────────────────────
// jv: "fine tune the trait view rankings more... try the best to mimic OS in
// a way." Researched OpenRarity's actual published methodology (what OpenSea
// itself uses) rather than guessing: the core math -- summing
// -log2(trait frequency) across a token's traits, i.e. information content --
// was ALREADY exactly what TraitView's client-side rarity score computes.
// The two real, documented gaps OpenSea's "Double Sort and Trait Count"
// update specifically calls out:
//   1. Trait count itself carries rarity signal, independent of which
//      specific traits a token has -- a token with an unusually uncommon
//      NUMBER of filled trait categories should score for that on its own.
//   2. Tokens with a 1-of-1 (totally unique) trait value are specifically
//      prioritized to reliably land at the very top, since a naive
//      information-content sum doesn't guarantee that on its own once other
//      tokens have several moderately-rare traits stacked together.
// Neither existed anywhere in this codebase before this. The exact internal
// combination formula OpenSea/OpenRarity uses for the 1-of-1 boost isn't
// published in a way that could be verified against real source, so that
// part is this codebase's own best-effort match to the documented INTENT
// (see hasUniqueTrait's use as the primary sort key below), not a byte-for-
// byte replica of an unpublished internal detail.
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

  const traitRes = await pgPool.query(
    `SELECT tt.token_id, tt.trait_name, tt.trait_value
     FROM token_traits tt
     WHERE tt.collection_slug = $1 AND ${BURNED_EXCL_TT}`,
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
    const n = traits.length;
    traitCountFreq.set(n, (traitCountFreq.get(n) || 0) + 1);
  }

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

    // Trait count as its own dimension -- a token with a rare NUMBER of
    // traits gets credit for that independent of what those traits are.
    const n = traits.length;
    const tcFreq = traitCountFreq.get(n) || 1;
    const tcP = tcFreq / tokenCount;
    score += -Math.log2(Math.max(tcP, 1e-12));

    scored.push({ tokenId, score, hasUniqueTrait, traitCount: n });
  }

  // Primary sort: any 1-of-1 trait always outranks none -- matches OpenSea's
  // documented intent of reliably surfacing 1-of-1s at the very top, which a
  // pure information-content sum doesn't guarantee on its own. Information
  // content itself is the tiebreaker within each group.
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

module.exports = { computeObsRanks };
