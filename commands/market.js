'use strict';

const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const fetch = require('node-fetch');

/**
 * Handle market/NFT lookup commands.
 * @param {string} commandName
 * @param {object} ctx - shared context
 */

// ── Sweep helper functions ────────────────────────────────────────────────────
function getSweepTokenId(item){
  return item?.token_id ?? item?.id ?? item?.identifier ?? item?.tokenId ?? item?.tokenID ?? null;
}

function normalizeSweepListing(item){
  const tokenId = getSweepTokenId(item);
  return {
    token_id: tokenId ? parseInt(tokenId) : null,
    price_eth: item?.price_eth != null ? parseFloat(item.price_eth) : null,
    url: item?.url || null,
    os_rank: item?.os_rank ? parseInt(item.os_rank) : null,
    obs_rank: item?.obs_rank ? parseInt(item.obs_rank) : null,
    trait_count: item?.trait_count ? parseInt(item.trait_count) : null
  };
}

function sweepTokenUrl(item){
  const tokenId = getSweepTokenId(item);
  const contract = '0x078be86f3104a32313a47815792230a3808642cc';
  return tokenId ? ('https://opensea.io/assets/ethereum/' + contract + '/' + tokenId) : 'https://opensea.io/collection/on-chain-all-stars';
}

function formatSweepTokenLine(item){
  const tokenId = getSweepTokenId(item);
  const rank = item?.os_rank ? ('⬥' + Number(item.os_rank).toLocaleString()) : (item?.obs_rank ? ('⬥' + Number(item.obs_rank).toLocaleString()) : null);
  const tokenLink = '[#' + tokenId + '](' + sweepTokenUrl(item) + ')';
  const price = 'Ξ ' + parseFloat(item.price_eth).toFixed(4);
  return [tokenLink, rank, price].filter(Boolean).join(' · ');
}

