/**
 * backfill-os-rank.js
 * ─────────────────────────────────────────────────────────────────
 * One-time script to fetch OpenSea rarity rank for all 10,000 OCAS
 * tokens and store it in the tokens.os_rank column in Railway Postgres.
 *
 * Usage:
 *   node backfill-os-rank.js
 *   node backfill-os-rank.js --start 1000   # resume from token 1000
 *   node backfill-os-rank.js --dry-run       # test without writing to DB
 *
 * Progress is checkpointed every 100 tokens to backfill-progress.json
 * so you can safely stop and resume at any time.
 *
 * Rate limit strategy:
 *   - 200ms between requests (normal)
 *   - 429 → exponential backoff starting at 2s, doubling up to 60s
 *   - 3 consecutive failures → pause 60s then retry
 * ─────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { Pool }  = require('pg');
const fetch     = require('node-fetch');
const fs        = require('fs');
const path      = require('path');

// ── Environment selection ────────────────────────────────────────────────────
// Same convention as register-commands.js: `node backfill-os-rank.js staging`
// or `node backfill-os-rank.js production` explicitly picks the right DB
// instead of silently falling back to whatever's in the bare .env file.
const envArgIdx = process.argv.findIndex(a => a === 'staging' || a === 'production' || a === 'prod');
const envName = envArgIdx !== -1 ? process.argv[envArgIdx] : '';
if(envName){
  const envFile = (envName === 'staging') ? '.env.staging' : '.env.production';
  require('dotenv').config({ path: path.join(__dirname, envFile), override: true });
  console.log(`Using environment file: ${envFile}`);
} else {
  console.log('No environment specified (staging/production) — using bare .env. Pass one explicitly to avoid ambiguity, e.g.:');
  console.log('  node backfill-os-rank.js staging --start 1');
}

const CONTRACT      = '0x078be86f3104a32313a47815792230a3808642cc';
const TOTAL_TOKENS  = 10000;
const delayArgIdx   = process.argv.indexOf('--delay');
const DELAY_MS      = delayArgIdx !== -1 ? parseInt(process.argv[delayArgIdx + 1]) : 300;   // ms between normal requests -- 200 empirically hit 429s during tonight's cost-basis restore against the same OpenSea key, so defaulting higher; 429 handling below still backs off automatically if this is still too aggressive
const CHECKPOINT_FILE = path.join(__dirname, 'backfill-progress.json');

const OPENSEA_KEY   = process.env.OPENSEA_KEY || process.env.OPENSEA_API_KEY;
const dbUrlArgIdx   = process.argv.indexOf('--db-url');
const DATABASE_URL  = dbUrlArgIdx !== -1 ? process.argv[dbUrlArgIdx + 1] : process.env.DATABASE_URL;
const DRY_RUN       = process.argv.includes('--dry-run');
const START_ARG     = process.argv.indexOf('--start');
const START_FROM    = START_ARG !== -1 ? parseInt(process.argv[START_ARG + 1]) : null;

if (!OPENSEA_KEY)  { console.error('Missing OPENSEA_KEY'); process.exit(1); }
if (!DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 2,
});

// ── Load/save checkpoint ──────────────────────────────────────────────────────
function loadProgress() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE))
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  } catch {}
  return { lastCompleted: 0, failed: [] };
}

function saveProgress(progress) {
  try { fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(progress, null, 2)); } catch {}
}

// ── Fetch OS rank for a single token ─────────────────────────────────────────
async function fetchOsRank(tokenId, retries = 0) {
  const url = `https://api.opensea.io/api/v2/chain/ethereum/contract/${CONTRACT}/nfts/${tokenId}`;
  try {
    const r = await fetch(url, {
      headers: { 'x-api-key': OPENSEA_KEY, 'Accept': 'application/json' }
    });

    if (r.status === 429) {
      const wait = Math.min(5000 * Math.pow(2, retries), 120000);
      console.log(`  [429] Rate limited on #${tokenId}, waiting ${wait/1000}s...`);
      await sleep(wait);
      return fetchOsRank(tokenId, Math.min(retries + 1, 4));
    }

    if (r.status === 404) return { tokenId, rank: null, score: null, notFound: true };
    if (!r.ok) {
      if (retries < 3) {
        await sleep(3000 * (retries + 1));
        return fetchOsRank(tokenId, retries + 1);
      }
      return { tokenId, rank: null, score: null, error: `HTTP ${r.status}` };
    }

    const j = await r.json();
    const nft = j?.nft;
    if (!nft) return { tokenId, rank: null, score: null, error: 'no nft field' };

    const rank  = nft.rarity?.rank  ?? null;
    const score = nft.rarity?.score ?? null;
    return { tokenId, rank, score };

  } catch (e) {
    if (retries < 3) {
      await sleep(3000 * (retries + 1));
      return fetchOsRank(tokenId, retries + 1);
    }
    return { tokenId, rank: null, score: null, error: e.message };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Ensure os_rank column exists ──────────────────────────────────────────────
async function ensureColumns() {
  await pool.query(`
    ALTER TABLE tokens
      ADD COLUMN IF NOT EXISTS os_rank  INTEGER,
      ADD COLUMN IF NOT EXISTS os_score NUMERIC(18,6)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS tokens_os_rank_idx ON tokens(os_rank)
  `);
  console.log('[DB] os_rank and os_score columns ready');
}

// ── Write a batch to DB ───────────────────────────────────────────────────────
async function writeBatch(rows) {
  if (DRY_RUN || !rows.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { tokenId, rank, score } of rows) {
      await client.query(
        `UPDATE tokens SET os_rank=$1, os_score=$2 WHERE id=$3 AND collection_slug='on-chain-all-stars'`,
        [rank, score, tokenId]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 OCAS OS Rank Backfill${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   Contract: ${CONTRACT}`);
  console.log(`   Tokens:   1 – ${TOTAL_TOKENS}`);
  console.log(`   Delay:    ${DELAY_MS}ms between requests\n`);

  if (!DRY_RUN) await ensureColumns();

  const progress = loadProgress();
  let startFrom = START_FROM ?? progress.lastCompleted + 1;

  if (startFrom > 1) console.log(`⏩ Resuming from token #${startFrom}`);

  const stats = { success: 0, noRank: 0, failed: 0, skipped: startFrom - 1 };
  let batch = [];
  let consecutiveFails = 0;

  for (let id = startFrom; id <= TOTAL_TOKENS; id++) {
    const result = await fetchOsRank(id);

    if (result.error) {
      console.warn(`  ✗ #${id}: ${result.error}`);
      stats.failed++;
      consecutiveFails++;
      progress.failed.push(id);
      if (consecutiveFails >= 3) {
        console.log('  ⚠️  3 consecutive failures — pausing 60s...');
        await sleep(60000);
        consecutiveFails = 0;
      }
    } else {
      consecutiveFails = 0;
      if (result.rank) {
        stats.success++;
        batch.push(result);
        if (id % 100 === 0 || id === TOTAL_TOKENS) {
          process.stdout.write(`  #${id.toString().padStart(5)} rank=${result.rank} score=${result.score?.toFixed(2)??'—'}\n`);
        }
      } else {
        stats.noRank++;
      }
    }

    // Write batch every 50 tokens
    if (batch.length >= 50) {
      try {
        await writeBatch(batch);
        batch = [];
      } catch (e) {
        console.error('  DB write error:', e.message);
      }
    }

    // Checkpoint every 100 tokens
    if (id % 100 === 0) {
      progress.lastCompleted = id;
      saveProgress(progress);
      const pct = ((id / TOTAL_TOKENS) * 100).toFixed(1);
      const eta = Math.round(((TOTAL_TOKENS - id) * DELAY_MS) / 60000);
      console.log(`  📍 Checkpoint: ${id}/${TOTAL_TOKENS} (${pct}%) — ~${eta}min remaining | ✓${stats.success} ✗${stats.failed}`);
    }

    await sleep(DELAY_MS);
  }

  // Write remaining batch
  if (batch.length) await writeBatch(batch);

  // Retry failed tokens once
  if (progress.failed.length) {
    console.log(`\n🔄 Retrying ${progress.failed.length} failed tokens...`);
    const retryBatch = [];
    for (const id of progress.failed) {
      await sleep(500);
      const result = await fetchOsRank(id);
      if (!result.error && result.rank) {
        retryBatch.push(result);
        stats.success++;
        stats.failed--;
      }
    }
    if (retryBatch.length) await writeBatch(retryBatch);
  }

  progress.lastCompleted = TOTAL_TOKENS;
  progress.completedAt = new Date().toISOString();
  saveProgress(progress);

  console.log(`\n✅ Backfill complete!`);
  console.log(`   ✓ Success:  ${stats.success}`);
  console.log(`   — No rank: ${stats.noRank}`);
  console.log(`   ✗ Failed:  ${stats.failed}`);
  console.log(`   ⏩ Skipped: ${stats.skipped}`);
  if (DRY_RUN) console.log(`\n   (DRY RUN — nothing was written to DB)`);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
