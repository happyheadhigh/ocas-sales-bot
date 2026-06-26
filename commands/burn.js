'use strict';

const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const fetch = require('node-fetch');

async function handleBurnCommand(commandName, ctx){
  const {
  interaction, guildId, config, isAdmin,
  osHeaders, getRailwayApiUrl, sendErrorWebhook,
    buildSaleEmbed, buildListingEmbed, sendEmbed, postEmbeds,
    checkCommandCooldown, pgPool, fetchBotApiJson, resolveImage,
    COLORS, OCAS_CONTRACT, BURN_CONTRACT, BURN_COLORS, DEFAULT_LOTTERY_TIMEZONE,
    slideshowSessions, burnRpc, burnRpcUrl,
    triggerOsMetadataRefresh, buildBurnEmbed, upsertTokenTraitRows,
    normalizeOcasType, E1_TYPE_NAMES,
    buildBurnLotteryEmbed, buildActiveBurnLotteryComponents,
    getBurnLotteryEntries, drawAndPostBurnLottery,
    processDueBurnLotteries, buildBurnLotteryComponents,
    formatBurnLotteryWindow, pendingDrawSeed, resolveLotteryWindow,
    waitForEthBlock, fetchEthBlockHashSeed,
    lotteryPick, randomLotterySeed,
    timeSince, shortAddr, formatEth, isDiscordOk, normAddr,
    fetchTokenMetaFromDb, buildEmbedPayload, traitDisplayLines,
    fetchBurnDisplayTraits, fetchSnapshotImageForToken, burnTypeBreakdown,
    fetchTokenUriFromContract, extractPngFromSvg, clearCachedImage,
    burnTypeLabel, burnTypeColor, burnTypeEmoji,
    traitObjectToArray, osRankBadge, titleTokenId, getRankTierColor,
  } = ctx;

  if(commandName==='burnlatest'){
    await interaction.deferReply();
    try{
      const count = Math.max(1, Math.min(interaction.options.getInteger('count') || 1, 10));
      const r = await pgPool.query(`
        SELECT be.id, be.tx_hash, be.block_number, be.burner_wallet, be.survivor_token_id,
               be.result_body_type, be.result_is_angel, be.points_used, be.burned_at, be.log_index,
               array_agg(bei.burned_token_id ORDER BY bei.burned_token_id) AS burned_ids,
               EXISTS (
                 SELECT 1 FROM burn_alert_posts bap
                 WHERE bap.tx_hash = be.tx_hash AND bap.log_index = be.log_index
               ) AS already_posted
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        GROUP BY be.id
        ORDER BY be.block_number DESC, be.log_index DESC
        LIMIT $1
      `, [count]);
      if(!r.rows.length){ await interaction.editReply('No burn events recorded yet.'); return; }
      const embeds = await Promise.all(r.rows.map(async row => {
        const finalEvent = { survivorTokenId: row.survivor_token_id, resultBodyType: row.result_body_type,
          resultIsAngel: row.result_is_angel, points: row.points_used, txHash: row.tx_hash,
          blockNumber: row.block_number, logIndex: row.log_index, burnEventId: row.id };
        const startEvent = { owner: row.burner_wallet, tokenIds: (row.burned_ids||[]).filter(Boolean) };
        // Burn commands should always prefer the contract tokenURI for survivor/created tokens.
        // DB is only a final fallback because it may contain pre-burn traits.
        const freshTraits = await fetchBurnDisplayTraits(row.survivor_token_id).catch(()=>null);
        return buildBurnEmbed(finalEvent, startEvent, freshTraits || undefined, true);
      }));

      if(count === 1){
        await interaction.editReply(buildEmbedPayload(embeds[0]));
      } else {
        await postEmbeds(interaction, embeds, `Showing latest ${embeds.length} OCAS burn${embeds.length===1?'':'s'}:`);
      }
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // /burnstats
  if(commandName==='burnstats'){
    await interaction.deferReply();
    try{
      const [statsRes, latestRes] = await Promise.all([
        pgPool.query(`
          SELECT
            (SELECT COUNT(*)::int FROM burn_events) AS total_burns,
            (
              SELECT COUNT(DISTINCT bei.burned_token_id)::int
              FROM burn_event_inputs bei
              JOIN burn_events be ON be.id = bei.burn_event_id
              WHERE bei.burned_token_id != be.survivor_token_id
            ) AS total_burned,
            (SELECT COUNT(*)::int FROM burn_events) AS total_created,
            (
              SELECT COUNT(*)::int
              FROM burn_events be
              WHERE NOT EXISTS (
                SELECT 1 FROM burn_event_inputs bei WHERE bei.burn_event_id = be.id
              )
            ) AS missing_input_burns
        `),
        pgPool.query(`
          SELECT be.survivor_token_id, be.result_body_type, be.result_is_angel,
                 be.points_used, be.burned_at, be.burner_wallet,
                 COUNT(bei.id)::int AS burned_count
          FROM burn_events be
          LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
          GROUP BY be.id ORDER BY be.burned_at DESC LIMIT 1
        `),
      ]);
      const stats   = statsRes.rows[0];
      const latest  = latestRes.rows[0];
      const burned  = stats.total_burned || 0;
      const created = stats.total_created || 0;
      const estimatedSupply = 10000 - burned;

      const tokensUsed = burned + created;
      const embed = new EmbedBuilder()
        .setTitle('OCAS Burn Machine Stats')
        .setColor(BURN_COLORS.FIRE)
        .addFields(
          { name:'OCAS Burned',  value:String(burned),               inline:true },
          { name:'Total Burns',  value:String(stats.total_burns||0), inline:true },
          { name:'Tokens Used',  value:String(tokensUsed),           inline:true },
          { name:'Est. Supply',  value:String(estimatedSupply),      inline:false },
          { name:'Links',        value:`[Burn Machine](https://www.onchainallstars.xyz/burn-machine) | [TraitView](https://traitview.com/) | [Etherscan](https://etherscan.io/address/${BURN_CONTRACT})`, inline:false },
        );
      if(latest){
        const ago       = latest.burned_at ? timeSince(Math.floor(new Date(latest.burned_at).getTime()/1000)) : '?';
        const typeLabel = burnTypeLabel(latest.result_body_type, latest.result_is_angel);
        embed.addFields({ name:'Latest Burn',
          value:`[#${latest.survivor_token_id}](https://opensea.io/assets/ethereum/${OCAS_CONTRACT}/${latest.survivor_token_id}) · ${typeLabel} · ${latest.burned_count || '?'} tokens used · ${ago}`,
          inline:false });
      }
      embed.setFooter({ text:'OCAS Burn Machine' }).setTimestamp();
      await interaction.editReply({ embeds:[embed] });
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // /burn token:ID
  if(commandName==='burn'){
    const _burnCool = checkCommandCooldown(interaction.user.id, 'burn');
    if(_burnCool) return interaction.reply({content:`⏳ Please wait **${_burnCool}s** before using this command again.`, flags:MessageFlags.Ephemeral});
    const tokenInput = interaction.options.getInteger('token');
    if(!tokenInput) return interaction.reply({ content:'Provide a token ID.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    try{
      const contract = OCAS_CONTRACT;
      const osUrl  = `https://opensea.io/assets/ethereum/${contract}/${tokenInput}`;
      const tvUrl  = `https://traitview.com/?token=${tokenInput}`;
      const ethUrl = `https://etherscan.io/token/${contract}?a=${tokenInput}`;

      // Helper: fetch thumbnail for any token ID
      // Priority: 1) contract tokenURI image field (fastest, always current)
      //           2) resolveImage via OpenSea (fallback)
      async function fetchThumbForToken(tid, opts = {}){
        try{
          // Burned/consumed tokens may no longer have valid contract metadata.
          // For those, prefer the historical snapshot captured at BurnStarted.
          if(opts.historicalFromDb){
            const snap = await fetchSnapshotImageForToken(tid);
            if(snap) return snap;
            return null;
          }
          // Bust image cache so stale pre-burn images never get served for survivor/current tokens
          clearCachedImage?.(`${contract}:${tid}`);
          const contractTraits = await fetchTokenUriFromContract(tid).catch(()=>null);
          if(contractTraits?.__image){
            const imgSrc = contractTraits.__image;
            if(imgSrc.startsWith('<svg') || imgSrc.startsWith('data:image/svg') || imgSrc.toLowerCase().includes('image/svg')){
              try{
                const buf = await extractPngFromSvg(imgSrc);
                if(buf) return { type:'buffer', buffer:buf, filename:`token-${tid}.png` };
              }catch(_){}
            }
            if(imgSrc.startsWith('http') && isDiscordOk(imgSrc)) return { type:'url', url:imgSrc };
          }
          return await resolveImage({ identifier: String(tid) }, contract, 'ethereum');
        }catch(e){ return null; }
      }

      async function replyWithEmbed(embed, tid, opts = {}){
        const ir = await fetchThumbForToken(tid, opts);
        if(ir?.type==='buffer'){
          const att = new AttachmentBuilder(ir.buffer, { name:`token-${tid}.png` });
          embed.setThumbnail(`attachment://token-${tid}.png`);
          await interaction.editReply({ embeds:[embed], files:[att] });
        } else {
          if(ir?.type==='url') embed.setThumbnail(ir.url);
          await interaction.editReply({ embeds:[embed] });
        }
      }

      // Check if this token was consumed in a burn
      const consumedRes = await pgPool.query(`
        SELECT be.survivor_token_id, be.burner_wallet, be.burned_at,
               be.points_used, be.tx_hash,
               array_agg(bei2.burned_token_id ORDER BY bei2.burned_token_id) AS burned_ids
        FROM burn_event_inputs bei
        JOIN burn_events be ON be.id = bei.burn_event_id
        LEFT JOIN burn_event_inputs bei2 ON bei2.burn_event_id = be.id
        WHERE bei.burned_token_id = $1
        GROUP BY be.id
        LIMIT 1
      `, [tokenInput]);

      // Check if this token was ever a survivor
      const survivorCheckRes = await pgPool.query(
        `SELECT COUNT(*)::int AS cnt FROM burn_events WHERE survivor_token_id=$1`, [tokenInput]
      );
      const isSurvivor = (survivorCheckRes.rows[0]?.cnt || 0) > 0;

      if(!consumedRes.rows.length && !isSurvivor){
        const embed = new EmbedBuilder()
          .setColor(BURN_COLORS.FIRE)
          .setTitle(`#${tokenInput} — no burn activity`)
          .setDescription(`This token has not been burned and was not created via the burn machine.`)
          .addFields({ name:'Links', value:`[OpenSea](${osUrl}) | [TraitView](${tvUrl})`, inline:false })
          .setURL(osUrl)
          .setFooter({ text:'OCAS Burn Machine • on-chain-all-stars' });
        await replyWithEmbed(embed, tokenInput);
        return;
      }

      if(consumedRes.rows.length && !isSurvivor){
        // Token was consumed — show the single burn it was part of + pointer to survivor chain
        const b = consumedRes.rows[0];
        const survivorId  = b.survivor_token_id;
        const survivorUrl = `https://opensea.io/assets/ethereum/${contract}/${survivorId}`;
        const ago         = b.burned_at ? timeSince(Math.floor(new Date(b.burned_at).getTime()/1000)) : '?';
        const burnedIds   = (b.burned_ids||[]).filter(Boolean);
        const tokensStr   = burnedIds.length ? burnedIds.map(id=>`#${id}`).join(', ') : '?';
        const embed = new EmbedBuilder()
          .setColor(BURN_COLORS.FIRE)
          .setTitle(`#${tokenInput} — burned`)
          .setDescription(`This token was burned **${ago}** and helped create [#${survivorId}](${survivorUrl}).`)
          .addFields(
            { name:'Burner',           value:`[${shortAddr(b.burner_wallet)}](https://opensea.io/${b.burner_wallet})`, inline:true },
            { name:'Created',          value:`[#${survivorId}](${survivorUrl})`, inline:true },
            { name:'Tokens burned',    value:String(burnedIds.length || '?'), inline:true },
            { name:'Points used',      value:String(b.points_used || 0), inline:true },
            { name:'All tokens',       value:tokensStr.length > 1024 ? tokensStr.slice(0,1021)+'...' : tokensStr, inline:false },
            { name:'See full history', value:`\`/burn token:${survivorId}\``, inline:false },
            { name:'Links',            value:`[OpenSea](${osUrl}) | [TraitView](${tvUrl}) | [Etherscan](https://etherscan.io/tx/${b.tx_hash||''})`, inline:false },
          )
          .setURL(osUrl)
          .setFooter({ text:'OCAS Burn Machine • on-chain-all-stars' });
        await replyWithEmbed(embed, tokenInput, { historicalFromDb:true });
        return;
      }

      // Token is a survivor — fetch full burn chain
      const chainRes = await pgPool.query(`
        SELECT be.id, be.tx_hash, be.burner_wallet, be.burned_at, be.points_used,
               COALESCE(
                 started.burned_ids,
                 array_agg(DISTINCT bei.burned_token_id ORDER BY bei.burned_token_id)
                   FILTER (WHERE bei.burned_token_id IS NOT NULL),
                 ARRAY[]::int[]
               ) AS burned_ids
        FROM burn_events be
        LEFT JOIN LATERAL (
          SELECT bse.id,
                 array_agg(bsi.burned_token_id ORDER BY bsi.burned_token_id) AS burned_ids
          FROM burn_started_events bse
          JOIN burn_started_inputs bsi ON bsi.burn_started_id = bse.id
          WHERE bse.survivor_token_id = be.survivor_token_id
            AND bse.owner_wallet = be.burner_wallet
            AND bse.block_number <= be.block_number
          GROUP BY bse.id
          ORDER BY MAX(bse.block_number) DESC, MAX(bse.log_index) DESC
          LIMIT 1
        ) started ON true
        LEFT JOIN burn_event_inputs bei
          ON bei.burn_event_id = be.id
        WHERE be.survivor_token_id = $1
        GROUP BY be.id, started.burned_ids
        ORDER BY be.burned_at ASC NULLS LAST
      `, [tokenInput]);

      const burns            = chainRes.rows;
      const totalPts         = burns.reduce((s,r)=>s+(r.points_used||0), 0);
      // Subtract 1 per burn for the survivor token — it upgrades itself and is never actually consumed.
const totalTokensBurned = burns.reduce((s,r)=>{
  const ids = (r.burned_ids || [])
    .filter(Boolean)
    .map(Number)
    .filter(id => id !== Number(tokenInput));
  return s + ids.length;
}, 0);

      const embed = new EmbedBuilder()
        .setColor(BURN_COLORS.FIRE)
        .setTitle(`🔥 #${tokenInput} burn history`)
        .setDescription(
          `Burned **${burns.length} time${burns.length===1?"":"s"}** · **${totalTokensBurned} tokens** burned · **${totalPts} pts** total`
        )
        .setURL(osUrl)
        .setFooter({ text:'OCAS Burn Machine • on-chain-all-stars' });

      // Oldest first (Burn 1 → Burn N), up to 10 most recent
      const displayBurns = burns.length > 10 ? burns.slice(burns.length - 10) : [...burns];
      console.log('[DEBUG] displayBurns count:', displayBurns.length, 'burns[0].id:', burns[0]?.id);

      for(let i = 0; i < displayBurns.length; i++){
        const b = displayBurns[i];
        // burnNum is the actual position in the full chain, not just the display slice
        const burnNum = burns.indexOf(b) + 1;
        const ago      = b.burned_at ? timeSince(Math.floor(new Date(b.burned_at).getTime()/1000)) : '?';
        const consumedIds = (b.burned_ids || [])
          .filter(Boolean)
          .map(Number)
          .filter(id => id !== Number(tokenInput));
        
        
      const tokenTypes = await burnTypeBreakdown(consumedIds, b.id).catch(()=>String(consumedIds.length || '?'));
      const tokensStr_base = tokenTypes.replace(/^\d+/, String(consumedIds.length));

        // Get seed type (token's type at time of this burn) for parenthetical display
        // Uses the same fallback chain as buildBurnEmbed's survivorPreBurnType lookup
        let seedType = null;
        try {
          const sid = parseInt(tokenInput);
          // 1. burn-start-input snapshot
          const s1 = await pgPool.query(
            `SELECT traits_json FROM token_image_snapshots
             WHERE token_id=$1 AND source='burn-start-input'
             AND id <= (SELECT COALESCE(MAX(id),999999999) FROM token_image_snapshots WHERE token_id=$1 AND source='burn-start-input' AND created_at <= $2)
             ORDER BY id DESC LIMIT 1`,
            [sid, b.burned_at || new Date().toISOString()]
          ).catch(()=>({rows:[]}));
          if(s1.rows[0]?.traits_json){
            const tj = typeof s1.rows[0].traits_json==='string' ? JSON.parse(s1.rows[0].traits_json) : s1.rows[0].traits_json;
            seedType = normalizeOcasType(tj?.Type || tj?.type || null);
          }
          console.log('[SeedType s1]', s1.rows[0]?.traits_json ? 'hit' : 'miss');
          // 2. burn_state_snapshots — state from before this burn event
          if(!seedType){
            const s2 = await pgPool.query(
              `SELECT traits_json FROM burn_state_snapshots
               WHERE token_id=$1 AND burn_event_id < $2
               ORDER BY burn_event_id DESC LIMIT 1`,
              [sid, b.id]
            ).catch(()=>({rows:[]}));
            if(s2.rows[0]?.traits_json){
              const tj = typeof s2.rows[0].traits_json==='string' ? JSON.parse(s2.rows[0].traits_json) : s2.rows[0].traits_json;
              seedType = normalizeOcasType(tj?.Type || tj?.type || null);
            }
          }
          console.log('[SeedType s2]', s2.rows[0]?.traits_json ? 'hit' : 'miss', 'seedType now:', seedType);
          // 3. token_original_snapshots
          if(!seedType){
            const s3 = await pgPool.query(
              `SELECT traits_json FROM token_original_snapshots WHERE token_id=$1`, [sid]
            ).catch(()=>({rows:[]}));
            if(s3.rows[0]?.traits_json){
              const tj = typeof s3.rows[0].traits_json==='string' ? JSON.parse(s3.rows[0].traits_json) : s3.rows[0].traits_json;
              seedType = normalizeOcasType(tj?.Type || tj?.type || null);
            }
          }
          console.log('[SeedType s3]', s3.rows[0]?.traits_json ? 'hit' : 'miss', 'seedType now:', seedType);
          // 4. backfill-chunks snapshot
          if(!seedType){
            const s4 = await pgPool.query(
              `SELECT traits_json FROM token_image_snapshots
               WHERE token_id=$1 AND source='backfill-chunks'
               ORDER BY id DESC LIMIT 1`, [sid]
            ).catch(()=>({rows:[]}));
            if(s4.rows[0]?.traits_json){
              const tj = typeof s4.rows[0].traits_json==='string' ? JSON.parse(s4.rows[0].traits_json) : s4.rows[0].traits_json;
              seedType = normalizeOcasType(tj?.Type || tj?.type || null);
            }
          }
          // 5. token_traits — last resort
          if(!seedType){
            const s5 = await pgPool.query(
              `SELECT trait_value FROM token_traits WHERE token_id=$1 AND LOWER(trait_name)='type' LIMIT 1`, [sid]
            ).catch(()=>({rows:[]}));
            if(s5.rows[0]?.trait_value) seedType = normalizeOcasType(s5.rows[0].trait_value);
          }
        } catch(seedErr){ console.warn('[SeedType] error:', seedErr.message); }
        console.log('[SeedType] burn', burnNum, 'token', tokenInput, '=> seedType:', seedType);

        const tokensStr = seedType ? `${tokensStr_base} (+ 1x ${seedType})` : tokensStr_base;
        const fieldVal = [
          `**Burner:** [${shortAddr(b.burner_wallet)}](https://opensea.io/${b.burner_wallet})`,
          `**Tokens Burned:** ${tokensStr}`,
          `**Points:** ${b.points_used||0}`,
        ].join('\n');
        embed.addFields({ name:`Burn ${burnNum} — ${ago}`, value:fieldVal, inline:true });
      }

      if(burns.length > 10){
        embed.addFields({ name:`+${burns.length-10} earlier burns`, value:'Only the 10 most recent burns are shown.', inline:false });
      }

      embed.addFields({
        name:'Links',
        value:`[OpenSea](${osUrl}) | [TraitView](${tvUrl}) | [Etherscan](${ethUrl})`,
        inline:false
      });


      // Two buttons: Show all burned tokens + Show Pre-Burn History slideshow
      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`burn_all_tokens:${tokenInput}`)
          .setLabel('Show All Burned Tokens')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`burn_preburn:${tokenInput}`)
          .setLabel('Pre-Burn History')
          .setStyle(ButtonStyle.Primary),
      );

      // Current state as thumbnail only — no large image
      const ir = await fetchThumbForToken(tokenInput);
      const files = [];
      if(ir?.type==='buffer'){
        const att = new AttachmentBuilder(ir.buffer, { name:`token-${tokenInput}.png` });
        embed.setThumbnail(`attachment://token-${tokenInput}.png`);
        files.push(att);
      } else if(ir?.type==='url'){
        embed.setThumbnail(ir.url);
      }

      await interaction.editReply({ embeds:[embed], files, components:[actionRow] });
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // /burnwallet wallet:ADDRESS
  if(commandName==='burnwallet'){
    const walletAddr = (interaction.options.getString('wallet')||'').trim().toLowerCase();
    if(!/^0x[a-f0-9]{40}$/.test(walletAddr))
      return interaction.reply({ content:'Invalid wallet address. Use format: 0x...', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    try{
      const contract = OCAS_CONTRACT;
      const r = await pgPool.query(`
        SELECT be.id, be.survivor_token_id, be.result_body_type, be.result_is_angel,
               be.points_used, be.burned_at,
               array_agg(bei.burned_token_id ORDER BY bei.burned_token_id) AS burned_ids
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        WHERE LOWER(be.burner_wallet) = $1
        GROUP BY be.id
        ORDER BY be.burned_at DESC
        LIMIT 10
      `, [walletAddr]);
      if(!r.rows.length){
        await interaction.editReply(`No burn activity found for \`${shortAddr(walletAddr)}\`.`);
        return;
      }
      const totalBurned  = r.rows.reduce((s,row)=>(s + (row.burned_ids||[]).filter(Boolean).length), 0);
      const totalCreated = r.rows.length;
      const totalPoints  = r.rows.reduce((s,row)=>s + (parseInt(row.points_used)||0), 0);
      // Best created token by type rarity: Radioactive > Zombie > Skeleton > Human
      const typeOrder = { 3:0, 1:1, 2:2, 0:3 };
      const best = r.rows.sort((a,b)=>(typeOrder[a.result_body_type]??4)-(typeOrder[b.result_body_type]??4))[0];
      const embed = new EmbedBuilder()
        .setTitle(`Burn History: ${shortAddr(walletAddr)}`)
        .setColor(BURN_COLORS.FIRE)
        .setURL(`https://opensea.io/${walletAddr}`)
        .addFields(
          { name:'Tokens Burned',   value:String(totalBurned),  inline:true },
          { name:'Tokens Created',  value:String(totalCreated), inline:true },
          { name:'Total Points',    value:String(totalPoints),  inline:true },
          { name:'Best Created',    value:`[#${best.survivor_token_id}](https://opensea.io/assets/ethereum/${contract}/${best.survivor_token_id})`, inline:false },
        );
      const recentLines = r.rows.slice(0,5).map(row=>{
        const ids = (row.burned_ids||[]).filter(Boolean);
        const ago = row.burned_at ? timeSince(Math.floor(new Date(row.burned_at).getTime()/1000)) : '?';
        return `[#${row.survivor_token_id}](https://opensea.io/assets/ethereum/${contract}/${row.survivor_token_id}) - ${ids.length} burned - ${ago}`;
      });
      embed.addFields({ name:'Recent Burns (up to 5)', value:recentLines.join('\n'), inline:false });
      embed.setFooter({ text:'OCAS Burn Machine' }).setTimestamp();
      await interaction.editReply({ embeds:[embed] });
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // /burnleaderboard
  if(commandName==='burnleaderboard'){
    await interaction.deferReply();
    try{
      const contract = OCAS_CONTRACT;
      const r = await pgPool.query(`
        SELECT be.burner_wallet,
               COUNT(be.id)::int AS total_burns,
               SUM(array_length(ARRAY(SELECT bei2.burned_token_id FROM burn_event_inputs bei2 WHERE bei2.burn_event_id = be.id), 1))::int AS total_burned,
               SUM(be.points_used)::int AS total_points
        FROM burn_events be
        GROUP BY be.burner_wallet
        ORDER BY total_burned DESC
        LIMIT 10
      `);
      if(!r.rows.length){ await interaction.editReply('No burn data yet.'); return; }
      const lines = r.rows.map((row,i)=>{
        const wallet = `[${shortAddr(row.burner_wallet)}](https://opensea.io/${row.burner_wallet})`;
        return `**${i+1}.** ${wallet} - ${row.total_burned} burned - ${row.total_burns} burns - ${row.total_points||0} pts`;
      });
      const embed = new EmbedBuilder()
        .setTitle('OCAS Burn Leaderboard')
        .setColor(BURN_COLORS.FIRE)
        .setDescription(lines.join('\n'))
        .setFooter({ text:'Ranked by total tokens burned' })
        .setTimestamp();
      await interaction.editReply({ embeds:[embed] });
    }catch(e){ await interaction.editReply('Error: '+e.message); }
    return;
  }

  // /burnrefresh token:ID — community command to re-queue a burn alert with fresh metadata
  if(commandName==='burnrefresh'){
    const tokenId = interaction.options.getInteger('token');
    if(!tokenId) return interaction.reply({ content:'Provide a token ID.', flags: MessageFlags.Ephemeral });

    // Rate limit: 1 use per user per token per 5 minutes
    const COOLDOWN_MS = 5 * 60 * 1000;
    const rlKey = `${interaction.user.id}:${tokenId}`;
    const lastUsed = burnRefreshCooldowns.get(rlKey);
    if(lastUsed && Date.now() - lastUsed < COOLDOWN_MS){
      const secsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - lastUsed)) / 1000);
      return interaction.reply({
        content: `You can use this command again for #${tokenId} in **${secsLeft}s**.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    burnRefreshCooldowns.set(rlKey, Date.now());
    // Prune old entries
    if(burnRefreshCooldowns.size > 1000){
      const cutoff = Date.now() - COOLDOWN_MS;
      for(const [k,v] of burnRefreshCooldowns) if(v < cutoff) burnRefreshCooldowns.delete(k);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try{
      // Look up the burn event from DB
      const r = await pgPool.query(`
        SELECT be.id, be.tx_hash, be.block_number, be.burner_wallet, be.survivor_token_id,
               be.result_body_type, be.result_is_angel, be.points_used, be.log_index,
               array_agg(bei.burned_token_id ORDER BY bei.burned_token_id) AS burned_ids
        FROM burn_events be
        LEFT JOIN burn_event_inputs bei ON bei.burn_event_id = be.id
        WHERE be.survivor_token_id = $1
        GROUP BY be.id
        ORDER BY be.block_number DESC, be.log_index DESC
        LIMIT 1
      `, [tokenId]);

      if(!r.rows.length){
        await interaction.editReply(`No burn event found for #${tokenId}. Only the created/survivor token ID can be refreshed.`);
        return;
      }

      const row = r.rows[0];
      const finalEvent = {
        survivorTokenId: row.survivor_token_id,
        resultBodyType:  row.result_body_type,
        resultIsAngel:   row.result_is_angel,
        points:          row.points_used,
        txHash:          row.tx_hash,
        blockNumber:     row.block_number,
        logIndex:        row.log_index,
        burnEventId:     row.id,
      };
      const startEvent = {
        owner:    row.burner_wallet,
        tokenIds: (row.burned_ids || []).filter(Boolean),
      };

      // Snapshot current DB traits to compare against after refresh
      const snapMeta = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
      const preBurnTraits = snapMeta?.traits ? { ...snapMeta.traits } : null;
      if(preBurnTraits){
        const snapType = preBurnTraits.Type || preBurnTraits.type || '?';
        console.log(`[BurnRefresh] DB snapshot for #${tokenId}: Type=${snapType}`);
      } else {
        console.log(`[BurnRefresh] No DB snapshot for #${tokenId} — will use 90s minimum wait`);
      }

      // Queue to pending alert system (skip if already pending, but always re-trigger refresh)
      const alertKey = String(tokenId);
      const alreadyPending = pendingBurnAlerts.has(alertKey);
      if(!alreadyPending){
        pendingBurnAlerts.set(alertKey, {
          finalEvent,
          startEvent,
          preBurnTraits, // snapshot for comparison — if null, 90s minimum wait applies
          addedAt:  Date.now(),
          attempts: 0,
          slowMode: false,
        });
      } else {
        // Already pending — update the snapshot and reset the timer so 90s wait applies fresh
        const existing = pendingBurnAlerts.get(alertKey);
        if(preBurnTraits) existing.preBurnTraits = preBurnTraits;
        existing.addedAt = Date.now();
        existing.attempts = 0;
        existing.slowMode = false;
        existing.lastChecked = null;
      }

      // Trigger OS metadata refresh regardless — this is the whole point of the command
      const refreshEnabled = BURN_METADATA_REFRESH_ENABLED;
      if(refreshEnabled){
        triggerOsMetadataRefresh(tokenId); // fire-and-forget
      }

      const statusMsg = alreadyPending
        ? `#${tokenId} is already queued — metadata refresh triggered again. Alert will post once traits update.`
        : `Queued burn alert for #${tokenId}. Metadata refresh triggered${refreshEnabled ? '' : ' (BURN_METADATA_REFRESH_ENABLED is off)'}. Alert will post once OS updates the traits — usually within 1–5 minutes.`;

      console.log(`[BurnRefresh] user=${interaction.user.id} token=#${tokenId} guild=${guildId} alreadyPending=${alreadyPending}`);
      await interaction.editReply(statusMsg);
    }catch(e){
      console.error('[BurnRefresh]', e.message);
      await interaction.editReply('Error: ' + e.message);
    }
    return;
  }





}

const BURN_COMMANDS = new Set([
  'burnlatest','burnstats','burn','burnwallet','burnleaderboard','burnrefresh',
]);

module.exports = { handleBurnCommand, BURN_COMMANDS };