'use strict';

// ── Stackers on-chain reader ──────────────────────────────────────────────────
// Reads live state from the three Stackers contracts (NFT, earning engine,
// vault) on Robinhood Chain. Uses ethers.js rather than the hand-rolled raw
// eth_call/hex-decode pattern used elsewhere in this codebase — those
// contracts only ever return single string values (tokenURI), which is
// simple to decode by hand. These contracts return arrays and multi-field
// structs (balancesOf, tokenState), which is meaningfully more error-prone
// to hand-decode correctly, especially without a way to test locally before
// this runs live. ethers.Contract takes the ABI directly and handles that
// encoding/decoding, which is the safer choice for this specific case.
//
// Two things below are flagged explicitly as unconfirmed and need a live
// test against the real contract before being trusted — search "NEEDS LIVE
// VERIFICATION" for both. Everything else here is either a direct read with
// no interpretation needed, or logic that discovers its own bounds from the
// chain rather than hardcoding assumptions.

const { ethers } = require('ethers');

// Migrated again 19 Aug 2026 -- this time NFT, engine, AND vault all moved
// together. Confirmed via Stackers' own official docs page
// (https://stackers.cash/docs) plus independently verified every function
// this codebase actually calls still exists with an identical signature on
// the new contracts before making this change:
//   - engine.splitOf(uint256) -> (uint8[3],uint16[3],uint8): confirmed via
//     Blockscout's verified ABI for the new engine -- exact match.
//   - vault.balancesOf(uint256) -> (address[],uint256[]): confirmed via
//     Blockscout's verified ABI for the new vault -- exact match.
//   - nft.tierBurned(uint256) -> uint256 and nft.isActive(uint256) -> bool:
//     the new NFT contract is unverified on Blockscout (both the proxy
//     itself and its resolved EIP-1967 implementation), so these were
//     confirmed via a raw eth_call probe instead -- both returned real,
//     sane-looking values (a genuine tierBurned amount, isActive=true) for
//     token 1, not reverts.
// Previous (Aug 17-19) engine/vault, now also retired:
//   engine 0xca32351c41D6CbBD84353FEC7d0438BBb869364A
//   vault  0xBa5DB450613420AA3D8Dfbf963523f9C87A2aA48
// Even earlier (Aug 10-17) engine, retired before that:
//   0xB0CC447d9aCE8aFB9AC4dae763afcf911c7E5CdA
// Kept here only for reference, none in use.
//
// NOTE: this migration's EVENTS changed names/fields on the engine
// (Merged -> Absorbed, with a renamed deadId field and a new creditMoved
// field; Credited/Claimed no longer exist on the engine at all -- Claimed
// likely moved to the vault, which now exposes claim()/claimFor()/claimOne()
// directly). The event-driven listeners (lib/stackers-fusion-poller.js,
// lib/stackers-live-events.js) have NOT been updated for this yet and will
// need real code changes, not just address swaps, before real-time
// merge/fusion Discord alerts work again. This address update alone is
// sufficient for the STATS side (lib/stackers-analytics.js's snapshot job),
// which reads via the function calls above, not the changed events.
const NFT_ADDRESS    = '0x8C646c7D3f9Af3afd6cDccd3dc00A01Bf2d1298d';
const ENGINE_ADDRESS = '0x23098b7307b5b6c4b14DbA655813d245DbE4064b';
const VAULT_ADDRESS  = '0x8c9D1F0fbd54d7e80a6A8A896F4FEc0f2D04A4A2';
// Deliberately NOT changed to 'stackersv2' (OpenSea's current real slug for
// this collection) -- confirmed this is used purely as an internal DB key/
// routing label throughout this codebase (collection_slug column values,
// internal "is this Stackers" checks), never to construct a live OpenSea
// API call. Renaming it would require a matching SQL migration to relabel
// every existing tokens/token_traits/listings row already tagged
// 'stackersxyz', or all of that existing scraped data would silently
// orphan. Leaving it as-is avoids that risk entirely since there's no
// functional reason it needs to match OpenSea's current slug.
const STACKERS_SLUG  = 'stackersxyz';

