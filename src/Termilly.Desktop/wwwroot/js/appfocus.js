// @ts-check
// Whether Termilly is in front: any of its windows (the main one or one of its own, js/windows.js) has the focus. The
// window's background turns solid while it isn't, if asked (js/backgrounds.js).

import { inEachDocument, openDocuments } from './windows.js';
import { setAppActive } from './backgrounds.js';

/** A moment after focus moves (from one of Termilly's windows to another, it leaves one before the other has it). */
function followFocus() {
  setTimeout(() => setAppActive(openDocuments().some(doc => doc.hasFocus())));
}

/** Follows the focus in the main window and in each window of its own as it opens. */
export function watchAppFocus() {
  inEachDocument(doc => {
    doc.defaultView?.addEventListener('focus', followFocus);
    doc.defaultView?.addEventListener('blur', followFocus);
  });
}
