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

function getServerCollectionsForWalletSync(config){
  const items = [];
  const add = c => {
    if(!c) return;
    const contract = String(c.contract || '').trim().toLowerCase();
    const slug = String(c.slug || c.collectionSlug || '').trim();
    if(!contract && !slug) return;
    items.push({ contract, slug: slug || contract, name: c.name || c.contractName || slug || contract });
  };
  add({ contract: config?.contract, slug: config?.collectionSlug || config?.slug, name: config?.contractName || config?.collectionSlug || config?.slug });
  for(const c of config?.collections || []) add(c);
  add({ contract: '0x078be86f3104a32313a47815792230a3808642cc', slug: 'on-chain-all-stars', name: 'On-Chain All Stars' });
  const seen = new Set();
  return items.filter(c => {
    const key = c.slug ? `slug:${c.slug.toLowerCase()}` : `contract:${c.contract}`;
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    const replyFn = interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : (interaction.replied || interaction.deferred ? 'editReply' : 'reply');
    return interaction[replyFn]({ content: `No trait data found for **${slug}** yet.`, ...(replyFn !== 'update' ? { flags: MessageFlags.Ephemeral } : {}) });
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
  const replyFn = interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : (interaction.replied || interaction.deferred ? 'editReply' : 'reply');
  const replyOpts = {
    content: `**🔔 My Alert — ${slug}**\n\nPick a trait to filter by:`,
    components: [new ActionRowBuilder().addComponents(menu)],
    embeds: [],
  };
  if(replyFn !== 'update') replyOpts.flags = MessageFlags.Ephemeral;
  return interaction[replyFn](replyOpts);
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
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back to My Settings').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({ content: '', embeds: [embed], components: [backRow] });
  }
  if(customId === 'ma_browse:cancel'){
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back to My Settings').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({ content: 'Alert wizard cancelled.', embeds: [], components: [backRow] });
  }
}


// ── /myalertclear wizard ─────────────────────────────────────────────────────
async function showMaClearWizard(interaction, ctx){
  const { getAlert } = ctx;
  const alert = getAlert(interaction.user.id);
  if(!alert || (!Object.keys(alert.traitFilters||{}).length && !alert.slug)){
    const naFn = interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : 'reply';
    return interaction[naFn]({ content: 'You have no alert set. Use `/me` to set one.', embeds:[], components:[], ...(naFn !== 'update' ? { flags: MessageFlags.Ephemeral } : {}) });
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
    // Build one button per value, not per trait
    const valueBtns = [];
    for(const [trait, val] of Object.entries(filters)){
      const vals = Array.isArray(val) ? val : [val];
      for(const v of vals){
        valueBtns.push(
          new ButtonBuilder()
            .setCustomId(`mac_browse:val:${trait}:${v}`)
            .setLabel(`✕ ${trait}: ${v}`.slice(0, 80))
            .setStyle(ButtonStyle.Danger)
        );
      }
    }
    for(let i = 0; i < Math.min(valueBtns.length, 16); i += 4){
      rows.push(new ActionRowBuilder().addComponents(valueBtns.slice(i, i+4)));
    }
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mac_browse:all').setLabel('Remove Everything').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('mac_browse:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  ));
  const clearReplyFn = interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : 'reply';
  const clearOpts = { embeds: [embed], components: rows };
  if(clearReplyFn !== 'update') clearOpts.flags = MessageFlags.Ephemeral;
  return interaction[clearReplyFn](clearOpts);
}

async function handleMaClearInteraction(interaction, ctx){
  const { getAlert, setAlert, deleteAlert } = ctx;
  const customId = interaction.customId;
  if(customId === 'mac_browse:all'){
    deleteAlert(interaction.user.id);
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back to My Settings').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({ content: '✅ Your alert has been fully removed.', embeds: [], components: [backRow] });
  }
  if(customId === 'mac_browse:cancel'){
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back to My Settings').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({ content: 'No changes made.', embeds: [], components: [backRow] });
  }
  if(customId.startsWith('mac_browse:val:')){
    // Format: mac_browse:val:traitName:traitValue
    const rest = customId.slice('mac_browse:val:'.length);
    const colonIdx = rest.indexOf(':');
    const traitKey = rest.slice(0, colonIdx);
    const traitVal = rest.slice(colonIdx + 1);
    const alert = getAlert(interaction.user.id);
    if(!alert) return interaction.update({ content: 'No alert found.', embeds: [], components: [] });
    const filters = { ...(alert.traitFilters||{}) };
    const current = filters[traitKey];
    if(Array.isArray(current)){
      const updated = current.filter(v => v !== traitVal);
      if(updated.length === 0) delete filters[traitKey];
      else if(updated.length === 1) filters[traitKey] = updated[0];
      else filters[traitKey] = updated;
    } else {
      delete filters[traitKey];
    }
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
    const valueBtns2 = [];
    for(const [trait, val] of Object.entries(filters)){
      const vals = Array.isArray(val) ? val : [val];
      for(const v of vals){
        valueBtns2.push(
          new ButtonBuilder()
            .setCustomId(`mac_browse:val:${trait}:${v}`)
            .setLabel(`✕ ${trait}: ${v}`.slice(0, 80))
            .setStyle(ButtonStyle.Danger)
        );
      }
    }
    for(let i = 0; i < Math.min(valueBtns2.length, 16); i += 4){
      rows.push(new ActionRowBuilder().addComponents(valueBtns2.slice(i, i+4)));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mac_browse:all').setLabel('Remove Everything').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mac_browse:cancel').setLabel('Done').setStyle(ButtonStyle.Secondary),
    ));
    return interaction.update({ embeds: [embed], components: rows });
  }
}

// ── /me hub helpers ──────────────────────────────────────────────────────────
function parseCooldown(str){
  // Parses "30m", "2h", "1d", or plain number (treated as minutes)
  // Returns minutes as integer
  if(!str) return 60; // default 1 hour
  const s = String(str).trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*([mhd]?)$/);
  if(!match) return 60;
  const val = parseFloat(match[1]);
  const unit = match[2] || 'm';
  if(unit === 'd') return Math.round(val * 24 * 60);
  if(unit === 'h') return Math.round(val * 60);
  return Math.round(val); // minutes
}

function formatCooldown(minutes){
  if(minutes >= 1440) return `${(minutes/1440).toFixed(1).replace(/\.0$/,'')}d`;
  if(minutes >= 60)   return `${(minutes/60).toFixed(1).replace(/\.0$/,'')}h`;
  return `${minutes}m`;
}

