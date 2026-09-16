'use strict';

// jv: "the bot /me portfolio and also traitview need to be aware in the
// connected holder section and wallet tab when a token moves in that
// wallet" -- real-time transfer detection for every linked wallet, not
// just marketplace sales (already covered separately in lib/poll.js).
// Uses Alchemy's Address Activity webhook (push-based -- Alchemy notifies
// us the instant a tracked address is involved in any transfer, rather
// than this bot polling on a timer and wasting calls on wallets with no
// activity at all).
//
// Needs three env vars, all from the Alchemy dashboard (see the setup
// walkthrough given separately, not just this comment):
//   ALCHEMY_AUTH_TOKEN         -- Notify API auth token (dashboard-level,
//                                 different from the regular ALCHEMY_API_KEY)
//   ALCHEMY_WEBHOOK_ID         -- the created webhook's ID (wh_...)
//   ALCHEMY_WEBHOOK_SIGNING_KEY -- per-webhook signing key, from that
//                                 webhook's own detail page

const fetch = require('node-fetch');
const crypto = require('crypto');

// Alchemy signs the raw request body with HMAC-SHA256, hex-encoded, in the
// X-Alchemy-Signature header -- no "sha256=" prefix, no timestamp, just the
// hex digest. Must be computed over the exact raw bytes received (api.js's
// express.json() verify callback captures req.rawBody for this reason) --
// a re-serialized JSON body will not match.
function verifyAlchemySignature(rawBody, signature, signingKey){
  if(!signature || !signingKey || !rawBody) return false;
  try{
    const digest = crypto.createHmac('sha256', signingKey).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature);
    const digestBuf = Buffer.from(digest);
    if(sigBuf.length !== digestBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, digestBuf);
  }catch(_){ return false; }
}

// Idempotent per Alchemy's own docs -- safe to call repeatedly with the
// same address. Called whenever a wallet gets linked/unlinked
// (lib/linked-wallets.js) so the webhook's tracked-address list always
// matches linked_wallets, without anyone needing to remember to update it
// by hand in the dashboard.
async function updateWebhookAddresses(addressesToAdd = [], addressesToRemove = []){
  const authToken = process.env.ALCHEMY_AUTH_TOKEN;
  const webhookId = process.env.ALCHEMY_WEBHOOK_ID;
  if(!authToken || !webhookId){
    console.warn('[AlchemyWebhook] ALCHEMY_AUTH_TOKEN or ALCHEMY_WEBHOOK_ID not configured -- skipping address list update');
    return { ok: false, error: 'not_configured' };
  }
  if(!addressesToAdd.length && !addressesToRemove.length) return { ok: true };
  try{
    const r = await fetch('https://dashboard.alchemy.com/api/update-webhook-addresses', {
      method: 'PATCH',
      headers: { 'X-Alchemy-Token': authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhook_id: webhookId,
        addresses_to_add: addressesToAdd.map(a => a.toLowerCase()),
        addresses_to_remove: addressesToRemove.map(a => a.toLowerCase()),
      }),
    });
    const text = await r.text();
    if(!r.ok){
      console.error('[AlchemyWebhook] update-webhook-addresses failed:', r.status, text.slice(0, 300));
      return { ok: false, error: `HTTP ${r.status}` };
    }
    return { ok: true };
  }catch(e){
    console.error('[AlchemyWebhook] update-webhook-addresses error:', e.message);
    return { ok: false, error: e.message };
  }
}

