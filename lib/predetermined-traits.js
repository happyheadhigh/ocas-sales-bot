// ── Predetermined on-chain trait backfill ──────────────────────────────────
//
// Built for Argonauts, generalized for any future collection with the same
// architecture. jv confirmed live via the verified contract source
// (0x387c41b0b2f1128de44db1bcf8baad085f26392c): this contract has NO
// totalSupply() and no conventional sequential mint — ACK holders claim a
// specific, pre-assigned token ID whenever they like, no deadline, so most
// of the 9,999-token collection can be genuinely unclaimed at any time.
//
// That's why the normal Alchemy/OpenSea-indexed-NFT backfill (collection-
// backfill.js) can only ever see currently-minted tokens: OpenSea, Alchemy,
// tokenURI() and ownerOf() are all fundamentally ownership-gated. But the
// contract's own traitsOf(tokenId) has none of that — it just reads a fixed
// 7-byte row from a trait table that's written ONCE before the sale opens
// and permanently frozen after (setPool() locks setTraitChunk() forever).
// Confirmed live: ownerOf(21) reverts (unclaimed) while traitsOf(21) still
// returns real data ([8,4,0,0,2,0,5]) — the traits exist independently of
// who owns what, for the entire eventual collection, right now.
//
// The renderer contract's own tokenURI(tokenId, traits, printed) — a
// separate contract, found via the main contract's `renderer` getter — has
// no ownership check at all either, and builds the exact same
// attributes/image JSON the official site is built from when handed the
// traits array directly. So instead of hand-decoding the 7 numbers
// ourselves, we read traitsOf() + printExists() + ownerOf() for every ID via
// Multicall3, then feed the living ones straight into the renderer to get
// back real, correctly-named trait data with zero guesswork.
//
// This is a ONE-TIME job per collection (traits are frozen forever, not an
// ongoing chase), and it's DELIBERATELY separate from the ownership
// question: a token can have real, valid traits here while still being
// completely unclaimed. See tokens.is_minted (lib/db.js) — this module is
// the only writer that ever sets it false. Anything ownership-dependent
// (wallet views, sales, listings) must filter on is_minted; trait/rarity
// stats should NOT, so they match what the official site already shows for
// the full, eventual collection.

const { ethers } = require('ethers');
const {
  SUPPORTED_CHAINS, extractTraits, toDisplayableImageUrl, needsSvgRender, bulkInsert,
} = require('./collection-backfill');

// Same address on every major EVM chain (Ethereum, Base, Polygon, etc.) —
// a standard, widely-deployed contract, not something specific to Argonauts.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnData)',
];

// Generic — works for any collection with this shape, not hardcoded to
// Argonauts' own function names beyond what "the same setup" means by
// definition (see backfillPredeterminedTraits' slug/contract/renderer
// parameters, all per-collection config, not constants).
const TRAIT_SOURCE_ABI = [
  'function traitsOf(uint256 tokenId) view returns (uint8[7])',
  'function printExists(uint256 tokenId) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function MAX_ID() view returns (uint256)',
];
const RENDERER_ABI = [
  'function tokenURI(uint256 tokenId, uint8[7] traits, bool printed) view returns (string)',
];

const traitSourceIface = new ethers.Interface(TRAIT_SOURCE_ABI);
const rendererIface = new ethers.Interface(RENDERER_ABI);
const multicallIface = new ethers.Interface(MULTICALL3_ABI);

// Tokens per multicall batch. traitsOf/printExists/ownerOf all return tiny
// fixed-size data (a 7-byte array, a bool, an address) so payload size isn't
// the constraint — this is a conservative margin against per-call eth_call
// gas limits some RPC providers impose, not a size limit we've actually hit.
const CHUNK_SIZE = 500;
// Multicall3 itself gets sub-batched at this size within one eth_call, for
// the same conservative reason — keeps every single RPC round trip well
// under any provider's default gas/response caps regardless of chain.
const MULTICALL_SUBBATCH = 400;

function getProvider(chain, alchemyKey){
  const alchemySubdomain = SUPPORTED_CHAINS[chain];
  if(!alchemySubdomain) throw new Error(`no Alchemy RPC subdomain configured for chain "${chain}"`);
  if(!alchemyKey) throw new Error('no Alchemy API key configured (ALCHEMY_API_KEY / ALCHEMY_KEY)');
  const rpcUrl = `https://${alchemySubdomain}.g.alchemy.com/v2/${alchemyKey}`;
  return new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
}

