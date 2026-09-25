'use strict';
/* Push notifications for TraitView (installed web app).
   jv: "push notifications should work just like the discord bot... a 🔔 ...
   floor price alerts, listing alerts, trait, trait counts, or specific
   token #... newly minted tokens, or burns". First build (jv's picks):
   new listings under a price (any / trait / trait count), new mints, burns.

   Shared by BOTH processes: api.js (listings sync) and bot.js (burn poller,
   new-token poller) -- they share one database, so VAPID keys,
   subscriptions and rules all live there. The VAPID keypair is generated
   once and stored (push_config), so nothing has to be configured on
   Railway. No accounts: each installed app's push subscription IS the
   subscriber identity.

   Tables:
     push_config        key/value (VAPID keys)
     push_subscriptions one row per device (endpoint + encryption keys)
     push_rules         what that device wants to hear about
   Matching sends ONE summary notification per rule per batch (a sweep of
   40 listings = 1 notification, not 40). Dead subscriptions (404/410 from
   the push service) are deleted automatically. */
const webpush = require('web-push');
const { pgPool } = require('./db');

let _ready = null;
function ensurePush(){
  if(_ready) return _ready;
  _ready = (async () => {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS push_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await pgPool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      user_agent TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), last_ok_at TIMESTAMPTZ)`);
    await pgPool.query(`CREATE TABLE IF NOT EXISTS push_rules (
      id SERIAL PRIMARY KEY,
      subscription_id INT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
      collection_slug TEXT NOT NULL, collection_name TEXT,
      kind TEXT NOT NULL,                -- 'listing' | 'mint' | 'burn'
      scope TEXT NOT NULL DEFAULT 'any', -- listing: 'any' | 'trait' | 'traitcount'
      trait_name TEXT, trait_value TEXT, trait_count INT,
      excluded_categories JSONB,         -- non-worn categories (count like the site does)
      max_price_eth NUMERIC,
      created_at TIMESTAMPTZ DEFAULT NOW(), last_sent_at TIMESTAMPTZ)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS push_rules_slug_kind ON push_rules (collection_slug, kind)`);
    // Floor alerts (kind 'floor'): direction 'below' | 'above' a threshold.
    await pgPool.query(`ALTER TABLE push_rules ADD COLUMN IF NOT EXISTS direction TEXT`);
    await pgPool.query(`ALTER TABLE push_rules ADD COLUMN IF NOT EXISTS threshold_eth NUMERIC`);
    // 'token' scope (a specific token #) for listing + sale alerts.
    await pgPool.query(`ALTER TABLE push_rules ADD COLUMN IF NOT EXISTS token_id INT`);
    // Wallet watch (kind 'wallet'): every buy / sell / mint / transfer / burn
    // of this collection by that wallet.
    await pgPool.query(`ALTER TABLE push_rules ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS push_rules_wallet ON push_rules (collection_slug, wallet_address) WHERE kind = 'wallet'`);
    // Activity inbox: every notification a device was sent, kept so the bell
    // can show a feed after the notification itself is gone.
    await pgPool.query(`CREATE TABLE IF NOT EXISTS push_inbox (
      id BIGSERIAL PRIMARY KEY,
      subscription_id INT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
      collection_slug TEXT, kind TEXT, title TEXT, body TEXT, url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS push_inbox_sub ON push_inbox (subscription_id, created_at DESC)`);
    await pgPool.query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS inbox_seen_at TIMESTAMPTZ`);
    // VAPID keys: generate once, keep forever (rotating them would silently
    // break every existing subscription).
    let r = await pgPool.query(`SELECT key, value FROM push_config WHERE key IN ('vapid_public','vapid_private')`);
    let cfg = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    if(!cfg.vapid_public || !cfg.vapid_private){
      const k = webpush.generateVAPIDKeys();
      await pgPool.query(`INSERT INTO push_config (key, value) VALUES ('vapid_public',$1),('vapid_private',$2) ON CONFLICT (key) DO NOTHING`, [k.publicKey, k.privateKey]);
      r = await pgPool.query(`SELECT key, value FROM push_config WHERE key IN ('vapid_public','vapid_private')`);
      cfg = Object.fromEntries(r.rows.map(x => [x.key, x.value]));   // re-read: the other process may have won the race
    }
    webpush.setVapidDetails('mailto:alerts@traitview.com', cfg.vapid_public, cfg.vapid_private);
    return cfg.vapid_public;
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

const INBOX_KEEP = 300; // per device
async function recordInbox(sub, payload){
  if(!payload || payload.tag === 'test') return;
  try{
    await pgPool.query(`INSERT INTO push_inbox (subscription_id, collection_slug, kind, title, body, url) VALUES ($1,$2,$3,$4,$5,$6)`,
      [sub.id, payload.slug || null, payload.kind || null, String(payload.title || '').slice(0, 300), String(payload.body || '').slice(0, 600), String(payload.url || '').slice(0, 500)]);
    if(Math.random() < 0.05){
      await pgPool.query(`DELETE FROM push_inbox WHERE subscription_id = $1 AND id NOT IN (SELECT id FROM push_inbox WHERE subscription_id = $1 ORDER BY id DESC LIMIT ${INBOX_KEEP})`, [sub.id]);
    }
  }catch(e){ console.warn('[push] inbox record failed', e.message); }
}
async function sendToSubscription(sub, payload){
  // jv (Activity Inbox): kept even if the push itself fails, so the bell
  // feed still shows it.
  await recordInbox(sub, payload);
  try{
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
    pgPool.query(`UPDATE push_subscriptions SET last_ok_at = NOW() WHERE id = $1`, [sub.id]).catch(() => {});
    return true;
  }catch(e){
    if(e.statusCode === 404 || e.statusCode === 410){
      await pgPool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]).catch(() => {});
    } else {
      console.warn('[push] send failed', e.statusCode || '', (e.body || e.message || '').toString().slice(0, 160));
    }
    return false;
  }
}

