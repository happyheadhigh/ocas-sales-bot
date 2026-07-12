/**
 * Diagnostic only -- no writes. /traitfind still reports "no trait data
 * found" even after confirming token_traits has correct data. The bot's
 * own call to this endpoint is wrapped in an empty catch(e){} -- if the
 * API call itself is failing for any reason (wrong URL, auth mismatch,
 * network issue), that failure is completely invisible, and the bot would
 * show the exact same "no trait data found" message regardless of the
 * real cause. This bypasses the bot entirely and hits the API directly to
 * see what's actually happening.
 *
 * USAGE
 *   node diag-test-trait-index-endpoint.js
 *
 * Uses RAILWAY_API_URL and API_SECRET from this environment -- run this
 * on the same service (or one with the same env vars) as the bot, so it's
 * testing with the exact same configuration the bot itself is using.
 */

require('dotenv').config();
const fetch = require('node-fetch');

async function main() {
  const base = process.env.RAILWAY_API_URL || process.env.RAILWAY_URL || '';
  const key = process.env.API_SECRET || '';

  console.log(`RAILWAY_API_URL in this environment: ${base || '(EMPTY -- not set!)'}`);
  console.log(`API_SECRET is set: ${key ? 'yes' : 'NO -- not set!'}`);

  if (!base) {
    console.log('\nRAILWAY_API_URL is empty in this environment -- that alone would explain');
    console.log('the bot getting no trait data, since it would have nowhere to ask.');
    return;
  }

  const url = `${base}/db/trait-index?slug=on-chain-all-stars&key=${encodeURIComponent(key)}`;
  console.log(`\nRequesting: ${url.replace(key, '***')}\n`);

  try {
    const res = await fetch(url);
    console.log(`HTTP ${res.status}`);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }

    if (!json) {
      console.log('Response was not valid JSON. Raw response (first 500 chars):');
      console.log(text.slice(0, 500));
      return;
    }

    console.log(`ok: ${json.ok}`);
    console.log(`count: ${json.count}`);
    if (json.error) console.log(`error: ${json.error}`);
    if (Array.isArray(json.traits) && json.traits.length) {
      console.log('\nFirst 3 traits returned:');
      for (const t of json.traits.slice(0, 3)) {
        console.log(`  ${t.trait_name}: ${t.trait_value} (${t.token_count} tokens)`);
      }
    }
  } catch (e) {
    console.log(`\nRequest itself failed (this is exactly the kind of error the bot's empty`);
    console.log(`catch block would be silently swallowing): ${e.message}`);
  }
}

main();
