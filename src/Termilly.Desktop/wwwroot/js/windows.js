// @ts-check
// Termilly's own windows besides the main one: a terminal, the Notepad or the Snippets window detached into a window
// of its own (detached.html). Everything keeps running in the main page; a detached window only shows the element
// moved into it, in the main page's theme (its root's attributes mirrored), and closing it gives the element back.
// Menus and dialogs open in the window the user is in (hereDoc), and what has to listen in every window (popups'
// Escape and outside clicks, Termilly's shortcuts) registers once with inEachDocument.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { WINDOW_ACTION } from './constants.js';

/**
 * A detached window: what it shows, its title, and what happens around it. onMoved runs once the element is in it
 * (the window takes a moment to open, and the element stays where it was until then); onClosed gets the element back
 * (it's no longer in any page); askClose, when given, decides whether the title bar's X may close it (it closes it
 * itself).
 * @typedef {{ key: string, win: Window, el: HTMLElement, title: string, ready: boolean, onClosed: (el: HTMLElement) => void,
 *   onMoved?: () => void, onResize?: () => void, askClose?: () => unknown }} Detached
 */

/** The page the windows show, and what their window.open names start with. */
const PAGE_URL = 'detached.html';
const NAME_PREFIX = 'termilly-';
/** How often the windows are checked for one gone without saying so (closed with its page). */
const WATCH_MS = 1000;
/** Where a new window opens from the place its element had, so the two don't line up exactly. */
const OFFSET_PX = 24;
/** A page going away: a detached window's closing, or the main page's. */
const PAGE_GONE = 'pagehide';

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
 *   onResize?: () => void, askClose?: () => unknown }} options
 */
export function detach(key, { el, title, onClosed, onMoved, onResize, askClose }) {
  if (open.has(key)) return focusWindow(key), true;
  const r = el.getBoundingClientRect();
  const features = [
    'popup', `width=${Math.round(r.width)}`, `height=${Math.round(r.height)}`,
    `left=${Math.round(screenX + r.left + OFFSET_PX)}`, `top=${Math.round(screenY + r.top + OFFSET_PX)}`,
  ].join(',');
  const win = window.open(PAGE_URL, NAME_PREFIX + key, features);
  if (!win) return false;
  open.set(key, { key, win, el, title, ready: false, onClosed, onMoved, onResize, askClose });
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
 * detached.html has loaded (it calls this on its opener): the element moves in, in the main page's theme.
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
  win.addEventListener('focus', () => { here = doc; });
  win.addEventListener('resize', () => d.onResize?.());
  win.addEventListener(PAGE_GONE, () => gone(d, false));
  here = doc;
  d.onMoved?.();
  d.onResize?.();
}

/**
 * The title bar's X (detached.html asks here first): the owner may ask about changes not saved, else it closes.
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
  if (here.defaultView === d.win) here = document;
  if (!open.size) {
    clearInterval(watch);
    watch = 0;
  }
  // Out of the closing window's page now, so it never goes down with it.
  document.adoptNode(d.el);
  if (!quiet) d.onClosed(d.el);
}

function checkClosed() {
  for (const d of [...open.values()]) if (d.win.closed) gone(d, false);
}

/**
 * The main page's root attributes (theme, fonts, colours) on a window's root, kept the same as they change.
 * @param {HTMLElement} root
 */
function mirror(root) {
  for (const { name } of [...root.attributes]) if (!document.documentElement.hasAttribute(name)) root.removeAttribute(name);
  for (const { name, value } of document.documentElement.attributes) root.setAttribute(name, value);
}

window.addEventListener('focus', () => { here = document; });
// The main page going (Termilly quitting, a reload): its windows go with it.
window.addEventListener(PAGE_GONE, () => { for (const d of open.values()) d.win.close(); });

/** detached.html's calls on its opener. */
Object.assign(window, { termillyWindowReady: ready, termillyWindowClose: askClose });
