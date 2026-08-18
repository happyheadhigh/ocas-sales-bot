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

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { dbLoad, dbSave, getAllConfigs, pgPool } = require('./db');
const { getProvider, getContracts, NFT_ADDRESS, STACKERS_SLUG, formatStackersFields } = require('./stackers');
const { cacheStackerImage } = require('./stackers-image-cache');
const { refreshVaultBalance } = require('./stackers-status-poller');

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
    const isStackersHere = primarySlug === STACKERS_SLUG || (Array.isArray(cfg.collections) && cfg.collections.some(c => c.slug === STACKERS_SLUG));
    if(!isStackersHere) continue;

    // Dedicated fusion channel takes priority if set; falls back to
    // whichever channel this guild already uses for Stackers sales
    // alerts, matching the "defaults to Sales Channel if not set"
    // behavior described directly in /config.
    if(cfg.fusionChannel){
      targets.push({ guildId, channelId: cfg.fusionChannel });
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

async function buildFusionEmbed(survivorId, absorbedId){
  const embed = new EmbedBuilder()
    .setTitle('🔥 Stacker Fusion')
    .setColor(0xF97316)
    .setDescription(`**Stacker #${absorbedId}** was absorbed into **Stacker #${survivorId}**`)
    .setURL(`https://opensea.io/assets/robinhood/${NFT_ADDRESS}/${survivorId}`)
    .setTimestamp();

  // Rarity — confirmed accurate, static art data (verified directly
  // against Stackers' own official fusion announcement for this exact
  // token before adding). Piece count and STACK cost are both facts
  // guaranteed by this function's own signature and Stackers' documented
  // cost table respectively, not dependent on any synced data at all.
  const rarityRes = await pgPool.query(
    `SELECT trait_value FROM token_traits WHERE collection_slug = $1 AND token_id = $2 AND trait_name = 'Rarity'`,
    [STACKERS_SLUG, survivorId]
  ).catch(() => ({ rows: [] }));
  const rarity = rarityRes.rows[0]?.trait_value || null;

  const fusionFacts = [`**Pieces:** 2`, `**Burned Here:** 50,000 $STACK`];
  if(rarity) fusionFacts.push(`**Rarity:** ${rarity}`);
  embed.addFields({ name: '🔥 This Fusion', value: fusionFacts.join('\n'), inline: false });

  // Shows the survivor's post-fusion state — its new combined tier and
  // updated vault balance, reusing the same formatter used everywhere else
  // rather than duplicating this logic here.
  const stackersFields = await formatStackersFields(survivorId).catch(() => []);
  if(stackersFields.length) embed.addFields(...stackersFields);

  // Attaches the survivor's actual image — this embed never called
  // .setImage() at all before now, missing since this was first built.
  // Falls back to no image (rather than failing the whole alert) if the
  // fetch fails for any reason; the fusion still gets reported either way.
  const files = [];
  try{
    const fresh = await cacheStackerImage(pgPool, survivorId);
    const ext = fresh.isSvg ? 'svg' : 'png';
    const filename = `stacker-${survivorId}.${ext}`;
    const buffer = fresh.isSvg ? Buffer.from(fresh.data, 'utf8') : fresh.data;
    files.push(new AttachmentBuilder(buffer, { name: filename }));
    embed.setImage(`attachment://${filename}`);
  }catch(e){
    console.warn(`[StackersFusion] Failed to attach image for survivor #${survivorId}:`, e.message);
  }

  return { embed, files };
}

// Handles one fusion event — the actual work (image cache refresh, vault-
// listing refresh, alert posting), extracted so both the polling loop
// below and the live WebSocket listener can share identical logic rather
// than duplicating it.
async function handleFusionEvent(survivorId, absorbedId, blockNumber){
  survivorId = survivorId.toString();
  absorbedId = absorbedId.toString();
  console.log(`[StackersFusion] Merged: #${absorbedId} -> #${survivorId}${blockNumber ? ` (block ${blockNumber})` : ''}`);

  // Fusion can also add vault value to the survivor (the absorbed
  // token's vault merges in, confirmed via the engine's own Absorbed
  // event) — refreshes the live-tracked balance regardless of whether
  // the survivor happens to be currently listed, since this now feeds
  // both /stackerstats' total and /stackers listings.
  refreshVaultBalance(pgPool, survivorId).catch(e =>
    console.warn(`[StackersFusion] Failed to refresh vault balance for survivor #${survivorId}:`, e.message)
  );

  // buildFusionEmbed handles refreshing the survivor's cached image itself
  // now (force-refresh, properly awaited — fusion can change a token's
  // art, so this needs to guarantee freshness rather than risk a stale
  // pre-fusion image, the way a separate fire-and-forget call here could).
  const result = await buildFusionEmbed(survivorId, absorbedId).catch(e => {
    console.warn('[StackersFusion] Failed to build embed:', e.message);
    return null;
  });
  if(!result) return;
  const { embed, files } = result;

  const targets = getFusionAlertChannels();
  for(const { channelId } of targets){
    const channel = await resolveDiscordChannel(channelId);
    if(channel){
      await channel.send({ embeds: [embed], files }).catch(e =>
        console.warn(`[StackersFusion] Failed to post to channel ${channelId}:`, e.message)
      );
    }
  }
}

async function pollFusionEvents(maxChunksOverride){
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

    // Loops through multiple chunks per invocation rather than just one —
    // this chain produces blocks fast enough (confirmed ~598/minute) that
    // processing only one 10-block chunk per 60-second cycle meant falling
    // permanently behind, never catching up. Higher cap than the status
    // poller (60 vs 30) since this only makes one query per chunk instead
    // of four — same total RPC cost for double the block coverage, close
    // to true real-time parity (~60 chunks/minute) given fusion is worth
    // catching promptly.
    const MAX_CHUNKS_PER_CYCLE = maxChunksOverride || 60;
    let cursor = fromBlock;
    let chunksProcessed = 0;
    let totalFusions = 0;

    while(cursor <= safeLatest && chunksProcessed < MAX_CHUNKS_PER_CYCLE){
      const chunkTo = Math.min(safeLatest, cursor + CHUNK_BLOCKS - 1);

      const filter = vault.filters.Merged();
      const events = await vault.queryFilter(filter, cursor, chunkTo);

      if(events.length){
        console.log(`[StackersFusion] ${events.length} fusion(s) in blocks ${cursor}-${chunkTo}`);
      }
      totalFusions += events.length;

      for(const event of events){
        await handleFusionEvent(event.args.survivorId, event.args.absorbedId, event.blockNumber);
      }

      dbSave(FUSION_CURSOR_KEY, String(chunkTo)).catch(e =>
        console.warn('[StackersFusion] Failed to save cursor:', e.message)
      );

      cursor = chunkTo + 1;
      chunksProcessed++;
    }

    const blocksBehind = safeLatest - (cursor - 1);
    if(blocksBehind > MAX_CHUNKS_PER_CYCLE * CHUNK_BLOCKS){
      console.log(`[StackersFusion] Still catching up — ~${blocksBehind} blocks behind, will continue next cycle`);
    }
  }catch(e){
    console.error('[StackersFusion] Poll error:', e.message);
  }
}

module.exports = { setClient, pollFusionEvents, getFusionAlertChannels, handleFusionEvent };
