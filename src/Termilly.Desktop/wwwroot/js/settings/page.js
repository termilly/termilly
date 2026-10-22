// @ts-check
// What the Settings page (settings.js) and its sections (one module each, in this folder) share: the page's elements,
// which section is open, what the host has said that a section shows, and redrawing the open section.

import { HOST } from '../protocol.js';
import { onHost } from '../host.js';
import { restoreFocus } from '../panes.js';

/**
 * One section of the page: its place in the nav, its markup, and what it does with its own controls. The page's
 * shared controls (data-setting switches, choices and fields) are handled by the page itself.
 * @typedef {object} Section
 * @property {string} id
 * @property {string} label
 * @property {string} icon
 * @property {() => string} html Its markup; rows are found again in it by the search and the palette.
 * @property {() => void} [refresh] On switching to it from another section: asks the host for what it shows.
 * @property {() => void} [opened] Each time Settings opens on it.
 * @property {(body: HTMLElement) => void} [drawn] After its markup is in the page, also as search results.
 * @property {(body: HTMLElement) => void} [sync] Shows the current settings in its own controls.
 * @property {Record<string, (el: HTMLElement) => unknown>} [actions] Its data-action buttons, by name.
 * @property {(e: MouseEvent) => unknown} [click] Clicks on its own controls; true (or a value) when handled.
 * @property {(e: Event) => unknown} [change] Changes to its own fields; true when handled.
 * @property {(e: Event) => unknown} [input] Typing in its own fields.
 * @property {(key: string) => void} [changed] After the page saved a setting from a shared control ('group.key').
 */

/** The sections' ids, in the nav's order. */
export const SECTION = Object.freeze({
  appearance: 'appearance',
  terminal: 'terminal',
  ssh: 'ssh',
  serial: 'serial',
  workspaces: 'workspaces',
  changes: 'changes',
  privacy: 'privacy',
  phone: 'phone',
  plugins: 'plugins',
  keyboard: 'keyboard',
  about: 'about',
});

export const layer = /** @type {HTMLElement} */ (document.getElementById('settings-layer'));
export const body = /** @type {HTMLElement} */ (document.getElementById('set-body'));
/** The title bar's Settings button, lit while the page is open. */
export const button = /** @type {HTMLElement} */ (document.getElementById('settings-button'));

/**
 * The open (or last open) section.
 * @type {{ current: string }}
 */
export const page = { current: SECTION.appearance };

/** Global shortcuts another app already owns (the host couldn't register them); their rows say so. */
export const takenChords = new Set();
onHost(HOST.hotkeyTaken, m => {
  takenChords.add(m.chord);
  redrawIfShowing(SECTION.workspaces, SECTION.terminal);
});

let redrawPage = () => {};

/** How the page redraws its open section (settings.js). */
export const setRedraw = (/** @type {() => void} */ fn) => { redrawPage = fn; };

/** Redraws the open section (or the search results), keeping the scroll position. */
export const redraw = () => redrawPage();

/**
 * Redraws the page if it's open on one of these sections.
 * @param {...string} ids
 */
export function redrawIfShowing(...ids) {
  if (!layer.hidden && ids.includes(page.current)) redrawPage();
}

export function closeSettings() {
  if (layer.hidden) return;
  layer.hidden = true;
  button.classList.remove('open');
  restoreFocus();
}
