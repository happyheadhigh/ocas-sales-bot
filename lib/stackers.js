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

const NFT_ADDRESS    = '0x968C5F0b6fE2F77b221F5e015C955f32f9A50507';
const ENGINE_ADDRESS = '0xB0CC447d9aCE8aFB9AC4dae763afcf911c7E5CdA';
const VAULT_ADDRESS  = '0x7908Ec7D5fD5927CB7f667b095b671285CE6919F';
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
  _provider = new ethers.JsonRpcProvider(`https://robinhood-mainnet.g.alchemy.com/v2/${key}`);
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
    guessedMultiplier: Number(weightRaw) / 10000, // UNCONFIRMED — verify against TIER_WEIGHT(0) live
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
      ? `Tier ${info.tier.index + 1} (${info.tier.weight.guessedMultiplier.toFixed(1)}×)` // guessedMultiplier is unconfirmed — see formatTierWeight
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

module.exports = {
  STACKERS_SLUG,
  NFT_ADDRESS, ENGINE_ADDRESS, VAULT_ADDRESS,
  getProvider, getContracts,
  getStackerInfo,
  getTierThresholds,
  resolveAsset,
  formatStackersFields,
};
