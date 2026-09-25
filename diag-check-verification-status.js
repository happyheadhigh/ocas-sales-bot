/**
 * Diagnostic only -- no writes. jv reports TraitView still shows "wallet
 * verified" and the bot's /me shows "not verified" / "TraitView not
 * linked" after the production cutover. Confirmed TraitView's own frontend
 * has zero reference to any real verification check (traitview_links,
 * claim-code, isVerified all absent from js/app.js) -- its "verified"
 * display is just whatever wallet address is sitting in browser
 * localStorage from a previous session, not a real database check.
 *
 * This checks production's actual user_registrations and traitview_links
 * tables for this wallet, to confirm whether verification has ever
 * actually happened against production's database specifically (as
 * opposed to only ever having been tested on staging, a separate
 * database).
 *
 * USAGE
 *   node diag-check-verification-status.js <walletAddress>
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const wallet = (process.argv[2] || '').trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
  console.log('Usage: node diag-check-verification-status.js <walletAddress>');
  process.exit(1);
}

async function main() {
  console.log(`\n=== user_registrations for wallet ${wallet} ===\n`);
  const regRes = await pool.query(
    `SELECT discord_id, guild_id, wallet, verified_at FROM user_registrations WHERE LOWER(wallet) = LOWER($1)`,
    [wallet]
  );
  if (!regRes.rows.length) {
    console.log('  No rows at all for this wallet -- never verified on THIS database.');
  } else {
    for (const r of regRes.rows) {
      console.log(`  discord_id=${r.discord_id}  guild_id=${r.guild_id}  verified_at=${r.verified_at}`);
    }
  }

  console.log(`\n=== traitview_links for wallet ${wallet} ===\n`);
  const linkRes = await pool.query(
    `SELECT discord_id, wallet, linked_at FROM traitview_links WHERE LOWER(wallet) = LOWER($1)`,
    [wallet]
  );
  if (!linkRes.rows.length) {
    console.log('  No rows at all for this wallet -- never linked via TraitView on THIS database.');
  } else {
    for (const r of linkRes.rows) {
      console.log(`  discord_id=${r.discord_id}  linked_at=${r.linked_at}`);
    }
  }

  console.log('\n=== Verdict ===');
  if (!regRes.rows.length && !linkRes.rows.length) {
    console.log('Confirmed: this wallet has no verification record on THIS database at all.');
    console.log('If you previously verified while testing on staging, that record lives in');
    console.log('staging\'s separate database -- production genuinely has never seen this');
    console.log('verification happen. Re-verifying through the bot now is the correct, expected');
    console.log('fix, not a workaround for a bug.');
  } else {
    console.log('A record DOES exist on this database -- if the bot still reports "not');
    console.log('verified" despite this, that would be a genuine bug worth digging into');
    console.log('further, not a staging/production data gap.');
  }
}

main().then(() => pool.end()).catch(e => { console.error('Query failed:', e.message); pool.end(); process.exit(1); });
