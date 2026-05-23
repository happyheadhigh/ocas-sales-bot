require('dotenv').config();
const fetch = require('node-fetch');
const { Pool } = require('pg');

const BURN_CONTRACT = '0x1095c73C337CC5e03f9E1D426c524CC3e32a50f6';
const ZERO_START = process.env.BURN_START_BLOCK ? parseInt(process.env.BURN_START_BLOCK, 10) : null;
const CHUNK = Math.max(100, parseInt(process.env.BURN_REPAIR_CHUNK || process.env.BURN_BLOCK_CHUNK || '1000', 10));
const TOPIC_BURN_STARTED   = '0x4dd367d2c410889fbff76f34abdefdceb947ad0c58baaf327ead8ac9d6a38c22';
const TOPIC_BURN_FINALIZED = '0x4c7b2090df533e8b1f7bd4ab01aadb95fedf5006f15ff4300c1709b97c4c6d5e';

const DATABASE_URL = process.env.DATABASE_URL;
const ALCHEMY_URL = process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://','https://')
  || (process.env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : '');

if(!DATABASE_URL){ console.error('[burn-repair] Missing DATABASE_URL'); process.exit(1); }
if(!ALCHEMY_URL){ console.error('[burn-repair] Missing ALCHEMY_API_KEY or ALCHEMY_WEBSOCKET_URL'); process.exit(1); }
if(!Number.isFinite(ZERO_START) || ZERO_START < 0){
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

async function loadStarted(client, survivorTokenId){
  const r = await client.query(`
    SELECT bse.owner_wallet, array_agg(bsi.burned_token_id ORDER BY bsi.burned_token_id) AS token_ids
    FROM burn_started_events bse
    LEFT JOIN burn_started_inputs bsi ON bsi.burn_started_id = bse.id
    WHERE bse.survivor_token_id = $1
    GROUP BY bse.id
    ORDER BY bse.block_number DESC, bse.log_index DESC
    LIMIT 1
  `, [survivorTokenId]);
  return r.rows[0] ? { owner: r.rows[0].owner_wallet, tokenIds: (r.rows[0].token_ids || []).filter(Boolean) } : null;
}

async function upsertFinalized(client, event){
  const started = await loadStarted(client, event.survivorTokenId);
  const r = await client.query(`
    INSERT INTO burn_events
      (tx_hash, block_number, log_index, burner_wallet, survivor_token_id,
       result_body_type, result_is_angel, points_used, boost_chance, burn_seed)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (tx_hash, log_index) DO UPDATE SET
      block_number=EXCLUDED.block_number,
      burner_wallet=EXCLUDED.burner_wallet,
      survivor_token_id=EXCLUDED.survivor_token_id,
      result_body_type=EXCLUDED.result_body_type,
      result_is_angel=EXCLUDED.result_is_angel,
      points_used=EXCLUDED.points_used,
      boost_chance=EXCLUDED.boost_chance,
      burn_seed=EXCLUDED.burn_seed
    RETURNING id
  `, [event.txHash, event.blockNumber, event.logIndex, started?.owner || '',
      event.survivorTokenId, event.resultBodyType, event.resultIsAngel, event.points, event.boostChance, String(event.burnSeed || '')]);
  const id = r.rows[0].id;
  for(const tokenId of started?.tokenIds || []){
    await client.query(
      `INSERT INTO burn_event_inputs (burn_event_id, burned_token_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [id, tokenId]
    );
  }
  return { id, inputCount: started?.tokenIds?.length || 0 };
}

async function totals(client){
  const r = await client.query(`
    SELECT
      COUNT(DISTINCT be.id)::int AS finalized_burns,
      COUNT(DISTINCT (bei.burn_event_id, bei.burned_token_id))::int AS tokens_burned,
      COUNT(DISTINCT be.id)::int AS tokens_created,
      COUNT(DISTINCT be.id) FILTER (WHERE bei.burn_event_id IS NULL)::int AS missing_input_burns
    FROM burn_events be
    LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
  `);
  const d = await client.query(`
    SELECT COUNT(*)::int AS duplicate_inputs FROM (
      SELECT burn_event_id, burned_token_id
      FROM burn_event_inputs
      GROUP BY burn_event_id, burned_token_id
      HAVING COUNT(*) > 1
    ) x
  `);
  return { ...r.rows[0], duplicate_inputs: d.rows[0].duplicate_inputs };
}

async function main(){
  const client = await pool.connect();
  try{
    await ensureSchema(client);
    const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [1095, 735]);
    if(!lock.rows[0]?.locked){ console.log('[burn-repair] Another repair is already running.'); return; }

    const latest = intHex(await rpc('eth_blockNumber', []));
    let foundFinalized = 0;
    let foundStarted = 0;
    let chunks = 0;
    const failedChunks = [];

    for(let from = ZERO_START; from <= latest; from += CHUNK){
      const to = Math.min(latest, from + CHUNK - 1);
      try{
        const logs = await rpc('eth_getLogs', [{
          address: BURN_CONTRACT,
          fromBlock: hex(from),
          toBlock: hex(to),
          topics: [[TOPIC_BURN_STARTED, TOPIC_BURN_FINALIZED]],
        }]);
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
    }

    const t = await totals(client);
    const reduction = Number(t.tokens_burned || 0) - Number(t.tokens_created || 0);
    const estimated = 10000 - reduction;
    console.log('\n[burn-repair] complete');
    console.log(`chunks completed: ${chunks}`);
    console.log(`failed chunks: ${failedChunks.length}`);
    for(const [from,to,msg] of failedChunks) console.log(`missing/failed range: ${from}-${to} (${msg})`);
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
