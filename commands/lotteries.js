'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const PAGE  = 5; // rows per page

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtTime(ts){ return ts ? `<t:${Math.floor(new Date(ts).getTime()/1000)}:R>` : '—'; }
function fmtSeed(seed){ return seed ? `\`${String(seed).slice(0,20)}${seed.length>20?'…':''}\`` : '`pending`'; }
function statusEmoji(s){ return s==='active'?'🟢':s==='processing'?'🟡':s==='completed'?'✅':'❌'; }
function typeLabel(row){
  if(row._table==='burn') return '🔥 Burn Lottery';
  return row.type==='guess' ? '🎯 Guess Lottery' : '🎁 Giveaway';
}

// ── Build rows from both tables ───────────────────────────────────────────────
function mergeRows(burnRows, genericRows){
  const all = [
    ...burnRows.map(r=>({...r, _table:'burn'})),
    ...genericRows.map(r=>({...r, _table:'generic'})),
  ];
  // Sort: active first, then by created/start time desc
  all.sort((a,b)=>{
    const aActive = a.status==='active'?0:1;
    const bActive = b.status==='active'?0:1;
    if(aActive!==bActive) return aActive-bActive;
    return new Date(b.start_time||0) - new Date(a.start_time||0);
  });
  return all;
}

// ── Dashboard embed ───────────────────────────────────────────────────────────
function buildDashboardEmbed(all, page, filter){
  const filtered = filter==='all' ? all
    : filter==='live'      ? all.filter(r=>r.status==='active')
    : all.filter(r=>r.status==='completed'||r.status==='cancelled');

  const total  = filtered.length;
  const pages  = Math.max(1, Math.ceil(total/PAGE));
  const slice  = filtered.slice(page*PAGE, page*PAGE+PAGE);
  const live   = all.filter(r=>r.status==='active').length;

  let desc = SEP + '\n';
  desc += `**${live} live** · ${all.length} total\n` + SEP + '\n\n';

  if(slice.length===0){
    desc += '*No lotteries found.*\n';
  } else {
    for(const r of slice){
      const winner = r._table==='burn'
        ? (r.winner_wallet ? `\`${r.winner_wallet.slice(0,6)}…${r.winner_wallet.slice(-4)}\`` : '—')
        : (r.winner_display ? `**${r.winner_display}**` : '—');
      desc +=
        `${statusEmoji(r.status)} **${r.title||'Untitled'}** · ${typeLabel(r)}\n` +
        `> ID: \`${r._table[0].toUpperCase()}${r.id}\` · ${r.status==='active'?'Ends ':r.status==='completed'?'Ended ':''}${fmtTime(r.end_time||r.completed_at)}\n` +
        (r.status!=='active' ? `> Winner: ${winner}\n` : '') +
        `> Seed: ${fmtSeed(r.seed)}\n\n`;
    }
  }

  if(pages>1) desc += `*Page ${page+1} of ${pages}*`;

  return { embed: new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎰 Lotteries & Giveaways')
    .setDescription(desc)
    .setFooter({ text: 'Only visible to you' }),
    filtered, pages, page };
}

