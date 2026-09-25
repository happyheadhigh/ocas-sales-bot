'use strict';

// ── Stackers listed-with-unclaimed-vault-value ────────────────────────────────
// Finds currently listed Stackers that have real, unclaimed value sitting in
// their vault — value a buyer gets on top of the token itself, since vault
// balance travels with the NFT on sale.
//
// getVaultListings() reads live: joins stackers_token_status.vault_balances
// (kept genuinely current via the Credited/Claimed event listeners in
// lib/stackers-live-events.js) directly against the listings table (already
// kept fresh by the existing, fast listings-sync pipeline) — rather than a
// separate table only refreshed every 6 hours. This used to be the design
// here (a periodic full sweep of every listed token, since vault balance had
// no live event mapping yet); now that Credited/Claimed are confirmed real
// and wired into the live listener, that sweep is redundant for this
// specific purpose and has been removed.

const { STACKERS_SLUG } = require('./stackers');

// Reads live: stackers_token_status.vault_balances (kept current via the
// Credited/Claimed live listeners) joined against listings (already fresh).
// Both sides of this join are already live, independently of each other —
// no separate refresh job needed for this specific view.
async function getVaultListings(pgPool, limit = 15){
  const res = await pgPool.query(
    `SELECT s.token_id, s.vault_balances, s.updated_at, l.price_eth, l.url
     FROM stackers_token_status s
     JOIN listings l ON l.token_id = s.token_id AND l.collection_slug = $1
     WHERE s.vault_balances IS NOT NULL AND jsonb_array_length(s.vault_balances) > 0
     ORDER BY l.price_eth ASC
     LIMIT $2`,
    [STACKERS_SLUG, limit]
  );
  return res.rows;
}

module.exports = { getVaultListings };
