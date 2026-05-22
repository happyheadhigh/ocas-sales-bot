# TraitView Wallet Analytics Backend

This is the first backend foundation for real TraitView wallet analytics. It is intentionally separate from the Discord bot so transfer backfills and analytics work cannot slow down sale/listing alerts.

## New Tables

Run `migrations/001_wallet_analytics.sql` against Railway Postgres.

- `nft_transfers`: append-only OCAS ERC721 transfer ledger from Alchemy.
- `wallet_token_intervals`: derived holding intervals per wallet and token.
- `wallet_daily_snapshots`: precomputed daily wallet metrics for charts.
- `wallet_analytics_cache`: cached wallet summary payloads.
- `sync_state`: sync checkpoint state for Alchemy transfer backfills/incremental syncs.

The migration only creates new tables and indexes. It does not modify `bot_state`, `listings`, `sales`, `tokens`, or `token_traits`.

## Environment Variables

Required for sync/derive:

- `DATABASE_URL`: Railway Postgres connection string.
- `ALCHEMY_API_KEY` or `ALCHEMY_URL`: server-side only. Do not expose this to TraitView.

Optional:

- `OCAS_CONTRACT`: defaults to `0x078be86f3104a32313a47815792230a3808642cc`.
- `START_BLOCK`: optional first block for backfill if not passing `--from-block`.
- `SYNC_BLOCK_CHUNK`: optional block chunk size for transfer sync checkpoints. Defaults to `50000`.
- `ALCHEMY_MAX_RETRIES`: optional retry count for rate limits and temporary Alchemy failures. Defaults to `5`.
- `ALCHEMY_RETRY_BASE_MS`: optional retry base delay in milliseconds. Defaults to `1000`.

Existing API variables still apply:

- `API_SECRET`: protects read endpoints when configured. In `NODE_ENV=production`, protected endpoints fail closed if this is missing.
- `PORT`: Express API port.

## Run Migration

Use Railway's SQL console, `psql`, or another Postgres client:

```sql
\i migrations/001_wallet_analytics.sql
```

If using a shell with `psql`:

```bash
psql "$DATABASE_URL" -f migrations/001_wallet_analytics.sql
```

## Backfill Transfers

Backfill should run as a separate Railway service/job, not inside `bot.js`.

```bash
npm run wallet:backfill -- --from-block 0x0
```

For a known deployment block, prefer that block over `0x0`.

The sync uses:

- `alchemy_getAssetTransfers`
- `pg_try_advisory_lock`
- `sync_state`
- a Postgres pool max of `2`

It upserts by `(tx_hash, log_index)` and never deletes bot data.

## Incremental Sync

After a backfill:

```bash
npm run wallet:sync
```

This resumes from `sync_state.last_block + 1`. The sync runs in block chunks and advances `sync_state.last_block` after each completed chunk so a crash only replays the current chunk, not the entire requested range. The current Alchemy `pageKey` is saved during a chunk and reused on the next run when possible.

## Derive Holding Intervals

After transfers are synced:

```bash
npm run wallet:derive
```

This rebuilds `wallet_token_intervals` from `nft_transfers` in block/log order.

Rules:

- `from = 0x000...000` is a mint.
- `to = 0x000...000` is a burn.
- normal transfers close the previous holder interval and open a new holder interval.

The derive step is idempotent and only rebuilds the derived interval table. A full rebuild is acceptable for v1/backfill; if this becomes a frequent production job, replace it with an incremental derive keyed by synced block ranges.

## API Endpoints

Read-only wallet analytics endpoints:

- `GET /db/wallet/:address/summary`
- `GET /db/wallet/:address/transfers?limit=100&offset=0`
- `GET /db/wallet/:address/history?days=90`
- `GET /db/wallet/:address/traits?limit=100`
- `GET /db/token/:id/history?limit=100`

If wallet sync has not run yet, endpoints return graceful empty responses with `synced: false`.

## Railway Deployment

Recommended services:

- Existing Discord bot service: unchanged, `npm start`.
- Existing API service: `node api.js`.
- New wallet sync service/job: `npm run wallet:sync`.
- Optional one-off backfill job: `npm run wallet:backfill -- --from-block <deployment-block>`.
- Optional scheduled derive job: `npm run wallet:derive`.

Do not import `wallet-sync.js` from `bot.js` or `api.js`.

## Why Separate From The Discord Bot

The Discord bot polls OpenSea and posts alerts. It needs to stay responsive and should not compete with transfer backfills for CPU, network, API rate limits, or database connections.

Wallet analytics can involve large historical backfills and derived computations. Keeping it in a separate process lets Railway scale, restart, schedule, and monitor it independently.

## Safety Notes

- Keep Alchemy keys server-side only.
- Keep `API_SECRET` enabled for non-public/admin routes. Production API deployments must set `API_SECRET`; otherwise protected endpoints fail closed.
- Avoid privileged API secrets in frontend query strings.
- Keep wallet endpoints paginated.
- Use indexes from the migration before exposing charts in TraitView.
- Avoid unbounded wallet history queries from the browser.
