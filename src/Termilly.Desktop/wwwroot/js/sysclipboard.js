// @ts-check
// The system clipboard, through the window the user is in. A detached window runs the main page's code, and the
// browser refuses the main page's clipboard while another window has the focus (the copy fails without a word).

import { hereDoc, openDocuments } from './windows.js';

/**
 * The clipboard of the Termilly window that has the focus now (the main one, or a detached one); else of the one the
 * user was in last. Take it before awaiting anything: the focus may move meanwhile.
 */
export function systemClipboard() {
  const doc = openDocuments().find(d => d.hasFocus()) ?? hereDoc();
  return (doc.defaultView ?? window).navigator.clipboard;
}
