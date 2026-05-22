-- TraitView wallet analytics foundation.
-- Safe to run repeatedly. This migration only creates new wallet analytics tables
-- and indexes; it does not modify bot_state, listings, sales, or token metadata.

CREATE TABLE IF NOT EXISTS nft_transfers (
  contract      VARCHAR(42) NOT NULL,
  token_id      INTEGER NOT NULL,
  from_address  VARCHAR(42),
  to_address    VARCHAR(42),
  tx_hash       VARCHAR(66) NOT NULL,
  log_index     INTEGER NOT NULL,
  block_number  BIGINT NOT NULL,
  block_ts      TIMESTAMPTZ,
  event_type    TEXT NOT NULL DEFAULT 'transfer',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nft_transfers_tx_log_uniq UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS nft_transfers_contract_block_idx
  ON nft_transfers (contract, block_number, log_index);

CREATE INDEX IF NOT EXISTS nft_transfers_token_idx
  ON nft_transfers (contract, token_id, block_number, log_index);

CREATE INDEX IF NOT EXISTS nft_transfers_from_idx
  ON nft_transfers (contract, from_address, block_number DESC)
  WHERE from_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS nft_transfers_to_idx
  ON nft_transfers (contract, to_address, block_number DESC)
  WHERE to_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS nft_transfers_wallet_lookup_idx
  ON nft_transfers (contract, token_id, block_number, log_index, from_address, to_address);

CREATE TABLE IF NOT EXISTS wallet_token_intervals (
  wallet_address VARCHAR(42) NOT NULL,
  token_id       INTEGER NOT NULL,
  acquired_at    TIMESTAMPTZ NOT NULL,
  disposed_at    TIMESTAMPTZ,
  acquired_tx    VARCHAR(66),
  disposed_tx    VARCHAR(66),
  PRIMARY KEY (wallet_address, token_id, acquired_at)
);

CREATE INDEX IF NOT EXISTS wallet_token_intervals_wallet_idx
  ON wallet_token_intervals (wallet_address, acquired_at DESC);

CREATE INDEX IF NOT EXISTS wallet_token_intervals_current_wallet_idx
  ON wallet_token_intervals (wallet_address, token_id)
  WHERE disposed_at IS NULL;

CREATE INDEX IF NOT EXISTS wallet_token_intervals_token_idx
  ON wallet_token_intervals (token_id, acquired_at DESC);

CREATE TABLE IF NOT EXISTS wallet_daily_snapshots (
  wallet_address        VARCHAR(42) NOT NULL,
  snapshot_date         DATE NOT NULL,
  owned_count           INTEGER NOT NULL DEFAULT 0,
  best_rank             INTEGER,
  listed_count          INTEGER NOT NULL DEFAULT 0,
  estimated_floor_value NUMERIC(18,8),
  PRIMARY KEY (wallet_address, snapshot_date)
);

CREATE INDEX IF NOT EXISTS wallet_daily_snapshots_wallet_date_idx
  ON wallet_daily_snapshots (wallet_address, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS wallet_analytics_cache (
  wallet_address VARCHAR(42) PRIMARY KEY,
  summary_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wallet_analytics_cache_updated_idx
  ON wallet_analytics_cache (updated_at DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  source     TEXT NOT NULL,
  contract   VARCHAR(42) NOT NULL,
  last_block BIGINT,
  cursor     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, contract)
);