async function rulesFor(slug, kind){
  await ensurePush();
  const r = await pgPool.query(
    `SELECT r.*, s.endpoint, s.p256dh, s.auth, s.id AS sub_id
     FROM push_rules r JOIN push_subscriptions s ON s.id = r.subscription_id
     WHERE r.collection_slug = $1 AND r.kind = $2`, [slug, kind]);
  return r.rows;
}
const fmtEth = v => { const n = Number(v); return (n >= 10 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4)).replace(/\.?0+$/, ''); };
const collectionUrl = slug => `/?collection=${encodeURIComponent(slug)}`;

// Token traits for a set of ids: { id: { name: value } }
async function traitsFor(slug, ids){
  if(!ids.length) return {};
  const r = await pgPool.query(
    `SELECT token_id, trait_name, trait_value FROM token_traits WHERE collection_slug = $1 AND token_id = ANY($2::int[])`,
    [slug, ids]);
  const out = {};
  for(const row of r.rows) (out[row.token_id] ||= {})[row.trait_name] = row.trait_value;
  return out;
}
function ruleMatchesToken(rule, traits, tokenId){
  if(rule.scope === 'token') return Number(tokenId) === Number(rule.token_id);
  if(rule.scope === 'trait') return String(traits?.[rule.trait_name]) === String(rule.trait_value);
  if(rule.scope === 'traitcount'){
    const excluded = new Set((rule.excluded_categories || []).map(c => String(c).toLowerCase()));
    const n = Object.keys(traits || {}).filter(k => !excluded.has(k.toLowerCase())).length;
    return n === Number(rule.trait_count);
  }
  return true;
}
function scopeLabel(rule){
  if(rule.scope === 'trait') return `${rule.trait_name}: ${rule.trait_value}`;
  if(rule.scope === 'traitcount') return `${rule.trait_count} trait${Number(rule.trait_count) === 1 ? '' : 's'}`;
  if(rule.scope === 'token') return `Token #${rule.token_id}`;
  return null;
}

/* New listings: [{ tokenId, priceEth }] -- tokens newly listed or relisted
   lower this sync cycle (see sync-listings.js). */
