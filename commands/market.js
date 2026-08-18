'use strict';

const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const { STACKERS_SLUG, formatStackersFields } = require('../lib/stackers');
const { getWalletVaultSummary, getHeldTokenIds } = require('../lib/stackers-wallet-vault');
const { optimize } = require('../lib/stackers-optimizer');
const { getRecentRoundHistory } = require('../lib/stackers-analytics');
const fetch = require('node-fetch');
const { OWNER_DISCORD_IDS, OCAS_SLUG } = require('../lib/constants');
const { extractPngFromSvg, resolveImage } = require('../lib/images');
const { isDiscordOk } = require('../utils/format');
const { initSession: initValuePicker, getSession: getValuePickerSession, clearSession: clearValuePicker, buildStackedValuePickerRows, recordMenuSelection, parseValuePickerCustomId } = require('../lib/value-picker');

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
    // No explicit collection was given -- and there's currently no slash
    // command option to provide one anyway. Previously this just returned
    // whatever "primary" happened to be configured as, with no regard for
    // whether OCAS was even the primary slot. That's exactly how a server
    // with OCAS registered as a secondary/"extra" collection (and
    // something else as primary) silently swept the wrong collection with
    // no way to override it. Prefer OCAS specifically wherever it's
    // configured for this server; only fall back to "primary" as a last
    // resort when OCAS genuinely isn't configured here and there's more
    // than one other collection to choose between (fully ambiguous case).
    const ocasMatch = all.find(c => (c.slug||'').toLowerCase() === OCAS_SLUG);
    if(ocasMatch) return ocasMatch;
    if(all.length === 1) return all[0];
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
    const _lsCool = checkCommandCooldown(interaction.user.id, 'lastsale');
    if(_lsCool) return interaction.reply({content:`⏳ Please wait **${_lsCool}s** before using this command again.`, flags:MessageFlags.Ephemeral});
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
    const _rsCool = checkCommandCooldown(interaction.user.id, 'recentsales');
    if(_rsCool) return interaction.reply({content:`⏳ Please wait **${_rsCool}s** before using this command again.`, flags:MessageFlags.Ephemeral});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=${count}`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply('No sales found.');return;}
      const cfg={...config,slug};
      const embeds=[];
      for(const s of sales.reverse()){ const e=await buildSaleEmbed(s,cfg).catch(()=>null); if(e) embeds.push(e); }
      await postEmbeds(interaction, embeds, `Last ${sales.length} sales for **${slug}**:`);
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
          const dbMeta = await fetchTokenMetaFromDb(sale.token_id, slug).catch(()=>null);
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
        const dbMeta = await fetchTokenMetaFromDb(tokenId, slug).catch(()=>null);
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
    const _liCool = checkCommandCooldown(interaction.user.id, 'listings');
    if(_liCool) return interaction.reply({content:`⏳ Please wait **${_liCool}s** before using this command again.`, flags:MessageFlags.Ephemeral});
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
    if(!OWNER_DISCORD_IDS.has(String(interaction.user.id))) return interaction.reply({content:'❌ Owner only.', flags: MessageFlags.Ephemeral});
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
      return interaction.reply({
        content: '**🔔 My Alert** — Pick a collection:',
        components: buildCollectionPickerRows(allCols, 'ma_browse:col'),
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
    if(!RAILWAY_URL) return interaction.reply({ content: 'RAILWAY_API_URL not configured.', flags: MessageFlags.Ephemeral });

    const _rfColInput  = interaction.options.getString('collection') || null;

    // No rank range given at all — launch the guided flow: collection
    // picker first (only if the server has more than one configured and
    // none was explicitly given), then a modal for min/max rank, then a
    // follow-up menu for mode + sort.
    const noRankArgsGiven = interaction.options.getInteger('min_rank') == null && interaction.options.getInteger('max_rank') == null;
    if(noRankArgsGiven){
      if(_rfColInput){
        return showRfRankModal(interaction, _rfColInput);
      }
      const allCols = [];
      const primarySlug = config.collectionSlug || config.slug;
      if(primarySlug) allCols.push({ slug: primarySlug, name: config.contractName || primarySlug });
      for(const c of config.collections || []) { if(c.slug) allCols.push({ slug: c.slug, name: c.name || c.slug }); }
      if(!allCols.length) allCols.push({ slug: 'on-chain-all-stars', name: 'OCAS' });
      if(allCols.length === 1){
        return showRfRankModal(interaction, allCols[0].slug);
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId('rf_browse:col')
        .setPlaceholder('Pick a collection...')
        .addOptions(allCols.slice(0, 25).map(c =>
          new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug)
        ));
      return interaction.reply({
        content: '**🏆 Rank Find** — Pick a collection:',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
    }

    const rankMin  = interaction.options.getInteger('min_rank') || 1;
    const rankMax  = interaction.options.getInteger('max_rank') || 100;
    const modeRf   = interaction.options.getString('mode') || 'listings';
    const sortBy   = interaction.options.getString('sort') || 'price';
    const _rfResolved  = resolveCollectionFromServerCfg(config, _rfColInput);
    const rfSlug       = _rfResolved?.slug || config.collectionSlug || config.slug;

    if(rankMin < 1 || rankMax > 1_000_000 || rankMin > rankMax) return interaction.reply({ content: 'Invalid rank range. min_rank must be ≤ max_rank and within 1–1,000,000.', flags: MessageFlags.Ephemeral });

    await interaction.deferReply();
    return runRankFindSearch(interaction, ctx, config, { rankMin, rankMax, modeRf, sortBy, rfSlug, _rfResolved });
  }

  if(commandName==='sweep'){
    const sweepColInput = interaction.options.getString('collection') || null;
    const sweepResolved = resolveCollectionFromServerCfg(config, sweepColInput);
    const sweepConfig = sweepResolved ? {...config, ...sweepResolved} : config;
    if(isPaidFeature(sweepConfig, 'sweep', interaction.user.id))
      return interaction.reply({content:'🧹 Sweep commands require a paid tier for non-OCAS collections. Visit traitview.com to upgrade.', flags: MessageFlags.Ephemeral});
    const _swCool = checkCommandCooldown(interaction.user.id, 'sweep');
    if(_swCool) return interaction.reply({content:`⏳ Please wait **${_swCool}s** before using this command again.`, flags:MessageFlags.Ephemeral});
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

      const sweepSlug = sweepConfig.slug || sweepConfig.collectionSlug || OCAS_SLUG;

      if(workingSearch && RAILWAY_URL){
        const traitIndex = await getTraitIndex(RAILWAY_URL, API_SECRET, sweepSlug);
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
           LEFT JOIN tokens t ON t.id = l.token_id AND t.collection_slug = $2
           WHERE l.collection_slug = $2
           ORDER BY l.price_eth ASC
           LIMIT $1`,
          [fetchLimit, sweepSlug]
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
        const qs = new URLSearchParams({ listed:'1', limit: String(fetchLimit), key: API_SECRET||'', slug: sweepSlug });
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
// Sorts trait category names with "Type" always first (most commonly searched),
// rest kept in original order. Used by both the trait-find and mispriced-alert pickers.
function sortTraitNamesTypeFirst(names){
  const idx = names.findIndex(n => n.toLowerCase() === 'type');
  if(idx <= 0) return names; // already first, or not present
  const copy = [...names];
  const [type] = copy.splice(idx, 1);
  copy.unshift(type);
  return copy;
}
// ── /rankfind guided flow ──────────────────────────────────────────────────
// Launched when /rankfind is run with no min_rank/max_rank given at all.
// Shows a modal (two plain-text fields, easier for the community to fill in
// correctly than a single "1-100" free-text field) then a follow-up menu
// for mode + sort, then runs the same search logic the direct-args path uses.
async function handleRfColPick(interaction, ctx){
  const slug = interaction.values[0];
  return showRfRankModal(interaction, slug);
}

function showRfRankModal(interaction, collectionInput){
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = require('discord.js');
  const modal = new ModalBuilder()
    .setCustomId(`rf_modal:range:${collectionInput || ''}`)
    .setTitle('Rank Find — Choose a Range');
  modal.addComponents(
    new AR().addComponents(new TextInputBuilder().setCustomId('min_rank').setLabel('Minimum Rank').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('1')),
    new AR().addComponents(new TextInputBuilder().setCustomId('max_rank').setLabel('Maximum Rank').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('100')),
  );
  return interaction.showModal(modal);
}