// Processes one ADDRESS_ACTIVITY webhook payload (already signature-
// verified by the caller). For each activity entry that's an NFT transfer
// (erc721/erc1155 -- plain ETH/ERC20 value transfers are ignored, this
// bot only cares about NFT movement) involving a tracked collection:
//   - marks the sending wallet's held row disposed (if it was tracked)
//   - inserts a new held row for the receiving wallet (if it's tracked)
//   - triggers an immediate, debounced role re-sync for either side that's
//     a verified Discord user (reuses the same _syncTraitRolesFn/debounce
//     path lib/poll.js already wires up for marketplace sales)
async function processAddressActivityEvent(payload, { pgPool, client, syncTraitRolesFn, shouldSyncRolesNow }){
  const activity = payload?.event?.activity || [];
  if(!activity.length) return;

  // Contract -> slug lookup, one query for every distinct contract in this
  // batch rather than one query per activity entry.
  const contracts = [...new Set(activity.map(a => (a.rawContract?.address || a.contractAddress || '').toLowerCase()).filter(Boolean))];
  if(!contracts.length) return;
  const slugMap = {};
  try{
    const res = await pgPool.query(`SELECT slug, contract FROM collections WHERE LOWER(contract) = ANY($1::text[])`, [contracts]);
    for(const row of res.rows) slugMap[row.contract.toLowerCase()] = row.slug;
  }catch(e){
    console.warn('[AlchemyWebhook] collection lookup failed:', e.message);
    return;
  }

  for(const act of activity){
    try{
      const contract = (act.rawContract?.address || act.contractAddress || '').toLowerCase();
      const slug = slugMap[contract];
      if(!slug) continue; // not a tracked collection

      // NFT transfers carry erc721TokenId (single) or erc1155Metadata
      // (array, possibly multiple token IDs in one transfer).
      const tokenIds = [];
      if(act.erc721TokenId) tokenIds.push(parseInt(act.erc721TokenId, 16) || parseInt(act.erc721TokenId, 10));
      if(Array.isArray(act.erc1155Metadata)){
        for(const m of act.erc1155Metadata){
          const tid = parseInt(m.tokenId, 16) || parseInt(m.tokenId, 10);
          if(tid) tokenIds.push(tid);
        }
      }
      if(!tokenIds.length) continue; // plain ETH/ERC20 transfer, not an NFT -- irrelevant here

      const from = (act.fromAddress || '').toLowerCase();
      const to = (act.toAddress || '').toLowerCase();
      const isMint = from === '0x0000000000000000000000000000000000000000';

      for(const tokenId of tokenIds){
        if(!isMint){
          await pgPool.query(
            `UPDATE wallet_token_intervals SET disposed_at=NOW()
             WHERE wallet_address=$1 AND token_id=$2 AND collection_slug=$3 AND disposed_at IS NULL`,
            [from, tokenId, slug]
          ).catch(e => console.warn('[AlchemyWebhook] dispose update failed:', e.message));
        }
        if(to){
          // acquired_at/cost_eth are approximate here (NOW() / 0) -- this
          // webhook only tells us a transfer happened, not what it sold
          // for. The sales poller (lib/poll.js) is the real source of
          // truth for cost basis on an actual marketplace sale; this
          // path exists specifically for transfers that never go through
          // sales polling at all (gifts, wallet-to-wallet moves).
          await pgPool.query(
            `INSERT INTO wallet_token_intervals (wallet_address, token_id, acquired_at, disposed_at, cost_eth, collection_slug)
             VALUES ($1,$2,NOW(),NULL,0,$3)`,
            [to, tokenId, slug]
          ).catch(e => console.warn('[AlchemyWebhook] acquire insert failed:', e.message));
        }
      }

      // Immediate role re-sync for either side, if they're a verified
      // Discord user in any guild -- same debounced path as marketplace
      // sales (lib/poll.js), so this can't spam-trigger either.
      if(syncTraitRolesFn && shouldSyncRolesNow){
        const involved = [from, to].filter(Boolean);
        const affected = await pgPool.query(
          `SELECT discord_id, guild_id, array_agg(wallet) AS wallets
           FROM linked_wallets WHERE verified=true AND wallet = ANY($1::text[])
           GROUP BY discord_id, guild_id`,
          [involved]
        ).catch(() => ({ rows: [] }));
        for(const row of affected.rows){
          if(!shouldSyncRolesNow(row.discord_id, row.guild_id)) continue;
          const guildObj = client?.guilds?.cache?.get(row.guild_id);
          if(!guildObj) continue;
          syncTraitRolesFn(guildObj, row.discord_id, row.wallets).catch(e =>
            console.warn('[AlchemyWebhook] role re-sync failed for', row.discord_id, ':', e.message)
          );
        }
      }
    }catch(e){
      console.warn('[AlchemyWebhook] Failed processing one activity entry:', e.message);
      // Continue with the rest of the batch -- one malformed entry
      // shouldn't drop every other transfer in the same webhook payload.
    }
  }
}

module.exports = { verifyAlchemySignature, updateWebhookAddresses, processAddressActivityEvent };
