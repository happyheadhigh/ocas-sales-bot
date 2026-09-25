/**
 * run-migration-004.js
 * ─────────────────────────────────────────────────────────────────
 * One-time runner for migrations/004_fix_collection_scoping_gaps.sql,
 * since psql isn't available in this container. Uses the same pg
 * Pool pattern as every other script in this repo.
 *
 * Usage:
 *   node run-migration-004.js
 *
 * Safe to run more than once — every statement in the migration is
 * idempotent (IF NOT EXISTS / IF EXISTS guards throughout).
 * ─────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

async function main() {
  const sqlPath = path.join(__dirname, 'migrations', '004_fix_collection_scoping_gaps.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error('Could not find', sqlPath);
    process.exit(1);
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('🚀 Running migrations/004_fix_collection_scoping_gaps.sql ...\n');

  // Verify state BEFORE
  const before = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('tokens','token_traits','listings','sales') AND column_name = 'collection_slug'
  `);
  console.log('Before migration — collection_slug exists on:', before.rows.map(r => r.table_name).join(', ') || '(none)');

  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('\n✅ Migration executed successfully.');
  } catch (e) {
    console.error('\n❌ Migration failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
  }

  // Verify state AFTER
  const after = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('tokens','token_traits','listings','sales') AND column_name = 'collection_slug'
  `);
  console.log('After migration — collection_slug exists on:', after.rows.map(r => r.table_name).join(', ') || '(none — something is wrong)');

  const pkCols = await pool.query(`
    SELECT c.conname, array_agg(a.attname ORDER BY a.attnum) AS cols
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conname IN ('tokens_pkey','token_traits_pkey')
    GROUP BY c.conname
  `);
  console.log('Primary keys now:', pkCols.rows);

  const tokenCount = await pool.query(`SELECT COUNT(*) FROM tokens WHERE collection_slug = 'on-chain-all-stars'`);
  const traitCount = await pool.query(`SELECT COUNT(*) FROM token_traits WHERE collection_slug = 'on-chain-all-stars'`);
  const listingCount = await pool.query(`SELECT COUNT(*) FROM listings WHERE collection_slug = 'on-chain-all-stars'`);
  const salesCount = await pool.query(`SELECT COUNT(*) FROM sales WHERE collection_slug = 'on-chain-all-stars'`);
  console.log(`\nOCAS rows backfilled — tokens: ${tokenCount.rows[0].count}, token_traits: ${traitCount.rows[0].count}, listings: ${listingCount.rows[0].count}, sales: ${salesCount.rows[0].count}`);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
