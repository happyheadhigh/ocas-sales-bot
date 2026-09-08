'use strict';

// ── WETH offer arbitrage detection ──────────────────────────────────────────
// Detects when a listing's price is below the best applicable OpenSea offer
// for that specific token (collection-wide, trait-specific, or item-specific
// — whichever is highest) — a real, well-known NFT strategy: buy the listing,
// then immediately accept the offer to capture the spread.
//
// Deliberately shows the RAW spread only (offer price minus listing price),
// not a net-profit-after-fees estimate. Explicitly requested this way: fees
// are no longer a fixed, predictable number (OpenSea's own marketplace fee
// has changed several times historically, and creator royalties became
// optional and per-collection in Aug 2023 rather than platform-enforced),
// and gas for the two required transactions isn't reliably estimable ahead
// of time either. Every alert/response this produces should make clear this
// is a GROSS spread, not a guaranteed take-home profit.
//
// Important, honest caveat about this whole feature: OpenSea's exact JSON
// response shape for the best-offer-by-NFT endpoint isn't confirmed against
// live data yet (their docs page is an interactive "Try It" widget, not
// static schema documentation) -- parsing below is deliberately defensive
// (tries several plausible field paths) and logs the raw response
// unconditionally so the actual shape can be verified against real data
// before this is trusted for anything beyond a first look.

const fetch = require('node-fetch');
const { EmbedBuilder } = require('discord.js');
const { osHeaders, COLORS } = require('./constants');
const { trimEth } = require('../utils/format');

// Tries several plausible paths for where the offer's price actually lives,
// since the exact schema isn't confirmed. Returns null if none match, rather
// than guessing wrong silently.
function extractOfferPriceEth(offer){
  if(!offer) return null;
  const candidates = [
    offer?.price?.value && offer?.price?.decimals != null
      ? Number(offer.price.value) / Math.pow(10, offer.price.decimals) : null,
    offer?.price?.current?.value && offer?.price?.current?.decimals != null
      ? Number(offer.price.current.value) / Math.pow(10, offer.price.current.decimals) : null,
    offer?.payment?.quantity && offer?.payment?.decimals != null
      ? Number(offer.payment.quantity) / Math.pow(10, offer.payment.decimals) : null,
    offer?.protocol_data?.parameters?.consideration?.[0]?.startAmount
      ? Number(offer.protocol_data.parameters.consideration[0].startAmount) / 1e18 : null,
  ].filter(v => v != null && isFinite(v) && v > 0);
  return candidates.length ? candidates[0] : null;
}

// Fetches the single best applicable offer for a specific token — OpenSea's
// own endpoint already combines collection-wide, trait-specific, and
// item-specific offers into one "best" value, so this doesn't need to
// separately fetch and compare all three categories itself.
async function fetchBestOfferForToken(slug, tokenId){
  try{
    const url = `https://api.opensea.io/api/v2/offers/collection/${slug}/nfts/${tokenId}/best`;
    const r = await fetch(url, { headers: osHeaders() });
    if(r.status === 404) return null; // no active offer for this token at all -- not an error
    if(!r.ok){
      console.warn(`[arbitrage] best-offer fetch HTTP ${r.status} for ${slug}#${tokenId}`);
      return null;
    }
    const j = await r.json();
    // Unconditional — the exact response shape isn't confirmed against live
    // data yet, so every call logs what OpenSea actually returned until
    // this has been checked against real, current offers.
    console.log(`[arbitrage] raw best-offer response for ${slug}#${tokenId}: ${JSON.stringify(j).slice(0, 500)}`);
    return j;
  }catch(e){
    console.warn(`[arbitrage] best-offer fetch failed for ${slug}#${tokenId}:`, e.message);
    return null;
  }
}

// Compares a listing's price against the token's best offer. Returns null if
// there's no arbitrage opportunity (no offer, or offer <= listing), or a
// result object describing the opportunity if there is one.
async function checkArbitrageOpportunity(slug, tokenId, listingPriceEth){
  if(!listingPriceEth || listingPriceEth <= 0) return null;
  const offerData = await fetchBestOfferForToken(slug, tokenId);
  if(!offerData) return null;

  const offerPriceEth = extractOfferPriceEth(offerData);
  if(offerPriceEth == null){
    console.warn(`[arbitrage] could not parse a price from best-offer response for ${slug}#${tokenId} -- see raw response logged above`);
    return null;
  }

  if(offerPriceEth <= listingPriceEth) return null; // no arbitrage -- offer doesn't beat the listing

  return {
    tokenId,
    slug,
    listingPriceEth,
    offerPriceEth,
    spreadEth: trimEth(offerPriceEth - listingPriceEth),
    offerData,
  };
}

module.exports = {
  fetchBestOfferForToken,
  checkArbitrageOpportunity,
  extractOfferPriceEth,
  buildArbitrageEmbed,
};

// Builds the alert embed. Deliberately labels the spread as GROSS (before
// fees/gas) rather than an estimated take-home profit -- see this file's
// top comment for why fee/gas math isn't included at all.
function buildArbitrageEmbed({ slug, tokenId, listingPriceEth, offerPriceEth, spreadEth, chain = 'ethereum', name }){
  const osUrl = `https://opensea.io/assets/${chain}/${slug}/${tokenId}`;
  return new EmbedBuilder()
    .setColor(COLORS.RANK_TOP_100)
    .setTitle(`🔀 Arbitrage: ${name || `#${tokenId}`}`)
    .setDescription(
      `**${slug}** · [View on OpenSea](${osUrl})\n\n` +
      `Listed at **Ξ ${trimEth(listingPriceEth)}**\n` +
      `Best offer: **Ξ ${trimEth(offerPriceEth)}**\n` +
      `**Gross spread: Ξ ${spreadEth}**\n\n` +
      `⚠️ Gross spread only — does not account for marketplace fees, creator royalties, or gas for the buy + accept-offer transactions. Verify actual numbers on OpenSea before acting.`
    );
}
