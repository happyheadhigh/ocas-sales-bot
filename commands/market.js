'use strict';

const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { OWNER_DISCORD_IDS } = require('../lib/constants');

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


// ── Paid tier check ────────────────────────────────────────────────────────────
function isPaidFeature(cfg, featureName, userId){
  if(userId && OWNER_DISCORD_IDS.has(String(userId))) return false;
  const isOcas = (cfg?.contract||cfg?.collectionSlug||cfg?.slug||'').toLowerCase().includes('on-chain-all-stars') ||
                 (cfg?.contract||'').toLowerCase() === '0x078be86f3104a32313a47815792230a3808642cc';
  if(isOcas) return false;
  return !(cfg?.isPaidTier === true);
}

function isOcasSlug(slug){
  return (slug||'').toLowerCase().includes('on-chain-all-stars');
}

// ── Smart collection resolver ──────────────────────────────────────────────────
function resolveCollectionFromServerCfg(serverCfg, collectionInput){
  if(!serverCfg) return null;
  const primary = {
    slug: serverCfg.collectionSlug || serverCfg.slug,
    contract: serverCfg.contract,
    name: serverCfg.contractName,
    channelId: serverCfg.channelId,
    listingsChannelId: serverCfg.listingsChannelId,
    listingFilters: serverCfg.listingFilters || {},
    isPaidTier: serverCfg.isPaidTier || false,
    _isPrimary: true,
  };
  const extras = (serverCfg.collections || []).map(c => ({...c, isPaidTier: serverCfg.isPaidTier || false}));
  const all = [primary, ...extras].filter(c => c.slug);

  if(!collectionInput) {
    return primary.slug ? primary : null;
  }

  const input = collectionInput.toLowerCase();
  return all.find(c =>
    (c.slug||'').toLowerCase() === input ||
    (c.name||'').toLowerCase() === input
  ) || primary;
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
    const colInput = interaction.options.getString('collection') || null;
    const resolved = resolveCollectionFromServerCfg(config, colInput);
    const slug = resolved?.slug || config.slug;
    const activeConfig = resolved ? {...config, ...resolved} : config;
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=1`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply('No sales found.');return;}
      const embed=await buildSaleEmbed(sales[0],activeConfig);
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
    if(!contract) return interaction.reply({content:'Set a collection contract in `/config` → Collections.', flags: MessageFlags.Ephemeral});
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

  // /traitfind
  if(commandName==='traitfind'){
    const _tfCool = checkCommandCooldown(interaction.user.id, 'traitfind');
    if(_tfCool) return interaction.reply({content:`⏳ Please wait **${_tfCool}s** before using this command again.`, flags:MessageFlags.Ephemeral});
    const _tfColInput = interaction.options.getString('collection') || null;
    const _tfResolved = resolveCollectionFromServerCfg(config, _tfColInput);
    const slug       = _tfResolved?.slug || config.collectionSlug || config.slug;
    const traitOpt   = (interaction.options.getString('trait') || '').trim();
    const valueOpt   = (interaction.options.getString('value') || '').trim();
    const modeOpt    = interaction.options.getString('mode') || 'tokens';
    const want       = Math.min(interaction.options.getInteger('count') || 20, 50);
    const RAILWAY_URL = getRailwayApiUrl();
    const API_SECRET  = process.env.API_SECRET;

    const wantListings = modeOpt === 'listings';
    const wantSales    = modeOpt === 'sales';

    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});

    // No args — launch guided select menu wizard
    if(!traitOpt && !valueOpt){
      const allCols = [];
      const primarySlug = config.collectionSlug || config.slug;
      if(primarySlug) allCols.push({ slug: primarySlug, name: config.contractName || primarySlug });
      for(const c of config.collections || []) { if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }
      if(!allCols.length) return interaction.reply({ content: 'Run `/setup` first to configure a collection.', flags: MessageFlags.Ephemeral });
      if(allCols.length === 1){
        return showTfTraitPicker(interaction, ctx, allCols[0].slug);
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId('tf_browse:col')
        .setPlaceholder('Pick a collection...')
        .addOptions(allCols.slice(0, 25).map(c =>
          new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug)
        ));
      return interaction.reply({
        content: '**🔍 Trait Find** — Pick a collection to search:',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if(!RAILWAY_URL) return interaction.reply({content:'Trait search needs the internal TraitView API URL. Set `RAILWAY_API_URL` in this Railway service.', flags: MessageFlags.Ephemeral});

    const groups = [[{ trait_name: traitOpt || '_any', trait_value: valueOpt }]];
    const matchLabel = traitOpt && valueOpt ? `${traitOpt}: ${valueOpt}` : (valueOpt || traitOpt);

    await interaction.deferReply();
    const cfg = _tfResolved ? {...config, ..._tfResolved} : {...config, slug};

    try{
      if(wantSales){
        await interaction.editReply(`🔍 Searching **${matchLabel}** in full sales history...`);
        const qs = new URLSearchParams({ trait: traitOpt, value: valueOpt, limit: String(Math.min(want, 200)), sort: 'desc' });
        if(API_SECRET) qs.set('key', API_SECRET);
        const j = await fetchBotApiJson(`${RAILWAY_URL}/db/trait-sales?${qs}`, '/db/trait-sales API');
        const sales = j.sales || [];
        if(!sales.length){ await interaction.editReply(`No sales found for **${matchLabel}**.`); return; }
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
          `Found **${j.count}** sale${j.count===1?'':'s'} with **${matchLabel}**${totalNote}:`);
        return;
      }

      const listedOnly = wantListings;
      await interaction.editReply(`Searching ${listedOnly ? 'listed tokens' : 'tokens'} matching **${matchLabel}**...`);
      const qs = new URLSearchParams({ limit: String(want), key: API_SECRET||'', slug });
      qs.set('groups', JSON.stringify(groups));
      if(listedOnly) qs.set('listed', '1');
      const label = listedOnly ? '/db/multi-trait-tokens listings API' : '/db/multi-trait-tokens token API';
      const j = await fetchBotApiJson(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`, label);
      const tokens = j.tokens || [];
      if(!tokens.length){
        await interaction.editReply(`No ${listedOnly ? 'active listings' : 'tokens'} found matching **${matchLabel}**.`);
        return;
      }
      const embeds = await Promise.all(tokens.map(async t => {
        const tokenId = t.token_id ?? t.id ?? t.identifier;
        if(listedOnly){
          const priceWei = t.price_eth != null ? String(BigInt(Math.round(t.price_eth * 1e18))) : '0';
          const scopedDbToken = { traits: t.traits || {}, obs_rank: t.obs_rank || null, os_rank: t.os_rank || null };
          const fakeListingObj = {
            token_id: tokenId,
            asset: { token_id: String(tokenId), identifier: String(tokenId), name: '#'+tokenId,
                     traits: t.traits?.__attributes || [] },
            payment: { quantity: priceWei, decimals: 18, symbol: 'ETH', token_address: '' },
            maker: t.seller || '',
            url: t.url || null,
            os_rank: t.os_rank || null,
            _dbToken: scopedDbToken,
          };
          return buildListingEmbed(fakeListingObj, cfg).catch(()=>null);
        }
        const dbMeta = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
        return buildTokenSearchEmbed({...t, _dbToken: dbMeta}, cfg, `Trait Search - ${matchLabel}`).catch(()=>null);
      }));
      await postEmbeds(interaction, embeds.filter(Boolean),
        `Found **${tokens.length}** ${listedOnly ? 'listing' : 'token'}${tokens.length===1?'':'s'} matching **${matchLabel}**${listedOnly ? ' (cheapest first)' : ''}:`);
      return;

    }catch(e){
      console.warn('[traitfind]', e.message);
      await interaction.editReply(`I could not load trait results from the TraitView API. ${e.message}`);
    }
    return;
  }

  // /listings
  if(commandName==='listings'){
    const colInput2 = interaction.options.getString('collection') || null;
    const resolved2 = resolveCollectionFromServerCfg(config, colInput2);
    const activeConfig2 = resolved2 ? {...config, ...resolved2} : config;
    if(isPaidFeature(activeConfig2, 'listings', interaction.user.id))
      return interaction.reply({content:'📋 Listing commands require a paid tier for non-OCAS collections. Visit traitview.com to upgrade.', flags: MessageFlags.Ephemeral});
    const colSlug = resolved2?.slug || config.slug;
    const count=Math.min(interaction.options.getInteger('count')||5,20);
    if(!colSlug) return interaction.reply({content:'Run `/setup` first or provide a collection.', flags: MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(colSlug)}?event_type=listing&limit=${count}`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const listings=(await r.json()).asset_events||[];
      if(!listings.length){await interaction.editReply('No listings found.');return;}
      const cfg={...config,slug:colSlug};
      const embeds=await Promise.all(listings.reverse().map(l=>buildListingEmbed(l,cfg).catch(()=>null)));
      await postEmbeds(interaction, embeds.filter(Boolean), `${listings.length} recent listings for **${colSlug}**:`);
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /debuglisting
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
    const alertColInput = interaction.options.getString('collection') || null;
    const alertResolved = resolveCollectionFromServerCfg(config, alertColInput);
    const alertConfig = alertResolved ? {...config, ...alertResolved} : config;
    if(isPaidFeature(alertConfig, 'myalert', interaction.user.id))
      return interaction.reply({content:'🔔 Personal alerts require a paid tier for non-OCAS collections. Visit traitview.com to upgrade.', flags: MessageFlags.Ephemeral});
    const trait=interaction.options.getString('trait')?.toLowerCase().trim();
    const value=interaction.options.getString('value')?.toLowerCase().trim();
    const alertSales=interaction.options.getBoolean('sales')??true;
    const alertListings=interaction.options.getBoolean('listings')??false;
    const slug=interaction.options.getString('collection')||config.slug;
    if(!slug) return interaction.reply({content:'Provide a collection or run `/setup` in a configured server first.', flags: MessageFlags.Ephemeral});

    // No args — launch guided wizard
    if(!trait && !value && !interaction.options.getBoolean('sales') && !interaction.options.getBoolean('listings') && !alertColInput){
      const allCols = [];
      const primarySlug = config.collectionSlug || config.slug;
      if(primarySlug) allCols.push({ slug: primarySlug, name: config.contractName || primarySlug });
      for(const c of config.collections || []) { if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }
      if(!allCols.length) return interaction.reply({ content: 'Run `/setup` first to configure a collection.', flags: MessageFlags.Ephemeral });
      if(allCols.length === 1){
        return showMaTraitPicker(interaction, ctx, allCols[0].slug);
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId('ma_browse:col')
        .setPlaceholder('Pick a collection...')
        .addOptions(allCols.slice(0,25).map(c =>
          new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug)
        ));
      return interaction.reply({
        content: '**🔔 My Alert** — Pick a collection:',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
    }

    const existing=getAlert(interaction.user.id)||{};
    const filters={...(existing.traitFilters||{})};

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
      return;
    }
    return showMaClearWizard(interaction, { getAlert, deleteAlert, setAlert });
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

  // /rankfind
  if(commandName==='rankfind'){
    if(isPaidFeature(config, 'rankfind', interaction.user.id))
      return interaction.reply({content:'📊 Rank search requires a paid tier for non-OCAS collections. Visit traitview.com to upgrade.', flags: MessageFlags.Ephemeral});
    const _rfCool = checkCommandCooldown(interaction.user.id, 'rankfind');
    if(_rfCool) return interaction.reply({content:`⏳ Please wait **${_rfCool}s** before using this command again.`, flags:MessageFlags.Ephemeral});
    const RAILWAY_URL = getRailwayApiUrl();
    const API_SECRET  = process.env.API_SECRET;
    const rankMin  = interaction.options.getInteger('min_rank') || 1;
    const rankMax  = interaction.options.getInteger('max_rank') || 100;
    const modeRf   = interaction.options.getString('mode') || 'listings';
    const sortBy   = interaction.options.getString('sort') || 'price';
    const wantSales    = modeRf === 'sales';
    const wantListings = !wantSales;
    const _rfColInput  = interaction.options.getString('collection') || null;
    const _rfResolved  = resolveCollectionFromServerCfg(config, _rfColInput);
    const rfSlug       = _rfResolved?.slug || config.collectionSlug || config.slug;

    if(!RAILWAY_URL) return interaction.reply({ content: 'RAILWAY_API_URL not configured.', flags: MessageFlags.Ephemeral });
    if(rankMin < 1 || rankMax > 10000 || rankMin > rankMax) return interaction.reply({ content: 'Invalid rank range. min_rank must be ≤ max_rank and within 1–10000.', flags: MessageFlags.Ephemeral });

    await interaction.deferReply();
    const contract = (_rfResolved?.contract || config.contract || '');
    try{
      if(wantSales){
        const qs = new URLSearchParams({ rank_min: rankMin, rank_max: rankMax, limit: '20', sort: 'desc' });
        if(API_SECRET) qs.set('key', API_SECRET);
        const j = await fetchBotApiJson(`${RAILWAY_URL}/db/rank-sales?${qs}`, '/db/rank-sales API');
        const sales = j.sales || [];
        if(!sales.length){ await interaction.editReply(`No sales found for OS rank **⬥ #${rankMin}–#${rankMax}**.`); return; }
        const cfg = _rfResolved ? {...config, ..._rfResolved} : {...config, slug: rfSlug};
        const saleEmbeds = await Promise.all(sales.map(async sale => {
          const tokenTraits = sale.traits && typeof sale.traits==='object' ? traitObjectToArray(sale.traits) : [];
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
    const sweepColInput = interaction.options.getString('collection') || null;
    const sweepResolved = resolveCollectionFromServerCfg(config, sweepColInput);
    const sweepConfig = sweepResolved ? {...config, ...sweepResolved} : config;
    if(isPaidFeature(sweepConfig, 'sweep', interaction.user.id))
      return interaction.reply({content:'🧹 Sweep commands require a paid tier for non-OCAS collections. Visit traitview.com to upgrade.', flags: MessageFlags.Ephemeral});
    const RAILWAY_URL = getRailwayApiUrl();
    const API_SECRET  = process.env.API_SECRET;
    const rawSearch   = (interaction.options.getString('search')||'').trim();
    console.log('[/sweep] RAILWAY_URL set:', !!RAILWAY_URL, 'search:', rawSearch);
    await interaction.deferReply();
    try{
      let sweepMode   = 'count';
      let sweepCount  = 10;
      let budget      = null;
      let targetFloor = null;
      let workingSearch = rawSearch;

      const budgetMatch = workingSearch.match(/(?:^|\s)([\d.]+)\s*eth(?=\s|$)/i);
      if(budgetMatch){
        sweepMode = 'budget';
        budget = parseFloat(budgetMatch[1]);
        workingSearch = workingSearch.replace(budgetMatch[0], ' ').trim();
      }

      if(sweepMode === 'count'){
        const floorNumMatch = workingSearch.match(/(?:^|\s)([\d.]+)\s+floor(?=\s|$)/i);
        if(floorNumMatch){
          sweepMode   = 'floor';
          targetFloor = parseFloat(floorNumMatch[1]);
          workingSearch = workingSearch.replace(floorNumMatch[0], ' ').trim();
        } else {
          workingSearch = workingSearch.replace(/(?:^|\s)floor(?=\s|$)/gi, ' ').trim();
        }
      }

      if(sweepMode === 'count'){
        const numMatch = workingSearch.match(/(?:^|\s)(\d+)(?=\s|$)/);
        if(numMatch){
          const n = parseInt(numMatch[1]);
          if(n > 0 && n <= 500){ sweepCount = n; workingSearch = workingSearch.replace(numMatch[0], ' ').trim(); }
        }
      }

      let traitCount = null;
      const tcMatch = workingSearch.match(/(?:trait\s*count\s*:?\s*(\d+)|(\d+)\s*traits?)/i);
      if(tcMatch){
        traitCount = parseInt(tcMatch[1] || tcMatch[2]);
        workingSearch = workingSearch.replace(tcMatch[0], ' ').trim();
      }

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

      const labelParts = matchedGroups.map(g => [...new Set(g.map(x => x.trait_value))][0]);
      if(traitCount !== null) labelParts.push(traitCount + ' traits');
      const traitLabel = labelParts.length ? labelParts.join(' · ') : 'OCAS';

      let modeTitle;
      if(sweepMode === 'budget') modeTitle = `Budget Sweep Ξ${budget} · ${traitLabel}`;
      else if(sweepMode === 'floor') modeTitle = `Floor Sweep Ξ${targetFloor} · ${traitLabel}`;
      else modeTitle = `Sweep ${sweepCount} · ${traitLabel}`;

      const fetchLimit = (sweepMode === 'count') ? sweepCount + 1 : 1000;

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

      const available  = sweepListings.length;
      const short      = sweepMode === 'count' && available < sweepCount;
      const prices     = sweepListings.map(t => parseFloat(t.price_eth));
      const totalEth   = prices.reduce((a,b)=>a+b,0);
      const avgEth     = totalEth / prices.length;
      const cheapest   = prices[0];
      const highest    = prices[prices.length-1];
      const floorAfter = postSweepToken ? parseFloat(postSweepToken.price_eth) : null;

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

      const components = [];
      const sessionId = interaction.id;
      const cleanSweepListings = sweepListings.map(normalizeSweepListing).filter(t => t.token_id && t.price_eth != null);
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

  // /me — personal hub
  if(commandName==='me'){
    return showMeHub(interaction, ctx);
  }

  // /burnlatest

  // /ocas — placeholder
}

const MARKET_COMMANDS = new Set([
  'lastsale','recentsales','sale','traitfind','listings','debuglisting',
  'myalert','myalertclear','myalertstatus','rankfind','sweep','me',
]);

// ── /traitfind guided flow helpers ───────────────────────────────────────────
async function showTfTraitPicker(interaction, ctx, slug){
  const { getRailwayApiUrl, getCachedTraitIndex } = ctx;
  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET = process.env.API_SECRET;
  let traitIndex = [];
  try { traitIndex = await getCachedTraitIndex(RAILWAY_URL, API_SECRET, slug); } catch(e){}
  const traitNames = [...new Set(traitIndex.map(t => t.trait_name))].slice(0, 25);
  if(!traitNames.length){
    const replyFn = interaction.replied || interaction.deferred ? 'editReply' : 'reply';
    return interaction[replyFn]({ content: `No trait data found for **${slug}** yet. Make sure the collection is added via \`/config\`.`, flags: MessageFlags.Ephemeral });
  }
  const traitValueCounts = {};
  for(const t of traitIndex){
    if(!traitValueCounts[t.trait_name]) traitValueCounts[t.trait_name] = 0;
    traitValueCounts[t.trait_name]++;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tf_browse:trait:${slug}`)
    .setPlaceholder('Pick a trait category...')
    .addOptions(traitNames.map(n => new StringSelectMenuOptionBuilder()
      .setLabel(n)
      .setValue(n)
      .setDescription(`${traitValueCounts[n] || 0} value${traitValueCounts[n]===1?'':'s'}`)
    ));
  const replyFn = interaction.replied || interaction.deferred ? 'editReply' : 'reply';
  return interaction[replyFn]({
    content: `**🔍 Trait Find — ${slug}**\n\nPick a trait category:`,
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function showTfValuePicker(interaction, ctx, slug, traitName){
  const { getRailwayApiUrl, getCachedTraitIndex } = ctx;
  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET = process.env.API_SECRET;
  let traitIndex = [];
  try { traitIndex = await getCachedTraitIndex(RAILWAY_URL, API_SECRET, slug); } catch(e){}
  const matchingRows = traitIndex.filter(t => t.trait_name === traitName);
  const valueRows = matchingRows.slice(0, 25);
  if(!valueRows.length){
    return interaction.update({ content: `No values found for **${traitName}**.`, components: [] });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tf_browse:val:${slug}:${traitName}`)
    .setPlaceholder(`Pick a ${traitName} value...`)
    .addOptions(valueRows.map(r => new StringSelectMenuOptionBuilder()
      .setLabel(r.trait_value)
      .setValue(r.trait_value)
      .setDescription(`${r.token_count} token${r.token_count===1?'':'s'}`)
    ));
  return interaction.update({
    content: `**🔍 Trait Find — ${slug} › ${traitName}**\n\nPick a value:`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function showTfModePicker(interaction, ctx, slug, traitName, traitValue){
  const { getRailwayApiUrl, fetchBotApiJson } = ctx;
  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET = process.env.API_SECRET;
  let tokenCount = '?', listingCount = '?', salesCount = '?';
  try {
    const qs = new URLSearchParams({ slug, key: API_SECRET||'' });
    qs.set('groups', JSON.stringify([[{ trait_name: traitName, trait_value: traitValue }]]));
    const [tokRes, lstRes, salRes] = await Promise.all([
      fetchBotApiJson(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`, 'mode-count-tokens').catch(()=>null),
      fetchBotApiJson(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}&listed=1`, 'mode-count-listed').catch(()=>null),
      fetchBotApiJson(`${RAILWAY_URL}/db/trait-sales?${new URLSearchParams({ trait: traitName, value: traitValue, limit:'1', key: API_SECRET||'' })}`, 'mode-count-sales').catch(()=>null),
    ]);
    if(tokRes?.tokens) tokenCount = tokRes.tokens.length >= 20 ? '20+' : String(tokRes.tokens.length);
    if(lstRes?.tokens) listingCount = String(lstRes.tokens.length);
    if(salRes?.count != null) salesCount = String(salRes.count);
  } catch(e) {}
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tf_browse:mode:${slug}:${traitName}:${traitValue}`)
    .setPlaceholder('What do you want to see?')
    .addOptions([
      new StringSelectMenuOptionBuilder().setLabel('Tokens').setDescription(`${tokenCount} token${tokenCount==='1'?'':'s'} with this trait`).setValue('tokens'),
      new StringSelectMenuOptionBuilder().setLabel('Listings').setDescription(`${listingCount} listed — cheapest first`).setValue('listings'),
      new StringSelectMenuOptionBuilder().setLabel('Sales').setDescription(`${salesCount} sale${salesCount==='1'?'':'s'} in history`).setValue('sales'),
    ]);
  return interaction.update({
    content: `**🔍 Trait Find — ${slug} › ${traitName}: ${traitValue}**\n\nWhat would you like to see?`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

// ── /traitfind browse flow — select menu follow-ups ───────────────────────────
async function handleTraitBrowseInteraction(interaction, ctx){
  const { pgPool, getConfig, getRailwayApiUrl, getCachedTraitIndex,
          buildSaleEmbed, buildListingEmbed, postEmbeds, fetchBotApiJson,
          buildTokenSearchEmbed, fetchTokenMetaFromDb, traitObjectToArray } = ctx;
  const customId = interaction.customId;

  if(customId === 'tf_browse:col'){
    const slug = interaction.values[0];
    return showTfTraitPicker(interaction, ctx, slug);
  }

  if(customId.startsWith('tf_browse:trait:')){
    const slug = customId.slice('tf_browse:trait:'.length);
    const traitName = interaction.values[0];
    return showTfValuePicker(interaction, ctx, slug, traitName);
  }

  if(customId.startsWith('tf_browse:val:')){
    const parts = customId.slice('tf_browse:val:'.length).split(':');
    const slug = parts[0];
    const traitName = parts.slice(1).join(':');
    const traitValue = interaction.values[0];
    return showTfModePicker(interaction, ctx, slug, traitName, traitValue);
  }

  if(customId.startsWith('tf_browse:mode:')){
    const parts = customId.slice('tf_browse:mode:'.length).split(':');
    const slug = parts[0];
    const traitName = parts[1];
    const traitValue = parts.slice(2).join(':');
    const mode = interaction.values[0];

    await interaction.update({ content: `🔍 Searching **${traitName}: ${traitValue}** in **${slug}** (${mode})...`, components: [] });

    const guildId = interaction.guildId;
    const config = getConfig(guildId) || {};
    const RAILWAY_URL = getRailwayApiUrl();
    const API_SECRET = process.env.API_SECRET;
    const _resolved = resolveCollectionFromServerCfg(config, slug);
    const cfg = _resolved ? { ...config, ..._resolved } : { ...config, slug };
    const want = 20;
    const groups = [[{ trait_name: traitName, trait_value: traitValue }]];
    const matchLabel = `${traitName}: ${traitValue}`;

    try {
      if(mode === 'sales'){
        const qs = new URLSearchParams({ trait: traitName, value: traitValue, limit: '20', sort: 'desc' });
        if(API_SECRET) qs.set('key', API_SECRET);
        const j = await fetchBotApiJson(`${RAILWAY_URL}/db/trait-sales?${qs}`, '/db/trait-sales');
        const sales = j.sales || [];
        if(!sales.length){ await interaction.editReply({ content: `No sales found for **${matchLabel}**.`, components:[] }); return; }
        const saleEmbeds = await Promise.all(sales.slice(0,want).map(async sale => {
          const dbMeta = await fetchTokenMetaFromDb(sale.token_id).catch(()=>null);
          const tokenTraits = dbMeta?.traits ? traitObjectToArray(dbMeta.traits) : [];
          const syntheticSale = {
            nft: { identifier: String(sale.token_id), name: `#${sale.token_id}`, traits: tokenTraits },
            buyer: sale.buyer||'unknown', seller: sale.seller||'unknown',
            payment: { symbol: 'ETH', token_address: '', quantity: sale.price_eth!=null?String(BigInt(Math.round(sale.price_eth*1e18))):'0', decimals:18 },
            event_timestamp: sale.sale_ts ? Math.floor(new Date(sale.sale_ts).getTime()/1000) : null,
          };
          return buildSaleEmbed(syntheticSale, cfg).catch(()=>null);
        }));
        await postEmbeds(interaction, saleEmbeds.filter(Boolean), `Found **${j.count}** sale${j.count===1?'':'s'} with **${matchLabel}**:`);
        return;
      }

      const listedOnly = mode === 'listings';
      const qs = new URLSearchParams({ limit: String(want), key: API_SECRET||'', slug });
      qs.set('groups', JSON.stringify(groups));
      if(listedOnly) qs.set('listed', '1');
      const j = await fetchBotApiJson(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`, '/db/multi-trait-tokens');
      const tokens = j.tokens || [];
      if(!tokens.length){ await interaction.editReply({ content: `No ${listedOnly?'listings':'tokens'} found for **${matchLabel}**.`, components:[] }); return; }
      const embeds = await Promise.all(tokens.map(async t => {
        const tokenId = t.token_id ?? t.id ?? t.identifier;
        if(listedOnly){
          const priceWei = t.price_eth!=null ? String(BigInt(Math.round(t.price_eth*1e18))) : '0';
          const fakeListingObj = {
            token_id: tokenId,
            asset: { token_id: String(tokenId), identifier: String(tokenId), name:'#'+tokenId, traits: t.traits?.__attributes||[] },
            payment: { quantity: priceWei, decimals:18, symbol:'ETH', token_address:'' },
            maker: t.seller||'', url: t.url||null, os_rank: t.os_rank||null,
            _dbToken: { traits: t.traits||{}, obs_rank: t.obs_rank||null, os_rank: t.os_rank||null },
          };
          return buildListingEmbed(fakeListingObj, cfg).catch(()=>null);
        }
        const dbMeta = await fetchTokenMetaFromDb(tokenId).catch(()=>null);
        return buildTokenSearchEmbed({...t, _dbToken: dbMeta}, cfg, `Trait Search - ${matchLabel}`).catch(()=>null);
      }));
      await postEmbeds(interaction, embeds.filter(Boolean),
        `Found **${tokens.length}** ${listedOnly?'listing':'token'}${tokens.length===1?'':'s'} matching **${matchLabel}**${listedOnly?' (cheapest first)':''}:`);
    } catch(e) {
      console.warn('[tf_browse:mode]', e.message);
      await interaction.editReply({ content: `Search failed: ${e.message}`, components:[] });
    }
    return;
  }
}

// ── /myalert guided flow helpers ─────────────────────────────────────────────
async function showMaTraitPicker(interaction, ctx, slug){
  const { getRailwayApiUrl, getCachedTraitIndex } = ctx;
  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET = process.env.API_SECRET;
  let traitIndex = [];
  try { traitIndex = await getCachedTraitIndex(RAILWAY_URL, API_SECRET, slug); } catch(e){}
  const traitNames = [...new Set(traitIndex.map(t => t.trait_name))].slice(0, 25);
  if(!traitNames.length){
    const replyFn = interaction.replied || interaction.deferred ? 'editReply' : 'reply';
    return interaction[replyFn]({ content: `No trait data found for **${slug}** yet.`, flags: MessageFlags.Ephemeral });
  }
  const traitValueCounts = {};
  for(const t of traitIndex){ if(!traitValueCounts[t.trait_name]) traitValueCounts[t.trait_name]=0; traitValueCounts[t.trait_name]++; }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ma_browse:trait:${slug}`)
    .setPlaceholder('Pick a trait to filter by...')
    .addOptions(traitNames.map(n => new StringSelectMenuOptionBuilder()
      .setLabel(n).setValue(n)
      .setDescription(`${traitValueCounts[n]||0} value${traitValueCounts[n]===1?'':'s'}`)
    ));
  const replyFn = interaction.replied || interaction.deferred ? 'editReply' : 'reply';
  return interaction[replyFn]({
    content: `**🔔 My Alert — ${slug}**\n\nPick a trait to filter by (or skip to alert on all tokens):`,
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ma_browse:skiptr:${slug}`).setLabel('Skip — alert on all traits').setStyle(ButtonStyle.Secondary)
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function showMaValuePicker(interaction, ctx, slug, traitName){
  const { getRailwayApiUrl, getCachedTraitIndex } = ctx;
  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET = process.env.API_SECRET;
  let traitIndex = [];
  try { traitIndex = await getCachedTraitIndex(RAILWAY_URL, API_SECRET, slug); } catch(e){}
  const valueRows = traitIndex.filter(t => t.trait_name === traitName).slice(0, 25);
  if(!valueRows.length){
    return interaction.update({ content: `No values found for **${traitName}**.`, components: [] });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ma_browse:val:${slug}:${traitName}`)
    .setPlaceholder(`Pick ${traitName} value(s)...`)
    .setMinValues(1)
    .setMaxValues(Math.min(valueRows.length, 25))
    .addOptions(valueRows.map(r => new StringSelectMenuOptionBuilder()
      .setLabel(r.trait_value).setValue(r.trait_value)
      .setDescription(`${r.token_count} token${r.token_count===1?'':'s'}`)
    ));
  return interaction.update({
    content: `**🔔 My Alert — ${slug} › ${traitName}**\n\nPick one or more values (hold/tap to multi-select):`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function showMaTypePicker(interaction, slug, traitName, traitValues){
  const valEncoded = (traitValues || []).join('|');
  const traitEncoded = traitName || '';
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ma_browse:type:${slug}:${traitEncoded}:${valEncoded}`)
    .setPlaceholder('What should trigger a DM?')
    .setMinValues(1)
    .setMaxValues(2)
    .addOptions([
      new StringSelectMenuOptionBuilder().setLabel('Sales').setDescription('DM me when a matching token sells').setValue('sales'),
      new StringSelectMenuOptionBuilder().setLabel('Listings').setDescription('DM me when a matching token is listed').setValue('listings'),
    ]);
  const filterSummary = traitName
    ? `**${traitName}:** ${(traitValues||[]).join(', ')}`
    : 'All tokens (no trait filter)';
  return interaction.update({
    content: `**🔔 My Alert — ${slug}**\n\nFilter: ${filterSummary}\n\nWhat should trigger a DM?`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function showMaConfirm(interaction, ctx, slug, traitName, traitValues, alertTypes){
  const { getAlert } = ctx;
  const existing = getAlert(interaction.user.id) || {};
  const existingFilters = existing.traitFilters || {};
  const previewFilters = { ...existingFilters };
  if(traitName && traitValues && traitValues.length){
    const current = previewFilters[traitName];
    const existing_arr = current ? (Array.isArray(current) ? current : [current]) : [];
    const merged = [...new Set([...existing_arr, ...traitValues])];
    previewFilters[traitName] = merged.length === 1 ? merged[0] : merged;
  }
  const alertSales = alertTypes.includes('sales');
  const alertListings = alertTypes.includes('listings');
  const fmtF = f => Object.keys(f||{}).length===0 ? 'none (all tokens)' :
    Object.entries(f).map(([k,v]) => `**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join('\n');
  const valEncoded = (traitValues||[]).join('|');
  const traitEncoded = traitName || '';
  const typeEncoded = alertTypes.join('|');
  const embed = new EmbedBuilder()
    .setTitle('🔔 Confirm Alert')
    .setColor(0x5865F2)
    .setDescription([
      `**Collection:** ${slug}`,
      `**Sales DMs:** ${alertSales ? '✅ on' : '❌ off'}`,
      `**Listing DMs:** ${alertListings ? '✅ on' : '❌ off'}`,
      `**Filters after save:**`,
      fmtF(previewFilters),
    ].join('\n'));
  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ma_browse:confirm:${slug}:${traitEncoded}:${valEncoded}:${typeEncoded}`)
      .setLabel('Set Alert').setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ma_browse:cancel')
      .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return interaction.update({ content: '', embeds: [embed], components: [confirmRow] });
}

// ── /myalert wizard — select menu + button follow-ups ────────────────────────
async function handleMyAlertInteraction(interaction, ctx){
  const { getAlert, setAlert } = ctx;
  const customId = interaction.customId;

  if(customId === 'ma_browse:col'){
    const slug = interaction.values[0];
    return showMaTraitPicker(interaction, ctx, slug);
  }
  if(customId.startsWith('ma_browse:trait:')){
    const slug = customId.slice('ma_browse:trait:'.length);
    const traitName = interaction.values[0];
    return showMaValuePicker(interaction, ctx, slug, traitName);
  }
  if(customId.startsWith('ma_browse:skiptr:')){
    const slug = customId.slice('ma_browse:skiptr:'.length);
    return showMaTypePicker(interaction, slug, null, null);
  }
  if(customId.startsWith('ma_browse:val:')){
    const parts = customId.slice('ma_browse:val:'.length).split(':');
    const slug = parts[0];
    const traitName = parts.slice(1).join(':');
    const traitValues = interaction.values;
    return showMaTypePicker(interaction, slug, traitName, traitValues);
  }
  if(customId.startsWith('ma_browse:type:')){
    const parts = customId.slice('ma_browse:type:'.length).split(':');
    const slug = parts[0];
    const traitName = parts[1] || null;
    const valEncoded = parts.slice(2).join(':');
    const traitValues = valEncoded ? valEncoded.split('|').filter(Boolean) : [];
    const alertTypes = interaction.values;
    return showMaConfirm(interaction, ctx, slug, traitName, traitValues, alertTypes);
  }
  if(customId.startsWith('ma_browse:confirm:')){
    const parts = customId.slice('ma_browse:confirm:'.length).split(':');
    const slug = parts[0];
    const traitName = parts[1] || null;
    const valEncoded = parts[2] || '';
    const typeEncoded = parts[3] || 'sales';
    const traitValues = valEncoded ? valEncoded.split('|').filter(Boolean) : [];
    const alertTypes = typeEncoded.split('|').filter(Boolean);
    const alertSales = alertTypes.includes('sales');
    const alertListings = alertTypes.includes('listings');
    const existing = getAlert(interaction.user.id) || {};
    const filters = { ...(existing.traitFilters || {}) };
    if(traitName && traitValues.length){
      const current = filters[traitName];
      const existing_arr = current ? (Array.isArray(current) ? current : [current]) : [];
      const merged = [...new Set([...existing_arr, ...traitValues])];
      filters[traitName] = merged.length === 1 ? merged[0] : merged;
    }
    setAlert(interaction.user.id, { slug, traitFilters: filters, alertSales, alertListings });
    const fmtF = f => Object.keys(f||{}).length===0 ? 'none (all tokens)' :
      Object.entries(f).map(([k,v]) => `**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join('\n');
    const embed = new EmbedBuilder()
      .setTitle('✅ Alert Set!')
      .setColor(0x57F287)
      .setDescription([
        `**Collection:** ${slug}`,
        `**Sales DMs:** ${alertSales ? '✅ on' : '❌ off'}`,
        `**Listing DMs:** ${alertListings ? '✅ on' : '❌ off'}`,
        `**Filters:**`,
        fmtF(filters),
        '',
        'Use `/myalert` again to add more filters.',
        'Use `/myalertclear` to remove your alert.',
      ].join('\n'));
    return interaction.update({ content: '', embeds: [embed], components: [] });
  }
  if(customId === 'ma_browse:cancel'){
    return interaction.update({ content: 'Alert wizard cancelled.', embeds: [], components: [] });
  }
}


// ── /myalertclear wizard ─────────────────────────────────────────────────────
async function showMaClearWizard(interaction, ctx){
  const { getAlert } = ctx;
  const alert = getAlert(interaction.user.id);
  if(!alert || (!Object.keys(alert.traitFilters||{}).length && !alert.slug)){
    return interaction.reply({ content: 'You have no alert set. Use `/myalert` to create one.', flags: MessageFlags.Ephemeral });
  }
  const filters = alert.traitFilters || {};
  const fmtF = f => Object.keys(f).length===0 ? 'none (all tokens)' :
    Object.entries(f).map(([k,v]) => `**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join('\n');
  const embed = new EmbedBuilder()
    .setTitle('🔔 My Alert')
    .setColor(0x5865F2)
    .setDescription([
      `**Collection:** ${alert.slug||'any'}`,
      `**Sales DMs:** ${alert.alertSales ? '✅ on' : '❌ off'}`,
      `**Listing DMs:** ${alert.alertListings ? '✅ on' : '❌ off'}`,
      `**Filters:**`,
      fmtF(filters),
    ].join('\n'));
  const rows = [];
  const traitKeys = Object.keys(filters);
  if(traitKeys.length){
    const traitBtns = traitKeys.slice(0, 8).map(k =>
      new ButtonBuilder().setCustomId(`mac_browse:trait:${k}`).setLabel(`Remove: ${k}`).setStyle(ButtonStyle.Danger)
    );
    for(let i = 0; i < traitBtns.length; i += 4){
      rows.push(new ActionRowBuilder().addComponents(traitBtns.slice(i, i+4)));
    }
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mac_browse:all').setLabel('Remove Everything').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('mac_browse:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  ));
  return interaction.reply({ embeds: [embed], components: rows, flags: MessageFlags.Ephemeral });
}

async function handleMaClearInteraction(interaction, ctx){
  const { getAlert, setAlert, deleteAlert } = ctx;
  const customId = interaction.customId;
  if(customId === 'mac_browse:all'){
    deleteAlert(interaction.user.id);
    return interaction.update({ content: '✅ Your alert has been fully removed.', embeds: [], components: [] });
  }
  if(customId === 'mac_browse:cancel'){
    return interaction.update({ content: 'No changes made.', embeds: [], components: [] });
  }
  if(customId.startsWith('mac_browse:trait:')){
    const traitKey = customId.slice('mac_browse:trait:'.length);
    const alert = getAlert(interaction.user.id);
    if(!alert) return interaction.update({ content: 'No alert found.', embeds: [], components: [] });
    const filters = { ...(alert.traitFilters||{}) };
    delete filters[traitKey];
    setAlert(interaction.user.id, { ...alert, traitFilters: filters });
    const fmtF = f => Object.keys(f).length===0 ? 'none (all tokens)' :
      Object.entries(f).map(([k,v]) => `**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join('\n');
    const embed = new EmbedBuilder()
      .setTitle('🔔 My Alert')
      .setColor(0x5865F2)
      .setDescription([
        `**Collection:** ${alert.slug||'any'}`,
        `**Sales DMs:** ${alert.alertSales ? '✅ on' : '❌ off'}`,
        `**Listing DMs:** ${alert.alertListings ? '✅ on' : '❌ off'}`,
        `**Filters:**`,
        fmtF(filters),
      ].join('\n'));
    const rows = [];
    const traitKeys = Object.keys(filters);
    if(traitKeys.length){
      const traitBtns = traitKeys.slice(0, 8).map(k =>
        new ButtonBuilder().setCustomId(`mac_browse:trait:${k}`).setLabel(`Remove: ${k}`).setStyle(ButtonStyle.Danger)
      );
      for(let i = 0; i < traitBtns.length; i += 4){
        rows.push(new ActionRowBuilder().addComponents(traitBtns.slice(i, i+4)));
      }
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mac_browse:all').setLabel('Remove Everything').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mac_browse:cancel').setLabel('Done').setStyle(ButtonStyle.Secondary),
    ));
    return interaction.update({ embeds: [embed], components: rows });
  }
}

// ── /me hub ───────────────────────────────────────────────────────────────────
async function showMeHub(interaction, ctx){
  const { getAlert, pgPool } = ctx;
  const userId = interaction.user.id;
  const alert = getAlert(userId);

  const fmtF = f => !f || Object.keys(f).length===0 ? 'none (all tokens)' :
    Object.entries(f).map(([k,v]) => `**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join('\n');

  // Build alerts section
  let alertDesc = 'No alert set.';
  if(alert){
    alertDesc = [
      `**Collection:** ${alert.slug||'any'}`,
      `**Sales DMs:** ${alert.alertSales ? '✅ on' : '❌ off'}`,
      `**Listing DMs:** ${alert.alertListings ? '✅ on' : '❌ off'}`,
      `**Filters:**`,
      fmtF(alert.traitFilters),
    ].join('\n');
  }

  // Build price alerts section
  let priceAlertDesc = 'No price alerts set.';
  if(pgPool){
    const paRes = await pgPool.query(
      `SELECT token_id, threshold_eth, slug, alert_once, repeat_alert, triggered_at FROM user_price_alerts WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [userId]
    ).catch(()=>null);
    if(paRes?.rows.length){
      priceAlertDesc = paRes.rows.map(r =>
        `**#${r.token_id}** (${r.slug}) — below Ξ ${parseFloat(r.threshold_eth).toFixed(4)}${r.triggered_at ? ' ✅ triggered' : ''}`
      ).join('\n');
    }
  }

  // Build floor alerts section
  let floorAlertDesc = 'No floor alerts set.';
  if(pgPool){
    const faRes = await pgPool.query(
      `SELECT slug, threshold_eth, cooldown_hours, last_alerted_at FROM user_floor_alerts WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [userId]
    ).catch(()=>null);
    if(faRes?.rows.length){
      floorAlertDesc = faRes.rows.map(r =>
        `**${r.slug}** — below Ξ ${parseFloat(r.threshold_eth).toFixed(4)} (cooldown: ${r.cooldown_hours}h)`
      ).join('\n');
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`👤 My Settings`)
    .setColor(0x5865F2)
    .setDescription([
      '**📣 Trait Alert**',
      alertDesc,
      '',
      '**🏷️ Price Alerts**',
      priceAlertDesc,
      '',
      '**📉 Floor Alerts**',
      floorAlertDesc,
      '',
      '**💼 Wallet**',
      '_Verification coming soon_',
    ].join('\n'))
    .setFooter({ text: 'Use the buttons below to manage your settings' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('me_browse:alert:set')
      .setLabel(alert ? 'Edit Trait Alert' : 'Set Trait Alert')
      .setStyle(alert ? ButtonStyle.Primary : ButtonStyle.Success),
  );
  if(alert){
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId('me_browse:alert:clear')
        .setLabel('Manage Trait Alert')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('me_browse:pricealert:set')
      .setLabel('Add Price Alert')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('me_browse:flooralert:set')
      .setLabel('Add Floor Alert')
      .setStyle(ButtonStyle.Primary),
  );

  const components = [row1, row2];

  // Add manage buttons if alerts exist
  const hasPriceAlerts = priceAlertDesc !== 'No price alerts set.';
  const hasFloorAlerts = floorAlertDesc !== 'No floor alerts set.';
  if(hasPriceAlerts || hasFloorAlerts){
    const row3 = new ActionRowBuilder();
    if(hasPriceAlerts) row3.addComponents(
      new ButtonBuilder().setCustomId('me_browse:pricealert:manage').setLabel('Manage Price Alerts').setStyle(ButtonStyle.Secondary)
    );
    if(hasFloorAlerts) row3.addComponents(
      new ButtonBuilder().setCustomId('me_browse:flooralert:manage').setLabel('Manage Floor Alerts').setStyle(ButtonStyle.Secondary)
    );
    components.push(row3);
  }

  return interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
}

// ── /me interaction handler ───────────────────────────────────────────────────
async function handleMeInteraction(interaction, ctx){
  const { getAlert, setAlert, deleteAlert, getConfig, getRailwayApiUrl, getCachedTraitIndex } = ctx;
  const customId = interaction.customId;

  // Alert tab — set/edit launches myalert wizard
  if(customId === 'me_browse:alert:set'){
    const guildId = interaction.guildId;
    const config = getConfig(guildId) || {};
    const allCols = [];
    const primarySlug = config.collectionSlug || config.slug;
    if(primarySlug) allCols.push({ slug: primarySlug, name: config.contractName || primarySlug });
    for(const c of config.collections || []) { if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }
    if(!allCols.length) return interaction.update({ content: 'Run `/setup` first to configure a collection.', embeds: [], components: [] });
    if(allCols.length === 1){
      return showMaTraitPicker(interaction, ctx, allCols[0].slug);
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ma_browse:col')
      .setPlaceholder('Pick a collection...')
      .addOptions(allCols.slice(0,25).map(c =>
        new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug)
      ));
    return interaction.update({
      content: '**🔔 Set Alert** — Pick a collection:',
      embeds: [],
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  }

  // Alert tab — manage/clear launches clear wizard
  if(customId === 'me_browse:alert:clear'){
    return showMaClearWizard(interaction, { getAlert, deleteAlert, setAlert });
  }

  // Price alert — set
  if(customId === 'me_browse:pricealert:set'){
    const { getConfig, pgPool } = ctx;
    const guildId = interaction.guildId;
    const config = getConfig(guildId) || {};
    const allCols = [];
    const primarySlug = config.collectionSlug || config.slug;
    if(primarySlug) allCols.push({ slug: primarySlug, name: config.contractName || primarySlug });
    for(const c of config.collections || []) { if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }

    if(allCols.length === 0) return interaction.update({ content: 'No collections configured.', embeds:[], components:[] });

    // If only one collection skip picker, go straight to token/price input via modal
    const targetSlug = allCols.length === 1 ? allCols[0].slug : null;
    if(targetSlug){
      const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = require('discord.js');
      const modal = new ModalBuilder()
        .setCustomId(`me_modal:pricealert:${targetSlug}`)
        .setTitle('Set Price Alert');
      modal.addComponents(
        new AR().addComponents(new TextInputBuilder().setCustomId('token_id').setLabel('Token ID (e.g. 1234)').setStyle(TextInputStyle.Short).setRequired(true)),
        new AR().addComponents(new TextInputBuilder().setCustomId('threshold').setLabel('Alert when listed below (ETH, e.g. 0.05)').setStyle(TextInputStyle.Short).setRequired(true)),
        new AR().addComponents(new TextInputBuilder().setCustomId('once').setLabel('Alert once or repeat? (once / repeat)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('once')),
      );
      return interaction.showModal(modal);
    }
    // Multi-collection — show collection picker first
    const menu = new StringSelectMenuBuilder()
      .setCustomId('me_browse:pricealert:col')
      .setPlaceholder('Pick a collection...')
      .addOptions(allCols.slice(0,25).map(c => new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug)));
    return interaction.update({ content: '**🏷️ Price Alert** — Pick a collection:', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }

  if(customId.startsWith('me_browse:pricealert:col')){
    const slug = interaction.values[0];
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = require('discord.js');
    const modal = new ModalBuilder().setCustomId(`me_modal:pricealert:${slug}`).setTitle('Set Price Alert');
    modal.addComponents(
      new AR().addComponents(new TextInputBuilder().setCustomId('token_id').setLabel('Token ID (e.g. 1234)').setStyle(TextInputStyle.Short).setRequired(true)),
      new AR().addComponents(new TextInputBuilder().setCustomId('threshold').setLabel('Alert when listed below (ETH, e.g. 0.05)').setStyle(TextInputStyle.Short).setRequired(true)),
      new AR().addComponents(new TextInputBuilder().setCustomId('once').setLabel('Alert once or repeat? (once / repeat)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('once')),
    );
    return interaction.showModal(modal);
  }

  // Price alert — manage (show list with remove buttons)
  if(customId === 'me_browse:pricealert:manage'){
    const { pgPool } = ctx;
    const res = await pgPool.query(
      `SELECT id, token_id, slug, threshold_eth, triggered_at FROM user_price_alerts WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 8`,
      [interaction.user.id]
    ).catch(()=>({rows:[]}));
    if(!res.rows.length) return interaction.update({ content: 'No price alerts found.', embeds:[], components:[] });
    const rows = [];
    const btns = res.rows.map(r =>
      new ButtonBuilder()
        .setCustomId(`me_browse:pricealert:remove:${r.id}`)
        .setLabel(`#${r.token_id} Ξ${parseFloat(r.threshold_eth).toFixed(3)}${r.triggered_at?' ✅':''}`)
        .setStyle(ButtonStyle.Danger)
    );
    for(let i=0;i<btns.length;i+=4) rows.push(new ActionRowBuilder().addComponents(btns.slice(i,i+4)));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('me_browse:pricealert:clearall').setLabel('Remove All').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('me_browse:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    ));
    return interaction.update({ content: '**🏷️ Price Alerts** — tap to remove:', embeds:[], components: rows });
  }

  if(customId.startsWith('me_browse:pricealert:remove:')){
    const { pgPool } = ctx;
    const id = parseInt(customId.split(':').pop());
    await pgPool.query(`DELETE FROM user_price_alerts WHERE id=$1 AND discord_id=$2`, [id, interaction.user.id]).catch(()=>{});
    return interaction.update({ content: '✅ Price alert removed.', embeds:[], components:[] });
  }

  if(customId === 'me_browse:pricealert:clearall'){
    const { pgPool } = ctx;
    await pgPool.query(`DELETE FROM user_price_alerts WHERE discord_id=$1`, [interaction.user.id]).catch(()=>{});
    return interaction.update({ content: '✅ All price alerts removed.', embeds:[], components:[] });
  }

  // Floor alert — set
  if(customId === 'me_browse:flooralert:set'){
    const { getConfig, pgPool } = ctx;
    const guildId = interaction.guildId;
    const config = getConfig(guildId) || {};
    const allCols = [];
    const primarySlug = config.collectionSlug || config.slug;
    if(primarySlug) allCols.push({ slug: primarySlug, name: config.contractName || primarySlug });
    for(const c of config.collections || []) { if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }
    if(!allCols.length) return interaction.update({ content: 'No collections configured.', embeds:[], components:[] });

    const targetSlug = allCols.length === 1 ? allCols[0].slug : null;
    if(targetSlug){
      const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = require('discord.js');
      const modal = new ModalBuilder().setCustomId(`me_modal:flooralert:${targetSlug}`).setTitle('Set Floor Alert');
      modal.addComponents(
        new AR().addComponents(new TextInputBuilder().setCustomId('threshold').setLabel('Alert when floor drops below (ETH)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('0.05')),
        new AR().addComponents(new TextInputBuilder().setCustomId('cooldown').setLabel('Cooldown between alerts (hours)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('1')),
      );
      return interaction.showModal(modal);
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId('me_browse:flooralert:col')
      .setPlaceholder('Pick a collection...')
      .addOptions(allCols.slice(0,25).map(c => new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug)));
    return interaction.update({ content: '**📉 Floor Alert** — Pick a collection:', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }

  if(customId.startsWith('me_browse:flooralert:col')){
    const slug = interaction.values[0];
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = require('discord.js');
    const modal = new ModalBuilder().setCustomId(`me_modal:flooralert:${slug}`).setTitle('Set Floor Alert');
    modal.addComponents(
      new AR().addComponents(new TextInputBuilder().setCustomId('threshold').setLabel('Alert when floor drops below (ETH)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('0.05')),
      new AR().addComponents(new TextInputBuilder().setCustomId('cooldown').setLabel('Cooldown between alerts (hours)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('1')),
    );
    return interaction.showModal(modal);
  }

  // Floor alert — manage
  if(customId === 'me_browse:flooralert:manage'){
    const { pgPool } = ctx;
    const res = await pgPool.query(
      `SELECT id, slug, threshold_eth, cooldown_hours FROM user_floor_alerts WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 8`,
      [interaction.user.id]
    ).catch(()=>({rows:[]}));
    if(!res.rows.length) return interaction.update({ content: 'No floor alerts found.', embeds:[], components:[] });
    const btns = res.rows.map(r =>
      new ButtonBuilder()
        .setCustomId(`me_browse:flooralert:remove:${r.id}`)
        .setLabel(`${r.slug} Ξ${parseFloat(r.threshold_eth).toFixed(3)}`)
        .setStyle(ButtonStyle.Danger)
    );
    const rows = [];
    for(let i=0;i<btns.length;i+=4) rows.push(new ActionRowBuilder().addComponents(btns.slice(i,i+4)));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('me_browse:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    ));
    return interaction.update({ content: '**📉 Floor Alerts** — tap to remove:', embeds:[], components: rows });
  }

  if(customId.startsWith('me_browse:flooralert:remove:')){
    const { pgPool } = ctx;
    const id = parseInt(customId.split(':').pop());
    await pgPool.query(`DELETE FROM user_floor_alerts WHERE id=$1 AND discord_id=$2`, [id, interaction.user.id]).catch(()=>{});
    return interaction.update({ content: '✅ Floor alert removed.', embeds:[], components:[] });
  }

  if(customId === 'me_browse:back'){
    return showMeHub(interaction, ctx);
  }
}

module.exports = { handleMarketCommand, MARKET_COMMANDS, resolveCollectionFromServerCfg, isPaidFeature, handleTraitBrowseInteraction, handleMyAlertInteraction, showMaTraitPicker, handleMaClearInteraction, handleMeInteraction };
