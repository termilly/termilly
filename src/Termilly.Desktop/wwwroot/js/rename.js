// @ts-check
// Renaming a terminal where its name is: the header's name becomes a field (double-click, Ctrl+Shift+R, its menu).

import { emit, persist, profileOf, tabTitle, EVENTS } from './store.js';
import { restoreFocus } from './panes.js';

/** The longest name a terminal takes. */
const MAX_NAME = 60;
/** The header's name, which renaming swaps for a field (header.js shows it). */
export const PANE_NAME = '.pane-name';
/** The class of a name being edited in place (a terminal's here, a workspace's in the sidebar). */
export const RENAME_INPUT_CLASS = 'rename-input';

/** @param {Tab} tab */
export function beginRename(tab) {
  const header = tab.view?.header;
  const name = header?.querySelector(PANE_NAME);
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

  let done = false;
  const finish = (/** @type {boolean} */ commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const value = input.value.trim();
      // An empty name, or the shell's own name, goes back to following the shell.
      tab.name = value && value !== profileOf(tab)?.name ? value : null;
      persist();
    }
    input.replaceWith(name);
    emit(EVENTS.tab, tab); // the header shows the name again
    restoreFocus();
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation(); // typing a name must not trigger app shortcuts
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}
