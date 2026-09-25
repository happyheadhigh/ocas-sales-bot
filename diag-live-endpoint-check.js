/**
 * Diagnostic only -- no writes, no simulation this time. My earlier
 * diag-simulate-wallet-burn-stats.js deliberately skipped the mint-time
 * fallback (see its own comment: "not checking mint fallback here"), so its
 * "null" output for #901 wasn't actually proof the live endpoint returns
 * null -- I misread an intentionally incomplete simulation as if it were
 * the real thing. This calls the ACTUAL running API directly instead,
 * removing that whole class of mistake.
 *
 * USAGE
 *   node diag-live-endpoint-check.js <walletAddress>
 *
 * Uses the same API_SECRET/base URL env vars the bot itself uses.
 */

require('dotenv').config();
const fetch = require('node-fetch');
const crypto = require('crypto');

function hash(s) { return s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 16) : null; }

const address = (process.argv[2] || '').trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.log('Usage: node diag-live-endpoint-check.js <walletAddress>');
  process.exit(1);
}

async function main() {
  // The bot and API service are separate Railway services in separate
  // containers -- localhost wouldn't reach the API from the bot's own
  // console. Using the known public staging URL instead, which works
  // regardless of which service's console this actually runs from.
  const base = process.env.RAILWAY_API_URL || 'https://successful-healing-production-2f7e.up.railway.app';
  const key = process.env.API_SECRET || 'AllStarSecret2k26TV';
  const url = `${base}/db/wallet/${encodeURIComponent(address)}/burn-stats?key=${encodeURIComponent(key)}`;

  console.log(`\nRequesting: ${url}\n`);
  const res = await fetch(url);
  console.log(`HTTP ${res.status}`);
  const data = await res.json();

  const event146 = (data.events || []).find(e => e.burnEventId === 146);
  if (!event146) {
    console.log('\nEvent 146 not found in this response -- printing all event IDs returned instead:');
    console.log((data.events || []).map(e => e.burnEventId).join(', '));
    return;
  }

  console.log('\n=== Event 146 (the exact card in question) ===');
  console.log(JSON.stringify(event146, null, 2));

  console.log('\n=== input_snapshots keys touching token 901 or event 146 ===');
  const relevant = Object.entries(data.input_snapshots || {}).filter(([k]) => k.includes(':901') || k.startsWith('146:'));
  for (const [k, v] of relevant) {
    console.log(`  "${k}": hash=${hash(v)}  length=${v ? v.length : 0}`);
  }
  if (!relevant.length) {
    console.log('  (no matching keys found at all -- neither "146:*" nor "*:901" exists in input_snapshots)');
  }

  console.log('\n=== Direct comparison ===');
  const survivorHash = hash(event146.survivorSnapshotImage);
  const burnedRowHash = hash((data.input_snapshots || {})['146:901']);
  console.log(`  Event 146 survivor image (#901, current card's survivor row): ${survivorHash}`);
  console.log(`  Event 146 input_snapshots["146:901"] (the Burned row's #901):  ${burnedRowHash}`);
  if (survivorHash && survivorHash === burnedRowHash) {
    console.log('\n  MATCH: the API itself is returning the identical image for both the');
    console.log('  survivor slot and the burned slot -- this IS the actual bug, and it\'s in the');
    console.log('  backend response, not the frontend. Since #901\'s mint-time snapshot is');
    console.log('  confirmed to genuinely differ from this, something is resolving to the wrong');
    console.log('  value here despite the fallback data being available and correct.');
  } else {
    console.log('\n  DIFFERENT: the API is returning two genuinely different images for these');
    console.log('  two slots. If the page is still showing the same look for both, the bug is');
    console.log('  in the frontend, not this endpoint.');
  }
}

main().catch(e => { console.error('Request failed:', e.message); process.exit(1); });