// Runs `calls` through Multicall3's aggregate3, sub-batching internally so
// the caller can pass an arbitrarily large call list without worrying about
// per-request limits. Every call is allowFailure:true — a revert (e.g.
// ownerOf on an unclaimed token, or traitsOf on a 0xFF "not living" row) is
// expected, routine, and must not abort the batch.
async function aggregate3(provider, calls){
  const out = [];
  for(let i = 0; i < calls.length; i += MULTICALL_SUBBATCH){
    const batch = calls.slice(i, i + MULTICALL_SUBBATCH);
    const data = multicallIface.encodeFunctionData('aggregate3', [batch]);
    const raw = await provider.call({ to: MULTICALL3_ADDRESS, data });
    const [results] = multicallIface.decodeFunctionResult('aggregate3', raw);
    out.push(...results);
  }
  return out;
}

// Tries the collection's own MAX_ID() (Argonauts' own naming — a public
// constant, so a plain eth_call, no different from totalSupply() in
// mechanics). Returns null on any failure so a caller can fall back to
// asking for an explicit value; not every future collection with this same
// predetermined-trait architecture is guaranteed to name it identically.
async function fetchOnChainMaxId(contract, chain, alchemyKey){
  try{
    const provider = getProvider(chain, alchemyKey);
    const data = traitSourceIface.encodeFunctionData('MAX_ID', []);
    const raw = await provider.call({ to: contract.toLowerCase(), data });
    const [maxId] = traitSourceIface.decodeFunctionResult('MAX_ID', raw);
    const n = Number(maxId);
    return (Number.isFinite(n) && n > 0) ? n : null;
  }catch(e){
    console.warn(`[predetermined-traits] MAX_ID() read failed for ${contract} on ${chain} (falling back to a manually supplied value): ${e.message}`);
    return null;
  }
}

// Decodes a tokenURI() data-URI JSON string (base64 or raw utf8) into a
// plain object. Returns null on anything unparseable rather than throwing —
// one bad token's data should never abort a whole chunk.
function decodeDataUriJson(uriStr){
  if(!uriStr || typeof uriStr !== 'string' || !uriStr.startsWith('data:')) return null;
  try{
    const commaIdx = uriStr.indexOf(',');
    if(commaIdx === -1) return null;
    const meta = uriStr.slice(5, commaIdx);
    const payload = uriStr.slice(commaIdx + 1);
    const text = meta.includes('base64') ? Buffer.from(payload, 'base64').toString('utf-8') : decodeURIComponent(payload);
    return JSON.parse(text);
  }catch(e){
    return null;
  }
}

async function writeChunk(pgPool, slug, writable){
  if(!writable.length) return;
  const client = await pgPool.connect();
  try{
    await client.query('BEGIN');

    const ids = writable.map(w => w.tokenId);
    await client.query(`DELETE FROM token_traits WHERE collection_slug=$1 AND token_id = ANY($2::int[])`, [slug, ids]);

    const tokenRows = writable.map(w => [w.tokenId, slug, w.attrs.length, w.discordImageUrl, w.minted]);
    await bulkInsert(
      client, 'tokens', ['id', 'collection_slug', 'trait_count', 'image_url', 'is_minted'], tokenRows,
      `ON CONFLICT (id, collection_slug) DO UPDATE SET
         trait_count=EXCLUDED.trait_count,
         image_url=COALESCE(EXCLUDED.image_url, tokens.image_url),
         is_minted=EXCLUDED.is_minted`
    );

    const traitRows = [];
    for(const w of writable){
      w.attrs.forEach((t, idx) => traitRows.push([w.tokenId, t.trait_type, t.value, idx, slug]));
    }
    await bulkInsert(client, 'token_traits', ['token_id', 'trait_name', 'trait_value', 'trait_index', 'collection_slug'], traitRows);

    const svgRows = writable.filter(w => w.isSvgImage).map(w => [w.tokenId, slug, w.imageUrl]);
    if(svgRows.length){
      await bulkInsert(
        client, 'token_svg_cache', ['token_id', 'collection_slug', 'image_data'], svgRows,
        `ON CONFLICT (token_id, collection_slug) DO UPDATE SET image_data=EXCLUDED.image_data`
      ).catch(e => console.warn(`[predetermined-traits] ${slug} bulk token_svg_cache insert failed: ${e.message}`));
    }

    await client.query('COMMIT');
  }catch(e){
    await client.query('ROLLBACK').catch(()=>{});
    throw e;
  }finally{
    client.release();
  }
}

