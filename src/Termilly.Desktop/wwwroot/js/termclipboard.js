// @ts-check
// Copy and paste in a terminal: the keys (clipboardkeys.js), copy on select (Settings › Terminal) and the right-click
// menu. A paste goes through the terminal's own checks (production, several lines), which terminals.js passes in.

import { state } from './store.js';
import { showMenu } from './popups.js';
import { clipboardAction, CLIPBOARD_ACTION } from './clipboardkeys.js';
import { underlinedLink } from './termlinks.js';
import { showToast } from './toasts.js';

/** The word for pasting, on the menu and on the production question (terminals.js). */
export const PASTE_LABEL = 'Paste';

/** xterm's mouse mode while no program asks for the mouse; otherwise a right-click is the program's. */
const NO_MOUSE_TRACKING = 'none';

/**
 * What a feature adds to the right-click menu after Copy and Paste (js/actions.js: open, actions, ask an agent).
 * @type {(body: HTMLElement) => import('./popups.js').MenuEntry[]}
 */
let menuExtras = () => [];

/**
 * Sets what the right-click menu adds after Copy and Paste.
 * @param {(body: HTMLElement) => import('./popups.js').MenuEntry[]} fn
 */
export function setMenuExtras(fn) {
  menuExtras = fn;
}

/** @param {any} term xterm */
function copySelection(term) {
  const text = term.getSelection();
  if (text) navigator.clipboard.writeText(text).catch(() => {});
}

/**
 * xterm's key hook for copying and pasting: false when the key copied or pastes, so it doesn't reach the shell.
 * A paste is left to the browser: its paste event runs the checks in terminals.js, then xterm types the text.
 * @param {any} term xterm
 * @param {KeyboardEvent} e
 */
export function clipboardKey(term, e) {
  if (e.type !== 'keydown') return true;
  // Ctrl held over a link underlines it, and Ctrl+C then copies the link, unless text is selected.
  const link = !term.hasSelection() && clipboardAction(e, true) === CLIPBOARD_ACTION.copy && !e.shiftKey ? underlinedLink() : null;
  if (link) {
    e.preventDefault();
    navigator.clipboard.writeText(link).catch(() => {});
    showToast({ text: `Copied ${link}` });
    return false;
  }
  const action = clipboardAction(e, term.hasSelection());
  if (action === CLIPBOARD_ACTION.copy) {
    e.preventDefault();
    copySelection(term);
    // Ctrl+C lets go of what it copied, so the next Ctrl+C stops the program again (as in Windows Terminal).
    if (!e.shiftKey) term.clearSelection();
  }
  return !action;
}

/**
 * Copy on select, and the right-click menu: Copy (with a selection), Paste, and what features add (setMenuExtras).
 * @param {any} term xterm
 * @param {HTMLElement} body the terminal's element
 * @param {(text: string) => void} paste types `text` after the terminal's paste checks
 */
export function wireClipboard(term, body, paste) {
  body.addEventListener('mouseup', () => {
    if (state.settings.terminal.copyOnSelect && term.hasSelection()) copySelection(term);
  });
  body.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (term.modes.mouseTrackingMode !== NO_MOUSE_TRACKING) return;
    showMenu([
      { label: 'Copy', hint: 'Ctrl+C', disabled: !term.hasSelection(), action: () => copySelection(term) },
      { label: PASTE_LABEL, hint: 'Ctrl+V', action: () => navigator.clipboard.readText().then(text => { if (text) paste(text); }).catch(() => {}) },
      ...menuExtras(body),
    ], { x: e.clientX, y: e.clientY });
  });
}
