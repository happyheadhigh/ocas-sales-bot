-- migrations/008_widen_listings_primary_key.sql
--
-- Migration 004 added collection_slug to listings and created a plain,
-- non-unique index on it (listings_collection_slug_idx), but never widened
-- listings_pkey itself — that was an oversight, not a deliberate choice.
-- listings_pkey has remained (token_id) alone through every migration today.
-- This wasn't caught until sync-listings.js's real multi-collection upsert
-- (ON CONFLICT (token_id, collection_slug)) actually tried to target a
-- composite uniqueness constraint that was never created, failing live with
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" across every collection's listings sync.
--
-- Same pattern as migrations 004 (tokens_pkey) and 004 (token_traits_pkey):
-- drop the single-column primary key, recreate as composite.
--
-- listings has no incoming foreign keys (confirmed earlier this session —
-- only listings/sales/token_traits reference tokens.id, nothing references
-- listings.token_id), so unlike the tokens_pkey swap, there is no dependent
-- constraint to drop first.
--
-- Safe to run more than once.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'listings_pkey' AND contype = 'p'
  ) THEN
    IF (
      SELECT COUNT(*) FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conname = 'listings_pkey'
    ) = 1 THEN
      ALTER TABLE listings DROP CONSTRAINT listings_pkey;
      ALTER TABLE listings ADD CONSTRAINT listings_pkey PRIMARY KEY (token_id, collection_slug);
    END IF;
  END IF;
END $$;
