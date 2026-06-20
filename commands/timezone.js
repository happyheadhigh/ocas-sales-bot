'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');
const { normalizeLotteryTimezone } = require('../utils/lottery');

// ── Per-user saved timezone ────────────────────────────────────────────────────
// Used by /giveaway so date-only inputs (e.g. "June 16 2026") resolve against
// the person's own timezone instead of always falling back to the server's
// configured default. Stored globally per Discord user, not per-guild, since a
// person's physical timezone doesn't change between servers.

async function getUserTimezone(pgPool, userId){
  const r = await pgPool.query('SELECT timezone FROM user_timezones WHERE user_id=$1', [userId]).catch(()=>({rows:[]}));
  return r.rows[0]?.timezone || null;
}

async function handleTimezoneCommand(interaction, ctx){
  const { pgPool } = ctx;
  const sub = interaction.options.getSubcommand();

  if(sub === 'set'){
    const tzRaw = interaction.options.getString('timezone', true).trim();
    let tz;
    try{
      tz = normalizeLotteryTimezone(tzRaw);
    }catch(e){
      return interaction.reply({ content: `❌ ${e.message}`, flags: MessageFlags.Ephemeral });
    }
    await pgPool.query(
      `INSERT INTO user_timezones (user_id, timezone, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (user_id) DO UPDATE SET timezone=EXCLUDED.timezone, updated_at=NOW()`,
      [interaction.user.id, tz]
    );
    const now = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle:'full', timeStyle:'short' }).format(new Date());
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setDescription(`✅ Your timezone is set to **${tz}**.\n\nIt's currently **${now}** there.\n\nDate-only inputs in \`/giveaway\` (like "June 16 2026") will now use this timezone instead of the server default.`)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if(sub === 'clear'){
    await pgPool.query('DELETE FROM user_timezones WHERE user_id=$1', [interaction.user.id]);
    return interaction.reply({ content: '✅ Your saved timezone was cleared. The server default will be used again.', flags: MessageFlags.Ephemeral });
  }

  if(sub === 'show'){
    const tz = await getUserTimezone(pgPool, interaction.user.id);
    if(!tz){
      return interaction.reply({ content: 'You haven\'t set a personal timezone yet. Use `/timezone set` to add one.', flags: MessageFlags.Ephemeral });
    }
    const now = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle:'full', timeStyle:'short' }).format(new Date());
    return interaction.reply({ content: `Your saved timezone is **${tz}**.\nIt's currently **${now}** there.`, flags: MessageFlags.Ephemeral });
  }
}

const TIMEZONE_COMMANDS = new Set(['timezone']);

module.exports = { handleTimezoneCommand, getUserTimezone, TIMEZONE_COMMANDS };
