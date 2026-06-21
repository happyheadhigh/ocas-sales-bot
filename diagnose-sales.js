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
    WHERE c.conrelid = 'sales'::regclass
  `);
  console.log('=== ALL constraints on sales ===');
  console.log(constraints.rows);

  await pool.end();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
