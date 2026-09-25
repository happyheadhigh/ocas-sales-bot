-- OCAS Burn Machine history/backfill support
-- Safe to run more than once.

ALTER TABLE burn_events DROP CONSTRAINT IF EXISTS burn_events_tx_hash_key;

CREATE UNIQUE INDEX IF NOT EXISTS burn_events_tx_log_idx
  ON burn_events(tx_hash, log_index);

CREATE INDEX IF NOT EXISTS burn_events_burner_idx
  ON burn_events(burner_wallet);

CREATE INDEX IF NOT EXISTS burn_events_survivor_idx
  ON burn_events(survivor_token_id);

CREATE UNIQUE INDEX IF NOT EXISTS burn_event_inputs_event_token_idx
  ON burn_event_inputs(burn_event_id, burned_token_id);

CREATE TABLE IF NOT EXISTS burn_started_events (
  id                SERIAL PRIMARY KEY,
  tx_hash           TEXT NOT NULL,
  block_number      BIGINT NOT NULL,
  log_index         INT NOT NULL,
  owner_wallet      TEXT NOT NULL,
  survivor_token_id INT NOT NULL,
  points_used       INT,
  result_body_type  INT,
  result_is_angel   BOOLEAN DEFAULT FALSE,
  boost_chance      INT,
  reveal_block      BIGINT,
  selection_hash    TEXT,
  started_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS burn_started_tx_log_idx
  ON burn_started_events(tx_hash, log_index);

CREATE INDEX IF NOT EXISTS burn_started_survivor_idx
  ON burn_started_events(survivor_token_id);

CREATE TABLE IF NOT EXISTS burn_started_inputs (
  id              SERIAL PRIMARY KEY,
  burn_started_id INT NOT NULL REFERENCES burn_started_events(id) ON DELETE CASCADE,
  burned_token_id INT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS burn_started_inputs_event_token_idx
  ON burn_started_inputs(burn_started_id, burned_token_id);

CREATE INDEX IF NOT EXISTS burn_started_inputs_token_idx
  ON burn_started_inputs(burned_token_id);
