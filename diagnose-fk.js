require('dotenv').config();
const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

async function main(){
  // Find every foreign key constraint anywhere in the DB that references tokens
  const fks = await pool.query(`
    SELECT
      tc.table_name AS referencing_table,
      kcu.column_name AS referencing_column,
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column,
      tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'tokens'
  `);
  console.log('Foreign keys referencing tokens:');
  console.log(fks.rows);

  // Also check current state of tokens_pkey itself
  const pkCols = await pool.query(`
    SELECT a.attname FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conname = 'tokens_pkey'
  `);
  console.log('\ntokens_pkey currently covers columns:', pkCols.rows.map(r => r.attname));

  // Confirm current collection_slug state
  const cols = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('tokens','token_traits') AND column_name = 'collection_slug'
  `);
  console.log('collection_slug exists on:', cols.rows.map(r => r.table_name));

  await pool.end();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
