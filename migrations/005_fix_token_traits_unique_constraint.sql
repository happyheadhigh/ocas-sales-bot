-- migrations/005_fix_token_traits_unique_constraint.sql
--
-- Discovered running a real (non-OCAS) backfill via backfill-collection-traits.js
-- against CryptoPunks (the first ever attempt to insert brand-new, non-OCAS
-- rows into tokens/token_traits). Two separate problems surfaced that no
-- amount of OCAS-only testing could catch, since every OCAS token ID already
-- existed before any of this scoping work began:
--
-- 1. token_traits_token_id_trait_index_key — a UNIQUE constraint on just
--    (token_id, trait_index), separate from and in addition to the primary
--    key. Migration 004 fixed the primary key but missed this second,
--    independent constraint, which still silently enforces the old
--    single-collection assumption: two different collections' tokens cannot
--    both have a trait at index 0. Widened here to match the primary key's
--    shape (token_id, trait_index, collection_slug) rather than dropped, to
--    preserve the actual uniqueness guarantee it exists for.
--
-- 2. tokens.obs_rank and tokens.rarity_score are NOT NULL with no usable
--    default. Every existing OCAS row already had real values (computed by
--    a background rank-sync job that only exists for OCAS), so this was
--    never exercised until a brand-new non-OCAS token ID needed inserting
--    with neither value known yet — there is no rank-computation path for
--    any other collection anywhere in this codebase. A placeholder value
--    (e.g. -1) was considered and rejected: every ORDER BY/rank_min/rank_max
--    query that touches these columns was audited (api.js), and a fake
--    sentinel would have sorted unranked tokens to the very top of
--    "best rank first" listings — actively misleading, not just unused
--    filler. Made nullable instead, which is both more accurate (these
--    tokens genuinely have no rank yet) and required no further code
--    changes: every existing ORDER BY on these columns is ascending, and
--    Postgres's default NULLS LAST behavior for ASC sorts already puts
--    unranked tokens at the bottom where they belong; rank_min/rank_max
--    range filters already exclude NULL rows automatically (NULL >= x is
--    never true in SQL); rarity_score is only ever displayed, never sorted,
--    and the existing display code already guards for a falsy value.
--
-- Safe to run more than once.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_traits_token_id_trait_index_key' AND contype = 'u'
  ) THEN
    IF (
      SELECT COUNT(*) FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conname = 'token_traits_token_id_trait_index_key'
    ) = 2 THEN
      ALTER TABLE token_traits DROP CONSTRAINT token_traits_token_id_trait_index_key;
      ALTER TABLE token_traits ADD CONSTRAINT token_traits_token_id_trait_index_key UNIQUE (token_id, trait_index, collection_slug);
    END IF;
  END IF;
END $$;

ALTER TABLE tokens ALTER COLUMN obs_rank DROP NOT NULL;
ALTER TABLE tokens ALTER COLUMN rarity_score DROP NOT NULL;
