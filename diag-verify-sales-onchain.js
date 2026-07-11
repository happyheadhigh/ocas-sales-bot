/**
 * DRY RUN ONLY -- no database writes whatsoever. Confirmed via three
 * independent sources (user's direct knowledge, Etherscan, and a separate
 * nft_transfers query) that token #3876 has 22 wrong rows in the sales
 * table -- attached to real transactions it was never actually part of.
 * "Shared tx_hash across many tokens" alone isn't proof of corruption
 * though (a real 50-NFT Seaport sweep looks exactly like that too, and IS
 * legitimate for the 50 tokens genuinely in it). The only rigorous way to
 * tell "genuinely part of this transaction" apart from "wrongly attached
 * to it" is checking the transaction's real on-chain logs directly.
 *
 * For every flagged row (tx_hash shared across >= MIN_TOKENS distinct
 * token_ids), this fetches that transaction's real receipt once (cached
 * per tx_hash, since many rows share one hash), extracts every genuine
 * ERC-721 Transfer event for the OCAS contract specifically, and checks
 * whether each row's claimed token_id actually appears among the tokens
 * really transferred in that transaction. Anything that doesn't is
 * confirmed wrong by the blockchain itself, not by inference.
 *
 * Writes a JSON report to disk (wrong-sales-rows-report.json) listing
 * every confirmed-wrong row's id, for a human to review before any actual
 * deletion happens -- this script itself changes nothing in the database.
 *
 * USAGE
 *   node diag-verify-sales-onchain.js [minTokenCount]
 *   (minTokenCount defaults to 5, matching the earlier scope-check)
 *
 * This can take a while -- one RPC call per DISTINCT tx_hash, not per row,
 * but that could still be several hundred calls. Progress is logged as it
 * runs so it's clear this is working, not hung.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { burnRpc, burnRpcUrl } = require('./lib/rpc');
const { OCAS_CONTRACT } = require('./lib/constants');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const minTokenCount = parseInt(process.argv[2], 10) || 5;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Extracts the set of token_ids genuinely transferred FROM the OCAS
// contract specifically, via real ERC-721 Transfer event logs, in one
// transaction receipt.
function realTokenIdsFromReceipt(receipt){
  const ids = new Set();
  for (const log of (receipt.logs || [])) {
    if (String(log.address || '').toLowerCase() !== OCAS_CONTRACT.toLowerCase()) continue;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC0) continue;
    if (log.topics.length !== 4) continue; // ERC-721 Transfer has tokenId as the 3rd indexed topic
    ids.add(parseInt(log.topics[3], 16));
  }
  return ids;
}

async function main() {
  const rpcUrl = burnRpcUrl();
  console.log(`Using RPC: ${rpcUrl ? new URL(rpcUrl).host : '(none configured)'}\n`);

  const flaggedRes = await pool.query(
    `SELECT tx_hash FROM sales WHERE tx_hash IS NOT NULL
     GROUP BY tx_hash HAVING COUNT(DISTINCT token_id) >= $1`,
    [minTokenCount]
  );
  const txHashes = flaggedRes.rows.map(r => r.tx_hash);
  console.log(`Checking ${txHashes.length} distinct flagged transaction(s) against real on-chain logs...\n`);

  const wrongRows = [];
  let confirmedCorrect = 0, confirmedWrong = 0, lookupFailures = 0;

  for (let i = 0; i < txHashes.length; i++) {
    const txHash = txHashes[i];
    if (i % 25 === 0) console.log(`  ...progress: ${i}/${txHashes.length} transactions checked`);

    let receipt;
    try {
      receipt = await burnRpc(rpcUrl, 'eth_getTransactionReceipt', [txHash]);
      if (!receipt) throw new Error('null receipt (tx not found or not yet indexed)');
    } catch (e) {
      console.warn(`  [skip] ${txHash}: ${e.message}`);
      lookupFailures++;
      await sleep(150);
      continue;
    }

    const realTokenIds = realTokenIdsFromReceipt(receipt);

    const rowsRes = await pool.query(
      `SELECT id, token_id FROM sales WHERE tx_hash=$1`,
      [txHash]
    );
    for (const row of rowsRes.rows) {
      if (realTokenIds.has(parseInt(row.token_id))) {
        confirmedCorrect++;
      } else {
        confirmedWrong++;
        wrongRows.push({ id: row.id, token_id: parseInt(row.token_id), tx_hash: txHash });
      }
    }

    await sleep(150); // stay well under rate limits, this isn't time-sensitive
  }

  console.log('\n=== Results ===');
  console.log(`  Transactions checked: ${txHashes.length}`);
  console.log(`  Lookup failures (skipped): ${lookupFailures}`);
  console.log(`  Rows confirmed CORRECT (token genuinely in that transaction): ${confirmedCorrect}`);
  console.log(`  Rows confirmed WRONG (token NOT in that transaction's real logs): ${confirmedWrong}`);

  const outPath = path.join(__dirname, 'wrong-sales-rows-report.json');
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), minTokenCount, confirmedCorrect, confirmedWrong, lookupFailures, wrongRows }, null, 2));
  console.log(`\nFull list of confirmed-wrong row IDs written to: ${outPath}`);
  console.log('No database changes were made -- this is a report only, for review before any repair.');
}

main().then(() => pool.end()).catch(e => { console.error('Fatal error:', e.message); pool.end(); process.exit(1); });
