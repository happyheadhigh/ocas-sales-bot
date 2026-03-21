/**
 * NFT Sales + Listings Bot — Multi-Server Public Edition
 * ─────────────────────────────────────────────────────────────
 * Posts NFT sales AND listings to separate channels.
 * Supports personal DM alerts per user with their own filters.
 *
 * SERVER ADMIN COMMANDS (Manage Server required):
 *   /setup         — Configure sales channel + collection
 *   /setlistings   — Set the listings channel
 *   /setchannel    — Change sales channel
 *   /setcollection — Change collection
 *   /salesfilter   — Filter auto-posted sales by trait
 *   /listingfilter — Filter auto-posted listings by trait
 *   /clearfilters  — Clear all server-level filters
 *   /pause /resume — Pause/resume all auto-posts
 *   /status        — Show server config
 *
 * PUBLIC COMMANDS (anyone):
 *   /lastsale            — Most recent sale
 *   /recentsales         — Last N sales
 *   /sale token:1234     — Specific token's last sale
 *   /traitfind           — Search sales history by trait
 *   /listings            — Show current active listings
 *   /myalert             — Set personal DM alert (sales + listings)
 *   /myalertclear        — Remove your personal DM alert
 *   /myalertstatus       — See your current alert settings
 *   /help
 */

require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes,
  EmbedBuilder, AttachmentBuilder, PermissionFlagsBits,
} = require('discord.js');
const fetch = require('node-fetch');
const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENSEA_KEY   = process.env.OPENSEA_KEY || '';
const POLL_MS       = parseInt(process.env.POLL_MS || '30000', 10);
const SERVER_FILE   = path.join(__dirname, 'server-configs.json');
const ALERTS_FILE   = path.join(__dirname, 'user-alerts.json');

