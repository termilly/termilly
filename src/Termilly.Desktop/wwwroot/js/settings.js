// @ts-check
// The Settings page: the nav, the search, and the controls every section shares. Each section is a module of its
// own (js/settings/). Every change applies at once and is saved by the host (settings.json, debounced).

import { state, on, emit, getSetting, GROUPS, EVENTS } from './store.js';
import { closeAll, dropdown } from './popups.js';
import { applyTerminalSettings, isLight, onSystemThemeChange } from './terminals.js';
import { THEME_VARIABLES, currentTheme, TERM_FONT_VAR } from './themes.js';
import { cssString, escapeHtml } from './ui.js';
import { compileTriggers } from './triggers.js';
import { updateSettings, setSetting, saveSoon, onApply } from './preferences.js';
import { layer, body, button, page, setRedraw, closeSettings } from './settings/page.js';
import { SECTIONS } from './settings/sections.js';
import { SETTING_VALUES } from './constants.js';
import { byId, field, find, targetOf } from './dom.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { textSmoothing, theme } = SETTING_VALUES;

const nav = byId('set-nav');
const title = byId('set-title');

/** How long a setting the search or palette went to stays lit. */
const FLASH_MS = 1600;
/** The class that lights it. */
const FLASH_CLASS = 'set-flash';
/** Every place a search word shows, in any case. */
const EVERY_MATCH_ANY_CASE = 'gi';

/** The CSS variables for the app's font, and the terminals' font, which the change preview and replays use too. */
const UI_FONT_VAR = '--ui-font';

const sections = Object.values(SECTIONS);

// ---- Settings state ----

/** Applies settings to the page and terminals, and refreshes the page's controls if it's open. */
export function applySettings() {
  const root = document.documentElement;
  // The theme's colours (themes.js): Dark and Light are app.css's own, the others set its colour variables.
  const current = currentTheme();
  root.dataset.theme = current.base;
  for (const name of THEME_VARIABLES) {
    if (current.vars[name]) root.style.setProperty(name, current.vars[name]);
    else root.style.removeProperty(name);
  }
  // The host colours its window and start-up loader with these before the page draws (saved with the settings).
  const windowColors = { ...current.window, light: current.base === theme.light };
  if (JSON.stringify(state.settings.uiState.windowColors) !== JSON.stringify(windowColors)) {
    state.settings.uiState.windowColors = windowColors;
    saveSoon(GROUPS.uiState);
  }
  root.dataset.smoothing = state.settings.terminal.textSmoothing ?? textSmoothing.default;
  // The chosen app font goes in front of the defaults, which still cover characters it lacks.
  const uiFont = state.settings.interface.font;
  if (uiFont) root.style.setProperty(UI_FONT_VAR, `"${cssString(uiFont)}", var(--ui-default-font)`);
  else root.style.removeProperty(UI_FONT_VAR);
  // The change preview shows code in the terminals' font and size.
  root.style.setProperty(TERM_FONT_VAR, `"${cssString(state.settings.terminal.fontFamily)}", var(--mono)`);
  root.style.setProperty('--term-font-size', `${state.settings.terminal.fontSize}px`);
  applyTerminalSettings();
  compileTriggers();
  if (!layer.hidden) syncControls();
  emit(EVENTS.settings); // for parts that follow a setting on their own (the change preview and its button)
}

export const toggleTheme = () => updateSettings(GROUPS.interface, { theme: isLight() ? theme.dark : theme.light });

onSystemThemeChange(applySettings);
onApply(applySettings);

// ---- Page ----

// The nav's search box stays put while the section list under it is redrawn, so it keeps focus and caret.
nav.innerHTML = `<div class="set-nav-head">Settings</div>
  <input class="field set-search" id="set-search" type="search" placeholder="Search settings" spellcheck="false" autocomplete="off">
  <div class="set-nav-items"></div>`;
const searchBox = field(nav, '#set-search');
const navItems = find(nav, '.set-nav-items');

function renderNav() {
  navItems.innerHTML = sections.map(s =>
    `<button class="set-nav-item${s.id === page.current && !searchQuery ? ' on' : ''}" data-section="${s.id}">${s.icon}<span>${s.label}</span></button>`).join('');
}

