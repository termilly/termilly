// @ts-check
// Termilly's own tooltips, for every element with a title, in every window (the main one and the windows of its own a
// terminal, the Notepad or the Snippets window opens in). The browser's (WebView2's, WebKitGTK's) skip a hover that
// comes back quickly and look different on each system. As the mouse comes to an element its title moves to
// data-tip, so the browser's never shows; a title set again later is taken the next time. Right after one shows, the
// next shows at once, as moving along a toolbar expects.

import { MOUSE_OVER } from './dom.js';
import { inEachDocument } from './windows.js';

/** How long the mouse rests before a tooltip shows, and how soon after one hid the next shows at once (ms). */
const SHOW_MS = 450;
const WARM_MS = 700;
/** The gap between the element and its tooltip, and the window's edge it keeps off (px). */
const GAP = 6;
const EDGE = 8;
const TIP_ATTR = 'title';
const TITLED = '[title], [data-tip]';

/**
 * One window's tooltips: its document and window, its tooltip element, the element the mouse rests on, the timer that
 * shows it, when the last one hid, where the mouse is, and what follows a title changing while it shows.
 * @typedef {{ doc: Document, win: Window, tip: HTMLElement, target: HTMLElement | null, timer: number, hiddenAt: number,
 *   mouseX: number, mouseY: number, watcher: MutationObserver }} Tips
 */

/**
 * An element's tooltip text: its title, moved to data-tip (and kept as its name for screen readers when it has no
 * text of its own).
 * @param {HTMLElement} el
 */
function textOf(el) {
  const title = el.getAttribute(TIP_ATTR);
  if (title !== null) {
    el.removeAttribute(TIP_ATTR);
    if (title) el.dataset.tip = title;
    else delete el.dataset.tip;
    if (title && !el.textContent?.trim() && !el.hasAttribute('aria-label')) el.setAttribute('aria-label', title);
  }
  return el.dataset.tip ?? '';
}

/** @param {Tips} t */
function place(t) {
  if (!t.target) return;
  const r = t.target.getBoundingClientRect();
  const w = t.tip.offsetWidth;
  const h = t.tip.offsetHeight;
  const left = Math.max(EDGE, Math.min(t.win.innerWidth - w - EDGE, r.left + r.width / 2 - w / 2));
  const below = r.bottom + GAP;
  const top = below + h + EDGE <= t.win.innerHeight ? below : Math.max(EDGE, r.top - GAP - h);
  t.tip.style.left = `${Math.round(left)}px`;
  t.tip.style.top = `${Math.round(top)}px`;
}

/** @param {Tips} t */
function show(t) {
  if (t.target && !t.target.isConnected) {
    // Redrawn while the mouse rested on it: the one there now.
    const now = /** @type {HTMLElement | null} */ (t.doc.elementFromPoint(t.mouseX, t.mouseY)?.closest(TITLED) ?? null);
    t.watcher.disconnect();
    t.target = now;
    if (now) t.watcher.observe(now, { attributes: true, attributeFilter: [TIP_ATTR] });
  }
  if (!t.target) return hide(t);
  const text = textOf(t.target);
  if (!text) return;
  t.tip.textContent = text;
  t.tip.hidden = false;
  place(t);
}

/** @param {Tips} t */
function hide(t) {
  t.win.clearTimeout(t.timer);
  t.watcher.disconnect();
  if (!t.tip.hidden) {
    t.tip.hidden = true;
    t.hiddenAt = Date.now();
  }
  t.target = null;
}

/**
 * The mouse came to an element: its tooltip shows after a rest (at once right after another hid).
 * @param {Tips} t
 * @param {Event} e
 */
function over(t, e) {
  const el = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.(TITLED) ?? null);
  if (el === t.target) return;
  hide(t);
  if (!el || !textOf(el)) return;
  t.target = el;
  t.watcher.observe(el, { attributes: true, attributeFilter: [TIP_ATTR] });
  t.timer = t.win.setTimeout(() => show(t), Date.now() - t.hiddenAt < WARM_MS ? 0 : SHOW_MS);
}

/**
 * Tooltips in one window's document.
 * @param {Document} doc
 */
function install(doc) {
  const tip = doc.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  doc.body.append(tip);
  /** @type {Tips} */
  const t = {
    doc, win: /** @type {Window} */ (doc.defaultView), tip, target: null, timer: 0, hiddenAt: 0, mouseX: -1, mouseY: -1,
    // A title set while its tooltip shows: the tooltip follows it.
    watcher: new MutationObserver(() => {
      if (!t.target) return;
      const text = textOf(t.target);
      if (text) t.tip.textContent = text;
      else hide(t);
    }),
  };
  doc.addEventListener('mousemove', e => { t.mouseX = e.clientX; t.mouseY = e.clientY; }, { capture: true, passive: true });
  doc.addEventListener(MOUSE_OVER, e => over(t, e), true);
  // Leaving the window, clicking, typing or scrolling puts it away (until the mouse comes to another element).
  doc.documentElement.addEventListener('mouseleave', () => hide(t));
  for (const type of ['mousedown', 'keydown', 'wheel']) {
    t.win.addEventListener(type, () => {
      const el = t.target;
      hide(t);
      // Still over it: no tooltip again until the mouse leaves it.
      t.target = el;
    }, true);
  }
  t.win.addEventListener('blur', () => hide(t));
}

inEachDocument(install);
