// @ts-check
// Renaming a terminal where its name is: the header's name becomes a field (double-click, Ctrl+Shift+R, its menu), or
// the sidebar's row does (its menu there). The other place shows the name as it's typed.

import { emit, persist, profileOf, tabTitle, EVENTS } from './store.js';
import { restoreFocus, PANE_NAME } from './panes.js';

/** The name in a pane's title bar (header.js finds it by this). */
export { PANE_NAME };

/** The longest name a terminal takes. */
const MAX_NAME = 60;
/** The class of a name being edited in place (a terminal's here, a workspace's in the sidebar). */
export const RENAME_INPUT_CLASS = 'rename-input';
/** Where the name is renamed. */
export const RENAME_IN = Object.freeze({ header: 'header', sidebar: 'sidebar' });

/** The names being typed, by terminal: the other place shows it meanwhile, drawn again or not. */
/** @type {Map<Tab, () => string>} */
const typing = new Map();

/**
 * The name a terminal shows: the one being typed, else its own (the header and the sidebar draw it).
 * @param {Tab} tab
 */
export const shownName = tab => typing.get(tab)?.() ?? tabTitle(tab);

/**
 * The sidebar's name of a terminal (sidebar.js tabRowHtml), when it shows.
 * @param {Tab} tab
 */
const sidebarName = tab => document.querySelector(`#sidebar .tab-row[data-tab="${CSS.escape(tab.id)}"] .name`);

/**
 * @param {Tab} tab
 * @param {string} [where] RENAME_IN: the header (the default), or the sidebar's row
 */
export function beginRename(tab, where = RENAME_IN.header) {
  const inSidebar = where === RENAME_IN.sidebar;
  const name = inSidebar ? sidebarName(tab) : tab.view?.header?.querySelector(PANE_NAME);
  if (!name) return;
  const input = document.createElement('input');
  input.className = RENAME_INPUT_CLASS;
  input.value = tabTitle(tab);
  input.spellcheck = false;
  input.maxLength = MAX_NAME;
  input.setAttribute('aria-label', 'Tab name');
  name.replaceWith(input);
  input.focus();
  input.select();

  /** The name as it's typed (the shell's while it's empty), and the other place showing it. */
  const typed = () => input.value.trim() || (profileOf(tab)?.name ?? tabTitle(tab));
  const mirror = () => {
    const other = inSidebar ? tab.view?.header?.querySelector(PANE_NAME) : sidebarName(tab);
    if (other) other.textContent = typed();
  };

  let done = false;
  const finish = (/** @type {boolean} */ commit) => {
    if (done) return;
    done = true;
    typing.delete(tab);
    if (commit) {
      const value = input.value.trim();
      // An empty name, or the shell's own name, goes back to following the shell.
      tab.name = value && value !== profileOf(tab)?.name ? value : null;
      persist();
    }
    input.replaceWith(name);
    emit(EVENTS.tab, tab); // both places show the name again (given up: the old one)
    restoreFocus();
  };
  typing.set(tab, typed);
  input.addEventListener('input', mirror);
  input.addEventListener('keydown', e => {
    e.stopPropagation(); // typing a name must not trigger app shortcuts
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    // Ends here: finishing gives the terminal the keyboard at once, and the key's keypress would follow it there,
    // so Enter would run whatever was typed at the prompt.
    e.preventDefault();
    finish(e.key === 'Enter');
  });
  // In the sidebar's row (a button): a click or a key in the field isn't the row's, and Space doesn't press it.
  for (const type of ['click', 'mousedown', 'keyup', 'dblclick']) input.addEventListener(type, e => { e.stopPropagation(); if (e instanceof KeyboardEvent && e.key === ' ') e.preventDefault(); });
  input.addEventListener('blur', () => finish(true));
}