const NFT_ABI    = require('./stackers-abis/nft.json');
const ENGINE_ABI = require('./stackers-abis/engine.json');
const VAULT_ABI  = require('./stackers-abis/vault.json');

// Minimal ERC-20 ABI — just enough to resolve a token address into a
// human-readable symbol and its real decimals (not assumed to be 18 for
// every asset here; USDG and various tokenized-stock wrappers may differ).
const ERC20_MINI_ABI = [
  { inputs: [], name: 'symbol',   outputs: [{ type: 'string' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'decimals', outputs: [{ type: 'uint8'  }], stateMutability: 'view', type: 'function' },
];

let _provider = null;
function getProvider(){
  if(_provider) return _provider;
  const key = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  if(!key) throw new Error('Missing ALCHEMY_API_KEY/ALCHEMY_KEY env var');
  // Explicit timeout — JsonRpcProvider has none by default, same missing-
  // timeout pattern that caused a genuinely painful multi-hour debugging
  // session earlier tonight with node-fetch calls elsewhere in this
  // codebase. Robinhood Chain's Alchemy endpoint has already proven
  // unreliable more than once tonight (403s, 429s, a 10-block eth_getLogs
  // cap) — without this, a single slow/hung call anywhere inside
  // getStackerInfo() would leave a command stuck on "thinking..." forever,
  // with no error and no way to recover short of a manual restart.
  const fetchRequest = new ethers.FetchRequest(`https://robinhood-mainnet.g.alchemy.com/v2/${key}`);
  fetchRequest.timeout = 15000;
  _provider = new ethers.JsonRpcProvider(fetchRequest);
  return _provider;
}

function getContracts(){
  const provider = getProvider();
  return {
    nft:    new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider),
    engine: new ethers.Contract(ENGINE_ADDRESS, ENGINE_ABI, provider),
    vault:  new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider),
  };
}

// Asset addresses never change once set — cache symbol/decimals lookups
// rather than re-reading them on every call.
const _assetCache = new Map();
async function resolveAsset(tokenAddress, provider){
  const key = tokenAddress.toLowerCase();
  if(_assetCache.has(key)) return _assetCache.get(key);
  let result;
  try{
    const erc20 = new ethers.Contract(tokenAddress, ERC20_MINI_ABI, provider);
    const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
    result = { symbol, decimals: Number(decimals) };
  }catch(e){
    console.warn(`[stackers] Failed to resolve asset ${tokenAddress}:`, e.message);
    result = { symbol: tokenAddress.slice(0, 8), decimals: 18 }; // fallback only — not a real assumption, just keeps callers from crashing
  }
  _assetCache.set(key, result);
  return result;
}

// Walks TIER_BURN(0), TIER_BURN(1), ... until a call reverts, to discover how
// many tiers actually exist on-chain rather than hardcoding the 5 the docs
// describe — if that ever changes, this keeps working without a code edit.
let _tierThresholdsCache = null;
async function getTierThresholds(nft){
  if(_tierThresholdsCache) return _tierThresholdsCache;
  const thresholds = [];
  for(let i = 0; i < 20; i++){ // sane upper bound, not expected to ever be reached
    try{
      const [burn, weight] = await Promise.all([nft.TIER_BURN(i), nft.TIER_WEIGHT(i)]);
      thresholds.push({ index: i, burn: BigInt(burn), weightRaw: BigInt(weight) });
    }catch(e){
      break; // reverted — no tier configured at this index, stop here
    }
  }
  _tierThresholdsCache = thresholds;
  return thresholds;
}

// Given a token's cumulative $STACK burned, finds which tier that lands in
// using the real on-chain thresholds.
function resolveTier(tierBurned, thresholds){
  let current = null;
  for(const t of thresholds){
    if(tierBurned >= t.burn) current = t;
    else break;
  }
  return current;
}

