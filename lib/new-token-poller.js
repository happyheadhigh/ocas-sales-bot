/* jv: "new tokens are still being claimed in Argonauts... is there
   something that is capturing those events... and what would happen if
   another collection had the same thing in the future".

   Confirmed gap: lib/metadata-update-poller.js only watches for CHANGES
   to tokens already known to exist (EIP-4906's MetadataUpdate/
   BatchMetadataUpdate events reference a tokenId that already has a
   row here) -- nothing anywhere periodically checked whether a
   collection's on-chain supply had grown and new token IDs now exist
   that were never backfilled at all. This is a general architectural
   gap, not specific to argonauts -- any collection with an open-ended
   or growing supply would hit the exact same blind spot, which is why
   this checks every ready collection, not just one.

   Design: totalSupply() is a single free eth_call (no Alchemy NFT-API
   cost at all -- see fetchOnChainTotalSupply in collection-backfill.js),
   so it's cheap to check FREQUENTLY for every ready collection. The
   actual paid, rate-limited work -- fetching and writing new tokens'
   metadata -- only ever runs when a real gap is found, scoped to just
   the new ID range via the same bulk, concurrent range-fetch helper
   backfillCollectionTraits() itself uses internally, rather than a full
   re-scan of the whole collection every cycle. */

const { pgPool } = require('./db');
const {
  SUPPORTED_CHAINS, fetchOnChainTotalSupply, fetchOnChainMaxId, fetchTokenRangesBulk, writePage,
} = require('./collection-backfill');
const { scheduleRankRecompute } = require('./rank-compute');
const { OCAS_SLUG } = require('./constants');

const CHECK_INTERVAL_MS = 20 * 60_000; // same cadence as runTraitPulseForAllCollections -- cheap enough (one eth_call per collection) to check this often
const PAGE_SIZE = 100;
const RANGES_PER_ROUND = 4; // matches backfillCollectionTraits()'s own "pagination broken" bulk-range mode
const _checking = new Set(); // per-slug guard against overlapping runs, same pattern as _polling in metadata-update-poller.js

// jv: "Argonauts doesn't use [totalSupply()]. Its contract is built
// differently: instead of totalSupply(), it exposes its own functions
// -- traitsOf(tokenId), MAX_ID(), and traitChunks... The fix: swap
// that one check to use MAX_ID() for Argonauts instead, since that's
// the equivalent value in its own architecture... needs to happen
// collection-by-collection rather than assuming every contract looks
// the same." Confirmed via the actual deploy logs: totalSupply()
// reverted for Argonauts specifically. A per-slug override rather than
// a chain-wide or blanket assumption, since this is a per-contract
// design choice, not something tied to which network a collection is
// on -- other collections on the same chain may still use the
// standard totalSupply() just fine.
const SUPPLY_FUNCTION_OVERRIDE = { argonauts: 'maxId' };

