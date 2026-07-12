/**
 * Diagnostic only -- no writes. Confirmed for wallet
 * 0x6456c11151f4ada09dadb1ebc729d3ef5f38ad41: token #901 (genuinely
 * burned per burn_event_inputs) has no corresponding "sent to burn
 * contract" row in nft_transfers -- only a "received" row. deriveIntervals
 * requires nft_transfers to have that specific from-wallet-to-burn-address
 * row to ever mark a token as disposed, regardless of what
 * burn_event_inputs says. This checks how widespread this gap actually is
 * across the whole database, not just this one wallet.
 *
 * USAGE
 *   node diag-scope-missing-burn-transfers.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('=== burn_event_inputs rows with NO matching burn-type row in nft_transfers ===\n');

  const res = await pool.query(`
    SELECT bei.burned_token_id, be.burner_wallet, be.block_number
    FROM burn_event_inputs bei
    JOIN burn_events be ON be.id = bei.burn_event_id
    WHERE bei.burned_token_id != be.survivor_token_id
      AND NOT EXISTS (
        SELECT 1 FROM nft_transfers nt
        WHERE nt.token_id = bei.burned_token_id
          AND LOWER(nt.from_address) = LOWER(be.burner_wallet)
          AND nt.event_type = 'burn'
      )
    ORDER BY be.block_number ASC
  `);

  console.log(`Found ${res.rows.length} burned tokens with no matching nft_transfers burn row\n`);
  for (const r of res.rows.slice(0, 20)) {
    console.log(`  token_id=${r.burned_token_id}  burner_wallet=${r.burner_wallet}  block=${r.block_number}`);
  }
  if (res.rows.length > 20) console.log(`  ...and ${res.rows.length - 20} more`);

  const totalBurnedRes = await pool.query(`
    SELECT COUNT(*)::int AS total FROM burn_event_inputs bei
    JOIN burn_events be ON be.id = bei.burn_event_id
    WHERE bei.burned_token_id != be.survivor_token_id
  `);
  console.log(`\nTotal genuinely-burned-as-input rows (excluding survivors): ${totalBurnedRes.rows[0].total}`);
  console.log(`Missing nft_transfers burn row: ${res.rows.length} (${((res.rows.length/totalBurnedRes.rows[0].total)*100).toFixed(1)}%)`);
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