/** @param {string} id */
function showSection(id) {
  const section = SECTIONS[id];
  if (id !== page.current) section.refresh?.();
  page.current = id;
  searchQuery = '';
  searchBox.value = '';
  renderNav();
  title.textContent = section.label;
  body.innerHTML = section.html();
  body.scrollTop = 0;
  section.drawn?.(body);
  syncControls();
}

// ---- Search ----

/**
 * Other words a search term also finds, for settings named differently from how people look for them.
 * A row can add its own with `row(…, { keywords })`.
 * @type {Record<string, string[]>}
 */
const SYNONYMS = {
  font: ['line height', 'typeface', 'text size', 'letter'],
  text: ['font'],
  size: ['font', 'zoom'],
  agent: ['claude', 'codex', 'hook', 'mcp'],
  claude: ['agent', 'hook'],
  ai: ['claude', 'model', 'provider'],
  proxy: ['jump', 'bastion', 'forward'],
  jump: ['proxy', 'bastion'],
  colour: ['color', 'theme'],
  color: ['colour', 'theme'],
  dark: ['theme', 'light'],
  light: ['theme', 'dark'],
  password: ['secret', 'vault', 'key', 'recovery'],
  copy: ['clipboard'],
  clipboard: ['copy', 'paste', 'osc 52'],
  shortcut: ['keyboard', 'hotkey', 'key', 'chord'],
  hotkey: ['shortcut', 'keyboard'],
  notification: ['notify', 'toast', 'alert'],
  alert: ['notification', 'notify', 'bell', 'trigger'],
  history: ['closed', 'scrollback', 'restore'],
  update: ['version', 'check'],
  diff: ['change preview', 'changed files'],
};

const ROW = '.set-row';
const GROUP = '.set-group';
const ROW_NAME = '.set-name';

let searchQuery = '';
/**
 * The rows the search found, in page order, and the one ↑↓ has picked.
 * @type {HTMLElement[]}
 */
let hits = [];
let hitIndex = 0;

/**
 * Lower-cased words of a query, each with the words it also finds.
 * @param {string} query
 */
const queryTerms = query => query.toLowerCase().split(/\s+/).filter(Boolean)
  .map(word => [word, ...(SYNONYMS[word] ?? [])]);

/**
 * Whether a row's text (label, description, keywords) has every term (or one of its synonyms).
 * @param {HTMLElement} rowEl
 * @param {string[][]} terms
 */
const rowMatches = (rowEl, terms) => {
  const heading = rowEl.closest(GROUP)?.querySelector('h4')?.textContent ?? '';
  const hay = `${heading} ${rowEl.querySelector('.set-label')?.textContent ?? ''} ${rowEl.dataset.keywords ?? ''}`.toLowerCase();
  return terms.every(alternatives => alternatives.some(word => hay.includes(word)));
};

/**
 * A row's name, as the palette and the search go back to it by.
 * @param {Element} rowEl
 */
const rowName = rowEl => rowEl.querySelector(ROW_NAME)?.textContent.trim();

/**
 * A section's rows that match, in a copy of its page (null when none do). Headings stay for context.
 * @param {import('./settings/page.js').Section} section
 * @param {string[][]} terms
 */
function sectionMatches(section, terms) {
  const source = document.createElement('div');
  source.innerHTML = section.html();
  // Matching rows move into fresh groups under their group's heading (rows may sit deeper than a group's
  // children, inside wrappers that the rest of the section needs).
  const holder = document.createElement('div');
  let lastGroup = null;
  let out = null;
  for (const rowEl of /** @type {NodeListOf<HTMLElement>} */ (source.querySelectorAll(ROW))) {
    if (!rowMatches(rowEl, terms)) continue;
    const groupEl = rowEl.closest(GROUP);
    if (!out || groupEl !== lastGroup) {
      lastGroup = groupEl;
      out = document.createElement('section');
      out.className = 'set-group';
      const heading = groupEl?.querySelector(':scope > h4');
      if (heading) out.append(heading.cloneNode(true));
      holder.append(out);
    }
    rowEl.dataset.hitSection = section.id;
    out.append(rowEl);
  }
  return holder.childNodes.length ? holder : null;
}

/**
 * Wraps each place a query word shows in the given elements' text in a highlight.
 * @param {Iterable<Node>} scopes
 * @param {string[]} words
 */
