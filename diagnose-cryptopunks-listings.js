require('dotenv').config();

const OPENSEA_API_KEY = process.env.OPENSEA_KEY || process.env.OPENSEA_API_KEY;
if (!OPENSEA_API_KEY) { console.error('Missing OPENSEA_API_KEY'); process.exit(1); }

async function fetchRaw(slug) {
  const url = `https://api.opensea.io/api/v2/listings/collection/${slug}/all?chain=ethereum&limit=100`;
  console.log(`\n=== Fetching: ${url} ===`);
  const resp = await fetch(url, {
    headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' }
  });
  console.log(`HTTP status: ${resp.status}`);
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); }
  catch (e) {
    console.log('Response was not valid JSON. Raw text (first 500 chars):');
    console.log(text.slice(0, 500));
    return null;
  }
  console.log('Top-level response keys:', Object.keys(body));
  console.log('Listings array length:', body.listings?.length ?? 'undefined');
  if (body.listings?.length) {
    console.log('First listing (full object):');
    console.log(JSON.stringify(body.listings[0], null, 2));
  } else {
    console.log('Full response body (since listings is empty, showing everything):');
    console.log(JSON.stringify(body, null, 2).slice(0, 2000));
  }
  return body;
}

// Also check the collection endpoint itself, in case the collection record
// reports something useful (e.g. a different canonical slug, or a flag
// about marketplace/order type restrictions)
async function fetchCollectionInfo(slug) {
  const url = `https://api.opensea.io/api/v2/collections/${slug}`;
  console.log(`\n=== Fetching collection info: ${url} ===`);
  const resp = await fetch(url, {
    headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' }
  });
  console.log(`HTTP status: ${resp.status}`);
  const text = await resp.text();
  try {
    const body = JSON.parse(text);
    console.log(JSON.stringify(body, null, 2).slice(0, 2000));
  } catch {
    console.log('Non-JSON response:', text.slice(0, 500));
  }
}

async function main() {
  console.log('################ CRYPTOPUNKS ################');
  await fetchCollectionInfo('cryptopunks');
  await fetchRaw('cryptopunks');

  console.log('\n\n################ HERALDIA (known working) ################');
  await fetchCollectionInfo('heraldia');
  await fetchRaw('heraldia');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
