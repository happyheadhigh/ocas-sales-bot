/**
 * Diagnostic only -- no writes. Replicates the EXACT same computation as
 * /db/wallet/:address/burn-stats (survivorSnapMap + resolveInputImage),
 * then prints the resolved image hash for every event + input token, so
 * this can be checked directly against reality instead of tracing the
 * logic by hand (which is error-prone and already been done once without
 * finding the bug).
 *
 * USAGE
 *   node diag-simulate-wallet-burn-stats.js <walletAddress>
 */

require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const address = (process.argv[2] || '').trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.log('Usage: node diag-simulate-wallet-burn-stats.js <walletAddress>');
  process.exit(1);
}

function hash(s) { return crypto.createHash('sha256').update(s || '').digest('hex').slice(0, 12); }

async function main() {
  const eventsRes = await pool.query(
    `SELECT id, block_number, survivor_token_id FROM burn_events WHERE LOWER(burner_wallet) = LOWER($1) ORDER BY block_number DESC`,
    [address]
  );
  const events = eventsRes.rows;
  console.log(`\n=== ${events.length} burn event(s) for ${address} ===\n`);

  const eventIds = events.map(e => e.id);
  const inputsRes = await pool.query(
    `SELECT burn_event_id, burned_token_id FROM burn_event_inputs WHERE burn_event_id = ANY($1)`,
    [eventIds]
  );
  const inputsByEvent = {};
  for (const row of inputsRes.rows) {
    (inputsByEvent[row.burn_event_id] ||= []).push(parseInt(row.burned_token_id));
  }

  // Exact same query as the endpoint
  const survivorSnapsRes = await pool.query(
    `SELECT burn_event_id, image_data FROM burn_state_snapshots WHERE burn_event_id = ANY($1::int[])`,
    [eventIds]
  );
  const survivorSnapMap = {};
  for (const r of survivorSnapsRes.rows) survivorSnapMap[r.burn_event_id] = r.image_data;

  const allInputIds = inputsRes.rows.map(r => r.burned_token_id);
  const priorSnapsRes = await pool.query(
    `SELECT bss.token_id, bss.burn_event_id, bss.image_data, be.block_number
     FROM burn_state_snapshots bss JOIN burn_events be ON be.id = bss.burn_event_id
     WHERE bss.token_id = ANY($1::int[])`,
    [allInputIds]
  );
  const priorSnapsByToken = {};
  for (const r of priorSnapsRes.rows) {
    (priorSnapsByToken[r.token_id] ||= []).push({ blockNumber: parseInt(r.block_number), image: r.image_data });
  }
  for (const list of Object.values(priorSnapsByToken)) list.sort((a, b) => a.blockNumber - b.blockNumber);

  function resolveInputImage(tokenId, currentEventBlockNumber) {
    const candidates = priorSnapsByToken[tokenId] || [];
    let best = null;
    for (const c of candidates) {
      if (c.blockNumber < currentEventBlockNumber && (!best || c.blockNumber > best.blockNumber)) best = c;
    }
    return best ? best.image : null; // not checking mint fallback here, just the prior-snapshot path
  }

  for (const e of events) {
    console.log(`--- burn_event_id=${e.id}  block=${e.block_number} ---`);
    console.log(`  SURVIVOR (#${e.survivor_token_id}): survivorSnapMap hash = ${hash(survivorSnapMap[e.id])}`);
    for (const tokenId of (inputsByEvent[e.id] || [])) {
      const resolved = resolveInputImage(tokenId, parseInt(e.block_number));
      console.log(`  BURNED   (#${tokenId}): resolved hash = ${resolved ? hash(resolved) : '(null -- falls back to mint-time)'}`);
    }
    console.log('');
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
