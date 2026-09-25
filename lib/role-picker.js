'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');

const CHUNK = 25; // Discord's hard cap on select-menu options
const MAX_ROWS = 4; // reserve 1 of the 5 available rows for Cancel

// All assignable roles in a guild, @everyone excluded, alphabetical.
function sortedRoles(guild){
  return [...guild.roles.cache.values()]
    .filter(r => r.id !== guild.id)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Builds a stacked single-select role picker -- up to 4 simultaneous menus
// (100 roles) instead of Prev/Next pagination, matching the same pattern
// used for trait categories and collections. Picking a role is a one-shot
// choice, not a multi-select, so no accumulation-across-menus session is
// needed here -- whichever menu the user actually uses fires the existing
// downstream handler completely unchanged.
//
// `targetCustomId` must be the customId prefix the existing role-selection
// handler already expects (e.g. 'cfg_rolesel:verify', 'setup_traitrole:rolesel').
// Each stacked menu gets a distinct customId (`${targetCustomId}:${i}`) since
// Discord requires every component in a message to have a unique custom_id
// (confirmed via their own docs) -- every downstream handler for these
// already reads its type/suffix via split(':') on a fixed position or via
// startsWith, so an appended trailing chunk index doesn't disturb any of
// them; verified this for all call sites before relying on it here too.
//
// `cancelId` is optional; pass null to omit the cancel button.
function buildRolePickerRows(guild, targetCustomId, cancelId, placeholder){
  const roles = sortedRoles(guild);
  const menuCount = Math.max(1, Math.min(MAX_ROWS, Math.ceil(roles.length / CHUNK)));
  const rows = [];

  if(!roles.length){
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${targetCustomId}:0`)
      .setPlaceholder(placeholder || 'Pick a role...')
      .addOptions(new StringSelectMenuOptionBuilder().setLabel('No roles found').setValue('__none__'));
    rows.push(new ActionRowBuilder().addComponents(menu));
  } else {
    for(let i = 0; i < menuCount; i++){
      const slice = roles.slice(i * CHUNK, (i + 1) * CHUNK);
      if(!slice.length) break;
      const options = slice.map(r => new StringSelectMenuOptionBuilder().setLabel(r.name.slice(0, 100)).setValue(r.id));
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`${targetCustomId}:${i}`)
        .setPlaceholder(menuCount > 1 ? `Roles (menu ${i + 1} of ${menuCount})` : (placeholder || 'Pick a role...'))
        .addOptions(options);
      rows.push(new ActionRowBuilder().addComponents(menu));
    }
  }

  if(cancelId) rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cancelId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
  ));

  const pageLabel = roles.length > CHUNK ? ` (${roles.length} roles)` : '';
  return { rows, pageLabel };
}

module.exports = { buildRolePickerRows };
