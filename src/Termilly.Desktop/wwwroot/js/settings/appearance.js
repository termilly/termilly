// @ts-check
// Settings › Appearance › Theme: the colour themes, well-known schemes first and then Termilly's own, searching them
// and showing only dark or light ones, and following the system's light and dark mode with a theme picked for each.
// Appearance's other tabs are Text (appearancetext.js) and Layout (appearancelayout.js).

import { sys, SYSTEM_NAME } from '../host.js';
import { getSetting, GROUPS } from '../store.js';
import { THEMES, THEME_BASE, POPULAR_THEME_IDS, themeId, systemPick, importedThemes, themeById } from '../themes.js';
import { cssColor, escapeHtml, ICONS } from '../ui.js';
import { updateSettings } from '../preferences.js';
import { row, group } from './controls.js';
import { SECTION, body, redraw } from './page.js';
import { SETTING_VALUES } from '../constants.js';
import { targetOf } from '../dom.js';
import { dropdown, showMenu } from '../popups.js';
import { importScheme } from '../themeimport.js';

/** The theme setting's choices (C#'s SettingValues): a theme's id, or System. */
const { theme } = SETTING_VALUES;
const THEME_SETTING = 'interface.theme';
/** The themes following the system shows in dark mode and in light mode. */
const DARK_PICK = 'interface.themeDark';
const LIGHT_PICK = 'interface.themeLight';
/** A theme's card in the gallery, and the class that dims the picks while the system isn't followed. */
const THEME_CARD = '.theme-card';
const THEME_SEARCH = 'theme-search';
const THEME_NONE = '.theme-none';
const PICKS_UNUSED = 'unused';
/** How long each line of "output" is in a theme card's small terminal, in percent. */
const INK_WIDTHS = [70, 45, 58];

/** Which themes the gallery shows: all, or only dark or light ones. */
const FILTER = Object.freeze({ all: 'all', dark: THEME_BASE.dark, light: THEME_BASE.light });
/** @type {string} */
let filter = FILTER.all;
/** The search typed, kept while the page is drawn again (after an import). */
let query = '';

/** The built-in themes in the gallery's order: the well-known schemes (most-starred first), then Termilly's own. */
const ORDERED = [...POPULAR_THEME_IDS.flatMap(id => THEMES.filter(t => t.id === id)), ...THEMES.filter(t => !POPULAR_THEME_IDS.includes(t.id))];
/** Every theme in the gallery's order: imported ones first. */
const gallery = () => [...importedThemes(), ...ORDERED];

/** What the system's light and dark mode is called here. */
const systemName = sys.name === SYSTEM_NAME.linux ? 'the desktop' : 'Windows';

/** @param {import('../themes.js').Theme['preview']} p a theme's small window, in its colours */
const mini = p => `<span class="tc-win" style="--p-bg:${cssColor(p.bg)};--p-side:${cssColor(p.side)};--p-line:${cssColor(p.line)};--p-text:${cssColor(p.text)};--p-accent:${cssColor(p.accent)};--p-term:${cssColor(p.term)}">
    <span class="tc-side"><i></i><i class="on"></i><i></i></span>
    <span class="tc-term">${p.ink.map((c, i) => `<i style="background:${cssColor(c)};width:${INK_WIDTHS[i]}%"></i>`).join('')}</span>
  </span>`;

/**
 * A theme's card: its small window, its name, and the well-known scheme it follows, or that it's imported (searched by
 * its name or the scheme's).
 * @param {import('../themes.js').Theme} t
 */
const card = t => {
  const note = t.imported ? IMPORTED_NOTE : t.like;
  return `<button class="theme-card" data-theme-id="${t.id}" data-base="${t.base}" data-hay="${escapeHtml(`${t.name} ${t.like ?? ''}`.toLowerCase())}"${t.imported ? ` title="${REMOVE_HINT}"` : ''}>${mini(t.preview)}<span class="tc-name">${escapeHtml(t.name)}</span>${note ? `<span class="tc-like">${escapeHtml(note)}</span>` : ''}</button>`;
};
const IMPORTED_NOTE = 'Imported';
const REMOVE_HINT = 'Imported. Right-click to remove it.';

/**
 * Takes an imported theme out; one on screen gives way to Dark or Light (as following the system's pick does).
 * @param {string} id
 */
function removeImported(id) {
  const gone = themeById(id);
  const patch = { customThemes: (getSetting('interface.customThemes') ?? []).filter((/** @type {{ id: string }} */ t) => t.id !== id) };
  const fallback = gone?.base === THEME_BASE.light ? theme.light : theme.dark;
  updateSettings(GROUPS.interface, getSetting(THEME_SETTING) === id ? { ...patch, theme: fallback } : patch);
  redraw();
}

// An imported theme's card, right-clicked: Remove.
body.addEventListener('contextmenu', e => {
  const target = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-theme-id]'));
  const id = target?.dataset.themeId;
  if (!target || !id || !themeById(id)?.imported) return;
  e.preventDefault();
  showMenu([{ label: 'Remove theme', icon: ICONS.trash, danger: true, action: () => removeImported(id) }], { x: e.clientX, y: e.clientY });
});