async function notifyNewListings(slug, listings){
  if(!listings || !listings.length) return;
  const rules = await rulesFor(slug, 'listing');
  if(!rules.length) return;
  const needTraits = rules.some(r => r.scope === 'trait' || r.scope === 'traitcount');
  const traits = needTraits ? await traitsFor(slug, listings.map(l => l.tokenId)) : {};
  for(const rule of rules){
    const max = rule.max_price_eth != null ? Number(rule.max_price_eth) : Infinity;
    const hits = listings.filter(l => l.priceEth <= max && ruleMatchesToken(rule, traits[l.tokenId], l.tokenId))
                         .sort((a, b) => a.priceEth - b.priceEth);
    if(!hits.length) continue;
    const name = rule.collection_name || slug;
    const scope = scopeLabel(rule);
    const best = hits[0];
    // jv: "In the notification it will display ... token #, ivory cloak,
    // listing price ... For trait count it would show the trait count."
    // Title = what & how much; body = which filter matched (+ your limit).
    const limit = max !== Infinity ? `under your Ξ${fmtEth(max)} alert` : 'just listed';
    let title, body;
    if(hits.length === 1){
      title = `${name} #${best.tokenId} · Ξ${fmtEth(best.priceEth)}`;
      body = `${scope || 'New listing'} · ${limit}`;
    } else {
      title = `${hits.length} new ${name} listings` + (scope ? ` · ${scope}` : '');
      body = hits.slice(0, 4).map(h => `#${h.tokenId} Ξ${fmtEth(h.priceEth)}`).join(' · ')
        + (hits.length > 4 ? ` · +${hits.length - 4} more` : '') + (max !== Infinity ? ` (under Ξ${fmtEth(max)})` : '');
    }
    await sendToSubscription({ id: rule.sub_id, endpoint: rule.endpoint, p256dh: rule.p256dh, auth: rule.auth },
      { title, body, url: `${collectionUrl(slug)}&token=${best.tokenId}`, tag: `listing-${rule.id}`, slug, kind: 'listing' });
    pgPool.query(`UPDATE push_rules SET last_sent_at = NOW() WHERE id = $1`, [rule.id]).catch(() => {});
  }
}

async function notifySimple(slug, kind, ids, verbSingle, verbMany){
  if(!ids || !ids.length) return;
  const rules = await rulesFor(slug, kind);
  for(const rule of rules){
    const name = rule.collection_name || slug;
    const title = ids.length === 1 ? `${name} #${ids[0]} ${verbSingle}` : `${ids.length} ${name} tokens ${verbMany}`;
    const body = ids.length === 1 ? '' : ids.slice(0, 6).map(i => '#' + i).join(', ') + (ids.length > 6 ? ` +${ids.length - 6} more` : '');
    await sendToSubscription({ id: rule.sub_id, endpoint: rule.endpoint, p256dh: rule.p256dh, auth: rule.auth },
      { title, body, url: ids.length === 1 ? `${collectionUrl(slug)}&token=${ids[0]}` : collectionUrl(slug), tag: `${kind}-${rule.id}`, slug, kind });
    pgPool.query(`UPDATE push_rules SET last_sent_at = NOW() WHERE id = $1`, [rule.id]).catch(() => {});
  }
}
/* Sales: [{ tokenId, priceEth, currency, buyer }] -- rows the bot just
   INSERTED (so each sale notifies once, whichever path saw it first). jv:
   "I dont have the option for sales alerts". Same targeting as listings
   (any / trait / trait count / token #). One summary per rule per batch. */
async function notifySales(slug, sales){
  if(!sales || !sales.length) return;
  const rules = await rulesFor(slug, 'sale');
  if(!rules.length) return;
  const needTraits = rules.some(r => r.scope === 'trait' || r.scope === 'traitcount');
  const traits = needTraits ? await traitsFor(slug, sales.map(x => x.tokenId)) : {};
  const short = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
  for(const rule of rules){
    const hits = sales.filter(x => ruleMatchesToken(rule, traits[x.tokenId], x.tokenId)).sort((a, b) => b.priceEth - a.priceEth);
    if(!hits.length) continue;
    const name = rule.collection_name || slug;
    const scope = scopeLabel(rule);
    const top = hits[0];
    let title, body;
    if(hits.length === 1){
      title = `${name} #${top.tokenId} sold · Ξ${fmtEth(top.priceEth)}`;
      body = (scope ? scope + ' · ' : '') + (top.buyer ? `Bought by ${short(top.buyer)}` : 'New sale');
    } else {
      title = `${hits.length} ${name} sales` + (scope ? ` · ${scope}` : '');
      body = hits.slice(0, 4).map(h => `#${h.tokenId} Ξ${fmtEth(h.priceEth)}`).join(' · ') + (hits.length > 4 ? ` · +${hits.length - 4} more` : '');
    }
    await sendToSubscription({ id: rule.sub_id, endpoint: rule.endpoint, p256dh: rule.p256dh, auth: rule.auth },
      { title, body, url: `${collectionUrl(slug)}&token=${top.tokenId}`, tag: `sale-${rule.id}`, slug, kind: 'sale' });
    pgPool.query(`UPDATE push_rules SET last_sent_at = NOW() WHERE id = $1`, [rule.id]).catch(() => {});
  }
}
// Only sales from the last 30 minutes alert -- a history backfill never does.
function freshSales(rows){
  const cutoff = Date.now() - 30 * 60_000;
  return (rows || []).map(r => ({ tokenId: parseInt(r.token_id, 10), priceEth: parseFloat(r.price_eth), currency: r.currency, buyer: r.buyer, seller: r.seller || null, tx: r.tx_hash || null,
      ts: new Date(r.sale_ts).getTime() }))
    .filter(x => Number.isFinite(x.tokenId) && x.priceEth > 0 && x.ts >= cutoff);
}

