/**
 * Fixes TraitView's wallet "Owned Tokens" showing already-burned tokens as
 * still owned. Root cause confirmed via diag-scope-missing-burn-transfers.js:
 * 1,041 of 1,403 (74.2%) genuinely-burned-as-input tokens have no
 * corresponding "sent to burn contract" row in nft_transfers -- only a
 * "received" row. deriveIntervals() (which computes wallet_token_intervals,
 * the table "Owned Tokens" is actually driven by) requires nft_transfers to
 * have that specific from-wallet-to-burn-address row with event_type='burn'
 * to ever close out an interval, regardless of what burn_event_inputs says.
 *
 * This synthesizes the missing rows directly from burn_event_inputs/
 * burn_events, which are already confirmed accurate (313/313 verified
 * clean earlier). Does NOT touch the blockchain or re-fetch anything --
 * uses only data already trusted in this database.
 *
 * to_address is set to the zero address, matching the real reference row
 * confirmed via diag-check-nft-transfers-schema.js (burns transfer to
 * 0x000...000 on-chain, not the burn orchestrator contract address).
 * transferred_at is set to burn_events.burned_at so these rows sort
 * correctly in deriveIntervals' chronological processing, since the real
 * reference row shows transferred_at can be NULL even on genuine rows,
 * which would sort a newly-inserted row incorrectly.
 *
 * log_index: there's a real UNIQUE (tx_hash, log_index) constraint. Since
 * these are synthesized (not re-fetched from the chain), this script
 * checks the current MAX log_index already used for each tx_hash and
 * assigns new, non-colliding sequential values above that per transaction
 * -- multiple tokens burned in the same tx_hash are common (confirmed via
 * real examples with up to 22 tokens in one burn transaction) and must
 * each get a distinct log_index.
 *
 * Defaults to a dry run. Set WRITE=true to actually apply it.
 *
 * USAGE
 *   node fix-missing-nft-transfers-burn-rows.js                  (dry run)
 *   WRITE=true node fix-missing-nft-transfers-burn-rows.js        (applies)
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const OCAS_SLUG = 'on-chain-all-stars';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const WRITE = process.env.WRITE === 'true';

async function main() {
  const missingRes = await pool.query(`
    SELECT bei.burned_token_id, be.burner_wallet, be.block_number, be.burned_at, be.tx_hash
    FROM burn_event_inputs bei
    JOIN burn_events be ON be.id = bei.burn_event_id
    WHERE bei.burned_token_id != be.survivor_token_id
      AND NOT EXISTS (
        SELECT 1 FROM nft_transfers nt
        WHERE nt.token_id = bei.burned_token_id
          AND LOWER(nt.from_address) = LOWER(be.burner_wallet)
          AND nt.event_type = 'burn'
      )
    ORDER BY be.tx_hash, be.block_number ASC
  `);

  console.log(`Missing nft_transfers burn rows: ${missingRes.rows.length}`);
  if (!missingRes.rows.length) {
    console.log('Nothing to do.');
    return;
  }

  const byTx = new Map();
  for (const r of missingRes.rows) {
    if (!byTx.has(r.tx_hash)) byTx.set(r.tx_hash, []);
    byTx.get(r.tx_hash).push(r);
  }
  console.log(`Spanning ${byTx.size} distinct transaction(s)\n`);

  if (!WRITE) {
    console.log('DRY RUN -- showing the first 3 transactions worth of planned inserts:\n');
    let shown = 0;
    for (const [txHash, rows] of byTx) {
      if (shown >= 3) break;
      const maxRes = await pool.query(`SELECT COALESCE(MAX(log_index), -1) AS max_idx FROM nft_transfers WHERE tx_hash = $1`, [txHash]);
      let nextIdx = parseInt(maxRes.rows[0].max_idx) + 1;
      console.log(`  tx_hash=${txHash} (${rows.length} row(s), starting log_index=${nextIdx}):`);
      for (const r of rows) {
        console.log(`    token_id=${r.burned_token_id}  from=${r.burner_wallet}  log_index=${nextIdx}  block=${r.block_number}`);
        nextIdx++;
      }
      shown++;
    }
    console.log(`\nTotal across all ${byTx.size} transactions: ${missingRes.rows.length} rows would be inserted.`);
    console.log('Re-run with WRITE=true to actually apply it.');
    return;
  }

  console.log('WRITE=true -- inserting missing rows...\n');
  let inserted = 0, failed = 0;
  for (const [txHash, rows] of byTx) {
    const maxRes = await pool.query(`SELECT COALESCE(MAX(log_index), -1) AS max_idx FROM nft_transfers WHERE tx_hash = $1`, [txHash]);
    let nextIdx = parseInt(maxRes.rows[0].max_idx) + 1;
    for (const r of rows) {
      try {
        await pool.query(
          `INSERT INTO nft_transfers
             (contract, token_id, from_address, to_address, tx_hash, log_index, block_number, block_ts, event_type, value_eth, transferred_at, collection_slug)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'burn',0,$8,$9)`,
          [OCAS_CONTRACT, r.burned_token_id, r.burner_wallet, ZERO_ADDR, txHash, nextIdx, r.block_number, r.burned_at, OCAS_SLUG]
        );
        inserted++;
      } catch (e) {
        console.warn(`  [skip] token_id=${r.burned_token_id} tx_hash=${txHash} log_index=${nextIdx}: ${e.message}`);
        failed++;
      }
      nextIdx++;
    }
  }
  console.log(`\nInserted ${inserted} row(s), ${failed} failed (expected total ${missingRes.rows.length}).`);
  if (inserted + failed !== missingRes.rows.length) {
    console.log('NOTE: counts do not add up cleanly -- worth double-checking manually.');
  } else if (failed === 0) {
    console.log('All rows inserted cleanly. Repair complete.');
  }
}

main().then(() => pool.end()).catch(e => { console.error('Fatal error:', e.message); pool.end(); process.exit(1); });
