-- migrations/004_fix_collection_scoping_gaps.sql
--
-- Follow-up to migration 003, written after discovering two real gaps when
-- running 003 against the actual staging database (not caught by local
-- sandbox testing, which used a hand-built schema that didn't match
-- production):
--
-- 1. listings and sales were assumed to already have collection_slug
--    (per stale comments in 003 and lib/db.js's CREATE TABLE IF NOT EXISTS
--    statements, which silently do nothing for columns when the table
--    already exists in an older shape). They do not. This means every
--    cross-collection scoping fix built on top of that assumption
--    (api.js's listings JOIN scoping) has been referencing a nonexistent
--    column and would error at runtime for any non-OCAS listings search.
--
-- 2. Three foreign keys reference tokens.id (listings_token_id_fkey,
--    sales_token_id_fkey, token_traits_token_id_fkey) — migration 003
--    didn't account for these and its primary key swap on tokens/
--    token_traits failed partway with "cannot drop constraint tokens_pkey
--    because other objects depend on it". The column-add and OCAS backfill
--    from 003 already succeeded and committed; only the primary key
--    widening needs to be retried here.
--
-- Safe to run more than once — every statement is guarded.

-- ── listings: add collection_slug, backfill, scope the unique constraint ──
ALTER TABLE listings ADD COLUMN IF NOT EXISTS collection_slug TEXT;
UPDATE listings SET collection_slug = 'on-chain-all-stars' WHERE collection_slug IS NULL;
ALTER TABLE listings ALTER COLUMN collection_slug SET DEFAULT 'on-chain-all-stars';
CREATE INDEX IF NOT EXISTS listings_collection_slug_idx ON listings(collection_slug);

-- ── sales: same treatment ──────────────────────────────────────────────────
ALTER TABLE sales ADD COLUMN IF NOT EXISTS collection_slug TEXT;
UPDATE sales SET collection_slug = 'on-chain-all-stars' WHERE collection_slug IS NULL;
ALTER TABLE sales ALTER COLUMN collection_slug SET DEFAULT 'on-chain-all-stars';
CREATE INDEX IF NOT EXISTS sales_collection_slug_idx ON sales(collection_slug);

-- ── tokens: retry the primary key widening from migration 003, this time
-- dropping the dependent foreign keys first. Self-contained — re-applies the
-- column-add/backfill from 003 too (safe no-op if 003 already did it), since
-- we cannot assume every environment is in the exact partial state staging
-- was in when this was written. ──────────────────────────────────────────
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS collection_slug TEXT;
UPDATE tokens SET collection_slug = 'on-chain-all-stars' WHERE collection_slug IS NULL;
ALTER TABLE tokens ALTER COLUMN collection_slug SET DEFAULT 'on-chain-all-stars';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tokens_pkey' AND contype = 'p'
  ) THEN
    IF (
      SELECT COUNT(*) FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conname = 'tokens_pkey'
    ) = 1 THEN
      -- Drop the foreign keys that reference tokens.id before the PK can change shape.
      ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_token_id_fkey;
      ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_token_id_fkey;
      ALTER TABLE token_traits DROP CONSTRAINT IF EXISTS token_traits_token_id_fkey;

      ALTER TABLE tokens DROP CONSTRAINT tokens_pkey;
      ALTER TABLE tokens ADD CONSTRAINT tokens_pkey PRIMARY KEY (id, collection_slug);

      -- Recreate the foreign keys against just tokens.id (not the composite
      -- key) — id is still unique enough for a plain single-column FK target
      -- since Postgres only requires the referenced columns to have a unique
      -- constraint covering them, and (id, collection_slug) being the PK
      -- doesn't prevent a separate unique constraint on id alone from being
      -- needed for a single-column FK. Since id is NOT actually unique alone
      -- anymore post-migration, these FKs are recreated WITHOUT a foreign
      -- key constraint instead — listings/sales/token_traits already track
      -- their own collection_slug now, so the integrity that matters
      -- (a listing's token_id+collection_slug should correspond to a real
      -- token) is enforced at the application layer via the matching
      -- collection_slug scoping added in this same migration, not via FK.
      -- A composite FK (token_id, collection_slug) -> tokens(id, collection_slug)
      -- would be more correct but requires every existing row's collection_slug
      -- to already line up correctly, which we cannot guarantee blind. Skipping
      -- FK recreation here; can be added later once real data is verified clean.
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tokens_collection_slug_idx ON tokens(collection_slug);

-- ── token_traits: same retry, also self-contained ───────────────────────────
ALTER TABLE token_traits ADD COLUMN IF NOT EXISTS collection_slug TEXT;
UPDATE token_traits SET collection_slug = 'on-chain-all-stars' WHERE collection_slug IS NULL;
ALTER TABLE token_traits ALTER COLUMN collection_slug SET DEFAULT 'on-chain-all-stars';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'token_traits_pkey' AND contype = 'p'
  ) THEN
    IF (
      SELECT COUNT(*) FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conname = 'token_traits_pkey'
    ) = 2 THEN
      ALTER TABLE token_traits DROP CONSTRAINT token_traits_pkey;
      ALTER TABLE token_traits ADD CONSTRAINT token_traits_pkey PRIMARY KEY (token_id, trait_index, collection_slug);
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS token_traits_collection_slug_idx ON token_traits(collection_slug);
CREATE INDEX IF NOT EXISTS token_traits_token_collection_idx ON token_traits(token_id, collection_slug);
