// @ts-check
// A terminal's name line, or its bar shown on hover, in Minimal (js/minimal.js): what it shows is picked in a submenu of
// the terminal's menu (tabmenu.js). Set aside, Close and Stop always stay.

import { state, persist, GROUPS } from './store.js';
import { SEPARATOR } from './popups.js';
import { updateSettings } from './preferences.js';
import { SETTING_VALUES } from './constants.js';

/** @typedef {import('./popups.js').MenuEntry} MenuEntry */
/** @typedef {import('./popups.js').MenuItem} MenuItem */

/** The class that leaves a part out of the line (app.css hides it in Minimal only). */
const OFF = 'bar-off';
/** A terminal's header: its name line or bar in Minimal (js/header.js). */
export const PANE_HEADER = '.pane-header';
const { paneNames, layout } = SETTING_VALUES;

/** Whether the window is in Minimal (Settings › Appearance › Layout). */
export const isMinimal = () => state.settings.interface.layout === layout.minimal;

/** The parts the user can leave out: id (kept in state.paneBar.hidden), what the menu calls it, and where it is. */
const PARTS = /** @type {const} */ ([
  ['badge', 'Shell badge', '.badge-slot'],
  ['name', 'Name', '.pane-name'],
  ['tags', 'Tags', '.pane-tags'],
  ['note', 'Pinned note', '.pane-note'],
  ['view', 'Agent view switch', '.view-btn'],
  ['prompts', 'My prompts', '.prompts-btn'],
  ['todo', 'To do', '.note-btn'],
  ['tag', 'Tag button', '.tag-btn'],
  ['menu', 'Menu button', '.menu-btn'],
]);

/** The parts left out. */
const hiddenParts = () => state.paneBar.hidden ?? [];

/**
 * Marks the parts left out on one header.
 * @param {HTMLElement} header
 */
export function markBarParts(header) {
  const hidden = hiddenParts();
  for (const [id, , selector] of PARTS) header.querySelector(selector)?.classList.toggle(OFF, hidden.includes(id));
}

/** @param {string} id */
function togglePart(id) {
  const hidden = hiddenParts();
  state.paneBar = { ...state.paneBar, hidden: hidden.includes(id) ? hidden.filter(h => h !== id) : [...hidden, id] };
  persist();
  for (const header of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(PANE_HEADER))) markBarParts(header);
}

/**
 * The terminal menu's entry for the line in Minimal: what it shows and where the name goes.
 * @returns {MenuItem}
 */
export function paneBarItem() {
  return { label: 'Title bar', submenu: paneBarItems };
}

/** @returns {MenuEntry[]} */
function paneBarItems() {
  const hidden = hiddenParts();
  const names = state.settings.interface.paneNames ?? paneNames.default;
  /** @type {MenuEntry[]} */
  const items = PARTS.map(([id, label]) => ({ label, checked: !hidden.includes(id), action: () => togglePart(id) }));
  items.push(SEPARATOR,
    { label: 'Name on a line', picked: names === paneNames.line, action: () => updateSettings(GROUPS.interface, { paneNames: paneNames.line }) },
    { label: 'Name on hover', picked: names === paneNames.hover, action: () => updateSettings(GROUPS.interface, { paneNames: paneNames.hover }) });
  return items;
}
