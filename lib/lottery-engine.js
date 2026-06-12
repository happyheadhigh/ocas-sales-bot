'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { COLORS, DEFAULT_LOTTERY_TIMEZONE, ALCHEMY_KEY } = require('./constants');
const { BURN_COLORS, E1_TYPE_NAMES, burnTypeLabel, normalizeOcasType } = require('./burn-constants');
const { pgPool } = require('./db');
const { sendErrorWebhook } = require('./error');
const { burnRpc, burnRpcUrl, fetchEthBlockHashSeed, waitForEthBlock } = require('./rpc');
const { lotteryPick, pendingDrawSeed, isPendingDrawSeed, randomLotterySeed, lotteryHash, normalizeLotteryTimezone } = require('../utils/lottery');
const { resolveDiscordChannel } = require('./burn-poller');
const { lotteryTime, formatBurnLotteryWindow, shortAddr } = require('../utils/format');

function etherscanAddressLink(addr){
  const a = String(addr || '').toLowerCase();
  if(!/^0x[a-f0-9]{40}$/.test(a)) return String(addr || 'unknown');
  return `[${shortAddr(a)}](https://etherscan.io/address/${a})`;
}

function buildBurnLotteryEmbed({title='OCAS Burn Lottery', prize, mode, start, end, seed, entries, wallets, burns, pick, lotteryId, timezone=DEFAULT_LOTTERY_TIMEZONE, seedMeta=null}){
  const timeZone = normalizeLotteryTimezone(timezone);
  const embed = new EmbedBuilder().setTitle(`🎟️ ${title}`).setColor(COLORS.OCAS_GREEN).addFields(
    { name:'Window', value:formatBurnLotteryWindow(start, end, timeZone), inline:false },
    { name:'Mode', value:mode === 'burn' ? 'One entry per burn' : 'One entry per wallet', inline:true },
    { name:'Qualified Wallets', value:String(wallets.length), inline:true },
    { name:'Total Burns', value:String(burns.length), inline:true },
  );
  if(prize) embed.addFields({ name:'Prize', value:String(prize).slice(0,1024), inline:false });
  if(pick?.winner) embed.addFields({ name:'Winner', value:etherscanAddressLink(pick.winner), inline:false });
  if(pick?.proof){
    const blockLine = seedMeta?.block_number
      ? `\nSeed source: Ethereum block [#${seedMeta.block_number}](https://etherscan.io/block/${seedMeta.block_number})`
      : seedMeta?.seed_type === 'random_fallback' ? `\nSeed source: cryptographic random (ETH RPC unavailable — result is fair but not on-chain verifiable)` : '';
    embed.addFields({
      name:'Draw Proof',
      value:`Winning entry: **${(pick.position || pick.index + 1).toLocaleString()} of ${entries.length.toLocaleString()}**\nProof: \`${pick.proof.slice(0,32)}...\`${blockLine}`,
      inline:false
    });
  }
  embed.setFooter({ text: lotteryId ? `Lottery ID ${lotteryId}` : 'Instant draw' }).setTimestamp();
  return embed;
}
async function drawAndPostBurnLottery(row){
  // Claim the lottery immediately to prevent double-draw during ETH block wait
  const claim = await pgPool.query(`UPDATE burn_lotteries SET status='processing' WHERE id=$1 AND status='active' RETURNING id`, [row.id]);
  if(!claim.rows.length) return; // Another process already claimed it
  const start = new Date(row.start_time), end = new Date(row.end_time);
  const timeZone = row.timezone || DEFAULT_LOTTERY_TIMEZONE;
  const { entries, wallets, burns } = await getBurnLotteryEntries(start, end, row.mode);

  // Edit the original scheduled embed to show fetching state
  let originalMsg = null;
  if(row.message_id && row.channel_id){
    try{
      const ch = await resolveDiscordChannel(row.channel_id);
      if(ch){
        originalMsg = await ch.messages.fetch(row.message_id).catch(() => null);
        if(originalMsg){
          const fetchingEmbed = EmbedBuilder.from(originalMsg.embeds[0])
            .setDescription('⏳ Entry window closed — fetching Ethereum block hash for tamper-proof seed...');
          await originalMsg.edit({ embeds:[fetchingEmbed], components:buildActiveBurnLotteryComponents(row.id) }).catch(() => {});
        }
      }
    }catch(_){}
  }

  let drawSeed, seedMeta = {};

  if(isPendingDrawSeed(row.seed)){
    // Use Ethereum block hash as the tamper-proof public seed.
    // Target: the block mined 5 blocks after the end of the lottery window,
    // giving finality and ensuring no one (including the bot operator) can
    // predict or influence the seed before the entry window closes.
    try{
      const rpcUrl = process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://','https://') ||
        `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
      const latestBlock = parseInt(await burnRpc(rpcUrl, 'eth_blockNumber', []), 16);
      const targetBlock = latestBlock + 5;
      console.log(`[BurnLottery #${row.id}] Waiting for Ethereum block #${targetBlock} (current: ${latestBlock})...`);
      const arrived = await waitForEthBlock(targetBlock);
      if(arrived){
        const { hash, blockNumber } = await fetchEthBlockHashSeed(targetBlock);
        drawSeed = hash; // Full 66-char 0x-prefixed block hash is the seed
        seedMeta = { seed_type: 'eth_block_hash', block_number: blockNumber, block_hash: hash };
        console.log(`[BurnLottery #${row.id}] Seed: block #${blockNumber} hash ${hash}`);
      } else {
        // Fallback to randomBytes if RPC unavailable after timeout
        drawSeed = randomLotterySeed();
        seedMeta = { seed_type: 'random_fallback', reason: 'eth_block_timeout' };
        console.warn(`[BurnLottery #${row.id}] ETH block timeout — falling back to random seed`);
      }
    }catch(e){
      drawSeed = randomLotterySeed();
      seedMeta = { seed_type: 'random_fallback', reason: e.message };
      console.warn(`[BurnLottery #${row.id}] ETH block fetch failed: ${e.message} — falling back to random seed`);
    }
  } else {
    // Admin-supplied seed or already-completed lottery being re-viewed — keep as-is
    drawSeed = String(row.seed || randomLotterySeed());
    seedMeta = { seed_type: 'admin_supplied' };
  }

  const pick = lotteryPick(entries, drawSeed);
  await pgPool.query(
    `UPDATE burn_lotteries
     SET status='completed', seed=$1, winner_wallet=$2, qualified_wallets=$3, total_burns=$4,
         result_json=$5, completed_at=NOW()
     WHERE id=$6`,
    [drawSeed, pick?.winner||null, wallets.length, burns.length,
     JSON.stringify({entries:entries.length, proof:pick?.proof||null, winner_index:pick?.index ?? null, winner_position:pick?.position ?? null, ...seedMeta}),
     row.id]
  );
  const resultEmbed = buildBurnLotteryEmbed({title:row.title||'OCAS Burn Lottery', prize:row.prize, mode:row.mode, start, end, seed:drawSeed, entries, wallets, burns, pick, lotteryId:row.id, timezone:timeZone, seedMeta});
  const resultComponents = buildBurnLotteryComponents(row.id);

  if(originalMsg){
    // Edit the original message to show the full result — no second message posted
    try{
      await originalMsg.edit({ embeds:[resultEmbed], components:resultComponents }).catch(() => {});
    }catch(_){}
  } else {
    // No original message to edit (e.g. auto-draw with no stored message_id) — post fresh
    const ch = await resolveDiscordChannel(row.channel_id);
    if(ch) await ch.send({ embeds:[resultEmbed], components:resultComponents });
  }
}
async function processDueBurnLotteries(){
  const r = await pgPool.query(`SELECT * FROM burn_lotteries WHERE status='active' AND end_time <= NOW() ORDER BY end_time ASC LIMIT 5`).catch(()=>({rows:[]}));
  for(const row of r.rows){
    try{
      console.log(`[BurnLottery #${row.id}] Auto-draw triggered`);
      await drawAndPostBurnLottery(row);
      console.log(`[BurnLottery #${row.id}] Draw complete`);
    }catch(e){
      console.warn('[BurnLottery auto]', row.id, e.message);
      sendErrorWebhook('BurnLottery Auto-Draw Error', e, `lottery=${row.id}`);
    }
  }
}
function lotteryNumberFromSeed(seed,min,max){ const lo=Math.min(parseInt(min),parseInt(max)), hi=Math.max(parseInt(min),parseInt(max)); const h=lotteryHash(seed); return lo + Number(BigInt('0x'+h.slice(0,16)) % BigInt(hi-lo+1)); }
function lotteryEntryButton(row){ return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`lottery_enter:${row.id}`).setLabel('Enter Giveaway').setStyle(ButtonStyle.Success)); }
function buildGenericLotteryComponents(lotteryId, type='giveaway', active=true){
  const rows = [];
  if(active && type === 'giveaway'){
    // Active giveaway — entry button only
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lottery_enter:${lotteryId}`).setLabel('Enter Giveaway').setStyle(ButtonStyle.Success)
    ));
  } else {
    // Completed — show draw proof + show entries buttons
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`generic_lottery_proof:${lotteryId}`).setLabel('Show Draw Proof').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`generic_lottery_entries:${lotteryId}`).setLabel('Show Entries').setStyle(ButtonStyle.Secondary)
    ));
  }
  return rows;
}
function buildGenericLotteryStartEmbed(row, count=0){
  const type = String(row.type || 'giveaway');
  const title = row.title || (type === 'guess' ? 'Guess the Number' : 'Giveaway Lottery');

  const embed = new EmbedBuilder()
    .setTitle(`🎲 ${title}`)
    .setColor(COLORS.OCAS_GREEN)
    .addFields(
      { name:'ID',     value:String(row.id),                                       inline:true },
      { name:'Type',   value:type === 'guess' ? 'Guess the number' : 'Giveaway button entries', inline:true },
      { name:'Window', value:`${lotteryTime(row.start_time)} → ${lotteryTime(row.end_time)}`,   inline:false },
    );

  if(row.prize) embed.addFields({ name:'Prize', value:String(row.prize).slice(0, 1024), inline:false });

  if(type === 'guess'){
    embed.addFields(
      { name:'Range',       value:`${row.min_number}–${row.max_number}`,                       inline:true },
      { name:'Winner Mode', value:row.winner_mode === 'exact' ? 'Exact only' : 'Closest wins', inline:true },
      { name:'How to Play', value:`Use \`/lottery guess id:${row.id} number:<guess>\``,         inline:false },
    );
  } else {
    embed.addFields(
      { name:'Entries',    value:String(count),                                                inline:true },
      { name:'How to Enter', value:'Click **Enter Giveaway** below, or use `/lottery enter`.', inline:false },
    );
  }

  embed
    .setFooter({ text:`Lottery ID ${row.id}` })
    .setTimestamp();

  return embed;
}
function buildGenericLotteryResultEmbed(row, entries, result){
  const type = String(row.type || 'giveaway');
  const title = row.title || (type === 'guess' ? 'Guess the Number Result' : 'Giveaway Result');

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${title}`)
    .setColor(COLORS.OCAS_GREEN)
    .addFields(
      { name:'ID',      value:String(row.id),       inline:true },
      { name:'Entries', value:String(entries.length), inline:true },
      ...(row.start_time && row.end_time && String(row.start_time) !== String(row.end_time)
        ? [{ name:'Window', value:`${lotteryTime(row.start_time)} → ${lotteryTime(row.end_time)}`, inline:false }]
        : []),
    );

  if(row.prize) embed.addFields({ name:'Prize', value:String(row.prize).slice(0, 1024), inline:false });

  if(type === 'guess'){
    embed.addFields({ name:'Winning Number', value:String(row.winning_number), inline:true });
    if(result?.winner){
      embed.addFields(
        { name:'Winner',       value:`<@${result.winner.user_id}>`,    inline:true },
        { name:'Winning Guess', value:String(result.winner.guess_number), inline:true },
      );
    } else {
      embed.addFields({ name:'Winner', value:row.winner_mode === 'exact' ? 'No exact guess.' : 'No valid guesses.', inline:false });
    }
  } else {
    if(result?.winner){
      // row.winner_display = raw entry value for instant draws (name/number)
      // Otherwise use Discord mention for real user IDs, or plain username fallback
      const isSnowflake = /^\d{17,19}$/.test(String(result.winner.user_id || ''));
      const baseName = row.winner_display
        ? String(row.winner_display)
        : isSnowflake
          ? `<@${result.winner.user_id}>`
          : String(result.winner.username || result.winner.user_id || 'Unknown');
      const pos = result.position || row.result_json?.winner_position || null;
      const winnerDisplay = baseName;
      embed.addFields({ name:'Winner', value:winnerDisplay, inline:false });
    } else {
      embed.addFields({ name:'Winner', value:'No eligible entries.', inline:false });
    }
  }

  const rj = row.result_json || {};
  const blockNum = rj.block_number || null;
  const seedLine = blockNum
    ? `[Block #${blockNum}](https://etherscan.io/block/${blockNum}) — \`${String(row.seed).slice(0, 100)}\``
    : `\`${String(row.seed).slice(0, 256)}\``;
  embed.addFields({ name:'Seed', value:seedLine, inline:false });
  if(result?.proof) embed.addFields({ name:'Proof', value:`\`${result.proof.slice(0, 32)}...\``, inline:false });

  return embed.setFooter({ text:`Lottery ID ${row.id}` }).setTimestamp();
}
async function findActiveGenericLottery(guildId,type=null){ const params=[guildId]; let q=`SELECT * FROM generic_lotteries WHERE guild_id=$1 AND status='active' AND end_time > NOW()`; if(type){params.push(type); q+=` AND type=$2`;} q+=` ORDER BY id DESC LIMIT 1`; const r=await pgPool.query(q,params); return r.rows[0]||null; }
async function getGenericLotteryEntryCount(id){ const r=await pgPool.query('SELECT COUNT(*)::int count FROM generic_lottery_entries WHERE lottery_id=$1',[id]).catch(()=>({rows:[{count:0}]})); return parseInt(r.rows[0]?.count||0); }
async function drawGenericLottery(row, post=true, ethSeed=null, ethBlockNumber=null, preClaimed=false){
  // Claim to prevent double-draw. Skip if caller already claimed (processDueGenericLotteries).
  if(!preClaimed){
    const claim = await pgPool.query(
      `UPDATE generic_lotteries SET status='processing' WHERE id=$1 AND status='active' RETURNING id`,
      [row.id]
    );
    if(!claim.rows.length) return { embed:null, entries:[], result:{winner:null,proof:null}, components:[] };
  }

  // Fetch entries ordered by entry time then user ID for deterministic results
  const er = await pgPool.query(
    'SELECT user_id, username, guess_number, entered_at FROM generic_lottery_entries WHERE lottery_id=$1 ORDER BY entered_at ASC, user_id ASC',
    [row.id]
  );
  const entries = er.rows;
  let result = { winner: null, proof: null };

  // Use ETH block hash seed if provided.
  // If ETH fetch failed and the stored seed is still a pending placeholder, generate a
  // cryptographic random seed so the result embed never shows a raw __PENDING_DRAW_SEED__ string.
  const activeSeed = ethSeed || (isPendingDrawSeed(row.seed) ? randomLotterySeed() : row.seed);

  if(row.type === 'guess'){
    const valid = entries.filter(x => x.guess_number != null);
    // Determine winning number from seed if not already set
    row.winning_number = row.winning_number ?? lotteryNumberFromSeed(
      `${activeSeed}:winning-number`, row.min_number || 1, row.max_number || 100
    );
    // Find exact matches first
    let pool = valid.filter(x => parseInt(x.guess_number) === parseInt(row.winning_number));
    // Fall back to closest guess if no exact match and not exact-only mode
    if(!pool.length && row.winner_mode !== 'exact' && valid.length){
      const minDist = Math.min(...valid.map(x => Math.abs(parseInt(x.guess_number) - parseInt(row.winning_number))));
      pool = valid.filter(x => Math.abs(parseInt(x.guess_number) - parseInt(row.winning_number)) === minDist);
    }
    if(pool.length){
      const p = lotteryPick(pool.map(x => x.user_id), `${activeSeed}:guess:${row.id}:${row.winning_number}`);
      result = { winner: pool.find(x => x.user_id === p.winner) || pool[0], proof: p.proof };
    }
  } else {
    // Giveaway mode — pick from all entries
    const p = lotteryPick(entries.map(x => x.user_id), `${activeSeed}:giveaway:${row.id}`);
    if(p) result = { winner: entries.find(x => x.user_id === p.winner) || entries[p.index], proof: p.proof };
  }

  // Always write the final seed back to DB — covers ETH hash, random fallback, and pending→resolved
  await pgPool.query('UPDATE generic_lotteries SET seed=$1 WHERE id=$2', [activeSeed, row.id]).catch(() => {});

  // Mark completed and store result
  await pgPool.query(
    `UPDATE generic_lotteries
     SET status='completed', winner_user_id=$1, winner_display=$2, winner_guess=$3,
         entry_count=$4, result_json=$5, completed_at=NOW(), winning_number=$6
     WHERE id=$7`,
    [
      result.winner?.user_id || null,
      result.winner?.username || null,
      result.winner?.guess_number ?? null,
      entries.length,
      JSON.stringify({ proof: result.proof || null, winner_index: result.index ?? null, winner_position: result.position ?? null, block_number: ethBlockNumber || null }),
      row.winning_number ?? null,
      row.id,
    ]
  );

  // Ensure row.seed reflects the final resolved seed for the result embed
  row.seed = activeSeed;
  const embed = buildGenericLotteryResultEmbed(row, entries, result);
  const resultComponents = buildGenericLotteryComponents(row.id, row.type, false);
  if(post){
    const ch = await resolveDiscordChannel(row.channel_id);
    if(ch) await ch.send({ embeds: [embed], components: resultComponents });
  }
  return { embed, entries, result, components: resultComponents };
}

async function processDueGenericLotteries(){
  const r = await pgPool.query(
    `SELECT * FROM generic_lotteries WHERE status='active' AND end_time <= NOW() ORDER BY end_time ASC LIMIT 5`
  ).catch(() => ({ rows: [] }));

  for(const row of r.rows){
    try{
      // Claim immediately — prevents a second poller cycle from racing during the ETH block wait
      const claim = await pgPool.query(
        `UPDATE generic_lotteries SET status='processing' WHERE id=$1 AND status='active' RETURNING id`,
        [row.id]
      );
      if(!claim.rows.length){ console.log(`[Lottery #${row.id}] Already claimed, skipping`); continue; }

      console.log(`[Lottery #${row.id}] Auto-draw triggered type=${row.type}`);

      // Edit original message to show fetching state
      let originalMsg = null;
      if(row.message_id && row.channel_id){
        try{
          const ch = await resolveDiscordChannel(row.channel_id);
          if(ch){
            originalMsg = await ch.messages.fetch(row.message_id).catch(() => null);
            if(originalMsg){
              const fetchingEmbed = EmbedBuilder.from(originalMsg.embeds[0])
                .setDescription('⏳ Entry window closed — fetching Ethereum block hash for tamper-proof seed...');
              await originalMsg.edit({ embeds:[fetchingEmbed], components:[] }).catch(() => {});
            }
          }
        }catch(_){}
      }

      // Fetch ETH block hash seed
      let ethSeed = null;
      let ethBlockNumber = null;
      try{
        const rpcUrlA = process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://', 'https://') ||
          `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
        const latestBlockA = parseInt(await burnRpc(rpcUrlA, 'eth_blockNumber', []), 16);
        const targetBlockA = latestBlockA + 5;
        console.log(`[Lottery #${row.id}] Waiting for Ethereum block #${targetBlockA} (current: ${latestBlockA})...`);
        const arrivedA = await waitForEthBlock(targetBlockA);
        if(arrivedA){
          const { hash: bHashA } = await fetchEthBlockHashSeed(targetBlockA);
          ethSeed = bHashA;
          ethBlockNumber = targetBlockA;
          console.log(`[Lottery #${row.id}] Seed: block hash ${bHashA}`);
        } else {
          console.warn(`[Lottery #${row.id}] ETH block timeout — using stored seed`);
        }
      }catch(ethErr){
        console.warn(`[Lottery #${row.id}] ETH seed failed: ${ethErr.message} — using stored seed`);
      }

      await drawGenericLottery(row, true, ethSeed, ethBlockNumber, true);

      // Update original message to show draw complete
      if(originalMsg){
        try{
          const doneEmbed = EmbedBuilder.from(originalMsg.embeds[0]).setDescription('✅ Draw complete.');
          await originalMsg.edit({ embeds:[doneEmbed], components:[] }).catch(() => {});
        }catch(_){}
      }

      console.log(`[Lottery #${row.id}] Draw complete`);
    }catch(e){
      console.warn('[GenericLottery auto]', row.id, e.message);
      sendErrorWebhook('GenericLottery Auto-Draw Error', e, `lottery=${row.id}`);
    }
  }
}




async function getBurnLotteryEntries(start, end, mode='wallet'){
  const { pgPool } = require('./db');
  const r = await pgPool.query(`
    SELECT id, burner_wallet, survivor_token_id, tx_hash, burned_at
    FROM burn_events
    WHERE burned_at >= $1 AND burned_at < $2
      AND burner_wallet IS NOT NULL AND TRIM(burner_wallet) <> ''
    ORDER BY burned_at ASC, id ASC
  `, [start, end]);
  const burns   = r.rows;
  const wallets = [...new Set(burns.map(b=>String(b.burner_wallet).toLowerCase()).filter(Boolean))];
  const entries = mode === 'burn' ? burns.map(b=>String(b.burner_wallet).toLowerCase()).filter(Boolean) : wallets;
  return { entries, wallets, burns };
}


function buildBurnLotteryComponents(lotteryId){
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  if(!lotteryId) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`burnlottery_proof:${lotteryId}`).setLabel('Show Draw Proof').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`burnlottery_entries:${lotteryId}:0`).setLabel('Show Entries').setStyle(ButtonStyle.Secondary)
  )];
}

function buildActiveBurnLotteryComponents(lotteryId){
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  if(!lotteryId) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`burnlottery_current_entries:${lotteryId}:0`).setLabel('Show Current Entries').setStyle(ButtonStyle.Secondary)
  )];
}

module.exports = {
  buildBurnLotteryEmbed, buildActiveBurnLotteryComponents, buildBurnLotteryComponents,
  buildGenericLotteryStartEmbed, buildGenericLotteryResultEmbed,
  buildGenericLotteryComponents, getGenericLotteryEntryCount,
  drawGenericLottery, processDueGenericLotteries,
  getBurnLotteryEntries, drawAndPostBurnLottery, processDueBurnLotteries,
  buildBurnLotteryComponents, buildActiveBurnLotteryComponents,
  findActiveGenericLottery, lotteryNumberFromSeed,
};
