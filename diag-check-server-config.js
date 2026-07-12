/**
 * Diagnostic only -- no writes. migrate-configs.js does a wholesale
 * ON CONFLICT DO UPDATE SET config = EXCLUDED.config, not a merge -- when
 * the old bot_state blob (9 keys, OCAS's full config) "won" against an
 * existing server_configs row (1 key, likely Fluxeto from earlier config
 * wizard testing), it replaced the whole thing instead of merging the two.
 * Checking the actual current state before deciding on a fix.
 *
 * USAGE
 *   node diag-check-server-config.js <guildId>
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const guildId = (process.argv[2] || '').trim();
if (!guildId) {
  console.log('Usage: node diag-check-server-config.js <guildId>');
  process.exit(1);
}

async function main() {
  console.log(`\n=== Current server_configs row for guild ${guildId} ===\n`);
  const res = await pool.query(`SELECT config FROM server_configs WHERE guild_id=$1`, [guildId]);
  if (!res.rows.length) {
    console.log('  No row at all for this guild.');
  } else {
    console.log(JSON.stringify(res.rows[0].config, null, 2));
  }

  console.log(`\n=== Original bot_state blob entry for this guild (source of the migration) ===\n`);
  const blobRes = await pool.query(`SELECT value FROM bot_state WHERE key='server_configs'`);
  if (blobRes.rows.length) {
    const raw = blobRes.rows[0].value;
    const configs = typeof raw === 'string' ? JSON.parse(raw) : raw;
    console.log(JSON.stringify(configs[guildId] || '(not found in blob)', null, 2));
  } else {
    console.log('  No bot_state server_configs blob found at all.');
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
