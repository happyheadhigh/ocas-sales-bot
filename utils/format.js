'use strict';

const { DEFAULT_LOTTERY_TIMEZONE } = require('../lib/constants');
const fetch = require('node-fetch');

// ── Address helpers ───────────────────────────────────────────────────────────
function normAddr(addr){
  const s = String(addr || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : '';
}

function shortAddr(addr){
  if(!addr || addr.length < 10) return addr || 'unknown';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

// ── ETH price helpers ─────────────────────────────────────────────────────────
function trimEth(eth){
  if(!isFinite(eth) || eth <= 0) return null;
  return eth >= 1 ? String(parseFloat(eth.toFixed(3))) : String(parseFloat(eth.toFixed(5)));
}

function formatEth(event){
  try{
    const qty = BigInt(event.payment?.quantity || '0');
    const dec = event.payment?.decimals ?? 18;
    const eth = Number(qty) / Math.pow(10, dec);
    return trimEth(eth);
  }catch{ return null; }
}

function formatListingEth(listing){
  try{
    const qty = listing.payment?.quantity;
    if(!qty) return null;
    const dec = listing.payment?.decimals ?? 18;
    const eth = Number(qty) / Math.pow(10, dec);
    return trimEth(eth);
  }catch{ return null; }
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function timeSince(ts){
  const s = Math.floor(Date.now() / 1000 - ts);
  if(s < 60)      return s + 's ago';
  if(s < 3600)    return Math.floor(s / 60) + 'm ago';
  if(s < 86400)   return Math.floor(s / 3600) + 'h ago';
  if(s < 2592000) return Math.floor(s / 86400) + 'd ago';
  if(s < 31536000) return Math.floor(s / 2592000) + 'mo ago';
  return Math.floor(s / 31536000) + 'y ago';
}

function lotteryTime(d){ return `<t:${Math.floor(new Date(d).getTime() / 1000)}:f>`; }

function formatLotteryHours(hours){
  const n = Number(hours);
  if(!Number.isFinite(n)) return 'unknown';
  if(n < 1){
    const mins = Math.round(n * 60);
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  return (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))) + ' hour' + (n === 1 ? '' : 's');
}

function burnLotteryWindowDurationHours(start, end){
  return (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
}

function burnLotteryWindowSummary(start, end){
  return `${lotteryTime(start)} -> ${lotteryTime(end)}\nDuration: ${formatLotteryHours(burnLotteryWindowDurationHours(start, end))}`;
}

function formatBurnLotteryWindow(start, end){ return burnLotteryWindowSummary(start, end); }

function formatBurnLotteryLocalTime(d, timeZone){
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(new Date(d)).replace(/\b(am|pm)\b/ig, m => m.toUpperCase());
}

function burnLotteryWindowStatusLine(row){
  const tz    = row.timezone || DEFAULT_LOTTERY_TIMEZONE;
  const start = new Date(row.start_time);
  const end   = new Date(row.end_time);
  return `#${row.id} · ${row.status} · ${lotteryTime(start)} -> ${lotteryTime(end)} · ${formatLotteryHours(burnLotteryWindowDurationHours(start, end))} · ${tz}${row.winner_wallet ? ' · winner ' + shortAddr(row.winner_wallet) : ''}`;
}

// ── Image helpers ─────────────────────────────────────────────────────────────
function isSvg(url){
  if(!url) return false;
  const s = String(url).trim();
  // Detects SVG content or SVG URLs — used for rendering decisions
  return s.startsWith('<svg') || s.startsWith('data:image/svg') || s.toLowerCase().endsWith('.svg') || s.includes('image/svg');
}

function isDiscordOk(url){
  if(!url) return false;
  const s = url.toLowerCase();
  if(!s.startsWith('http://') && !s.startsWith('https://')) return false;
  if(s.startsWith('data:')) return false;
  // Block raw SVG markup but allow HTTPS .svg URLs from known CDNs that Discord can render
  if(s.startsWith('<svg') || s.includes('data:image/svg') || s.includes('image/svg')) return false;
  // Block raw .svg URLs that OpenSea serves (Discord cannot render them) but allow
  // Alchemy CDN and seadn which serve pre-rendered images even if URL ends in .svg
  if(s.endsWith('.svg')){
    if(s.includes('nft2-cdn.alchemy.com') || s.includes('nft3-cdn.alchemy.com')) return true;
    return false;
  }
  return true;
}

// Confirmed live: the assumption baked into isDiscordOk above -- that
// nft2-cdn.alchemy.com/nft3-cdn.alchemy.com always serve pre-rendered raster
// images "even if URL ends in .svg" -- is not reliably true. Alchemy's CDN
// can and does serve genuine SVG content through a URL with ZERO textual
// indication of that at all (no .svg extension, no "image/svg" substring,
// just a hash-like path) -- isDiscordOk's entire approach is pattern-
// matching the URL string, which can never catch this, since there's
// nothing in the URL itself to match against. The only reliable way to know
// what a URL actually serves is to ask the server. isDiscordOk is still
// useful as a fast, free first-pass filter (rejects non-http, data URIs,
// raw markup, obviously-bad .svg links) -- this is the authoritative check
// for anything that passes it and is about to be used directly, without a
// render step as a fallback.
//
// A HEAD request (no body download) is enough. Falls back to treating a
// URL as fine if the check itself fails for any reason (network hiccup, no
// HEAD support) -- avoids losing a genuinely good image over an unrelated
// verification failure.
async function verifyImageIsRaster(url){
  try{
    const r = await fetch(url, { method: 'HEAD', timeout: 5000 });
    const contentType = (r.headers.get('content-type') || '').toLowerCase();
    if(!contentType) return true; // no header to go on — don't block over it
    return contentType.startsWith('image/') && !contentType.includes('svg');
  }catch(e){
    return true;
  }
}

// ── Trait filter matching ─────────────────────────────────────────────────────
function matchesFilters(traits, filters){
  if(!filters || Object.keys(filters).length === 0) return true;
  const lookup = {};
  for(const t of (traits || [])) lookup[t.trait_type?.toLowerCase()] = String(t.value).toLowerCase();
  for(const [k, v] of Object.entries(filters)){
    const allowed = Array.isArray(v) ? v : [v];
    if(allowed.map(a => String(a).toLowerCase()).includes(lookup[k])) return true;
  }
  return false;
}

module.exports = {
  normAddr, shortAddr, trimEth, formatEth, formatListingEth,
  timeSince, lotteryTime, formatLotteryHours,
  burnLotteryWindowDurationHours, burnLotteryWindowSummary,
  formatBurnLotteryWindow, formatBurnLotteryLocalTime,
  burnLotteryWindowStatusLine, isSvg, isDiscordOk, matchesFilters,
  verifyImageIsRaster,
};
