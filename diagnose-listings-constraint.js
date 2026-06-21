require('dotenv').config();
const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

async function main(){
  const constraints = await pool.query(`
    SELECT conname, contype,
      (SELECT array_agg(a.attname ORDER BY a.attnum)
       FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) AS columns
    FROM pg_constraint c
    WHERE c.conrelid = 'listings'::regclass
  `);
  console.log('=== ALL constraints on listings ===');
  console.log(constraints.rows);

  // Also check indexes specifically, since ON CONFLICT can target a unique
  // index even without a named constraint
  const indexes = await pool.query(`
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'listings'
  `);
  console.log('\n=== ALL indexes on listings ===');
  console.log(indexes.rows);

  await pool.end();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
