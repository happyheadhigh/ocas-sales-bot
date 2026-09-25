/**
 * Diagnostic only -- no writes. Confirmed via a live API test that the
 * wallet burn-stats "Burned" row's fallback resolves to the SAME image as
 * the survivor slot for token #901/event 146, even though the resolution
 * logic itself traces correctly on paper. The remaining explanation: the
 * fallback table (token_image_snapshots, queried by fetchInputSnapshots())
 * might not actually hold the true original mint image -- token_original_
 * snapshots is a separate table already used correctly by the token
 * modal's "Original Mint" feature, and may be the one that should be used
 * here instead. Checks the real, current schema first (lib/db.js's CREATE
 * TABLE statements are known to drift from live schema over time), then
 * compares actual content for token 901 against what's already known.
 *
 * USAGE
 *   node diag-check-original-snapshots-table.js <tokenId>
 */

require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const tokenId = parseInt(process.argv[2], 10);
if (!Number.isFinite(tokenId)) {
  console.log('Usage: node diag-check-original-snapshots-table.js <tokenId>');
  process.exit(1);
}

function hash(s) { return s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 16) : null; }

async function main() {
  console.log('\n=== Live column check: token_original_snapshots ===\n');
  const colsRes = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='token_original_snapshots' ORDER BY ordinal_position`
  );
  for (const c of colsRes.rows) console.log(`  ${c.column_name}  (${c.data_type})`);

  console.log(`\n=== token_original_snapshots row for #${tokenId} ===\n`);
  const rowRes = await pool.query(`SELECT * FROM token_original_snapshots WHERE token_id=$1`, [tokenId]);
  if (!rowRes.rows.length) {
    console.log('  No row at all for this token.');
  } else {
    const row = rowRes.rows[0];
    for (const [k, v] of Object.entries(row)) {
      if (k === 'image_data') console.log(`  image_data: hash=${hash(v)}  length=${v ? v.length : 0}`);
      else console.log(`  ${k}: ${v}`);
    }
  }

  console.log(`\n=== token_image_snapshots row for #${tokenId} (for direct comparison) ===\n`);
  const imgRes = await pool.query(`SELECT * FROM token_image_snapshots WHERE token_id=$1`, [tokenId]);
  if (!imgRes.rows.length) {
    console.log('  No row at all for this token.');
  } else {
    const row = imgRes.rows[0];
    for (const [k, v] of Object.entries(row)) {
      if (k === 'image_data') console.log(`  image_data: hash=${hash(v)}  length=${v ? v.length : 0}`);
      else console.log(`  ${k}: ${v}`);
    }
  }

  console.log('\n=== What we already know for comparison ===');
  console.log('  Event 146 survivor image / current Burned-row bug value: hash=088a39a6623ddee5');
  console.log('  (this is what BOTH the survivor slot and the wrongly-matching burned slot show)');
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