// ── Persistence ───────────────────────────────────────────────────────────────
function loadJson(file){ try{ return JSON.parse(fs.readFileSync(file,'utf8')); }catch{ return {}; } }
function saveJson(file, data){ fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

let serverConfigs = loadJson(SERVER_FILE); // { guildId: { channelId, listingsChannelId, slug, contract, salesFilters, listingFilters, paused } }
let userAlerts    = loadJson(ALERTS_FILE); // { userId: { slug, contract, traitFilters, alertSales, alertListings } }

function getConfig(guildId){ return serverConfigs[guildId] || {}; }
function setConfig(guildId, updates){ serverConfigs[guildId] = { ...getConfig(guildId), ...updates }; saveJson(SERVER_FILE, serverConfigs); }
function getAlert(userId){ return userAlerts[userId] || null; }
function setAlert(userId, updates){ userAlerts[userId] = { ...(userAlerts[userId]||{}), ...updates }; saveJson(ALERTS_FILE, userAlerts); }
function deleteAlert(userId){ delete userAlerts[userId]; saveJson(ALERTS_FILE, userAlerts); }

// ── Cursors (not persisted) ───────────────────────────────────────────────────
const lastSaleIds    = new Map(); // guildId → last sale id
const lastListingIds = new Map(); // guildId → last listing id
const imageCache     = new Map(); // "contract:tokenId" → resolved image

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Helpers ───────────────────────────────────────────────────────────────────
function osHeaders(){ const h={accept:'application/json'}; if(OPENSEA_KEY) h['x-api-key']=OPENSEA_KEY; return h; }

function formatEth(event){
  try{
    const qty = BigInt(event.payment?.quantity||'0');
    const dec = event.payment?.decimals??18;
    const eth = Number(qty)/Math.pow(10,dec);
    if(!isFinite(eth)||eth<=0) return null;
    return eth>=1?eth.toFixed(4):eth.toFixed(5);
  }catch{ return null; }
}

function formatListingEth(listing){
  try{
    const price = listing.price?.current?.value || listing.price?.value;
    if(!price) return null;
    const eth = Number(price)/1e18;
    if(!isFinite(eth)||eth<=0) return null;
    return eth>=1?eth.toFixed(4):eth.toFixed(5);
  }catch{ return null; }
}

function shortAddr(addr){ if(!addr||addr.length<10) return addr||'unknown'; return addr.slice(0,6)+'...'+addr.slice(-4); }
function timeSince(ts){ const s=Math.floor(Date.now()/1000-ts); if(s<60) return s+'s ago'; if(s<3600) return Math.floor(s/60)+'m ago'; return Math.floor(s/3600)+'h ago'; }
function isSvg(url){ if(!url) return false; const s=String(url).trim(); return s.startsWith('<svg')||s.startsWith('data:image/svg')||s.toLowerCase().endsWith('.svg')||s.includes('image/svg'); }
function isDiscordOk(url){ if(!url||isSvg(url)) return false; const s=url.toLowerCase(); return (s.startsWith('http://')||s.startsWith('https://'))&&!s.startsWith('data:'); }

function matchesFilters(traits, filters){
  if(!filters||Object.keys(filters).length===0) return true;
  const lookup={};
  for(const t of (traits||[])) lookup[t.trait_type?.toLowerCase()]=String(t.value).toLowerCase();
  for(const [k,v] of Object.entries(filters)){ if(lookup[k]!==v) return false; }
  return true;
}

// ── SVG → PNG (OCAS on-chain SVG with embedded PNG + gradient background) ────
async function extractPngFromSvg(svgSource){
  let svgText;
  if(svgSource.startsWith('data:image/svg')){
    const b64=svgSource.split(',')[1]; if(!b64) throw new Error('Empty SVG');
    svgText=Buffer.from(b64,'base64').toString('utf-8');
  } else {
    const r=await fetch(svgSource); if(!r.ok) throw new Error('SVG fetch '+r.status);
    svgText=await r.text();
  }
  const SIZE=500;
  const pngMatch=svgText.match(/src=["']data:image\/png;base64,([A-Za-z0-9+/=\s]+)["']/);
  let charBuf=null;
  if(pngMatch){
    const rawPng=Buffer.from(pngMatch[1].replace(/\s/g,''),'base64');
    charBuf=await sharp(rawPng).resize(SIZE,SIZE,{kernel:'nearest'}).png().toBuffer();
  }
  const stopMatches=[...svgText.matchAll(/stop-color=["'](#[0-9a-fA-F]{6,8})["']/g)];
  const stops=stopMatches.map(m=>m[1].slice(0,7));
  const unique=stops.filter((c,i)=>c!==stops[i-1]);
  const gd=svgText.match(/linearGradient[^>]+x1=["']([\d.]+)["'][^>]+y1=["']([\d.]+)["'][^>]+x2=["']([\d.]+)["'][^>]+y2=["']([\d.]+)["']/);
  const [gx1,gy1,gx2,gy2]=gd?[gd[1],gd[2],gd[3],gd[4]]:['0','0','0','1'];
  let gradStops;
  if(unique.length<=1){ const c=unique[0]||'#1a1a2e'; gradStops=`<stop offset="0%" stop-color="${c}"/><stop offset="100%" stop-color="${c}"/>`; }
  else { gradStops=unique.map((c,i)=>`<stop offset="${Math.round(i/(unique.length-1)*100)}%" stop-color="${c}"/>`).join(''); }
  const bgSvg=`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><defs><linearGradient id="bg" x1="${gx1}" y1="${gy1}" x2="${gx2}" y2="${gy2}">${gradStops}</linearGradient></defs><rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/></svg>`;
  const bgBuf=await sharp(Buffer.from(bgSvg)).resize(SIZE,SIZE).png().toBuffer();
  if(charBuf) return sharp(bgBuf).composite([{input:charBuf,blend:'over'}]).png().toBuffer();
  return bgBuf;
}

// ── Image resolver ────────────────────────────────────────────────────────────
async function resolveImage(nft, contract){
  const id=nft?.identifier||nft?.token_id;
  const key=`${contract}:${id}`;
  if(id&&imageCache.has(key)) return imageCache.get(key);
  const candidates=[nft?.display_image_url,nft?.image_url,nft?.image_preview_url];
  for(const url of candidates){ if(isDiscordOk(url)){ const r={type:'url',url}; if(id) imageCache.set(key,r); return r; } }
  if(id){
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/chain/ethereum/contract/${contract}/nfts/${id}`,{headers:osHeaders()});
      if(r.ok){
        const j=await r.json(); const n=j.nft||j;
        const deep=[n.display_image_url,n.image_url,n.image_preview_url,n.image_thumbnail_url];
        for(const url of deep){ if(isDiscordOk(url)){ const res={type:'url',url}; imageCache.set(key,res); return res; } }
        const svgSrc=deep.find(u=>u&&!u.startsWith('<svg')&&!u.startsWith('data:')&&isSvg(u))||candidates.find(u=>u&&isSvg(u));
        if(svgSrc){ const buf=await extractPngFromSvg(svgSrc); const res={type:'buffer',buffer:buf,filename:`token-${id}.png`}; imageCache.set(key,res); return res; }
      }
    }catch(e){ console.warn('[Image]',id,e.message); }
  }
  return null;
}

// ── Send embed (handles buffer attachment vs URL) ─────────────────────────────
async function sendEmbed(target, embed){
  const ir=embed._imageResult; delete embed._imageResult;
  if(ir?.type==='buffer'){ const att=new AttachmentBuilder(ir.buffer,{name:ir.filename}); embed.setThumbnail(`attachment://${ir.filename}`); return target.send({embeds:[embed],files:[att]}); }
  if(ir?.type==='url') embed.setThumbnail(ir.url);
  return target.send({embeds:[embed]});
}

// ── Build SALE embed ──────────────────────────────────────────────────────────
async function buildSaleEmbed(sale, config, isTest=false){
  const id=sale.nft?.identifier;
  const name=sale.nft?.name||`#${id}`;
  const eth=formatEth(sale);
  const contract=config.contract||'';
  const slug=config.slug||'';
  const osUrl=`https://opensea.io/assets/ethereum/${contract}/${id}`;
  const tvUrl=`https://traitview.com/?jump=${id}`;
  const timeStr=sale.event_timestamp?timeSince(sale.event_timestamp):'';
  const buyerLink=sale.buyer&&sale.buyer!=='unknown'?`[${shortAddr(sale.buyer)}](https://opensea.io/${sale.buyer})`:'unknown';
  const sellerLink=sale.seller&&sale.seller!=='unknown'?`[${shortAddr(sale.seller)}](https://opensea.io/${sale.seller})`:'unknown';

  const embed=new EmbedBuilder()
    .setTitle(`${isTest?'TEST ':''}SOLD ${name} - ${eth?eth+' ETH':'--'}`)
    .setColor(0x2dd4bf)
    .setURL(osUrl)
    .setFooter({text:`Sales Bot - ${slug}${timeStr?' - '+timeStr:''}`})
    .setTimestamp();

  embed._imageResult=await resolveImage(sale.nft,contract);

  embed.addFields(
    {name:'Price', value:eth?eth+' ETH':'--', inline:true},
    {name:'Buyer', value:buyerLink, inline:true},
    {name:'Seller',value:sellerLink,inline:true},
  );
  const traits=sale.nft?.traits||[];
  if(traits.length>0) embed.addFields({name:'Traits',value:traits.slice(0,12).map(t=>`**${t.trait_type}**: ${t.value}`).join('\n'),inline:true});
  embed.addFields({name:'Links',value:`[OpenSea](${osUrl}) - [TraitView](${tvUrl})`,inline:false});
  return embed;
}

// ── Build LISTING embed ───────────────────────────────────────────────────────
async function buildListingEmbed(listing, config, isTest=false){
  const nft=listing.item||listing.nft||{};
  const rawId=nft.nft_id||nft.identifier||'';
  const id=rawId.includes('/')?rawId.split('/').pop():rawId;
  const name=nft.name||`#${id}`;
  const eth=formatListingEth(listing);
  const contract=config.contract||'';
  const slug=config.slug||'';
  const osUrl=`https://opensea.io/assets/ethereum/${contract}/${id}`;
  const tvUrl=`https://traitview.com/?jump=${id}`;
  const sellerAddr=listing.maker?.address||'';
  const sellerLink=sellerAddr?`[${shortAddr(sellerAddr)}](https://opensea.io/${sellerAddr})`:'unknown';

  const embed=new EmbedBuilder()
    .setTitle(`${isTest?'TEST ':''}LISTED ${name} - ${eth?eth+' ETH':'--'}`)
    .setColor(0x7aa2ff)
    .setURL(osUrl)
    .setFooter({text:`Listings Bot - ${slug}`})
    .setTimestamp();

  embed._imageResult=await resolveImage(nft,contract);

  embed.addFields(
    {name:'Price', value:eth?eth+' ETH':'--', inline:true},
    {name:'Seller',value:sellerLink,inline:true},
    {name:'Buy Now',value:`[OpenSea](${osUrl})`,inline:true},
  );
  const traits=nft.traits||[];
  if(traits.length>0) embed.addFields({name:'Traits',value:traits.slice(0,12).map(t=>`**${t.trait_type}**: ${t.value}`).join('\n'),inline:true});
  embed.addFields({name:'Links',value:`[OpenSea](${osUrl}) - [TraitView](${tvUrl})`,inline:false});
  return embed;
}

// ── Poll sales ────────────────────────────────────────────────────────────────
async function pollSales(){
  for(const [guildId,config] of Object.entries(serverConfigs)){
    if(!config.channelId||!config.slug||config.paused) continue;
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(config.slug)}?event_type=sale&limit=20`,{headers:osHeaders()});
      if(!r.ok) continue;
      const sales=(await r.json()).asset_events||[];
      if(!sales.length) continue;
      const lastId=lastSaleIds.get(guildId);
      if(!lastId){ lastSaleIds.set(guildId,String(sales[0].id||sales[0].event_timestamp)); continue; }
      const newSales=[];
      for(const s of sales){ const sid=String(s.id||s.event_timestamp); if(sid===lastId) break; newSales.push(s); }
      if(!newSales.length) continue;
      lastSaleIds.set(guildId,String(sales[0].id||sales[0].event_timestamp));
      const channel=client.channels.cache.get(config.channelId);
      if(!channel) continue;
      for(const sale of newSales.reverse()){
        // Server-level auto-post
        if(matchesFilters(sale.nft?.traits,config.salesFilters)){
          try{ const embed=await buildSaleEmbed(sale,config); await sendEmbed(channel,embed); }catch(e){ console.error('[Sale post]',e.message); }
        }
        // Personal DM alerts
        await sendPersonalAlerts(sale, 'sale', config);
      }
    }catch(e){ console.error('[Poll sales]',guildId,e.message); }
  }
}

// ── Poll listings ─────────────────────────────────────────────────────────────
async function pollListings(){
  for(const [guildId,config] of Object.entries(serverConfigs)){
    if(!config.listingsChannelId||!config.slug||config.paused) continue;
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(config.slug)}?event_type=listing&limit=20`,{headers:osHeaders()});
      if(!r.ok) continue;
      const listings=(await r.json()).asset_events||[];
      if(!listings.length) continue;
      const lastId=lastListingIds.get(guildId);
      if(!lastId){ lastListingIds.set(guildId,String(listings[0].id||listings[0].event_timestamp)); continue; }
      const newListings=[];
      for(const l of listings){ const lid=String(l.id||l.event_timestamp); if(lid===lastId) break; newListings.push(l); }
      if(!newListings.length) continue;
      lastListingIds.set(guildId,String(listings[0].id||listings[0].event_timestamp));
      const channel=client.channels.cache.get(config.listingsChannelId);
      if(!channel) continue;
      for(const listing of newListings.reverse()){
        const nftTraits=listing.item?.traits||listing.nft?.traits||[];
        // Server-level auto-post
        if(matchesFilters(nftTraits,config.listingFilters)){
          try{ const embed=await buildListingEmbed(listing,config); await sendEmbed(channel,embed); }catch(e){ console.error('[Listing post]',e.message); }
        }
        // Personal DM alerts
        await sendPersonalAlerts(listing, 'listing', config);
      }
    }catch(e){ console.error('[Poll listings]',guildId,e.message); }
  }
}

// ── Personal DM alerts ────────────────────────────────────────────────────────
async function sendPersonalAlerts(event, type, config){
  for(const [userId, alert] of Object.entries(userAlerts)){
    try{
      if(alert.slug && alert.slug !== config.slug) continue;
      if(type==='sale'&&!alert.alertSales) continue;
      if(type==='listing'&&!alert.alertListings) continue;
      const traits=type==='sale'?(event.nft?.traits||[]):(event.item?.traits||event.nft?.traits||[]);
      if(!matchesFilters(traits,alert.traitFilters)) continue;
      const user=await client.users.fetch(userId).catch(()=>null);
      if(!user) continue;
      const embed=type==='sale'
        ? await buildSaleEmbed(event,config,false)
        : await buildListingEmbed(event,config,false);
      embed.setFooter({text:`Your personal alert - ${config.slug}`});
      await sendEmbed(user,embed);
    }catch(e){ console.warn('[DM alert]',userId,e.message); }
  }
}

// ── Slash commands ────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction)=>{
  if(!interaction.isChatInputCommand()) return;
  const {commandName,guildId}=interaction;
  const config=getConfig(guildId);
  const isAdmin=interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

  // /setup
  if(commandName==='setup'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.',ephemeral:true});
    const channel=interaction.options.getChannel('channel');
    const slug=interaction.options.getString('collection');
    const contract=(interaction.options.getString('contract')||'').toLowerCase().trim();
    setConfig(guildId,{channelId:channel.id,slug:slug.toLowerCase().trim(),contract,salesFilters:{},listingFilters:{},paused:false});
    await interaction.reply({embeds:[new EmbedBuilder().setTitle('Sales Bot Configured!').setColor(0x2dd4bf)
      .addFields({name:'Sales Channel',value:`<#${channel.id}>`,inline:true},{name:'Collection',value:slug,inline:true},{name:'Contract',value:contract||'not set',inline:true})
      .setDescription('Sales will post automatically. Use `/setlistings` to also enable listing alerts.')],ephemeral:false});
    return;
  }

  // /setlistings
  if(commandName==='setlistings'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.',ephemeral:true});
    const channel=interaction.options.getChannel('channel');
    setConfig(guildId,{listingsChannelId:channel.id});
    await interaction.reply({content:`Listings channel set to <#${channel.id}>. New listings will post there automatically.`,ephemeral:false});
    return;
  }

  // /setchannel
  if(commandName==='setchannel'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.',ephemeral:true});
    const channel=interaction.options.getChannel('channel');
    setConfig(guildId,{channelId:channel.id});
    await interaction.reply({content:`Sales channel updated to <#${channel.id}>`,ephemeral:true});
    return;
  }

  // /setcollection
  if(commandName==='setcollection'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.',ephemeral:true});
    const slug=interaction.options.getString('slug').toLowerCase().trim();
    const contract=(interaction.options.getString('contract')||'').toLowerCase().trim();
    setConfig(guildId,{slug,contract,salesFilters:{},listingFilters:{}});
    await interaction.reply({content:`Collection set to **${slug}**`,ephemeral:true});
    return;
  }

  // /salesfilter
  if(commandName==='salesfilter'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.',ephemeral:true});
    const trait=interaction.options.getString('trait').toLowerCase().trim();
    const value=interaction.options.getString('value').toLowerCase().trim();
    const filters={...(config.salesFilters||{}),[trait]:value};
    setConfig(guildId,{salesFilters:filters});
    await interaction.reply({content:`Sales filter set: **${trait}** = ${value}\nUse \`/clearfilters\` to remove.`,ephemeral:true});
    return;
  }

  // /listingfilter
  if(commandName==='listingfilter'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.',ephemeral:true});
    const trait=interaction.options.getString('trait').toLowerCase().trim();
    const value=interaction.options.getString('value').toLowerCase().trim();
    const filters={...(config.listingFilters||{}),[trait]:value};
    setConfig(guildId,{listingFilters:filters});
    await interaction.reply({content:`Listing filter set: **${trait}** = ${value}\nUse \`/clearfilters\` to remove.`,ephemeral:true});
    return;
  }

  // /clearfilters
  if(commandName==='clearfilters'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.',ephemeral:true});
    setConfig(guildId,{salesFilters:{},listingFilters:{}});
    await interaction.reply({content:'All server filters cleared.',ephemeral:true});
    return;
  }

  // /pause
  if(commandName==='pause'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.',ephemeral:true});
    setConfig(guildId,{paused:true});
    await interaction.reply({content:'Paused. Use `/resume` to restart.',ephemeral:true});
    return;
  }

  // /resume
  if(commandName==='resume'){
    if(!isAdmin) return interaction.reply({content:'Need Manage Server permission.',ephemeral:true});
    setConfig(guildId,{paused:false});
    await interaction.reply({content:'Resumed!',ephemeral:true});
    return;
  }

  // /status
  if(commandName==='status'){
    const sf=config.salesFilters&&Object.keys(config.salesFilters).length>0?Object.entries(config.salesFilters).map(([k,v])=>`${k}=${v}`).join(', '):'none';
    const lf=config.listingFilters&&Object.keys(config.listingFilters).length>0?Object.entries(config.listingFilters).map(([k,v])=>`${k}=${v}`).join(', '):'none';
    await interaction.reply({embeds:[new EmbedBuilder().setTitle('Bot Status').setColor(0x7aa2ff)
      .addFields(
        {name:'Collection',value:config.slug||'not set',inline:true},
        {name:'Paused',value:config.paused?'Yes':'No',inline:true},
        {name:'Sales Channel',value:config.channelId?`<#${config.channelId}>`:'not set',inline:true},
        {name:'Listings Channel',value:config.listingsChannelId?`<#${config.listingsChannelId}>`:'not set',inline:true},
        {name:'Sales Filters',value:sf,inline:true},
        {name:'Listing Filters',value:lf,inline:true},
      )],ephemeral:true});
    return;
  }

  // /lastsale
  if(commandName==='lastsale'){
    const slug=interaction.options.getString('collection')||config.slug;
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.',ephemeral:true});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=1`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply('No sales found.');return;}
      const embed=await buildSaleEmbed(sales[0],{...config,slug},true);
      const ir=embed._imageResult;delete embed._imageResult;
      if(ir?.type==='buffer'){const att=new AttachmentBuilder(ir.buffer,{name:ir.filename});embed.setThumbnail(`attachment://${ir.filename}`);await interaction.editReply({embeds:[embed],files:[att]});}
      else{if(ir?.type==='url')embed.setThumbnail(ir.url);await interaction.editReply({embeds:[embed]});}
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /recentsales
  if(commandName==='recentsales'){
    const slug=interaction.options.getString('collection')||config.slug;
    const count=Math.min(interaction.options.getInteger('count')||5,10);
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.',ephemeral:true});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=${count}`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply('No sales found.');return;}
      await interaction.editReply(`Last ${sales.length} sales for **${slug}**:`);
      const cfg={...config,slug};
      for(const sale of sales.reverse()){const embed=await buildSaleEmbed(sale,cfg,true);await sendEmbed(interaction.channel,embed);await new Promise(r=>setTimeout(r,800));}
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /sale token:ID
  if(commandName==='sale'){
    const tokenId=interaction.options.getString('token').replace('#','');
    const slug=interaction.options.getString('collection')||config.slug;
    const contract=config.contract||'';
    if(!slug) return interaction.reply({content:'Run `/setup` first.',ephemeral:true});
    if(!contract) return interaction.reply({content:'Set a contract with `/setcollection`.',ephemeral:true});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/chain/ethereum/contract/${contract}/nfts/${tokenId}?event_type=sale&limit=1`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const sales=(await r.json()).asset_events||[];
      if(!sales.length){await interaction.editReply(`No sales found for #${tokenId}.`);return;}
      const embed=await buildSaleEmbed(sales[0],config,true);
      const ir=embed._imageResult;delete embed._imageResult;
      if(ir?.type==='buffer'){const att=new AttachmentBuilder(ir.buffer,{name:ir.filename});embed.setThumbnail(`attachment://${ir.filename}`);await interaction.editReply({embeds:[embed],files:[att]});}
      else{if(ir?.type==='url')embed.setThumbnail(ir.url);await interaction.editReply({embeds:[embed]});}
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /traitfind
  if(commandName==='traitfind'){
    const slug=interaction.options.getString('collection')||config.slug;
    const trait=interaction.options.getString('trait').toLowerCase().trim();
    const value=interaction.options.getString('value').toLowerCase().trim();
    const want=Math.min(interaction.options.getInteger('count')||5,10);
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.',ephemeral:true});
    await interaction.deferReply();
    try{
      const matched=[];let cursor=null;let pages=0;
      await interaction.editReply(`Searching sales for **${trait}: ${value}**...`);
      while(matched.length<want&&pages<15){
        const qs=new URLSearchParams({event_type:'sale',limit:'100'});
        if(cursor) qs.set('next',cursor);
        const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?${qs}`,{headers:osHeaders()});
        if(!r.ok) break;
        const j=await r.json();const sales=j.asset_events||[];if(!sales.length) break;
        for(const sale of sales){
          if(matched.length>=want) break;
          const lookup={};for(const t of (sale.nft?.traits||[])) lookup[t.trait_type?.toLowerCase()]=String(t.value).toLowerCase();
          if(lookup[trait]===value) matched.push(sale);
        }
        cursor=j.next||null;if(!cursor) break;pages++;
      }
      if(!matched.length){await interaction.editReply(`No sales found with **${trait}: ${value}** in the last ${pages*100} sales.`);return;}
      await interaction.editReply(`Found **${matched.length}** sale${matched.length===1?'':'s'} with **${trait}: ${value}**:`);
      const cfg={...config,slug};
      for(const sale of matched){const embed=await buildSaleEmbed(sale,cfg,true);await sendEmbed(interaction.channel,embed);await new Promise(r=>setTimeout(r,800));}
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /listings
  if(commandName==='listings'){
    const slug=interaction.options.getString('collection')||config.slug;
    const count=Math.min(interaction.options.getInteger('count')||5,10);
    if(!slug) return interaction.reply({content:'Run `/setup` first or provide a collection.',ephemeral:true});
    await interaction.deferReply();
    try{
      const r=await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=listing&limit=${count}`,{headers:osHeaders()});
      if(!r.ok){await interaction.editReply('OpenSea error: '+r.status);return;}
      const listings=(await r.json()).asset_events||[];
      if(!listings.length){await interaction.editReply('No listings found.');return;}
      await interaction.editReply(`${listings.length} recent listings for **${slug}**:`);
      const cfg={...config,slug};
      for(const l of listings.reverse()){const embed=await buildListingEmbed(l,cfg,true);await sendEmbed(interaction.channel,embed);await new Promise(r=>setTimeout(r,800));}
    }catch(e){await interaction.editReply('Error: '+e.message);}
    return;
  }

  // /myalert — personal DM alert setup
  if(commandName==='myalert'){
    const trait=interaction.options.getString('trait')?.toLowerCase().trim();
    const value=interaction.options.getString('value')?.toLowerCase().trim();
    const alertSales=interaction.options.getBoolean('sales')??true;
    const alertListings=interaction.options.getBoolean('listings')??true;
    const slug=interaction.options.getString('collection')||config.slug;
    if(!slug) return interaction.reply({content:'Provide a collection or run `/setup` in a configured server first.',ephemeral:true});

    const existing=getAlert(interaction.user.id)||{};
    const filters={...(existing.traitFilters||{})};
    if(trait&&value) filters[trait]=value;

    setAlert(interaction.user.id,{slug,traitFilters:filters,alertSales,alertListings});

    const filterStr=Object.keys(filters).length>0?Object.entries(filters).map(([k,v])=>`**${k}** = ${v}`).join(', '):'none (all)';
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

    await interaction.reply({content:lines,ephemeral:true});
    return;
  }

  // /myalertclear
  if(commandName==='myalertclear'){
    deleteAlert(interaction.user.id);
    await interaction.reply({content:'Your personal alert has been removed.',ephemeral:true});
    return;
  }

  // /myalertstatus
  if(commandName==='myalertstatus'){
    const alert=getAlert(interaction.user.id);
    if(!alert){await interaction.reply({content:'You have no personal alert set. Use `/myalert` to create one.',ephemeral:true});return;}
    const filterStr=alert.traitFilters&&Object.keys(alert.traitFilters).length>0?Object.entries(alert.traitFilters).map(([k,v])=>`**${k}** = ${v}`).join('\n'):'none (all events)';
    const lines=[
      `Collection: **${alert.slug||'any'}**`,
      `Sales DMs: ${alert.alertSales?'on':'off'}`,
      `Listing DMs: ${alert.alertListings?'on':'off'}`,
      `Filters:\n${filterStr}`
    ].join('\n');
    await interaction.reply({content:lines,ephemeral:true});
    return;
  }

  // /help
  if(commandName==='help'){
    const adminCmds=[
      '`/setup` - Configure sales channel + collection',
      '`/setlistings` - Set the listings channel',
      '`/setchannel` - Change sales channel',
      '`/setcollection` - Change collection',
      '`/salesfilter` - Filter auto-posted sales by trait',
      '`/listingfilter` - Filter auto-posted listings by trait',
      '`/clearfilters` - Clear all server filters',
      '`/pause` / `/resume` - Pause/resume auto-posts',
      '`/status` - Show server config'
    ].join('\n');
    const publicCmds=[
      '`/lastsale` - Most recent sale',
      '`/recentsales count:10` - Last N sales',
      '`/sale token:1234` - Specific token last sale',
      '`/traitfind trait:Type value:Zombie` - Search sales by trait',
      '`/listings count:5` - Recent new listings',
      '`/myalert trait:Type value:Zombie sales:true listings:true` - Get DMs for matching events',
      '`/myalertclear` - Remove your DM alert',
      '`/myalertstatus` - See your alert settings',
      '`/help` - This message'
    ].join('\n');
    await interaction.reply({embeds:[new EmbedBuilder().setTitle('NFT Sales Bot - Commands').setColor(0x7aa2ff)
      .addFields({name:'Admin Commands (Manage Server required)',value:adminCmds,inline:false},{name:'Public Commands',value:publicCmds,inline:false})],ephemeral:true});
    return;
  }
});

// ── Welcome message on server join ────────────────────────────────────────────
client.on('guildCreate', async (guild)=>{
  try{
    // Send welcome DM to server owner only — keeps it private and targeted
    const owner = await guild.fetchOwner().catch(()=>null);
    const target = owner?.user || null;
    if(!target) return;

    const desc=[
      'I post NFT **sales** and **listings** alerts with token images, price, traits, buyer/seller links, and more.',
      '',
      'Works with **any OpenSea collection**. Each server configures independently.'
    ].join('\n');

    const setup=[
      '**Step 1 - Sales channel:**',
      '`/setup channel:#all-sales collection:your-slug contract:0x...`',
      '',
      '**Step 2 - Listings channel:**',
      '`/setlistings channel:#all-listings`',
      '',
      '**Step 3 - Test it:**',
      '`/lastsale` and `/listings`',
      '',
      'Thats it! Both channels will auto-post immediately.'
    ].join('\n');

    const channelTip=[
      'Recommended 4-channel setup:',
      '',
      '**#all-sales** - auto-posts every sale (make read-only for members)',
      '**#all-listings** - auto-posts every listing (make read-only for members)',
      '**#sales-search** - members use `/traitfind`, `/recentsales`, `/sale`',
      '**#listings-search** - members use `/listings`',
      '',
      'To make a channel read-only: Channel Settings > Permissions > @everyone > disable Send Messages'
    ].join('\n');

    const personalAlerts=[
      'Anyone can set personal DM alerts with `/myalert`.',
      'They get a private DM when a matching sale or listing happens.',
      '',
      '`/myalert trait:Type value:Zombie sales:true listings:true`',
      '- DM me whenever a Zombie sells or gets listed',
      '',
      '`/myalert trait:Background value:Blue listings:true sales:false`',
      '- DM me only when a Blue Background token gets listed',
      '',
      '`/myalertclear` - Remove your alert',
      '`/myalertstatus` - See your current alert'
    ].join('\n');

    const serverFilters=[
      'Admins can filter what auto-posts to each channel:',
      '',
      '`/salesfilter trait:Type value:Zombie`',
      'Only post sales where Type = Zombie',
      '',
      '`/listingfilter trait:Background value:Blue`',
      'Only post listings where Background = Blue',
      '',
      '`/clearfilters` - Remove all server filters',
      '`/status` - See current configuration'
    ].join('\n');

    const embed = new EmbedBuilder()
      .setTitle('Thanks for adding the NFT Sales Bot!')
      .setColor(0x2dd4bf)
      .setDescription(desc)
      .addFields(
        {name:'Quick Setup (2 minutes)', value:setup, inline:false},
        {name:'Recommended Channel Layout', value:channelTip, inline:false},
        {name:'Personal DM Alerts (anyone can use)', value:personalAlerts, inline:false},
        {name:'Server-Wide Filters (admin only)', value:serverFilters, inline:false}
      )
      .setFooter({text:'Use /help anytime to see all commands'});

    await target.send({embeds:[embed]});
    console.log('[Welcome] Sent setup DM to owner of '+guild.name);
  }catch(e){ console.warn('[Welcome]',guild.name,e.message); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
client.once('ready',()=>{
  console.log('Bot online as '+client.user.tag);
  console.log('Servers: '+Object.keys(serverConfigs).length);
  console.log('OpenSea key: '+(OPENSEA_KEY?'set':'NOT SET'));
  pollSales();
  pollListings();
  setInterval(pollSales, POLL_MS);
  setInterval(pollListings, POLL_MS);
});

client.on('error',e=>console.error('[Discord]',e.message));
process.on('unhandledRejection',e=>console.error('[Bot]',e));
client.login(DISCORD_TOKEN);
