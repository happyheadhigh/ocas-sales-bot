require('dotenv').config();
const fetch = require('node-fetch');
const { Pool } = require('pg');

const BURN_CONTRACT = '0x1095c73C337CC5e03f9E1D426c524CC3e32a50f6';
const ZERO_START = process.env.BURN_START_BLOCK ? parseInt(process.env.BURN_START_BLOCK, 10) : null;
const CHUNK = Math.max(1, parseInt(process.env.BURN_REPAIR_CHUNK || process.env.BURN_BLOCK_CHUNK || '1000', 10));
const DELAY_MS = Math.max(0, parseInt(process.env.BURN_REPAIR_DELAY_MS || '500', 10));
const TOPIC_BURN_STARTED   = '0x4dd367d2c410889fbff76f34abdefdceb947ad0c58baaf327ead8ac9d6a38c22';
const TOPIC_BURN_FINALIZED = '0x4c7b2090df533e8b1f7bd4ab01aadb95fedf5006f15ff4300c1709b97c4c6d5e';
const ARGS = process.argv.slice(2);
const DRY_RUN_BURNED_AT = ARGS.includes('--dry-run-burned-at');
const FIX_BURNED_AT = ARGS.includes('--fix-burned-at');
const CHECK_WALLET_INDEX = ARGS.indexOf('--check-wallet');
const CHECK_TX_INDEX = ARGS.indexOf('--check-tx');
const CHECK_WALLET = CHECK_WALLET_INDEX >= 0 ? normArg(ARGS[CHECK_WALLET_INDEX + 1]) : '';
const CHECK_TX = CHECK_TX_INDEX >= 0 ? normArg(ARGS[CHECK_TX_INDEX + 1]) : '';
const TIMESTAMP_ONLY_MODE = DRY_RUN_BURNED_AT || FIX_BURNED_AT || !!CHECK_WALLET || !!CHECK_TX;

const DATABASE_URL = process.env.DATABASE_URL;
const ALCHEMY_URL = process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://','https://')
  || (process.env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : '');

