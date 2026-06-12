'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

async function handleLotteryCommand(commandName, ctx){
  const {
    interaction, guildId, isAdmin,
    pgPool, checkCommandCooldown,
    pendingDrawSeed, isPendingDrawSeed, randomLotterySeed, lotteryPick,
    waitForEthBlock, fetchEthBlockHashSeed, burnRpc,
    buildGenericLotteryStartEmbed, buildGenericLotteryResultEmbed,
    buildGenericLotteryComponents, drawGenericLottery,
    processDueGenericLotteries, resolveLotteryWindow,
    resolveDiscordChannel, COLORS,
    timeSince, lotteryTime, formatEth,
    sendErrorWebhook, findActiveGenericLottery,
    lotteryNumberFromSeed, getGenericLotteryEntryCount,
  } = ctx;

  if(commandName==='lottery'){
    const sub = interaction.options.getSubcommand(false) || 'instant';
    const adminOnly = ['start','draw','cancel','instant'].includes(sub);
    if(adminOnly && !isAdmin) return interaction.reply({ content:'Need Manage Server permission.', flags:MessageFlags.Ephemeral });

    try{

      // ── /lottery instant — quick one-off draw from a list or number range ──
      if(sub === 'instant'){
        await interaction.deferReply();
        const entriesRaw = interaction.options.getString('entries') || '';
        const min        = interaction.options.getInteger('min');
        const max        = interaction.options.getInteger('max');
        const customSeed = interaction.options.getString('seed') || null;
        const title      = interaction.options.getString('title') || 'Instant Lottery';

        let entries = entriesRaw ? entriesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
        if(!entries.length && min != null && max != null){
          for(let i = Math.min(min, max); i <= Math.max(min, max); i++) entries.push(String(i));
        }
        if(entries.length < 2) return interaction.editReply('Add at least 2 entries, or set min and max numbers.');

        // Insert record early so we have an ID for the Show Entries button
        const preInsert = await pgPool.query(
          `INSERT INTO generic_lotteries
             (guild_id, channel_id, created_by, title, type, start_time, end_time, seed, status, min_number, max_number)
           VALUES ($1,$2,$3,$4,'giveaway',NOW(),NOW(),$5,'processing',$6,$7) RETURNING id`,
          [guildId, interaction.channel.id, interaction.user.id, title, pendingDrawSeed(),
           min ?? null, max ?? null]
        );
        const lotteryId = preInsert.rows[0]?.id;

        // Store entries in DB — use positional key (name:index) so duplicates are preserved for weighted draws
        for(let i = 0; i < entries.length; i++){
          await pgPool.query(
            `INSERT INTO generic_lottery_entries (lottery_id, user_id, username)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [lotteryId, `${entries[i]}:${i}`, entries[i]]
          ).catch(()=>{});
        }

        // Show details embed with ⏳ while fetching ETH seed
        const instantEmbed = new EmbedBuilder()
          .setTitle(`🎲 ${title}`)
          .setColor(COLORS.OCAS_GREEN)
          .setDescription('⏳ Fetching Ethereum block hash for tamper-proof seed...')
          .addFields(
            { name:'ID',      value:String(lotteryId), inline:true },
            { name:'Type',    value:'Instant draw',    inline:true },
            { name:'Entries', value:String(entries.length), inline:true },
          )
          .setFooter({ text:`Lottery ID ${lotteryId}` })
          .setTimestamp();
        await interaction.editReply({ embeds:[instantEmbed], components:[
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`generic_lottery_entries:${lotteryId}`).setLabel('Show Entries').setStyle(ButtonStyle.Secondary)
          )
        ] });

        // Fetch ETH block hash seed
        let ethSeed = null, ethBlockNumber = null;
        if(!customSeed){
          try{
            const rpcUrl = process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://','https://') ||
              `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
            const latestBlock   = parseInt(await burnRpc(rpcUrl, 'eth_blockNumber', []), 16);
            const targetBlock   = latestBlock + 5;
            const arrived       = await waitForEthBlock(targetBlock);
            if(arrived){
              const { hash } = await fetchEthBlockHashSeed(targetBlock);
              ethSeed        = hash;
              ethBlockNumber = targetBlock;
            }
          }catch(_){}
        }

        const activeSeed = customSeed || ethSeed || randomLotterySeed();
        const pick       = lotteryPick(entries, activeSeed);

        // Update DB record with result
        await pgPool.query(
          `UPDATE generic_lotteries SET seed=$1, status='completed', result_json=$2, completed_at=NOW() WHERE id=$3`,
          [activeSeed, JSON.stringify({ proof: pick.proof||null, winner_index: pick.index??null, winner_position: pick.position??null, block_number: ethBlockNumber||null }), lotteryId]
        ).catch(()=>{});

        // Build result row for embed
        // winner_display stores the raw entry value (name or number) for instant draws
        const resultRow = { id: lotteryId, title, type:'giveaway', seed: activeSeed,
          winner_display: String(pick.winner),
          result_json: { proof: pick.proof||null, block_number: ethBlockNumber||null } };
        const resultEmbed = buildGenericLotteryResultEmbed(resultRow, entries.map(e=>({ username:e, user_id:e })), pick);
        const resultComponents = buildGenericLotteryComponents(lotteryId, 'giveaway', false);

        return interaction.editReply({ embeds:[resultEmbed], components:resultComponents });
      }

      // ── /lottery start — create a new scheduled giveaway or guess lottery ──
      if(sub === 'start'){
        await interaction.deferReply();

        const type       = interaction.options.getString('type');
        const minutes    = Math.max(1, Math.min(10080, interaction.options.getInteger('minutes') || 10));
        const start      = new Date();
        const end        = new Date(start.getTime() + minutes * 60000);
        // Giveaway seeds are pending until draw time (ETH block hash assigned after window closes).
        // Guess lotteries use a fixed seed so the winning number can be pre-committed.
        const adminSeed  = interaction.options.getString('seed');
        const seed       = adminSeed || (type === 'giveaway' ? pendingDrawSeed() : require('crypto').randomBytes(12).toString('hex'));
        const channel    = interaction.options.getChannel('channel') || interaction.channel;
        const title      = interaction.options.getString('title') || (type === 'guess' ? 'Guess the Number' : 'Giveaway Lottery');
        const prize      = interaction.options.getString('prize') || null;

        let minN = interaction.options.getInteger('min') ?? 1;
        let maxN = interaction.options.getInteger('max') ?? 100;
        let winnerMode = interaction.options.getString('winner') || 'closest';
        let winning = null;

        if(type === 'guess'){
          if(minN === maxN) return interaction.editReply('Min and max cannot match.');
          const lo = Math.min(minN, maxN), hi = Math.max(minN, maxN);
          minN = lo; maxN = hi;
          winning = lotteryNumberFromSeed(`${seed}:winning-number`, minN, maxN);
        } else {
          minN = null; maxN = null; winnerMode = 'random';
        }

        const r = await pgPool.query(
          `INSERT INTO generic_lotteries
             (guild_id, channel_id, created_by, title, prize, type, min_number, max_number,
              winner_mode, winning_number, start_time, end_time, seed, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active') RETURNING *`,
          [guildId, channel.id, interaction.user.id, title, prize, type,
           minN, maxN, winnerMode, winning, start, end, seed]
        );
        const row = r.rows[0];
        const components = buildGenericLotteryComponents(row.id, type, true);
        const msg = await interaction.editReply({ embeds:[buildGenericLotteryStartEmbed(row, 0)], components });
        await pgPool.query('UPDATE generic_lotteries SET message_id=$1 WHERE id=$2', [msg.id, row.id]).catch(() => {});
        console.log(`[Lottery #${row.id}] Started type=${type} minutes=${minutes} guild=${guildId}`);
        return;
      }

      // ── /lottery enter — enter an active giveaway ──
      if(sub === 'enter'){
        const id = interaction.options.getInteger('id');
        const row = id
          ? (await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1 AND guild_id=$2', [id, guildId])).rows[0]
          : await findActiveGenericLottery(guildId, 'giveaway');

        if(!row) return interaction.reply({ content:'No active giveaway found.', flags:MessageFlags.Ephemeral });
        if(row.status !== 'active' || new Date(row.end_time) <= new Date())
          return interaction.reply({ content:'This giveaway is closed.', flags:MessageFlags.Ephemeral });

        const username = interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || interaction.user.id;
        await pgPool.query(
          `INSERT INTO generic_lottery_entries (lottery_id, user_id, username)
           VALUES ($1,$2,$3) ON CONFLICT (lottery_id, user_id) DO UPDATE SET username=EXCLUDED.username`,
          [row.id, interaction.user.id, username]
        );
        const count = await getGenericLotteryEntryCount(row.id);
        return interaction.reply({ content:`You are entered in lottery #${row.id}. Current entries: ${count}.`, flags:MessageFlags.Ephemeral });
      }

      // ── /lottery guess — submit a guess for a guess-type lottery ──
      if(sub === 'guess'){
        const number = interaction.options.getInteger('number');
        const id = interaction.options.getInteger('id');
        const row = id
          ? (await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1 AND guild_id=$2', [id, guildId])).rows[0]
          : await findActiveGenericLottery(guildId, 'guess');

        if(!row) return interaction.reply({ content:'No active guess lottery found.', flags:MessageFlags.Ephemeral });
        if(row.status !== 'active' || new Date(row.end_time) <= new Date())
          return interaction.reply({ content:'This guess event is closed.', flags:MessageFlags.Ephemeral });
        if(number < row.min_number || number > row.max_number)
          return interaction.reply({ content:`Guess must be between ${row.min_number} and ${row.max_number}.`, flags:MessageFlags.Ephemeral });

        const username = interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || interaction.user.id;
        await pgPool.query(
          `INSERT INTO generic_lottery_entries (lottery_id, user_id, username, guess_number)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (lottery_id, user_id) DO UPDATE SET
             username=EXCLUDED.username, guess_number=EXCLUDED.guess_number, entered_at=NOW()`,
          [row.id, interaction.user.id, username, number]
        );
        return interaction.reply({ content:`Your guess for lottery #${row.id} is **${number}**.`, flags:MessageFlags.Ephemeral });
      }

      // ── /lottery status — show active or recent lotteries ──
      if(sub === 'status'){
        const id = interaction.options.getInteger('id');
        const r = id
          ? await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1 AND guild_id=$2', [id, guildId])
          : await pgPool.query('SELECT * FROM generic_lotteries WHERE guild_id=$1 ORDER BY id DESC LIMIT 10', [guildId]);

        if(!r.rows.length) return interaction.reply({ content:'No lotteries found.', flags:MessageFlags.Ephemeral });

        const lines = [];
        for(const x of r.rows){
          const c = await getGenericLotteryEntryCount(x.id);
          lines.push(
            `#${x.id} · ${x.type} · ${x.status} · entries ${c} · ` +
            `${lotteryTime(x.start_time)} → ${lotteryTime(x.end_time)}` +
            (x.winner_user_id ? ` · winner <@${x.winner_user_id}>` : '')
          );
        }
        return interaction.reply(lines.join('\n').slice(0, 1900));
      }

      // ── /lottery draw — manually draw a winner with ETH block hash seed ──
      if(sub === 'draw'){
        await interaction.deferReply();

        const id = interaction.options.getInteger('id');
        const r = await pgPool.query('SELECT * FROM generic_lotteries WHERE id=$1 AND guild_id=$2', [id, guildId]);
        const row = r.rows[0];
        if(!row) return interaction.editReply('Lottery not found.');
        if(row.status !== 'active') return interaction.editReply('Lottery is not active.');

        // Show full lottery details with ⏳ while fetching ETH seed
        const entryCount = (await pgPool.query('SELECT COUNT(*) FROM generic_lottery_entries WHERE lottery_id=$1', [id])).rows[0]?.count || 0;
        const drawFetchEmbed = buildGenericLotteryStartEmbed({ ...row, _entry_count: parseInt(entryCount) }, parseInt(entryCount))
          .setDescription('⏳ Fetching Ethereum block hash for tamper-proof seed...');
        await interaction.editReply({ embeds:[drawFetchEmbed], components:[
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`generic_lottery_entries:${row.id}`).setLabel('Show Entries').setStyle(ButtonStyle.Secondary)
          )
        ] });

        let ethSeed = null, ethBlockNumber = null;
        try{
          const rpcUrlG = process.env.ALCHEMY_WEBSOCKET_URL?.replace('wss://', 'https://') ||
            `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
          const latestBlockG  = parseInt(await burnRpc(rpcUrlG, 'eth_blockNumber', []), 16);
          const targetBlockG  = latestBlockG + 5;
          const arrivedG      = await waitForEthBlock(targetBlockG);
          if(arrivedG){
            const { hash: bHashG } = await fetchEthBlockHashSeed(targetBlockG);
            ethSeed        = bHashG;
            ethBlockNumber = targetBlockG;
          }
        }catch(_){}

        const out = await drawGenericLottery(row, false, ethSeed, ethBlockNumber, true);

        // Update interaction reply to ✅ done — result posted via drawGenericLottery
        const doneEmbed = EmbedBuilder.from(drawFetchEmbed).setDescription('✅ Draw complete.');
        return interaction.editReply({ embeds:[doneEmbed], components:[] });
      }

      // ── /lottery cancel — cancel an active lottery ──
      if(sub === 'cancel'){
        const id = interaction.options.getInteger('id');
        const r = await pgPool.query(
          "UPDATE generic_lotteries SET status='cancelled' WHERE id=$1 AND guild_id=$2 AND status='active' RETURNING id",
          [id, guildId]
        );
        return interaction.reply(r.rows.length ? `Cancelled lottery #${id}.` : `No active lottery #${id} found.`);
      }

    }catch(e){
      console.error('[/lottery]', e);
      sendErrorWebhook('/lottery Error', e, `guild=${guildId} sub=${sub}`);
      const msg = 'Lottery error: ' + e.message;
      return interaction.deferred ? interaction.editReply(msg) : interaction.reply({ content:msg, flags:MessageFlags.Ephemeral });
    }
  }

}

const LOTTERY_COMMANDS = new Set(['lottery']);

module.exports = { handleLotteryCommand, LOTTERY_COMMANDS };
