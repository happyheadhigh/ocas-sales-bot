'use strict';

// ── Stackers fusion poller ────────────────────────────────────────────────────
// Watches the vault contract's Merged(survivorId, absorbedId) event on
// Robinhood Chain and posts an alert whenever a fusion actually happens —
// the real parallel to OCAS's burn tracking, just triggered by a different
// mechanism (fusion merges two Stackers into one; OCAS burns destroy
// outright). Structurally mirrors lib/burn-poller.js (cursor-based block
// range polling, persisted so a restart doesn't lose progress) but reuses
// the two hard-won fixes from that file rather than risking reintroducing
// the same bugs: a safety margin below the reported chain head (Alchemy is
// load-balanced across multiple nodes — two sequential calls aren't
// guaranteed to land on the same one, see the burn-poller.js fix from
// earlier tonight for the full explanation), and a guard against the edge
// case that margin can create if the cursor is already very close to the
// true head.

const { EmbedBuilder } = require('discord.js');
const { dbLoad, dbSave, getAllConfigs, pgPool } = require('./db');
const { getProvider, getContracts, NFT_ADDRESS, STACKERS_SLUG, formatStackersFields } = require('./stackers');
const { cacheStackerImage } = require('./stackers-image-cache');
const { refreshOneVaultListing } = require('./stackers-vault-listings');

const FUSION_CURSOR_KEY      = 'stackers_fusion_last_block';
const SAFETY_MARGIN_BLOCKS   = 2;   // same race-condition fix as burn-poller.js
const CHUNK_BLOCKS           = 10;   // this Alchemy account caps eth_getLogs at a 10-block range — confirmed via a live error, matches what burn-poller.js already uses for the same account-level constraint
const FIRST_RUN_LOOKBACK     = 500;  // smaller than before — at a 10-block chunk size, catching up from a large lookback takes real time (500/10 = 50 cycles), and fusion events are rare enough that missing a bit of older history on first run isn't critical

let _client = null;
function setClient(client){ _client = client; }

async function resolveDiscordChannel(channelId){
  if(!channelId || !_client) return null;
  return _client.channels.cache.get(channelId) || await _client.channels.fetch(channelId).catch(()=>null);
}

// Finds every guild currently tracking Stackers (as its primary collection
// or as one of its extra collections) and the channel to post fusion alerts
// to. Deliberately reuses whichever channel that guild already has
// configured for sales alerts, rather than introducing a whole new
// per-guild-configurable channel type for this one event — a dedicated
// fusion-channel picker in /config is a reasonable future addition if this
// ever needs to be more granular than "same channel as sales."
function getFusionAlertChannels(){
  const targets = [];
  for(const [guildId, cfg] of getAllConfigs()){
    const primarySlug = cfg.collectionSlug || cfg.slug;
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

async function buildFusionEmbed(survivorId, absorbedId){
  const embed = new EmbedBuilder()
    .setTitle('🔥 Stacker Fusion')
    .setColor(0xF97316)
    .setDescription(`**Stacker #${absorbedId}** was absorbed into **Stacker #${survivorId}**`)
    .setURL(`https://opensea.io/assets/robinhood/${NFT_ADDRESS}/${survivorId}`)
    .setTimestamp();

  // Shows the survivor's post-fusion state — its new combined tier and
  // updated vault balance, reusing the same formatter used everywhere else
  // rather than duplicating this logic here.
  const stackersFields = await formatStackersFields(survivorId).catch(() => []);
  if(stackersFields.length) embed.addFields(...stackersFields);

  return embed;
}

async function pollFusionEvents(){
  try{
    const provider = getProvider();
    const { vault } = getContracts();

    const lastBlockRaw = await dbLoad(FUSION_CURSOR_KEY).catch(() => null);
    let fromBlock = lastBlockRaw ? parseInt(lastBlockRaw, 10) + 1 : null;

    const latest = await provider.getBlockNumber();

    if(!fromBlock || !Number.isFinite(fromBlock)){
      fromBlock = Math.max(0, latest - FIRST_RUN_LOOKBACK);
      console.log(`[StackersFusion] No cursor found; starting from latest-${FIRST_RUN_LOOKBACK} (${fromBlock})`);
    }

    // Safety margin below the reported head — same fix as burn-poller.js,
    // same reasoning: two sequential calls (getBlockNumber, then the query
    // below) aren't guaranteed to land on the same load-balanced node.
    const safeLatest = Math.max(0, latest - SAFETY_MARGIN_BLOCKS);
    if(fromBlock > safeLatest) return; // nothing safely queryable yet this cycle

    const chunkTo = Math.min(safeLatest, fromBlock + CHUNK_BLOCKS - 1);

    const filter = vault.filters.Merged();
    const events = await vault.queryFilter(filter, fromBlock, chunkTo);

    if(events.length){
      console.log(`[StackersFusion] ${events.length} fusion(s) in blocks ${fromBlock}-${chunkTo}`);
    }

    for(const event of events){
      const survivorId = event.args.survivorId.toString();
      const absorbedId = event.args.absorbedId.toString();
      console.log(`[StackersFusion] Merged: #${absorbedId} -> #${survivorId} (block ${event.blockNumber})`);

      // Fusion can change a token's art — refresh its cached image now
      // rather than let it go stale until someone happens to request it.
      // Fire-and-forget: this shouldn't block or slow down alert posting
      // below, and a few seconds' delay before the cache catches up is
      // fine given the whole point is staying reasonably fresh, not instant.
      cacheStackerImage(pgPool, survivorId).catch(e =>
        console.warn(`[StackersFusion] Failed to refresh cached image for survivor #${survivorId}:`, e.message)
      );

      // Fusion can also add vault value to the survivor (the absorbed
      // token's vault merges in) — relevant if the survivor happens to be
      // listed. No-op internally if it isn't currently listed at all.
      refreshOneVaultListing(pgPool, survivorId).catch(e =>
        console.warn(`[StackersFusion] Failed to refresh vault-listing cache for survivor #${survivorId}:`, e.message)
      );

      const embed = await buildFusionEmbed(survivorId, absorbedId).catch(e => {
        console.warn('[StackersFusion] Failed to build embed:', e.message);
        return null;
      });
      if(!embed) continue;

      const targets = getFusionAlertChannels();
      for(const { channelId } of targets){
        const channel = await resolveDiscordChannel(channelId);
        if(channel){
          await channel.send({ embeds: [embed] }).catch(e =>
            console.warn(`[StackersFusion] Failed to post to channel ${channelId}:`, e.message)
          );
        }
      }
    }

    dbSave(FUSION_CURSOR_KEY, String(chunkTo)).catch(e =>
      console.warn('[StackersFusion] Failed to save cursor:', e.message)
    );
  }catch(e){
    console.error('[StackersFusion] Poll error:', e.message);
  }
}

module.exports = { setClient, pollFusionEvents, getFusionAlertChannels };
