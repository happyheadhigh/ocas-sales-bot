'use strict';

// ── Collection onboarding orchestrator ───────────────────────────────────────
// The actual "someone types a slug nobody's searched before" entry point.
// Resolves the slug via OpenSea, validates it's onboardable, creates the
// collections registry row (phase 1), then runs the trait/image backfill
// (existing collection-backfill.js) followed by the market history seed
// (phase 3, sync-listings.js) in sequence.
//
// Field mapping verified directly against OpenSea's published OpenAPI spec
// for get_collection and get_contract (fetched and read, not guessed from
// docs prose) — same discipline as the Stream API work, since getting a
// field wrong here would either silently reject valid collections or waste
// a full backfill attempt on something unsupported.

const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || process.env.OPENSEA_KEY;
const { backfillCollectionTraits } = require('./collection-backfill');
const { seedMarketHistory } = require('../sync-listings');

// Resolves a slug to { slug, contract, name, totalSupply, tokenStandard },
// throwing a specific, human-readable reason for every rejection case
// rather than a generic "not found" or letting a bad collection through to
// a backfill attempt that would just fail partway through.
async function resolveCollectionForOnboarding(slug){
  if(!OPENSEA_API_KEY) throw new Error('Missing OPENSEA_API_KEY/OPENSEA_KEY env var');

  const collRes = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`, {
    headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' }
  });
  if(collRes.status === 404) throw new Error(`No OpenSea collection found for slug "${slug}"`);
  if(!collRes.ok) throw new Error(`OpenSea collection lookup failed for "${slug}": HTTP ${collRes.status}`);
  const coll = await collRes.json();

  if(coll.is_disabled) throw new Error(`Collection "${slug}" is disabled on OpenSea`);
  if(coll.is_nsfw) throw new Error(`Collection "${slug}" is flagged NSFW on OpenSea — not onboarding automatically`);

  const ethContract = (coll.contracts || []).find(c => c.chain === 'ethereum');
  if(!ethContract) throw new Error(`Collection "${slug}" has no Ethereum contract — this pipeline (Alchemy-based backfill) only supports Ethereum mainnet collections right now`);

  const contractRes = await fetch(`https://api.opensea.io/api/v2/chain/ethereum/contract/${ethContract.address}`, {
    headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' }
  });
  if(!contractRes.ok) throw new Error(`OpenSea contract lookup failed for ${ethContract.address}: HTTP ${contractRes.status}`);
  const contractMeta = await contractRes.json();

  // The actual guard against CryptoPunks-style pre-Seaport collections
  // (contract_standard: "cryptopunks") and anything else non-standard —
  // confirmed and accepted as a known limitation earlier, not pursued
  // further at the time. ERC-1155 is also excluded for now since the rest
  // of this pipeline (one-owner-per-token assumptions in wallet/portfolio
  // logic) isn't built for multi-edition tokens.
  if(contractMeta.contract_standard !== 'erc721'){
    throw new Error(`Collection "${slug}" is "${contractMeta.contract_standard}", not erc721 — not supported by this pipeline yet (e.g. CryptoPunks-style legacy contracts and ERC-1155 editions aren't handled)`);
  }

  return {
    slug: coll.collection || slug,
    contract: ethContract.address.toLowerCase(),
    name: coll.name || slug,
    totalSupply: coll.total_supply || null,
    tokenStandard: contractMeta.contract_standard,
  };
}

// Full onboarding: resolve + validate, upsert the registry row, then run
// trait/image backfill followed by market history seed. Safe to call again
// for an already-onboarded slug (upsert + idempotent backfill functions
// throughout) — but refuses to start a SECOND concurrent run for a slug
// that's already mid-backfill, to avoid two jobs hammering OpenSea/Alchemy
// for the same collection at once.
async function onboardCollection(pgPool, rawSlug){
  const resolved = await resolveCollectionForOnboarding(rawSlug);

  const existing = await pgPool.query(`SELECT status FROM collections WHERE slug = $1`, [resolved.slug]);
  if(existing.rows.length && ['backfilling_traits', 'backfilling_market'].includes(existing.rows[0].status)){
    throw new Error(`Onboarding already in progress for "${resolved.slug}" (status: ${existing.rows[0].status}) — not starting a second one`);
  }

  await pgPool.query(`
    INSERT INTO collections (slug, contract, name, status, total_supply, token_standard)
    VALUES ($1, $2, $3, 'pending', $4, $5)
    ON CONFLICT (slug) DO UPDATE SET
      contract = EXCLUDED.contract,
      name = EXCLUDED.name,
      total_supply = EXCLUDED.total_supply,
      token_standard = EXCLUDED.token_standard,
      status = 'pending',
      error_message = NULL,
      updated_at = NOW()
  `, [resolved.slug, resolved.contract, resolved.name, resolved.totalSupply, resolved.tokenStandard]);

  console.log(`[onboard] ${resolved.slug} (${resolved.contract}) — resolved, starting backfill`);

  try{
    await pgPool.query(`UPDATE collections SET status = 'backfilling_traits', updated_at = NOW() WHERE slug = $1`, [resolved.slug]);
    await backfillCollectionTraits(pgPool, { contract: resolved.contract, slug: resolved.slug });

    // seedMarketHistory moves status through backfilling_market -> ready/failed
    // on its own (built in phase 3) — just hand off to it.
    await seedMarketHistory({ slug: resolved.slug, contract: resolved.contract });

    console.log(`[onboard] ${resolved.slug} fully onboarded`);
    return resolved;
  }catch(e){
    await pgPool.query(
      `UPDATE collections SET status = 'failed', error_message = $2, updated_at = NOW() WHERE slug = $1`,
      [resolved.slug, e.message]
    ).catch(dbErr => console.error(`[onboard] ${resolved.slug} also failed to record error status:`, dbErr.message));
    console.error(`[onboard] ${resolved.slug} failed:`, e.message);
    throw e;
  }
}

module.exports = { resolveCollectionForOnboarding, onboardCollection };
