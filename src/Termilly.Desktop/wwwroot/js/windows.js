// @ts-check
// Termilly's own windows besides the main one: a terminal, the Notepad or the Snippets window detached into a window
// of its own. Everything keeps running in the main page; a detached window only shows the element moved into it, in
// the main page's styles and theme (its root's attributes mirrored), and closing it gives the element back. The window
// opens empty (about:blank, the main page's own, so nothing loads) and the page builds it: navigating it to a page of
// ours took WebView2 two seconds on the termilly.local address before anything showed.
// Menus and dialogs open in the window the user is in (hereDoc), and what has to listen in every window (popups'
// Escape and outside clicks, Termilly's shortcuts) registers once with inEachDocument. The windows have no title bar of
// their own: the element's header is it, with Return, Minimize, Maximize and Close added (the main window's own
// buttons, copied), and the window's edges resize it, as the main window's do (the host moves and sizes it).

import { PAGE, HOST } from './protocol.js';
import { send, onHost, mac } from './host.js';
import { MAC_LIGHTS, MAC_LIGHT_ORDER } from './macwindow.js';
import { WINDOW_ACTION, DETACHED_WINDOW } from './constants.js';

/**
 * A detached window: what it shows, its title, and what happens around it. onMoved runs once the element is in it
 * (the window takes a moment to open, and the element stays where it was until then); onClosed gets the element back
 * (it's no longer in any page); askClose, when given, decides whether the title bar's X may close it (it closes it
 * itself). header is the element's title bar, where the window's buttons go and which moves the window; close is what
 * its Close does (what it shows closes; Return puts it back); keepDoubleClick, what in the header keeps its own
 * double click (else a double click maximizes the window); dragHandle, what in the header is dragged out of the
 * window (the page's own drag and drop) rather than moving it.
 * @typedef {{ key: string, win: Window, el: HTMLElement, title: string, ready: boolean, onClosed: (el: HTMLElement) => void,
 *   onMoved?: () => void, onResize?: () => void, askClose?: () => unknown, header?: HTMLElement, close?: () => unknown,
 *   keepDoubleClick?: string, dragHandle?: string, chrome?: AbortController, onDragged?: Dragged, faded?: boolean, remember?: boolean, placed?: boolean,
 *   pictured?: boolean, returnable?: boolean }} Detached
 */

/**
 * Where a window was on the screen and its size (its page's, in the page's pixels), to open it there again.
 * @typedef {{ x: number, y: number, w: number, h: number }} WindowPlace
 */

/**
 * The window moved by its title bar, over the main window at x, y (its page's pixels; null when it isn't over it), and
 * let go there (dropped): whether it would land somewhere there (the window goes see-through, so that shows).
 * @typedef {(x: number | null, y: number | null, dropped: boolean) => boolean} Dragged
 */

/** What the windows' window.open names start with: the hosts know their windows by it. */
const NAME_PREFIX = DETACHED_WINDOW.namePrefix;
/** A dragged thing's picture (DragPictureWindow, Windows) goes: its window is where it was. */
const takePictureAway = () => send(PAGE.windowDragPicture, {});

/** The main page's stylesheets, which each window takes too. */
const STYLES = ['lib/xterm.css', 'app.css'];
/** The narrowest a window opens: its header, with the window's buttons added, shows its name and tools. */
export const MIN_WIDTH_PX = 440;
/** The body's class in a window (app.css: what's moved in fills it). */
const WINDOW_BODY = 'detached-window';
/** How often the windows are checked for one gone without saying so (closed with its page). */
const WATCH_MS = 1000;
/** Where a new window opens from the place its element had (the two don't line up exactly), or before a drop point. */
export const OFFSET_PX = 24;
/** A page going away: a detached window's closing, or the main page's. */
const PAGE_GONE = 'pagehide';
/** Return's icon (back into the main window), 16px at a 1px line: an arrow going into a frame. ui.js's ICONS.attach. */
export const RETURN_ICON = '<svg viewBox="0 0 16 16"><path d="M8.5 2.5h5v11h-11v-5"/><path d="M2.5 2.5l5 5M7.5 3.5v4h-4"/></svg>';
export const RETURN_LABEL = 'Back to the main window';
/** The pin that keeps a window above every other one: 16px at a 1px line, on the pixel grid. */
const PIN_ICON = '<svg viewBox="0 0 16 16"><path d="M5.5 2.5h5M6.5 2.5v4l-2 2v1h7v-1l-2-2v-4M8 9.5v4"/></svg>';
const PIN_LABEL = 'Always on top';
/** A window's own close in its header (a dialog's), moved after the pin while it's in a window. */
const OWN_CLOSE = 'set-close';
/** The pin's class while the window is kept on top (app.css). */
const PINNED = 'on';
/** The window's buttons, in the main window's order after Return. */
const CONTROLS = [WINDOW_ACTION.minimize, WINDOW_ACTION.maximize, WINDOW_ACTION.close];
/** The body's class while the window is maximized (app.css: Restore's icon, no edges). */
const MAXIMIZED = 'maximized';
/** How much less than the screen's room a maximized window's page may be: its frame. */
const FRAME_SLACK_PX = 4;