// NEEDS LIVE VERIFICATION: TIER_WEIGHT's fixed-point scale is not confirmed.
// It returns a uint16 representing something like "1.0x to 3.5x" per the
// docs, but the actual scaling factor (basis points where 10000=1.0x? a
// simpler x100 scale? something else?) isn't knowable from the ABI alone —
// the ABI only tells us the type, not the convention. This function returns
// the raw value alongside a best-guess basis-points conversion, clearly
// labeled, rather than presenting a guess as fact. Confirm by reading
// TIER_WEIGHT(0) live — the base tier should represent exactly 1.0x, so
// whatever raw number comes back tells us the true scale directly.
function formatTierWeight(weightRaw){
  return {
    raw: weightRaw,
    // CONFIRMED via live on-chain read: raw values are 100/140/190/250/350
    // for tiers 0-4. Dividing by 100 gives exactly 1.0x/1.4x/1.9x/2.5x/3.5x,
    // matching the tier multipliers described in Stackers' own docs exactly,
    // including the 3.5x ceiling on the top tier. Originally guessed at
    // basis-10000 (basis-points style) — the real scale is basis-100.
    multiplier: Number(weightRaw) / 100,
  };
}

// Full on-chain picture for a single Stacker: tier, active status, chosen
// split (with resolved asset names), and current vault balance (with
// resolved asset names + real decimals). Everything an embed would need,
// in one call.
async function getStackerInfo(tokenId){
  const provider = getProvider();
  const { nft, engine, vault } = getContracts();

  const [tierBurnedRaw, isActive, splitRaw, balancesRaw, thresholds] = await Promise.all([
    nft.tierBurned(tokenId),
    nft.isActive(tokenId),
    engine.splitOf(tokenId),
    vault.balancesOf(tokenId),
    getTierThresholds(nft),
  ]);

  const tierBurned = BigInt(tierBurnedRaw);
  const tier = resolveTier(tierBurned, thresholds);

  // splitOf returns (uint8[3] assetIdxs, uint16[3] weightsBps, uint8 count)
  const [assetIdxs, splitWeightsBps, splitCount] = splitRaw;
  const split = [];
  for(let i = 0; i < Number(splitCount); i++){
    // assetToken lives on the vault contract, not the engine — the engine's
    // own per-asset lookup (assets(idx)) returns a larger struct (pool
    // addresses, fee tiers) for its own internal routing needs; the vault's
    // simpler assetToken(idx) is the direct address lookup, and both
    // contracts share the same index scheme.
    const tokenAddress = await vault.assetToken(assetIdxs[i]);
    const { symbol } = await resolveAsset(tokenAddress, provider);
    split.push({ symbol, weightPct: Number(splitWeightsBps[i]) / 100 });
  }

  // balancesOf returns (address[] tokens, uint256[] amounts) as parallel arrays
  const [balanceTokens, balanceAmounts] = balancesRaw;
  const balances = [];
  for(let i = 0; i < balanceTokens.length; i++){
    if(balanceAmounts[i] === 0n) continue; // skip zero balances, nothing to show
    const { symbol, decimals } = await resolveAsset(balanceTokens[i], provider);
    balances.push({
      symbol,
      amountRaw: balanceAmounts[i],
      amountFormatted: ethers.formatUnits(balanceAmounts[i], decimals),
    });
  }

  return {
    tokenId,
    isActive,
    tierBurned,
    tier: tier ? { index: tier.index, weight: formatTierWeight(tier.weightRaw) } : null,
    split,
    balances,
  };
}

