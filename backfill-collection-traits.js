/**
 * backfill-collection-traits.js
 * ─────────────────────────────────────────────────────────────────
 * Fetches every token's full trait list for a given NFT collection via
 * Alchemy's NFT API (getNFTsForContract) and writes it into the
 * token_traits table, scoped by collection_slug.
 *
 * Unlike backfill-os-rank.js (one OpenSea call per token, ~10,000 calls
 * for a 10k collection), this uses Alchemy's batched endpoint — up to
 * 100 tokens per call, so a 10k collection is ~100 calls total. This is
 * the per-collection backfill discussed for the paid tier: a deliberate,
 * one-time operation per collection, not something that runs automatically.
 *
 * Usage:
 *   node backfill-collection-traits.js --contract 0xABC... --slug some-collection
 *   node backfill-collection-traits.js --contract 0xABC... --slug some-collection --dry-run
 *   node backfill-collection-traits.js --contract 0xABC... --slug some-collection --dry-run --debug
 *     (--debug prints the first token's raw Alchemy response shape once,
 *     useful when verifying a new/unfamiliar collection before a real run)
 *   node backfill-collection-traits.js --contract 0xABC... --slug some-collection --resume-from 0x1388
 *     (resume-from accepts the last pageKey printed before a crash/stop)
 *
 * Safety: this script refuses to run against OCAS (on-chain-all-stars, by
 * slug or contract address) under any circumstances, including --dry-run,
 * unless --i-know-what-im-doing is also passed. OCAS already has correct
 * trait data maintained by the burn machine's priority system; this script
 * has no awareness of that and would overwrite it with Alchemy's current
 * snapshot. This is not expected to ever be overridden in practice.
 *
 * Progress is checkpointed after every page to
 * backfill-collection-traits-progress-<slug>.json so it can be safely
 * stopped and resumed (per-slug file, so multiple collections' progress
 * never collides).
 *
 * Rate limit strategy:
 *   - 300ms between page requests (well under Alchemy's free-tier 500
 *     CUPS — getNFTsForContract is also explicitly throughput-discounted
 *     by Alchemy, see their Compute Unit Costs docs)
 *   - 429 → exponential backoff starting at 2s, doubling up to 60s
 *   - 3 consecutive page failures → pause 60s then retry
 *
 * This does NOT touch tokens.os_rank or any rank data — traits only.
 * This does NOT touch listings or sales — those remain OpenSea-sourced,
 * since Alchemy's marketplace data (floor price, sales) is aggregated/
 * cached on a 5-15min cycle, not a live per-listing feed with full trait
 * detail per listing the way OpenSea's listings endpoint is.
 * ─────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { Pool }  = require('pg');
const fetch     = require('node-fetch');
const fs        = require('fs');
const path      = require('path');

const ALCHEMY_KEY   = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
const DATABASE_URL  = process.env.DATABASE_URL;
const DELAY_MS       = 300;   // ms between page requests
const PAGE_SIZE      = 100;   // Alchemy's max per getNFTsForContract call

const DRY_RUN        = process.argv.includes('--dry-run');
const DEBUG_DUMP      = process.argv.includes('--debug');
const CONTRACT_ARG   = process.argv.indexOf('--contract');
const SLUG_ARG       = process.argv.indexOf('--slug');
const RESUME_ARG     = process.argv.indexOf('--resume-from');

const CONTRACT  = CONTRACT_ARG !== -1 ? process.argv[CONTRACT_ARG + 1] : null;
const SLUG      = SLUG_ARG !== -1 ? process.argv[SLUG_ARG + 1] : null;
const RESUME_FROM = RESUME_ARG !== -1 ? process.argv[RESUME_ARG + 1] : null;

if (!ALCHEMY_KEY)  { console.error('Missing ALCHEMY_API_KEY (or ALCHEMY_KEY) env var'); process.exit(1); }
if (!DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }
if (!CONTRACT)     { console.error('Missing --contract 0x...'); process.exit(1); }
if (!SLUG)         { console.error('Missing --slug collection-slug'); process.exit(1); }
if (!/^0x[a-fA-F0-9]{40}$/.test(CONTRACT)) { console.error('--contract does not look like a valid address:', CONTRACT); process.exit(1); }

// ── OCAS guard ───────────────────────────────────────────────────────────────
// This script does an unscoped delete+insert of whatever Alchemy currently
// reports per token, with zero awareness of OCAS's burn-machine
// SOURCE_PRIORITY system (burn-finalized-survivor > backfill-chunks > ...).
// A survivor token's traits can change after a burn; that's tracked
// correctly by the burn-aware writers in lib/embeds.js / lib/images.js.
// Running this script against OCAS would blindly overwrite that with
// Alchemy's current snapshot, discarding which write should actually win.
// OCAS already has good, carefully-maintained trait data from its original
// backfill — it does not need this script and must never have it run for
// real. Blocked outright (including --dry-run, since the point of this
// guard is removing any judgment call about which flag combo is "safe
// enough" rather than relying on remembering not to run it) unless the
// override flag below is explicitly passed.
const OCAS_SLUG_LOWER     = 'on-chain-all-stars';
const OCAS_CONTRACT_LOWER = '0x078be86f3104a32313a47815792230a3808642cc';
const FORCE_OCAS = process.argv.includes('--i-know-what-im-doing');
if (!FORCE_OCAS && (SLUG.toLowerCase() === OCAS_SLUG_LOWER || CONTRACT.toLowerCase() === OCAS_CONTRACT_LOWER)) {
  console.error(
    '\n🛑 Refusing to run against OCAS (on-chain-all-stars).\n' +
    '   This script does not respect the burn-machine\'s trait write priority\n' +
    '   and would overwrite burn survivor trait data with Alchemy\'s current\n' +
    '   snapshot. OCAS already has good data from its original backfill.\n' +
    '   If you are certain this is intentional, re-run with --i-know-what-im-doing.\n'
  );
  process.exit(1);
}

const CHECKPOINT_FILE = path.join(__dirname, `backfill-collection-traits-progress-${SLUG}.json`);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 2,
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Trait normalization — mirrors lib/rpc.js's normalizeTraitAttribute,
// duplicated here since this is a standalone script outside the bot's
// module graph (avoids pulling in discord.js and other bot-only deps).
function normalizeTraitAttribute(t){
  if(!t || typeof t !== 'object') return null;
  const trait_type = t.trait_type || t.traitType || t.type || t.name;
  const value = t.value;
  if(!trait_type || value == null) return null;
  return { trait_type: String(trait_type), value: String(value) };
}

// ── Load/save checkpoint ──────────────────────────────────────────────────────
function loadProgress() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE))
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  } catch {}
  return { lastPageKey: null, tokensWritten: 0, pagesCompleted: 0, failed: [] };
}

function saveProgress(progress) {
  try { fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(progress, null, 2)); } catch {}
}

// ── Fetch one page of NFTs for the contract ──────────────────────────────────
async function fetchPage(pageKey, retries = 0) {
  const url = new URL(`https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTsForContract`);
  url.searchParams.set('contractAddress', CONTRACT);
  url.searchParams.set('withMetadata', 'true');
  url.searchParams.set('limit', String(PAGE_SIZE));
  if (pageKey) url.searchParams.set('startToken', pageKey);

  try {
    const r = await fetch(url.toString());

    if (r.status === 429) {
      const wait = Math.min(2000 * Math.pow(2, retries), 60000);
      console.log(`  [429] Rate limited, waiting ${wait/1000}s...`);
      await sleep(wait);
      return fetchPage(pageKey, Math.min(retries + 1, 5));
    }

    if (!r.ok) {
      const txt = await r.text().catch(()=> '');
      if (retries < 3) {
        await sleep(3000 * (retries + 1));
        return fetchPage(pageKey, retries + 1);
      }
      return { error: `HTTP ${r.status}: ${txt.slice(0,200)}` };
    }

    const j = await r.json();
    return { nfts: j.nfts || [], pageKey: j.pageKey || null };

  } catch (e) {
    if (retries < 3) {
      await sleep(3000 * (retries + 1));
      return fetchPage(pageKey, retries + 1);
    }
    return { error: e.message };
  }
}

// ── Write one page's worth of token traits to DB ─────────────────────────────
let _debugDumped = false;
async function writePage(nfts) {
  if (DEBUG_DUMP && !_debugDumped && nfts.length) {
    _debugDumped = true;
    const nft = nfts[0];
    const rawCopy = nft.raw ? { ...nft.raw } : nft.raw;
    if (rawCopy?.metadata) {
      rawCopy.metadata = { ...rawCopy.metadata };
      if (rawCopy.metadata.image) rawCopy.metadata.image = '[omitted, length=' + String(rawCopy.metadata.image).length + ']';
    }
    console.log('\n🔍 DEBUG — first token (image data omitted):');
    console.log(JSON.stringify({
      tokenId: nft.tokenId,
      tokenUri: nft.tokenUri,
      raw: rawCopy,
      collection: nft.collection,
      timeLastUpdated: nft.timeLastUpdated,
    }, null, 2));
    console.log('🔍 END DEBUG\n');
  }
  if (!nfts.length) return { written: 0, skipped: 0 };

  // In dry-run mode, parse and count exactly as normal but skip the DB
  // entirely — no pool.connect(), no queries. This is what was broken
  // before: the old early-return short-circuited before counting anything,
  // so dry-run always reported 0/0 regardless of whether the data was good.
  if (DRY_RUN) {
    let written = 0, skipped = 0;
    for (const nft of nfts) {
      const tokenId = parseInt(nft.tokenId);
      if (!tokenId && tokenId !== 0) { skipped++; continue; }
      const rawAttrs = nft.raw?.metadata?.attributes;
      const attrs = Array.isArray(rawAttrs) ? rawAttrs.map(normalizeTraitAttribute).filter(Boolean) : [];
      if (!attrs.length) { skipped++; continue; }
      written++;
    }
    return { written, skipped };
  }

  const client = await pool.connect();
  let written = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    for (const nft of nfts) {
      const tokenId = parseInt(nft.tokenId);
      if (!tokenId && tokenId !== 0) { skipped++; continue; }
      const rawAttrs = nft.raw?.metadata?.attributes;
      const attrs = Array.isArray(rawAttrs) ? rawAttrs.map(normalizeTraitAttribute).filter(Boolean) : [];
      if (!attrs.length) { skipped++; continue; }

      // Scoped delete+insert, same pattern as upsertTokenTraitRows in
      // lib/embeds.js / lib/images.js — collection_slug-scoped so this
      // can never touch another collection's rows for the same token ID.
      await client.query('DELETE FROM token_traits WHERE token_id=$1 AND collection_slug=$2', [tokenId, SLUG]);
      for (let i = 0; i < attrs.length; i++) {
        const t = attrs[i];
        await client.query(
          `INSERT INTO token_traits (token_id, trait_name, trait_value, trait_index, collection_slug)
           VALUES ($1,$2,$3,$4,$5)`,
          [tokenId, t.trait_type, t.value, i, SLUG]
        );
      }
      // Also ensure a tokens row exists for this id+slug, with trait_count
      // set, since /db/multi-trait-tokens joins against tokens for rank/
      // count filtering — without a tokens row, this token's traits would
      // be saved but invisible to search. Only trait_count is supplied;
      // obs_rank/rarity_score are intentionally left out (migration 006
      // made them nullable) since this script has no real rank data to
      // offer — that requires a separate rank-computation pass this
      // collection doesn't have yet. ON CONFLICT preserves any existing
      // rank data on a row that already exists.
      await client.query(
        `INSERT INTO tokens (id, collection_slug, trait_count)
         VALUES ($1,$2,$3)
         ON CONFLICT (id, collection_slug) DO UPDATE SET trait_count=$3`,
        [tokenId, SLUG, attrs.length]
      );
      written++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { written, skipped };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Collection Trait Backfill (Alchemy)${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   Contract: ${CONTRACT}`);
  console.log(`   Slug:     ${SLUG}`);
  console.log(`   Page size: ${PAGE_SIZE}  |  Delay: ${DELAY_MS}ms between pages\n`);

  const progress = loadProgress();
  let pageKey = RESUME_FROM || progress.lastPageKey || null;
  if (pageKey) console.log(`⏩ Resuming from pageKey ${pageKey}`);

  const stats = { written: 0, skipped: 0, pages: progress.pagesCompleted || 0, failed: 0 };
  let consecutiveFails = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await fetchPage(pageKey);

    if (page.error) {
      console.warn(`  ✗ Page fetch failed: ${page.error}`);
      stats.failed++;
      consecutiveFails++;
      if (consecutiveFails >= 3) {
        console.log('  ⚠️  3 consecutive page failures — pausing 60s...');
        await sleep(60000);
        consecutiveFails = 0;
      }
      await sleep(DELAY_MS);
      continue;
    }
    consecutiveFails = 0;

    try {
      const result = await writePage(page.nfts);
      stats.written += result.written;
      stats.skipped += result.skipped;
    } catch (e) {
      console.error('  DB write error on this page:', e.message);
      stats.failed++;
    }

    stats.pages++;
    pageKey = page.pageKey;
    hasMore = !!pageKey;

    progress.lastPageKey = pageKey;
    progress.tokensWritten = stats.written;
    progress.pagesCompleted = stats.pages;
    saveProgress(progress);

    console.log(`  📍 Page ${stats.pages} done — ${page.nfts.length} tokens fetched, ${stats.written} written so far, ${stats.skipped} skipped (no traits)${hasMore ? '' : ' — last page'}`);

    if (hasMore) await sleep(DELAY_MS);
  }

  progress.completedAt = new Date().toISOString();
  progress.lastPageKey = null; // fully done, nothing to resume
  saveProgress(progress);

  console.log(`\n✅ Backfill complete!`);
  console.log(`   ✓ Written: ${stats.written}`);
  console.log(`   — Skipped (no traits): ${stats.skipped}`);
  console.log(`   ✗ Failed pages: ${stats.failed}`);
  console.log(`   📄 Total pages: ${stats.pages}`);
  if (DRY_RUN) console.log(`\n   (DRY RUN — nothing was written to DB)`);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
