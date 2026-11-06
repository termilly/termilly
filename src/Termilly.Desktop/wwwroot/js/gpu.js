// @ts-check
// Terminals drawn on the GPU (xterm's WebGL add-on): scrolling and fast output stay smooth where the DOM renderer has
// thousands of elements to redo. A browser keeps only so many WebGL contexts (16 in Chromium; past that it drops the
// oldest), and Termilly can have more terminals than that, so a terminal has one while it's on screen and gives it
// back a little after it's hidden. A lost context (a driver reset, sleep) falls back to the DOM renderer, and comes
// back while the terminal shows, a few times at most. Settings › Appearance › GPU rendering turns it all off.
//
// The GPU draws each character in a cell of whole device pixels, rounding the font's width down (Consolas at 14px:
// 7.7 becomes 7, and the letters crowd). A pixel of letter spacing, centred, makes it the nearest whole width instead
// (8); the terminal then fits its columns again. Back on the DOM renderer, which keeps the exact width, it goes.

import { state } from './store.js';

/** A hidden terminal keeps its context this long (switching back and forth needn't rebuild it). */
const RELEASE_AFTER_MS = 10_000;
/** The most contexts in use at once, well under the browser's own limit. */
const MAX_CONTEXTS = 12;
/** A terminal whose context was lost this many times stays on the DOM renderer. */
const MAX_LOSSES = 3;
/** After a lost context, it tries again this much later (the GPU may be resetting). */
const RETRY_MS = 1000;

/**
 * A terminal's GPU state: its add-on while it has one, whether it's on screen, its release timer, how often its
 * context was lost, and when it last showed (the longest hidden gives its context up first).
 * @typedef {{ term: any, fit: () => void, addon: any, visible: boolean, timer: number, losses: number, shownAt: number, observer: IntersectionObserver }} Gpu
 */

/** @type {Map<string, Gpu>} */
const gpus = new Map();

/** Whether this page can draw with WebGL 2 at all (asked once). */
const supported = (() => {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
})();

const wanted = () => supported && state.settings.terminal.gpuRendering !== false;

/**
 * The letter spacing (whole device pixels) that rounds the GPU's cells to the nearest width rather than down; none
 * on the DOM renderer.
 * @param {Gpu} g
 */
function spacing(g) {
  const width = g.term._core?._charSizeService?.width;
  if (!g.addon || !width) return 0;
  const device = width * devicePixelRatio;
  return Math.round(device) - Math.floor(device);
}

/**
 * Sets the spacing the renderer needs (after a font, its size or the screen's scale changed) and fits the columns to it.
 * @param {Gpu} g
 */
function fitWidth(g) {
  const extra = spacing(g);
  if (g.term.options.letterSpacing === extra) return;
  g.term.options.letterSpacing = extra;
  if (g.visible) g.fit();
}

/** @param {Gpu} g */
function release(g) {
  clearTimeout(g.timer);
  if (!g.addon) return;
  const addon = g.addon;
  g.addon = null;
  fitWidth(g); // the DOM renderer keeps the font's own width
  try {
    addon.dispose(); // the DOM renderer takes over
  } catch {
    // a context already lost can throw as it goes; the terminal draws either way
  }
}

/** Makes room under the cap: the terminal hidden longest gives its context up. */
function makeRoom() {
  const using = [...gpus.values()].filter(g => g.addon);
  if (using.length < MAX_CONTEXTS) return;
  const hidden = using.filter(g => !g.visible).sort((a, b) => a.shownAt - b.shownAt);
  if (hidden[0]) release(hidden[0]);
}

/** @param {Gpu} g */
function attach(g) {
  if (g.addon || !g.visible || !wanted() || g.losses >= MAX_LOSSES) return;
  makeRoom();
  if ([...gpus.values()].filter(other => other.addon).length >= MAX_CONTEXTS) return; // all on screen: the DOM it is
  try {
    const addon = new WebglAddon.WebglAddon();
    addon.onContextLoss(() => {
      g.losses++;
      release(g);
      setTimeout(() => attach(g), RETRY_MS);
    });
    g.term.loadAddon(addon);
    g.addon = addon;
    requestAnimationFrame(() => fitWidth(g)); // the font is measured by then
  } catch {
    g.losses = MAX_LOSSES; // no WebGL for this one: it stays on the DOM renderer
  }
}

/**
 * Follows a terminal on screen: the GPU while it shows, the DOM renderer a little after it's hidden.
 * @param {Tab} tab
 * @param {any} term xterm, open in the tab's view
 * @param {() => void} fit fits its columns and rows to its pane
 */
export function wireGpu(tab, term, fit) {
  if (!supported) return;
  const body = /** @type {TabView} */ (tab.view).body;
  /** @type {Gpu} */
  const g = { term, fit, addon: null, visible: false, timer: 0, losses: 0, shownAt: 0, observer: /** @type {any} */ (null) };
  watch(g, body);
  gpus.set(tab.id, g);
}

/**
 * Watches whether `body` is on screen, from the window it's in: another window's observer never sees it (a detached
 * terminal would give its context up and, on WebKitGTK, draw nothing; back in the main window it never came back).
 * @param {Gpu} g
 * @param {HTMLElement} body
 */
function watch(g, body) {
  g.observer?.disconnect();
  const view = /** @type {typeof window} */ (body.ownerDocument.defaultView ?? window);
  g.observer = new view.IntersectionObserver(entries => {
    const visible = entries.some(e => e.isIntersecting);
    g.visible = visible;
    clearTimeout(g.timer);
    if (visible) {
      g.shownAt = Date.now();
      attach(g);
    } else {
      g.timer = setTimeout(() => release(g), RELEASE_AFTER_MS);
    }
  });
  g.observer.observe(body);
}

/**
 * A terminal moved into another window (its own, or the main one again): it's watched from there, and draws on a
 * context made afresh (one made for another window's page may not draw in this one).
 * @param {Tab} tab
 */
export function followGpu(tab) {
  const g = gpus.get(tab.id);
  if (!g) return;
  release(g);
  g.losses = 0;
  watch(g, /** @type {TabView} */ (tab.view).body);
}

/**
 * A terminal closes: its context goes with it.
 * @param {Tab} tab
 */
export function dropGpu(tab) {
  const g = gpus.get(tab.id);
  if (!g) return;
  g.observer.disconnect();
  release(g);
  gpus.delete(tab.id);
}

/** The settings changed (this one, or the font): every terminal on screen takes the GPU, or all give it back. */
export function applyGpu() {
  for (const g of gpus.values()) {
    if (wanted()) attach(g);
    else release(g);
  }
  requestAnimationFrame(() => { for (const g of gpus.values()) fitWidth(g); });
}

// Moved to a screen with another scale: the whole pixels are other ones.
matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', function rescaled() {
  for (const g of gpus.values()) fitWidth(g);
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', rescaled, { once: true });
}, { once: true });

/** Whether a terminal draws on the GPU now (tests, and the setting's note). @param {Tab} tab */
export const onGpu = tab => !!gpus.get(tab.id)?.addon;