/** @type {Map<string, Detached>} */
const open = new Map();
/** @type {Array<(doc: Document) => void>} */
const installers = [];
/** The document of the window the user was in last. */
let here = document;
let watch = 0;
/** Keeps the windows' roots the same as the main page's, from the first window on. */
/** @type {MutationObserver | null} */
let themeWatch = null;

/** The document the user is in: a detached window's, or the main page's. Menus and dialogs open there. */
export const hereDoc = () => (here !== document && here.defaultView && !here.defaultView.closed ? here : document);

/**
 * Runs `install` on the main page's document and on each detached window's, now and as they open: listeners that
 * every window needs.
 * @param {(doc: Document) => void} install
 */
export function inEachDocument(install) {
  installers.push(install);
  install(document);
  for (const d of open.values()) if (d.ready) install(d.win.document);
}

/** @param {string} key */
export const isDetached = key => open.has(key);

/**
 * Detaches `el` into a window of its own, the size it has now, where it is on the screen. False when no window could
 * be opened. Already detached: its window comes to the front.
 * @param {string} key
 * @param {{ el: HTMLElement, title: string, onClosed: (el: HTMLElement) => void, onMoved?: () => void,
 *   onResize?: () => void, askClose?: () => unknown, at?: { x: number, y: number }, header?: HTMLElement,
 *   close?: () => unknown, keepDoubleClick?: string, dragHandle?: string, minWidth?: number, onDragged?: Dragged,
 *   remember?: boolean, place?: { x: number, y: number }, returnable?: boolean, firstPlace?: WindowPlace }} options
 *   firstPlace: where it opens, and its size, while it remembers none yet (the first time ever).
 *   at: the screen point the window's top left corner goes near (a drag's drop); else over where the element is.
 *   place: exactly where on the screen its page's top left corner goes (where a dragged picture of it was let go); the
 *   picture goes once the window shows.
 *   returnable: whether its title bar has Return (back into the main window); not for what's always in a window of
 *   its own (the Snippets window).
 *   minWidth: the window is at least this wide (by default its title bar's name, tools and buttons all fit).
 *   remember: it opens where it was last time (its size too; at still picks the place), kept when it goes (keepPlaces)
 */
export function detach(key, options) {
  const { el, title, onClosed, onMoved, onResize, askClose, at, place, header, close, keepDoubleClick, dragHandle, minWidth = MIN_WIDTH_PX, onDragged, remember = false, returnable = true, firstPlace } = options;
  if (open.has(key)) return focusWindow(key), true;
  const r = el.getBoundingClientRect();
  const last = (remember ? places.get(key) : null) ?? firstPlace ?? null;
  const left = place ? place.x : at ? at.x - OFFSET_PX : last ? last.x : screenX + r.left + OFFSET_PX;
  const top = place ? place.y : at ? at.y - OFFSET_PX : last ? last.y : screenY + r.top + OFFSET_PX;
  // Where its picture was let go: the very size the picture had, as the place.
  const width = place ? r.width : last ? last.w : Math.max(r.width, minWidth);
  const height = place ? r.height : last ? last.h : r.height;
  const features = [
    'popup', `width=${Math.round(width)}`, `height=${Math.round(height)}`, `left=${Math.round(left)}`, `top=${Math.round(top)}`,
  ].join(',');
  const win = window.open('', NAME_PREFIX + key, features);
  if (!win) {
    if (place) takePictureAway();
    return false;
  }
  // WebKit on macOS doesn't tell the host the name: the page does, before anything else about this window.
  if (mac) send(PAGE.window, { action: WINDOW_ACTION.opened, name: NAME_PREFIX + key });
  open.set(key, { key, win, el, title, ready: false, onClosed, onMoved, onResize, askClose, header, close, keepDoubleClick, dragHandle, onDragged, remember, pictured: !!place, returnable });
  build(win);
  watch ||= window.setInterval(checkClosed, WATCH_MS);
  if (!themeWatch) {
    themeWatch = new MutationObserver(() => {
      for (const d of open.values()) if (d.ready) mirror(d.win.document.documentElement);
    });
    themeWatch.observe(document.documentElement, { attributes: true });
  }
  return true;
}

