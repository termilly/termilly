// @ts-check
// Going to a terminal from news that it needs the user (a desktop notification, the inbox, Minimal's "needs you"):
// its pane flashes once, so the eye finds it in a busy layout.

import { focusTab } from './panes.js';

/** The flash laid over the pane (panes.css). */
const ARRIVED_CLASS = 'pane-arrived';
/** How long the flash stays: a little over its animation. */
const ARRIVED_MS = 300;
/** Each lit pane's timer, so a second go starts a fresh flash rather than having the old timer cut it short. */
const arrivedTimers = new WeakMap();

/**
 * Focuses the terminal and flashes its pane.
 * @param {Tab} tab
 */
export function arriveAt(tab) {
  focusTab(tab);
  const el = tab.view?.el;
  if (el) flash(el);
}

/**
 * Flashes an element once, as a pane does when a notification takes the user to it (the notification center's button
 * when something comes in while it's closed, js/inboxalert.js). The element has the room for it in panes.css.
 * @param {HTMLElement} el
 */
export function flash(el) {
  // Its own element, not a pseudo-element: the pane's ::before is the broadcast stripe and its ::after Minimal's edge.
  el.querySelector(`:scope > .${ARRIVED_CLASS}`)?.remove();
  clearTimeout(arrivedTimers.get(el));
  const glow = document.createElement('div');
  glow.className = ARRIVED_CLASS;
  el.append(glow);
  arrivedTimers.set(el, setTimeout(() => glow.remove(), ARRIVED_MS));
}
