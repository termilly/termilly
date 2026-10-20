// @ts-check
// A terminal's tags: the picker on its header's tag button (tick existing tags, or type a new one and pick its
// colour), and setting one.

import { state, emit, persist, ensureTag, TAG_COLORS, EVENTS } from './store.js';
import { openPopover } from './popups.js';
import { tagChipHtml, escapeHtml, ICONS } from './ui.js';
import { field, find, targetOf } from './dom.js';

/** The longest tag name. */
const MAX_TAG = 24;

const normalizeTag = (/** @type {string} */ text) => text.trim().toLowerCase().replace(/\s+/g, '-').slice(0, MAX_TAG);

/** The colour a new tag starts with: the next one round the palette. */
const nextColor = () => TAG_COLORS[state.tags.length % TAG_COLORS.length];

/**
 * @param {Tab} tab
 * @param {string} name
 * @param {boolean} enabled
 */
export function setTag(tab, name, enabled) {
  const has = tab.tags.includes(name);
  if (enabled && !has) tab.tags.push(name);
  if (!enabled && has) tab.tags = tab.tags.filter(t => t !== name);
  emit(EVENTS.tab, tab);
  persist();
}

/**
 * How many terminals have a tag.
 * @param {string} name
 */
const usage = name => [...state.tabs.values()].filter(t => t.tags.includes(name)).length;

/**
 * The picker's list: the tags the query finds (ticked when the terminal has them), and creating a new one.
 * @param {Tab} tab
 * @param {string} query
 * @param {string} newColor
 */
function tagListHtml(tab, query, newColor) {
  const rows = state.tags.filter(t => t.name.includes(query)).map(t => `
      <button class="tp-row" data-tag="${escapeHtml(t.name)}" role="option" aria-selected="${tab.tags.includes(t.name)}">
        <span class="check${tab.tags.includes(t.name) ? ' on' : ''}"><svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg></span>
        ${tagChipHtml(t.name)}<span class="tp-count">${usage(t.name) || ''}</span>
      </button>`);
  if (query && !state.tags.some(t => t.name === query)) rows.push(createRowHtml(query, newColor));
  if (!rows.length) rows.push('<div class="tp-empty">Type a name to create a tag</div>');
  return rows.join('');
}

/**
 * "Create" with the new tag's chip, and the colours to give it (the palette's, or any).
 * @param {string} query
 * @param {string} newColor
 */
function createRowHtml(query, newColor) {
  const custom = !TAG_COLORS.includes(newColor);
  return `
        <div class="tp-sep"></div>
        <button class="tp-row tp-create" data-create="${escapeHtml(query)}">
          <span class="menu-icon">${ICONS.plus}</span>Create
          <span class="tag" style="--c:${newColor}">${escapeHtml(query)}</span>
        </button>
        <div class="swatches">${TAG_COLORS.map(c => `<button class="swatch${c === newColor ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="Colour"></button>`).join('')}
          <label class="swatch custom${custom ? ' on' : ''}" title="Pick any colour"${custom ? ` style="background:${newColor}"` : ''}>
            <input type="color" value="${newColor}" aria-label="Pick any colour"></label></div>`;
}

/**
 * The tag picker: tick existing tags, or type a new name, pick a colour and press Enter.
 * @param {Tab} tab
 * @param {import('./popups.js').Anchor} anchor
 */
export function openTagPicker(tab, anchor) {
  const picker = document.createElement('div');
  picker.className = 'popover tag-picker';
  picker.hidden = true;
  picker.innerHTML = `
    <input class="field" placeholder="Find or create a tag" spellcheck="false" maxlength="${MAX_TAG}" aria-label="Tag">
    <div class="tp-list" role="listbox"></div>`;
  const input = field(picker, 'input');
  const list = find(picker, '.tp-list');
  const picking = { newColor: nextColor() };
  const render = () => { list.innerHTML = tagListHtml(tab, normalizeTag(input.value), picking.newColor); };
  const toggle = (/** @type {string} */ name) => {
    setTag(tab, name, !tab.tags.includes(name));
    render();
  };
  const create = (/** @type {string} */ name) => {
    ensureTag(name, picking.newColor);
    setTag(tab, name, true);
    input.value = '';
    picking.newColor = nextColor();
    render();
  };
  wireList(list, picking, { render, toggle, create, focus: () => input.focus() });
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const query = normalizeTag(input.value);
    if (!query) return;
    if (!state.tags.some(t => t.name === query)) return create(query);
    input.value = '';
    toggle(query);
  });

  render();
  openPopover(picker, anchor, { dynamic: true });
  input.focus();
}

/**
 * The list's clicks (a tag, Create, a colour) and the colour picker, which the new tag's chip follows.
 * @param {HTMLElement} list
 * @param {{ newColor: string }} picking
 * @param {{ render: () => void, toggle: (name: string) => void, create: (name: string) => void,
 *   focus: () => void }} handlers
 */
function wireList(list, picking, { render, toggle, create, focus }) {
  list.addEventListener('mousedown', e => {
    // Keep focus in the input (the colour picker needs it).
    if (/** @type {HTMLInputElement} */ (e.target).type !== 'color') e.preventDefault();
  });
  list.addEventListener('click', e => {
    const swatch = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-color]'));
    if (swatch) {
      picking.newColor = /** @type {string} */ (swatch.dataset.color);
      return render();
    }
    const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tag]'));
    if (row) return toggle(/** @type {string} */ (row.dataset.tag));
    const createRow = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-create]'));
    if (createRow) create(/** @type {string} */ (createRow.dataset.create));
  });
  // While the colour picker is open the chip follows it; choosing redraws the swatches.
  list.addEventListener('input', e => {
    if (/** @type {HTMLInputElement} */ (e.target).type !== 'color') return;
    picking.newColor = /** @type {HTMLInputElement} */ (e.target).value;
    /** @type {HTMLElement | null} */ (list.querySelector('.tp-create .tag'))
      ?.style.setProperty('--c', picking.newColor);
  });
  list.addEventListener('change', e => {
    if (/** @type {HTMLInputElement} */ (e.target).type !== 'color') return;
    picking.newColor = /** @type {HTMLInputElement} */ (e.target).value;
    render();
    focus();
  });
}
