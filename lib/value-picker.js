'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');

const PAGE_SIZE = 25; // Discord's hard cap on select-menu options

// Multi-select across pages needs something role-picker's pagination doesn't:
// each page turn is a completely separate Discord interaction round-trip,
// with no built-in memory of what was picked on earlier pages. This session
// map is that memory -- cleared explicitly on Done/Cancel, not time-based,
// since a picker flow is bounded by the user actually finishing it.
const valuePickerSessions = new Map();

function getSession(sessionKey){
  return valuePickerSessions.get(sessionKey) || null;
}
function initSession(sessionKey, values){
  const session = { selected: new Set(), values };
  valuePickerSessions.set(sessionKey, session);
  return session;
}
function clearSession(sessionKey){
  valuePickerSessions.delete(sessionKey);
}

// Builds one page of a paginated multi-select value picker. sessionKey must
// already have a session (call initSession first, on the initial "too many
// values" branch-point) -- page/select interactions read the existing one.
function buildValuePickerRows(sessionKey, page, customIdPrefix, opts={}){
  const session = getSession(sessionKey);
  if(!session) return null;
  const { values, selected } = session;
  const totalPages = Math.max(1, Math.ceil(values.length / PAGE_SIZE));
  const clamped = Math.min(Math.max(0, page), totalPages - 1);
  const pageValues = values.slice(clamped * PAGE_SIZE, clamped * PAGE_SIZE + PAGE_SIZE);

  const options = pageValues.map(v =>
    new StringSelectMenuOptionBuilder()
      .setLabel(String(v).slice(0, 100))
      .setValue(v)
      .setDefault(selected.has(v))
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`vpick:${customIdPrefix}:sel:${clamped}`)
    .setPlaceholder(totalPages > 1
      ? `Page ${clamped + 1}/${totalPages} · ${selected.size} picked · tap Select, then Next below`
      : (opts.placeholder || 'Pick one or more values...'))
    .setMinValues(0)
    .setMaxValues(options.length)
    .addOptions(options);

  const rows = [new ActionRowBuilder().addComponents(menu)];

  const navBtns = [
    new ButtonBuilder().setCustomId(`vpick:${customIdPrefix}:page:${clamped - 1}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(clamped <= 0),
    new ButtonBuilder().setCustomId(`vpick:${customIdPrefix}:page:${clamped + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(clamped >= totalPages - 1),
    new ButtonBuilder().setCustomId(`vpick:${customIdPrefix}:done`).setLabel(`✅ Done (${selected.size})`).setStyle(ButtonStyle.Success).setDisabled(selected.size === 0),
  ];
  if(opts.cancelId) navBtns.push(new ButtonBuilder().setCustomId(opts.cancelId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary));
  rows.push(new ActionRowBuilder().addComponents(navBtns));

  const pageLabel = totalPages > 1
    ? ` — Page ${clamped + 1} of ${totalPages} (${values.length} values, ${selected.size} selected so far)`
    : '';
  return { rows, pageLabel, totalPages, clamped, selectedCount: selected.size };
}

// Called when the select menu itself is submitted on a given page: reconciles
// this page's portion of the accumulated set with whatever's now checked,
// leaving every other page's prior selections untouched.
function applyPageSelection(sessionKey, page, newValuesOnThisPage){
  const session = getSession(sessionKey);
  if(!session) return null;
  const pageValues = session.values.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  for(const v of pageValues) session.selected.delete(v);
  for(const v of newValuesOnThisPage) session.selected.add(v);
  return session;
}

// Parses a `vpick:<customIdPrefix>:sel|page|done:<page>` customId. Prefix
// itself may contain ':' (callers embed their own multi-part context in it),
// so the action/page suffix is always parsed from the right, not the left.
function parseValuePickerCustomId(customId){
  if(!customId.startsWith('vpick:')) return null;
  const rest = customId.slice('vpick:'.length);
  const segs = rest.split(':');
  const last = segs[segs.length - 1];
  if(last === 'done') return { action: 'done', customIdPrefix: segs.slice(0, -1).join(':') };
  if(segs[segs.length - 2] === 'page') return { action: 'page', page: parseInt(last, 10) || 0, customIdPrefix: segs.slice(0, -2).join(':') };
  if(segs[segs.length - 2] === 'sel') return { action: 'sel', page: parseInt(last, 10) || 0, customIdPrefix: segs.slice(0, -2).join(':') };
  return null;
}

module.exports = {
  PAGE_SIZE,
  initSession, getSession, clearSession,
  buildValuePickerRows, applyPageSelection, parseValuePickerCustomId,
};