/* Floor crossed a threshold. jv: "floor price would show the threshold it
   crossed and the current floor price." Fires on the CROSSING (was above
   and is now at/below for 'below'; the reverse for 'above'), not while the
   floor merely sits past the line; a floor bouncing around the line
   re-alerts at most every 30 min per rule. */
const FLOOR_COOLDOWN_MS = 30 * 60_000;
async function notifyFloor(slug, prevFloor, newFloor, floorTokenId){
  if(!(prevFloor > 0) || !(newFloor > 0) || prevFloor === newFloor) return;
  const rules = await rulesFor(slug, 'floor');
  for(const rule of rules){
    const t = Number(rule.threshold_eth);
    if(!(t > 0)) continue;
    const crossed = rule.direction === 'above' ? (prevFloor < t && newFloor >= t) : (prevFloor > t && newFloor <= t);
    if(!crossed) continue;
    if(rule.last_sent_at && Date.now() - new Date(rule.last_sent_at).getTime() < FLOOR_COOLDOWN_MS) continue;
    const name = rule.collection_name || slug;
    await sendToSubscription({ id: rule.sub_id, endpoint: rule.endpoint, p256dh: rule.p256dh, auth: rule.auth }, {
      title: `${name} floor ${rule.direction === 'above' ? 'above' : 'below'} Ξ${fmtEth(t)}`,
      body: `Now Ξ${fmtEth(newFloor)} · was Ξ${fmtEth(prevFloor)}` + (floorTokenId != null ? ` · floor #${floorTokenId}` : ''),
      url: floorTokenId != null ? `${collectionUrl(slug)}&token=${floorTokenId}` : collectionUrl(slug),
      tag: `floor-${rule.id}`, slug, kind: 'floor' });
    pgPool.query(`UPDATE push_rules SET last_sent_at = NOW() WHERE id = $1`, [rule.id]).catch(() => {});
  }
}

/* Wallet watch. jv (from the ChatGPT idea list): "Alert me when this wallet
   buys or sells" + "a push notification could take me directly back to
   that ... wallet inside the sales chart". Events for a watched wallet:
     sales     -> notifyWalletSales (same fresh-sale hook as sale alerts)
     transfers -> notifyWalletMoves (mints, plain in/out, burns -- from the
                  collection-wide transfer sync; sales are skipped there)
   One summary per rule per batch. Tapping opens Wallet History for that
   wallet (&whist=0x..). */
