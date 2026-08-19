'use strict';

const fetch = require('node-fetch');
const { ERROR_WEBHOOK_URL, BOT_ENV } = require('./constants');

// ── Error reporting webhook ───────────────────────────────────────────────────
// Known deployments get a distinct tag + Discord username; anything else
// (including unset) falls back to STAGING, matching the original behavior
// for the two existing deployments exactly -- neither needs any change.
const ENV_LABELS = {
  production: { tag: '🔴 PRODUCTION', username: 'OCAS Bot Errors' },
  'tv-bot':    { tag: '🟣 TV Bot',     username: 'TV Bot Errors' },
};
const ENV_INFO = ENV_LABELS[String(BOT_ENV || '').toLowerCase()] || { tag: '🟡 STAGING', username: 'OCAS Bot Errors' };
const ENV_TAG = ENV_INFO.tag;

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
      body: JSON.stringify({ content: msg.slice(0, 2000), username: ENV_INFO.username }),
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
