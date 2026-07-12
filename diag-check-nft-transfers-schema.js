/**
 * Diagnostic only -- no writes. Confirming nft_transfers' actual live
 * columns before writing a repair script, per tonight's established
 * caution about schema drift between what CREATE TABLE says and what's
 * actually there.
 *
 * USAGE
 *   node diag-check-nft-transfers-schema.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const res = await pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='nft_transfers' ORDER BY ordinal_position`
  );
  console.log('=== nft_transfers live columns ===\n');
  for (const c of res.rows) console.log(`  ${c.column_name}  (${c.data_type}, nullable=${c.is_nullable})`);

  console.log('\n=== One real burn-type row for reference ===\n');
  const sample = await pool.query(`SELECT * FROM nft_transfers WHERE event_type='burn' LIMIT 1`);
  if (sample.rows.length) console.log(JSON.stringify(sample.rows[0], null, 2));
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
