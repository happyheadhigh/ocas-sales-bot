'use strict';

// ── Generic burned-token detection via current on-chain ownership ──────────
// jv: Argonauts has no protocol-level burn mechanic at all -- a third-party
// account was independently running a strategy of buying up Argonauts and
// sending them to a burn/dead address. That's not something any
// collection-specific event or function call announces; it's just an
// ordinary ERC-721 Transfer to an address nobody can ever move a token out
// of again. That makes this fundamentally different from OCAS's own burn
// tracking (lib/db.js's burn_events/burn_event_inputs, which model a real,
// specific multi-token-combines-into-one-survivor mechanic with its own
// on-chain events) -- there's no equivalent mechanic to listen for here.
// The only reliable signal for "is this token still actually ownable" is
// checking who currently owns it and comparing against known dead addresses.
//
// Deliberately NOT unified with OCAS's burn_events-based exclusion in
// rank-compute.js -- that mechanism is correct for what OCAS actually does
// and touching it risks breaking something that already works. This is a
// separate, additional exclusion criterion (tokens.is_burned) that applies
// generically to any collection, OCAS included, alongside its own
// burn_events check rather than instead of it.

const KNOWN_DEAD_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000', // canonical zero address (mint address / permanent burn via safeTransferFrom(owner, address(0), id) on any contract that allows it)
  '0x000000000000000000000000000000000000dead',  // "dead" address convention, widely used as a manual voluntary-burn destination when a contract doesn't allow transferring to the zero address directly
]);

const SUPPORTED_CHAINS = {
  ethereum:  'eth-mainnet',
  base:      'base-mainnet',
  polygon:   'polygon-mainnet',
  robinhood: 'robinhood-mainnet',
};

/**
 * Refreshes tokens.is_burned for every token in a collection by checking
 * current on-chain ownership in bulk (Alchemy's getOwnersForContract,
 * withTokenBalances=true — one paginated call sequence for the whole
 * collection, not one ownerOf() read per token).
 *
 * Always a full resync, not incremental: sets is_burned=true for tokens
 * currently owned by a known dead address, and explicitly false for
 * everything else on file, so a bug or a past incorrect run can never leave
 * a stale true behind with no way to self-correct.
 *
 * @param {import('pg').Pool} pgPool
 * @param {{slug: string, contract: string, chain?: string}} collection
 * @returns {Promise<{checked: number, burned: number}>}
 */
async function refreshBurnedStatus(pgPool, { slug, contract, chain = 'ethereum' }) {
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (!alchemyKey) {
    console.warn(`[burn-detect] [${slug}] No ALCHEMY_API_KEY configured -- skipping`);
    return { checked: 0, burned: 0 };
  }
  const subdomain = SUPPORTED_CHAINS[chain] || SUPPORTED_CHAINS.ethereum;

  const burnedIds = new Set();
  let pageKey = null;
  let ownersScanned = 0;

  do {
    const url = new URL(`https://${subdomain}.g.alchemy.com/nft/v3/${alchemyKey}/getOwnersForContract`);
    url.searchParams.set('contractAddress', contract);
    url.searchParams.set('withTokenBalances', 'true');
    if (pageKey) url.searchParams.set('pageKey', pageKey);

    const r = await fetch(url.toString());
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`getOwnersForContract HTTP ${r.status}: ${body.slice(0, 200)}`);
    }
    const j = await r.json();
    for (const ownerRow of (j.owners || [])) {
      ownersScanned++;
      const ownerLower = String(ownerRow.ownerAddress || '').toLowerCase();
      if (!KNOWN_DEAD_ADDRESSES.has(ownerLower)) continue;
      for (const bal of (ownerRow.tokenBalances || [])) {
        const id = parseInt(bal.tokenId, bal.tokenId?.startsWith?.('0x') ? 16 : 10);
        if (Number.isFinite(id)) burnedIds.add(id);
      }
    }
    pageKey = j.pageKey || null;
  } while (pageKey);

  const idsArray = [...burnedIds];
  await pgPool.query(
    `UPDATE tokens SET is_burned = (id = ANY($2::int[])) WHERE collection_slug = $1`,
    [slug, idsArray]
  );

  console.log(`[burn-detect] [${slug}] Scanned ${ownersScanned} owner(s), found ${idsArray.length} token(s) at a known dead address`);
  return { checked: ownersScanned, burned: idsArray.length };
}

// ── Recurring poller — every collection, low frequency ──────────────────────
// Burns like this aren't time-sensitive the way a live sale or a metadata
// reveal is -- there's no reason a wallet's dead-address transfer needs to
// be reflected in ranks within minutes. Runs far less often than the
// metadata poller (default 6 hours vs that one's 5 minutes) specifically to
// keep this cheap: full ownership sync for a whole collection is a much
// heavier call than the metadata poller's targeted single-token refreshes.
const { pgPool } = require('./db');
const { computeObsRanks } = require('./rank-compute');
const OCAS_SLUG = 'on-chain-all-stars';
const BURN_POLL_INTERVAL_MS = Math.max(60 * 60_000, parseInt(process.env.BURN_DETECT_POLL_MS || String(6 * 60 * 60_000), 10));

let _burnPolling = false;
async function pollBurnedStatusAllCollections(){
  if(_burnPolling) return;
  _burnPolling = true;
  try{
    const res = await pgPool.query(`SELECT slug, contract, chain FROM collections WHERE status = 'ready'`)
      .catch(e => { console.error('[burn-detect] failed to load collections:', e.message); return { rows: [] }; });
    for(const col of res.rows){
      try{
        const result = await refreshBurnedStatus(pgPool, col);
        if(result.burned > 0){
          // Only worth a rank recompute if this cycle actually found
          // something new to exclude -- most cycles for most collections
          // will find nothing, and re-ranking a collection that hasn't
          // changed is wasted work.
          await computeObsRanks(pgPool, col.slug, { isOcas: col.slug === OCAS_SLUG });
        }
      }catch(e){
        console.error(`[burn-detect] poll failed for ${col.slug}:`, e.message);
      }
    }
  }finally{
    _burnPolling = false;
  }
}

function startBurnDetectionPoller(){
  pollBurnedStatusAllCollections().catch(e => console.error('[burn-detect] initial poll failed:', e.message));
  setInterval(() => {
    pollBurnedStatusAllCollections().catch(e => console.error('[burn-detect] poll cycle failed:', e.message));
  }, BURN_POLL_INTERVAL_MS);
  console.log(`[burn-detect] poller started (interval=${BURN_POLL_INTERVAL_MS}ms)`);
}

module.exports = { refreshBurnedStatus, KNOWN_DEAD_ADDRESSES, startBurnDetectionPoller };
