/**
 * Diagnostic only -- no writes. After a full fresh resync from Alchemy
 * (resync-wallet-from-chain.js), wallet 0x6456c1... now has complete,
 * real, correctly-timestamped nft_transfers data -- yet still shows only
 * 14 held (user confirms true count is 22) and 32 burned. The 32 "truly
 * burned" figure comes entirely from burn_event_inputs/burn_events
 * (trulyBurnedIds), and the reconciliation pass added in
 * lib/wallet-backfill.js force-closes ANY trulyBurnedIds token still open
 * as burned, regardless of whether a real on-chain burn transfer exists
 * for it. That was designed to fix missing/misordered burn rows -- but if
 * burn_event_inputs itself has bad attribution (e.g. crediting a burn to
 * the wrong wallet, plausible if burn transactions can combine inputs
 * from multiple original owners), this would now incorrectly force-close
 * genuinely still-held tokens as "burned".
 *
 * This checks, for each of this wallet's 32 trulyBurnedIds tokens: does a
 * REAL on-chain nft_transfers row exist showing this exact wallet sending
 * it to a known burn address? If not, burn_event_inputs' attribution for
 * that token is suspect.
 *
 * USAGE
 *   node diag-verify-burn-attribution.js 0x6456c11151f4ada09dadb1ebc729d3ef5f38ad41
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
    `SELECT bei.burned_token_id, be.tx_hash, be.block_number, be.survivor_token_id
     FROM burn_event_inputs bei
     JOIN burn_events be ON be.id = bei.burn_event_id
     WHERE be.burner_wallet = $1
     ORDER BY be.block_number ASC`,
    [wallet]
  );
  console.log(`burn_event_inputs rows attributing burns to ${wallet}: ${burnRes.rows.length}\n`);

  let confirmed = 0, unconfirmed = 0;
  const unconfirmedRows = [];

  for (const r of burnRes.rows) {
    const tid = parseInt(r.burned_token_id);
    // Does a REAL nft_transfers row exist: this exact wallet sending this exact token to a burn address?
    const evidence = await pool.query(
      `SELECT id, from_address, to_address, transferred_at, tx_hash
       FROM nft_transfers
       WHERE token_id=$1 AND collection_slug=$2 AND LOWER(from_address)=$3`,
      [tid, OCAS_SLUG, wallet]
    );
    const hasBurnEvidence = evidence.rows.some(row => BURN_ADDRS.has((row.to_address || '').toLowerCase()));
    if (hasBurnEvidence) {
      confirmed++;
    } else {
      unconfirmed++;
      unconfirmedRows.push({ tid, burnEventTx: r.tx_hash, burnEventBlock: r.block_number, survivor: r.survivor_token_id, actualRows: evidence.rows });
    }
  }

  console.log(`Confirmed by real on-chain from-wallet-to-burn-address transfer: ${confirmed}`);
  console.log(`NO on-chain evidence this wallet ever sent this token to a burn address: ${unconfirmed}\n`);

  if (unconfirmedRows.length) {
    console.log('=== Unconfirmed tokens detail ===');
    for (const u of unconfirmedRows) {
      console.log(`\n  token_id=${u.tid}  burn_event.tx_hash=${u.burnEventTx}  block=${u.burnEventBlock}  survivor_token_id=${u.survivor}`);
      if (!u.actualRows.length) {
        console.log(`    -> This wallet has ZERO nft_transfers rows as sender for this token at all.`);
      } else {
        for (const row of u.actualRows) {
          console.log(`    actual row: from=${row.from_address} to=${row.to_address} transferred_at=${row.transferred_at} tx=${row.tx_hash}`);
        }
      }
    }
  }

  // Cross-check: for unconfirmed tokens, who does burn_events say actually holds/held/burned it per a wider search?
  if (unconfirmedRows.length) {
    console.log('\n=== Where these tokens currently sit on-chain (latest transfer, any wallet) ===');
    for (const u of unconfirmedRows.slice(0, 15)) {
      const latest = await pool.query(
        `SELECT from_address, to_address, transferred_at, tx_hash
         FROM nft_transfers
         WHERE token_id=$1 AND collection_slug=$2
         ORDER BY transferred_at DESC NULLS LAST, id DESC
         LIMIT 1`,
        [u.tid, OCAS_SLUG]
      );
      if (latest.rows.length) {
        const l = latest.rows[0];
        console.log(`  token_id=${u.tid}: latest known transfer -> to=${l.to_address} at=${l.transferred_at} (from=${l.from_address})`);
      } else {
        console.log(`  token_id=${u.tid}: no nft_transfers rows found anywhere in DB.`);
      }
    }
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