/**
 * Closes a detached window, its element given back first (onClosed). Nothing when it isn't open.
 * @param {string} key
 * @param {{ quiet?: boolean }} [options] quiet: the element isn't wanted back (its terminal is closing)
 */
export function closeWindow(key, { quiet = false } = {}) {
  const d = open.get(key);
  if (!d) return;
  gone(d, quiet);
  d.win.close();
}

/**
 * A detached window's name, as the host knows it.
 * @param {string} key
 */
export const windowName = key => NAME_PREFIX + key;

/** @param {string} key */
export function focusWindow(key) {
  const d = open.get(key);
  if (!d) return;
  // The page can't bring another window to the front itself: the host does.
  send(PAGE.window, { action: WINDOW_ACTION.focus, name: NAME_PREFIX + key });
  d.win.focus();
}

/**
 * @param {string} key
 * @param {string} title
 */
export function setWindowTitle(key, title) {
  const d = open.get(key);
  if (!d) return;
  d.title = title;
  if (d.ready) d.win.document.title = title;
}

/**
 * A window's empty page made Termilly's: its stylesheets and theme, its title, and what its host's close runs (asking
 * here first). The element moves in once the styles are in, so it never shows unstyled.
 * @param {Window} win
 */
function build(win) {
  const doc = win.document;
  doc.body.className = WINDOW_BODY;
  mirror(doc.documentElement);
  const links = STYLES.map(href => `<link rel="stylesheet" href="${new URL(href, location.href).href}">`);
  doc.head.insertAdjacentHTML('beforeend', links.join(''));
  const loaded = [...doc.head.children].map(link => new Promise(done => {
    /** @type {HTMLLinkElement} */ (link).onload = /** @type {HTMLLinkElement} */ (link).onerror = done;
  }));
  // The host runs this when the window is closed (Alt+F4, the taskbar): the owner decides.
  Object.assign(win, { termillyClose: () => askClose(win.name) });
  Promise.all(loaded).then(() => ready(win));
}

/**
 * Its styles are in: the element moves in.
 * @param {Window} win
 */
function ready(win) {
  const d = [...open.values()].find(o => NAME_PREFIX + o.key === win.name);
  if (!d) return void win.close();
  const doc = win.document;
  d.ready = true;
  doc.title = d.title;
  mirror(doc.documentElement);
  doc.body.append(d.el);
  for (const install of installers) install(doc);
  addChrome(d, doc);
  win.addEventListener('focus', () => { here = doc; });
  win.addEventListener('resize', () => {
    showMaximized(d);
    d.onResize?.();
  });
  win.addEventListener(PAGE_GONE, () => closedByHost(d));
  here = doc;
  d.onMoved?.();
  if (d.pictured) takePictureAway();
  d.onResize?.();
}

/**
 * The window's close (Alt+F4, the taskbar; its host asks here first): the owner may ask about changes not saved, else
 * it closes.
 * @param {string} name
 */
function askClose(name) {
  const d = [...open.values()].find(o => NAME_PREFIX + o.key === name);
  if (!d) return;
  if (d.askClose) d.askClose(); else closeWindow(d.key);
}

/**
 * A window gone (closed, or its page unloading): its element goes back to its owner, unless `quiet`.
 * @param {Detached} d
 * @param {boolean} quiet
 */
function gone(d, quiet) {
  if (open.get(d.key) !== d) return;
  open.delete(d.key);
  rememberPlace(d);
  if (here.defaultView === d.win) here = document;
  if (!open.size) {
    clearInterval(watch);
    watch = 0;
  }
  // Its header goes back as it was; out of the closing window's page now, so it never goes down with it.
  d.chrome?.abort();
  for (const added of d.header?.querySelectorAll(`:scope > .detached-controls, :scope > .${MAC_LIGHTS}`) ?? []) added.remove();
  document.adoptNode(d.el);
  if (!quiet) d.onClosed(d.el);
}

/**
 * A header's own close (Schedules, Snippets) goes after the pin, with the window's buttons; back in its place when the
 * window goes (its chrome's signal).
 * @param {HTMLElement} header
 * @param {HTMLElement} controls
 * @param {AbortSignal} signal
 */
