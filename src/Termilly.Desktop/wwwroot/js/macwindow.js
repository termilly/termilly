// @ts-check
// macOS: the title bar's window buttons as the system's own, the traffic lights: Close, Minimize and Zoom at the left
// of the title bar, red, yellow and green, their signs showing while the pointer is over them, grey while the window
// isn't in front (app.css, .mac-lights). The buttons stay the ones main.js wires up (data-window), so they work as
// before; detached windows copy them (windows.js). Nothing changes on Windows and Linux.

import { mac } from './host.js';
import { WINDOW_ACTION } from './constants.js';

/** The class the traffic lights' group has (app.css). */
export const MAC_LIGHTS = 'mac-lights';
/** The order macOS has them in, from the left. */
export const MAC_LIGHT_ORDER = [WINDOW_ACTION.close, WINDOW_ACTION.minimize, WINDOW_ACTION.maximize];

/** Each light's sign, drawn on a 12px circle: an x, a line, and Zoom's two corner arrows. */
const SIGNS = Object.freeze({
  [WINDOW_ACTION.close]: '<svg viewBox="0 0 12 12"><path d="M4 4l4 4M8 4l-4 4"/></svg>',
  [WINDOW_ACTION.minimize]: '<svg viewBox="0 0 12 12"><path d="M3.5 6h5"/></svg>',
  [WINDOW_ACTION.maximize]: '<svg viewBox="0 0 12 12"><path class="fill" d="M4.8 3.5h3.7v3.7zM3.5 4.8v3.7h3.7z"/></svg>',
});

if (mac) makeLights();

/** The main window's buttons become the traffic lights, at the start of the title bar. */
function makeLights() {
  const controls = /** @type {HTMLElement | null} */ (document.querySelector('#titlebar .window-controls'));
  const left = document.querySelector('#titlebar .tb-left');
  if (!controls || !left) return;
  controls.classList.add(MAC_LIGHTS);
  for (const action of MAC_LIGHT_ORDER) {
    const button = /** @type {HTMLElement | null} */ (controls.querySelector(`[data-window="${action}"]`));
    if (!button) continue;
    button.innerHTML = SIGNS[action];
    controls.append(button); // in macOS's order
  }
  left.prepend(controls);
}