// ── /me hub — main entry ──────────────────────────────────────────────────────
async function showMeHub(interaction, ctx){
  const { getAlert, pgPool } = ctx;
  const userId = interaction.user.id;
  const fmtF = f => !f || Object.keys(f).length===0 ? 'none' :
    Object.entries(f).map(([k,v]) => `${k}: ${Array.isArray(v)?v.join(', '):v}`).join(' · ');

  // Build summary lines
  const summaryLines = [];

  // Trait alert
  const alert = getAlert(userId);
  if(alert){
    summaryLines.push(`📣 **Trait Alert** — ${alert.slug||'any'} · Sales: ${alert.alertSales?'✅':'❌'} · Listings: ${alert.alertListings?'✅':'❌'}`);
    summaryLines.push(`  Filters: ${fmtF(alert.traitFilters)}`);
  } else {
    summaryLines.push('📣 **Trait Alert** — not set');
  }

  // Price alerts
  if(pgPool){
    const pa = await pgPool.query(
      `SELECT COUNT(*) AS cnt FROM user_price_alerts WHERE discord_id=$1`, [userId]
    ).catch(()=>null);
    const paCnt = parseInt(pa?.rows[0]?.cnt||0);
    summaryLines.push(`🏷️ **Price Alerts** — ${paCnt > 0 ? `${paCnt} active` : 'none set'}`);

    const fa = await pgPool.query(
      `SELECT slug, threshold_eth FROM user_floor_alerts WHERE discord_id=$1`, [userId]
    ).catch(()=>null);
    if(fa?.rows.length){
      summaryLines.push(`📉 **Floor Alerts** — ${fa.rows.map(r=>`${r.slug} < Ξ${parseFloat(r.threshold_eth).toFixed(3)}`).join(', ')}`);
    } else {
      summaryLines.push('📉 **Floor Alerts** — none set');
    }
  }

  // Wallet status
  if(pgPool){
    const walletReg = await pgPool.query(
      `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
      [userId]
    ).catch(()=>null);
    const w = walletReg?.rows[0]?.wallet;
    if(w) summaryLines.push(`💼 **Wallet** — \`${w.slice(0,6)}...${w.slice(-4)}\` verified ✅`);
    else summaryLines.push('💼 **Wallet** — not verified');

    // TraitView link status
    const tvLink = await pgPool.query(
      `SELECT wallet, linked_at FROM traitview_links WHERE discord_id=$1 AND guild_id=$2`,
      [userId, interaction.guildId]
    ).catch(()=>null);
    if(tvLink?.rows[0]) summaryLines.push(`📊 **TraitView** — linked ✅`);
    else summaryLines.push('📊 **TraitView** — not linked');
  } else {
    summaryLines.push('💼 **Wallet** — not verified');
    summaryLines.push('📊 **TraitView** — not linked');
  }

  const nav = new StringSelectMenuBuilder()
    .setCustomId('me_browse:nav')
    .setPlaceholder('Select a section to manage...')
    .addOptions([
      new StringSelectMenuOptionBuilder().setLabel('📣 Trait Alert').setDescription('Sales & listing DMs by trait').setValue('trait_alert'),
      new StringSelectMenuOptionBuilder().setLabel('🏷️ Price Alerts').setDescription('DM when a token drops below a price').setValue('price_alerts'),
      new StringSelectMenuOptionBuilder().setLabel('📉 Floor Alerts').setDescription('DM when a collection floor drops').setValue('floor_alerts'),
      new StringSelectMenuOptionBuilder().setLabel('💼 Wallet').setDescription('Verification & wallet analytics').setValue('wallet'),
      new StringSelectMenuOptionBuilder().setLabel('📊 TraitView').setDescription('Link your TraitView account').setValue('traitview'),
    ]);

  const embed = new EmbedBuilder()
    .setTitle('👤 My Settings')
    .setColor(0x5865F2)
    .setDescription(summaryLines.join('\n'))
    .setFooter({ text: 'Your settings are private — only you can see this' });

  const replyFn = interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : (interaction.replied || interaction.deferred ? 'editReply' : 'reply');
  const meOpts = { embeds: [embed], components: [new ActionRowBuilder().addComponents(nav)] };
  if(replyFn !== 'update') meOpts.flags = MessageFlags.Ephemeral;
  return interaction[replyFn](meOpts);
}

// ── /me section renderers ─────────────────────────────────────────────────────
async function showMeTraitAlert(interaction, ctx){
  const { getAlert } = ctx;
  const alert = getAlert(interaction.user.id);
  const fmtF = f => !f || Object.keys(f).length===0 ? 'none (all tokens)' :
    Object.entries(f).map(([k,v]) => `**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join('\n');

  const desc = alert ? [
    `**Collection:** ${alert.slug||'any'}`,
    `**Sales DMs:** ${alert.alertSales ? '✅ on' : '❌ off'}`,
    `**Listing DMs:** ${alert.alertListings ? '✅ on' : '❌ off'}`,
    `**Filters:**`,
    fmtF(alert.traitFilters),
  ].join('\n') : 'No trait alert set.';

  const embed = new EmbedBuilder()
    .setTitle('📣 Trait Alert')
    .setColor(0x5865F2)
    .setDescription(desc);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me_browse:alert:set').setLabel('Add Alert').setStyle(ButtonStyle.Success),
  );
  if(alert) row.addComponents(
    new ButtonBuilder().setCustomId('me_browse:alert:clear').setLabel('Manage / Clear').setStyle(ButtonStyle.Danger),
  );
  row.addComponents(
    new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );

  const updateFn = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  return interaction[updateFn]({ embeds: [embed], components: [row] });
}

async function showMePriceAlerts(interaction, ctx){
  const { pgPool } = ctx;
  const userId = interaction.user.id;
  let desc = 'No price alerts set.';
  let hasAlerts = false;
  const rows = [];

  if(pgPool){
    const res = await pgPool.query(
      `SELECT id, token_id, slug, threshold_eth, alert_once, repeat_alert, triggered_at FROM user_price_alerts WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 8`,
      [userId]
    ).catch(()=>null);
    if(res?.rows.length){
      hasAlerts = true;
      desc = res.rows.map(r =>
        `**#${r.token_id}** (${r.slug}) — below Ξ ${parseFloat(r.threshold_eth).toFixed(4)} ${r.triggered_at?'✅ triggered':r.repeat_alert?'🔁 repeat':'1x'}`
      ).join('\n');
      const btns = res.rows.map(r =>
        new ButtonBuilder().setCustomId(`me_browse:pricealert:remove:${r.id}`)
          .setLabel(`Remove #${r.token_id}`).setStyle(ButtonStyle.Danger)
      );
      for(let i=0;i<btns.length;i+=4) rows.push(new ActionRowBuilder().addComponents(btns.slice(i,i+4)));
    }
  }

  const embed = new EmbedBuilder().setTitle('🏷️ Price Alerts').setColor(0x5865F2).setDescription(desc);

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me_browse:pricealert:set').setLabel('Add Price Alert').setStyle(ButtonStyle.Success),
  );
  if(hasAlerts) actionRow.addComponents(
    new ButtonBuilder().setCustomId('me_browse:pricealert:clearall').setLabel('Remove All').setStyle(ButtonStyle.Danger),
  );
  actionRow.addComponents(
    new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );
  rows.push(actionRow);

  const updateFn = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  return interaction[updateFn]({ embeds: [embed], components: rows });
}

