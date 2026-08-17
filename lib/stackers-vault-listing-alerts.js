'use strict';

// ── Stackers new-listing vault-value alerts ───────────────────────────────────
// Fires when a genuinely NEW listing appears for a Stacker that has real,
// unclaimed vault value. Piggybacks on the existing, already-fast
// listings-sync pipeline (pollListings, called right after it detects new
// listings) rather than the slower periodic vault-listings-cache job —
// the whole point is catching this before it's gone, in a market that's
// already been observed trading dozens of different tokens within hours.
//
// Delivery: to whichever channel a guild already uses for sales alerts
// (same reasoning as the fusion alerts — no separate channel-picker
// needed), for any guild with this specifically enabled; and to any
// Discord user who's opted into DMs for it, independent of any server.

const { EmbedBuilder } = require('discord.js');
const { getStackerInfo, STACKERS_SLUG, NFT_ADDRESS } = require('./stackers');
const { dbLoad, dbSave, getAllConfigs } = require('./db');

let _client = null;
function setClient(client){ _client = client; }

async function resolveDiscordChannel(channelId){
  if(!channelId || !_client) return null;
  return _client.channels.cache.get(channelId) || await _client.channels.fetch(channelId).catch(()=>null);
}

// Finds every guild that has vault-listing alerts specifically enabled for
// Stackers (as primary or an extra collection), and the channel to post
// to — same channel already configured for sales alerts, same pattern as
// getFusionAlertChannels in the fusion poller, extended to also check the
// vaultListingAlert toggle rather than just "is this collection Stackers."
function getVaultAlertChannels(){
  const targets = [];
  for(const [guildId, cfg] of getAllConfigs()){
    const primarySlug = cfg.collectionSlug || cfg.slug;
    const isStackersHere = primarySlug === STACKERS_SLUG || (Array.isArray(cfg.collections) && cfg.collections.some(c => c.slug === STACKERS_SLUG));
    if(!isStackersHere) continue;

    // Dedicated vault-alert channel takes priority if set; falls back to
    // whichever channel this guild already uses for Stackers sales
    // alerts, matching the "defaults to Sales Channel if not set"
    // behavior described directly in /config (same pattern as fusion
    // alerts' channel resolution).
    if(cfg.vaultAlertChannel){
      targets.push({ guildId, channelId: cfg.vaultAlertChannel });
      continue;
    }
    if(primarySlug === STACKERS_SLUG && cfg.channelId){
      targets.push({ guildId, channelId: cfg.channelId });
    }
    if(Array.isArray(cfg.collections)){
      for(const col of cfg.collections){
        if(col.slug === STACKERS_SLUG && col.salesChannel){
          targets.push({ guildId, channelId: col.salesChannel });
        }
      }
    }
  }
  return targets;
}

// Per-user DM opt-in — a simple persisted object, same pattern as the
// existing user_alerts key. Kept deliberately separate from the existing
// general-purpose "my alert" system (which is scoped to one collection at
// a time per user) rather than shoehorned into it, since this is a
// distinct, narrower thing.
async function getVaultDmOptIns(){
  return await dbLoad('stackers_vault_dm_optins') || {};
}
async function setVaultDmOptIn(discordId, enabled){
  const optIns = await getVaultDmOptIns();
  if(enabled) optIns[discordId] = true;
  else delete optIns[discordId];
  await dbSave('stackers_vault_dm_optins', optIns);
  return optIns;
}

async function buildVaultListingAlertEmbed(tokenId, priceEth, balances){
  const vaultText = balances.map(b => `${parseFloat(b.amountFormatted).toFixed(4)} ${b.symbol}`).join(', ');
  return new EmbedBuilder()
    .setTitle('🏦 New Listing with Unclaimed Vault Value')
    .setColor(0xF97316)
    .setDescription(`**Stacker #${tokenId}** just listed for Ξ${priceEth}`)
    .addFields({ name: 'Vault', value: vaultText || 'empty', inline: false })
    .setURL(`https://opensea.io/assets/robinhood/${NFT_ADDRESS}/${tokenId}`)
    .setTimestamp();
}

// Called right after pollListings detects genuinely new Stackers listings.
// Checks each for real vault value live (not from the periodic cache,
// which would be too slow for this specific purpose); if found, delivers
// to every enabled channel and every opted-in DM user. Deliberately never
// throws — errors here must not affect the normal listing-posting flow
// this piggybacks on, since that flow serves every other collection too.
async function checkNewListingsForVaultValue(newListingTokenIds, priceByTokenId){
  for(const tokenId of newListingTokenIds){
    try{
      const info = await getStackerInfo(tokenId);
      if(!info.balances.length) continue; // empty vault, nothing to alert about

      const priceEth = priceByTokenId.get(tokenId);
      const priceStr = priceEth != null ? (priceEth >= 1 ? priceEth.toFixed(3) : priceEth.toFixed(4)) : '?';
      const embed = await buildVaultListingAlertEmbed(tokenId, priceStr, info.balances);

      const channels = getVaultAlertChannels();
      for(const { channelId } of channels){
        const channel = await resolveDiscordChannel(channelId);
        if(channel){
          await channel.send({ embeds: [embed] }).catch(e =>
            console.warn(`[StackersVaultAlerts] Failed to post to channel ${channelId}:`, e.message)
          );
        }
      }

      if(_client){
        const optIns = await getVaultDmOptIns();
        for(const discordId of Object.keys(optIns)){
          const user = await _client.users.fetch(discordId).catch(() => null);
          if(user){
            await user.send({ embeds: [embed] }).catch(e =>
              console.warn(`[StackersVaultAlerts] Failed to DM ${discordId}:`, e.message)
            );
          }
        }
      }
    }catch(e){
      console.warn(`[StackersVaultAlerts] Failed to check/alert token ${tokenId}:`, e.message);
    }
  }
}

module.exports = {
  setClient,
  checkNewListingsForVaultValue,
  getVaultAlertChannels,
  getVaultDmOptIns,
  setVaultDmOptIn,
};
