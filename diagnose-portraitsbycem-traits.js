require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SLUG = 'portraitsbycem';

async function main(){
  console.log(`\n=== collection_traits rows for slug='${SLUG}', trait_name ILIKE 'emotion' ===`);
  const ct = await pool.query(
    `SELECT trait_name, trait_value, token_count FROM collection_traits
     WHERE slug=$1 AND trait_name ILIKE 'emotion' ORDER BY trait_value`,
    [SLUG]
  );
  console.log(`Rows found: ${ct.rows.length}`);
  console.table ? console.table(ct.rows) : console.log(JSON.stringify(ct.rows, null, 2));

  console.log(`\n=== token_traits rows for collection_slug='${SLUG}', trait_name ILIKE 'emotion' ===`);
  const tt = await pool.query(
    `SELECT trait_name, trait_value, COUNT(*) as cnt FROM token_traits
     WHERE collection_slug=$1 AND trait_name ILIKE 'emotion'
     GROUP BY trait_name, trait_value ORDER BY trait_value`,
    [SLUG]
  );
  console.log(`Rows found: ${tt.rows.length}`);
  console.log(JSON.stringify(tt.rows, null, 2));

  console.log(`\n=== Total token_traits row count for collection_slug='${SLUG}' (any trait) ===`);
  const totalTT = await pool.query(
    `SELECT COUNT(*) FROM token_traits WHERE collection_slug=$1`, [SLUG]
  );
  console.log(`Total rows: ${totalTT.rows[0].count}`);

  console.log(`\n=== Total tokens for collection_slug='${SLUG}' ===`);
  const totalTok = await pool.query(
    `SELECT COUNT(*) FROM tokens WHERE collection_slug=$1`, [SLUG]
  );
  console.log(`Total tokens: ${totalTok.rows[0].count}`);

  console.log(`\n=== Total listings for collection_slug='${SLUG}' ===`);
  const totalList = await pool.query(
    `SELECT COUNT(*) FROM listings WHERE collection_slug=$1`, [SLUG]
  );
  console.log(`Total listings: ${totalList.rows[0].count}`);

  console.log(`\n=== Sample of 5 token_traits rows for this slug, ANY trait (sanity check on casing/shape) ===`);
  const sample = await pool.query(
    `SELECT token_id, trait_name, trait_value FROM token_traits WHERE collection_slug=$1 LIMIT 5`,
    [SLUG]
  );
  console.log(JSON.stringify(sample.rows, null, 2));

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
