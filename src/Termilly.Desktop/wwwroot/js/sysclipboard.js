// @ts-check
// The system clipboard, through the window the user is in. A detached window runs the main page's code, and the
// browser refuses the main page's clipboard while another window has the focus (the copy fails without a word).

import { hereDoc, openDocuments } from './windows.js';
import { mac, request } from './host.js';
import { PAGE } from './protocol.js';

/**
 * The clipboard of the Termilly window that has the focus now (the main one, or a detached one); else of the one the
 * user was in last. Take it before awaiting anything: the focus may move meanwhile.
 */
export function systemClipboard() {
  const doc = openDocuments().find(d => d.hasFocus()) ?? hereDoc();
  return (doc.defaultView ?? window).navigator.clipboard;
}

/**
 * The clipboard's text, for a paste from a menu: on macOS the host reads it, as WebKit asks first (its own Paste
 * button) when the page reads text another app copied; elsewhere the page reads it. Empty when there's none.
 * @returns {Promise<string>}
 */
export function readClipboardText() {
  if (mac) return request(PAGE.clipRead).then(answer => answer.text ?? '');
  return systemClipboard().readText();
}
