/**
 * Diagnostic only -- no writes. Case-sensitivity theory was disproven
 * (diag-check-burn-row-case-sensitivity.js: 0 mismatches). Next theory:
 * ordering. deriveIntervals() processes nft_transfers rows sorted by
 * `transferred_at ASC NULLS LAST, id ASC`. If a token's "received" row
 * has a NULL transferred_at, NULLS LAST pushes it to the very end of the
 * sort -- meaning a correctly-timestamped burn row for that same token
 * could get processed BEFORE the receive. When that happens, the
 * `isBurn && open.has(tokenId)` check fails (token isn't open yet), so
 * the burn silently no-ops, and the later receive then adds the token to
 * `open` with nothing left to ever close it -- it stays "held" forever
 * even though burn_event_inputs says it was burned.
 *
 * This walks every trulyBurnedIds token for one wallet and shows, in
 * processing order, every nft_transfers row for that token -- so we can
 * see directly whether the burn row is landing before or after the
 * receive row, and whether NULL timestamps are involved.
 *
 * USAGE
 *   node diag-simulate-derive-order.js 0x6456c11151f4ada09dadb1ebc729d3ef5f38ad41
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const wallet = (process.argv[2] || '0x6456c11151f4ada09dadb1ebc729d3ef5f38ad41').toLowerCase();
const OCAS_SLUG = 'on-chain-all-stars';
const BURN_ADDRS = new Set([
  '0x1095c73c337cc5e03f9e1d426c524cc3e32a50f6',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000000',
]);

async function main() {
  const burnRes = await pool.query(
    `SELECT bei.burned_token_id
     FROM burn_event_inputs bei
     JOIN burn_events be ON be.id = bei.burn_event_id
     WHERE be.burner_wallet = $1`,
    [wallet]
  );
  const trulyBurnedIds = new Set(burnRes.rows.map(r => parseInt(r.burned_token_id)));
  console.log(`trulyBurnedIds for ${wallet}: ${trulyBurnedIds.size}\n`);

  const res = await pool.query(
    `SELECT id, token_id, from_address, to_address, value_eth, transferred_at, event_type, tx_hash
     FROM nft_transfers
     WHERE (to_address=$1 OR from_address=$1) AND collection_slug=$2
     ORDER BY transferred_at ASC NULLS LAST, id ASC`,
    [wallet, OCAS_SLUG]
  );
  console.log(`Total nft_transfers rows for wallet: ${res.rows.length}\n`);

  // Group rows by token_id for the trulyBurnedIds set only
  const rowsByToken = new Map();
  for (const row of res.rows) {
    const tid = parseInt(row.token_id);
    if (!trulyBurnedIds.has(tid)) continue;
    if (!rowsByToken.has(tid)) rowsByToken.set(tid, []);
    rowsByToken.get(tid).push(row);
  }

  let noRowsAtAll = 0, onlyReceive = 0, correctOrder = 0, invertedOrder = 0, other = 0;

  for (const tid of trulyBurnedIds) {
    const rows = rowsByToken.get(tid) || [];
    if (!rows.length) { noRowsAtAll++; continue; }

    const receiveIdx = rows.findIndex(r => (r.to_address||'').toLowerCase() === wallet);
    const burnIdx = rows.findIndex(r => (r.from_address||'').toLowerCase() === wallet && BURN_ADDRS.has((r.to_address||'').toLowerCase()));

    if (receiveIdx === -1) { noRowsAtAll++; continue; }
    if (burnIdx === -1) { onlyReceive++; continue; }
    if (burnIdx > receiveIdx) correctOrder++;
    else invertedOrder++;
  }

  console.log(`=== Summary across ${trulyBurnedIds.size} trulyBurnedIds tokens ===`);
  console.log(`  No nft_transfers rows at all for this token+wallet: ${noRowsAtAll}`);
  console.log(`  Has a receive row but NO qualifying burn row (from=wallet, to=BURN_ADDR): ${onlyReceive}`);
  console.log(`  Burn row correctly AFTER receive row (should process fine): ${correctOrder}`);
  console.log(`  Burn row BEFORE receive row (would be silently dropped): ${invertedOrder}`);

  console.log(`\n=== Detail for first 10 tokens with an issue (not correctOrder) ===`);
  let shown = 0;
  for (const tid of trulyBurnedIds) {
    if (shown >= 10) break;
    const rows = rowsByToken.get(tid) || [];
    const receiveIdx = rows.findIndex(r => (r.to_address||'').toLowerCase() === wallet);
    const burnIdx = rows.findIndex(r => (r.from_address||'').toLowerCase() === wallet && BURN_ADDRS.has((r.to_address||'').toLowerCase()));
    if (rows.length && receiveIdx !== -1 && burnIdx !== -1 && burnIdx > receiveIdx) continue; // correctOrder, skip
    shown++;
    console.log(`\n  token_id=${tid} (${rows.length} row(s) for this wallet):`);
    for (const r of rows) {
      console.log(`    id=${r.id} from=${r.from_address} to=${r.to_address} transferred_at=${r.transferred_at} event_type=${r.event_type} tx=${r.tx_hash}`);
    }
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
