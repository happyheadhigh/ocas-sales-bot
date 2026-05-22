/**
 * OCAS wallet analytics transfer sync.
 *
 * Standalone process. Do not import this from bot.js.
 *
 * Modes:
 *   npm run wallet:backfill -- --from-block 0x0
 *   npm run wallet:sync
 *
 * Env:
 *   DATABASE_URL
 *   ALCHEMY_API_KEY or ALCHEMY_URL
 *   OCAS_CONTRACT optional
 *   START_BLOCK optional
 */

require('dotenv').config();
const { Pool } = require('pg');

const ZERO = '0x0000000000000000000000000000000000000000';
const DEFAULT_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const SOURCE = 'alchemy_transfers';
const LOCK_KEY_1 = 842026;
const LOCK_KEY_2 = 1;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

const DATABASE_URL = process.env.DATABASE_URL;
const CONTRACT = normalizeAddress(process.env.OCAS_CONTRACT || DEFAULT_CONTRACT);
const ALCHEMY_URL = process.env.ALCHEMY_URL
  || (process.env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : '');
const MAX_RETRIES = Math.max(0, parseInt(process.env.ALCHEMY_MAX_RETRIES || '5', 10));
const RETRY_BASE_MS = Math.max(250, parseInt(process.env.ALCHEMY_RETRY_BASE_MS || '1000', 10));
const SYNC_BLOCK_CHUNK = Math.max(1, parseInt(process.env.SYNC_BLOCK_CHUNK || '50000', 10));

