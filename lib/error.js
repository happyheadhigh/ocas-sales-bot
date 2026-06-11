'use strict';

const fetch = require('node-fetch');
const { ERROR_WEBHOOK_URL, BOT_ENV } = require('./constants');

// ── Error reporting webhook ───────────────────────────────────────────────────
const ENV_TAG = BOT_ENV === 'production' ? '🔴 PRODUCTION' : '🟡 STAGING';

async function sendErrorWebhook(title, err, extra = ''){
  if(!ERROR_WEBHOOK_URL) return;
  const msg = [
    `**[${ENV_TAG}] ${title}**`,
    err instanceof Error ? `\`\`\`${err.message}\`\`\`` : `\`\`\`${String(err)}\`\`\``,
    extra ? String(extra).slice(0, 500) : '',
  ].filter(Boolean).join('\n').slice(0, 2000);

  try{
    await fetch(ERROR_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg.slice(0, 2000), username: 'OCAS Bot Errors' }),
    });
  }catch(e){
    console.error('[ErrorWebhook] Failed to send:', e.message);
  }
}

// ── Startup env var checks ────────────────────────────────────────────────────
function checkStartupEnvVars(){
  const checks = [
    { key: 'DISCORD_TOKEN',    impact: 'Bot cannot log in' },
    { key: 'DATABASE_URL',     impact: 'No DB — all commands will fail' },
    { key: 'OPENSEA_KEY',      impact: 'Sales/listings polling disabled' },
    { key: 'ALCHEMY_API_KEY',  impact: 'Burn poller and ETH seed disabled' },
    { key: 'API_SECRET',       impact: 'API auth disabled — endpoints unprotected' },
    { key: 'ERROR_WEBHOOK_URL',impact: 'Error reporting disabled' },
  ];

  let hasWarnings = false;
  for(const { key, impact } of checks){
    if(!process.env[key]){
      console.warn(`[Startup] ⚠ Missing ${key}: ${impact}`);
      hasWarnings = true;
    }
  }
  if(!hasWarnings) console.log('[Startup] All required env vars present ✓');
}

module.exports = { sendErrorWebhook, checkStartupEnvVars, ENV_TAG };