async function checkAndBackfillNewTokens(col){
  const { slug, contract, chain } = col;
  // OCAS already has its own, separate, purpose-built token-lifecycle
  // machinery (burn-detect.js, burn_events' survivor mechanic) and a
  // fixed supply that only ever shrinks via burns, never grows via new
  // mints -- backfillCollectionTraits() itself already refuses to run
  // for OCAS for the same reason.
  if(slug === OCAS_SLUG) return;
  if(_checking.has(slug)) return;
  _checking.add(slug);
  try{
    const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
    if(!ALCHEMY_KEY) return;

    const onChainSupply = SUPPLY_FUNCTION_OVERRIDE[slug] === 'maxId'
      ? await fetchOnChainMaxId(contract, chain, ALCHEMY_KEY)
      : await fetchOnChainTotalSupply(contract, chain, ALCHEMY_KEY);
    if(onChainSupply == null) return; // contract doesn't implement the expected function, or the read failed -- nothing safe to compare against

    const knownRes = await pgPool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(MAX(id), -1) AS max_id FROM tokens WHERE collection_slug = $1`,
      [slug]
    );
    const knownCount = knownRes.rows[0]?.cnt || 0;
    const maxKnownId = knownRes.rows[0]?.max_id ?? -1;

    if(onChainSupply <= knownCount) return; // nothing new (a lower on-chain count than what we have just means burns have reduced it, which is tracked separately and isn't this poller's concern)

    // Assumes sequential, 0-or-1-indexed token IDs starting right after
    // the highest one already known -- the overwhelmingly common
    // ERC-721 pattern, and the same assumption backfillCollectionTraits()
    // itself already makes for its own rangeStart-based fallback modes.
    const startId = maxKnownId + 1;
    const newCount = onChainSupply - knownCount;
    console.log(`[new-token-poller] ${slug}: on-chain supply ${onChainSupply} > known ${knownCount} -- backfilling ${newCount} new token(s) starting at #${startId}`);

    const alchemySubdomain = SUPPORTED_CHAINS[chain];
    if(!alchemySubdomain) return;

    let written = 0;
    let cursor = startId;
    const ceiling = startId + newCount + 10; // small buffer past the expected count, same convention as backfillCollectionTraits()'s own supplyCeiling
    while(cursor < ceiling){
      const starts = [];
      for(let k = 0; k < RANGES_PER_ROUND; k++){
        const s = cursor + k * PAGE_SIZE;
        if(s < ceiling) starts.push(s);
      }
      if(!starts.length) break;
      const batchNfts = await fetchTokenRangesBulk(ALCHEMY_KEY, contract, starts, PAGE_SIZE, alchemySubdomain, false);
      if(!batchNfts.length) break;
      const result = await writePage(pgPool, slug, batchNfts, contract, ALCHEMY_KEY, alchemySubdomain, chain);
      written += result.written;
      cursor += starts.length * PAGE_SIZE;
      if(batchNfts.length < starts.length * PAGE_SIZE) break; // Alchemy ran out of real tokens before hitting our ceiling -- done, whatever the exact final count was
    }

    console.log(`[new-token-poller] ${slug}: wrote ${written} new token(s)`);
    if(written > 0){
      await pgPool.query(`UPDATE collections SET total_supply = $2, updated_at = NOW() WHERE slug = $1`, [slug, onChainSupply]).catch(()=>{});
      // Same reasoning as every other trigger of this: new tokens shift
      // everyone else's trait/trait-count frequencies too, not just
      // their own -- a rare trait just got less rare the moment more
      // tokens holding it exist.
      scheduleRankRecompute(pgPool, slug, false);
    }
  }catch(e){
    console.warn(`[new-token-poller] ${slug} check failed:`, e.message);
  }finally{
    _checking.delete(slug);
  }
}

async function checkAllCollectionsForNewTokens(){
  const res = await pgPool.query(
    `SELECT slug, contract, chain FROM collections WHERE status = 'ready' AND contract IS NOT NULL`
  ).catch(e => { console.error('[new-token-poller] failed to load collections:', e.message); return { rows: [] }; });
  for(const col of res.rows){
    // One collection's failure should never block the others -- same
    // isolation pattern as pollMetadataUpdates()'s own per-collection loop.
    await checkAndBackfillNewTokens(col).catch(e => console.warn(`[new-token-poller] ${col.slug} unexpected error:`, e.message));
  }
}

function startNewTokenPoller(){
  checkAllCollectionsForNewTokens().catch(e => console.error('[new-token-poller] initial check failed:', e.message));
  setInterval(() => {
    checkAllCollectionsForNewTokens().catch(e => console.error('[new-token-poller] check cycle failed:', e.message));
  }, CHECK_INTERVAL_MS);
  console.log(`[new-token-poller] started (interval=${CHECK_INTERVAL_MS}ms)`);
}

module.exports = { startNewTokenPoller, checkAllCollectionsForNewTokens, checkAndBackfillNewTokens };
