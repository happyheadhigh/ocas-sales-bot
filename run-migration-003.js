/**
 * run-migration-003.js
 * ─────────────────────────────────────────────────────────────────
 * One-time runner for migrations/003_collection_scoped_tokens.sql,
 * since psql isn't available in this container. Uses the same pg
 * Pool pattern as every other script in this repo.
 *
 * Usage:
 *   node run-migration-003.js
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
  const sqlPath = path.join(__dirname, 'migrations', '003_collection_scoped_tokens.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error('Could not find', sqlPath);
    process.exit(1);
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('🚀 Running migrations/003_collection_scoped_tokens.sql ...\n');

  // Verify state BEFORE
  const before = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('tokens','token_traits') AND column_name = 'collection_slug'
  `);
  console.log('Before migration — collection_slug exists on:', before.rows.map(r => r.table_name).join(', ') || '(neither table)');

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
    WHERE table_name IN ('tokens','token_traits') AND column_name = 'collection_slug'
  `);
  console.log('After migration — collection_slug exists on:', after.rows.map(r => r.table_name).join(', ') || '(neither table — something is wrong)');

  const tokenCount = await pool.query(`SELECT COUNT(*) FROM tokens WHERE collection_slug = 'on-chain-all-stars'`);
  const traitCount = await pool.query(`SELECT COUNT(*) FROM token_traits WHERE collection_slug = 'on-chain-all-stars'`);
  console.log(`\nOCAS rows backfilled — tokens: ${tokenCount.rows[0].count}, token_traits: ${traitCount.rows[0].count}`);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
