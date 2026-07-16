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
const { backfillCollectionTraits, SUPPORTED_CHAINS } = require('./collection-backfill');
const { seedMarketHistory } = require('../sync-listings');

// Resolves a slug to { slug, contract, chain, name, totalSupply, tokenStandard },
// throwing a specific, human-readable reason for every rejection case
// rather than a generic "not found" or letting a bad collection through to
// a backfill attempt that would just fail partway through.
//
// Chain selection: prefers Ethereum if the collection has a contract there
// (matches historical default — every collection onboarded so far has been
// Ethereum), otherwise picks the first contract on any chain this pipeline
// supports. Always logs which chain was picked when there was more than one
// option, so a multi-chain collection is never a silent guess. Rejects only
// if NONE of the collection's contracts are on a supported chain.
//
// Deliberately single-chain per collection for now, even if a collection
// has contracts on several supported chains — true multi-chain-per-slug
// (backfilling every chain a collection is deployed on, under one registry
// entry) is a real schema change most of the codebase's collection_slug-
// scoped queries aren't built for, and is being deferred until it's
// actually needed rather than guessed at now.
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

  const contracts = coll.contracts || [];
  if(!contracts.length) throw new Error(`Collection "${slug}" has no contracts listed on OpenSea`);

  const supportedContracts = contracts.filter(c => SUPPORTED_CHAINS[c.chain]);
  if(!supportedContracts.length){
    const foundChains = contracts.map(c => c.chain).join(', ') || '(none)';
    throw new Error(`Collection "${slug}" has no contract on a supported chain — found: ${foundChains}; supported: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`);
  }

  const chosen = supportedContracts.find(c => c.chain === 'ethereum') || supportedContracts[0];
  if(supportedContracts.length > 1){
    console.log(`[onboard] ${slug} has contracts on multiple supported chains (${supportedContracts.map(c => c.chain).join(', ')}) — using ${chosen.chain}. Other chains are NOT backfilled — true multi-chain-per-slug isn't built yet.`);
  }

  const contractRes = await fetch(`https://api.opensea.io/api/v2/chain/${chosen.chain}/contract/${chosen.address}`, {
    headers: { 'x-api-key': OPENSEA_API_KEY, 'Accept': 'application/json' }
  });
  if(!contractRes.ok) throw new Error(`OpenSea contract lookup failed for ${chosen.address} on ${chosen.chain}: HTTP ${contractRes.status}`);
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
    contract: chosen.address.toLowerCase(),
    chain: chosen.chain,
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
    INSERT INTO collections (slug, contract, chain, name, status, total_supply, token_standard)
    VALUES ($1, $2, $3, $4, 'pending', $5, $6)
    ON CONFLICT (slug) DO UPDATE SET
      contract = EXCLUDED.contract,
      chain = EXCLUDED.chain,
      name = EXCLUDED.name,
      total_supply = EXCLUDED.total_supply,
      token_standard = EXCLUDED.token_standard,
      status = 'pending',
      error_message = NULL,
      updated_at = NOW()
  `, [resolved.slug, resolved.contract, resolved.chain, resolved.name, resolved.totalSupply, resolved.tokenStandard]);

  console.log(`[onboard] ${resolved.slug} (${resolved.contract}) on ${resolved.chain} — resolved, starting backfill`);

  try{
    await pgPool.query(`UPDATE collections SET status = 'backfilling_traits', updated_at = NOW() WHERE slug = $1`, [resolved.slug]);
    await backfillCollectionTraits(pgPool, { contract: resolved.contract, slug: resolved.slug, chain: resolved.chain });

    // seedMarketHistory moves status through backfilling_market -> ready/failed
    // on its own (built in phase 3) — just hand off to it. Market data comes
    // from OpenSea, which is keyed by slug not chain, so no chain param needed
    // here regardless of which chain the contract itself lives on.
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