// ── Detail embed for a single lottery ────────────────────────────────────────
function buildDetailEmbed(r, entryCount){
  const isGeneric = r._table==='generic';
  const winner = isGeneric
    ? (r.winner_display||'—')
    : (r.winner_wallet ? `${r.winner_wallet.slice(0,6)}…${r.winner_wallet.slice(-4)}` : '—');

  const seed = r.seed||'pending';
  const proof = r.result_json?.proof || null;

  let desc = SEP + '\n\n';
  desc += `${statusEmoji(r.status)} **Status:** ${r.status}\n`;
  desc += `**Type:** ${typeLabel(r)}\n`;
  desc += `**Title:** ${r.title||'Untitled'}\n`;
  if(r.prize) desc += `**Prize:** ${r.prize}\n`;
  desc += `**Entries:** ${entryCount}\n`;
  desc += `**Starts:** ${fmtTime(r.start_time)}\n`;
  desc += `**Ends:** ${fmtTime(r.end_time)}\n`;
  if(r.status!=='active'){
    desc += `**Completed:** ${fmtTime(r.completed_at)}\n`;
    desc += `**Winner:** ${winner}\n`;
  }
  desc += '\n**Seed / Hash:**\n';
  desc += `\`\`\`${seed}\`\`\``;
  if(proof) desc += `**Draw proof:** \`${String(proof).slice(0,60)}\`\n`;
  if(r.channel_id) desc += `\n**Channel:** <#${r.channel_id}>\n`;

  return new EmbedBuilder()
    .setColor(r.status==='active'?0x57F287:r.status==='completed'?0x5865F2:0xED4245)
    .setTitle(`🎰 ${r.title||'Lottery'} — ID: ${r._table[0].toUpperCase()}${r.id}`)
    .setDescription(desc)
    .setFooter({ text: 'Only visible to you' });
}

// ── Button rows ───────────────────────────────────────────────────────────────
function dashboardButtons(page, pages, filter){
  const filterRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ltrs:filter:all').setLabel('All').setStyle(filter==='all'?ButtonStyle.Primary:ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ltrs:filter:live').setLabel('🟢 Live').setStyle(filter==='live'?ButtonStyle.Primary:ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ltrs:filter:done').setLabel('✅ Completed').setStyle(filter==='done'?ButtonStyle.Primary:ButtonStyle.Secondary),
  );
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ltrs:prev').setLabel('← Prev').setStyle(ButtonStyle.Secondary).setDisabled(page===0),
    new ButtonBuilder().setCustomId('ltrs:next').setLabel('Next →').setStyle(ButtonStyle.Secondary).setDisabled(page>=pages-1),
    new ButtonBuilder().setCustomId('ltrs:refresh').setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
  );
  return [filterRow, navRow];
}

function detailButtons(r){
  const isLive = r.status==='active';
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ltrs:back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
      ...(isLive ? [
        new ButtonBuilder()
          .setCustomId(`ltrs:draw:${r._table}:${r.id}`)
          .setLabel('🎲 Draw Now')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`ltrs:cancel:${r._table}:${r.id}`)
          .setLabel('❌ Cancel')
          .setStyle(ButtonStyle.Danger),
      ] : []),
    ),
  ];
  return rows;
}

// ── Session state (in-memory per user, ephemeral so fine) ─────────────────────
const sessions = new Map(); // userId → { page, filter, all }

async function fetchAll(pgPool, guildId){
  const [bRes, gRes] = await Promise.all([
    pgPool.query('SELECT * FROM burn_lotteries WHERE guild_id=$1 ORDER BY id DESC', [guildId]).catch(()=>({rows:[]})),
    pgPool.query('SELECT * FROM generic_lotteries WHERE guild_id=$1 ORDER BY id DESC', [guildId]).catch(()=>({rows:[]})),
  ]);
  return mergeRows(bRes.rows, gRes.rows);
}

// ── Main command handler ───────────────────────────────────────────────────────
async function handleLotteriesCommand(interaction, ctx){
  await interaction.deferReply({ flags: 64 });
  const { pgPool } = ctx;
  const all = await fetchAll(pgPool, interaction.guildId);
  const session = { page:0, filter:'all', all };
  sessions.set(interaction.user.id, session);
  const { embed, filtered, pages } = buildDashboardEmbed(all, 0, 'all');

  // Add clickable ID buttons for live lotteries only — completed ones don't need action buttons
  const rows = dashboardButtons(0, pages, 'all');
  const liveLotteries = all.filter(r=>r.status==='active');
  if(liveLotteries.length>0){
    const idBtns = liveLotteries.slice(0,5).map(r=>
      new ButtonBuilder()
        .setCustomId(`ltrs:detail:${r._table}:${r.id}`)
        .setLabel(`${r._table[0].toUpperCase()}${r.id} 🟢`)
        .setStyle(ButtonStyle.Success)
    );
    if(idBtns.length) rows.push(new ActionRowBuilder().addComponents(idBtns));
  }

  return interaction.editReply({ embeds:[embed], components:rows });
}

