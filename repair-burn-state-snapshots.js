/**
 * Reconstructs the TRUE historical burn_state_snapshots row for every
 * finalized burn_event, using a historical eth_call (tokenURI at that burn's
 * own block_number) rather than "current" state. This replaces the approach
 * that caused the #2007 bug: an earlier backfill wrote CURRENT/latest data
 * under multiple different (non-latest) burn_event_ids, making "Before Burn N"
 * show the wrong (too-recent) appearance for any survivor burned more than
 * once. Confirmed via test-historical-rpc.js that the configured RPC
 * provider has full archive access, so the real per-block state is
 * retrievable for every historical burn, not just the current one.
 *
 * For each burn_event:
 *   - eth_call tokenURI(survivor_token_id) at blockTag = that burn's own
 *     block_number (state reflects the chain as of the END of that block,
 *     i.e. including that burn's own finalize transaction).
 *   - Compare to what's currently stored in burn_state_snapshots for
 *     (token_id, burn_event_id). If different (or missing), replace it.
 *
 * This is independent of survivor burn count -- every burn_event gets
 * verified/fixed, not just ones suspected of the specific #2007 pattern,
 * since the only way to know for certain is to check against ground truth.
 *
 * USAGE
 *   Dry run (default):      node repair-burn-state-snapshots.js
 *   Actually write:          WRITE=true node repair-burn-state-snapshots.js
 *   Single survivor only:    SURVIVOR=2007 node repair-burn-state-snapshots.js
 *   Single burn_event only:  BURN_EVENT=177 node repair-burn-state-snapshots.js
 */

require('dotenv').config();
const { Pool } = require('pg');

// Prefer Alchemy over whatever BURN_RPC_OVERRIDE (Infura, used during the
// live poller's catch-up mode) is currently set to, for the same reason as
// backfill-missing-survivor-images.js -- this script's own burst of calls
// has nothing to do with the live bot's catch-up strategy, and clearing
// these only affects THIS process's env, not the running bot service.
delete process.env.BURN_RPC_OVERRIDE;
delete process.env.ETH_RPC_URL;

const { burnRpcUrl, burnRpc, traitsObjectFromArray, realTraitCount } = require('./lib/rpc');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';
const WRITE = String(process.env.WRITE || 'false').toLowerCase() === 'true';

function decodeAbiString(result) {
  if (!result || result === '0x') return null;
  const hex = result.slice(2);
  if (hex.length < 128) return null;
  const length = parseInt(hex.slice(64, 128), 16);
  if (!Number.isFinite(length) || length <= 0) return null;
  return Buffer.from(hex.slice(128, 128 + length * 2), 'hex').toString('utf8');
}

