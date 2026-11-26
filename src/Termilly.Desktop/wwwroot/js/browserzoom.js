// @ts-check
// No browser zoom anywhere in Termilly: a touchpad pinch or Ctrl+wheel over the title bar, a panel or a detached window
// would zoom the whole window (Windows turns its pinch zoom off in the host as well). Termilly's own Ctrl+wheel (the
// terminals' font, the Notepad's text) is heard first, where it's wanted; this only takes what's left from the browser.
// In every window, those detached later too.

import { inEachDocument } from './windows.js';

/** @param {WheelEvent} e */
function wheeled(e) {
  // A touchpad pinch comes as Ctrl+wheel.
  if (e.ctrlKey) e.preventDefault();
}

/** @param {Event} e WebKit's own pinch (macOS, and Linux where it has it) */
const pinched = e => e.preventDefault();

/** WebKit's pinch events, which it sends besides the wheel. */
const PINCH_EVENTS = ['gesturestart', 'gesturechange'];

inEachDocument(doc => {
  doc.addEventListener('wheel', wheeled, { passive: false });
  for (const type of PINCH_EVENTS) doc.addEventListener(type, pinched, { passive: false });
});