if(!DATABASE_URL){ console.error('[burn-repair] Missing DATABASE_URL'); process.exit(1); }
if(!ALCHEMY_URL){ console.error('[burn-repair] Missing ALCHEMY_API_KEY or ALCHEMY_WEBSOCKET_URL'); process.exit(1); }
if(!TIMESTAMP_ONLY_MODE && (!Number.isFinite(ZERO_START) || ZERO_START < 0)){
  console.error('[burn-repair] Missing BURN_START_BLOCK. Use the Burn Machine deployment block.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

function normAddr(addr){
  const s = String(addr || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : '';
}
function normArg(v){ return String(v || '').trim().toLowerCase(); }
function hex(n){ return '0x' + Number(n).toString(16); }
function intHex(v){ return parseInt(String(v || '0x0'), 16); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function rpc(method, params, attempt=0){
  const r = await fetch(ALCHEMY_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0', id:Date.now(), method, params}),
  });
  const text = await r.text();
  if(!r.ok){
    if([429,500,502,503,504].includes(r.status) && attempt < 5){
      const wait = Math.min(60000, 1000 * Math.pow(2, attempt));
      console.warn(`[burn-repair] ${method} HTTP ${r.status}; retrying in ${wait}ms`);
      await sleep(wait);
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`${method} HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = JSON.parse(text);
  if(j.error) throw new Error(`${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

const blockTimestampCache = new Map();
const receiptCache = new Map();

async function getBlockTimestamp(blockNumber){
  const n = Number(blockNumber);
  if(!Number.isFinite(n) || n <= 0) return null;
  if(blockTimestampCache.has(n)) return blockTimestampCache.get(n);
  const block = await rpc('eth_getBlockByNumber', [hex(n), false]);
  const ts = intHex(block?.timestamp);
  const date = ts ? new Date(ts * 1000) : null;
  if(date) blockTimestampCache.set(n, date);
  return date;
}

async function getReceipt(txHash){
  const tx = normArg(txHash);
  if(!/^0x[a-f0-9]{64}$/.test(tx)) return null;
  if(receiptCache.has(tx)) return receiptCache.get(tx);
  const receipt = await rpc('eth_getTransactionReceipt', [tx]);
  receiptCache.set(tx, receipt || null);
  return receipt || null;
}

async function resolveBurnEventChainTime(row){
  let blockNumber = Number(row.block_number || 0);
  let receiptBlockNumber = null;
  if(!Number.isFinite(blockNumber) || blockNumber <= 0){
    const receipt = await getReceipt(row.tx_hash);
    receiptBlockNumber = intHex(receipt?.blockNumber);
    if(Number.isFinite(receiptBlockNumber) && receiptBlockNumber > 0) blockNumber = receiptBlockNumber;
  }
  if(!Number.isFinite(blockNumber) || blockNumber <= 0){
    return { ok:false, reason:'missing block_number and receipt blockNumber', blockNumber:null, chainBurnedAt:null };
  }
  const chainBurnedAt = await getBlockTimestamp(blockNumber);
  if(!chainBurnedAt){
    return { ok:false, reason:`could not fetch block ${blockNumber}`, blockNumber, chainBurnedAt:null };
  }
  return { ok:true, reason:null, blockNumber, chainBurnedAt };
}

function differsByMoreThanOneSecond(a, b){
  if(!a || !b) return true;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) > 1000;
}

function fmtDate(d){
  return d ? new Date(d).toISOString() : 'null';
}

async function loadBurnRowsForTimestampRepair(client){
  const where = [];
  const params = [];
  if(CHECK_WALLET){
    params.push(CHECK_WALLET);
    where.push(`lower(burner_wallet) = $${params.length}`);
  }
  if(CHECK_TX){
    params.push(CHECK_TX);
    where.push(`lower(tx_hash) = $${params.length}`);
  }
  const q = `
    SELECT id, tx_hash, block_number, log_index, burner_wallet, survivor_token_id, burned_at
    FROM burn_events
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id ASC
  `;
  return (await client.query(q, params)).rows;
}

async function repairBurnedAt(client, { fix=false, diagnosticOnly=false } = {}){
  const rows = await loadBurnRowsForTimestampRepair(client);
  let checked = 0;
  let wouldUpdate = 0;
  let updated = 0;
  const skipped = [];
  for(const row of rows){
    checked++;
    let resolved;
    try{
      resolved = await resolveBurnEventChainTime(row);
    }catch(e){
      skipped.push({ id:row.id, tx_hash:row.tx_hash, reason:e.message });
      continue;
    }
    if(!resolved.ok){
      skipped.push({ id:row.id, tx_hash:row.tx_hash, reason:resolved.reason });
      continue;
    }
    const blockDiffers = Number(row.block_number || 0) !== Number(resolved.blockNumber);
    const timeDiffers = differsByMoreThanOneSecond(row.burned_at, resolved.chainBurnedAt);
    const shouldUpdate = blockDiffers || timeDiffers;
    if(shouldUpdate) wouldUpdate++;

    if(diagnosticOnly || shouldUpdate){
      console.log([
        `[burned-at] id=${row.id}`,
        `tx=${row.tx_hash}`,
        `wallet=${row.burner_wallet}`,
        `block=${row.block_number || 'null'}`,
        `chainBlock=${resolved.blockNumber}`,
        `log=${row.log_index}`,
        `current=${fmtDate(row.burned_at)}`,
        `chain=${fmtDate(resolved.chainBurnedAt)}`,
        `differs=${shouldUpdate}`
      ].join(' '));
    }

    if(fix && shouldUpdate){
      await client.query(
        `UPDATE burn_events
         SET burned_at=$1, block_number=CASE WHEN COALESCE(block_number,0) <= 0 THEN $2 ELSE block_number END
         WHERE id=$3`,
        [resolved.chainBurnedAt, resolved.blockNumber, row.id]
      );
      updated++;
    }
  }
  console.log(`[burned-at] rows checked: ${checked}`);
  console.log(`[burned-at] rows that would update: ${wouldUpdate}`);
  console.log(`[burned-at] rows updated: ${updated}`);
  console.log(`[burned-at] rows skipped: ${skipped.length}`);
  for(const s of skipped) console.log(`[burned-at] skipped id=${s.id} tx=${s.tx_hash}: ${s.reason}`);
}

async function ensureSchema(client){
  await client.query(`ALTER TABLE burn_events DROP CONSTRAINT IF EXISTS burn_events_tx_hash_key`);
  await client.query(`
    DELETE FROM burn_event_inputs a
    USING burn_event_inputs b
    WHERE a.id > b.id
      AND a.burn_event_id = b.burn_event_id
      AND a.burned_token_id = b.burned_token_id
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS burn_events_tx_log_idx ON burn_events(tx_hash, log_index)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS burn_event_inputs_event_token_idx ON burn_event_inputs(burn_event_id, burned_token_id)`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS burn_started_events (
      id SERIAL PRIMARY KEY,
      tx_hash TEXT NOT NULL,
      block_number BIGINT NOT NULL,
      log_index INT NOT NULL,
      owner_wallet TEXT NOT NULL,
      survivor_token_id INT NOT NULL,
      points_used INT,
      result_body_type INT,
      result_is_angel BOOLEAN DEFAULT FALSE,
      boost_chance INT,
      reveal_block BIGINT,
      selection_hash TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS burn_started_tx_log_idx ON burn_started_events(tx_hash, log_index)`);
  await client.query(`CREATE INDEX IF NOT EXISTS burn_started_survivor_idx ON burn_started_events(survivor_token_id)`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS burn_started_inputs (
      id SERIAL PRIMARY KEY,
      burn_started_id INT NOT NULL REFERENCES burn_started_events(id) ON DELETE CASCADE,
      burned_token_id INT NOT NULL
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS burn_started_inputs_event_token_idx ON burn_started_inputs(burn_started_id, burned_token_id)`);
}

function decodeStarted(log){
  const data = log.data.slice(2);
  const words = [];
  for(let i=0;i<data.length;i+=64) words.push(data.slice(i,i+64));
  const arrWord = intHex(words[0]) / 32;
  const arrLen = intHex(words[arrWord]);
  const tokenIds = [];
  for(let i=0;i<arrLen;i++) tokenIds.push(intHex(words[arrWord + 1 + i]));
  return {
    owner: normAddr('0x' + log.topics[1].slice(26)),
    survivorTokenId: intHex(log.topics[2]),
    txHash: String(log.transactionHash || '').toLowerCase(),
    blockNumber: intHex(log.blockNumber),
    logIndex: intHex(log.logIndex),
    tokenIds,
    points: intHex(words[1]),
    resultBodyType: intHex(words[2]),
    resultIsAngel: intHex(words[3]) === 1,
    boostChance: intHex(words[4]),
    revealBlock: intHex(words[5]),
    selectionHash: words[6] ? '0x' + words[6] : null,
  };
}

function decodeFinalized(log){
  const data = log.data.slice(2);
  const words = [];
  for(let i=0;i<data.length;i+=64) words.push(data.slice(i,i+64));
  return {
    survivorTokenId: intHex(log.topics[1]),
    txHash: String(log.transactionHash || '').toLowerCase(),
    blockNumber: intHex(log.blockNumber),
    logIndex: intHex(log.logIndex),
    burnSeed: words[0] || '',
    points: intHex(words[1]),
    resultBodyType: intHex(words[2]),
    resultIsAngel: intHex(words[3]) === 1,
    boostChance: intHex(words[4]),
  };
}

async function upsertStarted(client, event){
  const r = await client.query(`
    INSERT INTO burn_started_events
      (tx_hash, block_number, log_index, owner_wallet, survivor_token_id,
       points_used, result_body_type, result_is_angel, boost_chance, reveal_block, selection_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (tx_hash, log_index) DO UPDATE SET
      block_number=EXCLUDED.block_number,
      owner_wallet=EXCLUDED.owner_wallet,
      survivor_token_id=EXCLUDED.survivor_token_id,
      points_used=EXCLUDED.points_used,
      result_body_type=EXCLUDED.result_body_type,
      result_is_angel=EXCLUDED.result_is_angel,
      boost_chance=EXCLUDED.boost_chance,
      reveal_block=EXCLUDED.reveal_block,
      selection_hash=EXCLUDED.selection_hash
    RETURNING id
  `, [event.txHash, event.blockNumber, event.logIndex, event.owner, event.survivorTokenId,
      event.points, event.resultBodyType, event.resultIsAngel, event.boostChance, event.revealBlock, event.selectionHash]);
  const id = r.rows[0].id;
  for(const tokenId of event.tokenIds){
    await client.query(
      `INSERT INTO burn_started_inputs (burn_started_id, burned_token_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [id, tokenId]
    );
  }
  return id;
}

async function loadStarted(client, survivorTokenId, maxBlockNumber = null){
  const params = [survivorTokenId];
  const blockFilter = maxBlockNumber == null ? '' : 'AND bse.block_number <= $2';
  if(maxBlockNumber != null) params.push(maxBlockNumber);
  const r = await client.query(`
    SELECT bse.id, bse.owner_wallet, bse.block_number, bse.log_index,
           array_agg(bsi.burned_token_id ORDER BY bsi.burned_token_id) AS token_ids
    FROM burn_started_events bse
    LEFT JOIN burn_started_inputs bsi ON bsi.burn_started_id = bse.id
    WHERE bse.survivor_token_id = $1
      ${blockFilter}
    GROUP BY bse.id
    ORDER BY bse.block_number DESC, bse.log_index DESC
    LIMIT 1
  `, params);
  return r.rows[0] ? {
    id: r.rows[0].id,
    owner: r.rows[0].owner_wallet,
    blockNumber: r.rows[0].block_number,
    logIndex: r.rows[0].log_index,
    tokenIds: (r.rows[0].token_ids || []).filter(Boolean),
  } : null;
}

async function upsertFinalized(client, event){
  const started = await loadStarted(client, event.survivorTokenId, event.blockNumber);
  const burnedAt = await getBlockTimestamp(event.blockNumber);
  if(!burnedAt) throw new Error(`block timestamp unavailable for finalized tx=${event.txHash} block=${event.blockNumber}`);
  const r = await client.query(`
    INSERT INTO burn_events
      (tx_hash, block_number, log_index, burner_wallet, survivor_token_id,
       result_body_type, result_is_angel, points_used, boost_chance, burn_seed, burned_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (tx_hash, log_index) DO UPDATE SET
      block_number=EXCLUDED.block_number,
      burner_wallet=EXCLUDED.burner_wallet,
      survivor_token_id=EXCLUDED.survivor_token_id,
      result_body_type=EXCLUDED.result_body_type,
      result_is_angel=EXCLUDED.result_is_angel,
      points_used=EXCLUDED.points_used,
      boost_chance=EXCLUDED.boost_chance,
      burn_seed=EXCLUDED.burn_seed,
      burned_at=EXCLUDED.burned_at
    RETURNING id
  `, [event.txHash, event.blockNumber, event.logIndex, started?.owner || '',
      event.survivorTokenId, event.resultBodyType, event.resultIsAngel, event.points, event.boostChance, String(event.burnSeed || ''), burnedAt]);
  const id = r.rows[0].id;
  for(const tokenId of started?.tokenIds || []){
    await client.query(
      `INSERT INTO burn_event_inputs (burn_event_id, burned_token_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [id, tokenId]
    );
  }
  return { id, inputCount: started?.tokenIds?.length || 0 };
}

async function reconcileFinalizedInputs(client){
  const before = await totals(client);
  const finalized = await client.query(`
    SELECT be.id, be.survivor_token_id, be.block_number, be.log_index,
           array_agg(bei.burned_token_id ORDER BY bei.burned_token_id) FILTER (WHERE bei.id IS NOT NULL) AS current_ids
    FROM burn_events be
    LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
    GROUP BY be.id
    ORDER BY be.block_number ASC, be.log_index ASC
  `);
  let missingBefore = 0;
  let missingAfter = 0;
  let repairedBurns = 0;
  let insertedInputs = 0;
  let deletedInputs = 0;
  let startedMatches = 0;
  let startedMissing = 0;

  for(const row of finalized.rows){
    const currentIds = (row.current_ids || []).filter(Boolean).map(Number).sort((a,b)=>a-b);
    if(!currentIds.length) missingBefore++;

    const started = await loadStarted(client, row.survivor_token_id, row.block_number);
    const tokenIds = started?.tokenIds || [];
    if(!tokenIds.length){
      startedMissing++;
      if(!currentIds.length) missingAfter++;
      continue;
    }
    startedMatches++;

    const desiredIds = [...new Set(tokenIds.map(Number).filter(Number.isFinite))].sort((a,b)=>a-b);
    const same = currentIds.length === desiredIds.length && currentIds.every((id, i) => id === desiredIds[i]);
    if(same) continue;

    const del = await client.query('DELETE FROM burn_event_inputs WHERE burn_event_id = $1', [row.id]);
    deletedInputs += del.rowCount;
    for(const tokenId of tokenIds){
      const r = await client.query(
        `INSERT INTO burn_event_inputs (burn_event_id, burned_token_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [row.id, tokenId]
      );
      insertedInputs += r.rowCount;
    }
    repairedBurns++;
  }

  const after = await totals(client);
  return {
    before: Number(before.missing_input_burns || missingBefore || 0),
    after: Number(after.missing_input_burns || missingAfter || 0),
    repairedBurns,
    insertedInputs,
    deletedInputs,
    startedMatches,
    startedMissing,
  };
}

async function totals(client){
  const r = await client.query(`
    WITH finalized AS (
      SELECT id FROM burn_events
    ),
    finalized_inputs AS (
      SELECT DISTINCT bei.burn_event_id, bei.burned_token_id
      FROM burn_event_inputs bei
      JOIN finalized f ON f.id = bei.burn_event_id
    )
    SELECT
      (SELECT COUNT(*)::int FROM finalized) AS finalized_burns,
      (SELECT COUNT(*)::int FROM finalized_inputs) AS tokens_burned,
      (SELECT COUNT(*)::int FROM finalized) AS tokens_created,
      (
        SELECT COUNT(*)::int
        FROM finalized f
        LEFT JOIN finalized_inputs fi ON fi.burn_event_id = f.id
        WHERE fi.burn_event_id IS NULL
      ) AS missing_input_burns
  `);
  const d = await client.query(`
    SELECT COUNT(*)::int AS duplicate_inputs FROM (
      SELECT burn_event_id, burned_token_id
      FROM burn_event_inputs
      GROUP BY burn_event_id, burned_token_id
      HAVING COUNT(*) > 1
    ) x
  `);
  const diagnostics = await client.query(`
    WITH finalized AS (
      SELECT id, survivor_token_id FROM burn_events
    )
    SELECT
      (SELECT COUNT(*)::int
       FROM burn_event_inputs bei
       LEFT JOIN burn_events be ON be.id = bei.burn_event_id
       WHERE be.id IS NULL) AS orphaned_burn_inputs,
      (SELECT COUNT(*)::int
       FROM burn_started_events bse
       LEFT JOIN finalized be ON be.survivor_token_id = bse.survivor_token_id
       WHERE be.id IS NULL) AS started_without_finalize,
      (SELECT COUNT(*)::int
       FROM finalized be
       LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
       WHERE bei.id IS NULL) AS finalized_without_inputs
  `);
  return { ...r.rows[0], ...diagnostics.rows[0], duplicate_inputs: d.rows[0].duplicate_inputs };
}

async function main(){
  const client = await pool.connect();
  try{
    const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [1095, 735]);
    if(!lock.rows[0]?.locked){ console.log('[burn-repair] Another repair is already running.'); return; }

    if(TIMESTAMP_ONLY_MODE){
      if(CHECK_WALLET && !normAddr(CHECK_WALLET)){
        throw new Error('--check-wallet requires a 0x wallet address');
      }
      if(CHECK_TX && !/^0x[a-f0-9]{64}$/.test(CHECK_TX)){
        throw new Error('--check-tx requires a 0x transaction hash');
      }
      const fix = FIX_BURNED_AT;
      const diagnosticOnly = !!CHECK_WALLET || !!CHECK_TX;
      console.log(`[burned-at] mode=${fix ? 'fix' : 'dry-run'}${diagnosticOnly ? ' diagnostic' : ''}`);
      await repairBurnedAt(client, { fix, diagnosticOnly });
      return;
    }

    await ensureSchema(client);

    const latest = intHex(await rpc('eth_blockNumber', []));
    console.log(`[burn-repair] start=${ZERO_START} latest=${latest} chunk=${CHUNK} delayMs=${DELAY_MS}`);
    let foundFinalized = 0;
    let foundStarted = 0;
    let chunks = 0;
    const failedChunks = [];

    async function fetchLogsRange(from, to){
      console.log(`[burn-repair] eth_getLogs fromBlock=${from} toBlock=${to}`);
      try{
        return await rpc('eth_getLogs', [{
          address: BURN_CONTRACT,
          fromBlock: hex(from),
          toBlock: hex(to),
          topics: [[TOPIC_BURN_STARTED, TOPIC_BURN_FINALIZED]],
        }]);
      }catch(e){
        if(from < to){
          console.warn(`[burn-repair] splitting failed range ${from}-${to}: ${e.message}`);
          const mid = Math.floor((from + to) / 2);
          const left = await fetchLogsRange(from, mid);
          if(DELAY_MS) await sleep(DELAY_MS);
          const right = await fetchLogsRange(mid + 1, to);
          return [...(left || []), ...(right || [])];
        }
        throw e;
      }
    }

    for(let from = ZERO_START; from <= latest; from += CHUNK){
      const to = Math.min(latest, from + CHUNK - 1);
      try{
        const logs = await fetchLogsRange(from, to);
        for(const log of logs || []){
          if(log.topics[0]?.toLowerCase() === TOPIC_BURN_STARTED){
            await upsertStarted(client, decodeStarted(log));
            foundStarted++;
          }
        }
        for(const log of logs || []){
          if(log.topics[0]?.toLowerCase() === TOPIC_BURN_FINALIZED){
            await upsertFinalized(client, decodeFinalized(log));
            foundFinalized++;
          }
        }
        chunks++;
        console.log(`[burn-repair] ${from}-${to}: logs=${logs?.length || 0} started=${foundStarted} finalized=${foundFinalized}`);
      }catch(e){
        failedChunks.push([from, to, e.message]);
        console.error(`[burn-repair] failed chunk ${from}-${to}: ${e.message}`);
      }
      if(DELAY_MS) await sleep(DELAY_MS);
    }

    const inputRepair = await reconcileFinalizedInputs(client);
    const t = await totals(client);
    const reduction = Number(t.tokens_burned || 0) - Number(t.tokens_created || 0);
    const estimated = 10000 - reduction;
    console.log('\n[burn-repair] complete');
    console.log(`chunks completed: ${chunks}`);
    console.log(`failed chunks: ${failedChunks.length}`);
    for(const [from,to,msg] of failedChunks) console.log(`missing/failed range: ${from}-${to} (${msg})`);
    console.log(`missing input rows before repair: ${inputRepair.before}`);
    console.log(`missing input rows after repair: ${inputRepair.after}`);
    console.log(`finalized burns reconciled: ${inputRepair.repairedBurns}`);
    console.log(`burn_event_inputs inserted during repair: ${inputRepair.insertedInputs}`);
    console.log(`burn_event_inputs deleted during repair: ${inputRepair.deletedInputs}`);
    console.log(`matched BurnStarted rows: ${inputRepair.startedMatches}`);
    console.log(`finalized burns without matching BurnStarted: ${inputRepair.startedMissing}`);
    console.log(`orphaned burn inputs: ${t.orphaned_burn_inputs}`);
    console.log(`started burns without finalize: ${t.started_without_finalize}`);
    console.log(`finalized burns without inputs: ${t.finalized_without_inputs}`);
    console.log(`finalized burn events found: ${t.finalized_burns}`);
    console.log(`tokens burned found: ${t.tokens_burned}`);
    console.log(`tokens created found: ${t.tokens_created}`);
    console.log(`net supply reduction: ${reduction}`);
    console.log(`estimated supply: ${estimated}`);
    console.log(`burns missing input rows: ${t.missing_input_burns}`);
    console.log(`duplicate burn_event_inputs: ${t.duplicate_inputs}`);
  } finally {
    try{ await client.query('SELECT pg_advisory_unlock($1, $2)', [1095, 735]); }catch(_){}
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('[burn-repair] fatal:', e.message);
  process.exit(1);
});
