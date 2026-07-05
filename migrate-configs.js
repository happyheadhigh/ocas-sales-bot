/**
 * migrate-configs.js
 * One-time migration: reads server_configs from bot_state JSON blob
 * and writes each guild as its own row in the server_configs table.
 * 
 * Safe to run multiple times — ON CONFLICT DO UPDATE means existing
 * rows are overwritten only if bot_state has newer/different data.
 * 
 * Run with: node migrate-configs.js
 */

'use strict';

const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  console.log('[migrate] Starting server_configs migration...');

  // 1. Read the JSON blob from bot_state
  const res = await pgPool.query(
    `SELECT value FROM bot_state WHERE key = 'server_configs'`
  );

  if (!res.rows.length || !res.rows[0].value) {
    console.log('[migrate] No server_configs found in bot_state — nothing to migrate.');
    await pgPool.end();
    return;
  }

  const raw = res.rows[0].value;
  const configs = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const guildIds = Object.keys(configs);

  console.log(`[migrate] Found ${guildIds.length} guild(s) in bot_state:`, guildIds);

  // 2. Write each guild into server_configs table
  let migrated = 0;
  let skipped = 0;

  for (const guildId of guildIds) {
    const cfg = configs[guildId];
    if (!cfg || typeof cfg !== 'object') { skipped++; continue; }

    try {
      // Check if already in server_configs table
      const existing = await pgPool.query(
        `SELECT guild_id FROM server_configs WHERE guild_id = $1`,
        [guildId]
      );

      if (existing.rows.length) {
        // Already exists — only overwrite if bot_state has richer data
        // (more keys = more settings configured)
        const existingCfg = await pgPool.query(
          `SELECT config FROM server_configs WHERE guild_id = $1`,
          [guildId]
        );
        const existingData = existingCfg.rows[0]?.config || {};
        const existingKeys = Object.keys(existingData).length;
        const incomingKeys = Object.keys(cfg).length;

        if (incomingKeys <= existingKeys) {
          console.log(`[migrate] Guild ${guildId}: already in table with ${existingKeys} keys (incoming has ${incomingKeys}) — skipping`);
          skipped++;
          continue;
        }
        console.log(`[migrate] Guild ${guildId}: updating (incoming has more keys: ${incomingKeys} vs ${existingKeys})`);
      }

      await pgPool.query(
        `INSERT INTO server_configs(guild_id, config)
         VALUES($1, $2)
         ON CONFLICT(guild_id) DO UPDATE SET config = EXCLUDED.config`,
        [guildId, JSON.stringify(cfg)]
      );

      console.log(`[migrate] Guild ${guildId}: ✓ migrated (slug: ${cfg.slug || cfg.collectionSlug || 'unknown'})`);
      migrated++;

    } catch (e) {
      console.error(`[migrate] Guild ${guildId}: ERROR — ${e.message}`);
    }
  }

  console.log(`\n[migrate] Done. Migrated: ${migrated}, Skipped: ${skipped}`);

  // 3. Verify
  const verify = await pgPool.query(`SELECT guild_id FROM server_configs`);
  console.log(`[migrate] server_configs table now has ${verify.rows.length} row(s):`, verify.rows.map(r => r.guild_id));

  await pgPool.end();
}

migrate().catch(e => {
  console.error('[migrate] Fatal error:', e.message);
  process.exit(1);
});
