// @ts-check
// The right-click menu of a text box that holds the user's writing (a Notepad page, a list's note): Cut, Copy, Paste and
// Paste as plain text, with the box's own entries after them.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { ICONS } from './ui.js';
import { showMenu, SEPARATOR } from './popups.js';
import { COPY_LABEL as COPY, PASTE_LABEL, MENU_KEYS } from './termclipboard.js';

const LF = '\n';
const CRLF = '\r\n';
/**
 * 16px at a 1px line: scissors (cut) and a clipboard with a T (paste as plain text); paste is ICONS.paste.
 */
const MENU_ICONS = Object.freeze({
  cut: '<svg viewBox="0 0 16 16"><circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M5.7 9.8L11 1.5M10.3 9.8L5 1.5"/></svg>',
  pastePlain: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="11" rx="1"/><path d="M6.5 2.5h3v2h-3zM5.5 7.5h4M7.5 7.5v5"/></svg>',
});

/**
 * Text as it reads, without what a terminal adds: colour and cursor codes, other control characters, Windows line
 * ends and spaces at the ends of lines.
 * @param {string} text
 */
const plainText = text => text
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replaceAll(CRLF, LF)
  .replace(/[^\n\t\P{Cc}]/gu, '')
  .replace(/[ \t]+$/gm, '');

/**
 * Copies text from here, and tells Clipboard (it keeps it even when it keeps Termilly's own copies only).
 * @param {string} text
 * @param {string} source who copied it, as Clipboard shows it
 */
export function copyOut(text, source) {
  navigator.clipboard.writeText(text).catch(() => {});
  send(PAGE.clipCopied, { text, source });
}

/**
 * Shows the menu of a right-click in a text box.
 * @param {MouseEvent} e
 * @param {HTMLTextAreaElement} area
 * @param {string} source who copies, as Clipboard shows it
 * @param {import('./popups.js').MenuEntry[]} own the box's own entries, after a separator
 */
export function textBoxMenu(e, area, source, own) {
  e.preventDefault();
  const { selectionStart: start, selectionEnd: end } = area;
  const selected = start !== end;
  const selection = area.value.slice(start, end);
  /** @param {string} text */
  const insert = text => {
    area.focus();
    // Types where the caret is, so Ctrl+Z takes it back. Its own window's document when it's detached: the command acts
    // on the focus there.
    area.ownerDocument.execCommand('insertText', false, text);
  };
  /** @param {(text: string) => string} [clean] */
  const paste = (clean = t => t) => navigator.clipboard.readText().then(text => { if (text) insert(clean(text)); }).catch(() => {});
  showMenu([
    { label: 'Cut', icon: MENU_ICONS.cut, hint: 'Ctrl+X', disabled: !selected, action: () => { copyOut(selection, source); insert(''); } },
    { label: COPY, icon: ICONS.copy, hint: MENU_KEYS.copy, disabled: !selected, action: () => copyOut(selection, source) },
    { label: PASTE_LABEL, icon: ICONS.paste, hint: MENU_KEYS.paste, action: () => paste() },
    { label: 'Paste as plain text', icon: MENU_ICONS.pastePlain, title: 'Without the colour codes, control characters and trailing spaces a terminal adds', action: () => paste(plainText) },
    SEPARATOR,
    ...own,
  ], { x: e.clientX, y: e.clientY }, {
    // The text box keeps the focus while the menu shows, so its selection stays lit; closing, it gets it back.
    keepFocus: true,
    refocus: () => { area.focus(); area.setSelectionRange(start, end); },
  });
}
