'use strict';

const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { STACKERS_SLUG, formatStackersFields } = require('../lib/stackers');
const fetch = require('node-fetch');

async function handleTokenCommand(commandName, ctx){
  const {
    interaction, guildId, config,
    osHeaders, getRailwayApiUrl,
    buildSaleEmbed, buildListingEmbed, sendEmbed, postEmbeds,
    checkCommandCooldown, pgPool, fetchBotApiJson, resolveImage,
    slideshowSessions, ocasTraitsCache, getCachedTraits, setCachedTraits,
    getCachedImage, setCachedImage,
    COLORS, OCAS_CONTRACT, sweepSessions, API_SECRET,
    getTraitIndex, chooseTraitGroupsFromQuery, getRankTierColor, traitGroupsLabel,
    fetchTokenMetaFromDb, buildEmbedPayload, traitObjectToArray,
    timeSince, shortAddr, formatEth, isDiscordOk, verifyImageIsRaster, extractPngFromSvg,
  } = ctx;

  if(commandName==='token'){
    // Resolve collection from server_configs
    const { resolveCollectionFromServerCfg, isPaidFeature } = require('./market');
    const colInput = interaction.options.getString('collection') || null;
    const resolved = resolveCollectionFromServerCfg(config, colInput);
    const activeCol = resolved ? {...config, ...resolved} : config;
    // Generic label for the actually-resolved collection — this used to be a
    // hardcoded "OCAS" throughout this command's user-facing text (title,
    // error messages), so explicitly selecting a different collection (e.g.
    // robinhood-chimps) still showed "OCAS #5000" in the embed even when the
    // underlying data (image, traits, contract) was already correctly
    // resolved to the right collection the whole time — the label was just
    // lying about it.
    const colLabel = activeCol.name || activeCol.contractName || activeCol.slug || activeCol.collectionSlug || 'Token';
    const tokenInput = interaction.options.getInteger('token');
    const rawSearch  = (interaction.options.getString('search') || '').trim();
    const contract   = activeCol.contract || config.contract || '';
    const isPaid = !isPaidFeature(activeCol, 'token');
    const RAILWAY_URL = getRailwayApiUrl();
    const API_SECRET  = process.env.API_SECRET;

    await interaction.deferReply();
    try{
      // normalizePhrase / getTraitIndex / chooseTraitGroupsFromQuery
      // are hoisted to module scope — shared with /sweep.
      let tokenId    = tokenInput || null;
      let traitCount = null;
      let rankMin    = null, rankMax = null;
      let floorPrice  = null;
      let matchedGroups = [];
      let searchForTraits = '';

      // Detect floor anywhere: "zombie floor", "floor zombie", "gold chain floor"
      const wantFloor = /(?:^|\s)floor(?:\s|$)/i.test(rawSearch);
      let workingSearch = rawSearch.replace(/(?:^|\s)floor(?:\s|$)/gi, ' ').trim();

      // Extract trait count but keep any remaining trait words, e.g. "zombie 15 traits".
      const countMatch = workingSearch.match(/(?:trait\s*count\s*:?\s*(\d+)|(\d+)\s*traits?)/i);
      if(countMatch){
        traitCount = parseInt(countMatch[1] || countMatch[2]);
        workingSearch = workingSearch.replace(countMatch[0], ' ').trim();
      }

      // Extract rank range but keep any remaining trait words, e.g. "zombie hoodie rank 1-500".
      const lowerWorking = workingSearch.toLowerCase();
      const rangeMatch = lowerWorking.match(/rank\s*(\d+)\s*(?:-|–|to)\s*(\d+)/i) || lowerWorking.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s*rank/i);
      const topMatch = lowerWorking.match(/top\s*(\d+)/i);
      const singleRankMatch = lowerWorking.match(/rank\s*(\d+)/i);
      if(rangeMatch){
        rankMin = parseInt(rangeMatch[1]); rankMax = parseInt(rangeMatch[2]);
        workingSearch = workingSearch.replace(new RegExp(rangeMatch[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i'), ' ').trim();
      } else if(topMatch){
        rankMin = 1; rankMax = parseInt(topMatch[1]);
        workingSearch = workingSearch.replace(new RegExp(topMatch[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i'), ' ').trim();
      } else if(singleRankMatch){
        rankMin = 1; rankMax = parseInt(singleRankMatch[1]);
        workingSearch = workingSearch.replace(new RegExp(singleRankMatch[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i'), ' ').trim();
      }

      // Pure token ID, but only when no other filters were supplied.
      if(!tokenId && /^\d+$/.test(workingSearch.trim()) && +workingSearch >= 1 && +workingSearch <= 10000 && traitCount === null && !rankMin){
        tokenId = +workingSearch.trim();
        workingSearch = '';
      }

      searchForTraits = workingSearch
        .replace(/[,+]/g, ' ')
        .replace(/\b(and|with|plus)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Resolve phrase-aware multi-trait search. Longest trait values win:
      // "gold chain diamond choker" → "Gold Chain" + "Diamond Choker".
      if(!tokenId && searchForTraits && RAILWAY_URL){
        const traitIndex = await getTraitIndex(RAILWAY_URL, API_SECRET, activeCol.slug || activeCol.collectionSlug);
        const resolved = chooseTraitGroupsFromQuery(searchForTraits, traitIndex);
        matchedGroups = resolved.groups;

        if(!matchedGroups.length){
          await interaction.editReply(`I couldn't match **"${searchForTraits}"** to any known ${colLabel} trait value. Try a more exact trait value like **Zombie**, **Gold Chain**, or **Diamond Choker**.`);
          return;
        }
        if(resolved.unmatched.length){
          await interaction.editReply(`I matched **${traitGroupsLabel(matchedGroups)}**, but couldn't understand: **${resolved.unmatched.join(' ')}**. Try the exact trait phrase, like **gold chain diamond choker**.`);
          return;
        }
      }

      // ── Combined trait/rank/trait-count search through Railway/Postgres ───
      if(!tokenId && RAILWAY_URL && (matchedGroups.length || traitCount !== null || (rankMin && rankMax))){
        const qs = new URLSearchParams({ key: API_SECRET || '', slug: activeCol.slug || activeCol.collectionSlug || '' });
        if(matchedGroups.length) qs.set('groups', JSON.stringify(matchedGroups));
        if(traitCount !== null) qs.set('trait_count', String(traitCount));
        if(rankMin && rankMax){ qs.set('rank_min', String(rankMin)); qs.set('rank_max', String(rankMax)); qs.set('rank_type', 'os'); }

        if(wantFloor){
          const r = await fetch(`${RAILWAY_URL}/db/multi-trait-floor?${qs}`);
          if(!r.ok) throw new Error(`multi-trait-floor API HTTP ${r.status}`);
          const j = await r.json();
          if(!j.ok) throw new Error(j.error || 'multi-trait-floor API error');
          if(!j.floor){
            const label = matchedGroups.length ? traitGroupsLabel(matchedGroups) : `${traitCount} traits`;
            await interaction.editReply(`No listed ${colLabel} found for **${label}**${traitCount !== null && matchedGroups.length ? ` + **${traitCount} traits**` : ''}${rankMin&&rankMax ? ` + **OS rank #${rankMin}–#${rankMax}**` : ''}.`);
            return;
          }
          tokenId = j.floor.token_id;
          floorPrice = j.floor.price_eth;
        } else {
          qs.set('limit', '10000');
          const r = await fetch(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`);
          if(!r.ok) throw new Error(`multi-trait-tokens API HTTP ${r.status}`);
          const j = await r.json();
          if(!j.ok) throw new Error(j.error || 'multi-trait-tokens API error');
          const tokens = j.tokens || [];
          if(!tokens.length){
            const label = matchedGroups.length ? traitGroupsLabel(matchedGroups) : `${traitCount} traits`;
            await interaction.editReply(`No ${colLabel} tokens found for **${label}**${traitCount !== null && matchedGroups.length ? ` + **${traitCount} traits**` : ''}${rankMin&&rankMax ? ` + **OS rank #${rankMin}–#${rankMax}**` : ''}.`);
            return;
          }
          const picked = tokens[Math.floor(Math.random() * tokens.length)];
          tokenId = picked.id;
        }
      }

      // ── Random fallback ───────────────────────────────────────────────────
      if(!tokenId) tokenId = Math.floor(Math.random()*10000)+1;

      // Fetch OS rank + chain for title badge, rank-tier sidebar color, and
      // correct-chain image/URL below — one fetch, used for both. Falls
      // back to activeCol.collectionSlug too, matching the same pattern
      // used for the Show Traits button's customId — activeCol.slug alone
      // was inconsistent with how other parts of this same command resolve
      // the collection, and fetchTokenMetaFromDb's own default param
      // (OCAS_SLUG) means an undefined slug here silently fetches OCAS's
      // data instead of failing loudly.
      const resolvedSlugForMeta = activeCol.slug || activeCol.collectionSlug;
      const dbMeta  = await fetchTokenMetaFromDb(tokenId, resolvedSlugForMeta).catch(()=>null);
      console.log(`[token] dbMeta fetch: slug="${resolvedSlugForMeta}" (activeCol.slug="${activeCol.slug}" activeCol.collectionSlug="${activeCol.collectionSlug}") -> image_url=${dbMeta?.image_url ? 'present' : 'null'} chain=${dbMeta?.chain}`);
      const tokenChain = dbMeta?.chain || 'ethereum';

      // ── Fetch + post image ────────────────────────────────────────────────
      let imgResult = getCachedImage(`${contract}:${tokenId}`);
      if(!imgResult && dbMeta?.image_url && isDiscordOk(dbMeta.image_url)){
        // Prefer whatever the backfill already fetched and stored in
        // tokens.image_url over a live OpenSea call — see the comment in
        // fetchTokenMetaFromDb for why this matters for non-Ethereum chains.
        // isDiscordOk alone isn't reliable, though — confirmed live that
        // Alchemy's own CDN can serve genuine SVG content through a URL
        // with zero textual indication of that (no .svg extension, no
        // "image/svg" substring). Verify the real content-type before
        // trusting the URL directly.
        const isRaster = await verifyImageIsRaster(dbMeta.image_url);
        if(isRaster){
          imgResult = { type:'url', url: dbMeta.image_url };
        } else {
          const buf = await extractPngFromSvg(dbMeta.image_url).catch(() => null);
          if(buf) imgResult = { type:'buffer', buffer: buf, filename: `token-${tokenId}.png` };
        }
      }
      if(!imgResult){
        imgResult = await resolveImage({identifier:String(tokenId)}, contract, tokenChain);
      }
      if(imgResult) setCachedImage(`${contract}:${tokenId}`, imgResult);
      const osUrl = `https://opensea.io/assets/${tokenChain}/${contract}/${tokenId}`;
      const tvUrl = `https://traitview.com/?token=${tokenId}`;

      // Description: trait values + count + rank only, no category labels
      const descParts = [];
      if(matchedGroups.length){
        const vals = matchedGroups.map(g => [...new Set(g.map(x => x.trait_value))][0]);
        descParts.push(vals.join(' · '));
      }
      if(traitCount !== null) descParts.push(`${traitCount} traits`);
      if(rankMin && rankMax) descParts.push(`rank #${rankMin}–#${rankMax}`);

      const priceLine   = (wantFloor && floorPrice != null) ? `**Floor:** Ξ ${floorPrice >= 1 ? floorPrice.toFixed(3) : floorPrice.toFixed(4)}\n` : '';
      const contextLine = descParts.length ? `${descParts.join(' · ')}\n` : '';

      const osRank  = dbMeta?.os_rank ? Number(dbMeta.os_rank) : null;
      const rankBadge = osRank ? ` ⬥${osRank.toLocaleString()}` : '';
      const ocasColor = getRankTierColor(osRank) ?? COLORS.OCAS_BG;

      const traitsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          // Collection slug appended as a 3rd segment — previously this was
          // just `ocas_traits:${tokenId}` (borrowed from the OCAS-only
          // command's own button), so the handler had no way to know which
          // collection a token belonged to and silently defaulted to OCAS
          // every time. Confirmed live: /token showing "Chimps #5000" with
          // the correct title still showed genuine OCAS traits (Type,
          // Clothes, Hat Hair...) when Show Traits was clicked.
          .setCustomId(`ocas_traits:${tokenId}:${encodeURIComponent(resolvedSlugForMeta || '')}`)
          .setLabel('Show Traits')
          .setStyle(ButtonStyle.Secondary)
      );
      console.log(`[token] Show Traits button built with slug="${resolvedSlugForMeta || ''}" -> customId="ocas_traits:${tokenId}:${encodeURIComponent(resolvedSlugForMeta || '')}"`);

      // Generic label for the actually-resolved collection — computed near
      // the top of this function, see there for why.
      const embed = new EmbedBuilder()
        .setTitle(`${colLabel} #${tokenId}${rankBadge}`)
        .setColor(ocasColor)
        .setDescription(`${priceLine}${contextLine}[OpenSea](${osUrl}) · [TraitView](${tvUrl})`);

      if((activeCol.slug || activeCol.collectionSlug) === STACKERS_SLUG){
        const stackersFields = await formatStackersFields(tokenId);
        if(stackersFields.length) embed.addFields(...stackersFields);
      }

      if(imgResult?.type==='buffer'){
        const att=new AttachmentBuilder(imgResult.buffer,{name:imgResult.filename});
        embed.setImage(`attachment://${imgResult.filename}`);
        await interaction.editReply({embeds:[embed],files:[att],components:[traitsRow]});
      } else if(imgResult?.type==='url'){
        embed.setImage(imgResult.url);
        await interaction.editReply({embeds:[embed],components:[traitsRow]});
      } else {
        embed.setDescription(`${priceLine}${contextLine}[OpenSea](${osUrl}) · [TraitView](${tvUrl})\n_Image unavailable_`);
        await interaction.editReply({embeds:[embed],components:[traitsRow]});
      }
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // ── /sweep ──────────────────────────────────────────────────────────────
}

const OCAS_COMMANDS = new Set(['ocas']);

module.exports = { handleTokenCommand, TOKEN_COMMANDS: new Set(['token']) };
