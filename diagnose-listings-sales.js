require('dotenv').config();
const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

async function main(){
  for (const table of ['listings', 'sales', 'tokens', 'token_traits']) {
    const cols = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = $1
      ORDER BY ordinal_position
    `, [table]);
    console.log(`\n=== ${table} ===`);
    console.log(cols.rows.map(r => `${r.column_name} (${r.data_type}${r.is_nullable==='NO'?', not null':''})`).join('\n'));
  }

  // Sample a few rows from listings to see if collection_slug is populated/meaningful
  const sample = await pool.query(`SELECT token_id, collection_slug FROM listings LIMIT 5`);
  console.log('\n=== listings sample (token_id, collection_slug) ===');
  console.log(sample.rows);

  const salesSample = await pool.query(`SELECT token_id, collection_slug FROM sales LIMIT 5`).catch(e => ({ error: e.message }));
  console.log('\n=== sales sample (token_id, collection_slug) ===');
  console.log(salesSample.rows || salesSample.error);

  await pool.end();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
