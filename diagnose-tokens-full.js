require('dotenv').config();
const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

async function main(){
  // Full column list for tokens with nullability and defaults
  const cols = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'tokens'
    ORDER BY ordinal_position
  `);
  console.log('=== tokens columns (full detail) ===');
  console.log(cols.rows);

  // Every constraint on token_traits, not just the primary key
  const constraints = await pool.query(`
    SELECT conname, contype,
      (SELECT array_agg(a.attname ORDER BY a.attnum)
       FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) AS columns
    FROM pg_constraint c
    WHERE c.conrelid = 'token_traits'::regclass
  `);
  console.log('\n=== ALL constraints on token_traits ===');
  console.log(constraints.rows);

  // Same for tokens, in case there's a similar surprise there too
  const tokenConstraints = await pool.query(`
    SELECT conname, contype,
      (SELECT array_agg(a.attname ORDER BY a.attnum)
       FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) AS columns
    FROM pg_constraint c
    WHERE c.conrelid = 'tokens'::regclass
  `);
  console.log('\n=== ALL constraints on tokens ===');
  console.log(tokenConstraints.rows);

  await pool.end();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