/**
 * The theme following the system shows in one mode: the dark themes or the light ones, in the gallery's order.
 * @param {string} key the setting
 * @param {string} base dark or light
 * @param {string} label
 */
const picker = (key, base, label) => `<label class="theme-pick"><span>${label}</span><select class="field" data-setting="${key}" aria-label="${label} theme">
    ${gallery().filter(t => t.base === base).map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select></label>`;

const following = () => getSetting(THEME_SETTING) === theme.system;

/**
 * Shows the cards the search and the filter match, or a line saying none do.
 * @param {HTMLElement} root
 */
function applyFilter(root) {
  const words = query.trim().toLowerCase();
  let any = false;
  for (const c of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(THEME_CARD))) {
    c.hidden = (filter !== FILTER.all && c.dataset.base !== filter) || !(c.dataset.hay ?? '').includes(words);
    any ||= !c.hidden;
  }
  const none = /** @type {HTMLElement | null} */ (root.querySelector(THEME_NONE));
  if (none) none.hidden = any;
}

/**
 * The theme on screen marked, the filter's choice, and the follow switch with the picks it uses.
 * @param {HTMLElement} root
 */
function sync(root) {
  const shown = themeId();
  for (const c of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(THEME_CARD))) c.classList.toggle('on', c.dataset.themeId === shown);
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-theme-filter]'))) b.classList.toggle('on', b.dataset.themeFilter === filter);
  root.querySelector('[data-theme-follow]')?.setAttribute('aria-checked', String(following()));
  root.querySelector('.theme-follow')?.classList.toggle(PICKS_UNUSED, !following());
  // Each pick as the system shows it: one that's gone or of the other kind shows as Dark or Light, as it acts.
  for (const select of /** @type {NodeListOf<HTMLSelectElement>} */ (root.querySelectorAll('.theme-pick select'))) {
    select.value = systemPick(select.dataset.setting === LIGHT_PICK);
    dropdown(select);
  }
}

/** @type {import('./page.js').Section} */
const APPEARANCE = {
  id: SECTION.appearance,
  label: 'Appearance', tab: 'Theme', icon: ICONS.appearance,
  tabs: [SECTION.appearance, SECTION.appearanceText, SECTION.appearanceLayout],
  html: () => group('', row('Follow the system', `Switches with ${systemName}’s dark and light mode.`,
    `<span class="theme-follow">${picker(DARK_PICK, THEME_BASE.dark, 'Dark')}${picker(LIGHT_PICK, THEME_BASE.light, 'Light')}
      <button class="switch" role="switch" data-theme-follow aria-label="Follow the system"><span></span></button></span>`,
    { keywords: 'system dark light mode automatic auto night day' }))
    + group('', row('Theme', 'Colours for the app and terminals.', `<div class="theme-tools">
        <input class="field ${THEME_SEARCH}" type="search" placeholder="Search themes" spellcheck="false" autocomplete="off" aria-label="Search themes" value="${escapeHtml(query)}">
        <span class="seg theme-filter">${Object.values(FILTER).map(f => `<button data-theme-filter="${f}">${f === FILTER.all ? 'All' : f === FILTER.dark ? 'Dark' : 'Light'}</button>`).join('')}</span>
        <button class="btn" data-theme-import>Import</button>
      </div><span class="seg theme-cards">${gallery().map(card).join('')}</span><p class="set-desc theme-none" hidden>No themes match.</p>`,
    { stack: true, keywords: `colour color look palette scheme ${THEMES.map(t => `${t.name} ${t.like ?? ''}`).join(' ').toLowerCase()}` })),
  drawn: root => { applyFilter(root); sync(root); },
  sync,
  click(e) {
    const picked = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-theme-id]'));
    if (picked) {
      updateSettings(GROUPS.interface, { theme: picked.dataset.themeId });
      return true;
    }
    if (targetOf(e).closest('[data-theme-follow]')) {
      // Off keeps what's on screen: the pick the system's mode shows now.
      updateSettings(GROUPS.interface, { theme: following() ? themeId() : theme.system });
      return true;
    }
    if (targetOf(e).closest('[data-theme-import]')) {
      importScheme().then(id => {
        if (id) redraw();
        // Back to Import (the one drawn again after a save).
        /** @type {HTMLElement | null} */ (body.querySelector('[data-theme-import]'))?.focus();
      });
      return true;
    }
    const kind = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-theme-filter]'));
    if (!kind) return false;
    filter = /** @type {string} */ (kind.dataset.themeFilter);
    applyFilter(body);
    sync(body);
    return true;
  },
  input(e) {
    const box = /** @type {HTMLInputElement} */ (targetOf(e));
    if (!box.classList.contains(THEME_SEARCH)) return;
    query = box.value;
    applyFilter(body);
  },
};

export default APPEARANCE;