// The main entry point. `maxId` is required and explicit on purpose — see
// fetchOnChainMaxId for the convenience path a caller can use to resolve it
// automatically first, but this function itself never guesses.
async function backfillPredeterminedTraits(pgPool, { slug, contract, rendererContract, chain = 'ethereum', maxId, onProgress }){
  if(!slug || !contract || !rendererContract || !maxId){
    throw new Error('backfillPredeterminedTraits requires slug, contract, rendererContract, and maxId');
  }
  // ethers throws synchronously on a mixed-case address that isn't a valid
  // EIP-55 checksum (confirmed while testing this module) -- and since both
  // addresses get baked into every single multicall batch, one bad
  // checksum would abort the ENTIRE backfill, not just one call. Normalizing
  // to lowercase here (this codebase's own convention everywhere else, e.g.
  // collection-onboard.js's `.toLowerCase()`) means it doesn't matter how
  // the caller stored or typed the address.
  contract = contract.toLowerCase();
  rendererContract = rendererContract.toLowerCase();
  const alchemyKey = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  const provider = getProvider(chain, alchemyKey);

  const stats = { chunks: 0, checked: 0, living: 0, notLiving: 0, minted: 0, unminted: 0, rendererFailed: 0, written: 0 };

  for(let start = 1; start <= maxId; start += CHUNK_SIZE){
    const end = Math.min(start + CHUNK_SIZE - 1, maxId);
    const ids = [];
    for(let id = start; id <= end; id++) ids.push(id);
    stats.checked += ids.length;

    // Phase A: traitsOf + printExists + ownerOf for the whole chunk in one
    // multicall round trip.
    const callsA = [];
    for(const id of ids){
      callsA.push({ target: contract, allowFailure: true, callData: traitSourceIface.encodeFunctionData('traitsOf', [id]) });
      callsA.push({ target: contract, allowFailure: true, callData: traitSourceIface.encodeFunctionData('printExists', [id]) });
      callsA.push({ target: contract, allowFailure: true, callData: traitSourceIface.encodeFunctionData('ownerOf', [id]) });
    }
    const resultsA = await aggregate3(provider, callsA);

    const living = [];
    for(let i = 0; i < ids.length; i++){
      const id = ids[i];
      const traitsRes = resultsA[i * 3];
      const printedRes = resultsA[i * 3 + 1];
      const ownerRes = resultsA[i * 3 + 2];
      const minted = ownerRes.success; // ownerOf only succeeds for a claimed token

      if(!traitsRes.success){ stats.notLiving++; continue; } // 0xFF sentinel row — traitsOf reverts by design
      let traits;
      try{
        const [t] = traitSourceIface.decodeFunctionResult('traitsOf', traitsRes.returnData);
        traits = Array.from(t).map(Number);
      }catch(e){ stats.notLiving++; continue; }

      let printed = false;
      if(printedRes.success){
        try{ [printed] = traitSourceIface.decodeFunctionResult('printExists', printedRes.returnData); }
        catch(e){ printed = false; }
      }

      stats.living++;
      if(minted) stats.minted++; else stats.unminted++;
      living.push({ id, traits, printed, minted });
    }

    // Phase B: renderer.tokenURI(id, traits, printed) for the living subset
    // only — no ownership check on this function at all (confirmed from its
    // source), so this works identically for claimed and unclaimed tokens.
    if(living.length){
      const callsB = living.map(t => ({
        target: rendererContract, allowFailure: true,
        callData: rendererIface.encodeFunctionData('tokenURI', [t.id, t.traits, t.printed]),
      }));
      const resultsB = await aggregate3(provider, callsB);

      const writable = [];
      for(let i = 0; i < living.length; i++){
        const t = living[i];
        const r = resultsB[i];
        if(!r.success){ stats.rendererFailed++; continue; }
        let uriStr;
        try{ [uriStr] = rendererIface.decodeFunctionResult('tokenURI', r.returnData); }
        catch(e){ stats.rendererFailed++; continue; }
        const decoded = decodeDataUriJson(uriStr);
        if(!decoded){ stats.rendererFailed++; continue; }

        const attrs = extractTraits(decoded.attributes || []);
        const rawImage = decoded.image || decoded.image_url || null;
        const imageUrl = toDisplayableImageUrl(rawImage);
        const isSvgImage = needsSvgRender(imageUrl);
        writable.push({
          tokenId: t.id, attrs, imageUrl, isSvgImage,
          discordImageUrl: isSvgImage ? null : imageUrl,
          minted: t.minted,
        });
      }

      await writeChunk(pgPool, slug, writable);
      stats.written += writable.length;
    }

    stats.chunks++;
    if(typeof onProgress === 'function'){
      try{ onProgress({ start, end, maxId, ...stats }); }catch(e){ /* progress callback errors never abort the backfill */ }
    }
  }

  return stats;
}

module.exports = { backfillPredeterminedTraits, fetchOnChainMaxId };