function highlight(scopes, words) {
  const pattern = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), EVERY_MATCH_ANY_CASE);
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    // SHOW_TEXT: the walker visits only text nodes, whose value is their text.
    /** @type {Text[]} */
    const nodes = [];
    while (walker.nextNode()) nodes.push(/** @type {Text} */ (walker.currentNode));
    for (const node of nodes) {
      const text = /** @type {string} */ (node.nodeValue);
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      const span = document.createElement('span');
      span.innerHTML = escapeHtml(text).replace(new RegExp(pattern.source, pattern.flags), m => `<mark class="set-hit">${m}</mark>`);
      node.replaceWith(...span.childNodes);
    }
  }
}

/** Shows every section's matching rows, under the section's name, with the matches highlighted. */
function renderSearch() {
  const terms = queryTerms(searchQuery);
  renderNav();
  title.textContent = 'Search results';
  body.innerHTML = '';
  for (const section of sections) {
    const found = sectionMatches(section, terms);
    if (!found) continue;
    const head = document.createElement('button');
    head.className = 'set-result-head';
    head.dataset.section = section.id;
    head.innerHTML = `${section.icon}<span>${section.label}</span>`;
    body.append(head, ...found.childNodes);
  }
  hits = [.../** @type {NodeListOf<HTMLElement>} */ (body.querySelectorAll(ROW))];
  highlight(body.querySelectorAll(`${ROW} ${ROW_NAME}, ${ROW} .set-desc, ${GROUP} h4`), terms.map(t => t[0]));
  if (!hits.length) body.innerHTML = `<p class="set-desc set-empty">No settings match “${escapeHtml(searchQuery)}”.</p>`;
  hitIndex = 0;
  markHit();
  for (const section of sections) section.drawn?.(body);
  syncControls();
}

/** Marks the picked match and keeps it in view. */
function markHit() {
  hits.forEach((hit, i) => hit.classList.toggle('hit-current', i === hitIndex));
  hits[hitIndex]?.scrollIntoView({ block: 'nearest' });
}

/**
 * Opens a setting's own section and shows it there, briefly lit.
 * @param {string} section
 * @param {string | undefined} name
 */
function revealSetting(section, name) {
  showSection(section);
  const target = [...body.querySelectorAll(ROW)].find(r => rowName(r) === name);
  if (!target) return;
  target.scrollIntoView({ block: 'center' });
  target.classList.add(FLASH_CLASS);
  setTimeout(() => target.classList.remove(FLASH_CLASS), FLASH_MS);
}

searchBox.addEventListener('input', () => {
  searchQuery = searchBox.value.trim();
  if (searchQuery) renderSearch();
  else showSection(page.current);
  searchBox.focus();
});

/**
 * ↑↓ pick a match, Enter opens it in its section (called from the page's key handler below).
 * @param {KeyboardEvent} e
 */
function searchKey(e) {
  if (!searchQuery) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!hits.length) return;
    hitIndex = (hitIndex + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
    markHit();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const hit = hits[hitIndex];
    if (hit) revealSetting(/** @type {string} */ (hit.dataset.hitSection), rowName(hit));
  }
}

/** Every setting by section and name, for the palette's "Settings: …" entries. */
export function settingEntries() {
  /** @type {Array<{ section: string, sectionLabel: string, name: string, keywords: string }>} */
  const entries = [];
  const holder = document.createElement('div');
  for (const section of sections) {
    try { holder.innerHTML = section.html(); } catch { continue; }
    for (const rowEl of /** @type {NodeListOf<HTMLElement>} */ (holder.querySelectorAll(ROW))) {
      const name = rowName(rowEl);
      if (name) entries.push({ section: section.id, sectionLabel: section.label, name, keywords: rowEl.dataset.keywords ?? '' });
    }
  }
  return entries;
}

/**
 * Opens Settings at one setting (from the palette).
 * @param {string} section
 * @param {string} name
 */
export function openSetting(section, name) {
  closeAll();
  layer.hidden = false;
  button.classList.add('open');
  revealSetting(section, name);
}

/** Reflects the current settings in the visible controls. */
function syncControls() {
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (body.querySelectorAll('[data-setting]'))) {
    const value = getSetting(/** @type {string} */ (el.dataset.setting));
    if (el.classList.contains('seg')) {
      for (const b of /** @type {NodeListOf<HTMLElement>} */ (el.querySelectorAll('[data-value]'))) {
        b.classList.toggle('on', String(value) === b.dataset.value);
      }
    } else if (el.classList.contains('switch')) {
      el.setAttribute('aria-checked', String(!!value));
    } else if (el.tagName === 'SELECT') {
      /** @type {HTMLSelectElement} */ (el).value = state.settings.shells.defaultProfile ?? state.profiles[0]?.id ?? '';
    }
  }
  for (const select of /** @type {NodeListOf<HTMLSelectElement>} */ (body.querySelectorAll('select.field'))) {
    dropdown(select);
  }
  for (const section of sections) section.sync?.(body);
}