const shortAddr = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
async function walletRulesFor(slug, wallets){
  if(!wallets.length) return [];
  await ensurePush();
  const r = await pgPool.query(
    `SELECT r.*, s.endpoint, s.p256dh, s.auth, s.id AS sub_id
     FROM push_rules r JOIN push_subscriptions s ON s.id = r.subscription_id
     WHERE r.collection_slug = $1 AND r.kind = 'wallet' AND r.wallet_address = ANY($2::text[])`, [slug, wallets]);
  return r.rows;
}
function walletUrl(slug, wallet, tokenId){
  // (&whist, not &wallet: TraitView's ?wallet= is the private
  // linked-wallet analytics link, gated behind Discord verification)
  return `${collectionUrl(slug)}&whist=${wallet}` + (tokenId != null ? `&wtoken=${tokenId}` : '');
}
async function sendWalletSummary(rule, slug, events){
  // events: [{ verb, tokenId, priceEth? }]
  const name = rule.collection_name || slug;
  const who = shortAddr(rule.wallet_address);
  let title, body;
  if(events.length === 1){
    const e = events[0];
    title = `${who} ${e.verb} ${name} #${e.tokenId}` + (e.priceEth ? ` · Ξ${fmtEth(e.priceEth)}` : '');
    body = e.note || 'Watched wallet';
  } else {
    const counts = {};
    for(const e of events) counts[e.verb] = (counts[e.verb] || 0) + 1;
    title = `${who}: ` + Object.entries(counts).map(([v, n]) => `${v} ${n}`).join(', ') + ` ${name}`;
    body = events.slice(0, 4).map(e => `#${e.tokenId}${e.priceEth ? ` Ξ${fmtEth(e.priceEth)}` : ''}`).join(' · ') + (events.length > 4 ? ` · +${events.length - 4} more` : '');
  }
  await sendToSubscription({ id: rule.sub_id, endpoint: rule.endpoint, p256dh: rule.p256dh, auth: rule.auth },
    { title, body, url: walletUrl(slug, rule.wallet_address, events[0].tokenId), tag: `wallet-${rule.id}`, slug, kind: 'wallet' });
  pgPool.query(`UPDATE push_rules SET last_sent_at = NOW() WHERE id = $1`, [rule.id]).catch(() => {});
}
async function notifyWalletSales(slug, sales){
  if(!sales || !sales.length) return;
  const lower = x => (x || '').toLowerCase();
  const wallets = [...new Set(sales.flatMap(x => [lower(x.buyer), lower(x.seller)]).filter(Boolean))];
  const rules = await walletRulesFor(slug, wallets);
  for(const rule of rules){
    const w = rule.wallet_address;
    const events = [];
    for(const x of sales){
      if(lower(x.buyer) === w) events.push({ verb: 'bought', tokenId: x.tokenId, priceEth: x.priceEth, note: x.seller ? `from ${shortAddr(lower(x.seller))}` : 'Watched wallet' });
      if(lower(x.seller) === w) events.push({ verb: 'sold', tokenId: x.tokenId, priceEth: x.priceEth, note: x.buyer ? `to ${shortAddr(lower(x.buyer))}` : 'Watched wallet' });
    }
    if(events.length) await sendWalletSummary(rule, slug, events);
  }
}
const ZERO_ADDR = '0x0000000000000000000000000000000000000000', DEAD_ADDR = '0x000000000000000000000000000000000000dead';
/* moves: [{ tokenId, from, to, tx, ts(ms) }] freshly inserted transfers. */
async function notifyWalletMoves(slug, moves){
  if(!moves || !moves.length) return;
  const cutoff = Date.now() - 30 * 60_000;
  const fresh = moves.filter(m => m.ts && m.ts >= cutoff);
  if(!fresh.length) return;
  const wallets = [...new Set(fresh.flatMap(m => [m.from, m.to]).filter(a => a && a !== ZERO_ADDR && a !== DEAD_ADDR))];
  const rules = await walletRulesFor(slug, wallets);
  if(!rules.length) return;
  // Sales already alerted through notifyWalletSales -- skip their transfers.
  const txs = [...new Set(fresh.map(m => m.tx).filter(Boolean))];
  const saleTx = new Set();
  if(txs.length){
    const r = await pgPool.query(`SELECT LOWER(tx_hash) AS tx FROM sales WHERE collection_slug = $1 AND LOWER(tx_hash) = ANY($2::text[])`, [slug, txs]).catch(() => ({ rows: [] }));
    for(const x of r.rows) saleTx.add(x.tx);
  }
  for(const rule of rules){
    const w = rule.wallet_address;
    const events = [];
    for(const m of fresh){
      if(m.tx && saleTx.has(m.tx)) continue;
      if(m.to === w && m.from === ZERO_ADDR) events.push({ verb: 'minted', tokenId: m.tokenId, note: 'New mint' });
      else if(m.from === w && (m.to === ZERO_ADDR || m.to === DEAD_ADDR)) events.push({ verb: 'burned', tokenId: m.tokenId, note: 'Burned' });
      else if(m.to === w) events.push({ verb: 'received', tokenId: m.tokenId, note: `from ${shortAddr(m.from)} · no sale recorded` });
      else if(m.from === w) events.push({ verb: 'sent', tokenId: m.tokenId, note: `to ${shortAddr(m.to)} · no sale recorded` });
    }
    if(events.length) await sendWalletSummary(rule, slug, events);
  }
}

const notifyMints = (slug, ids) => notifySimple(slug, 'mint', ids, 'was just minted', 'just minted');
const notifyBurns = (slug, ids) => notifySimple(slug, 'burn', ids, 'was just burned', 'just burned');

// Never let alerts break the pipeline that detected the event.
const safe = fn => (...args) => { Promise.resolve().then(() => fn(...args)).catch(e => console.warn('[push]', e.message)); };

module.exports = {
  ensurePush, sendToSubscription,
  notifyNewListings: safe(notifyNewListings), notifyMints: safe(notifyMints), notifyBurns: safe(notifyBurns), notifyFloor: safe(notifyFloor),
  // sale hooks call notifySales -- it now also covers watched wallets
  notifySales: safe(async (slug, sales) => { await notifySales(slug, sales); await notifyWalletSales(slug, sales); }),
  notifyWalletMoves: safe(notifyWalletMoves), freshSales,
  _test: { ruleMatchesToken, scopeLabel, notifyNewListings, notifySimple, notifyFloor, notifySales, freshSales, notifyWalletSales, notifyWalletMoves, recordInbox },
};
