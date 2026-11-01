// @ts-check
// Termilly's own tooltips, for every element with a title. The browser's (WebView2's, WebKitGTK's) skip a hover that
// comes back quickly and look different on each system. As the mouse comes to an element its title moves to
// data-tip, so the browser's never shows; a title set again later is taken the next time. Right after one shows, the
// next shows at once, as moving along a toolbar expects.

import { MOUSE_OVER } from './dom.js';

/** How long the mouse rests before a tooltip shows, and how soon after one hid the next shows at once (ms). */
const SHOW_MS = 450;
const WARM_MS = 700;
/** The gap between the element and its tooltip, and the window's edge it keeps off (px). */
const GAP = 6;
const EDGE = 8;
const TIP_ATTR = 'title';
const TITLED = '[title], [data-tip]';

const tip = document.createElement('div');
tip.className = 'tip';
tip.setAttribute('role', 'tooltip');
tip.hidden = true;
document.body.append(tip);

/** @type {HTMLElement | null} */
let target = null;
let timer = 0;
let hiddenAt = 0;
/** Where the mouse is: an element redrawn under it (a sidebar row) is found again there. */
let mouseX = -1;
let mouseY = -1;

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

/** A title set while its tooltip shows: the tooltip follows it. */
const watcher = new MutationObserver(() => {
  if (!target) return;
  const text = textOf(target);
  if (text) tip.textContent = text;
  else hide();
});

function place() {
  if (!target) return;
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, r.left + r.width / 2 - w / 2));
  const below = r.bottom + GAP;
  const top = below + h + EDGE <= window.innerHeight ? below : Math.max(EDGE, r.top - GAP - h);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function show() {
  if (target && !target.isConnected) {
    // Redrawn while the mouse rested on it: the one there now.
    const now = /** @type {HTMLElement | null} */ (document.elementFromPoint(mouseX, mouseY)?.closest(TITLED) ?? null);
    watcher.disconnect();
    target = now;
    if (now) watcher.observe(now, { attributes: true, attributeFilter: [TIP_ATTR] });
  }
  if (!target) return hide();
  const text = textOf(target);
  if (!text) return;
  tip.textContent = text;
  tip.hidden = false;
  place();
}

function hide() {
  clearTimeout(timer);
  watcher.disconnect();
  if (!tip.hidden) {
    tip.hidden = true;
    hiddenAt = Date.now();
  }
  target = null;
}

document.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; }, { capture: true, passive: true });
document.addEventListener(MOUSE_OVER, e => {
  const el = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.(TITLED) ?? null);
  if (el === target) return;
  hide();
  if (!el || !textOf(el)) return;
  target = el;
  watcher.observe(el, { attributes: true, attributeFilter: [TIP_ATTR] });
  timer = window.setTimeout(show, Date.now() - hiddenAt < WARM_MS ? 0 : SHOW_MS);
}, true);

// Leaving the window, clicking, typing or scrolling puts it away (until the mouse comes to another element).
document.documentElement.addEventListener('mouseleave', hide);
for (const type of ['mousedown', 'keydown', 'wheel']) {
  window.addEventListener(type, () => {
    const el = target;
    hide();
    // Still over it: no tooltip again until the mouse leaves it.
    target = el;
  }, true);
}
window.addEventListener('blur', hide);
