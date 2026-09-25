'use strict';

const fetch = require('node-fetch');
const { ERROR_WEBHOOK_URL, ACTIVITY_WEBHOOK_URL, BOT_ENV } = require('./constants');

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

// ── Activity reporting webhook ─────────────────────────────────────────────────
// Separate from the error webhook in spirit (this is "here's who's using the
// bot", not "something's broken"), but reuses the exact same delivery
// mechanism and environment tagging. Uses ACTIVITY_WEBHOOK_URL if it's been
// set to a distinct channel, otherwise falls back to ERROR_WEBHOOK_URL so
// this works immediately with zero new setup required.
async function sendActivityWebhook(title, details = ''){
  const url = ACTIVITY_WEBHOOK_URL || ERROR_WEBHOOK_URL;
  if(!url) return;
  const msg = [
    `**[${ENV_TAG}] ${title}**`,
    details ? String(details).slice(0, 1500) : '',
  ].filter(Boolean).join('\n').slice(0, 2000);

  try{
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg.slice(0, 2000), username: `${ENV_INFO.username.replace(' Errors', '')} Activity` }),
    });
  }catch(e){
    console.error('[ActivityWebhook] Failed to send:', e.message);
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

module.exports = { sendErrorWebhook, sendActivityWebhook, checkStartupEnvVars, ENV_TAG };