function decodeTokenUriJson(uri) {
  if (!uri) return null;
  if (uri.startsWith('data:application/json;base64,')) {
    return JSON.parse(Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf8'));
  }
  if (uri.startsWith('data:application/json,')) {
    return JSON.parse(decodeURIComponent(uri.slice('data:application/json,'.length)));
  }
  throw new Error(`Unsupported tokenURI format: ${uri.slice(0, 60)}`);
}

// Historical version of fetchTokenUriFromContract (lib/rpc.js) -- that
// function hardcodes blockTag='latest'; this one accepts a specific block.
async function fetchTokenUriAtBlock(rpcUrl, tokenId, blockNumber) {
  const paddedId = parseInt(tokenId, 10).toString(16).padStart(64, '0');
  const blockHex = '0x' + parseInt(blockNumber, 10).toString(16);
  const result = await burnRpc(rpcUrl, 'eth_call', [
    { to: OCAS_CONTRACT, data: '0xc87b56dd' + paddedId },
    blockHex,
  ]);
  const uri = decodeAbiString(result);
  const meta = decodeTokenUriJson(uri);
  if (!meta || typeof meta !== 'object') return null;
  const rawAttrs = Array.isArray(meta.attributes) ? meta.attributes : (Array.isArray(meta.traits) ? meta.traits : []);
  const traits = traitsObjectFromArray(rawAttrs, meta.image || null);
  return realTraitCount(traits) ? traits : null;
}

async function getBurnEvents(pool) {
  const where = [];
  const params = [];
  if (process.env.SURVIVOR) { params.push(parseInt(process.env.SURVIVOR, 10)); where.push(`survivor_token_id = $${params.length}`); }
  if (process.env.BURN_EVENT) { params.push(parseInt(process.env.BURN_EVENT, 10)); where.push(`id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT id, survivor_token_id, block_number, tx_hash FROM burn_events ${whereSql} ORDER BY survivor_token_id, block_number ASC`,
    params
  );
  return r.rows;
}

async function getStoredSnapshot(pool, burnEventId, tokenId) {
  const r = await pool.query(
    `SELECT image_data, traits_json FROM burn_state_snapshots WHERE burn_event_id=$1 AND token_id=$2`,
    [burnEventId, tokenId]
  );
  return r.rows[0] || null;
}

function tokenImageOf(traits) {
  return traits && typeof traits === 'object' ? traits.__image : null;
}

function traitsEqual(a, b) {
  // Compare ignoring __attributes (array form, order-sensitive by nature)
  // AND ignoring object key insertion order for everything else -- two
  // logically-identical trait sets built by different code paths can have
  // their keys in a different order, which a naive JSON.stringify
  // comparison would wrongly flag as "different". Sorting keys before
  // stringifying makes this comparison order-independent.
  if (!a || !b) return false;
  const strip = (t) => {
    const { __attributes, __image, ...rest } = t || {};
    return rest;
  };
  const canonical = (obj) => JSON.stringify(
    Object.keys(obj).sort().reduce((acc, k) => { acc[k] = obj[k]; return acc; }, {})
  );
  return canonical(strip(a)) === canonical(strip(b));
}

function imagesEqual(a, b) {
  return (a?.__image || null) === (b?.__image || null);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const rpcUrl = burnRpcUrl();
  if (!rpcUrl) {
    console.error('No RPC URL configured.');
    await pool.end();
    process.exit(1);
  }

  const events = await getBurnEvents(pool);
  console.log(`${WRITE ? 'WRITE MODE' : 'DRY RUN'} — checking ${events.length} burn_event(s) against historical on-chain state`);

  let checked = 0, correct = 0, fixedMissing = 0, fixedTraits = 0, fixedImageOnly = 0, rpcFailed = 0;

  for (const ev of events) {
    checked++;
    const trueTraits = await fetchTokenUriAtBlock(rpcUrl, ev.survivor_token_id, ev.block_number).catch(e => {
      console.warn(`  #${ev.survivor_token_id} burn_event #${ev.id} (block ${ev.block_number}): RPC failed — ${e.message}`);
      return null;
    });
    if (!trueTraits) { rpcFailed++; await new Promise(r => setTimeout(r, 300)); continue; }

    const stored = await getStoredSnapshot(pool, ev.id, ev.survivor_token_id);
    const storedTraits = stored?.traits_json ? (typeof stored.traits_json === 'string' ? JSON.parse(stored.traits_json) : stored.traits_json) : null;

    const traitsMatch = traitsEqual(trueTraits, storedTraits);
    const imagesMatch = storedTraits ? imagesEqual(trueTraits, storedTraits) : false;

    if (traitsMatch && imagesMatch) {
      correct++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    // Categorize so the summary distinguishes real historical corrections
    // (missing entirely, or trait VALUES actually differ) from cases where
    // the traits match but only the image bytes differ -- which could be a
    // real stale/wrong image, or could just be a harmless re-encode
    // (different SVG serialization producing the same visual result). Both
    // get written with the ground-truth value either way, but knowing which
    // category each fix falls into matters for judging how big a deal this
    // actually is before committing 80+ writes.
    let category;
    if (!storedTraits) category = 'MISSING';
    else if (!traitsMatch) category = 'TRAITS DIFFER';
    else category = 'IMAGE ONLY DIFFERS';

    if (category === 'MISSING') fixedMissing++;
    else if (category === 'TRAITS DIFFER') fixedTraits++;
    else fixedImageOnly++;

    console.log(`\n  Survivor #${ev.survivor_token_id}, burn_event #${ev.id} (tx ${ev.tx_hash}, block ${ev.block_number}) — ${category}:`);
    if (category === 'IMAGE ONLY DIFFERS') {
      console.log(`    (traits match; only the stored image bytes differ from ground truth — not printing the full dump)`);
    } else {
      console.log(`    stored: ${storedTraits ? JSON.stringify({ ...storedTraits, __image: storedTraits.__image ? '<image data>' : null }) : '(missing)'}`);
      console.log(`    true:   ${JSON.stringify({ ...trueTraits, __image: trueTraits.__image ? '<image data>' : null })}`);
    }

    if (WRITE) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM burn_state_snapshots WHERE burn_event_id=$1 AND token_id=$2`, [ev.id, ev.survivor_token_id]);
        await client.query(
          `INSERT INTO burn_state_snapshots (burn_event_id, token_id, image_data, traits_json) VALUES ($1,$2,$3,$4)`,
          [ev.id, ev.survivor_token_id, tokenImageOf(trueTraits), JSON.stringify(trueTraits)]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        console.warn(`    DB write failed:`, e.message);
      } finally {
        client.release();
      }
    }

    await new Promise(r => setTimeout(r, 300));
  }

  const totalFixed = fixedMissing + fixedTraits + fixedImageOnly;
  console.log(`\n=== Summary ===`);
  console.log(`Checked: ${checked}`);
  console.log(`Already correct: ${correct}`);
  console.log(`${WRITE ? 'Fixed' : 'Would fix'} (total): ${totalFixed}`);
  console.log(`  - Missing entirely: ${fixedMissing}`);
  console.log(`  - Traits genuinely differ (real historical correction): ${fixedTraits}`);
  console.log(`  - Traits match, image bytes only differ (re-encode or real staleness -- review): ${fixedImageOnly}`);
  console.log(`RPC failures (skipped, not touched): ${rpcFailed}`);
  if (!WRITE && totalFixed > 0) console.log(`\nRe-run with WRITE=true to apply these ${totalFixed} fix(es).`);

  await pool.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
