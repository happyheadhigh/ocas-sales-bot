/**
 * DRY RUN ONLY -- no database writes whatsoever. Originally written and run
 * for OCAS: confirmed via three independent sources (user's direct
 * knowledge, Etherscan, and a separate nft_transfers query) that token
 * #3876 had 22 wrong rows in the sales table -- attached to real
 * transactions it was never actually part of. "Shared tx_hash across many
 * tokens" alone isn't proof of corruption though (a real 50-NFT Seaport
 * sweep looks exactly like that too, and IS legitimate for the 50 tokens
 * genuinely in it). The only rigorous way to tell "genuinely part of this
 * transaction" apart from "wrongly attached to it" is checking the
 * transaction's real on-chain logs directly.
 *
 * jv (Argonauts): "token #1477 is MY token. it does not have 610 sales...
 * I MINTED token #1477 and eventually transferred it to another wallet.
 * that is it." Same bug class, a different collection -- /diag/sales-per-
 * token confirmed groups of Argonauts tokens (e.g. #4210/#9269/#1315/
 * #1477/#8634, all sharing an identical 610 sale_count, 299 distinct
 * buyers, 357 distinct sellers, and the exact same first/last sale
 * timestamp to the second) that can only mean the same underlying batch
 * of sale rows got written multiple times, once per token in the group --
 * exactly the bundle/sweep-misattribution pattern already confirmed for
 * OCAS. Generalized from hardcoded OCAS_CONTRACT to a SLUG env var (the
 * contract address is looked up from the collections table, not
 * hardcoded), and the tx_hash scan below is now scoped to that one
 * collection's own rows -- so this is reusable for any collection that
 * hits the same issue, not just a one-off for either of these two.
 *
 * For every flagged row (tx_hash shared across >= MIN_TOKENS distinct
 * token_ids, within this collection), this fetches that transaction's
 * real receipt once (cached per tx_hash, since many rows share one hash),
 * extracts every genuine ERC-721 Transfer event for this collection's own
 * contract specifically, and checks whether each row's claimed token_id
 * actually appears among the tokens really transferred in that
 * transaction. Anything that doesn't is confirmed wrong by the blockchain
 * itself, not by inference.
 *
 * Writes a JSON report to disk (wrong-sales-rows-report-<slug>.json)
 * listing every confirmed-wrong row's id, for a human to review before any
 * actual deletion happens -- this script itself changes nothing in the
 * database.
 *
 * USAGE
 *   SLUG=argonauts node diag-verify-sales-onchain.js [minTokenCount]
 *   (SLUG defaults to OCAS_SLUG if not set, matching the original,
 *   pre-generalization behavior for any existing caller that never
 *   passed one. minTokenCount defaults to 5, matching the earlier
 *   scope-check.)
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
const { OCAS_CONTRACT, OCAS_SLUG } = require('./lib/constants');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const minTokenCount = parseInt(process.argv[2], 10) || 5;
const slug = (process.env.SLUG || OCAS_SLUG).toLowerCase();

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Extracts the set of token_ids genuinely transferred FROM the given
// contract specifically, via real ERC-721 Transfer event logs, in one
// transaction receipt.
function realTokenIdsFromReceipt(receipt, contract){
  const ids = new Set();
  for (const log of (receipt.logs || [])) {
    if (String(log.address || '').toLowerCase() !== contract.toLowerCase()) continue;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC0) continue;
    if (log.topics.length !== 4) continue; // ERC-721 Transfer has tokenId as the 3rd indexed topic
    ids.add(parseInt(log.topics[3], 16));
  }
  return ids;
}

async function main() {
  const rpcUrl = burnRpcUrl();
  console.log(`Using RPC: ${rpcUrl ? new URL(rpcUrl).host : '(none configured)'}`);
  console.log(`Collection slug: ${slug}\n`);

  let contract;
  if (slug === OCAS_SLUG) {
    contract = OCAS_CONTRACT; // preserves exact original behavior, no DB round-trip needed
  } else {
    const colRes = await pool.query(`SELECT contract FROM collections WHERE slug=$1`, [slug]);
    if (!colRes.rows[0] || !colRes.rows[0].contract) {
      console.error(`No contract address on file for slug "${slug}" in the collections table -- aborting.`);
      process.exit(1);
    }
    contract = colRes.rows[0].contract;
  }
  console.log(`Contract: ${contract}\n`);

  const flaggedRes = await pool.query(
    `SELECT tx_hash FROM sales WHERE tx_hash IS NOT NULL AND collection_slug = $2
     GROUP BY tx_hash HAVING COUNT(DISTINCT token_id) >= $1`,
    [minTokenCount, slug]
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

    const realTokenIds = realTokenIdsFromReceipt(receipt, contract);

    const rowsRes = await pool.query(
      `SELECT id, token_id FROM sales WHERE tx_hash=$1 AND collection_slug=$2`,
      [txHash, slug]
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
  console.log(`  Collection: ${slug}`);
  console.log(`  Transactions checked: ${txHashes.length}`);
  console.log(`  Lookup failures (skipped): ${lookupFailures}`);
  console.log(`  Rows confirmed CORRECT (token genuinely in that transaction): ${confirmedCorrect}`);
  console.log(`  Rows confirmed WRONG (token NOT in that transaction's real logs): ${confirmedWrong}`);

  const outPath = path.join(__dirname, `wrong-sales-rows-report-${slug}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), slug, minTokenCount, confirmedCorrect, confirmedWrong, lookupFailures, wrongRows }, null, 2));
  console.log(`\nFull list of confirmed-wrong row IDs written to: ${outPath}`);
  console.log('No database changes were made -- this is a report only, for review before any repair.');
}

main().then(() => pool.end()).catch(e => { console.error('Fatal error:', e.message); pool.end(); process.exit(1); });
