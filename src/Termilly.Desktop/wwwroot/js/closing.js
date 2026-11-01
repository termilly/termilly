// @ts-check
// The screen Termilly shows while it closes (quit.js, snapshot.js): the logo, "Closing Termilly", a spinner and the
// step it's on, over the page, so the last moments aren't a frozen or blank window.

import { announce } from './dom.js';

/** The logo's sizes in pixels, one per display scale, and its size at 100% (as js/loader.js). */
const MARK_SIZES_PX = [48, 60, 72, 84, 96];
const MARK_BASE_PX = 48;

/** @type {HTMLElement | null} */
let screen = null;

/**
 * Shows the closing screen (once), at a step.
 * @param {string} step
 */
export function showClosing(step) {
  if (!screen) {
    screen = document.createElement('div');
    screen.className = 'closing-screen';
    announce(screen);
    screen.innerHTML = `
      <img width="48" height="48" alt="" srcset="${MARK_SIZES_PX.map(size => `assets/loader/mark-${size}.png ${size / MARK_BASE_PX}x`).join(', ')}">
      <div class="closing-title">Closing Termilly</div>
      <div class="closing-step"><span class="closing-spin"></span><span class="closing-text"></span></div>`;
    document.body.append(screen);
  }
  /** @type {HTMLElement} */ (screen.querySelector('.closing-text')).textContent = step;
}

/** Lets the closing screen paint before work that holds the page up (the last snapshot). */
export const painted = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
