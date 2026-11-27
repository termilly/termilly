// @ts-check
// Right-clicks across Termilly: the browser's own menu (Back, Reload, Inspect) shows nowhere, in the main window and in
// every window detached from it, those opened later too (inEachDocument). Termilly's own menus open from their own
// listeners, which hear the click first and take the browser's menu away themselves; a text field with no menu of its
// own gets Termilly's text menu (js/textmenu.js): Cut, Copy, Paste and Select all.

import { inEachDocument } from './windows.js';
import { targetOf } from './dom.js';
import { textBoxMenu } from './textmenu.js';

/** Who copied, as Clipboard shows it, for a field that doesn't say. */
const SOURCE = 'Termilly';
/** The kinds of input that hold text to select (a number or email field has no selection to read). */
const TEXT_INPUTS = new Set(['text', 'search', 'url', 'tel', 'password']);
const PASSWORD = 'password';

/**
 * The text field a right-click is in, if any: a text area or a text input that's on.
 * @param {Element} target
 * @returns {HTMLTextAreaElement | HTMLInputElement | null}
 */
function fieldOf(target) {
  const field = target.closest('textarea, input');
  if (!field || /** @type {HTMLInputElement} */ (field).disabled) return null;
  if (field.tagName === 'TEXTAREA') return /** @type {HTMLTextAreaElement} */ (field);
  return TEXT_INPUTS.has(/** @type {HTMLInputElement} */ (field).type) ? /** @type {HTMLInputElement} */ (field) : null;
}

/**
 * A right-click no menu of Termilly's took: no browser menu, and a text field gets the text menu.
 * @param {MouseEvent} e
 */
function rightClicked(e) {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const field = fieldOf(targetOf(e));
  if (!field) return;
  const selectAll = { label: 'Select all', hint: 'Ctrl+A', disabled: !field.value, action: () => { field.focus(); field.select(); } };
  textBoxMenu(e, field, SOURCE, [selectAll], { readOnly: field.readOnly, secret: field.type === PASSWORD });
}

inEachDocument(doc => doc.addEventListener('contextmenu', rightClicked));