// Lightweight variant of getStackerInfo — tier, active status, and split
// only, deliberately skipping vault.balancesOf and its per-asset resolution
// loop entirely. Exists because tier/active/split all have dedicated
// on-chain events (Activated, Deactivated, TierUpgraded, SplitSet) that can
// be watched continuously going forward, unlike vault balance which changes
// via hourly accrual and has no such confirmed event mapping yet — so this
// data can be kept genuinely live via a poller, while vault balance still
// needs the slower periodic full sweep. Used by the status poller's
// event-triggered updates and its one-time backfill/reseed.
async function getStackerStatusOnly(tokenId){
  const provider = getProvider();
  const { nft, engine, vault } = getContracts();

  const [tierBurnedRaw, isActive, splitRaw, thresholds] = await Promise.all([
    nft.tierBurned(tokenId),
    nft.isActive(tokenId),
    engine.splitOf(tokenId),
    getTierThresholds(nft),
  ]);

  const tierBurned = BigInt(tierBurnedRaw);
  const tier = resolveTier(tierBurned, thresholds);

  const [assetIdxs, splitWeightsBps, splitCount] = splitRaw;
  const split = [];
  for(let i = 0; i < Number(splitCount); i++){
    const tokenAddress = await vault.assetToken(assetIdxs[i]);
    const { symbol } = await resolveAsset(tokenAddress, provider);
    split.push({ symbol, weightPct: Number(splitWeightsBps[i]) / 100 });
  }

  return {
    tokenId,
    isActive,
    tierIndex: tier ? tier.index : null,
    split,
  };
}

// Formats a getStackerInfo() result into Discord embed fields — shared
// across every command/embed that shows Stacker-specific info, so this
// formatting logic exists once rather than being duplicated per file.
// Fails safe: any error returns an empty array, so the calling embed still
// posts normally, just without the extra fields, rather than breaking the
// whole embed over a Stackers-specific read failing.
async function formatStackersFields(tokenId){
  try{
    const info = await getStackerInfo(tokenId);
    const fields = [];

    const tierLabel = info.tier
      ? `Tier ${info.tier.index + 1} (${info.tier.weight.multiplier.toFixed(1)}×)`
      : 'Not yet tiered';
    fields.push({
      name: '📦 Stacker Status',
      value: `${info.isActive ? '🟢 Active' : '⚪ Asleep'} · ${tierLabel}`,
      inline: false,
    });

    if(info.split.length){
      const splitText = info.split.map(s => `${s.symbol} — ${s.weightPct}%`).join('\n');
      fields.push({ name: '🎯 Earning Split', value: splitText, inline: true });
    }

    const balanceText = info.balances.length
      ? info.balances.map(b => `${parseFloat(b.amountFormatted).toFixed(4)} ${b.symbol}`).join('\n')
      : 'Empty';
    fields.push({ name: '🏦 Vault Balance', value: balanceText, inline: true });

    return fields;
  }catch(e){
    console.warn(`[stackers] Failed to format fields for token ${tokenId}:`, e.message);
    return [];
  }
}

// Plain-text sibling of formatStackersFields, for commands that reply with
// a plain content string rather than an embed (currently just /download).
// Same underlying data, same fail-safe behavior (empty string on error).
async function formatStackersText(tokenId){
  try{
    const info = await getStackerInfo(tokenId);
    const lines = [];

    const tierLabel = info.tier
      ? `Tier ${info.tier.index + 1} (${info.tier.weight.multiplier.toFixed(1)}×)`
      : 'Not yet tiered';
    lines.push(`${info.isActive ? '🟢 Active' : '⚪ Asleep'} · ${tierLabel}`);

    if(info.split.length){
      lines.push(`Split: ${info.split.map(s => `${s.symbol} ${s.weightPct}%`).join(', ')}`);
    }

    lines.push(info.balances.length
      ? `Vault: ${info.balances.map(b => `${parseFloat(b.amountFormatted).toFixed(4)} ${b.symbol}`).join(', ')}`
      : 'Vault: empty');

    return lines.join('\n');
  }catch(e){
    console.warn(`[stackers] Failed to format text for token ${tokenId}:`, e.message);
    return '';
  }
}

module.exports = {
  STACKERS_SLUG,
  NFT_ADDRESS, ENGINE_ADDRESS, VAULT_ADDRESS,
  getProvider, getContracts,
  getStackerInfo,
  getStackerStatusOnly,
  getTierThresholds,
  resolveAsset,
  formatStackersFields,
  formatStackersText,
};