if (!DATABASE_URL) {
  console.error('[wallet-sync] Missing DATABASE_URL');
  process.exit(1);
}
if (!ALCHEMY_URL) {
  console.error('[wallet-sync] Missing ALCHEMY_URL or ALCHEMY_API_KEY');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function isBackfillMode() {
  return process.argv.includes('--backfill') || process.argv.includes('backfill');
}

function normalizeAddress(addr) {
  const s = String(addr || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : '';
}

function toBlockHex(n) {
  if (typeof n === 'string' && n.startsWith('0x')) return n;
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return '0x0';
  return '0x' + Math.floor(num).toString(16);
}

function parseBlockNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  return s.startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
}

function parseTokenId(t) {
  const raw = t?.erc721TokenId || t?.tokenId || t?.token_id || t?.rawContract?.tokenId;
  if (raw == null) return null;
  const s = String(raw);
  const n = s.startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
  return Number.isFinite(n) && n >= 1 && n <= 10000 ? n : null;
}

function parseLogIndex(t, fallback) {
  const candidates = [
    t?.logIndex,
    t?.log?.logIndex,
    t?.rawContract?.logIndex,
    String(t?.uniqueId || '').split(':').pop(),
  ];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const n = typeof c === 'string' && c.startsWith('0x') ? parseInt(c, 16) : parseInt(c, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function classifyTransfer(from, to) {
  if (from === ZERO) return 'mint';
  if (to === ZERO) return 'burn';
  return 'transfer';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function retryDelayMs(attempt, retryAfter) {
  const headerDelay = retryAfterMs(retryAfter);
  if (headerDelay != null) return headerDelay;
  const exponential = RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(60000, exponential + jitter);
}

async function alchemy(method, params) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let r;
    try {
      r = await fetch(ALCHEMY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw e;
      const delay = retryDelayMs(attempt);
      console.warn(`[wallet-sync] Alchemy network error (${e.message}); retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    if (!r.ok) {
      const text = (await r.text()).slice(0, 200);
      if (RETRY_STATUSES.has(r.status) && attempt < MAX_RETRIES) {
        const delay = retryDelayMs(attempt, r.headers.get('retry-after'));
        console.warn(`[wallet-sync] Alchemy HTTP ${r.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Alchemy HTTP ${r.status}: ${text}`);
    }

    const j = await r.json();
    if (j.error) {
      const msg = String(j.error.message || '');
      const retryable = /rate|limit|timeout|temporar|unavailable|server/i.test(msg);
      if (retryable && attempt < MAX_RETRIES) {
        const delay = retryDelayMs(attempt);
        console.warn(`[wallet-sync] Alchemy ${j.error.code || ''}: ${msg}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Alchemy ${j.error.code || ''}: ${j.error.message}`);
    }
    return j.result;
  }
  throw new Error('Alchemy retries exhausted');
}

async function latestBlock() {
  return parseBlockNumber(await alchemy('eth_blockNumber', []));
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      source TEXT NOT NULL,
      contract VARCHAR(42) NOT NULL,
      last_block BIGINT,
      cursor TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, contract)
    )
  `);
}

async function getSyncState(client) {
  const r = await client.query(
    'SELECT last_block, cursor FROM sync_state WHERE source=$1 AND contract=$2',
    [SOURCE, CONTRACT]
  );
  return r.rows[0] || null;
}

async function saveSyncState(client, lastBlock, cursor) {
  await client.query(
    `INSERT INTO sync_state(source, contract, last_block, cursor, updated_at)
     VALUES($1,$2,$3,$4,NOW())
     ON CONFLICT(source, contract)
     DO UPDATE SET last_block=$3, cursor=$4, updated_at=NOW()`,
    [SOURCE, CONTRACT, lastBlock, cursor || null]
  );
}

async function insertTransfers(client, transfers) {
  if (!transfers.length) return 0;
  let inserted = 0;
  for (let i = 0; i < transfers.length; i += 200) {
    const batch = transfers.slice(i, i + 200);
    const values = batch.map((_, j) =>
      `($${j * 9 + 1},$${j * 9 + 2},$${j * 9 + 3},$${j * 9 + 4},$${j * 9 + 5},$${j * 9 + 6},$${j * 9 + 7},$${j * 9 + 8},$${j * 9 + 9})`
    ).join(',');
    const params = batch.flatMap(t => [
      t.contract, t.token_id, t.from_address, t.to_address, t.tx_hash,
      t.log_index, t.block_number, t.block_ts, t.event_type,
    ]);
    const result = await client.query(`
      INSERT INTO nft_transfers
        (contract, token_id, from_address, to_address, tx_hash, log_index, block_number, block_ts, event_type)
      VALUES ${values}
      ON CONFLICT (tx_hash, log_index) DO NOTHING
    `, params);
    inserted += result.rowCount;
  }
  return inserted;
}

async function syncRange(client, fromBlock, toBlock, initialPageKey = null) {
  let pageKey = initialPageKey || null;
  let totalSeen = 0;
  let totalInserted = 0;
  let page = 0;

  do {
    const params = [{
      fromBlock: toBlockHex(fromBlock),
      toBlock: toBlockHex(toBlock),
      category: ['erc721'],
      contractAddresses: [CONTRACT],
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: '0x3e8',
      ...(pageKey ? { pageKey } : {}),
    }];

    const result = await alchemy('alchemy_getAssetTransfers', params);
    const raw = result?.transfers || [];
    const parsed = raw.map((t, i) => {
      const token_id = parseTokenId(t);
      const from = normalizeAddress(t.from) || null;
      const to = normalizeAddress(t.to) || null;
      const tx = String(t.hash || '').toLowerCase();
      const block = parseBlockNumber(t.blockNum);
      if (!token_id || !tx || !Number.isFinite(block)) return null;
      return {
        contract: CONTRACT,
        token_id,
        from_address: from,
        to_address: to,
        tx_hash: tx,
        log_index: parseLogIndex(t, i),
        block_number: block,
        block_ts: t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).toISOString() : null,
        event_type: classifyTransfer(from, to),
      };
    }).filter(Boolean);

    const inserted = await insertTransfers(client, parsed);
    totalSeen += raw.length;
    totalInserted += inserted;
    page++;
    pageKey = result?.pageKey || null;
    await saveSyncState(client, fromBlock - 1, pageKey);
    console.log(`[wallet-sync] chunk ${fromBlock}-${toBlock} page ${page}: seen=${raw.length}, parsed=${parsed.length}, inserted=${inserted}, pageKey=${pageKey ? 'yes' : 'no'}`);
  } while (pageKey);

  await saveSyncState(client, toBlock, null);
  return { totalSeen, totalInserted, pages: page };
}

async function syncChunks(client, fromBlock, toBlock, resumeCursor = null) {
  let cursorBlock = fromBlock;
  let totalSeen = 0;
  let totalInserted = 0;
  let pages = 0;
  let chunk = 0;

  while (cursorBlock <= toBlock) {
    const chunkTo = Math.min(toBlock, cursorBlock + SYNC_BLOCK_CHUNK - 1);
    const pageKey = chunk === 0 ? resumeCursor : null;
    console.log(`[wallet-sync] syncing block chunk ${cursorBlock}-${chunkTo}${pageKey ? ' from saved cursor' : ''}`);
    const result = await syncRange(client, cursorBlock, chunkTo, pageKey);
    totalSeen += result.totalSeen;
    totalInserted += result.totalInserted;
    pages += result.pages;
    cursorBlock = chunkTo + 1;
    chunk++;
  }

  return { totalSeen, totalInserted, pages, chunks: chunk };
}

async function main() {
  if (!CONTRACT) throw new Error('Invalid OCAS_CONTRACT');
  const client = await pool.connect();
  try {
    await ensureSchema(client);
    const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [LOCK_KEY_1, LOCK_KEY_2]);
    if (!lock.rows[0]?.locked) {
      console.log('[wallet-sync] Another wallet sync is already running; exiting.');
      return;
    }

    const state = await getSyncState(client);
    const latest = await latestBlock();
    const requestedFrom = argValue('--from-block') || process.env.START_BLOCK;
    const requestedTo = argValue('--to-block');
    const backfill = isBackfillMode();
    const resumeCursor = requestedFrom ? null : state?.cursor;
    const stateLastBlock = state?.last_block == null ? -1 : Number(state.last_block);
    const fromBlock = requestedFrom
      ? parseBlockNumber(requestedFrom)
      : Math.max(0, (Number.isFinite(stateLastBlock) ? stateLastBlock : -1) + 1);
    const toBlock = requestedTo ? parseBlockNumber(requestedTo) : latest;

    if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock > toBlock) {
      console.log(`[wallet-sync] Nothing to sync. from=${fromBlock} to=${toBlock}`);
      return;
    }

    console.log(`[wallet-sync] ${backfill ? 'backfill' : 'incremental'} ${CONTRACT} from ${fromBlock} to ${toBlock} chunkSize=${SYNC_BLOCK_CHUNK}`);
    const result = await syncChunks(client, fromBlock, toBlock, resumeCursor);
    console.log(`[wallet-sync] done chunks=${result.chunks} pages=${result.pages} seen=${result.totalSeen} inserted=${result.totalInserted}`);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]); } catch (_) {}
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('[wallet-sync] failed:', e.message);
  process.exit(1);
});
