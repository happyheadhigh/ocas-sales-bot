/**
 * Feasibility test only — no writes. Checks whether the configured RPC
 * provider supports historical eth_call (i.e. "what did tokenURI() return
 * at block X", not just "right now"). This determines whether the WRONG
 * burn_state_snapshots rows found for #2007 (and likely other tokens burned
 * multiple times in quick succession around May 22-26) can be reconstructed
 * with their TRUE historical state, or whether that data is permanently lost
 * and the best we can do is stop showing wrong data (delete the bad rows,
 * show nothing instead) rather than trying to recover it.
 *
 * Standard/free RPC tiers often only serve 'latest' state reliably; archive
 * access (arbitrary historical blocks) is usually a paid-tier feature.
 *
 * USAGE
 *   node test-historical-rpc.js
 */

require('dotenv').config();
const { burnRpcUrl, burnRpc, rpcHostForLog } = require('./lib/rpc');

const TEST_TOKEN_ID = 2007;
const TEST_BLOCK_AFTER_BURN_1 = 25165996; // one block after burn_event #177 (block 25165995)

async function main() {
  const rpcUrl = burnRpcUrl();
  if (!rpcUrl) {
    console.error('No RPC URL configured (checked BURN_RPC_OVERRIDE, ETH_RPC_URL, ALCHEMY_RPC_URL, ALCHEMY_API_KEY).');
    process.exit(1);
  }
  console.log(`Using RPC: ${rpcHostForLog(rpcUrl)}`);

  const paddedId = TEST_TOKEN_ID.toString(16).padStart(64, '0');
  const callData = { to: '0x078be86f3104a32313a47815792230a3808642cc', data: '0xc87b56dd' + paddedId };

  console.log(`\n1. Baseline — current state (blockTag='latest'):`);
  try {
    const latest = await burnRpc(rpcUrl, 'eth_call', [callData, 'latest']);
    console.log(`   OK, got ${latest?.length || 0} chars of response.`);
  } catch (e) {
    console.log(`   FAILED: ${e.message}`);
  }

  console.log(`\n2. Historical — state at block ${TEST_BLOCK_AFTER_BURN_1} (right after #${TEST_TOKEN_ID}'s Burn 1):`);
  try {
    const blockHex = '0x' + TEST_BLOCK_AFTER_BURN_1.toString(16);
    const historical = await burnRpc(rpcUrl, 'eth_call', [callData, blockHex]);
    console.log(`   OK, got ${historical?.length || 0} chars of response.`);
    console.log(`   This RPC provider DOES support historical state -- true per-burn reconstruction is possible.`);
  } catch (e) {
    console.log(`   FAILED: ${e.message}`);
    console.log(`   This likely means the current RPC tier doesn't serve historical/archive state.`);
    console.log(`   True historical reconstruction may need a different provider or a paid archive tier.`);
  }

  console.log(`\n3. Historical — state at a MUCH older block (block 1, sanity check for archive depth):`);
  try {
    const historical = await burnRpc(rpcUrl, 'eth_call', [callData, '0x1']);
    console.log(`   OK — full archive access available.`);
  } catch (e) {
    console.log(`   FAILED: ${e.message} (expected if not a full archive node -- less important than test #2 above)`);
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
