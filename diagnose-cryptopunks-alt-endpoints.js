require('dotenv').config();

const OPENSEA_API_KEY = process.env.OPENSEA_KEY || process.env.OPENSEA_API_KEY;
if (!OPENSEA_API_KEY) { console.error('Missing OPENSEA_API_KEY'); process.exit(1); }

async function fetchAndPrint(label, url) {
  console.log(`\n=== ${label}: ${url} ===`);
  const resp = await fetch(url, {
    headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' }
  });
  console.log(`HTTP status: ${resp.status}`);
  const text = await resp.text();
  try {
    const body = JSON.parse(text);
    console.log(JSON.stringify(body, null, 2).slice(0, 3000));
  } catch {
    console.log('Non-JSON:', text.slice(0, 500));
  }
}

async function main() {
  // Stats endpoint — the live OpenSea page showed a real 26.64 ETH floor,
  // so this should confirm whether that number comes from the same
  // listings data source or something else entirely.
  await fetchAndPrint('CryptoPunks stats', 'https://api.opensea.io/api/v2/collections/cryptopunks/stats');

  // Try fetching a SPECIFIC known token's listings directly, bypassing the
  // collection-wide endpoint entirely, to see if per-NFT listing data
  // exists even when the collection-wide endpoint returns empty.
  // Using token #242, which the live OpenSea page showed listed at 26.64 ETH.
  await fetchAndPrint(
    'CryptoPunk #242 direct NFT lookup',
    'https://api.opensea.io/api/v2/chain/ethereum/contract/0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb/nfts/242'
  );

  // Try the best-listing-for-NFT endpoint for that same specific token
  await fetchAndPrint(
    'CryptoPunk #242 best listing',
    'https://api.opensea.io/api/v2/listings/collection/cryptopunks/nfts/242/best'
  );
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
