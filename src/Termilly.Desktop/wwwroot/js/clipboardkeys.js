// @ts-check
// Which keys copy and paste in a terminal, as in Windows Terminal: Ctrl+C copies when text is selected (without a
// selection it stays the shell's ^C), Ctrl+Shift+C always copies, Ctrl+V and Ctrl+Shift+V paste, and Ctrl+Insert and
// Shift+Insert do what they do in every console. No imports, so the tests can load it on its own.

/** What a key does with the clipboard. */
export const CLIPBOARD_ACTION = Object.freeze({ copy: 'copy', paste: 'paste' });

const KEY = Object.freeze({ c: 'KeyC', v: 'KeyV', insert: 'Insert' });

/**
 * @typedef {{ code: string, key: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey?: boolean }} KeyLike
 */

/**
 * What `e` does with the clipboard, or null when it's an ordinary key for the shell.
 * @param {KeyLike} e
 * @param {boolean} selected whether the terminal has text selected
 * @returns {'copy' | 'paste' | null}
 */
export function clipboardAction(e, selected) {
  // Alt (and AltGr, which arrives as Ctrl+Alt) types characters or is the shell's.
  if (e.altKey || e.metaKey) return null;
  const ctrl = e.ctrlKey && !e.shiftKey;
  const ctrlShift = e.ctrlKey && e.shiftKey;
  const shift = e.shiftKey && !e.ctrlKey;
  if ((ctrl && e.code === KEY.c && selected) || (ctrlShift && e.code === KEY.c) || (ctrl && e.key === KEY.insert)) {
    return CLIPBOARD_ACTION.copy;
  }
  if ((e.ctrlKey && e.code === KEY.v) || (shift && e.key === KEY.insert)) return CLIPBOARD_ACTION.paste;
  return null;
}