async function showMeFloorAlerts(interaction, ctx){
  const { pgPool } = ctx;
  const userId = interaction.user.id;
  let desc = 'No floor alerts set.';
  let hasAlerts = false;
  const rows = [];

  if(pgPool){
    const res = await pgPool.query(
      `SELECT id, slug, threshold_eth, cooldown_minutes, direction, last_alerted_at FROM user_floor_alerts WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 8`,
      [userId]
    ).catch(()=>null);
    if(res?.rows.length){
      hasAlerts = true;
      desc = res.rows.map(r => {
        const dir = r.direction || 'below';
        const arrow = dir === 'above' ? '📈' : dir === 'either' ? '↕️' : '📉';
        return `${arrow} **${r.slug}** — ${dir} Ξ ${parseFloat(r.threshold_eth).toFixed(4)} · repeats after ${formatCooldown(r.cooldown_minutes||60)}${r.last_alerted_at?' · last alerted '+new Date(r.last_alerted_at).toLocaleDateString():''}`;
      }).join('\n');
      const btns = res.rows.map(r =>
        new ButtonBuilder().setCustomId(`me_browse:flooralert:remove:${r.id}`)
          .setLabel(`Remove ${r.slug}`).setStyle(ButtonStyle.Danger)
      );
      for(let i=0;i<btns.length;i+=4) rows.push(new ActionRowBuilder().addComponents(btns.slice(i,i+4)));
    }
  }

  const embed = new EmbedBuilder().setTitle('📉 Floor Alerts').setColor(0x5865F2).setDescription(desc);

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me_browse:flooralert:set').setLabel('Add Floor Alert').setStyle(ButtonStyle.Success),
  );
  if(hasAlerts) actionRow.addComponents(
    new ButtonBuilder().setCustomId('me_browse:flooralert:clearall').setLabel('Remove All').setStyle(ButtonStyle.Danger),
  );
  actionRow.addComponents(
    new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );
  rows.push(actionRow);

  const updateFn = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  return interaction[updateFn]({ embeds: [embed], components: rows });
}


// ── TraitView↔Discord verification ───────────────────────────────────────────
function generateTVCode() {
  // 6-char alphanumeric code, uppercase, no ambiguous chars (0/O, 1/I/L)
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for(let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function showMeTraitView(interaction, ctx) {
  const { pgPool } = ctx;
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  const updateFn = interaction.deferred || interaction.replied ? 'editReply'
    : (interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : 'editReply');

  // Check if already linked
  let linked = null;
  if(pgPool) {
    const row = await pgPool.query(
      `SELECT wallet, linked_at FROM traitview_links WHERE discord_id=$1 AND guild_id=$2`,
      [userId, guildId]
    ).catch(()=>null);
    linked = row?.rows[0] || null;
  }

  const lines = [];
  if(linked) {
    lines.push(`✅ **TraitView is linked!**`);
    lines.push(`Wallet: \`${linked.wallet.slice(0,6)}...${linked.wallet.slice(-4)}\``);
    lines.push(`Linked: <t:${Math.floor(new Date(linked.linked_at).getTime()/1000)}:R>`);
    lines.push('');
    lines.push('Your wallet data is now available on TraitView. You can re-link anytime.');
  } else {
    lines.push('Connect your Discord account to TraitView to unlock:');
    lines.push('• Verified holder badge on TraitView');
    lines.push('• Personal portfolio analytics on TraitView');
    lines.push('• Your burn history and community leaderboards');
    lines.push('');
    lines.push('**How to link:**');
    lines.push('**Option A** — Generate a code here and enter it on TraitView');
    lines.push('**Option B** — Get a code from TraitView and enter it here');
  }

  const embed = new EmbedBuilder()
    .setTitle('📊 TraitView')
    .setColor(linked ? 0x57F287 : 0x5865F2)
    .setDescription(lines.join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me_browse:tv:generate').setLabel('🔑 Generate Code').setStyle(linked ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('me_browse:tv:enter').setLabel('✏️ Enter Code').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );

  return interaction[updateFn]({ embeds: [embed], components: [row] });
}

async function handleTVGenerateCode(interaction, ctx) {
  const { pgPool } = ctx;
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  if(!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(()=>{});

  // Must have a verified wallet
  const walletRow = await pgPool.query(
    `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
    [userId]
  ).catch(()=>null);
  const wallet = walletRow?.rows[0]?.wallet;

  if(!wallet) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('📊 TraitView').setColor(0xED4245)
        .setDescription('❌ You need to verify your wallet first before linking TraitView.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary)
      )],
    });
  }

  // Generate code, invalidate any existing ones for this user, insert new
  const code = generateTVCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  await pgPool.query(
    `DELETE FROM tv_verify_codes WHERE discord_id=$1 AND guild_id=$2`,
    [userId, guildId]
  ).catch(()=>{});

  await pgPool.query(
    `INSERT INTO tv_verify_codes (code, discord_id, guild_id, wallet, direction, expires_at)
     VALUES ($1,$2,$3,$4,'discord',$5)`,
    [code, userId, guildId, wallet, expiresAt]
  ).catch(()=>{});

  const embed = new EmbedBuilder()
    .setTitle('📊 TraitView — Your Code')
    .setColor(0x5865F2)
    .setDescription([
      `Your verification code is:`,
      `# \`${code}\``,
      '',
      `Click the button below to open TraitView and enter your code.`,
      `⏱️ Expires in **5 minutes**`,
    ].join('\n'));

  return interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setURL('https://traitview.com?verify=true').setLabel('Verify on TraitView').setStyle(ButtonStyle.Link),
      new ButtonBuilder().setCustomId('me_browse:traitview').setLabel('← Back').setStyle(ButtonStyle.Secondary)
    )],
  });
}

async function handleTVEnterCode(interaction, ctx) {
  // Show a modal for the user to type in the code from TraitView
  const modal = new ModalBuilder()
    .setCustomId('me_modal:tv:enter_code')
    .setTitle('Enter TraitView Code');

  const codeInput = new TextInputBuilder()
    .setCustomId('tv_code')
    .setLabel('Code from TraitView')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. ABC123')
    .setMinLength(6)
    .setMaxLength(6)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
  return interaction.showModal(modal);
}