export function openSettings(id = page.current) {
  closeAll();
  layer.hidden = false;
  button.classList.add('open');
  showSection(id);
  SECTIONS[id].opened?.();
  /** @type {HTMLElement | null} */ (nav.querySelector('.set-nav-item.on'))?.focus();
}

export const toggleSettings = () => (layer.hidden ? openSettings() : closeSettings());
on(EVENTS.openSettings, id => openSettings(id));

/** Re-renders the open section, keeping the scroll position. */
function rerender() {
  const top = body.scrollTop;
  if (searchQuery) renderSearch();
  else showSection(page.current);
  body.scrollTop = top;
}
setRedraw(rerender);

// ---- Events ----

/** Every section's data-action buttons, by name. */
const actions = Object.assign({}, ...sections.map(s => s.actions ?? {}));

/**
 * Saves a setting from one of the shared controls, and tells the sections.
 * @param {string} key
 * @param {unknown} value
 */
function saveSetting(key, value) {
  setSetting(key, value);
  for (const section of sections) section.changed?.(key);
}

nav.addEventListener('click', e => {
  const item = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-section]'));
  if (item) showSection(/** @type {string} */ (item.dataset.section));
});

body.addEventListener('click', e => {
  const head = /** @type {HTMLElement | null} */ (targetOf(e).closest('.set-result-head'));
  if (head) return showSection(/** @type {string} */ (head.dataset.section));
  if (sections.some(s => s.click?.(e))) return;
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-action]'));
  if (action) return actions[/** @type {string} */ (action.dataset.action)]?.(action);

  const option = /** @type {HTMLElement | null} */ (targetOf(e).closest('.seg[data-setting] [data-value]'));
  if (option) {
    const key = /** @type {string} */ (/** @type {HTMLElement} */ (option.closest('[data-setting]')).dataset.setting);
    const raw = option.dataset.value;
    return saveSetting(key, typeof getSetting(key) === 'number' ? Number(raw) : raw);
  }
  const sw = /** @type {HTMLElement | null} */ (targetOf(e).closest('.switch[data-setting]'));
  if (sw) {
    saveSetting(/** @type {string} */ (sw.dataset.setting), !getSetting(/** @type {string} */ (sw.dataset.setting)));
  }
});

body.addEventListener('input', e => {
  for (const section of sections) section.input?.(e);
});
body.addEventListener('change', e => {
  if (sections.some(s => s.change?.(e))) return;
  if (targetOf(e).matches('select[data-setting]')) saveSetting(/** @type {string} */ (targetOf(e).dataset.setting),
    /** @type {HTMLSelectElement} */ (e.target).value);
  if (targetOf(e).matches('input[data-setting-text]')) {
    saveSetting(/** @type {string} */ (targetOf(e).dataset.settingText),
      /** @type {HTMLInputElement} */ (e.target).value.trim() || null);
  }
});

// Keys typed in the page must not reach app shortcuts or the terminal; Escape closes it. Dialogs opened
// from the page (confirm, recovery code) handle their own keys.
document.addEventListener('keydown', e => {
  // The target may be the document itself, which has no closest().
  if (layer.hidden
    || !/** @type {HTMLElement} */ (e.target).closest?.('#settings-layer') && e.target !== document.body) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    // A search clears first; Escape again closes.
    if (searchQuery) {
      searchBox.value = '';
      searchBox.dispatchEvent(new Event('input'));
    } else closeSettings();
  }
  if (e.target === searchBox) searchKey(e);
  // Ctrl+F searches the settings.
  if (e.key === 'f' && e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    searchBox.focus();
    searchBox.select();
  }
  e.stopPropagation();
}, true);
layer.addEventListener('mousedown', e => {
  if (e.target === layer) closeSettings();
});
byId('set-close').addEventListener('click', closeSettings);
button.addEventListener('click', toggleSettings);

on(EVENTS.sidebar, () => { if (!layer.hidden) syncControls(); });