async function handleRankFindModalSubmit(interaction, ctx){
  const parts = interaction.customId.split(':');
  const collectionInput = parts.slice(2).join(':') || null;
  const rankMin = parseInt(interaction.fields.getTextInputValue('min_rank').trim(), 10);
  const rankMax = parseInt(interaction.fields.getTextInputValue('max_rank').trim(), 10);
  if(isNaN(rankMin) || isNaN(rankMax) || rankMin < 1 || rankMax > 1_000_000 || rankMin > rankMax){
    return interaction.reply({ content: '❌ Invalid rank range. Minimum and maximum must be numbers between 1–1,000,000, with minimum ≤ maximum.', flags: MessageFlags.Ephemeral });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`rf_browse:mode:${collectionInput || ''}:${rankMin}:${rankMax}`)
    .setPlaceholder('What do you want to see?')
    .addOptions([
      new StringSelectMenuOptionBuilder().setLabel('Listings — cheapest first').setValue('listings:price'),
      new StringSelectMenuOptionBuilder().setLabel('Listings — best rank first').setValue('listings:rank'),
      new StringSelectMenuOptionBuilder().setLabel('Sales').setValue('sales:price'),
    ]);
  return interaction.reply({
    content: `**🏆 Rank Find — ⬥ #${rankMin}–#${rankMax}**\n\nWhat would you like to see?`,
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRankFindBrowseInteraction(interaction, ctx){
  const { getConfig } = ctx;
  const parts = interaction.customId.slice('rf_browse:mode:'.length).split(':');
  const collectionInput = parts[0] || null;
  const rankMin = parseInt(parts[1], 10);
  const rankMax = parseInt(parts[2], 10);
  const [modeRf, sortBy] = interaction.values[0].split(':');

  const guildId = interaction.guildId;
  const config = getConfig(guildId) || {};
  const _rfResolved = resolveCollectionFromServerCfg(config, collectionInput);
  const rfSlug = _rfResolved?.slug || config.collectionSlug || config.slug;

  await interaction.update({ content: `🔍 Searching **⬥ #${rankMin}–#${rankMax}**...`, components: [] });
  return runRankFindSearch(interaction, ctx, config, { rankMin, rankMax, modeRf, sortBy, rfSlug, _rfResolved });
}

async function runRankFindSearch(interaction, ctx, config, { rankMin, rankMax, modeRf, sortBy, rfSlug, _rfResolved }){
  const { getRailwayApiUrl, fetchBotApiJson, buildSaleEmbed, postEmbeds, traitObjectToArray,
          fetchTokenMetaFromDb, getRankTierColor, COLORS, resolveImage, traitDisplayLines, resolveOnChainImage } = ctx;
  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET  = process.env.API_SECRET;
  const wantSales = modeRf === 'sales';
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
      const dbMeta = await fetchTokenMetaFromDb(tokenId, rfSlug).catch(()=>null);
      const tokenTraits = dbMeta?.traits
        ? traitObjectToArray(dbMeta.traits)
        : (l.traits && typeof l.traits==='object' ? traitObjectToArray(l.traits) : []);
      const priceStr = l.price_eth >= 1 ? l.price_eth.toFixed(3) : l.price_eth.toFixed(4);
      const rankBadge = l.os_rank ? ` ⬥${Number(l.os_rank).toLocaleString()}` : '';
      const tokenChain = dbMeta?.chain || 'ethereum';
      const tokenContract = dbMeta?.contract || contract;
      const listingUrl = l.url || `https://opensea.io/assets/${tokenChain}/${tokenContract}/${tokenId}`;
      const tvUrl = `https://traitview.com/?jump=${tokenId}`;
      const rankColor = getRankTierColor(l.os_rank) ?? COLORS.OPENSEA_BLUE;
      const embed = new EmbedBuilder()
        .setColor(rankColor)
        .setTitle(`${priceStr} ETH • #${tokenId}${rankBadge} • Listed`)
        .setURL(listingUrl)
        .setFooter({ text: `${rfSlug} · OS Rank #${rankMin}–#${rankMax} · ${sortBy==='rank'?'best rank first':'cheapest first'}` })
        .setTimestamp();
      const tvLink = `[OpenSea](${l.url}) · [TraitView](${tvUrl})`;
      if(tokenTraits.length){
        embed.setDescription(traitDisplayLines(tokenTraits, 8).join('\n') + '\n\n**Links**\n' + tvLink);
      } else { embed.setDescription('**Links**\n' + tvLink); }
      if(rfSlug === STACKERS_SLUG){
        const stackersFields = await formatStackersFields(tokenId);
        if(stackersFields.length) embed.addFields(...stackersFields);
      }
      try{
        const onChainImage = dbMeta?.chain ? await resolveOnChainImage(tokenContract, String(tokenId), dbMeta.chain).catch(() => null) : null;
        embed._imageResult = onChainImage || await resolveImage({ identifier: String(tokenId) }, tokenContract, tokenChain);
      }catch(e){}
      return embed;
    }));
    const sortLabel = sortBy==='rank' ? 'best rank first' : 'cheapest first';
    await postEmbeds(interaction, rankEmbeds.filter(Boolean),
      `🏆 **OS Rank ⬥ #${rankMin}–#${rankMax}** — ${listings.length} listing${listings.length===1?'':'s'} (${sortLabel}):`);
  }catch(e){
    console.warn('[rankfind]', e.message);
    await interaction.editReply(`I could not load rank results from the TraitView API. ${e.message}`);
  }
}

