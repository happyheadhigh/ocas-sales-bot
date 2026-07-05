'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');

const PAGE_SIZE = 25; // Discord's hard cap on select-menu options

// All assignable roles in a guild, @everyone excluded, alphabetical.
function sortedRoles(guild){
  return [...guild.roles.cache.values()]
    .filter(r => r.id !== guild.id)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Builds one page of a manually-paginated role picker.
//
// `targetCustomId` must be the EXACT customId the existing role-selection
// handler already expects (e.g. 'cfg_rolesel:verify', 'setup_traitrole:rolesel').
// Selecting an option fires that handler completely unchanged — discord.js
// exposes `interaction.values[0]` identically whether the component is a
// StringSelectMenu or a native RoleSelectMenu, so nothing downstream needs
// to know the picker changed shape.
//
// `cancelId` is optional; pass null to omit the cancel button (matches
// whatever the original single-menu screen did).
function buildRolePickerRows(guild, targetCustomId, page, cancelId, placeholder){
  const roles = sortedRoles(guild);
  const totalPages = Math.max(1, Math.ceil(roles.length / PAGE_SIZE));
  const clamped = Math.min(Math.max(0, page), totalPages - 1);
  const pageRoles = roles.slice(clamped * PAGE_SIZE, clamped * PAGE_SIZE + PAGE_SIZE);

  const options = pageRoles.length
    ? pageRoles.map(r => new StringSelectMenuOptionBuilder().setLabel(r.name.slice(0, 100)).setValue(r.id))
    : [new StringSelectMenuOptionBuilder().setLabel('No roles found').setValue('__none__')];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(targetCustomId)
    .setPlaceholder(placeholder || 'Pick a role...')
    .addOptions(options);

  const rows = [new ActionRowBuilder().addComponents(menu)];

  const navBtns = [];
  if(totalPages > 1){
    navBtns.push(
      new ButtonBuilder()
        .setCustomId(`rolepg:${targetCustomId}|${clamped - 1}|${cancelId || ''}`)
        .setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(clamped <= 0),
      new ButtonBuilder()
        .setCustomId(`rolepg:${targetCustomId}|${clamped + 1}|${cancelId || ''}`)
        .setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(clamped >= totalPages - 1),
    );
  }
  if(cancelId) navBtns.push(new ButtonBuilder().setCustomId(cancelId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary));
  if(navBtns.length) rows.push(new ActionRowBuilder().addComponents(navBtns));

  const pageLabel = totalPages > 1 ? ` — Page ${clamped + 1} of ${totalPages} (${roles.length} roles)` : '';
  return { rows, pageLabel, totalPages };
}

// Parses a `rolepg:<targetCustomId>|<page>|<cancelId>` pagination-button
// customId. Returns null if this isn't one of ours.
function parseRolePagerCustomId(customId){
  if(!customId.startsWith('rolepg:')) return null;
  const rest = customId.slice('rolepg:'.length);
  const [targetCustomId, pageStr, cancelId] = rest.split('|');
  return { targetCustomId, page: parseInt(pageStr, 10) || 0, cancelId: cancelId || null };
}

module.exports = { buildRolePickerRows, parseRolePagerCustomId };
