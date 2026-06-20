-- Add per-collection scoping to tokens and token_traits.
--
-- Background: these two tables were built OCAS-only — `tokens.id` and
-- `token_traits.token_id` are treated as globally unique numbers, with no
-- column saying which collection they belong to. `listings` already has a
-- `collection_slug` column (see migration history / lib/db.js) so the same
-- token_id can exist across multiple collections there; tokens/token_traits
-- never got the same treatment. This migration brings them in line.
--
-- Safe to run more than once. Backfills all existing rows as OCAS
-- ('on-chain-all-stars'), since every row currently in these tables predates
-- multi-collection support and is implicitly OCAS data.
--
-- IMPORTANT — deploy ordering: run this migration BEFORE deploying any code
-- that depends on the new column (e.g. updated /db/multi-trait-tokens
-- filtering, upsertTokenTraitRows changes). Old code that doesn't know about
-- collection_slug will keep working fine against the new schema unchanged —
-- it'll just keep implicitly operating on whatever rows have NULL or the
-- backfilled OCAS slug. This migration does not change query behavior by
-- itself; it only adds the column and constraints needed for follow-up code
-- changes to start using it.
--
-- VERIFIED RISK (currently dormant, not yet live): upsertTokenTraitRows()
-- in lib/embeds.js and lib/images.js does `DELETE FROM token_traits WHERE
-- token_id=$1` with no collection_slug filter, then re-inserts. Tested
-- locally against this post-migration schema: if two collections ever share
-- a token_id (e.g. OCAS token #1 and some other collection's token #1),
-- that unscoped delete wipes BOTH collections' trait rows for that ID, not
-- just the one being updated. This is currently safe only because every
-- existing caller of upsertTokenTraitRows is OCAS-only burn-machine code
-- (bot.js, commands/burn.js, lib/burn-poller.js) — nothing writes
-- non-OCAS data into token_traits yet. The moment any future code starts
-- writing other collections' trait data here, upsertTokenTraitRows (both
-- copies — it's defined separately in lib/embeds.js AND lib/images.js) must
-- be updated to accept and scope by collection_slug before that happens, or
-- this delete will silently corrupt cross-collection data on shared IDs.

-- ── tokens ─────────────────────────────────────────────────────────────────
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS collection_slug TEXT;

UPDATE tokens SET collection_slug = 'on-chain-all-stars' WHERE collection_slug IS NULL;

ALTER TABLE tokens ALTER COLUMN collection_slug SET DEFAULT 'on-chain-all-stars';

-- tokens.id alone was PRIMARY KEY; once other collections add rows, id is no
-- longer globally unique (collection A token #5 and collection B token #5
-- are different tokens). Drop the old single-column primary key and replace
-- it with a composite key. The original PK constraint name follows
-- Postgres's default naming convention for a table created as
-- `id INT PRIMARY KEY`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tokens_pkey' AND contype = 'p'
  ) THEN
    -- Only drop+replace if it's still the old single-column form.
    IF (
      SELECT COUNT(*) FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conname = 'tokens_pkey'
    ) = 1 THEN
      ALTER TABLE tokens DROP CONSTRAINT tokens_pkey;
      ALTER TABLE tokens ADD CONSTRAINT tokens_pkey PRIMARY KEY (id, collection_slug);
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tokens_collection_slug_idx ON tokens(collection_slug);

-- ── token_traits ───────────────────────────────────────────────────────────
ALTER TABLE token_traits ADD COLUMN IF NOT EXISTS collection_slug TEXT;

UPDATE token_traits SET collection_slug = 'on-chain-all-stars' WHERE collection_slug IS NULL;

ALTER TABLE token_traits ALTER COLUMN collection_slug SET DEFAULT 'on-chain-all-stars';

-- token_traits's original PRIMARY KEY(token_id, trait_index) has the same
-- collision risk once other collections write rows here. Extend it the same
-- way, following the same "only touch the old single-form key" guard.
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