function takeOwnClose(header, controls, signal) {
  const own = /** @type {HTMLElement | null} */ (header.querySelector(`:scope > .${OWN_CLOSE}`));
  if (!own) return;
  const before = own.previousElementSibling;
  controls.append(own);
  signal.addEventListener('abort', () => (before ? before.after(own) : header.prepend(own)));
}

/**
 * The window's title bar and edges: Return, Minimize, Maximize and Close at the end of the element's header, which
 * moves the window (a double click maximizes it), and the edges that resize it. All undone when the window goes.
 * @param {Detached} d
 * @param {Document} doc
 */
function addChrome(d, doc) {
  if (!d.header) return;
  const { signal } = (d.chrome = new AbortController());
  const act = (/** @type {string} */ action, /** @type {string} */ edge = '') =>
    send(PAGE.window, { action, name: NAME_PREFIX + d.key, edge: edge || null });
  const controls = doc.createElement('div');
  controls.className = 'window-controls detached-controls';
  // The pin that keeps the window above every other one, Return, a separator, then the window's own buttons.
  controls.append(pinButton(doc, d.key, act));
  takeOwnClose(d.header, controls, signal);
  if (d.returnable !== false) {
    const back = doc.createElement('button');
    back.innerHTML = RETURN_ICON;
    back.title = RETURN_LABEL;
    back.addEventListener('click', () => closeWindow(d.key));
    controls.append(back);
  }
  const separator = doc.createElement('div');
  separator.className = 'separator';
  if (!mac) controls.append(separator);
  // macOS: the traffic lights at the start of the header, as the main window's; Return and the pin stay at the end.
  const lights = mac ? doc.createElement('div') : controls;
  if (mac) {
    lights.className = `window-controls ${MAC_LIGHTS}`;
    d.header.prepend(lights);
  }
  for (const action of mac ? MAC_LIGHT_ORDER : CONTROLS) {
    // The main window's own button (its icons and title), its clicks this window's.
    const button = /** @type {HTMLElement} */ (document.querySelector(`.window-controls [data-window="${action}"]`)?.cloneNode(true));
    button.addEventListener('click', () => (action === WINDOW_ACTION.close ? (d.close ?? (() => closeWindow(d.key)))() : act(action)));
    lights.append(button);
  }
  d.header.append(controls);
  if (mac) lights.addEventListener('mousedown', e => e.preventDefault(), { signal });
  // Its buttons never take the keyboard from what the window shows.
  controls.addEventListener('mousedown', e => e.preventDefault());
  d.header.addEventListener('mousedown', e => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (e.button !== 0 || target.closest('button, input, textarea, select')) return;
    if (e.detail === 1 && d.dragHandle && target.closest(d.dragHandle)) return;
    const keep = e.detail === 2 && d.keepDoubleClick && target.closest(d.keepDoubleClick);
    if (!keep) act(e.detail === 2 ? WINDOW_ACTION.maximize : WINDOW_ACTION.drag);
  }, { signal });
  for (const edge of document.querySelectorAll('body > .edge')) {
    const copy = /** @type {HTMLElement} */ (doc.importNode(edge, true));
    copy.addEventListener('mousedown', e => { if (e.button === 0) act(WINDOW_ACTION.resize, copy.dataset.edge); });
    doc.body.append(copy);
  }
  showMaximized(d);
}

/**
 * The title bar's pin: pressed, the window stays above every other window (its host keeps it so) until it's pressed
 * again.
 * @param {Document} doc
 * @param {string} key the window it is in (its pin is kept by it)
 * @param {(action: string) => void} act
 */
function pinButton(doc, key, act) {
  const pin = doc.createElement('button');
  pin.innerHTML = PIN_ICON;
  pin.title = PIN_LABEL;
  /** @param {boolean} on */
  const set = on => {
    pin.classList.toggle(PINNED, on);
    pin.setAttribute('aria-pressed', String(on));
    act(on ? WINDOW_ACTION.onTop : WINDOW_ACTION.notOnTop);
  };
  pin.addEventListener('click', () => {
    const on = !pin.classList.contains(PINNED);
    set(on);
    pins.set(key, on);
  });
  // Kept on top when it was last open (after a restart too): so again.
  if (pins.get(key)) set(true);
  else pin.setAttribute('aria-pressed', 'false');
  return pin;
}

/** Which windows are kept on top (their pins): kept with the page's state (store.js gives these). */
let pins = {
  /** @type {(key: string) => boolean} */
  get: () => false,
  /** @type {(key: string, on: boolean) => void} */
  set: () => {},
};

