-- migrations/007_scope_sales_and_floor_history.sql
--
-- Same root cause as migrations 004/005: sales_token_sale_uniq, a UNIQUE
-- constraint on (token_id, sale_ts), predates multi-collection support and
-- has no collection_slug in it. Confirmed live via diagnose-sales.js — the
-- real constraint name doesn't even match what lib/db.js's CREATE TABLE
-- comment claims (UNIQUE(tx_hash, token_id)), but the actual live
-- constraint (sales_token_sale_uniq on token_id, sale_ts) is what
-- sync-listings.js's ON CONFLICT clause has always correctly targeted —
-- the comment was just stale documentation, not a functional bug. Still
-- needs widening for the same reason every other unscoped constraint did:
-- two collections' tokens could otherwise collide on this constraint
-- incorrectly.
--
-- Also adds collection_slug to floor_history's primary key concerns —
-- handled separately via ALTER in sync-listings.js's ensureFloorHistoryTable
-- (not here), since that table is fully owned/created by that script.
--
-- Widened, not dropped, to preserve the actual dedup guarantee.
-- Safe to run more than once.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_token_sale_uniq' AND contype = 'u'
  ) THEN
    IF (
      SELECT COUNT(*) FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conname = 'sales_token_sale_uniq'
    ) = 2 THEN
      ALTER TABLE sales DROP CONSTRAINT sales_token_sale_uniq;
      ALTER TABLE sales ADD CONSTRAINT sales_token_sale_uniq UNIQUE (token_id, sale_ts, collection_slug);
    END IF;
  END IF;
END $$;
