'use strict';

const crypto = require('crypto');
const { PENDING_DRAW_SEED_PREFIX, DEFAULT_LOTTERY_TIMEZONE } = require('../lib/constants');

// ── Lottery crypto ────────────────────────────────────────────────────────────
function lotteryHash(seed){
  return crypto.createHash('sha256').update(String(seed)).digest('hex');
}

function lotteryPick(entries, seed){
  if(!entries.length) return null;
  const h   = lotteryHash(seed + '\n' + entries.join('|'));
  const idx = Number(BigInt('0x' + h) % BigInt(entries.length));
  return { winner: entries[idx], index: idx, position: idx + 1, proof: h };
}

function randomLotterySeed(){
  return crypto.randomBytes(32).toString('hex');
}

function pendingDrawSeed(){
  return `${PENDING_DRAW_SEED_PREFIX}:${crypto.randomBytes(16).toString('hex')}`;
}

function isPendingDrawSeed(seed){
  return String(seed || '').startsWith(PENDING_DRAW_SEED_PREFIX);
}

// ── Date/time parsing ─────────────────────────────────────────────────────────
function parseLotteryDate(s, fallback = null, timeZone = DEFAULT_LOTTERY_TIMEZONE){
  if(!s) return fallback;
  const v = String(s).trim().toLowerCase();
  if(v === 'now') return new Date();

  // Date-only inputs (no time-of-day, no explicit UTC offset) are ambiguous —
  // native `new Date(...)` parses these as midnight UTC, which silently shifts
  // the actual moment by hours depending on the configured lottery timezone.
  // Resolve these as midnight in the lottery's timezone instead, so "June 16
  // 2026" means midnight in Europe/London (or whatever was configured), not UTC.
  const dateOnly = v.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/)                         // 2026-06-16
    || v.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/)                                      // 06-16-2026
    || v.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);                                        // June 16 2026 / June 16, 2026
  if(dateOnly && !/\d{1,2}:\d{2}|am|pm|utc|gmt|z$/.test(v)){
    const probe = new Date(s); // still use native parsing to resolve year/month/day correctly, including month names
    if(!Number.isNaN(probe.getTime())){
      return zonedDateTimeToUtc(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(), 0, 0, 0, timeZone);
    }
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function normalizeLotteryTimezone(tz){
  const v = String(tz || '').trim();
  if(!v) return DEFAULT_LOTTERY_TIMEZONE;
  const aliases = {
    uk: 'Europe/London', london: 'Europe/London', gmt: 'Europe/London',
    bst: 'Europe/London', eastern: 'America/New_York', et: 'America/New_York',
    est: 'America/New_York', edt: 'America/New_York', newyork: 'America/New_York',
    'new-york': 'America/New_York', ny: 'America/New_York', utc: 'UTC', z: 'UTC',
  };
  const key = v.toLowerCase().replace(/\s+/g, '').replace(/_/g, '-');
  const out = aliases[key] || v;
  try{
    new Intl.DateTimeFormat('en-US', { timeZone: out }).format(new Date());
    return out;
  }catch(_){
    throw new Error(`Invalid timezone "${v}". Use something like Europe/London or America/New_York.`);
  }
}

function zonedParts(date, timeZone){
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const o = {};
  for(const p of parts) if(p.type !== 'literal') o[p.type] = p.value;
  return {
    year: Number(o.year), month: Number(o.month), day: Number(o.day),
    hour: Number(o.hour === '24' ? '0' : o.hour), minute: Number(o.minute), second: Number(o.second)
  };
}

function timezoneOffsetMs(date, timeZone){
  const p     = zonedParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - date.getTime();
}

function zonedDateTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0, timeZone = DEFAULT_LOTTERY_TIMEZONE){
  const localAsUTC = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = localAsUTC - timezoneOffsetMs(new Date(localAsUTC), timeZone);
  utc     = localAsUTC - timezoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

function addDaysToYmd(year, month, day, delta){
  const d = new Date(Date.UTC(year, month - 1, day + delta, 12, 0, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function parseLotteryTimeToken(token){
  const s = String(token || '').trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if(!m) throw new Error(`Could not parse time "${token}". Try 10am, 10:30am, or 22:00.`);
  let hour       = Number(m[1]);
  const minute   = m[2] ? Number(m[2]) : 0;
  const ampm     = m[3];
  if(minute < 0 || minute > 59) throw new Error(`Invalid minute in "${token}".`);
  if(ampm){
    if(hour < 1 || hour > 12) throw new Error(`Invalid 12-hour time "${token}".`);
    if(ampm === 'pm' && hour !== 12) hour += 12;
    if(ampm === 'am' && hour === 12) hour = 0;
  }else if(hour < 0 || hour > 23){
    throw new Error(`Invalid 24-hour time "${token}".`);
  }
  return { hour, minute };
}

function parseLotteryDurationHours(text, fallbackHours = 24){
  const s = String(text || '').toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(w|week|weeks|d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/);
  if(!m) return fallbackHours;
  const n    = Number(m[1]);
  if(!Number.isFinite(n) || n <= 0) return fallbackHours;
  const unit = m[2];
  let hours;
  if(unit.startsWith('w'))                            hours = n * 168;
  else if(unit.startsWith('d'))                       hours = n * 24;
  else if(unit === 'm' || unit.startsWith('mi'))      hours = n / 60;
  else                                                hours = n;
  if(hours > 168) throw new Error('Window duration cannot exceed 168 hours (1 week).');
  if(hours < (1 / 60)) throw new Error('Window duration must be at least 1 minute.');
  return hours;
}

const LOTTERY_DURATION_RE = /(\d+(?:\.\d+)?)\s*(w|week|weeks|d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i;

function parseLotteryWindowAnchor(anchorText, timeZone, now = new Date()){
  let s        = String(anchorText || '').trim().toLowerCase();
  const ukStyle = s.startsWith('uk:');
  if(ukStyle) s  = s.slice(3).trim();
  if(!s || s === 'now') return new Date(now);

  s = s.replace(/\s+/g, '-');
  const rel = s.match(/^(yesterday|today|tomorrow)-(.+)$/);
  if(rel){
    const today = zonedParts(now, timeZone);
    const delta = rel[1] === 'yesterday' ? -1 : rel[1] === 'tomorrow' ? 1 : 0;
    const ymd   = addDaysToYmd(today.year, today.month, today.day, delta);
    const tm    = parseLotteryTimeToken(rel[2]);
    return zonedDateTimeToUtc(ymd.year, ymd.month, ymd.day, tm.hour, tm.minute, 0, timeZone);
  }

  const abs = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[- ](.+)$/);
  if(abs){
    const tm = parseLotteryTimeToken(abs[4]);
    return zonedDateTimeToUtc(Number(abs[1]), Number(abs[2]), Number(abs[3]), tm.hour, tm.minute, 0, timeZone);
  }

  const usAbs = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})[- ](.+)$/);
  if(usAbs){
    const day   = Number(ukStyle ? usAbs[1] : usAbs[2]);
    const month = Number(ukStyle ? usAbs[2] : usAbs[1]);
    if(month < 1 || month > 12 || day < 1 || day > 31){
      throw new Error(`Invalid ${ukStyle ? 'DD-MM-YYYY' : 'MM-DD-YYYY'} date in "${anchorText}".`);
    }
    const tm = parseLotteryTimeToken(usAbs[4]);
    return zonedDateTimeToUtc(Number(usAbs[3]), month, day, tm.hour, tm.minute, 0, timeZone);
  }

  const d = new Date(anchorText);
  if(!Number.isNaN(d.getTime())) return d;
  throw new Error(`Could not parse window "${anchorText}".`);
}

function resolveLotteryWindow({ windowText, startText, endText, hours, timezone, now = new Date() }){
  const timeZone     = normalizeLotteryTimezone(timezone);
  const fallbackHours = Math.max(1, Math.min(168, Number(hours || 24)));
  if(windowText){
    const durationHours = parseLotteryDurationHours(windowText, fallbackHours);
    const anchor        = String(windowText).replace(LOTTERY_DURATION_RE, '').trim();
    const start         = parseLotteryWindowAnchor(anchor || 'now', timeZone, now);
    const end           = new Date(start.getTime() + durationHours * 3600000);
    return { start, end, hours: durationHours, timeZone };
  }
  const start = parseLotteryDate(startText, null, timeZone);
  const end   = parseLotteryDate(endText, null, timeZone);
  if(start && end)   return { start, end, hours: (end - start) / 3600000, timeZone };
  if(start && !end)  return { start, end: new Date(start.getTime() + fallbackHours * 3600000), hours: fallbackHours, timeZone };
  if(!start && end)  return { start: new Date(end.getTime() - fallbackHours * 3600000), end, hours: fallbackHours, timeZone };
  const defaultEnd   = now;
  return { start: new Date(defaultEnd.getTime() - fallbackHours * 3600000), end: defaultEnd, hours: fallbackHours, timeZone };
}

module.exports = {
  lotteryHash, lotteryPick, randomLotterySeed, pendingDrawSeed, isPendingDrawSeed,
  parseLotteryDate, normalizeLotteryTimezone, resolveLotteryWindow,
  parseLotteryDurationHours, parseLotteryWindowAnchor, LOTTERY_DURATION_RE,
};