async function showTfTraitPicker(interaction, ctx, slug, page = 0){
  const { getRailwayApiUrl, getCachedTraitIndex } = ctx;
  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET = process.env.API_SECRET;
  // Component interactions (select-menu clicks) are always fresh interaction
  // objects — interaction.replied/deferred on them is always false even
  // though the message they're attached to already exists. Using reply()
  // here would create a brand new ephemeral message every step instead of
  // editing the existing one. update() edits the message the component
  // lives on, which is what we want for every step after the initial
  // slash-command response.
  const isComponent = typeof interaction.isMessageComponent === 'function' && interaction.isMessageComponent();
  let traitIndex = [];
  try { traitIndex = await getCachedTraitIndex(RAILWAY_URL, API_SECRET, slug); } catch(e){ console.warn('[traitfind] getCachedTraitIndex failed:', e.message); }
  const allTraitNames = sortTraitNamesTypeFirst([...new Set(traitIndex.map(t => t.trait_name))]);
  const PAGE_SIZE = 24; // leave room for a "More categories" option as the 25th slot
  const totalPages = Math.max(1, Math.ceil(allTraitNames.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageNames = allTraitNames.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const hasNextPage = safePage < totalPages - 1;
  if(!pageNames.length){
    const replyFn = isComponent ? 'update' : (interaction.replied || interaction.deferred ? 'editReply' : 'reply');
    return interaction[replyFn]({ content: `No trait data found for **${slug}** yet. Make sure the collection is added via \`/config\`.`, flags: MessageFlags.Ephemeral });
  }
  const traitValueCounts = {};
  for(const t of traitIndex){
    if(!traitValueCounts[t.trait_name]) traitValueCounts[t.trait_name] = 0;
    traitValueCounts[t.trait_name]++;
  }
  const options = pageNames.map(n => new StringSelectMenuOptionBuilder()
    .setLabel(n)
    .setValue(n)
    .setDescription(`${traitValueCounts[n] || 0} value${traitValueCounts[n]===1?'':'s'}`)
  );
  if(hasNextPage){
    options.push(new StringSelectMenuOptionBuilder()
      .setLabel(`→ More categories (page ${safePage + 2} of ${totalPages})`)
      .setValue(`__next_page__:${safePage + 1}`)
      .setDescription('See remaining trait categories')
    );
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tf_browse:trait:${slug}`)
    .setPlaceholder('Pick a trait category...')
    .addOptions(options);
  const pageNote = totalPages > 1 ? ` (page ${safePage + 1} of ${totalPages})` : '';
  const replyFn = isComponent ? 'update' : (interaction.replied || interaction.deferred ? 'editReply' : 'reply');
  return interaction[replyFn]({
    content: `**🔍 Trait Find — ${slug}**\n\nPick a trait category${pageNote}:`,
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function showTfValuePicker(interaction, ctx, slug, traitName){
  const { getRailwayApiUrl, getCachedTraitIndex } = ctx;
  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET = process.env.API_SECRET;
  let traitIndex = [];
  try { traitIndex = await getCachedTraitIndex(RAILWAY_URL, API_SECRET, slug); } catch(e){ console.warn('[traitfind] getCachedTraitIndex failed:', e.message); }
  const matchingRows = traitIndex.filter(t => t.trait_name === traitName);
  if(!matchingRows.length){
    return interaction.update({ content: `No values found for **${traitName}**.`, components: [] });
  }

  // This used to silently slice(0, 25) with zero indication that anything
  // was hidden -- same underlying 25-option Discord limit as /config's
  // filter/trait-role pickers, just found in a third place. Stacked menus
  // let every value actually be reachable instead of quietly dropping the
  // rest.
  if(matchingRows.length > 25){
    const sessionKey = `${interaction.user.id}:traitfind:${slug}:${traitName}`;
    const allValues = matchingRows.map(r => r.trait_value);
    initValuePicker(sessionKey, allValues);
    const customIdPrefix = `traitfind:${encodeURIComponent(slug)}:${encodeURIComponent(traitName)}`;
    const { rows, truncatedNote } = buildStackedValuePickerRows(sessionKey, customIdPrefix, {
      placeholder: `Pick ${traitName} value(s)...`,
      cancelId: `tf_browse:trait:${slug}`,
    });
    return interaction.update({
      content: `**🔍 Trait Find — ${slug} › ${traitName}**\n\nPick one or more values (matches ANY selected)${truncatedNote}\n\nPick from as many of the menus below as you want, then Done.`,
      components: rows,
    });
  }

  const valueRows = matchingRows;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tf_browse:val:${slug}:${traitName}`)
    .setPlaceholder(`Pick 1-${valueRows.length} ${traitName} value(s)...`)
    .setMinValues(1)
    .setMaxValues(valueRows.length)
    .addOptions(valueRows.map(r => new StringSelectMenuOptionBuilder()
      .setLabel(r.trait_value)
      .setValue(r.trait_value)
      .setDescription(`${r.token_count} token${r.token_count===1?'':'s'}`)
    ));
  return interaction.update({
    content: `**🔍 Trait Find — ${slug} › ${traitName}**\n\nPick one or more values (matches ANY selected):`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function showTfModePicker(interaction, ctx, slug, traitName, traitValues){
  const { getRailwayApiUrl, fetchBotApiJson } = ctx;
  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET = process.env.API_SECRET;
  const valuesArr = Array.isArray(traitValues) ? traitValues : [traitValues];
  const valueLabel = valuesArr.join(' or ');
  // Group is one OR-set: [{trait_name, trait_value}, {trait_name, trait_value}, ...]
  // matches ANY of the selected values for this trait category.
  const group = valuesArr.map(v => ({ trait_name: traitName, trait_value: v }));
  let tokenCount = '?', listingCount = '?', salesCount = '?';
  try {
    const qs = new URLSearchParams({ slug, key: API_SECRET||'' });
    qs.set('groups', JSON.stringify([group]));
    const salesQs = new URLSearchParams({ trait: traitName, value: valuesArr[0], limit:'1', key: API_SECRET||'' });
    const [tokRes, lstRes, salRes] = await Promise.all([
      fetchBotApiJson(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}`, 'mode-count-tokens').catch(()=>null),
      fetchBotApiJson(`${RAILWAY_URL}/db/multi-trait-tokens?${qs}&listed=1`, 'mode-count-listed').catch(()=>null),
      fetchBotApiJson(`${RAILWAY_URL}/db/trait-sales?${salesQs}`, 'mode-count-sales').catch(()=>null),
    ]);
    if(tokRes?.tokens) tokenCount = tokRes.tokens.length >= 20 ? '20+' : String(tokRes.tokens.length);
    if(lstRes?.tokens) listingCount = String(lstRes.tokens.length);
    if(salRes?.count != null) salesCount = String(salRes.count);
  } catch(e) {}
  // Encode multiple values with | separator (safe — trait values don't contain |)
  const encodedValues = valuesArr.map(v => encodeURIComponent(v)).join('|');
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tf_browse:mode:${slug}:${traitName}:${encodedValues}`)
    .setPlaceholder('What do you want to see?')
    .addOptions([
      new StringSelectMenuOptionBuilder().setLabel('Tokens').setDescription(`${tokenCount} token${tokenCount==='1'?'':'s'} with this trait`).setValue('tokens'),
      new StringSelectMenuOptionBuilder().setLabel('Listings').setDescription(`${listingCount} listed — cheapest first`).setValue('listings'),
      new StringSelectMenuOptionBuilder().setLabel('Sales').setDescription(`${salesCount} sale${salesCount==='1'?'':'s'} in history (first value only)`).setValue('sales'),
    ]);
  return interaction.update({
    content: `**🔍 Trait Find — ${slug} › ${traitName}: ${valueLabel}**\n\nWhat would you like to see?`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

// ── /traitfind browse flow — select menu follow-ups ───────────────────────────
async function handleTraitBrowseInteraction(interaction, ctx){
  const { pgPool, getConfig, getRailwayApiUrl, getCachedTraitIndex,
          buildSaleEmbed, buildListingEmbed, postEmbeds, fetchBotApiJson,
          buildTokenSearchEmbed, fetchTokenMetaFromDb, traitObjectToArray } = ctx;
  const customId = interaction.customId;

  if(customId.startsWith('vpick:traitfind:')){
    try{
      const parsed = parseValuePickerCustomId(customId);
      if(!parsed){
        return interaction.update({ content: '❌ Something went wrong with this picker. Please start over.', components:[] });
      }
      const { action, customIdPrefix } = parsed;
      const [, encSlug, encTraitName] = customIdPrefix.split(':');
      const slug = decodeURIComponent(encSlug);
      const traitName = decodeURIComponent(encTraitName);
      const sessionKey = `${interaction.user.id}:traitfind:${slug}:${traitName}`;
      const session = getValuePickerSession(sessionKey);
      if(!session){
        return interaction.update({ content: '❌ This picker session expired (likely a bot restart mid-flow). Please start over.', components:[] });
      }

      if(action === 'sel'){
        recordMenuSelection(sessionKey, parsed.menuIndex, interaction.values || []);
        const { rows, truncatedNote } = buildStackedValuePickerRows(sessionKey, customIdPrefix, {
          placeholder: `Pick ${traitName} value(s)...`,
          cancelId: `tf_browse:trait:${slug}`,
        });
        return interaction.update({
          content: `**🔍 Trait Find — ${slug} › ${traitName}**\n\nPick one or more values (matches ANY selected)${truncatedNote}\n\nPick from as many of the menus below as you want, then Done.`,
          components: rows,
        });
      }

      if(action === 'done'){
        const selectedValues = [...session.selected];
        clearValuePicker(sessionKey);
        if(!selectedValues.length){
          return interaction.update({ content: `No values were selected for **${traitName}**. Please start over if you want to search.`, components:[] });
        }
        return showTfModePicker(interaction, ctx, slug, traitName, selectedValues);
      }
    }catch(e){
      console.error('[TraitFind] vpick dispatcher error:', e);
      return interaction.update({ content: `❌ Something went wrong: ${e.message || 'unknown error'}. Please try again.`, components:[] }).catch(()=>{});
    }
  }

  if(customId === 'tf_browse:col'){
    const slug = interaction.values[0];
    try{
      return await showTfTraitPicker(interaction, ctx, slug);
    }catch(e){
      console.error('[tf_browse:col]', e.message);
      return interaction.update({ content: `❌ Could not load traits for **${slug}**: ${e.message}`, components:[] }).catch(()=>{});
    }
  }

  if(customId.startsWith('tf_browse:trait:')){
    const slug = customId.slice('tf_browse:trait:'.length);
    const selected = interaction.values[0];
    if(selected.startsWith('__next_page__:')){
      const nextPage = parseInt(selected.split(':')[1], 10) || 0;
      return showTfTraitPicker(interaction, ctx, slug, nextPage);
    }
    return showTfValuePicker(interaction, ctx, slug, selected);
  }

  if(customId.startsWith('tf_browse:val:')){
    const parts = customId.slice('tf_browse:val:'.length).split(':');
    const slug = parts[0];
    const traitName = parts.slice(1).join(':');
    const traitValues = interaction.values; // array — one or more selected
    return showTfModePicker(interaction, ctx, slug, traitName, traitValues);
  }

  if(customId.startsWith('tf_browse:mode:')){
    const parts = customId.slice('tf_browse:mode:'.length).split(':');
    const slug = parts[0];
    const traitName = parts[1];
    const encodedValues = parts.slice(2).join(':');
    const traitValuesArr = encodedValues.split('|').map(v => decodeURIComponent(v));
    const traitValue = traitValuesArr[0]; // used for sales mode (single-value only) and labels
    const mode = interaction.values[0];
    const matchLabel = traitValuesArr.length > 1
      ? `${traitName}: ${traitValuesArr.join(' or ')}`
      : `${traitName}: ${traitValue}`;

    await interaction.update({ content: `🔍 Searching **${matchLabel}** in **${slug}** (${mode})...`, components: [] });

    const guildId = interaction.guildId;
    const config = getConfig(guildId) || {};
    const RAILWAY_URL = getRailwayApiUrl();
    const API_SECRET = process.env.API_SECRET;
    const _resolved = resolveCollectionFromServerCfg(config, slug);
    const cfg = _resolved ? { ...config, ..._resolved } : { ...config, slug };
    const want = 20;
    // One OR-group: matches ANY of the selected values for this trait
    const groups = [traitValuesArr.map(v => ({ trait_name: traitName, trait_value: v }))];

    // chain is a per-collection property, not per-token — one lookup covers
    // this whole batch. Needed so the synthetic _dbToken below (an existing
    // optimization to skip a redundant per-token DB call) doesn't silently
    // bypass the on-chain image fallback the way it did before this fix —
    // buildListingEmbed uses listing._dbToken directly when present, so
    // without chain here it never even attempts the on-chain read.
    const collChainInfo = await pgPool.query(`SELECT chain, contract FROM collections WHERE slug = $1`, [slug]).catch(() => ({ rows: [] }));
    const chainInfo = collChainInfo.rows[0] || null;

    try {
      if(mode === 'sales'){
        const qs = new URLSearchParams({ trait: traitName, value: traitValue, limit: '20', sort: 'desc' });
        if(API_SECRET) qs.set('key', API_SECRET);
        const j = await fetchBotApiJson(`${RAILWAY_URL}/db/trait-sales?${qs}`, '/db/trait-sales');
        const sales = j.sales || [];
        if(!sales.length){ await interaction.editReply({ content: `No sales found for **${matchLabel}**.`, components:[] }); return; }
        const saleEmbeds = await Promise.all(sales.slice(0,want).map(async sale => {
          const dbMeta = await fetchTokenMetaFromDb(sale.token_id, slug).catch(()=>null);
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
            _dbToken: { traits: t.traits||{}, obs_rank: t.obs_rank||null, os_rank: t.os_rank||null, chain: chainInfo?.chain||null, contract: chainInfo?.contract||null },
          };
          return buildListingEmbed(fakeListingObj, cfg).catch(()=>null);
        }
        const dbMeta = await fetchTokenMetaFromDb(tokenId, slug).catch(()=>null);
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
// Shared "pick a collection" stacked single-select -- all four call sites
// building this exact kind of menu had the same silent slice(0,25) cap, low
// risk in practice (a server realistically configuring 25+ collections is
// unlikely) but fixed the same way as everywhere else for consistency.
function buildCollectionPickerRows(allCols, baseCustomId){
  const CHUNK = 25;
  const menuCount = Math.min(4, Math.ceil(allCols.length / CHUNK));
  const rows = [];
  for(let i = 0; i < menuCount; i++){
    const slice = allCols.slice(i * CHUNK, (i + 1) * CHUNK);
    if(!slice.length) break;
    const opts = slice.map(c => new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.slug));
    const m = new StringSelectMenuBuilder()
      .setCustomId(`${baseCustomId}:${i}`)
      .setPlaceholder(menuCount > 1 ? `Collections (menu ${i + 1} of ${menuCount})` : 'Pick a collection...')
      .addOptions(opts);
    rows.push(new ActionRowBuilder().addComponents(m));
  }
  return rows;
}

async function showMaTraitPicker(interaction, ctx, slug, page = 0){
  const { getRailwayApiUrl, getCachedTraitIndex } = ctx;
  const RAILWAY_URL = getRailwayApiUrl();
  const API_SECRET = process.env.API_SECRET;
  let traitIndex = [];
  try { traitIndex = await getCachedTraitIndex(RAILWAY_URL, API_SECRET, slug); } catch(e){ console.warn('[traitfind] getCachedTraitIndex failed:', e.message); }
  const allTraitNames = sortTraitNamesTypeFirst([...new Set(traitIndex.map(t => t.trait_name))]);
  const PAGE_SIZE = 24;
  const totalPages = Math.max(1, Math.ceil(allTraitNames.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageNames = allTraitNames.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const hasNextPage = safePage < totalPages - 1;
  if(!pageNames.length){
    const replyFn = interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : (interaction.replied || interaction.deferred ? 'editReply' : 'reply');
    return interaction[replyFn]({ content: `No trait data found for **${slug}** yet.`, ...(replyFn !== 'update' ? { flags: MessageFlags.Ephemeral } : {}) });
  }
  const traitValueCounts = {};
  for(const t of traitIndex){ if(!traitValueCounts[t.trait_name]) traitValueCounts[t.trait_name]=0; traitValueCounts[t.trait_name]++; }
  const options = pageNames.map(n => new StringSelectMenuOptionBuilder()
    .setLabel(n).setValue(n)
    .setDescription(`${traitValueCounts[n]||0} value${traitValueCounts[n]===1?'':'s'}`)
  );
  if(hasNextPage){
    options.push(new StringSelectMenuOptionBuilder()
      .setLabel(`→ More categories (page ${safePage + 2} of ${totalPages})`)
      .setValue(`__next_page__:${safePage + 1}`)
      .setDescription('See remaining trait categories')
    );
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ma_browse:trait:${slug}`)
    .setPlaceholder('Pick a trait to filter by...')
    .addOptions(options);
  const pageNote = totalPages > 1 ? ` (page ${safePage + 1} of ${totalPages})` : '';
  const replyFn = interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : (interaction.replied || interaction.deferred ? 'editReply' : 'reply');
  const replyOpts = {
    content: `**🔔 My Alert — ${slug}**\n\nPick a trait to filter by${pageNote}:`,
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
  try { traitIndex = await getCachedTraitIndex(RAILWAY_URL, API_SECRET, slug); } catch(e){ console.warn('[traitfind] getCachedTraitIndex failed:', e.message); }
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

  if(customId.startsWith('ma_browse:col')){
    const slug = interaction.values[0];
    return showMaTraitPicker(interaction, ctx, slug);
  }
  if(customId.startsWith('ma_browse:trait:')){
    const slug = customId.slice('ma_browse:trait:'.length);
    const selected = interaction.values[0];
    if(selected.startsWith('__next_page__:')){
      const nextPage = parseInt(selected.split(':')[1], 10) || 0;
      return showMaTraitPicker(interaction, ctx, slug, nextPage);
    }
    return showMaValuePicker(interaction, ctx, slug, selected);
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
    new ButtonBuilder().setCustomId('mac_browse:toggle:sales').setLabel(alert.alertSales ? '🔕 Sales Off' : '🔔 Sales On').setStyle(alert.alertSales ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mac_browse:toggle:listings').setLabel(alert.alertListings ? '🔕 Listings Off' : '🔔 Listings On').setStyle(alert.alertListings ? ButtonStyle.Secondary : ButtonStyle.Success),
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
  if(customId.startsWith('mac_browse:toggle:')){
    const field = customId.slice('mac_browse:toggle:'.length); // 'sales' or 'listings'
    const alert = getAlert(interaction.user.id);
    if(!alert) return interaction.update({ content: 'No alert found.', embeds: [], components: [] });
    const updated = field === 'sales'
      ? { ...alert, alertSales: !alert.alertSales }
      : { ...alert, alertListings: !alert.alertListings };
    setAlert(interaction.user.id, updated);
    const filters = updated.traitFilters || {};
    const fmtF = f => Object.keys(f).length===0 ? 'none (all tokens)' :
      Object.entries(f).map(([k,v]) => `**${k}** = ${Array.isArray(v)?v.join(' OR '):v}`).join('\n');
    const embed = new EmbedBuilder()
      .setTitle('🔔 My Alert')
      .setColor(0x5865F2)
      .setDescription([
        `**Collection:** ${updated.slug||'any'}`,
        `**Sales DMs:** ${updated.alertSales ? '✅ on' : '❌ off'}`,
        `**Listing DMs:** ${updated.alertListings ? '✅ on' : '❌ off'}`,
        `**Filters:**`,
        fmtF(filters),
      ].join('\n'));
    const rows = [];
    const valueBtns3 = [];
    for(const [trait, val] of Object.entries(filters)){
      const vals = Array.isArray(val) ? val : [val];
      for(const v of vals){
        valueBtns3.push(
          new ButtonBuilder()
            .setCustomId(`mac_browse:val:${trait}:${v}`)
            .setLabel(`✕ ${trait}: ${v}`.slice(0, 80))
            .setStyle(ButtonStyle.Danger)
        );
      }
    }
    for(let i = 0; i < Math.min(valueBtns3.length, 16); i += 4){
      rows.push(new ActionRowBuilder().addComponents(valueBtns3.slice(i, i+4)));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mac_browse:toggle:sales').setLabel(updated.alertSales ? '🔕 Sales Off' : '🔔 Sales On').setStyle(updated.alertSales ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('mac_browse:toggle:listings').setLabel(updated.alertListings ? '🔕 Listings Off' : '🔔 Listings On').setStyle(updated.alertListings ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('mac_browse:all').setLabel('Remove Everything').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mac_browse:cancel').setLabel('Done').setStyle(ButtonStyle.Secondary),
    ));
    return interaction.update({ embeds: [embed], components: rows });
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
      new ButtonBuilder().setCustomId('mac_browse:toggle:sales').setLabel(alert.alertSales ? '🔕 Sales Off' : '🔔 Sales On').setStyle(alert.alertSales ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('mac_browse:toggle:listings').setLabel(alert.alertListings ? '🔕 Listings Off' : '🔔 Listings On').setStyle(alert.alertListings ? ButtonStyle.Secondary : ButtonStyle.Success),
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
    const pausedTag = alert.paused ? ' ⏸️ paused' : '';
    summaryLines.push(`📣 **Trait Alert** — ${alert.slug||'any'} · Sales: ${alert.alertSales?'✅':'❌'} · Listings: ${alert.alertListings?'✅':'❌'}${pausedTag}`);
    summaryLines.push(`  Filters: ${fmtF(alert.traitFilters)}`);
  } else {
    summaryLines.push('📣 **Trait Alert** — not set');
  }

  // Price alerts
  if(pgPool){
    const pa = await pgPool.query(
      `SELECT COUNT(*) FILTER (WHERE is_active) AS active_cnt, COUNT(*) FILTER (WHERE NOT is_active) AS paused_cnt FROM user_price_alerts WHERE discord_id=$1`, [userId]
    ).catch(()=>null);
    const activeCnt = parseInt(pa?.rows[0]?.active_cnt||0);
    const pausedCnt = parseInt(pa?.rows[0]?.paused_cnt||0);
    const paSummary = (activeCnt+pausedCnt) === 0 ? 'none set' : `${activeCnt} active${pausedCnt ? `, ${pausedCnt} ⏸️ paused` : ''}`;
    summaryLines.push(`🏷️ **Price Alerts** — ${paSummary}`);

    const fa = await pgPool.query(
      `SELECT slug, threshold_eth, is_active FROM user_floor_alerts WHERE discord_id=$1`, [userId]
    ).catch(()=>null);
    if(fa?.rows.length){
      summaryLines.push(`📉 **Floor Alerts** — ${fa.rows.map(r=>`${r.slug} < Ξ${parseFloat(r.threshold_eth).toFixed(3)}${r.is_active===false?' ⏸️':''}`).join(', ')}`);
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
      new StringSelectMenuOptionBuilder().setLabel('🥞 My Stackers').setDescription('Wallet summary, strategy optimizer, vault listing DMs').setValue('my_stackers'),
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
    alert.paused ? '**Status:** ⏸️ paused' : '',
    `**Filters:**`,
    fmtF(alert.traitFilters),
  ].filter(Boolean).join('\n') : 'No trait alert set.';

  const embed = new EmbedBuilder()
    .setTitle('📣 Trait Alert')
    .setColor(0x5865F2)
    .setDescription(desc);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me_browse:alert:set').setLabel('Add Alert').setStyle(ButtonStyle.Success),
  );
  if(alert){
    if(alert.paused){
      row.addComponents(new ButtonBuilder().setCustomId('me_browse:alert:resume').setLabel('▶️ Resume').setStyle(ButtonStyle.Success));
    } else {
      row.addComponents(new ButtonBuilder().setCustomId('me_browse:alert:pause').setLabel('⏸️ Pause').setStyle(ButtonStyle.Secondary));
    }
    row.addComponents(
      new ButtonBuilder().setCustomId('me_browse:alert:clear').setLabel('Manage / Clear').setStyle(ButtonStyle.Danger),
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );

  const updateFn = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  return interaction[updateFn]({ embeds: [embed], components: [row] });
}

async function showMePriceAlerts(interaction, ctx){
  const { pgPool } = ctx;
  const userId = interaction.user.id;

  if(pgPool){
    const res = await pgPool.query(
      `SELECT id, token_id, slug, threshold_eth, alert_once, repeat_alert, triggered_at, is_active FROM user_price_alerts WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [userId]
    ).catch(()=>null);
    if(res?.rows.length === 1){
      return showPriceAlertDetail(interaction, ctx, res.rows[0].id, res.rows[0]);
    }
    if(res?.rows.length > 1){
      const desc = res.rows.map(r => {
        const pausedTag = r.is_active === false ? ' ⏸️ *paused*' : '';
        return `**#${r.token_id}** (${r.slug}) — below Ξ ${parseFloat(r.threshold_eth).toFixed(4)} ${r.triggered_at?'✅ triggered':r.repeat_alert?'🔁 repeat':'1x'}${pausedTag}`;
      }).join('\n');
      const embed = new EmbedBuilder().setTitle('🏷️ Price Alerts').setColor(0x5865F2).setDescription(desc);
      const menu = new StringSelectMenuBuilder()
        .setCustomId('me_browse:pricealert:pick')
        .setPlaceholder('Pick an alert to manage...')
        .addOptions(res.rows.slice(0,25).map(r =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`#${r.token_id} (${r.slug}) — Ξ ${parseFloat(r.threshold_eth).toFixed(4)}`)
            .setDescription(r.is_active === false ? 'Paused' : 'Active')
            .setValue(String(r.id))
        ));
      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('me_browse:pricealert:set').setLabel('Add Price Alert').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('me_browse:pricealert:clearall').setLabel('Remove All').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
      );
      const updateFn = interaction.replied || interaction.deferred ? 'editReply' : 'update';
      return interaction[updateFn]({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), actionRow] });
    }
  }

  const embed = new EmbedBuilder().setTitle('🏷️ Price Alerts').setColor(0x5865F2).setDescription('No price alerts set.');
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me_browse:pricealert:set').setLabel('Add Price Alert').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );
  const updateFn = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  return interaction[updateFn]({ embeds: [embed], components: [actionRow] });
}

async function showPriceAlertDetail(interaction, ctx, alertId, preloaded){
  const { pgPool } = ctx;
  const userId = interaction.user.id;
  let r = preloaded;
  if(!r){
    const res = await pgPool.query(
      `SELECT id, token_id, slug, threshold_eth, alert_once, repeat_alert, triggered_at, is_active FROM user_price_alerts WHERE id=$1 AND discord_id=$2`,
      [alertId, userId]
    ).catch(()=>null);
    r = res?.rows[0];
  }
  if(!r) return showMePriceAlerts(interaction, ctx);

  const pausedTag = r.is_active === false ? '\n⏸️ *Paused*' : '';
  const desc = `**#${r.token_id}** (${r.slug}) — below Ξ ${parseFloat(r.threshold_eth).toFixed(4)}\n${r.triggered_at?'✅ Already triggered':r.repeat_alert?'🔁 Repeats':'Fires once'}${pausedTag}`;

  const embed = new EmbedBuilder().setTitle('🏷️ Price Alert').setColor(0x5865F2).setDescription(desc);
  const toggleBtn = r.is_active === false
    ? new ButtonBuilder().setCustomId(`me_browse:pricealert:resume:${r.id}`).setLabel('▶️ Resume').setStyle(ButtonStyle.Success)
    : new ButtonBuilder().setCustomId(`me_browse:pricealert:pause:${r.id}`).setLabel('⏸️ Pause').setStyle(ButtonStyle.Secondary);
  const removeBtn = new ButtonBuilder().setCustomId(`me_browse:pricealert:remove:${r.id}`).setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger);
  const backBtn = new ButtonBuilder().setCustomId('me_browse:pricealert:list').setLabel('← Back to list').setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder().addComponents(toggleBtn, removeBtn, backBtn);

  const updateFn = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  return interaction[updateFn]({ embeds: [embed], components: [row] });
}

async function showMeFloorAlerts(interaction, ctx){
  const { pgPool } = ctx;
  const userId = interaction.user.id;

  if(pgPool){
    const res = await pgPool.query(
      `SELECT id, slug, threshold_eth, cooldown_minutes, direction, last_alerted_at, is_active FROM user_floor_alerts WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [userId]
    ).catch(()=>null);
    if(res?.rows.length === 1){
      // Only one alert — no need to make the user pick, go straight to it.
      return showFloorAlertDetail(interaction, ctx, res.rows[0].id, res.rows[0]);
    }
    if(res?.rows.length > 1){
      const desc = res.rows.map(r => {
        const dir = r.direction || 'below';
        const arrow = dir === 'above' ? '📈' : dir === 'either' ? '↕️' : '📉';
        const pausedTag = r.is_active === false ? ' ⏸️ *paused*' : '';
        return `${arrow} **${r.slug}** — ${dir} Ξ ${parseFloat(r.threshold_eth).toFixed(4)}${pausedTag}`;
      }).join('\n');
      const embed = new EmbedBuilder().setTitle('📉 Floor Alerts').setColor(0x5865F2).setDescription(desc);
      const menu = new StringSelectMenuBuilder()
        .setCustomId('me_browse:flooralert:pick')
        .setPlaceholder('Pick an alert to manage...')
        .addOptions(res.rows.slice(0,25).map(r =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${r.slug} — ${(r.direction||'below')} Ξ ${parseFloat(r.threshold_eth).toFixed(4)}`)
            .setDescription(r.is_active === false ? 'Paused' : 'Active')
            .setValue(String(r.id))
        ));
      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('me_browse:flooralert:set').setLabel('Add Floor Alert').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('me_browse:flooralert:clearall').setLabel('Remove All').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
      );
      const updateFn = interaction.replied || interaction.deferred ? 'editReply' : 'update';
      return interaction[updateFn]({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), actionRow] });
    }
  }

  const embed = new EmbedBuilder().setTitle('📉 Floor Alerts').setColor(0x5865F2).setDescription('No floor alerts set.');
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me_browse:flooralert:set').setLabel('Add Floor Alert').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );
  const updateFn = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  return interaction[updateFn]({ embeds: [embed], components: [actionRow] });
}

async function showFloorAlertDetail(interaction, ctx, alertId, preloaded){
  const { pgPool } = ctx;
  const userId = interaction.user.id;
  let r = preloaded;
  if(!r){
    const res = await pgPool.query(
      `SELECT id, slug, threshold_eth, cooldown_minutes, direction, last_alerted_at, is_active FROM user_floor_alerts WHERE id=$1 AND discord_id=$2`,
      [alertId, userId]
    ).catch(()=>null);
    r = res?.rows[0];
  }
  if(!r) return showMeFloorAlerts(interaction, ctx);

  const dir = r.direction || 'below';
  const arrow = dir === 'above' ? '📈' : dir === 'either' ? '↕️' : '📉';
  const pausedTag = r.is_active === false ? '\n⏸️ *Paused*' : '';
  const desc = `${arrow} **${r.slug}** — ${dir} Ξ ${parseFloat(r.threshold_eth).toFixed(4)}\nRepeats after ${formatCooldown(r.cooldown_minutes||60)}${r.last_alerted_at?'\nLast alerted '+new Date(r.last_alerted_at).toLocaleDateString():''}${pausedTag}`;

  const embed = new EmbedBuilder().setTitle('📉 Floor Alert').setColor(0x5865F2).setDescription(desc);
  const toggleBtn = r.is_active === false
    ? new ButtonBuilder().setCustomId(`me_browse:flooralert:resume:${r.id}`).setLabel('▶️ Resume').setStyle(ButtonStyle.Success)
    : new ButtonBuilder().setCustomId(`me_browse:flooralert:pause:${r.id}`).setLabel('⏸️ Pause').setStyle(ButtonStyle.Secondary);
  const removeBtn = new ButtonBuilder().setCustomId(`me_browse:flooralert:remove:${r.id}`).setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger);
  const backBtn = new ButtonBuilder().setCustomId('me_browse:flooralert:list').setLabel('← Back to list').setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder().addComponents(toggleBtn, removeBtn, backBtn);

  const updateFn = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  return interaction[updateFn]({ embeds: [embed], components: [row] });
}


// ── TraitView↔Discord verification ───────────────────────────────────────────
function generateTVCode() {
  // 6-char alphanumeric code, uppercase, no ambiguous chars (0/O, 1/I/L)
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for(let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function showMeStackersHub(interaction, ctx) {
  const { getVaultDmOptIns } = require('../lib/stackers-vault-listing-alerts');
  const { pgPool } = ctx;
  const userId = interaction.user.id;

  const updateFn = interaction.deferred || interaction.replied ? 'editReply'
    : (interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : 'editReply');

  const optIns = await getVaultDmOptIns();
  const isOn = !!optIns[userId];

  const verifiedRes = pgPool ? await pgPool.query(
    `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
    [userId]
  ).catch(() => ({ rows: [] })) : { rows: [] };
  const wallet = verifiedRes.rows[0]?.wallet || null;

  const lines = [];

  if(wallet){
    const shortAddr = `${wallet.slice(0,6)}...${wallet.slice(-4)}`;
    lines.push(`💼 **Wallet:** \`${shortAddr}\``);

    const summary = await getWalletVaultSummary(wallet).catch(() => null);
    if(summary && summary.tokenCount){
      lines.push('');
      lines.push(`🏦 **Unclaimed Vault** — across ${summary.tokenCount} held Stacker${summary.tokenCount === 1 ? '' : 's'}:`);
      lines.push(summary.totals.length
        ? summary.totals.map(t => `  ${t.amount.toFixed(4)} ${t.symbol}`).join('\n')
        : '  Empty across all held tokens');
      if(summary.failed) lines.push(`  _${summary.failed} token(s) couldn't be checked_`);
    } else {
      lines.push('');
      lines.push('🏦 **Unclaimed Vault** — you don\'t currently hold any Stackers.');
    }
  } else {
    lines.push('💼 **Wallet** — not verified. Verify a wallet to see your vault summary and use the strategy optimizer.');
  }

  lines.push('');
  lines.push(`📬 **New-Listing Vault DMs:** ${isOn ? '✅ on' : '❌ off'} — a DM the moment a new listing appears with real, unclaimed value in its vault. Works independent of any server.`);

  const embed = new EmbedBuilder()
    .setTitle('🥞 My Stackers')
    .setColor(isOn ? 0x57F287 : 0xF97316)
    .setDescription(lines.join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me_browse:stackersvault:toggle').setLabel(isOn ? '🔕 Turn Off DMs' : '🔔 Turn On DMs').setStyle(isOn ? ButtonStyle.Secondary : ButtonStyle.Success),
  );
  if(wallet){
    row.addComponents(new ButtonBuilder().setCustomId('me_browse:stackers:optimize').setLabel('🧮 Run Optimizer').setStyle(ButtonStyle.Primary));
  }
  row.addComponents(new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary));

  return interaction[updateFn]({ embeds: [embed], components: [row] });
}

async function showStackerOptimizeModal(interaction) {
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = require('discord.js');
  const modal = new ModalBuilder()
    .setCustomId('me_modal:stackeroptimize')
    .setTitle('Stacker Strategy Optimizer');

  const budgetInput = new TextInputBuilder()
    .setCustomId('budget')
    .setLabel('How much $STACK do you have to spend?')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 350000')
    .setRequired(true);

  modal.addComponents(new AR().addComponents(budgetInput));
  return interaction.showModal(modal);
}

// Tier index -> display multiplier, matching Stackers' own docs table exactly
const STACKER_TIER_MULTIPLIERS = [null, 1.0, 1.4, 1.9, 2.5, 3.5];

// Ported from the old standalone /stackervaults optimize subcommand --
// same logic, but always plans for the caller's own verified wallet
// rather than an optional address override, since /me is inherently
// personal.
async function showStackerOptimizeResult(interaction, ctx, budget) {
  const { pgPool } = ctx;
  const userId = interaction.user.id;

  const verifiedRes = await pgPool.query(
    `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
    [userId]
  ).catch(() => ({ rows: [] }));
  if(!verifiedRes.rows.length){
    return interaction.reply({ content: 'You haven\'t verified a wallet yet — verify one first from the Wallet section.', flags: MessageFlags.Ephemeral });
  }
  const address = verifiedRes.rows[0].wallet.toLowerCase();

  const tokenIds = await getHeldTokenIds(address).catch(e => {
    console.error('[me stackers optimize] getHeldTokenIds failed:', e.message, e.stack);
    return null;
  });

  if(tokenIds === null){
    return interaction.reply({ content: 'Something went wrong looking up your wallet — try again in a moment.', flags: MessageFlags.Ephemeral });
  }
  if(!tokenIds.length){
    return interaction.reply({ content: 'Your verified wallet doesn\'t hold any Stackers right now.', flags: MessageFlags.Ephemeral });
  }

  const statusRes = await pgPool.query(
    `SELECT token_id, tier_index FROM stackers_token_status WHERE token_id = ANY($1)`,
    [tokenIds]
  ).catch(() => ({ rows: [] }));
  const tierByToken = new Map(statusRes.rows.map(r => [r.token_id, r.tier_index]));

  const tokens = tokenIds.map(id => {
    const tierIndex = tierByToken.get(id);
    return { id, tier: tierIndex !== undefined && tierIndex !== null ? tierIndex + 1 : 0 };
  });

  const result = optimize(tokens, budget);

  const actionLines = result.actionsTaken.map((a, idx) => {
    const step = idx + 1;
    if(a.type === 'upgrade'){
      const mult = STACKER_TIER_MULTIPLIERS[a.toTier];
      const reforgeNote = a.componentId !== a.groupSurvivorId ? ` (Reforge, part of #${a.groupSurvivorId}'s fused group)` : '';
      return `**${step}.** Upgrade #${a.componentId} to ${mult}×${reforgeNote} — **${a.cost.toLocaleString()}** $STACK`;
    }
    const verb = a.type === 'fusePair' ? 'Fuse' : 'Fuse (3-way)';
    return `**${step}.** ${verb} #${a.survivorId} + #${a.absorbedIds.join(' + #')} → new weight **${a.resultingWeight}** — **${a.cost.toLocaleString()}** $STACK`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🧮 Stacker Strategy — Recommended Steps')
    .setColor(0xF97316)
    .setDescription(
      actionLines.length
        ? actionLines.join('\n') + '\n\n_A strong, reasoned allocation — not a mathematical guarantee of the single best possible one. Each step is a separate on-chain transaction, in the order shown._'
        : '_No beneficial action found — either your budget is too small for anything meaningful, or everything you hold is already fully optimized._'
    )
    .addFields(
      { name: 'Budget', value: `${budget.toLocaleString()} $STACK`, inline: true },
      { name: 'Spent', value: `${result.totalSpent.toLocaleString()} $STACK`, inline: true },
      { name: 'Unused', value: `${result.remainingBudget.toLocaleString()} $STACK`, inline: true },
      { name: 'Resulting Total Weight', value: `${result.totalWeight}`, inline: false },
    );

  if(result.remainingBudget > 0 && actionLines.length){
    embed.addFields({ name: 'Why budget is left over', value: 'Everything affordable with what remains is already at max tier or fully fused — more Stackers would be needed to usefully spend the rest.', inline: false });
  }

  const recentRounds = await getRecentRoundHistory(pgPool, 24).catch(() => []);
  if(recentRounds.length >= 2){
    const totalPotWei = recentRounds.reduce((sum, r) => sum + BigInt(r.pot_wei), 0n);
    const totalWeightSum = recentRounds.reduce((sum, r) => sum + BigInt(r.total_weight), 0n);
    const avgPotWei = totalPotWei / BigInt(recentRounds.length);
    const avgTotalWeight = totalWeightSum / BigInt(recentRounds.length);

    if(avgTotalWeight > 0n){
      const myShareOfPotWei = (avgPotWei * BigInt(result.totalWeight)) / avgTotalWeight;
      const estimatedEthPerHour = Number(myShareOfPotWei) / 1e18;
      embed.addFields({
        name: '📈 Estimated Earnings (based on real recent rounds)',
        value: `~**${estimatedEthPerHour.toFixed(6)} ETH/hour** worth of assets, based on the last ${recentRounds.length} recorded round(s) — averaged to smooth out any single hour's volume being unusually high or low.\n\n_A real estimate, not a promise — trading volume drives the actual pot every hour and isn't guaranteed or predictable._`,
        inline: false,
      });
    }
  } else {
    embed.addFields({
      name: '📈 Estimated Earnings',
      value: `_Not enough real round history yet to estimate — ${recentRounds.length} recorded so far, need at least 2. Check back in a couple hours._`,
      inline: false,
    });
  }

  embed.setFooter({ text: `Planning for ${address.slice(0,6)}...${address.slice(-4)} · ${tokens.length} Stacker(s) held` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back to My Settings').setStyle(ButtonStyle.Secondary)
  );

  return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
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
        'Click **Verify Wallet** below to get started — takes about a minute.',
      ].join('\n'));
    return interaction[updateFn]({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('start_verification:'+guildId).setLabel('Verify Wallet').setStyle(ButtonStyle.Primary).setEmoji('🔗'),
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
        // True mint = wallet was the FIRST EVER recipient of that token.
        // For OCAS, every token transfer comes from zero address (including secondary sales),
        // so we detect mints by checking if the wallet received the token before anyone else ever did.
        // We do NOT exclude burn survivors here — a token you originally minted that later
        // became a survivor still counts as a mint.
        const acquisitionRes = await pgPool.query(
          `SELECT
             COUNT(DISTINCT CASE
               WHEN is_first_recipient.token_id IS NOT NULL
               THEN wti.token_id END) AS minted,
             COUNT(DISTINCT CASE
               WHEN is_first_recipient.token_id IS NULL
               THEN wti.id END)       AS bought_intervals,
             COALESCE(SUM(CASE
               WHEN is_first_recipient.token_id IS NULL
               THEN wti.cost_eth END), 0) AS total_buy_eth
           FROM wallet_token_intervals wti
           -- Check if wallet was the first-ever recipient of each token,
           -- Mint detection: zero address transferred directly to this wallet.
           -- Scoped to transfers TO this wallet only, so other holders' mints of
           -- the same token ID (shared token ID collections like Fluxeto) are ignored.
           -- For OCAS this also works since the mint goes zero → your wallet directly.
           LEFT JOIN (
             SELECT DISTINCT nt.token_id
             FROM nft_transfers nt
             WHERE nt.from_address = '0x0000000000000000000000000000000000000000'
               AND LOWER(nt.to_address) = $1
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

  // TraitView now handles ?wallet= (traitview c46a4dd's follow-up) --
  // deep-links straight into the read-only Wallet analytics tab for this
  // address, no wallet connection required. Previously pointed at
  // /wallet/${wallet}, a path that doesn't exist on this single-page app and
  // rendered a stray "Quick preview / Not in current filters" overlay instead
  // of an actual wallet page.
  lines.push(`[📊 Full analytics on TraitView](https://traitview.com/?wallet=${wallet})`);

  const embed = new EmbedBuilder()
    .setTitle('💼 Portfolio')
    .setColor(cols.some(c => c.unrealizedPnl > 0) ? 0x57F287 : 0x5865F2)
    .setDescription(lines.join('\n'));

  // Build collection token buttons (one per collection, up to 4)
  const tokenBtns = cols.slice(0, 4).map(c =>
    new ButtonBuilder()
      .setCustomId(`me_browse:wallet:tokens:${c.slug}:0`)
      .setLabel(`${c.name} tokens`)
      .setStyle(ButtonStyle.Primary)
  );

  const rows = [
    new ActionRowBuilder().addComponents(...tokenBtns),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('me_browse:wallet:sync').setLabel('🔄 Sync').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('me_browse:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    ),
  ];

  return interaction[updateFn]({ embeds: [embed], components: rows });
}

// ── showMeTokens — token dropdown for a collection ────────────────────────────
async function showMeTokens(interaction, ctx, slug, page = 0){
  const { pgPool } = ctx;
  const userId = interaction.user.id;
  const updateFn = interaction.deferred || interaction.replied ? 'editReply'
    : (interaction.isButton?.() || interaction.isStringSelectMenu?.() ? 'update' : 'editReply');

  // Get wallet
  const reg = await pgPool.query(
    `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
    [userId]
  ).catch(()=>null);
  const wallet = reg?.rows[0]?.wallet?.toLowerCase() || null;
  if(!wallet) return interaction[updateFn]({ content: '❌ No wallet linked.', components: [] });

  // Get collection name
  const cfgRow = await pgPool.query(
    `SELECT name FROM server_configs WHERE guild_id=$1`,
    [interaction.guildId]
  ).catch(()=>null);

  // Fetch all held tokens for this collection with P&L data
  const tokensRes = await pgPool.query(
    `SELECT wti.token_id, wti.cost_eth, wti.acquired_at,
            tt.trait_value AS type_trait
     FROM wallet_token_intervals wti
     LEFT JOIN token_traits tt ON tt.token_id = wti.token_id
       AND (tt.collection_slug = $2 OR tt.collection_slug IS NULL)
       AND LOWER(tt.trait_name) = 'type'
     WHERE LOWER(wti.wallet_address) = $1
       AND (wti.collection_slug = $2 OR wti.collection_slug IS NULL)
       AND wti.disposed_at IS NULL
     ORDER BY wti.token_id ASC`,
    [wallet, slug]
  ).catch(()=>({ rows: [] }));

  if(!tokensRes.rows.length){
    return interaction[updateFn]({ content: `No held tokens found for **${slug}**.`, components: [] });
  }

  // Get listings for est value per token (trait sweep)
  const tokenIds = tokensRes.rows.map(r => r.token_id);
  const listingsRes = await pgPool.query(
    `SELECT token_id, price_eth FROM listings WHERE collection_slug=$1 AND token_id = ANY($2)`,
    [slug, tokenIds]
  ).catch(()=>({ rows: [] }));
  const listingMap = {};
  for(const r of listingsRes.rows) listingMap[r.token_id] = parseFloat(r.price_eth);

  // Build token list with P&L, sorted by unrealized P&L desc
  const tokens = tokensRes.rows.map(r => {
    const cost = parseFloat(r.cost_eth || 0);
    const estVal = listingMap[r.token_id] || null;
    const unrealized = (estVal && cost > 0) ? estVal - cost : null;
    const pct = (unrealized !== null && cost > 0) ? ((unrealized / cost) * 100).toFixed(0) : null;
    return { tokenId: r.token_id, cost, estVal, unrealized, pct, typeLabel: r.type_trait || '' };
  }).sort((a, b) => (b.unrealized || 0) - (a.unrealized || 0));

  // Paginate — 25 per page
  const PAGE_SIZE = 25;
  const totalPages = Math.ceil(tokens.length / PAGE_SIZE);
  const pageTokens = tokens.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Build dropdown options
  const options = pageTokens.map(t => {
    const pctStr = t.pct !== null ? ` · ${t.unrealized >= 0 ? '+' : ''}${t.pct}%` : '';
    const typeStr = t.typeLabel ? ` · ${t.typeLabel}` : '';
    const label = `#${t.tokenId}${typeStr}${pctStr}`.slice(0, 100);
    return { label, value: `${t.tokenId}` };
  });

  const pageLabel = totalPages > 1 ? ` (${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, tokens.length)} of ${tokens.length})` : ` (${tokens.length} tokens)`;

  const { StringSelectMenuBuilder } = require('discord.js');
  const select = new StringSelectMenuBuilder()
    .setCustomId(`me_browse:wallet:token_select:${slug}:${page}`)
    .setPlaceholder(`Select a token...${pageLabel}`)
    .addOptions(options);

  const navBtns = [
    new ButtonBuilder().setCustomId('me_browse:wallet').setLabel('← Portfolio').setStyle(ButtonStyle.Secondary),
  ];
  if(page > 0) navBtns.unshift(
    new ButtonBuilder().setCustomId(`me_browse:wallet:tokens:${slug}:${page - 1}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary)
  );
  if(page < totalPages - 1) navBtns.push(
    new ButtonBuilder().setCustomId(`me_browse:wallet:tokens:${slug}:${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary)
  );

  const embed = new EmbedBuilder()
    .setTitle(`🗂️ ${slug} — Your Tokens`)
    .setColor(0x5865F2)
    .setDescription(`Sorted by unrealized P&L. Select a token to view details.`);

  return interaction[updateFn]({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(...navBtns),
    ],
  });
}

// ── showMeTokenDetail — full detail for a single held token ───────────────────
async function showMeTokenDetail(interaction, ctx, slug, tokenId, page = 0){
  const { pgPool, getRailwayApiUrl } = ctx;
  const userId = interaction.user.id;

  // Defer immediately — SVG→PNG rendering can exceed Discord's 3s window
  if(!interaction.deferred && !interaction.replied){
    await interaction.deferUpdate().catch(()=>interaction.deferReply({ ephemeral: true }).catch(()=>{}));
  }
  const updateFn = 'editReply';

  const reg = await pgPool.query(
    `SELECT wallet FROM user_registrations WHERE discord_id=$1 AND verified=true ORDER BY verified_at DESC LIMIT 1`,
    [userId]
  ).catch(()=>null);
  const wallet = reg?.rows[0]?.wallet?.toLowerCase() || null;
  if(!wallet) return interaction[updateFn]({ content: '❌ No wallet linked.', components: [] });

  // Get interval data for this token — use OR for collection_slug to handle NULL rows
  const wtiRes = await pgPool.query(
    `SELECT wti.token_id, wti.cost_eth, wti.acquired_at,
            tt.trait_value AS type_trait
     FROM wallet_token_intervals wti
     LEFT JOIN token_traits tt ON tt.token_id = wti.token_id
       AND (tt.collection_slug = $3 OR tt.collection_slug IS NULL)
       AND LOWER(tt.trait_name) = 'type'
     WHERE LOWER(wti.wallet_address) = $1
       AND (wti.collection_slug = $3 OR wti.collection_slug IS NULL)
       AND wti.token_id = $2
       AND wti.disposed_at IS NULL`,
    [wallet, tokenId, slug]
  ).catch(()=>({ rows: [] }));

  if(!wtiRes.rows.length){
    return interaction[updateFn]({ content: `Token #${tokenId} not found in your holdings.`, components: [] });
  }

  const t = wtiRes.rows[0];
  const cost = parseFloat(t.cost_eth || 0);

  // Get listing price for this token
  const listingRes = await pgPool.query(
    `SELECT price_eth FROM listings WHERE collection_slug=$1 AND token_id=$2`,
    [slug, tokenId]
  ).catch(()=>({ rows: [] }));
  const estVal = listingRes.rows[0]?.price_eth ? parseFloat(listingRes.rows[0].price_eth) : null;

  const unrealized = (estVal && cost > 0) ? estVal - cost : null;
  const pct = (unrealized !== null && cost > 0)
    ? ` (${unrealized >= 0 ? '+' : ''}${((unrealized / cost) * 100).toFixed(0)}%)`
    : '';

  // Get collection config — contract + animated flag
  const serverCfg = ctx.getConfig ? ctx.getConfig(interaction.guildId) : null;
  const allCols = serverCfg ? [
    ...(serverCfg.contract ? [{ slug: serverCfg.collectionSlug || serverCfg.slug, contract: serverCfg.contract, animated: serverCfg.animated }] : []),
    ...(serverCfg.collections || [])
  ] : [];
  const colCfg = allCols.find(c => c.slug === slug);
  const colContract = colCfg?.contract || null;
  const isAnimated = colCfg?.animated === true;
  const colChainRes = await pgPool.query(`SELECT chain FROM collections WHERE slug = $1`, [slug]).catch(() => ({ rows: [] }));
  const colChain = colChainRes.rows[0]?.chain || 'ethereum';

  let imageResult = null;

  // Animated collection — call OpenSea for display_image_url (cached 2 min)
  if(isAnimated && colContract){
    imageResult = await resolveImage({ identifier: tokenId, token_id: tokenId }, colContract, 'ethereum').catch(()=>null);
  }

  // Static — use stored image_url from backfill (no API call)
  // Strict collection_slug match only — never fall back to other collections
  if(!imageResult){
    const tokenImgRes = await pgPool.query(
      `SELECT image_url FROM tokens WHERE id=$1 AND collection_slug=$2`,
      [tokenId, slug]
    ).catch(()=>({ rows: [] }));
    const tokenImgUrl = tokenImgRes.rows[0]?.image_url || null;
    if(tokenImgUrl && isDiscordOk(tokenImgUrl)){
      imageResult = { type: 'url', url: tokenImgUrl };
    }
  }

  // Non-OCAS SVG fallback — render SVG→PNG from token_svg_cache
  if(!imageResult && slug !== 'on-chain-all-stars'){
    const svgRes = await pgPool.query(
      `SELECT image_data FROM token_svg_cache WHERE token_id=$1 AND collection_slug=$2 LIMIT 1`,
      [tokenId, slug]
    ).catch(()=>({ rows: [] }));
    const svgData = svgRes.rows[0]?.image_data || null;
    if(svgData){
      const buf = await extractPngFromSvg(svgData).catch(()=>null);
      if(buf) imageResult = { type: 'buffer', buffer: buf, filename: `token-${tokenId}.png` };
    }
  }

  // OCAS fallback — SVG → PNG from token_image_snapshots (OCAS-only table)
  // Only attempt this when the collection being viewed is actually OCAS —
  // never fall through to OCAS snapshots for Fluxeto or any other collection
  // that shares token IDs with OCAS.
  if(!imageResult && slug === 'on-chain-all-stars'){
    const imgRes = await pgPool.query(
      `SELECT image_data FROM token_image_snapshots WHERE token_id=$1 LIMIT 1`,
      [tokenId]
    ).catch(()=>({ rows: [] }));
    const imgData = imgRes.rows[0]?.image_data || null;
    if(imgData){
      if(imgData.startsWith('http') && isDiscordOk(imgData)){
        imageResult = { type: 'url', url: imgData };
      } else if(imgData.startsWith('<svg') || imgData.startsWith('data:image/svg') || imgData.toLowerCase().includes('image/svg')){
        const buf = await extractPngFromSvg(imgData).catch(()=>null);
        if(buf) imageResult = { type: 'buffer', buffer: buf, filename: `token-${tokenId}.png` };
      }
    }
  }

  // Top trait floor — find the rarest trait and its cheapest listing
  const topTraitRes = await pgPool.query(
    `SELECT tt.trait_name, tt.trait_value,
            MIN(l.price_eth) AS trait_floor,
            COUNT(tt2.token_id) AS trait_count
     FROM token_traits tt
     JOIN token_traits tt2 ON tt2.trait_name = tt.trait_name
       AND tt2.trait_value = tt.trait_value
       AND (tt2.collection_slug = $2 OR tt2.collection_slug IS NULL)
     JOIN listings l ON l.token_id = tt2.token_id AND l.collection_slug = $2
     WHERE tt.token_id = $1
       AND (tt.collection_slug = $2 OR tt.collection_slug IS NULL)
       AND LOWER(tt.trait_name) NOT IN ('type','num tattoos','num jewellery','num clothes')
     GROUP BY tt.trait_name, tt.trait_value
     ORDER BY trait_count ASC, trait_floor ASC
     LIMIT 1`,
    [tokenId, slug]
  ).catch(()=>({ rows: [] }));
  const topTrait = topTraitRes.rows[0] || null;

  // Collection floor as fallback for est value
  const collFloorRes = await pgPool.query(
    `SELECT MIN(price_eth) AS floor FROM listings WHERE collection_slug=$1`, [slug]
  ).catch(()=>({ rows: [] }));
  const collFloor = collFloorRes.rows[0]?.floor ? parseFloat(collFloorRes.rows[0].floor) : null;
  const displayEst = estVal || collFloor;
  const estLabel = estVal ? 'Est. Value' : 'Floor est.';

  // Check if minted
  const mintRes = await pgPool.query(
    `SELECT COUNT(*) AS cnt FROM nft_transfers
     WHERE token_id=$1
       AND from_address='0x0000000000000000000000000000000000000000'
       AND LOWER(to_address)=$2`,
    [tokenId, wallet]
  ).catch(()=>({ rows: [{ cnt: 0 }] }));
  const isMinted = parseInt(mintRes.rows[0]?.cnt || 0) > 0;

  // OCAS burn history
  let burnLine = '';
  if(slug === 'on-chain-all-stars'){
    const burnRes = await pgPool.query(
      `SELECT COUNT(*) AS cnt, SUM(points_used) AS pts
       FROM burn_events WHERE survivor_token_id=$1`, [tokenId]
    ).catch(()=>({ rows: [] }));
    const burnCount = parseInt(burnRes.rows[0]?.cnt || 0);
    const burnPts = parseInt(burnRes.rows[0]?.pts || 0);
    if(burnCount > 0) burnLine = `🔥 Burn survivor · ${burnCount}x burned · ${burnPts} pts`;
  }

  // Get all held tokens for nav (same sorted list)
  const allTokensRes = await pgPool.query(
    `SELECT wti.token_id, wti.cost_eth,
            l.price_eth
     FROM wallet_token_intervals wti
     LEFT JOIN listings l ON l.token_id = wti.token_id AND l.collection_slug = $2
     WHERE LOWER(wti.wallet_address) = $1
       AND (wti.collection_slug = $2 OR wti.collection_slug IS NULL)
       AND wti.disposed_at IS NULL
     ORDER BY wti.token_id ASC`,
    [wallet, slug]
  ).catch(()=>({ rows: [] }));

  const sortedTokens = allTokensRes.rows.map(r => {
    const c = parseFloat(r.cost_eth || 0);
    const e = r.price_eth ? parseFloat(r.price_eth) : null;
    return { tokenId: r.token_id, unrealized: (e && c > 0) ? e - c : null };
  }).sort((a, b) => (b.unrealized || 0) - (a.unrealized || 0));

  const currentIdx = sortedTokens.findIndex(r => r.tokenId == tokenId);
  const prevToken = currentIdx > 0 ? sortedTokens[currentIdx - 1].tokenId : null;
  const nextToken = currentIdx < sortedTokens.length - 1 ? sortedTokens[currentIdx + 1].tokenId : null;

  // Rebuild dropdown for current page
  const PAGE_SIZE = 25;
  const totalPages = Math.ceil(sortedTokens.length / PAGE_SIZE);
  const pageForToken = Math.floor(currentIdx / PAGE_SIZE);
  const pageTokens = sortedTokens.slice(pageForToken * PAGE_SIZE, (pageForToken + 1) * PAGE_SIZE);

  const { StringSelectMenuBuilder } = require('discord.js');
  const options = pageTokens.map(r => ({
    label: `#${r.tokenId}${r.unrealized !== null ? ` · ${r.unrealized >= 0 ? '+' : ''}${((r.unrealized / (parseFloat(allTokensRes.rows.find(x=>x.token_id==r.tokenId)?.cost_eth)||1))*100).toFixed(0)}%` : ''}`.slice(0,100),
    value: `${r.tokenId}`,
    default: r.tokenId == tokenId,
  }));

  const pageLabel = totalPages > 1 ? ` (${pageForToken * PAGE_SIZE + 1}–${Math.min((pageForToken+1)*PAGE_SIZE, sortedTokens.length)} of ${sortedTokens.length})` : ` (${sortedTokens.length} tokens)`;
  const select = new StringSelectMenuBuilder()
    .setCustomId(`me_browse:wallet:token_select:${slug}:${pageForToken}`)
    .setPlaceholder(`Select a token...${pageLabel}`)
    .addOptions(options);

  // Nav buttons
  const navBtns = [
    new ButtonBuilder().setCustomId(`me_browse:wallet:tokens:${slug}:${pageForToken}`).setLabel('← Tokens').setStyle(ButtonStyle.Secondary),
  ];
  if(prevToken !== null) navBtns.push(
    new ButtonBuilder().setCustomId(`me_browse:wallet:token_detail:${slug}:${prevToken}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary)
  );
  if(nextToken !== null) navBtns.push(
    new ButtonBuilder().setCustomId(`me_browse:wallet:token_detail:${slug}:${nextToken}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary)
  );

  const typeLabel = t.type_trait ? `${t.type_trait} · ` : '';
  const unrealizedDisplay = displayEst && cost > 0 ? displayEst - cost : null;
  const pctDisplay = (unrealizedDisplay !== null && cost > 0)
    ? ` (${unrealizedDisplay >= 0 ? '+' : ''}${((unrealizedDisplay / cost) * 100).toFixed(0)}%)`
    : '';

  const descLines = [
    `**#${tokenId}** · ${typeLabel}${slug}`,
    '',
    `Cost: **Ξ ${cost > 0 ? cost.toFixed(4) : '—'}**`,
    displayEst ? `${estLabel}: **Ξ ${displayEst.toFixed(4)}**` : 'Est. Value: —',
    topTrait ? `Top trait: **${topTrait.trait_value}** · Ξ ${parseFloat(topTrait.trait_floor).toFixed(4)} floor` : '',
    unrealizedDisplay !== null ? `Unrealized: **${unrealizedDisplay >= 0 ? '+' : ''}Ξ ${Math.abs(unrealizedDisplay).toFixed(4)}${pctDisplay}**` : '',
    '',
    isMinted ? '✨ Minted' : '🛒 Bought',
    burnLine,
  ].filter(Boolean).join('\n');

  // Token image
  const tvUrl = `https://traitview.com/token/${slug}/${tokenId}`;
  const osUrl = `https://opensea.io/assets/${colChain}/${colContract || slug}/${tokenId}`;
  const embed = new EmbedBuilder()
    .setTitle(`🔍 Token #${tokenId}`)
    .setColor(unrealizedDisplay !== null && unrealizedDisplay >= 0 ? 0x57F287 : 0xED4245)
    .setDescription(descLines)
    .setURL(tvUrl)
    .setFooter({ text: `${currentIdx + 1} of ${sortedTokens.length} held tokens` });

  if(slug === STACKERS_SLUG){
    const stackersFields = await formatStackersFields(tokenId);
    if(stackersFields.length) embed.addFields(...stackersFields);
  }

  const components = [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(...navBtns),
  ];

  if(imageResult?.type === 'buffer'){
    const att = new AttachmentBuilder(imageResult.buffer, { name: imageResult.filename });
    embed.setThumbnail(`attachment://${imageResult.filename}`);
    return interaction[updateFn]({ embeds: [embed], components, files: [att] });
  } else {
    if(imageResult?.type === 'url') embed.setThumbnail(imageResult.url);
    return interaction[updateFn]({ embeds: [embed], components, files: [] });
  }
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
    if(section === 'my_stackers') return showMeStackersHub(interaction, ctx);
    if(section === 'wallet') return showMeWallet(interaction, ctx);
    if(section === 'traitview') return showMeTraitView(interaction, ctx);
  }

  if(customId === 'me_browse:stackersvault:toggle'){
    const { setVaultDmOptIn, getVaultDmOptIns } = require('../lib/stackers-vault-listing-alerts');
    const current = await getVaultDmOptIns();
    const isOn = !!current[interaction.user.id];
    await setVaultDmOptIn(interaction.user.id, !isOn);
    return showMeStackersHub(interaction, ctx);
  }

  if(customId === 'me_browse:stackers:optimize'){
    return showStackerOptimizeModal(interaction);
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
    return interaction.update({ content: '**📣 Trait Alert** — Pick a collection:', embeds:[], components: buildCollectionPickerRows(allCols, 'ma_browse:col') });
  }

  if(customId === 'me_browse:alert:clear'){
    return showMaClearWizard(interaction, { getAlert, deleteAlert, setAlert });
  }

  if(customId === 'me_browse:alert:pause'){
    setAlert(interaction.user.id, { paused: true });
    return showMeTraitAlert(interaction, ctx);
  }

  if(customId === 'me_browse:alert:resume'){
    setAlert(interaction.user.id, { paused: false });
    return showMeTraitAlert(interaction, ctx);
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
    return interaction.update({ content: '**🏷️ Price Alert** — Pick a collection:', embeds:[], components: buildCollectionPickerRows(allCols, 'me_browse:pricealert:col') });
  }

  if(customId.startsWith('me_browse:pricealert:col')){
    return showPriceAlertModal(interaction, interaction.values[0]);
  }

  if(customId === 'me_browse:pricealert:pick'){
    return showPriceAlertDetail(interaction, ctx, parseInt(interaction.values[0]));
  }

  if(customId === 'me_browse:pricealert:list'){
    return showMePriceAlerts(interaction, ctx);
  }

  if(customId.startsWith('me_browse:pricealert:remove:')){
    const id = parseInt(customId.split(':').pop());
    await pgPool.query(`DELETE FROM user_price_alerts WHERE id=$1 AND discord_id=$2`, [id, interaction.user.id]).catch(()=>{});
    return showMePriceAlerts(interaction, ctx);
  }

  if(customId.startsWith('me_browse:pricealert:pause:')){
    const id = parseInt(customId.split(':').pop());
    await pgPool.query(`UPDATE user_price_alerts SET is_active=false WHERE id=$1 AND discord_id=$2`, [id, interaction.user.id]).catch(()=>{});
    return showPriceAlertDetail(interaction, ctx, id);
  }

  if(customId.startsWith('me_browse:pricealert:resume:')){
    const id = parseInt(customId.split(':').pop());
    await pgPool.query(`UPDATE user_price_alerts SET is_active=true WHERE id=$1 AND discord_id=$2`, [id, interaction.user.id]).catch(()=>{});
    return showPriceAlertDetail(interaction, ctx, id);
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
    return interaction.update({ content: '**📉 Floor Alert** — Pick a collection:', embeds:[], components: buildCollectionPickerRows(allCols, 'me_browse:flooralert:col') });
  }

  if(customId.startsWith('me_browse:flooralert:col')){
    return showFloorAlertModal(interaction, interaction.values[0]);
  }

  if(customId === 'me_browse:flooralert:pick'){
    return showFloorAlertDetail(interaction, ctx, parseInt(interaction.values[0]));
  }

  if(customId === 'me_browse:flooralert:list'){
    return showMeFloorAlerts(interaction, ctx);
  }

  if(customId.startsWith('me_browse:flooralert:remove:')){
    const id = parseInt(customId.split(':').pop());
    await pgPool.query(`DELETE FROM user_floor_alerts WHERE id=$1 AND discord_id=$2`, [id, interaction.user.id]).catch(()=>{});
    return showMeFloorAlerts(interaction, ctx);
  }

  if(customId.startsWith('me_browse:flooralert:pause:')){
    const id = parseInt(customId.split(':').pop());
    await pgPool.query(`UPDATE user_floor_alerts SET is_active=false WHERE id=$1 AND discord_id=$2`, [id, interaction.user.id]).catch(()=>{});
    return showFloorAlertDetail(interaction, ctx, id);
  }

  if(customId.startsWith('me_browse:flooralert:resume:')){
    const id = parseInt(customId.split(':').pop());
    await pgPool.query(`UPDATE user_floor_alerts SET is_active=true WHERE id=$1 AND discord_id=$2`, [id, interaction.user.id]).catch(()=>{});
    return showFloorAlertDetail(interaction, ctx, id);
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

  // Token list dropdown for a collection
  if(customId.startsWith('me_browse:wallet:tokens:')){
    const parts = customId.split(':');
    const slug = parts[3];
    const page = parseInt(parts[4] || '0');
    return showMeTokens(interaction, ctx, slug, page);
  }

  // Token selected from dropdown
  if(customId.startsWith('me_browse:wallet:token_select:')){
    const parts = customId.split(':');
    const slug = parts[3];
    const page = parseInt(parts[4] || '0');
    const tokenId = parseInt(interaction.values[0]);
    return showMeTokenDetail(interaction, ctx, slug, tokenId, page);
  }

  // Token detail via prev/next nav
  if(customId.startsWith('me_browse:wallet:token_detail:')){
    const parts = customId.split(':');
    const slug = parts[3];
    const tokenId = parseInt(parts[4]);
    return showMeTokenDetail(interaction, ctx, slug, tokenId);
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

module.exports = { handleMarketCommand, MARKET_COMMANDS, resolveCollectionFromServerCfg, isPaidFeature, handleTraitBrowseInteraction, handleMyAlertInteraction, showMaTraitPicker, handleMaClearInteraction, handleMeInteraction, handleRankFindModalSubmit, handleRankFindBrowseInteraction, handleRfColPick, showStackerOptimizeResult };