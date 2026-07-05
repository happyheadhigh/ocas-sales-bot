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

async function getConstraintShape() {
  const r = await pool.query(`
    SELECT conname, contype,
      (SELECT array_agg(a.attname ORDER BY a.attnum)
       FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) AS columns
    FROM pg_constraint c
    WHERE c.conrelid = 'sales'::regclass AND contype = 'u'
  `);
  return r.rows;
}

async function main() {
  const sqlPath = path.join(__dirname, 'migrations', '007_scope_sales_and_floor_history.sql');
  if (!fs.existsSync(sqlPath)) { console.error('Could not find', sqlPath); process.exit(1); }
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('🚀 Running migrations/007_scope_sales_and_floor_history.sql ...\n');
  console.log('Before:', await getConstraintShape());

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

  console.log('\nAfter:', await getConstraintShape());
  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
