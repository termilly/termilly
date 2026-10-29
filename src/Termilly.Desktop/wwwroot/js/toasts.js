// @ts-check
// Short notes at the bottom centre of the window about something the app did: "Downloaded 3 items to Downloads".
// One per action, however many files it took: it says what's going on while it runs, then what came of it, and
// closes by itself a few seconds later (or with its own ×). A note can carry one button, such as "Show".

import { escapeHtml, ICONS } from './ui.js';
import { targetOf, announce } from './dom.js';

/** How long a finished note stays, in milliseconds. */
const SHOWN_MS = 5000;
/** How many notes show at once: an older one makes room. */
const MOST = 4;
/** What a note is: under way, done, or failed (coloured). */
export const TOAST = Object.freeze({ running: 'running', done: 'done', failed: 'failed' });

/**
 * What a note says: its text, its state, and a button.
 * @typedef {{ text: string, state?: string, action?: { label: string, run: () => void } | null }} ToastContent
 */
/**
 * A note shown: change what it says (a finished one closes by itself), or close it.
 * @typedef {{ update: (content: ToastContent) => void, close: () => void }} Toast
 */

const area = document.createElement('div');
area.className = 'toasts';
area.setAttribute('role', 'status');
announce(area);
document.body.append(area);

/**
 * Shows a note. A running one stays until it's updated as done or failed.
 * @param {ToastContent} content
 * @returns {Toast}
 */
export function showToast(content) {
  const el = document.createElement('div');
  el.className = 'toast';
  /** @type {(() => void) | null} */
  let run = null;
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  /** @param {ToastContent} c */
  const update = ({ text, state = TOAST.done, action = null }) => {
    run = action?.run ?? null;
    el.dataset.state = state;
    el.innerHTML = `
      ${state === TOAST.running ? '<span class="toast-spinner"></span>' : ''}
      <span class="toast-text" title="${escapeHtml(text)}">${escapeHtml(text)}</span>
      ${action ? `<button class="btn small" data-toast-action>${escapeHtml(action.label)}</button>` : ''}
      <button class="pane-btn toast-close" data-toast-close title="Close" aria-label="Close">${ICONS.close}</button>`;
    clearTimeout(timer);
    if (state !== TOAST.running) timer = window.setTimeout(close, SHOWN_MS);
  };
  el.addEventListener('click', e => {
    if (targetOf(e).closest('[data-toast-close]')) close();
    else if (targetOf(e).closest('[data-toast-action]') && run) {
      run();
      close();
    }
  });
  // Pointing at a finished note keeps it while it's read.
  el.addEventListener('pointerenter', () => { if (el.dataset.state !== TOAST.running) clearTimeout(timer); });
  el.addEventListener('pointerleave', () => { if (el.dataset.state !== TOAST.running) timer = window.setTimeout(close, SHOWN_MS); });
  update(content);
  area.append(el);
  while (area.children.length > MOST) area.firstElementChild?.remove();
  return { update, close };
}
