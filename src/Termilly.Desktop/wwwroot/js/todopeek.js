// @ts-check
// Peek on hover for To do (as the Work panel had): a moment on a task shows a card beside the panel with all of it, its
// details, its steps, who works on it and what they said. It stays while the pointer is on it, Space on a task shows it or
// puts it away, and its size, dragged from its corner, is kept. Beside the panel where there's room (the side with more),
// else over it, as in a window of its own.

import { state, persist } from './store.js';
import { targetOf } from './dom.js';

/** How long the pointer rests on a task before its card shows, and how long the card waits after the pointer left. */
const PEEK_DELAY_MS = 500;
const PEEK_HIDE_MS = 250;
/** Its size at first, and the least it can be dragged to. */
const PEEK_SIZE = Object.freeze({ width: 380, height: 340 });
const PEEK_MIN = Object.freeze({ width: 260, height: 140 });
/** Its distance from the panel and from the window's edges. */
const PEEK_GAP_PX = 8;

/**
 * @typedef {object} PeekOptions
 * @property {HTMLElement} panel
 * @property {(taskId: string) => string | null} contentOf the card's markup for a task, or null when it's gone
 * @property {(control: HTMLElement, taskId: string) => void} act a control in the card was clicked
 */

/**
 * Where the card goes: beside the panel on the side with more room, else over the panel.
 * @param {DOMRect} panel
 * @param {DOMRect} row
 * @param {{ width: number, height: number }} size
 * @param {{ width: number, height: number }} view the window
 */
export function peekPlace(panel, row, size, view) {
  const left = panel.left;
  const right = view.width - panel.right;
  const roomy = Math.max(left, right) >= PEEK_MIN.width + PEEK_GAP_PX * 2;
  const room = roomy ? Math.max(left, right) - PEEK_GAP_PX * 2 : panel.width - PEEK_GAP_PX * 2;
  const width = Math.max(PEEK_MIN.width, Math.min(size.width, room));
  const height = Math.max(PEEK_MIN.height, Math.min(size.height, view.height - PEEK_GAP_PX * 2));
  const top = Math.max(PEEK_GAP_PX, Math.min(row.top, view.height - height - PEEK_GAP_PX));
  const x = !roomy ? panel.left + PEEK_GAP_PX : left >= right ? panel.left - width - PEEK_GAP_PX : panel.right + PEEK_GAP_PX;
  return { width, height, top, left: Math.max(PEEK_GAP_PX, x) };
}

/**
 * The card's own events: the pointer on it keeps it, its controls act, Space or Escape puts it away, and its size is kept.
 * @param {HTMLElement} card
 * @param {{ hide: () => void, left: () => void, keep: () => void, act: PeekOptions['act'] }} handlers
 */
function wireCard(card, { hide, left, keep, act }) {
  card.addEventListener('mouseleave', left);
  card.addEventListener('mouseenter', keep);
  card.addEventListener('click', e => {
    const control = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-td]'));
    if (control && card.dataset.task) act(control, card.dataset.task);
  });
  card.addEventListener('keydown', e => {
    if (e.key !== ' ' && e.key !== 'Escape') return;
    e.preventDefault();
    hide();
  });
  // Its size, dragged from its corner, is kept for the next card.
  new ResizeObserver(() => {
    if (card.hidden) return;
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const kept = state.todo.peek;
    if (kept && kept.width === size.width && kept.height === size.height) return;
    state.todo.peek = size;
    persist();
  }).observe(card);
}

/**
 * Puts the card by a task's row, in the panel's window.
 * @param {HTMLElement} card
 * @param {HTMLElement} panel
 * @param {HTMLElement} row
 */
function place(card, panel, row) {
  // The panel can be in a window of its own: the card goes where it is.
  if (card.ownerDocument !== panel.ownerDocument || !card.isConnected) panel.ownerDocument.body.append(card);
  const view = panel.ownerDocument.defaultView ?? window;
  const at = peekPlace(panel.getBoundingClientRect(), row.getBoundingClientRect(), state.todo.peek ?? PEEK_SIZE, { width: view.innerWidth, height: view.innerHeight });
  Object.assign(card.style, { width: `${at.width}px`, height: `${at.height}px`, top: `${at.top}px`, left: `${at.left}px` });
}

/**
 * Shows the card for a task's row.
 * @param {{ card: HTMLElement, panel: HTMLElement, peek: { row: HTMLElement | null }, contentOf: PeekOptions['contentOf'] }} at
 * @param {HTMLElement} row
 */
function showCard({ card, panel, peek, contentOf }, row) {
  const html = contentOf(/** @type {string} */ (row.dataset.task));
  if (!html) return;
  peek.row = row;
  card.dataset.task = row.dataset.task;
  card.innerHTML = html;
  place(card, panel, row);
  card.hidden = false;
}

/** @param {PeekOptions} options */
export function createPeek({ panel, contentOf, act }) {
  const card = Object.assign(document.createElement('div'), { className: 'td-peek', hidden: true, tabIndex: -1 });
  /** @type {{ row: HTMLElement | null, timer: number, hideTimer: number }} */
  const peek = { row: null, timer: 0, hideTimer: 0 };

  /** @param {HTMLElement} row */
  const show = row => showCard({ card, panel, peek, contentOf }, row);
  function hide() {
    clearTimeout(peek.timer);
    clearTimeout(peek.hideTimer);
    card.hidden = true;
    peek.row = null;
  }

  /** The pointer left the task or the card: the card goes, unless the pointer is on it. */
  function left() {
    clearTimeout(peek.timer);
    peek.hideTimer = window.setTimeout(() => {
      if (!card.matches(':hover')) hide();
    }, PEEK_HIDE_MS);
  }

  wireCard(card, { hide, left, keep: () => clearTimeout(peek.hideTimer), act });
  return {
    hide,
    left,
    /** @param {HTMLElement} row the pointer came onto a task: its card shows after a moment */
    entered(row) {
      clearTimeout(peek.timer);
      clearTimeout(peek.hideTimer);
      if (peek.row === row && !card.hidden) return;
      peek.timer = window.setTimeout(() => show(row), PEEK_DELAY_MS);
    },
    /** @param {HTMLElement} row Space on a task: its card, or away with it */
    toggle(row) {
      if (!card.hidden && peek.row?.dataset.task === row.dataset.task) hide();
      else show(row);
    },
    /** The task changed: its card again, or gone with it. Rows are drawn anew, so its row is found by its task. */
    refresh() {
      if (card.hidden || !card.dataset.task) return;
      const html = contentOf(card.dataset.task);
      if (!html) return hide();
      card.innerHTML = html;
      peek.row = panel.querySelector(`[data-task="${CSS.escape(card.dataset.task)}"]`);
    },
  };
}
