/**
 * Feasibility test only — no writes, doesn't touch the bot's own DB or
 * config at all. Checks whether OpenSea's CURRENT v2 accounts endpoint
 * exposes the bio field, and whether bio edits show up promptly or only
 * after some caching delay -- both open questions before building bio-based
 * verification as an alternative to requiring a username change.
 *
 * An earlier attempt at bio-based detection (on OpenSea's older API) found
 * nothing came through on the free tier. Official docs for the CURRENT v2
 * endpoint (docs.opensea.io/reference/get_account, updated ~1 month ago as
 * of this writing) explicitly list bio in the response schema, so this is
 * worth re-testing against what's actually live today rather than assuming
 * the old result still holds.
 *
 * USAGE
 *   node test-opensea-bio.js <wallet-address-or-os-username>
 *
 * SUGGESTED TEST SEQUENCE
 *   1. Run once now, note the "bio" value printed.
 *   2. Go edit that account's bio on opensea.io.
 *   3. Run again immediately -- does the new bio show up right away?
 *   4. If not, wait a few minutes and run again -- if it shows up THEN,
 *      that's a caching delay, not "bio isn't exposed at all" (a real but
 *      much smaller problem than what was hit before).
 */

require('dotenv').config();
const fetch = require('node-fetch');

const OPENSEA_KEY = process.env.OPENSEA_API_KEY;
const target = process.argv[2];

if (!target) {
  console.log('Usage: node test-opensea-bio.js <wallet-address-or-os-username>');
  process.exit(1);
}
if (!OPENSEA_KEY) {
  console.log('No OPENSEA_API_KEY found in environment -- this script uses the exact same key/header pattern the bot already uses everywhere else (lib/constants.js osHeaders()), so if this is missing, the bot itself would be missing it too.');
  process.exit(1);
}

async function main() {
  const url = `https://api.opensea.io/api/v2/accounts/${encodeURIComponent(target)}`;
  console.log(`Requesting: ${url}\n`);

  const res = await fetch(url, {
    headers: { 'X-API-KEY': OPENSEA_KEY, 'Accept': 'application/json' },
  });

  console.log(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    console.log('Response was not valid JSON:');
    console.log(text);
    return;
  }

  console.log('\nFull response:');
  console.log(JSON.stringify(json, null, 2));

  console.log('\n--- Key fields for the verification question ---');
  console.log('username:', json.username ?? '(none)');
  console.log('bio:     ', json.bio ?? '(none / empty)');
  console.log('address: ', json.address ?? '(none)');

  if (json.bio === undefined) {
    console.log('\nbio field is completely absent from the response -- would need to look at whether a different endpoint or auth level exposes it.');
  } else if (!json.bio) {
    console.log('\nbio field IS present in the response but currently empty -- the endpoint supports it, this account just hasn\'t set one (or it was just cleared). Try setting a bio and re-running.');
  } else {
    console.log('\nbio field is present and has a value -- this is the core capability needed. Next: re-run after editing the bio to check freshness/caching.');
  }
}

main().catch(e => {
  console.error('Request failed:', e.message);
  process.exit(1);
});