async function showMeWallet(interaction, ctx){
  const { pgPool, getConfig } = ctx;
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  // Look up verified wallet
  let wallet = null;
  if(pgPool){
    const reg = await pgPool.query(
      `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND guild_id=$2 AND verified=true LIMIT 1`,
      [userId, guildId]
    ).catch(()=>null);
    wallet = reg?.rows[0]?.wallet?.toLowerCase() || null;
    if(!wallet){
      const globalReg = await pgPool.query(
        `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
        [userId]
      ).catch(()=>null);
      wallet = globalReg?.rows[0]?.wallet?.toLowerCase() || null;
    }
  }

  const updateFn = interaction.deferred || interaction.replied
    ? 'editReply'
    : (interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : 'editReply');

  // ── Unverified ──────────────────────────────────────────────────────────────
  if(!wallet){
    const embed = new EmbedBuilder()
      .setTitle('💼 Wallet')
      .setColor(0x5865F2)
      .setDescription([
        'Link your wallet to unlock portfolio analytics, P&L tracking, and leaderboards.',
        '',
        'Find the **Verify Wallet** button in your server\'s verification channel to get started.',
      ].join('\n'));
    return interaction[updateFn]({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  // ── Fetch per-collection analytics ──────────────────────────────────────────
  const shortWallet = wallet.slice(0,6) + '...' + wallet.slice(-4);
  let cols = [];

  if(pgPool){
    const config = getConfig(guildId) || {};
    const rawCols = [];
    if(config.collectionSlug || config.slug) rawCols.push({ slug: config.collectionSlug || config.slug, name: config.contractName || config.collectionSlug || config.slug });
    for(const c of config.collections || []) { if(c.slug) rawCols.push({ slug: c.slug, name: c.name || c.slug }); }
    if(!rawCols.find(c => c.slug === 'on-chain-all-stars')) rawCols.push({ slug: 'on-chain-all-stars', name: 'On-Chain All Stars' });

    for(const col of rawCols){
      try {
        // ── Core interval stats ───────────────────────────────────────────────
        const stats = await pgPool.query(
          `SELECT
            COUNT(*) FILTER (WHERE disposed_at IS NULL)                                                        AS held,
            COUNT(*) FILTER (WHERE disposed_at IS NOT NULL AND sale_eth IS NOT NULL AND sale_eth > 0)          AS sold,
            COUNT(*) FILTER (WHERE disposed_at IS NOT NULL AND (sale_eth IS NULL OR sale_eth = 0))             AS burned,
            COALESCE(AVG(cost_eth)  FILTER (WHERE disposed_at IS NULL), 0)                                     AS avg_cost,
            COALESCE(SUM(cost_eth)  FILTER (WHERE disposed_at IS NOT NULL AND sale_eth IS NOT NULL AND sale_eth > 0), 0) AS total_spent_sold,
            COALESCE(SUM(sale_eth)  FILTER (WHERE disposed_at IS NOT NULL AND sale_eth IS NOT NULL AND sale_eth > 0), 0) AS total_earned,
            COALESCE(SUM(sale_eth - cost_eth) FILTER (WHERE disposed_at IS NOT NULL AND sale_eth IS NOT NULL AND sale_eth > 0), 0) AS realized_pnl
           FROM wallet_token_intervals
           WHERE LOWER(wallet_address)=$1 AND collection_slug=$2`,
          [wallet, col.slug]
        );

        // Count distinct burn events for this wallet+collection
        const burnEvents = await pgPool.query(
          `SELECT COUNT(DISTINCT be.id) AS event_count
           FROM burn_events be
           WHERE LOWER(be.burner_wallet) = $1`,
          [wallet]
        ).catch(() => ({ rows: [{ event_count: 0 }] }));

        const burnEventCount = parseInt(burnEvents.rows[0]?.event_count || 0);
        const held   = parseInt(stats.rows[0]?.held   || 0);
        const sold   = parseInt(stats.rows[0]?.sold   || 0);
        const burned = parseInt(stats.rows[0]?.burned || 0);
        if(held === 0 && sold === 0 && burned === 0) continue;

        const totalEarned     = parseFloat(stats.rows[0]?.total_earned     || 0);
        const realizedPnl     = parseFloat(stats.rows[0]?.realized_pnl     || 0);
        const avgCost         = parseFloat(stats.rows[0]?.avg_cost         || 0);

        // ── Sweep-depth est. value ────────────────────────────────────────────
        // Est. value = sum of the cheapest `held` listings in the collection.
        // This models what it would actually cost to acquire an equivalent position —
        // floor rises as each cheaper token gets picked off, which is more realistic
        // than (held × floor price).
        //
        // Trait layer: if trait data exists for this collection, group held tokens
        // by their most-listed trait value and find the cheapest K listings per group,
        // where K = how many of that trait the wallet holds. This gives per-trait
        // sweep depth. Falls back to collection sweep if no trait data.

        let estValue = null;
        let estMethod = 'sweep'; // 'sweep' | 'trait-sweep' | 'floor'

        if(held > 0){
          // Collection sweep depth — cheapest `held` listings
          const sweepRes = await pgPool.query(
            `SELECT COALESCE(SUM(price_eth), 0) AS sweep_value, COUNT(*) AS count
             FROM (
               SELECT price_eth
               FROM listings
               WHERE collection_slug = $1
               ORDER BY price_eth ASC
               LIMIT $2
             ) sub`,
            [col.slug, held]
          ).catch(() => ({ rows: [] }));

          const sweepCount = parseInt(sweepRes.rows[0]?.count || 0);
          const sweepValue = sweepCount > 0 ? parseFloat(sweepRes.rows[0]?.sweep_value || 0) : null;

          // Trait sweep depth — only attempt if collection has trait data
          const hasTraits = await pgPool.query(
            `SELECT 1 FROM token_traits WHERE (collection_slug=$1 OR collection_slug IS NULL) LIMIT 1`,
            [col.slug]
          ).catch(() => ({ rows: [] }));

          if(hasTraits.rows.length > 0 && held > 0){
            // For each held token, find cheapest listing among tokens sharing its rarest trait
            // (rarest = trait shared by fewest tokens in collection → most price-differentiating)
            const traitSweepRes = await pgPool.query(
              `WITH held_tokens AS (
                 SELECT token_id FROM wallet_token_intervals
                 WHERE LOWER(wallet_address)=$1 AND collection_slug=$2 AND disposed_at IS NULL
               ),
               token_rarest_trait AS (
                 -- For each held token pick its rarest trait (fewest tokens share it)
                 SELECT DISTINCT ON (tt.token_id)
                   tt.token_id,
                   tt.trait_name,
                   tt.trait_value,
                   COUNT(*) OVER (PARTITION BY tt.trait_name, tt.trait_value) AS trait_count
                 FROM token_traits tt
                 JOIN held_tokens ht ON ht.token_id = tt.token_id
                 WHERE (tt.collection_slug=$2 OR tt.collection_slug IS NULL)
                 ORDER BY tt.token_id, trait_count ASC
               ),
               trait_groups AS (
                 -- Count how many held tokens share each trait group
                 SELECT trait_name, trait_value, COUNT(*) AS held_count
                 FROM token_rarest_trait
                 GROUP BY trait_name, trait_value
               ),
               trait_sweep AS (
                 -- For each trait group, sum cheapest K listings where K = held_count
                 SELECT
                   tg.trait_name,
                   tg.trait_value,
                   tg.held_count,
                   (SELECT COALESCE(SUM(price_eth), 0)
                    FROM (
                      SELECT l.price_eth
                      FROM listings l
                      JOIN token_traits tt2 ON tt2.token_id = l.token_id
                        AND tt2.trait_name  = tg.trait_name
                        AND tt2.trait_value = tg.trait_value
                        AND (tt2.collection_slug=$2 OR tt2.collection_slug IS NULL)
                      WHERE l.collection_slug = $2
                      ORDER BY l.price_eth ASC
                      LIMIT tg.held_count
                    ) sub
                   ) AS group_sweep_value,
                   (SELECT COUNT(*)
                    FROM listings l
                    JOIN token_traits tt2 ON tt2.token_id = l.token_id
                      AND tt2.trait_name  = tg.trait_name
                      AND tt2.trait_value = tg.trait_value
                      AND (tt2.collection_slug=$2 OR tt2.collection_slug IS NULL)
                    WHERE l.collection_slug = $2
                   ) AS listings_available
                 FROM trait_groups tg
               )
               SELECT
                 SUM(group_sweep_value) AS total_trait_sweep,
                 SUM(held_count) AS tokens_covered,
                 SUM(CASE WHEN listings_available >= held_count THEN held_count ELSE listings_available END) AS fully_covered
               FROM trait_sweep`,
              [wallet, col.slug]
            ).catch(() => ({ rows: [] }));

            const traitSweepVal = traitSweepRes.rows[0]?.total_trait_sweep
              ? parseFloat(traitSweepRes.rows[0].total_trait_sweep) : null;
            const covered = parseInt(traitSweepRes.rows[0]?.tokens_covered || 0);

            if(traitSweepVal !== null && covered === held){
              // Full trait coverage — use trait sweep
              estValue  = traitSweepVal;
              estMethod = 'trait-sweep';
            } else if(traitSweepVal !== null && sweepValue !== null){
              // Partial — blend: trait sweep for covered tokens, collection sweep for rest
              const uncovered = held - covered;
              const partialCollSweep = await pgPool.query(
                `SELECT COALESCE(SUM(price_eth),0) AS v FROM (
                   SELECT price_eth FROM listings WHERE collection_slug=$1
                   ORDER BY price_eth ASC LIMIT $2
                 ) sub`,
                [col.slug, uncovered]
              ).catch(() => ({ rows: [{ v: 0 }] }));
              estValue  = traitSweepVal + parseFloat(partialCollSweep.rows[0]?.v || 0);
              estMethod = 'trait-sweep';
            } else if(sweepValue !== null){
              estValue  = sweepValue;
              estMethod = 'sweep';
            }
          } else if(sweepValue !== null){
            estValue  = sweepValue;
            estMethod = 'sweep';
          }
        }

        // Collection floor (for display reference)
        const collFloorRow = await pgPool.query(
          `SELECT MIN(price_eth) AS floor FROM listings WHERE collection_slug=$1`,
          [col.slug]
        ).catch(() => ({ rows: [] }));
        const floor = collFloorRow.rows[0]?.floor ? parseFloat(collFloorRow.rows[0].floor) : null;

        // Collection floor est. = held × floor (simple baseline always shown)
        const collFloorEst = (floor && held) ? held * floor : null;
        // Best est. = trait sweep if available, otherwise collection sweep, otherwise floor est.
        const bestEst = estValue ?? collFloorEst;
        const unrealizedPnl = (bestEst !== null && avgCost > 0) ? (bestEst - avgCost * held) : null;

        // ── Minted / Bought breakdown ─────────────────────────────────────────
        // Minted = token's very first on-chain transfer ever was from zero address
        // Bought = everything else acquired (secondary purchases)
        // Total ETH spent on buys = SUM(cost_eth) for non-minted acquired intervals
        // Burn contract address — survivors minted by this are NOT user mints
        // True mint = wallet was the FIRST EVER recipient of that token (not just from zero address).
        // For OCAS, every token transfer comes from zero address (including secondary sales),
        // so we detect mints by checking if the wallet received the token before anyone else ever did.
        // Burn survivors are excluded separately via burn_events.
        const acquisitionRes = await pgPool.query(
          `SELECT
             COUNT(DISTINCT CASE
               WHEN is_first_recipient.token_id IS NOT NULL
                AND wti.token_id NOT IN (
                  SELECT survivor_token_id FROM burn_events WHERE survivor_token_id IS NOT NULL AND LOWER(burner_wallet) = $1
                )
               THEN wti.token_id END) AS minted,
             COUNT(DISTINCT CASE
               WHEN is_first_recipient.token_id IS NULL
                OR wti.token_id IN (
                  SELECT survivor_token_id FROM burn_events WHERE survivor_token_id IS NOT NULL AND LOWER(burner_wallet) = $1
                )
               THEN wti.id END)       AS bought_intervals,
             COALESCE(SUM(CASE
               WHEN is_first_recipient.token_id IS NULL
                OR wti.token_id IN (
                  SELECT survivor_token_id FROM burn_events WHERE survivor_token_id IS NOT NULL AND LOWER(burner_wallet) = $1
                )
               THEN wti.cost_eth END), 0) AS total_buy_eth
           FROM wallet_token_intervals wti
           -- Check if wallet was the first-ever recipient of each token
           LEFT JOIN (
             SELECT DISTINCT nt.token_id
             FROM nft_transfers nt
             WHERE LOWER(nt.to_address) = $1
             AND NOT EXISTS (
               SELECT 1 FROM nft_transfers nt2
               WHERE nt2.token_id = nt.token_id
               AND (nt2.block_number < nt.block_number
                 OR (nt2.block_number = nt.block_number AND nt2.id < nt.id))
             )
           ) is_first_recipient ON is_first_recipient.token_id = wti.token_id
           WHERE LOWER(wti.wallet_address) = $1
             AND wti.collection_slug = $2`,
          [wallet, col.slug]
        ).catch(() => ({ rows: [{ minted: 0, bought_intervals: 0, total_buy_eth: 0 }] }));

        const minted       = parseInt(acquisitionRes.rows[0]?.minted          || 0);
        const boughtCount  = parseInt(acquisitionRes.rows[0]?.bought_intervals || 0);
        const totalBuyEth  = parseFloat(acquisitionRes.rows[0]?.total_buy_eth  || 0);

        cols.push({ name: col.name, slug: col.slug, held, sold, burned, burnEventCount,
                    floor, collFloorEst, estValue, bestEst, estMethod, avgCost,
                    unrealizedPnl, realizedPnl, totalEarned, minted, boughtCount, totalBuyEth });
      } catch(e){ console.warn('[WalletTab]', col.slug, e.message); }
    }
  }

  // ── Format helpers ───────────────────────────────────────────────────────────
  const fmtE = n => {
    if(!n && n !== 0) return '—';
    const abs = Math.abs(n);
    return (abs >= 1 ? abs.toFixed(3) : abs.toFixed(4));
  };
  const pnl = (n, showSign = true) => {
    if(!n && n !== 0) return '—';
    const sign = n >= 0 ? (showSign ? '+' : '') : '-';
    return `${sign}Ξ${fmtE(n)}`;
  };
  const pct = (gain, cost) => {
    if(!cost || cost === 0) return '';
    const p = (gain / (cost * Math.abs(gain / gain || 1))) * 100;
    const pp = ((gain / (cost * cols.find(c=>c.unrealizedPnl===gain)?.held || 1)) / (cost) * 100);
    return '';
  };

  // ── Build embed ──────────────────────────────────────────────────────────────
  if(!cols.length){
    const embed = new EmbedBuilder()
      .setTitle('💼 Wallet')
      .setColor(0x5865F2)
      .setDescription([
        `\`${shortWallet}\``,
        '',
        '_No holdings found. Tap **🔄 Sync Wallet** to load your portfolio._',
      ].join('\n'));
    return interaction[updateFn]({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('me_browse:wallet:sync').setLabel('🔄 Sync Wallet').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  const lines = [`\`${shortWallet}\``, ''];

  for(const c of cols){
    const unrealPct = (c.unrealizedPnl !== null && c.avgCost > 0 && c.bestEst !== null)
      ? ` (${c.unrealizedPnl >= 0 ? '+' : ''}${((c.unrealizedPnl / (c.avgCost * c.held)) * 100).toFixed(0)}%)`
      : '';

    lines.push(`**${c.name}**`);

    // Holdings + est value
    lines.push(`Holdings: **${c.held}** token${c.held === 1 ? '' : 's'}`);
    if(c.floor){
      // Always show floor line with collection floor est.
      // If trait est. is available and different, show it on same line
      if(c.estMethod === 'trait-sweep' && c.estValue !== null){
        lines.push(`Floor: **Ξ ${fmtE(c.floor)}** · Floor est.: **Ξ ${fmtE(c.collFloorEst)}** · Trait est.: **Ξ ${fmtE(c.estValue)}**`);
      } else {
        lines.push(`Floor: **Ξ ${fmtE(c.floor)}** · Est. value: **Ξ ${fmtE(c.bestEst)}**`);
      }
    }

    // Minted / Bought / Sold — full history from wallet backfill
    if(c.minted > 0)      lines.push(`Minted: **${c.minted}**`);
    if(c.boughtCount > 0) lines.push(`Bought: **${c.boughtCount}** · Spent: **Ξ ${fmtE(c.totalBuyEth)}**`);
    if(c.sold > 0)        lines.push(`Sold: **${c.sold}** · Earned: **Ξ ${fmtE(c.totalEarned)}**`);

    // Avg cost + unrealized P&L
    if(c.avgCost > 0){
      lines.push(`Avg. cost: **Ξ ${fmtE(c.avgCost)}** · Unrealized: **${pnl(c.unrealizedPnl)}${unrealPct}**`);
    }

    // Realized P&L
    if(c.sold > 0){
      lines.push(`Realized P&L: **${pnl(c.realizedPnl)}**`);
    }

    // Burned (no P&L)
    if(c.burned > 0){
      const evStr = c.burnEventCount > 0 ? ` (${c.burnEventCount} event${c.burnEventCount === 1 ? '' : 's'})` : '';
      lines.push(`Burned: **${c.burned}** tokens${evStr}`);
    }

    lines.push('');
  }

  // Totals row — use bestEst (trait sweep if available, else collection sweep/floor)
  if(cols.length > 1){
    const totalEst   = cols.reduce((a, c) => a + (c.bestEst || 0), 0);
    const totalUnreal = cols.filter(c => c.unrealizedPnl !== null && c.avgCost > 0).reduce((a, c) => a + c.unrealizedPnl, 0);
    const totalReal  = cols.reduce((a, c) => a + c.realizedPnl, 0);

    lines.push('─────────────────');
    lines.push(`Total Est. Value: **Ξ ${fmtE(totalEst)}**`);
    const hasUnreal = cols.some(c => c.avgCost > 0);
    if(hasUnreal) lines.push(`Unrealized: **${pnl(totalUnreal)}** · Realized: **${pnl(totalReal)}**`);
    lines.push('');
  }

  lines.push(`[📊 Full analytics on TraitView](https://traitview.com/wallet/${wallet})`);

  const embed = new EmbedBuilder()
    .setTitle('💼 Portfolio')
    .setColor(cols.some(c => c.unrealizedPnl > 0) ? 0x57F287 : 0x5865F2)
    .setDescription(lines.join('\n'));

  return interaction[updateFn]({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('me_browse:wallet:sync').setLabel('🔄 Sync').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    )],
  });
}

// ── /me interaction handler ───────────────────────────────────────────────────
async function handleMeInteraction(interaction, ctx){
  const { getAlert, setAlert, deleteAlert, getConfig, pgPool, getSyncStatus, syncWalletForUser } = ctx;
  const customId = interaction.customId;

  // Nav dropdown
  if(customId === 'me_browse:nav'){
    const section = interaction.values[0];
    if(section === 'trait_alert') return showMeTraitAlert(interaction, ctx);
    if(section === 'price_alerts') return showMePriceAlerts(interaction, ctx);
    if(section === 'floor_alerts') return showMeFloorAlerts(interaction, ctx);
    if(section === 'wallet') return showMeWallet(interaction, ctx);
    if(section === 'traitview') return showMeTraitView(interaction, ctx);
  }

  // Back to hub
  if(customId === 'me_browse:back') return showMeHub(interaction, ctx);
  if(customId === 'me_browse:traitview') return showMeTraitView(interaction, ctx);
  if(customId === 'me_browse:tv:generate') return handleTVGenerateCode(interaction, ctx);
  if(customId === 'me_browse:tv:enter') return handleTVEnterCode(interaction, ctx);

  // ── Trait alert ──────────────────────────────────────────────────────────────
  if(customId === 'me_browse:alert:set'){
    const guildId = interaction.guildId;
    const config = getConfig(guildId) || {};
    const allCols = [];
    const primarySlug = config.collectionSlug || config.slug;
    if(primarySlug) allCols.push({ slug: primarySlug, name: config.contractName || primarySlug });
    for(const c of config.collections || []) { if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }
    if(!allCols.length) return interaction.update({ content: 'No collections configured on this server.', embeds:[], components:[] });
    if(allCols.length === 1) return showMaTraitPicker(interaction, ctx, allCols[0].slug);
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ma_browse:col')
      .setPlaceholder('Pick a collection...')
      .addOptions(allCols.slice(0,25).map(c => new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug)));
    return interaction.update({ content: '**📣 Trait Alert** — Pick a collection:', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }

  if(customId === 'me_browse:alert:clear'){
    return showMaClearWizard(interaction, { getAlert, deleteAlert, setAlert });
  }

  // ── Price alerts ─────────────────────────────────────────────────────────────
  if(customId === 'me_browse:pricealert:set'){
    const guildId = interaction.guildId;
    const config = getConfig(guildId) || {};
    const allCols = [];
    const primarySlug = config.collectionSlug || config.slug;
    if(primarySlug) allCols.push({ slug: primarySlug, name: config.contractName || primarySlug });
    for(const c of config.collections || []) { if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }
    if(!allCols.length) return interaction.update({ content: 'No collections configured.', embeds:[], components:[] });
    if(allCols.length === 1) return showPriceAlertModal(interaction, allCols[0].slug);
    const menu = new StringSelectMenuBuilder()
      .setCustomId('me_browse:pricealert:col')
      .setPlaceholder('Pick a collection...')
      .addOptions(allCols.slice(0,25).map(c => new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug)));
    return interaction.update({ content: '**🏷️ Price Alert** — Pick a collection:', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }

  if(customId.startsWith('me_browse:pricealert:col')){
    return showPriceAlertModal(interaction, interaction.values[0]);
  }

  if(customId.startsWith('me_browse:pricealert:remove:')){
    const id = parseInt(customId.split(':').pop());
    await pgPool.query(`DELETE FROM user_price_alerts WHERE id=$1 AND discord_id=$2`, [id, interaction.user.id]).catch(()=>{});
    return showMePriceAlerts(interaction, ctx);
  }

  if(customId === 'me_browse:pricealert:clearall'){
    await pgPool.query(`DELETE FROM user_price_alerts WHERE discord_id=$1`, [interaction.user.id]).catch(()=>{});
    return showMePriceAlerts(interaction, ctx);
  }

  // ── Floor alerts ─────────────────────────────────────────────────────────────
  if(customId === 'me_browse:flooralert:set'){
    const guildId = interaction.guildId;
    const config = getConfig(guildId) || {};
    const allCols = [];
    const primarySlug = config.collectionSlug || config.slug;
    if(primarySlug) allCols.push({ slug: primarySlug, name: config.contractName || primarySlug });
    for(const c of config.collections || []) { if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }
    if(!allCols.length) return interaction.update({ content: 'No collections configured.', embeds:[], components:[] });
    if(allCols.length === 1) return showFloorAlertModal(interaction, allCols[0].slug);
    const menu = new StringSelectMenuBuilder()
      .setCustomId('me_browse:flooralert:col')
      .setPlaceholder('Pick a collection...')
      .addOptions(allCols.slice(0,25).map(c => new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug)));
    return interaction.update({ content: '**📉 Floor Alert** — Pick a collection:', embeds:[], components:[new ActionRowBuilder().addComponents(menu)] });
  }

  if(customId.startsWith('me_browse:flooralert:col')){
    return showFloorAlertModal(interaction, interaction.values[0]);
  }

  if(customId.startsWith('me_browse:flooralert:remove:')){
    const id = parseInt(customId.split(':').pop());
    await pgPool.query(`DELETE FROM user_floor_alerts WHERE id=$1 AND discord_id=$2`, [id, interaction.user.id]).catch(()=>{});
    return showMeFloorAlerts(interaction, ctx);
  }

  if(customId === 'me_browse:flooralert:clearall'){
    await pgPool.query(`DELETE FROM user_floor_alerts WHERE discord_id=$1`, [interaction.user.id]).catch(()=>{});
    return showMeFloorAlerts(interaction, ctx);
  }

  // ── Wallet sync ─────────────────────────────────────────────────────────────
  if(customId === 'me_modal:tv:enter_code'){
    // User entered a code from TraitView
    const code = (interaction.fields?.getTextInputValue('tv_code') || '').trim().toUpperCase();
    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    await interaction.deferReply({ ephemeral: true }).catch(()=>{});

    const row = await pgPool.query(
      `SELECT discord_id, wallet, guild_id, expires_at, claimed_at, direction
       FROM tv_verify_codes WHERE code=$1`,
      [code]
    ).catch(()=>null);

    const entry = row?.rows[0];
    const errEmbed = (msg) => new EmbedBuilder().setTitle('📊 TraitView').setColor(0xED4245).setDescription(msg);

    if(!entry) return interaction.editReply({ embeds: [errEmbed('❌ Invalid code. Check the code on TraitView and try again.')] });
    if(entry.claimed_at) return interaction.editReply({ embeds: [errEmbed('❌ This code has already been used.')] });
    if(new Date(entry.expires_at) < new Date()) return interaction.editReply({ embeds: [errEmbed('❌ This code has expired. Generate a new one on TraitView.')] });

    // Claim it
    await pgPool.query(`UPDATE tv_verify_codes SET claimed_at=NOW() WHERE code=$1`, [code]).catch(()=>{});

    // Get wallet from user_registrations (the person entering the code must be verified)
    const walletRow = await pgPool.query(
      `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
      [userId]
    ).catch(()=>null);
    const wallet = walletRow?.rows[0]?.wallet;
    if(!wallet) return interaction.editReply({ embeds: [errEmbed('❌ You need to verify your wallet first.')] });

    await pgPool.query(
      `INSERT INTO traitview_links (discord_id, guild_id, wallet, linked_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (discord_id, guild_id) DO UPDATE SET wallet=$3, linked_at=NOW()`,
      [userId, guildId, wallet]
    ).catch(()=>{});

    return interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('📊 TraitView').setColor(0x57F287)
        .setDescription(`✅ **TraitView linked successfully!**\n\nWallet: \`${wallet.slice(0,6)}...${wallet.slice(-4)}\`\nYour portfolio data is now available on TraitView.`)],
    });
  }

  if(customId === 'me_browse:wallet:sync'){
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    if(!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(()=>{});
    const editWalletSync = payload => interaction.editReply(payload).catch(()=>{});

    // Check if verified first
    const reg = await pgPool.query(
      `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
      [userId]
    ).catch(()=>null);
    const wallet = reg?.rows[0]?.wallet;

    if(!wallet){
      return editWalletSync({
        embeds: [new EmbedBuilder().setTitle('💼 Wallet').setColor(0xED4245).setDescription('❌ No verified wallet found. Verify your wallet first.')],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary))],
      });
    }

    // Build collection list to show in progress
    const config = getConfig(guildId) || {};
    const syncCols = getServerCollectionsForWalletSync(config).map(c => c.name || c.slug);

    // Fire-and-forget — don't await
    const { syncWalletForUser } = ctx;
    if(syncWalletForUser){
      syncWalletForUser(userId, guildId, pgPool, process.env.ALCHEMY_API_KEY, getConfig).catch(e => {
        console.warn('[WalletSync]', e.message);
      });
    }

    // Show initial progress screen
    const progressLines = syncCols.map(n => `⏳ ${n}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('me_browse:wallet:progress').setLabel('🔃 Check Progress').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    );
    return editWalletSync({
      embeds: [new EmbedBuilder()
        .setTitle('💼 Wallet — Syncing')
        .setColor(0x5865F2)
        .setDescription([
          `🔄 Syncing wallet \`${wallet.slice(0,6)}...${wallet.slice(-4)}\``,
          '',
          ...progressLines,
          '',
          'Tap **🔃 Check Progress** to update.',
        ].join('\n'))],
      components: [row],
    });
  }

  // Check sync progress
  if(customId === 'me_browse:wallet:progress'){
    const userId = interaction.user.id;
    const { getSyncStatus } = ctx;
    if(!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(()=>{});
    const editWalletProgress = payload => interaction.editReply(payload).catch(()=>{});
    let statusRows = [];
    try {
      if(getSyncStatus) statusRows = await getSyncStatus(userId, pgPool);
    } catch(e) { console.warn('[WalletProgress]', e.message); }

    if(!statusRows.length){
      // No sync status found — likely table not created yet or sync hasn't started
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('me_browse:wallet:sync').setLabel('🔄 Sync Wallet').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
      );
      return editWalletProgress({
        embeds: [new EmbedBuilder().setTitle('💼 Wallet').setColor(0x5865F2)
          .setDescription('No sync data found yet. Tap **🔄 Sync Wallet** to start.')],
        components: [row],
      });
    }

    const done = statusRows.filter(r => r.status === 'done').length;
    const total = statusRows.length;
    const allDone = done === total;

    const progressLines = statusRows.map(r => {
      if(r.status === 'done') return `✅ ${r.slug}${r.token_count > 0 ? ` (${r.token_count} held)` : ' (0 found)'}`;
      if(r.status === 'error') return `❌ ${r.slug} — sync error`;
      return `⏳ ${r.slug} — syncing...`;
    });

    if(allDone){
      const totalHeld = statusRows.reduce((a, r) => a + (r.token_count || 0), 0);
      if(totalHeld > 0){
        // Data found — show wallet tab
        return showMeWallet(interaction, ctx);
      }
      // All done but 0 tokens found — show progress summary so user can see what happened
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('me_browse:wallet:sync').setLabel('🔄 Re-sync').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
      );
      return editWalletProgress({
        embeds: [new EmbedBuilder()
          .setTitle('💼 Wallet — Sync Complete')
          .setColor(0x5865F2)
          .setDescription([
            `Sync finished — no token holdings found.`,
            '',
            ...progressLines,
            '',
            'If you hold tokens in these collections, try **🔄 Re-sync**.',
            'If the issue persists check Railway logs for `[WalletBackfill]` entries.',
          ].join('\n'))],
        components: [row],
      });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('me_browse:wallet:progress').setLabel('🔃 Check Progress').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    );
    return editWalletProgress({
      embeds: [new EmbedBuilder()
        .setTitle(`💼 Wallet — Syncing (${done}/${total})`)
        .setColor(0x5865F2)
        .setDescription([
          `Syncing ${total} collection${total===1?'':'s'}...`,
          '',
          ...progressLines,
          '',
          allDone ? 'All done!' : 'Still syncing — tap Check Progress again in a moment.',
        ].join('\n'))],
      components: [row],
    });
  }

  // Direct wallet tab refresh
  if(customId === 'me_browse:wallet'){
    return showMeWallet(interaction, ctx);
  }
}

