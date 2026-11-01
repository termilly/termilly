// @ts-check
// Copy and paste in a terminal: the keys (clipboardkeys.js), copy on select (Settings › Terminal) and the right-click
// menu. A paste goes through the terminal's own checks (production, several lines), which terminals.js passes in.

import { state } from './store.js';
import { showMenu } from './popups.js';
import { clipboardAction, CLIPBOARD_ACTION } from './clipboardkeys.js';
import { underlinedLink, linkUnderMouse } from './termlinks.js';
import { showToast } from './toasts.js';
import { ICONS } from './ui.js';

/** The word for pasting, on the menu and on the production question (terminals.js). */
export const PASTE_LABEL = 'Paste';
/** Copy on a right-click menu, and the keys its entries show (the Notepad's menu too). */
export const COPY_LABEL = 'Copy';
export const MENU_KEYS = Object.freeze({ copy: 'Ctrl+C', paste: 'Ctrl+V' });

/** xterm's mouse mode while no program asks for the mouse; otherwise a right-click is the program's. */
const NO_MOUSE_TRACKING = 'none';

/**
 * What a feature adds to the right-click menu after Copy and Paste (js/actions.js: open, actions, ask an agent).
 * @type {(body: HTMLElement) => import('./popups.js').MenuEntry[]}
 */
let menuExtras = () => [];

/**
 * What Smart Clip adds right after Paste (js/smartclip.js), given how this terminal pastes.
 * @type {(body: HTMLElement, paste: (text: string) => void) => import('./popups.js').MenuEntry[]}
 */
let clipEntries = () => [];
/**
 * Who hears of a copy made here (Smart Clip keeps it, with where it came from): the text, the terminal's element,
 * and whether it's a link.
 * @type {(text: string, body: HTMLElement | null, link: boolean) => void}
 */
let copied = () => {};

/**
 * Sets Smart Clip's part of the right-click menu, and what hears of copies.
 * @param {typeof clipEntries} entries
 * @param {typeof copied} onCopy
 */
export function setClipHooks(entries, onCopy) {
  clipEntries = entries;
  copied = onCopy;
}

/**
 * Sets what the right-click menu adds after Copy and Paste.
 * @param {(body: HTMLElement) => import('./popups.js').MenuEntry[]} fn
 */
export function setMenuExtras(fn) {
  menuExtras = fn;
}

/**
 * @param {any} term xterm
 * @param {HTMLElement | null} [body] the terminal's element, to say where a copy came from
 */
function copySelection(term, body = null) {
  const text = term.getSelection();
  if (!text) return;
  navigator.clipboard.writeText(text).catch(() => {});
  copied(text, body, false);
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
    copied(link, term.element?.parentElement ?? null, true);
    showToast({ text: `Copied ${link}` });
    return false;
  }
  const action = clipboardAction(e, term.hasSelection());
  if (action === CLIPBOARD_ACTION.copy) {
    e.preventDefault();
    copySelection(term, term.element?.parentElement ?? null);
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
    if (state.settings.terminal.copyOnSelect && term.hasSelection()) copySelection(term, body);
  });
  body.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (term.modes.mouseTrackingMode !== NO_MOUSE_TRACKING) return;
    // Nothing selected, a link under the mouse: Copy takes the link, as Ctrl+C does over it.
    const link = term.hasSelection() ? null : linkUnderMouse();
    showMenu([
      link
        ? { label: 'Copy link', icon: ICONS.copy, action: () => { navigator.clipboard.writeText(link).catch(() => {}); copied(link, body, true); showToast({ text: `Copied ${link}` }); } }
        : { label: COPY_LABEL, icon: ICONS.copy, hint: MENU_KEYS.copy, disabled: !term.hasSelection(), action: () => copySelection(term, body) },
      { label: PASTE_LABEL, icon: ICONS.paste, hint: MENU_KEYS.paste, action: () => navigator.clipboard.readText().then(text => { if (text) paste(text); }).catch(() => {}) },
      ...clipEntries(body, paste),
      ...menuExtras(body),
    ], { x: e.clientX, y: e.clientY });
  });
}
