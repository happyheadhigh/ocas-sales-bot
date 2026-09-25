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

async function getNullability() {
  const r = await pool.query(`
    SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_name = 'tokens' AND column_name IN ('obs_rank','rarity_score')
    ORDER BY column_name
  `);
  return r.rows;
}

async function main() {
  const sqlPath = path.join(__dirname, 'migrations', '006_make_rank_columns_nullable.sql');
  if (!fs.existsSync(sqlPath)) { console.error('Could not find', sqlPath); process.exit(1); }
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('🚀 Running migrations/006_make_rank_columns_nullable.sql ...\n');
  console.log('Before:', await getNullability());

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

  console.log('\nAfter:', await getNullability());

  // Sanity check: existing OCAS rows should still have real values
  const ocasCheck = await pool.query(`
    SELECT COUNT(*) AS total, COUNT(obs_rank) AS with_rank, COUNT(rarity_score) AS with_rarity
    FROM tokens WHERE collection_slug = 'on-chain-all-stars'
  `);
  console.log('\nOCAS rows — total:', ocasCheck.rows[0].total, '| with obs_rank:', ocasCheck.rows[0].with_rank, '| with rarity_score:', ocasCheck.rows[0].with_rarity, '(should all match if no data was lost)');

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