// ── Modal launchers ───────────────────────────────────────────────────────────
async function showPriceAlertModal(interaction, slug){
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = require('discord.js');
  const modal = new ModalBuilder().setCustomId(`me_modal:pricealert:${slug}`).setTitle(`Price Alert — ${slug}`);
  modal.addComponents(
    new AR().addComponents(new TextInputBuilder().setCustomId('token_id').setLabel('Token ID (e.g. 1234)').setStyle(TextInputStyle.Short).setRequired(true)),
    new AR().addComponents(new TextInputBuilder().setCustomId('threshold').setLabel('Alert when listed below (ETH, e.g. 0.05)').setStyle(TextInputStyle.Short).setRequired(true)),
    new AR().addComponents(new TextInputBuilder().setCustomId('once').setLabel('Alert once or repeat? (once / repeat)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('once')),
  );
  return interaction.showModal(modal);
}

async function showFloorAlertModal(interaction, slug){
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = require('discord.js');
  const modal = new ModalBuilder().setCustomId(`me_modal:flooralert:${slug}`).setTitle(`Floor Alert — ${slug}`);
  modal.addComponents(
    new AR().addComponents(new TextInputBuilder().setCustomId('threshold').setLabel('Floor threshold (ETH)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('0.05')),
    new AR().addComponents(new TextInputBuilder().setCustomId('direction').setLabel('Direction: below, above, or either').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('below')),
    new AR().addComponents(new TextInputBuilder().setCustomId('cooldown').setLabel('Min. repeat interval (e.g. 30m, 2h, 1d)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('1h')),
  );
  return interaction.showModal(modal);
}

module.exports = { handleMarketCommand, MARKET_COMMANDS, resolveCollectionFromServerCfg, isPaidFeature, handleTraitBrowseInteraction, handleMyAlertInteraction, showMaTraitPicker, handleMaClearInteraction, handleMeInteraction };