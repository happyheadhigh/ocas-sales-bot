'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');

const MENU_SIZE = 25; // Discord's hard cap on select-menu options
const MAX_ROWS = 5;   // Discord's hard cap on action rows per message -- each
                       // select menu occupies a full row of its own, so this
                       // is also the max number of stacked menus that fit.

// Tracks which values have been picked so far, purely so re-rendering after
// a submission can mark them as still-checked (.setDefault) across every
// stacked menu -- NOT needed for save correctness, since the actual save
// logic (config.js) is additive and applies directly per-menu-submission.
const valuePickerSessions = new Map();

function initSession(sessionKey, values){
  const session = { selected: new Set(), values };
  valuePickerSessions.set(sessionKey, session);
  return session;
}
function getSession(sessionKey){
  return valuePickerSessions.get(sessionKey) || null;
}
function clearSession(sessionKey){
  valuePickerSessions.delete(sessionKey);
}

// Builds every stacked menu row this value list needs (up to MAX_ROWS), plus
// a Done row in whatever room is left over. If the list needs all 5 rows
// just for menus (100+ values), there's no room for a Done button at all --
// that's fine, since every pick already saved itself the moment it was
// submitted; Done is just a clean way to close out, not a requirement.
function buildStackedValuePickerRows(sessionKey, customIdPrefix, opts={}){
  const session = getSession(sessionKey);
  if(!session) return null;
  const { values, selected } = session;
  const menuCount = Math.min(MAX_ROWS, Math.ceil(values.length / MENU_SIZE));
  const rows = [];

  for(let i = 0; i < menuCount; i++){
    const slice = values.slice(i * MENU_SIZE, (i + 1) * MENU_SIZE);
    if(!slice.length) break;
    const options = slice.map(v =>
      new StringSelectMenuOptionBuilder()
        .setLabel(String(v).slice(0, 100))
        .setValue(v)
        .setDefault(selected.has(v))
    );
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`vpick:${customIdPrefix}:sel:${i}`)
      .setPlaceholder(
        menuCount > 1
          ? `Values ${i * MENU_SIZE + 1}-${i * MENU_SIZE + slice.length} of ${values.length}`
          : (opts.placeholder || 'Pick one or more values...')
      )
      .setMinValues(1)
      .setMaxValues(slice.length)
      .addOptions(options);
    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  if(rows.length < MAX_ROWS){
    const btns = [new ButtonBuilder().setCustomId(`vpick:${customIdPrefix}:done`).setLabel(`✅ Done (${selected.size} picked)`).setStyle(ButtonStyle.Success)];
    if(opts.countButton) btns.push(new ButtonBuilder().setCustomId(`vpick:${customIdPrefix}:setcount`).setLabel('🔢 Set Count').setStyle(ButtonStyle.Primary));
    if(opts.cancelId) btns.push(new ButtonBuilder().setCustomId(opts.cancelId).setLabel('← Back').setStyle(ButtonStyle.Secondary));
    rows.push(new ActionRowBuilder().addComponents(btns));
  }

  const shown = menuCount * MENU_SIZE;
  const truncatedNote = values.length > shown
    ? ` (showing first ${shown} of ${values.length} values)`
    : '';
  return { rows, selectedCount: selected.size, menuCount, truncatedNote };
}

// Records what was picked on one specific menu, purely for the .setDefault
// bookkeeping described above -- callers still apply the actual save
// themselves using interaction.values directly, since that's additive and
// doesn't need this session at all to be correct.
function recordMenuSelection(sessionKey, menuIndex, newValuesOnThisMenu){
  const session = getSession(sessionKey);
  if(!session) return null;
  const sliceValues = session.values.slice(menuIndex * MENU_SIZE, (menuIndex + 1) * MENU_SIZE);
  for(const v of sliceValues) session.selected.delete(v);
  for(const v of newValuesOnThisMenu) session.selected.add(v);
  return session;
}

// Parses a `vpick:<customIdPrefix>:sel:<menuIndex>`, `vpick:<prefix>:done`,
// or `vpick:<prefix>:setcount` customId. Prefix itself may contain ':'
// (callers embed their own multi-part context in it), so the action/index
// suffix is parsed from the right, not the left.
function parseValuePickerCustomId(customId){
  if(!customId.startsWith('vpick:')) return null;
  const rest = customId.slice('vpick:'.length);
  const segs = rest.split(':');
  const last = segs[segs.length - 1];
  if(last === 'done') return { action: 'done', customIdPrefix: segs.slice(0, -1).join(':') };
  if(last === 'setcount') return { action: 'setcount', customIdPrefix: segs.slice(0, -1).join(':') };
  if(segs[segs.length - 2] === 'sel') return { action: 'sel', menuIndex: parseInt(last, 10) || 0, customIdPrefix: segs.slice(0, -2).join(':') };
  return null;
}

module.exports = {
  MENU_SIZE, MAX_ROWS,
  initSession, getSession, clearSession,
  buildStackedValuePickerRows, recordMenuSelection, parseValuePickerCustomId,
};