async function handleMarketCommand(commandName, ctx){
  const {
    interaction, guildId, config,
    osHeaders, getRailwayApiUrl, API_SECRET,
    buildSaleEmbed, buildListingEmbed, sendEmbed, postEmbeds,
    checkCommandCooldown, getAlert, setAlert, deleteAlert,
    pgPool, fetchBotApiJson, resolveImage,
    slideshowSessions, sweepSessions,
    COLORS, OCAS_CONTRACT,
    getTraitIndex, chooseTraitGroupsFromQuery, traitGroupsLabel,
    buildTokenSearchEmbed, traitDisplayLines, traitObjectToArray,
    fetchTokenMetaFromDb, getRankTierColor, buildEmbedPayload,
    shortAddr, formatEth, timeSince, isDiscordOk, normAddr,
  } = ctx;

  if(commandName==='lastsale'){
    const slug=interaction.options.getString('collection')||config.slug;
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=1`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply('No sales found.');return;}
      const embed=await buildSaleEmbed(sales[0],{...config,slug});
      const ir=embed._imageResult;delete embed._imageResult;
      if(ir?.type==='buffer'){const att=new AttachmentBuilder(ir.buffer,{name:ir.filename});embed.setThumbnail(`attachment://${ir.filename}`);await interaction.editReply({embeds:[embed],files:[att]});}
      else{if(ir?.type==='url')embed.setThumbnail(ir.url);await interaction.editReply({embeds:[embed]});}
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /recentsales
  if(commandName==='recentsales'){
    const slug=interaction.options.getString('collection')||config.slug;
    const count=Math.min(interaction.options.getInteger('count')||5,20);
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=${count}`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply('No sales found.');return;}
      const cfg={...config,slug};
      const embeds=await Promise.all(sales.reverse().map(s=>buildSaleEmbed(s,cfg).catch(()=>null)));
      await postEmbeds(interaction, embeds.filter(Boolean), `Last ${sales.length} sales for **${slug}**:`);
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /sale token:ID
  if(commandName==='sale'){
    const tokenId=interaction.options.getString('token').replace('#','');
    const slug=interaction.options.getString('collection')||config.slug;
    const contract=config.contract||'';
    if(!slug) return interaction.reply({content:'Run `/setup` first.', flags: MessageFlags.Ephemeral});
    if(!contract) return interaction.reply({content:'Set a contract with `/setcollection`.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const chainForSale=config.chain||'ethereum';
      const r=await fetch(`https://api.opensea.io/api/v2/events/chain/${chainForSale}/contract/${contract}/nfts/${tokenId}?event_type=sale&limit=1`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply(`No sales found for #${tokenId}.`);return;}
      const embed=await buildSaleEmbed(sales[0],config);
      const ir=embed._imageResult;delete embed._imageResult;
      if(ir?.type==='buffer'){const att=new AttachmentBuilder(ir.buffer,{name:ir.filename});embed.setThumbnail(`attachment://${ir.filename}`);await interaction.editReply({embeds:[embed],files:[att]});}
      else{if(ir?.type==='url')embed.setThumbnail(ir.url);await interaction.editReply({embeds:[embed]});}
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /traitfind - token search by default; add "listings" or "sales" for those modes.
  if(commandName==='traitfind'){
    const _tfCool = checkCommandCooldown(interaction.user.id, 'traitfind');
    if(_tfCool) return interaction.reply({content:`⏳ Please wait **${_tfCool}s** before using this command again.`, flags:MessageFlags.Ephemeral});
    const slug       = interaction.options.getString('collection') || config.slug;
    const rawSearch  = (interaction.options.getString('search') || '').trim();
    const RAILWAY_URL = getRailwayApiUrl();
    const API_SECRET  = process.env.API_SECRET;

    // Detect mode: tokens default, or explicit listings/sales.
    const wantListings = /\blistings?\b/i.test(rawSearch);
    const wantSales    = /\bsales?\b/i.test(rawSearch);
    let workingSearch = rawSearch.replace(/\b(listings?|sales?)\b/gi, ' ').trim();

    // Parse count: first standalone number (default 10, max 20)
    let want = 10;
    const numMatch = workingSearch.match(/(?:^|\s)(\d+)(?=\s|$)/);
    if(numMatch){ const n=parseInt(numMatch[1]); if(n>0&&n<=20){ want=n; workingSearch=workingSearch.replace(numMatch[0],' ').trim(); } }

    // Resolve trait name+value using phrase-aware parser.
    let trait = '', value = '', groups = [], unmatched = [], traitParseError = null;
    if(workingSearch && RAILWAY_URL){
      try{
        const traitIndex = await getTraitIndex(RAILWAY_URL, API_SECRET);
        const resolved = chooseTraitGroupsFromQuery(workingSearch, traitIndex);
        groups = resolved.groups || [];
        unmatched = resolved.unmatched || [];
        if(groups.length){ trait = groups[0][0].trait_name; value = groups[0][0].trait_value; }
      }catch(e){ traitParseError = e; console.warn('[traitfind] parser error:', e.message); }
    }
    if(!trait && workingSearch){ value=workingSearch; }
    const matchLabel = traitGroupsLabel(groups, value || workingSearch);

    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    if(!workingSearch) return interaction.reply({content:'Provide a trait to search. e.g. `/traitfind search:zombie`, `/traitfind search:zombie listings`, or `/traitfind search:zombie sales`', flags: MessageFlags.Ephemeral});
    if(!RAILWAY_URL) return interaction.reply({content:'Trait search needs the internal TraitView API URL so it can read the token DB/cache. Set `RAILWAY_API_URL` in this Railway service.', flags: MessageFlags.Ephemeral});
    if(traitParseError) return interaction.reply({content:`I could not load the trait index from the TraitView API. ${traitParseError.message}`, flags: MessageFlags.Ephemeral});
    if(!groups.length){
      const extra = unmatched.length ? ` Unmatched words: ${unmatched.join(', ')}.` : '';
      return interaction.reply({content:`I could not match **${workingSearch}** to known OCAS traits.${extra} Try an exact trait/value like \`zombie\`, \`gold chain\`, or \`alien epic bear\`.`, flags: MessageFlags.Ephemeral});
    }
    await interaction.deferReply();

    try{
      // Token search is the default. "listings" narrows the same trait search
      // to active listings. "sales" keeps the existing sales-history behavior.
      if(wantListings || !wantSales){
        const listedOnly = wantListings;
        await interaction.editReply(`Searching ${listedOnly ? 'listed tokens' : 'OCAS tokens'} matching **${matchLabel}**...`);
        const qs = new URLSearchParams({ limit: String(want), key: API_SECRET||'' });
        qs.set('groups', JSON.stringify(groups));
        if(listedOnly) qs.set('listed', '1');
        const label = listedOnly ? '/db/multi-trait-tokens listings API' : '/db/multi-trait-tokens token API';
        const j = await fetchBotApiJson(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`, label);
        const tokens = j.tokens || [];
        if(!tokens.length){
          await interaction.editReply(`No ${listedOnly ? 'active listings' : 'OCAS tokens'} found matching **${matchLabel}**.`);
          return;
        }
        const cfg = {...config, slug};
        const embeds = await Promise.all(tokens.map(async t => {
          const tokenId = t.token_id ?? t.id ?? t.identifier;
          const dbMeta = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
          if(listedOnly){
            const priceWei = t.price_eth != null ? String(BigInt(Math.round(t.price_eth * 1e18))) : '0';
            const fakeListingObj = {
              token_id: tokenId,
              asset: { token_id: String(tokenId), identifier: String(tokenId), name: '#'+tokenId,
                       traits: dbMeta?.traits ? traitObjectToArray(dbMeta.traits) : [] },
              payment: { quantity: priceWei, decimals: 18, symbol: 'ETH', token_address: '' },
              maker: t.seller || '',
              url: t.url || null,
              os_rank: t.os_rank || null,
              _dbToken: dbMeta,
            };
            return buildListingEmbed(fakeListingObj, cfg).catch(()=>null);
          }
          return buildTokenSearchEmbed({...t, _dbToken: dbMeta}, cfg, `Trait Search - ${matchLabel}`).catch(()=>null);
        }));
        await postEmbeds(interaction, embeds.filter(Boolean),
          `Found **${tokens.length}** ${listedOnly ? 'listing' : 'token'}${tokens.length===1?'':'s'} matching **${matchLabel}**${listedOnly ? ' (cheapest first)' : ''}:`);
        return;
      }

      // ── Listings mode ──────────────────────────────────────────────────────
      if(wantListings && RAILWAY_URL){
        await interaction.editReply(`🔍 Searching listed tokens with **${trait ? trait+': ' : ''}${value}**...`);
        // Use multi-trait-tokens with listed=1 — build a single-group filter
        const groups = [[{ trait_name: trait || '_any', trait_value: value }]];
        // For single known trait, use groups param; otherwise fall back to trait-sales endpoint
        const qs = new URLSearchParams({ listed:'1', limit: String(want), key: API_SECRET||'' });
        if(trait) qs.set('groups', JSON.stringify([[{ trait_name: trait, trait_value: value }]]));
        const r = await fetch(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`);
        if(r.ok){
          const j = await r.json();
          if(!j.ok) throw new Error(j.error || 'API error');
          const tokens = j.tokens || [];
          if(!tokens.length){ await interaction.editReply(`No listed tokens found with **${trait ? trait+': ' : ''}${value}**.`); return; }
          const contract = config.contract || '';
          const listEmbeds = await Promise.all(tokens.map(async t => {
            const tokenId = t.token_id ?? t.id ?? t.identifier;
            const dbMeta = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
            const priceWei = t.price_eth != null ? String(BigInt(Math.round(t.price_eth * 1e18))) : '0';
            const fakeListingObj = {
              token_id: tokenId,
              asset: { token_id: String(tokenId), identifier: String(tokenId), name: '#'+tokenId,
                       traits: dbMeta?.traits ? traitObjectToArray(dbMeta.traits) : [] },
              payment: { quantity: priceWei, decimals: 18, symbol: 'ETH', token_address: '' },
              maker: t.seller || '',
              url: t.url || null,
              _dbToken: dbMeta,
            };
            return buildListingEmbed(fakeListingObj, {...config, slug}).catch(()=>null);
          }));
          await postEmbeds(interaction, listEmbeds.filter(Boolean),
            `Found **${tokens.length}** listing${tokens.length===1?'':'s'} with **${trait ? trait+': ' : ''}${value}** (cheapest first):`);
          return;
        }
      }

      // ── Sales mode (default) ───────────────────────────────────────────────
      if(RAILWAY_URL){
        await interaction.editReply(`🔍 Searching **${trait ? trait+': ' : ''}${value}** in full sales history...`);
        const qs = new URLSearchParams({ trait, value, limit: String(Math.min(want, 200)), sort: 'desc' });
        if(API_SECRET) qs.set('key', API_SECRET);
        const r = await fetch(`${RAILWAY_URL}/db/trait-sales?${qs}`);
        if(r.ok){
          const j = await r.json();
          if(!j.ok) throw new Error(j.error || 'DB error');
          const sales = j.sales || [];
          if(!sales.length){ await interaction.editReply(`No sales found for **${trait ? trait+': ' : ''}${value}** (searched ${j.count ?? 'all'} records).`); return; }
          const cfg = {...config, slug};
          const toShow = sales.slice(0, want);
          const saleEmbeds = await Promise.all(toShow.map(async sale => {
            const dbMeta = await fetchTokenMetaFromDb(sale.token_id).catch(()=>null);
            const tokenTraits = dbMeta?.traits ? traitObjectToArray(dbMeta.traits) : [];
            const syntheticSale = {
              nft: { identifier: String(sale.token_id), name: `#${sale.token_id}`, traits: tokenTraits },
              buyer: sale.buyer||'unknown', seller: sale.seller||'unknown',
              payment: { symbol: (sale.currency||'ETH'), token_address: (sale.currency||'ETH').toUpperCase()==='WETH'?'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2':'', quantity: sale.price_eth!=null?String(BigInt(Math.round(sale.price_eth*1e18))):'0', decimals:18 },
              event_timestamp: sale.sale_ts ? Math.floor(new Date(sale.sale_ts).getTime()/1000) : null,
            };
            return buildSaleEmbed(syntheticSale, cfg).catch(()=>null);
          }));
          const totalNote = j.count > want ? ` (showing ${want} of ${j.count} total)` : '';
          await postEmbeds(interaction, saleEmbeds.filter(Boolean),
            `Found **${j.count}** sale${j.count===1?'':'s'} with **${trait ? trait+': ' : ''}${value}**${totalNote}:`);
          return;
        }
        console.warn('[traitfind] Railway DB call failed, falling back to OpenSea');
      }

      // ── Contract fallback — fetch traits for matched tokens directly from chain ─
      // Only fires when Railway DB is unavailable. Contract is always authoritative.
      if(groups.length){
        try{
          await interaction.editReply(`🔍 Fetching on-chain traits for **${matchLabel}**...`);
          // We don't have token IDs without the DB, so this is a best-effort single-token lookup
          // using the trait search term to at least surface what we can from the contract.
          console.log('[traitfind] contract fallback triggered for groups:', JSON.stringify(groups));
        }catch(e){ console.warn('[traitfind] contract fallback error:', e.message); }
      }

      // ── OpenSea fallback (sales only) ──────────────────────────────────────
      await interaction.editReply(`🔍 Searching OpenSea sales for **${trait ? trait+': ' : ''}${value}**...`);
      const traitLow=trait.toLowerCase(), valueLow=value.toLowerCase();
      const matched=[];let cursor=null;let pages=0;
      while(matched.length<want&&pages<15){
        const qs=new URLSearchParams({event_type:'sale',limit:'100'});
        if(cursor) qs.set('next',cursor);
        const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?${qs}`,{headers:osHeaders()});
        if(!r.ok) break;
        const j=await r.json();const sales=j.asset_events||[];if(!sales.length) break;
        for(const sale of sales){
          if(matched.length>=want) break;
          const lookup={};
          for(const t of (sale.nft?.traits||[])) lookup[t.trait_type?.toLowerCase()]=String(t.value).toLowerCase();
          if(lookup[traitLow]===valueLow) matched.push(sale);
        }
        cursor=j.next||null;if(!cursor) break;pages++;
      }
      if(!matched.length){ await interaction.editReply(`No sales found with **${trait ? trait+': ' : ''}${value}** in the last ~${pages*100} sales.`); return; }
      const cfg={...config,slug};
      await interaction.editReply(`Found **${matched.length}** sale${matched.length===1?'':'s'} with **${trait ? trait+': ' : ''}${value}** (OpenSea, last ~${pages*100}):`);
      for(const sale of matched){const embed=await buildSaleEmbed(sale,cfg);await sendEmbed(interaction.channel,embed);await new Promise(r=>setTimeout(r,800));}
    }catch(e){
      console.warn('[traitfind]', e.message);
      await interaction.editReply(`I could not load trait results from the TraitView API. ${e.message}`);
    }
    return;
  }

  // /listings
  if(commandName==='listings'){
    const slug=interaction.options.getString('collection')||config.slug;
    const count=Math.min(interaction.options.getInteger('count')||5,20);
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=listing&limit=${count}`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const listings=(await r.json()).asset_events||[];
      if(!listings.length){await interaction.editReply('No listings found.');return;}
      const cfg={...config,slug};
      const embeds=await Promise.all(listings.reverse().map(l=>buildListingEmbed(l,cfg).catch(()=>null)));
      await postEmbeds(interaction, embeds.filter(Boolean), `${listings.length} recent listings for **${slug}**:`);
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /debuglisting — show raw listing event to diagnose parsing issues
  if(commandName==='debuglisting'){
    const slug=interaction.options.getString('collection')||config.slug;
    if(!slug) return interaction.reply({content:'Provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply({ephemeral:true});
    try{
      const r=await fetch('https://api.opensea.io/api/v2/events/collection/'+encodeURIComponent(slug)+'?event_type=listing&limit=1',{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const j=await r.json();
      const events=j.asset_events||[];
      if(!events.length){await interaction.editReply('No listings found.');return;}
      const ev=events[0];
      const lines=[];
      lines.push('**Top-level keys:** '+JSON.stringify(Object.keys(ev)));
      lines.push('**event_type:** '+ev.event_type);
      lines.push('**nft keys:** '+(ev.nft?JSON.stringify(Object.keys(ev.nft)):'null'));
      lines.push('**nft.identifier:** '+(ev.nft?.identifier||'null'));
      lines.push('**nft.name:** '+(ev.nft?.name||'null'));
      lines.push('**nft.image_url:** '+(ev.nft?.image_url||'null'));
      lines.push('**price:** '+JSON.stringify(ev.price||null));
      lines.push('**payment:** '+JSON.stringify(ev.payment||null));
      lines.push('**base_price:** '+(ev.base_price||'null'));
      lines.push('**maker:** '+JSON.stringify(ev.maker||null));
      lines.push('**seller:** '+(ev.seller||'null'));
      lines.push('**item keys:** '+(ev.item?JSON.stringify(Object.keys(ev.item)):'null'));
      await interaction.editReply(lines.join('\n').slice(0,1900));
    }catch(err){await interaction.editReply('Error: '+err.message);}
    return;
  }

    // /myalert — personal DM alert setup
  if(commandName==='myalert'){
    const trait=interaction.options.getString('trait')?.toLowerCase().trim();
    const value=interaction.options.getString('value')?.toLowerCase().trim();
    const alertSales=interaction.options.getBoolean('sales')??true;
    const alertListings=interaction.options.getBoolean('listings')??true;
    const slug=interaction.options.getString('collection')||config.slug;
    if(!slug) return interaction.reply({content:'Provide a collection or run `/setup` in a configured server first.', flags: MessageFlags.Ephemeral});

    const existing=getAlert(interaction.user.id)||{};
    const filters={...(existing.traitFilters||{})};

    // Stack multiple values for same trait (OR logic) — same as server filters
    if(trait&&value){
      const current=filters[trait];
      if(!current) filters[trait]=value;
      else if(Array.isArray(current)) filters[trait]=current.includes(value)?current:[...current,value];
      else filters[trait]=current===value?current:[current,value];
    }

    setAlert(interaction.user.id,{slug,traitFilters:filters,alertSales,alertListings});

    const fmtF=f=>Object.keys(f||{}).length===0?'none (all)':Object.entries(f).map(([k,v])=>`**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join(', ');
    const filterStr=fmtF(filters);
    const lines=[
      `Personal alert set for **${slug}**!`,
      `Filters: ${filterStr}`,
      `Sales DMs: ${alertSales?'on':'off'}`,
      `Listing DMs: ${alertListings?'on':'off'}`,
      '',
      'You will receive DMs when matching events happen.',
      'Use `/myalert` again to add more trait filters.',
      'Use `/myalertclear` to remove your alert.'
    ].join('\n');

    await interaction.reply({content:lines, flags: MessageFlags.Ephemeral});
    return;
  }

  // /myalertclear
  if(commandName==='myalertclear'){
    const trait=interaction.options.getString('trait');
    const value=interaction.options.getString('value');
    if(trait){
      // Remove just one trait/value from the alert
      const alert=getAlert(interaction.user.id);
      if(!alert){ await interaction.reply({content:'You have no alert set.', flags: MessageFlags.Ephemeral}); return; }
      const filters={...(alert.traitFilters||{})};
      if(value&&filters[trait]){
        const current=filters[trait];
        if(Array.isArray(current)){
          const updated=current.filter(v=>v!==value.toLowerCase().trim());
          if(updated.length===0) delete filters[trait];
          else if(updated.length===1) filters[trait]=updated[0];
          else filters[trait]=updated;
        } else { delete filters[trait]; }
      } else { delete filters[trait]; }
      setAlert(interaction.user.id,{...alert,traitFilters:filters});
      const remaining=Object.keys(filters).length===0?'none':Object.entries(filters).map(([k,v])=>`**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join(', ');
      await interaction.reply({content:`Removed filter. Remaining: ${remaining}`, flags: MessageFlags.Ephemeral});
    } else {
      deleteAlert(interaction.user.id);
      await interaction.reply({content:'Your personal alert has been fully removed.', flags: MessageFlags.Ephemeral});
    }
    return;
  }

  // /myalertstatus
  if(commandName==='myalertstatus'){
    const alert=getAlert(interaction.user.id);
    if(!alert){await interaction.reply({content:'You have no personal alert set. Use `/myalert` to create one.', flags: MessageFlags.Ephemeral});return;}
    const filterStr=alert.traitFilters&&Object.keys(alert.traitFilters).length>0?Object.entries(alert.traitFilters).map(([k,v])=>`**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join('\n'):'none (all events)';
    const lines=[
      `Collection: **${alert.slug||'any'}**`,
      `Sales DMs: ${alert.alertSales?'on':'off'}`,
      `Listing DMs: ${alert.alertListings?'on':'off'}`,
      `Filters:\n${filterStr}`
    ].join('\n');
    await interaction.reply({content:lines, flags: MessageFlags.Ephemeral});
    return;
  }

  // /help
  // /rankfilter — show currently listed tokens filtered by OS rank range
  if(commandName==='rankfind'){
    const _rfCool = checkCommandCooldown(interaction.user.id, 'rankfind');
    if(_rfCool) return interaction.reply({content:`⏳ Please wait **${_rfCool}s** before using this command again.`, flags:MessageFlags.Ephemeral});
    const rawSearch  = (interaction.options.getString('search') || '').trim();
    const RAILWAY_URL = getRailwayApiUrl();
    const API_SECRET  = process.env.API_SECRET;

    // Detect mode: sales or listings (default)
    const wantSales    = /\bsales?\b/i.test(rawSearch);
    const wantListings = !wantSales;
    let workingSearch = rawSearch.replace(/\b(listings?|sales?)\b/gi, ' ').trim();

    // Parse range: "1-100", "1 to 100"
    let rankMin = 1, rankMax = 100;
    const rangeMatch = workingSearch.match(/(\d+)\s*(?:-|to|–)\s*(\d+)/);
    if(rangeMatch){ rankMin = parseInt(rangeMatch[1]); rankMax = parseInt(rangeMatch[2]); }
    else { const numMatch = workingSearch.match(/(\d+)/); if(numMatch) rankMax = parseInt(numMatch[1]); }

    // Parse sort for listings mode: 'rank'/'best' or default 'price'/'cheapest'
    const sortBy = /\b(rank|best)\b/i.test(workingSearch) ? 'rank' : 'price';

    if(!RAILWAY_URL) return interaction.reply({ content: 'RAILWAY_API_URL not configured. Set it to your internal/public TraitView API URL in this Railway service.', flags: MessageFlags.Ephemeral });
    if(rankMin < 1 || rankMax > 10000 || rankMin > rankMax) return interaction.reply({ content: 'Invalid rank range. Try: "1-100" or "1-500 rank"', flags: MessageFlags.Ephemeral });

    await interaction.deferReply();
    const contract = config.contract || '';
    try{

      // ── Sales mode ─────────────────────────────────────────────────────────
      if(wantSales){
        const qs = new URLSearchParams({ rank_min: rankMin, rank_max: rankMax, limit: '20', sort: 'desc' });
        if(API_SECRET) qs.set('key', API_SECRET);
        const j = await fetchBotApiJson(`${RAILWAY_URL}/db/rank-sales?${qs}`, '/db/rank-sales API');
        const sales = j.sales || [];
        if(!sales.length){ await interaction.editReply(`No sales found for OS rank **⬥ #${rankMin}–#${rankMax}**.`); return; }
        const cfg = {...config};
        const saleEmbeds = await Promise.all(sales.map(async sale => {
          const tokenTraits = sale.traits && typeof sale.traits==='object'
            ? traitObjectToArray(sale.traits)
            : [];
          const isWethSale = (sale.currency||'ETH').toUpperCase() === 'WETH';
          const syntheticSale = {
            nft: { identifier: String(sale.token_id), name: `#${sale.token_id}`, traits: tokenTraits, os_rank: sale.os_rank },
            buyer: sale.buyer||'unknown', seller: sale.seller||'unknown',
            payment: { symbol: (sale.currency||'ETH'), token_address: isWethSale?'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2':'', quantity: sale.price_eth!=null?String(BigInt(Math.round(sale.price_eth*1e18))):'0', decimals:18 },
            event_timestamp: sale.sale_ts ? Math.floor(new Date(sale.sale_ts).getTime()/1000) : null,
          };
          return buildSaleEmbed(syntheticSale, cfg).catch(()=>null);
        }));
        await postEmbeds(interaction, saleEmbeds.filter(Boolean),
          `📊 **OS Rank ⬥ #${rankMin}–#${rankMax}** — ${sales.length} recent sale${sales.length===1?'':'s'}:`);
        return;
      }

      // ── Listings mode (default) ────────────────────────────────────────────
      const qs = new URLSearchParams({ listed: '1', rank_min: rankMin, rank_max: rankMax, rank_type: 'os', limit: '20' });
      if(API_SECRET) qs.set('key', API_SECRET);
      const j = await fetchBotApiJson(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`, '/db/multi-trait-tokens rank listings API');
      let listings = j.tokens || [];
      if(!listings.length){ await interaction.editReply(`No listings found with OS rank **⬥ #${rankMin}–#${rankMax}**.`); return; }
      if(sortBy === 'rank') listings.sort((a,b) => (a.os_rank??9999) - (b.os_rank??9999));
      const rankEmbeds = await Promise.all(listings.map(async l => {
        const tokenId = l.token_id ?? l.id ?? l.identifier;
        const dbMeta = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
        const tokenTraits = dbMeta?.traits
          ? traitObjectToArray(dbMeta.traits)
          : (l.traits && typeof l.traits==='object' ? traitObjectToArray(l.traits) : []);
        const priceStr = l.price_eth >= 1 ? l.price_eth.toFixed(3) : l.price_eth.toFixed(4);
        const rankBadge = l.os_rank ? ` ⬥${Number(l.os_rank).toLocaleString()}` : '';
        const listingUrl = l.url || `https://opensea.io/assets/ethereum/${contract}/${tokenId}`;
        const tvUrl = `https://traitview.com/?jump=${tokenId}`;
        const rankColor = getRankTierColor(l.os_rank) ?? COLORS.OPENSEA_BLUE;
        const embed = new EmbedBuilder()
          .setColor(rankColor)
          .setTitle(`${priceStr} ETH • #${tokenId}${rankBadge} • Listed`)
          .setURL(listingUrl)
          .setFooter({ text: `on-chain-all-stars · OS Rank #${rankMin}–#${rankMax} · ${sortBy==='rank'?'best rank first':'cheapest first'}` })
          .setTimestamp();
        const tvLink = `[OpenSea](${l.url}) · [TraitView](${tvUrl})`;
        if(tokenTraits.length){
          embed.setDescription(traitDisplayLines(tokenTraits, 8).join('\n') + '\n\n**Links**\n' + tvLink);
        } else { embed.setDescription('**Links**\n' + tvLink); }
        try{ embed._imageResult = await resolveImage({ identifier: String(tokenId) }, contract, 'ethereum'); }catch(e){}
        return embed;
      }));
      const sortLabel = sortBy==='rank' ? 'best rank first' : 'cheapest first';
      await postEmbeds(interaction, rankEmbeds.filter(Boolean),
        `🏆 **OS Rank ⬥ #${rankMin}–#${rankMax}** — ${listings.length} listing${listings.length===1?'':'s'} (${sortLabel}):`);
    }catch(e){
      console.warn('[rankfind]', e.message);
      await interaction.editReply(`I could not load rank results from the TraitView API. ${e.message}`);
    }
    return;
  }


  if(commandName==='sweep'){
    const RAILWAY_URL = getRailwayApiUrl();
    const API_SECRET  = process.env.API_SECRET;
    const rawSearch   = (interaction.options.getString('search')||'').trim();
    console.log('[/sweep] RAILWAY_URL set:', !!RAILWAY_URL, 'search:', rawSearch);
    await interaction.deferReply();
    try{

      // ── Parse sweep mode ──────────────────────────────────────────────────
      let sweepMode   = 'count';
      let sweepCount  = 10;
      let budget      = null;
      let targetFloor = null;
      let workingSearch = rawSearch;

      // Budget mode: "2eth", "1eth zombie", "0.5eth zombie hoodie"
      const budgetMatch = workingSearch.match(/(?:^|\s)([\d.]+)\s*eth(?=\s|$)/i);
      if(budgetMatch){
        sweepMode = 'budget';
        budget = parseFloat(budgetMatch[1]);
        workingSearch = workingSearch.replace(budgetMatch[0], ' ').trim();
      }

      // Target-floor mode: "0.05 floor", "0.1 floor zombie"
      if(sweepMode === 'count'){
        const floorNumMatch = workingSearch.match(/(?:^|\s)([\d.]+)\s+floor(?=\s|$)/i);
        if(floorNumMatch){
          sweepMode   = 'floor';
          targetFloor = parseFloat(floorNumMatch[1]);
          workingSearch = workingSearch.replace(floorNumMatch[0], ' ').trim();
        } else {
          // Strip stray "floor" keyword if no number preceded it
          workingSearch = workingSearch.replace(/(?:^|\s)floor(?=\s|$)/gi, ' ').trim();
        }
      }

      // Count mode: extract standalone integer
      if(sweepMode === 'count'){
        const numMatch = workingSearch.match(/(?:^|\s)(\d+)(?=\s|$)/);
        if(numMatch){
          const n = parseInt(numMatch[1]);
          if(n > 0 && n <= 500){ sweepCount = n; workingSearch = workingSearch.replace(numMatch[0], ' ').trim(); }
        }
      }

      // ── Extract trait count e.g. "15 traits" ──────────────────────────────
      let traitCount = null;
      const tcMatch = workingSearch.match(/(?:trait\s*count\s*:?\s*(\d+)|(\d+)\s*traits?)/i);
      if(tcMatch){
        traitCount = parseInt(tcMatch[1] || tcMatch[2]);
        workingSearch = workingSearch.replace(tcMatch[0], ' ').trim();
      }

      // ── Simple depluralize ────────────────────────────────────────────────
      const PLURAL_OVERRIDES = {
        zombies: 'zombie', hoodies: 'hoodie', skeletons: 'skeleton',
        apes: 'ape', aliens: 'alien', robots: 'robot'
      };
      const SKIP_DEPLURAL = new Set(['teeth','tattoos','traits','clothes','glasses']);
      workingSearch = workingSearch.split(' ').map(w => {
        const lw = w.toLowerCase();
        if(PLURAL_OVERRIDES[lw]) return PLURAL_OVERRIDES[lw];
        if(SKIP_DEPLURAL.has(lw)) return w;
        if(lw.endsWith('ies') && lw.length > 4) return w.slice(0,-3)+'y';
        if(lw.endsWith('s') && lw.length > 3) return w.slice(0,-1);
        return w;
      }).join(' ').trim();

      // ── Phrase-aware trait matching ────────────────────────────────────────
      let matchedGroups = [];
      workingSearch = workingSearch.replace(/[,+]/g,' ').replace(/\b(and|with|plus)\b/gi,' ').replace(/\s+/g,' ').trim();

      if(workingSearch && RAILWAY_URL){
        const traitIndex = await getTraitIndex(RAILWAY_URL, API_SECRET);
        const resolved = chooseTraitGroupsFromQuery(workingSearch, traitIndex);
        matchedGroups = resolved.groups;
        if(resolved.unmatched.length && !matchedGroups.length){
          await interaction.editReply(`I couldn't match **"${workingSearch}"** to any known trait. Try: "zombie", "gold chain", "15 traits".`);
          return;
        }
        if(resolved.unmatched.length){
          await interaction.editReply(`I matched some traits but couldn't understand: **${resolved.unmatched.join(' ')}**. Try exact trait phrases.`);
          return;
        }
      }

      // ── Build label + title ────────────────────────────────────────────────
      const labelParts = matchedGroups.map(g => [...new Set(g.map(x => x.trait_value))][0]);
      if(traitCount !== null) labelParts.push(traitCount + ' traits');
      const traitLabel = labelParts.length ? labelParts.join(' · ') : 'OCAS';

      let modeTitle;
      if(sweepMode === 'budget') modeTitle = `Budget Sweep Ξ${budget} · ${traitLabel}`;
      else if(sweepMode === 'floor') modeTitle = `Floor Sweep Ξ${targetFloor} · ${traitLabel}`;
      else modeTitle = `Sweep ${sweepCount} · ${traitLabel}`;

      // ── Determine fetch limit ──────────────────────────────────────────────
      const fetchLimit = (sweepMode === 'count') ? sweepCount + 1 : 1000;

      // ── Fetch listings from DB ─────────────────────────────────────────────
      let allFetched = [];
      if(!matchedGroups.length && traitCount === null){
        console.log('[/sweep] plain sweep from DB, mode:', sweepMode);
        const dbRes = await pgPool.query(
          `SELECT l.token_id, l.price_eth, l.url, t.os_rank, t.obs_rank, t.trait_count
           FROM listings l
           LEFT JOIN tokens t ON t.id = l.token_id
           ORDER BY l.price_eth ASC
           LIMIT $1`,
          [fetchLimit]
        );
        allFetched = dbRes.rows.map(r => ({
          token_id: parseInt(r.token_id),
          price_eth: parseFloat(r.price_eth),
          url: r.url,
          os_rank: r.os_rank ? parseInt(r.os_rank) : null,
          obs_rank: r.obs_rank ? parseInt(r.obs_rank) : null,
          trait_count: r.trait_count ? parseInt(r.trait_count) : null
        }));
        console.log('[/sweep] plain sweep tokens returned:', allFetched.length);
      } else {
        if(!RAILWAY_URL) throw new Error('RAILWAY_API_URL is required for trait/count sweeps.');
        const qs = new URLSearchParams({ listed:'1', limit: String(fetchLimit), key: API_SECRET||'' });
        if(matchedGroups.length) qs.set('groups', JSON.stringify(matchedGroups));
        if(traitCount !== null) qs.set('trait_count', String(traitCount));
        console.log('[/sweep] fetching multi-trait-tokens, mode:', sweepMode, 'groups:', matchedGroups.length, 'traitCount:', traitCount);
        const r = await fetch(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`);
        console.log('[/sweep] response status:', r.status);
        if(!r.ok){ const txt = await r.text(); throw new Error('multi-trait-tokens HTTP ' + r.status + ': ' + txt.slice(0,200)); }
        const j = await r.json();
        console.log('[/sweep] tokens returned:', j.tokens?.length);
        if(!j.ok) throw new Error(j.error||'API error');
        allFetched = (j.tokens||[]).map(normalizeSweepListing).filter(t => t.token_id && t.price_eth != null);
      }

      if(!allFetched.length){
        await interaction.editReply('No listed tokens found for **' + traitLabel + '**.');
        return;
      }

      // ── Apply mode logic ───────────────────────────────────────────────────
      let sweepListings = [];
      let postSweepToken = null;
      const fmt = n => n.toFixed(4);

      if(sweepMode === 'budget'){
        let running = 0;
        for(const t of allFetched){
          if(running + t.price_eth <= budget){ sweepListings.push(t); running += t.price_eth; }
          else { postSweepToken = postSweepToken || t; break; }
        }
        if(!sweepListings.length){
          await interaction.editReply(`No listings fit within that budget of **Ξ${budget}** for **${traitLabel}**.\nCheapest available: Ξ${fmt(allFetched[0].price_eth)}`);
          return;
        }
      } else if(sweepMode === 'floor'){
        for(const t of allFetched){
          if(t.price_eth < targetFloor) sweepListings.push(t);
          else { postSweepToken = postSweepToken || t; break; }
        }
        if(!sweepListings.length){
          await interaction.editReply(`No listings below target floor of **Ξ${targetFloor}** for **${traitLabel}**.\nCheapest available: Ξ${fmt(allFetched[0].price_eth)}`);
          return;
        }
      } else {
        sweepListings  = allFetched.slice(0, sweepCount);
        postSweepToken = allFetched[sweepCount] || null;
      }

      // ── Compute stats ──────────────────────────────────────────────────────
      const available  = sweepListings.length;
      const short      = sweepMode === 'count' && available < sweepCount;
      const prices     = sweepListings.map(t => parseFloat(t.price_eth));
      const totalEth   = prices.reduce((a,b)=>a+b,0);
      const avgEth     = totalEth / prices.length;
      const cheapest   = prices[0];
      const highest    = prices[prices.length-1];
      const floorAfter = postSweepToken ? parseFloat(postSweepToken.price_eth) : null;

      // ── Build embed description ────────────────────────────────────────────
      let desc = '';
      if(sweepMode === 'budget'){
        const remaining = budget - totalEth;
        desc += `**Budget:** Ξ ${fmt(budget)}\n`;
        desc += `**Tokens swept:** ${available}\n`;
        desc += `**Total ETH:** Ξ ${fmt(totalEth)}\n`;
        desc += `**ETH left:** Ξ ${fmt(remaining)}\n`;
        desc += `**Average price:** Ξ ${fmt(avgEth)}\n`;
        desc += `**Cheapest included:** Ξ ${fmt(cheapest)}\n`;
        desc += `**Highest included:** Ξ ${fmt(highest)}\n`;
        if(floorAfter) desc += `**New floor after sweep:** Ξ ${fmt(floorAfter)}\n`;
      } else if(sweepMode === 'floor'){
        desc += `**Target floor:** Ξ ${targetFloor.toFixed(4)}\n`;
        desc += `**Tokens swept:** ${available}\n`;
        desc += `**Total ETH:** Ξ ${fmt(totalEth)}\n`;
        desc += `**Average price:** Ξ ${fmt(avgEth)}\n`;
        desc += `**Cheapest included:** Ξ ${fmt(cheapest)}\n`;
        desc += `**Highest included:** Ξ ${fmt(highest)}\n`;
        if(floorAfter) desc += `**New floor after sweep:** Ξ ${fmt(floorAfter)}\n`;
      } else {
        if(short) desc += '⚠️ Only ' + available + ' listed\n\n';
        desc += '**Total:** Ξ ' + fmt(totalEth) + '\n';
        desc += '**Average:** Ξ ' + fmt(avgEth) + '\n';
        desc += '**Cheapest:** Ξ ' + fmt(cheapest) + '\n';
        desc += '**Highest included:** Ξ ' + fmt(highest) + '\n';
        if(floorAfter) desc += '**New floor after sweep:** Ξ ' + fmt(floorAfter) + '\n';
      }

      const embed = new EmbedBuilder()
        .setTitle(modeTitle)
        .setColor(COLORS.OCAS_GREEN)
        .setDescription(desc.slice(0, 4090));

      // ── All tokens behind private Show All Tokens button ──────────────────
      const components = [];
      const sessionId = interaction.id;
      const cleanSweepListings = sweepListings.map(normalizeSweepListing).filter(t => t.token_id && t.price_eth != null);
      // Cap total concurrent sweep sessions to prevent unbounded memory growth
      if(sweepSessions.size >= 100){
        const oldest = sweepSessions.keys().next().value;
        sweepSessions.delete(oldest);
      }
      sweepSessions.set(sessionId, { listings: cleanSweepListings, page: 0 });
      setTimeout(() => sweepSessions.delete(sessionId), 30 * 60 * 1000);
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sweep:showall:' + sessionId).setLabel('Show All Tokens').setStyle(ButtonStyle.Secondary)
      ));

      await interaction.editReply({ embeds: [embed], components });

    }catch(e){
      console.error('[/sweep] ERROR:', e.message, e.stack);
      try{ await interaction.editReply('Error: ' + e.message); }catch(_){}
    }
    return;
  }

  // /burnlatest

  // /ocas — placeholder
}

const MARKET_COMMANDS = new Set([
  'lastsale','recentsales','sale','traitfind','listings','debuglisting',
  'myalert','myalertclear','myalertstatus','rankfind','sweep',
]);

module.exports = { handleMarketCommand, MARKET_COMMANDS };
