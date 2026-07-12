/**
 * Diagnostic only -- no writes. jv reports TraitView's Owned Tokens shows
 * tokens they've already burned as still owned. Traced the mechanism:
 * "owned" = wallet_token_intervals.disposed_at IS NULL, and
 * deriveIntervals() (which is responsible for closing out an interval
 * when a token is burned) queries nft_transfers WHERE collection_slug=$2.
 * Checking whether nft_transfers has the same NULL-collection_slug pattern
 * seen in every other table tonight, before assuming anything else.
 *
 * USAGE
 *   node diag-check-nft-transfers-slug.js [walletAddress]
 *   (walletAddress optional -- if given, also shows this wallet's specific
 *   transfer rows so burn events can be checked directly)
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const wallet = (process.argv[2] || '').trim().toLowerCase();

async function main() {
  console.log('=== nft_transfers row counts ===\n');
  const totalRes = await pool.query(`SELECT COUNT(*) AS total FROM nft_transfers`);
  console.log(`  Total rows in nft_transfers: ${totalRes.rows[0].total}`);

  const bySlugRes = await pool.query(`
    SELECT collection_slug, COUNT(*)::int AS row_count
    FROM nft_transfers
    GROUP BY collection_slug
    ORDER BY row_count DESC
  `);
  console.log('\n  Breakdown by collection_slug value:');
  for (const r of bySlugRes.rows) {
    console.log(`    ${r.collection_slug === null ? '(NULL)' : `"${r.collection_slug}"`}: ${r.row_count} rows`);
  }

  if (wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    console.log(`\n=== nft_transfers rows for wallet ${wallet} ===\n`);
    const walletRes = await pool.query(
      `SELECT token_id, from_address, to_address, event_type, collection_slug, transferred_at
       FROM nft_transfers WHERE LOWER(to_address)=$1 OR LOWER(from_address)=$1
       ORDER BY transferred_at ASC LIMIT 30`,
      [wallet]
    );
    for (const r of walletRes.rows) {
      console.log(`  token_id=${r.token_id}  from=${r.from_address}  to=${r.to_address}  event_type=${r.event_type}  collection_slug=${r.collection_slug === null ? '(NULL)' : r.collection_slug}  at=${r.transferred_at}`);
    }

    console.log(`\n=== wallet_token_intervals for this wallet ===\n`);
    const intervalsRes = await pool.query(
      `SELECT token_id, collection_slug, disposed_at FROM wallet_token_intervals WHERE LOWER(wallet_address)=$1 ORDER BY token_id`,
      [wallet]
    );
    for (const r of intervalsRes.rows) {
      console.log(`  token_id=${r.token_id}  collection_slug=${r.collection_slug === null ? '(NULL)' : r.collection_slug}  disposed_at=${r.disposed_at === null ? '(NULL -- shows as OWNED)' : r.disposed_at}`);
    }
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
