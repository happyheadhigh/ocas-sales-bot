/**
 * Backfill latest survivor burn_state_snapshots from current on-chain tokenURI.
 *
 * PURPOSE
 * - Safe Option A only: fill the CURRENT/LATEST state for each survivor token's latest burn event.
 * - This does NOT recreate missing middle history for older multi-burn tokens.
 * - Run on STAGING first.
 *
 * ENV REQUIRED
 * - DATABASE_URL
 * - ALCHEMY_API_KEY or ALCHEMY_WEBSOCKET_URL
 *
 * USAGE
 * - Dry run first:
 *     node backfill-latest-burn-state-snapshots.js
 * - Actually write rows:
 *     WRITE=true node backfill-latest-burn-state-snapshots.js
 * - Optional limit:
 *     LIMIT=5 node backfill-latest-burn-state-snapshots.js
 *     WRITE=true LIMIT=5 node backfill-latest-burn-state-snapshots.js
 */

require('dotenv').config();

const { Pool } = require('pg');
const fetch = require('node-fetch');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const WRITE = String(process.env.WRITE || 'false').toLowerCase() === 'true';
const LIMIT = Math.max(0, parseInt(process.env.LIMIT || '0', 10));
const DELAY_MS = Math.max(0, parseInt(process.env.DELAY_MS || '150', 10));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL env var.');
  process.exit(1);
}

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
const RPC_URL = process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://', 'https://') ||
  (ALCHEMY_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : null);

if (!RPC_URL) {
  console.error('Missing ALCHEMY_API_KEY or ALCHEMY_WEBSOCKET_URL env var.');
  process.exit(1);
}

const pgPool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

function decodeAbiString(result) {
  if (!result || result === '0x') return null;

  const hex = result.slice(2);
  if (hex.length < 128) return null;

  // ABI string return: word 0 offset, word 1 length, then string bytes.
  const length = parseInt(hex.slice(64, 128), 16);
  if (!Number.isFinite(length) || length <= 0) return null;

  return Buffer.from(hex.slice(128, 128 + length * 2), 'hex').toString('utf8');
}

function decodeTokenUriJson(uri) {
  if (!uri) return null;

  if (uri.startsWith('data:application/json;base64,')) {
    return JSON.parse(Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf8'));
  }

  if (uri.startsWith('data:application/json,')) {
    return JSON.parse(decodeURIComponent(uri.slice('data:application/json,'.length)));
  }

  throw new Error(`Unsupported tokenURI format: ${uri.slice(0, 60)}`);
}

async function fetchTokenUriSnapshot(tokenId) {
  const id = parseInt(tokenId, 10);
  if (!id) throw new Error(`Invalid tokenId: ${tokenId}`);

  // tokenURI(uint256) selector = 0xc87b56dd
  const paddedId = id.toString(16).padStart(64, '0');
  const result = await rpc('eth_call', [{
    to: OCAS_CONTRACT,
    data: '0xc87b56dd' + paddedId,
  }, 'latest']);

  const uri = decodeAbiString(result);
  const meta = decodeTokenUriJson(uri);

  if (!meta || typeof meta !== 'object') throw new Error('Could not parse metadata JSON');

  const rawAttrs = Array.isArray(meta.attributes) ? meta.attributes : (Array.isArray(meta.traits) ? meta.traits : []);
  const traits = {};
  for (const a of rawAttrs) {
    const name = a.trait_type || a.traitType || a.type || a.name;
    const value = a.value;
    if (name && value != null) traits[String(name)] = String(value);
  }

  if (meta.image) traits.__image = meta.image;

  return {
    image_data: meta.image || null,
    traits_json: traits,
    type: traits.Type || traits.type || null,
    trait_count: Object.keys(traits).filter(k => k !== '__image').length,
  };
}

async function getTargets() {
  const limitSql = LIMIT > 0 ? `LIMIT ${LIMIT}` : '';

  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (survivor_token_id)
        id AS burn_event_id,
        survivor_token_id,
        burned_at
      FROM burn_events
      ORDER BY survivor_token_id, burned_at DESC, id DESC
    ), counts AS (
      SELECT survivor_token_id, COUNT(*)::int AS burn_count
      FROM burn_events
      GROUP BY survivor_token_id
    )
    SELECT
      latest.burn_event_id,
      latest.survivor_token_id,
      counts.burn_count,
      latest.burned_at
    FROM latest
    JOIN counts ON counts.survivor_token_id = latest.survivor_token_id
    LEFT JOIN burn_state_snapshots bss
      ON bss.burn_event_id = latest.burn_event_id
     AND bss.token_id = latest.survivor_token_id
    WHERE bss.id IS NULL
    ORDER BY counts.burn_count DESC, latest.survivor_token_id ASC
    ${limitSql}
  `;

  const res = await pgPool.query(sql);
  return res.rows;
}

async function writeSnapshot(target, snapshot) {
  await pgPool.query(
    `INSERT INTO burn_state_snapshots (burn_event_id, token_id, image_data, traits_json)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (burn_event_id, token_id) DO UPDATE SET
       image_data = EXCLUDED.image_data,
       traits_json = EXCLUDED.traits_json`,
    [target.burn_event_id, target.survivor_token_id, snapshot.image_data, JSON.stringify(snapshot.traits_json)]
  );
}

async function main() {
  console.log('============================================================');
  console.log('Backfill latest burn_state_snapshots from current tokenURI');
  console.log('Mode:', WRITE ? 'WRITE ENABLED' : 'DRY RUN - no DB writes');
  console.log('Limit:', LIMIT > 0 ? LIMIT : 'none');
  console.log('============================================================');

  const targets = await getTargets();
  console.log(`Found ${targets.length} latest survivor burn(s) missing snapshots.`);

  let ok = 0;
  let failed = 0;

  for (const target of targets) {
    const tokenId = target.survivor_token_id;
    try {
      const snap = await fetchTokenUriSnapshot(tokenId);
      console.log(
        `#${tokenId} latestBurnEvent=${target.burn_event_id} burns=${target.burn_count} ` +
        `type=${snap.type || '?'} traits=${snap.trait_count} image=${snap.image_data ? 'yes' : 'no'}`
      );

      if (WRITE) {
        await writeSnapshot(target, snap);
        console.log(`  wrote burn_state_snapshots event=${target.burn_event_id} token=#${tokenId}`);
      }

      ok++;
    } catch (err) {
      failed++;
      console.warn(`#${tokenId} latestBurnEvent=${target.burn_event_id} FAILED: ${err.message}`);
    }

    if (DELAY_MS) await sleep(DELAY_MS);
  }

  console.log('============================================================');
  console.log(`Done. ok=${ok} failed=${failed} mode=${WRITE ? 'write' : 'dry-run'}`);
  console.log('============================================================');
}

main()
  .catch(err => {
    console.error('Fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.end().catch(() => {});
  });
