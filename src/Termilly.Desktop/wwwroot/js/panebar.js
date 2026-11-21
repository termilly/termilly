// @ts-check
// A terminal's name line, or its bar shown on hover, in Minimal (js/minimal.js): right-click picks what it shows. Set
// aside, Close and Stop always stay; the terminal's own menu is the last item, as the header's right-click is in Normal.

import { state, persist, GROUPS } from './store.js';
import { showMenu, SEPARATOR } from './popups.js';
import { openTabMenu } from './tabmenu.js';
import { updateSettings } from './preferences.js';
import { SETTING_VALUES } from './constants.js';

/** @typedef {import('./popups.js').MenuEntry} MenuEntry */

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
 * The line's right-click menu: what it shows, where the name goes, and the terminal's own menu.
 * @param {Tab} tab
 * @param {{ x: number, y: number }} at
 */
export function openPaneBarMenu(tab, at) {
  const hidden = hiddenParts();
  const names = state.settings.interface.paneNames ?? paneNames.default;
  /** @type {MenuEntry[]} */
  const items = PARTS.map(([id, label]) => ({ label, checked: !hidden.includes(id), action: () => togglePart(id) }));
  items.push(SEPARATOR,
    { label: 'Name on a line', checked: names === paneNames.line, action: () => updateSettings(GROUPS.interface, { paneNames: paneNames.line }) },
    { label: 'Name on hover', checked: names === paneNames.hover, action: () => updateSettings(GROUPS.interface, { paneNames: paneNames.hover }) },
    SEPARATOR,
    { label: 'Terminal menu', action: () => setTimeout(() => openTabMenu(tab, at)) });
  showMenu(items, at);
}
