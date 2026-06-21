require('dotenv').config();

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
if (!ALCHEMY_KEY) { console.error('Missing ALCHEMY_API_KEY/ALCHEMY_KEY'); process.exit(1); }

async function main(){
  // Use the exact same endpoint the backfill actually calls (OCAS contract,
  // 1 token, just to get real headers back — not a real backfill run).
  const url = new URL(`https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTsForContract`);
  url.searchParams.set('contractAddress', '0x078be86f3104a32313a47815792230a3808642cc');
  url.searchParams.set('withMetadata', 'true');
  url.searchParams.set('limit', '1');

  console.log('=== Single request — inspecting real response headers ===');
  const r = await fetch(url.toString());
  console.log(`HTTP status: ${r.status}`);
  console.log('\nAll response headers:');
  for(const [key, value] of r.headers.entries()){
    console.log(`  ${key}: ${value}`);
  }

  // Check Alchemy's dedicated app-config endpoint, which directly reports
  // the plan/tier this specific key is provisioned under, if accessible.
  console.log('\n=== Checking account/app tier info ===');
  try{
    const tierUrl = `https://dashboard.alchemy.com/api/app-data?apiKey=${ALCHEMY_KEY}`;
    const tr = await fetch(tierUrl);
    console.log(`Tier endpoint status: ${tr.status}`);
    if(tr.ok){
      const tj = await tr.json();
      console.log(JSON.stringify(tj, null, 2).slice(0, 1500));
    } else {
      console.log('(Tier endpoint not accessible this way — expected, this requires dashboard auth not an API key. Relying on response headers above instead.)');
    }
  }catch(e){
    console.log('Tier endpoint check failed (expected):', e.message);
  }

  // Burst test: fire 10 rapid concurrent requests and see if any hit 429,
  // and read back any rate-limit-specific headers if present.
  console.log('\n=== Burst test: 10 concurrent requests ===');
  const burstUrl = new URL(`https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTsForContract`);
  burstUrl.searchParams.set('contractAddress', '0x078be86f3104a32313a47815792230a3808642cc');
  burstUrl.searchParams.set('withMetadata', 'true');
  burstUrl.searchParams.set('limit', '1');

  const results = await Promise.all(
    Array.from({length: 10}, () => fetch(burstUrl.toString()).then(res => ({
      status: res.status,
      remaining: res.headers.get('x-ratelimit-remaining') || res.headers.get('ratelimit-remaining') || null,
      limit: res.headers.get('x-ratelimit-limit') || res.headers.get('ratelimit-limit') || null,
    })))
  );
  console.log(JSON.stringify(results, null, 2));
  const any429 = results.some(r => r.status === 429);
  console.log(`\nAny 429s in burst of 10 concurrent requests: ${any429}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