// ── Button handler ─────────────────────────────────────────────────────────────
async function handleLotteriesButton(interaction, ctx){
  const { pgPool } = ctx;
  const guildId  = interaction.guildId;
  const userId   = interaction.user.id;
  const customId = interaction.customId;
  await interaction.deferUpdate();

  let session = sessions.get(userId) || { page:0, filter:'all', all:[] };

  // ── Refresh / filter / page ────────────────────────────────────────────────
  if(customId==='ltrs:refresh' || customId.startsWith('ltrs:filter:') || customId==='ltrs:prev' || customId==='ltrs:next'){
    if(customId==='ltrs:refresh'){
      session.all = await fetchAll(pgPool, guildId);
    }
    if(customId.startsWith('ltrs:filter:')){
      session.filter = customId.split(':')[2];
      session.page   = 0;
    }
    if(customId==='ltrs:prev') session.page = Math.max(0, session.page-1);
    if(customId==='ltrs:next') session.page++;
    sessions.set(userId, session);

    const { embed, filtered, pages } = buildDashboardEmbed(session.all, session.page, session.filter);
    const rows = dashboardButtons(session.page, pages, session.filter);
    const liveItems = session.all.filter(r=>r.status==='active');
    if(liveItems.length){
      rows.push(new ActionRowBuilder().addComponents(
        liveItems.slice(0,5).map(r=>
          new ButtonBuilder()
            .setCustomId(`ltrs:detail:${r._table}:${r.id}`)
            .setLabel(`${r._table[0].toUpperCase()}${r.id} 🟢`)
            .setStyle(ButtonStyle.Success)
        )
      ));
    }
    return interaction.editReply({ embeds:[embed], components:rows });
  }

  // ── Detail view ────────────────────────────────────────────────────────────
  if(customId.startsWith('ltrs:detail:')){
    const [,,table,idStr] = customId.split(':');
    const id = parseInt(idStr);
    const tbl = table==='burn' ? 'burn_lotteries' : 'generic_lotteries';
    const r = await pgPool.query(`SELECT * FROM ${tbl} WHERE id=$1 AND guild_id=$2`,[id,guildId]).catch(()=>({rows:[]}));
    if(!r.rows.length) return interaction.editReply({ content:'❌ Lottery not found.', embeds:[], components:[] });
    const row = {...r.rows[0], _table:table};

    let entryCount = 0;
    if(table==='generic'){
      const ec = await pgPool.query('SELECT COUNT(*) FROM generic_lottery_entries WHERE lottery_id=$1',[id]).catch(()=>({rows:[{count:0}]}));
      entryCount = parseInt(ec.rows[0].count)||0;
    } else {
      entryCount = row.qualified_wallets||0;
    }

    return interaction.editReply({ embeds:[buildDetailEmbed(row, entryCount)], components:detailButtons(row) });
  }

  // ── Back to dashboard ──────────────────────────────────────────────────────
  if(customId==='ltrs:back'){
    session.all = await fetchAll(pgPool, guildId);
    sessions.set(userId, session);
    const { embed, filtered, pages } = buildDashboardEmbed(session.all, session.page, session.filter);
    const rows = dashboardButtons(session.page, pages, session.filter);
    const liveItems = session.all.filter(r=>r.status==='active');
    if(liveItems.length){
      rows.push(new ActionRowBuilder().addComponents(
        liveItems.slice(0,5).map(r=>
          new ButtonBuilder()
            .setCustomId(`ltrs:detail:${r._table}:${r.id}`)
            .setLabel(`${r._table[0].toUpperCase()}${r.id} 🟢`)
            .setStyle(ButtonStyle.Success)
        )
      ));
    }
    return interaction.editReply({ embeds:[embed], components:rows });
  }

  // ── Draw now ───────────────────────────────────────────────────────────────
  if(customId.startsWith('ltrs:draw:')){
    const [,,table,idStr] = customId.split(':');
    const id = parseInt(idStr);

    if(table==='generic'){
      const { drawGenericLottery } = require('../lib/lottery-engine');
      const r = await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1 AND guild_id=$2',[id,guildId]).catch(()=>({rows:[]}));
      if(!r.rows.length || r.rows[0].status!=='active')
        return interaction.editReply({ content:'❌ Lottery not found or already drawn.', embeds:[], components:[] });
      const row = {...r.rows[0], _table:'generic'};
      await interaction.editReply({ content:`🎲 Drawing **${row.title}**…`, embeds:[], components:[] });
      await drawGenericLottery(row, true, null, null, false);
      // Refresh detail
      const updated = await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1',[id]).catch(()=>({rows:[]}));
      if(updated.rows.length){
        const ec = await pgPool.query('SELECT COUNT(*) FROM generic_lottery_entries WHERE lottery_id=$1',[id]).catch(()=>({rows:[{count:0}]}));
        const updRow = {...updated.rows[0], _table:'generic'};
        return interaction.editReply({ content:'✅ Draw complete!', embeds:[buildDetailEmbed(updRow, parseInt(ec.rows[0].count)||0)], components:detailButtons(updRow) });
      }
    }

    if(table==='burn'){
      const { drawAndPostBurnLottery } = require('../lib/lottery-engine');
      const r = await pgPool.query('SELECT * FROM burn_lotteries WHERE id=$1 AND guild_id=$2',[id,guildId]).catch(()=>({rows:[]}));
      if(!r.rows.length || r.rows[0].status!=='active')
        return interaction.editReply({ content:'❌ Lottery not found or already drawn.', embeds:[], components:[] });
      const row = {...r.rows[0], _table:'burn'};
      await interaction.editReply({ content:`🎲 Drawing burn lottery **${row.title}**…`, embeds:[], components:[] });
      await drawAndPostBurnLottery(row);
      const updated = await pgPool.query('SELECT * FROM burn_lotteries WHERE id=$1',[id]).catch(()=>({rows:[]}));
      if(updated.rows.length){
        const updRow = {...updated.rows[0], _table:'burn'};
        return interaction.editReply({ content:'✅ Draw complete!', embeds:[buildDetailEmbed(updRow, updRow.qualified_wallets||0)], components:detailButtons(updRow) });
      }
    }

    return interaction.editReply({ content:'✅ Draw triggered.', embeds:[], components:[] });
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────
  if(customId.startsWith('ltrs:cancel:')){
    const [,,table,idStr] = customId.split(':');
    const id = parseInt(idStr);
    const tbl = table==='burn' ? 'burn_lotteries' : 'generic_lotteries';
    await pgPool.query(`UPDATE ${tbl} SET status='cancelled' WHERE id=$1 AND guild_id=$2`,[id,guildId]).catch(()=>{});
    const updated = await pgPool.query(`SELECT * FROM ${tbl} WHERE id=$1`,[id]).catch(()=>({rows:[]}));
    if(updated.rows.length){
      const updRow = {...updated.rows[0], _table:table};
      const ec = table==='generic'
        ? parseInt((await pgPool.query('SELECT COUNT(*) FROM generic_lottery_entries WHERE lottery_id=$1',[id]).catch(()=>({rows:[{count:0}]}))).rows[0].count)||0
        : updRow.qualified_wallets||0;
      return interaction.editReply({ content:'❌ Lottery cancelled.', embeds:[buildDetailEmbed(updRow,ec)], components:detailButtons(updRow) });
    }
    return interaction.editReply({ content:'❌ Cancelled.', embeds:[], components:[] });
  }
}

const LOTTERIES_COMMANDS = new Set(['lotteries']);
module.exports = { handleLotteriesCommand, handleLotteriesButton, LOTTERIES_COMMANDS };