/**
 * Where the windows' pins (Always on top) are kept (store.js, saved with the page's state).
 * @param {(key: string) => boolean} get
 * @param {(key: string, on: boolean) => void} set
 */
export function keepPins(get, set) {
  pins = { get, set };
}

/**
 * Maximized or not, as the window is now: Restore's icon instead of Maximize's, and no edges to drag.
 * @param {Detached} d
 */
function showMaximized(d) {
  const { win } = d;
  // The page is the window less its frame (a pixel each side), so within a few pixels of the screen's room is all of it.
  const { availWidth, availHeight } = win.screen;
  const maximized = win.outerWidth >= availWidth - FRAME_SLACK_PX && win.outerHeight >= availHeight - FRAME_SLACK_PX;
  win.document.body.classList.toggle(MAXIMIZED, maximized);
}

/**
 * Where a window that remembers its place was, as it goes, for next time; not while maximized (it opens where it was
 * before that), nor once its page is gone. Only where its host doesn't say each time it moves or is resized
 * (window:placed): the page's own screenX and size don't follow the host moving the window, so they'd keep the first.
 * @param {Detached} d
 */
function rememberPlace(d) {
  const { win } = d;
  if (!d.remember || d.placed || !d.ready || win.closed || win.document.body.classList.contains(MAXIMIZED)) return;
  places.set(d.key, { x: win.screenX, y: win.screenY, w: win.innerWidth, h: win.innerHeight });
}

// A window moved or resized (not maximized or minimized, its host says): a window that remembers its place keeps it.
onHost(HOST.windowPlaced, m => {
  const d = [...open.values()].find(o => NAME_PREFIX + o.key === m.name);
  if (!d?.remember) return;
  d.placed = true;
  places.set(d.key, { x: m.x, y: m.y, w: m.w, h: m.h });
});

/** Where windows that remember their place were: kept with the page's state (store.js gives these). */
let places = {
  /** @type {(key: string) => WindowPlace | null} */
  get: () => null,
  /** @type {(key: string, place: WindowPlace) => void} */
  set: () => {},
};

/**
 * Where windows that remember their place keep it (store.js, saved with the page's state).
 * @param {(key: string) => WindowPlace | null} get
 * @param {(key: string, place: WindowPlace) => void} set
 */
export function keepPlaces(get, set) {
  places = { get, set };
}

function checkClosed() {
  for (const d of [...open.values()]) if (d.win.closed) closedByHost(d);
}

/**
 * A window gone without the page closing it: its host closed it, which it does only as Termilly closes (the user's
 * Close and Alt+F4 go through the page). What's saved is saved first, as things are (whenHostCloses), so it opens in
 * its window again next time; then its element goes back.
 * @param {Detached} d
 */
function closedByHost(d) {
  if (open.get(d.key) !== d) return; // the page closed it: gone already
  hostCloses();
  gone(d, false);
}

/** What runs as the host closes the windows (store.js: the last save). */
let hostCloses = () => {};

/**
 * What runs once the host starts closing the windows, Termilly closing (store.js saves as things are, then stops).
 * @param {() => void} run
 */
export function whenHostCloses(run) {
  hostCloses = run;
}

/**
 * The main page's root attributes (theme, fonts, colours) on a window's root, kept the same as they change.
 * @param {HTMLElement} root
 */
function mirror(root) {
  for (const { name } of [...root.attributes]) if (!document.documentElement.hasAttribute(name)) root.removeAttribute(name);
  for (const { name, value } of document.documentElement.attributes) root.setAttribute(name, value);
}

// A window moved by its title bar, over the main window: its owner shows where it would land (and lands it when it's
// let go), and the window goes see-through while there's a place, so the main window shows under it.
onHost(HOST.windowDragged, m => {
  const d = [...open.values()].find(o => NAME_PREFIX + o.key === m.name);
  if (!d?.onDragged) return;
  const lands = d.onDragged(m.x, m.y, m.dropped) && !m.dropped;
  if (lands === !!d.faded || !open.has(d.key)) return;
  d.faded = lands;
  send(PAGE.window, { action: lands ? WINDOW_ACTION.fade : WINDOW_ACTION.solid, name: m.name });
});

window.addEventListener('focus', () => { here = document; });
// The main page going (Termilly quitting, a reload): its windows go with it.
window.addEventListener(PAGE_GONE, () => { for (const d of open.values()) d.win.close(); });
