// @ts-check
// Whether Termilly's window is in front, as the host last reported it (HOST.windowState). A minimized WebView2 can
// still say document.hasFocus(), so whether a terminal is in view (store.js isInView) asks this too.

/** The window's state: it starts in front. */
const shown = { minimized: false, active: true };

/** Whether the window is in front now: not minimized, and the active window. */
export const windowInFront = () => !shown.minimized && shown.active;

/**
 * The host reported the window's state. Returns whether the window has just come back in front (restored or
 * activated), when the terminal with focus counts as seen.
 * @param {{ minimized: boolean, active: boolean }} m
 */
export function setWindowState(m) {
  const wasInFront = windowInFront();
  shown.minimized = m.minimized;
  shown.active = m.active;
  return !wasInFront && windowInFront();
}
