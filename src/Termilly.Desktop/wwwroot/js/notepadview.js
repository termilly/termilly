// @ts-check
// How the Notepad (js/notepad.js) shows a page, around its text box: the text's size (Ctrl+wheel, Ctrl+= - 0, as in
// terminals), line numbers on the left (following wrapped lines), the caret's line marked, and a status bar with the
// page's characters and lines, the caret's line and column, and what's selected. With word wrap a line may take more
// than one row, so where each line starts is measured in a copy of the text laid out as the box lays it out.

import { escapeHtml } from './ui.js';

/** The text's size in pixels: its default, and how small and big Ctrl+wheel takes it. */
export const NP_FONT = Object.freeze({ default: 13, min: 8, max: 32 });
const LF = '\n';
/** On the editor while line numbers show (app.css gives the text room for them). */
const NUMBERS_CLASS = 'with-numbers';
/** The line-number column's room besides its digits, in characters. */
const GUTTER_EXTRA_CH = 2;
/** The keys that change the size while the Notepad has the focus (Ctrl+= - 0). */
const SIZE_KEYS = Object.freeze({ Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1, Digit0: 0, Numpad0: 0 });
/** The text's size, and its line height (app.css: .np-text). */
const SIZE_VAR = '--np-size';
const LINE_HEIGHT = 1.5;
const ARIA_HIDDEN = 'aria-hidden';

/**
 * What the view works with: the text box, the editor around it, what's added there, and where each line is.
 * @typedef {{ area: HTMLTextAreaElement, editor: HTMLElement, statusEl: HTMLElement, band: HTMLElement,
 *   gutter: HTMLElement, measure: HTMLElement, tops: number[], heights: number[], size: () => number,
 *   setSize: (px: number) => void, numbers: () => boolean, highlight: () => boolean }} View
 */

/**
 * The line and column of a place in the text (both from 1).
 * @param {string} text
 * @param {number} at
 */
function lineCol(text, at) {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf(LF); i !== -1 && i < at; i = text.indexOf(LF, i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, col: at - start + 1 };
}

/** @param {number} n */
const count = n => n.toLocaleString();

/**
 * @param {string} className
 * @param {boolean} [unread] screen readers leave it out
 */
function part(className, unread = true) {
  const el = document.createElement('div');
  el.className = className;
  if (unread) el.setAttribute(ARIA_HIDDEN, String(true));
  return el;
}

/**
 * Each line's place, measured again (after typing, a resize, a change of size or wrap), then drawn.
 * @param {View} v
 */
function layout(v) {
  const { area, measure, editor } = v;
  const lines = area.value.split(LF);
  const style = getComputedStyle(area);
  const row = parseFloat(style.lineHeight) || v.size() * LINE_HEIGHT;
  if (style.whiteSpace === 'pre') {
    v.tops = lines.map((_, i) => i * row);
    v.heights = lines.map(() => row);
  } else {
    measure.style.width = `${area.clientWidth}px`;
    measure.innerHTML = lines.map(l => `<div>${escapeHtml(l) || ' '}</div>`).join('');
    const kids = /** @type {HTMLElement[]} */ ([...measure.children]);
    const first = kids[0]?.offsetTop ?? 0;
    v.tops = kids.map(k => k.offsetTop - first);
    v.heights = kids.map(k => k.offsetHeight || row);
    measure.textContent = '';
  }
  editor.style.setProperty('--np-gutter', `${String(lines.length).length + GUTTER_EXTRA_CH}ch`);
  place(v);
}

/**
 * The line numbers in sight, and the caret's line marked, where the text is scrolled to.
 * @param {View} v
 */
function place(v) {
  const { area, band, gutter, tops, heights } = v;
  const on = v.numbers();
  v.editor.classList.toggle(NUMBERS_CLASS, on);
  const padTop = parseFloat(getComputedStyle(area).paddingTop) || 0;
  const caret = lineCol(area.value, area.selectionStart).line - 1;
  const scrolled = area.scrollTop;
  band.hidden = !v.highlight() || area.hidden;
  if (!band.hidden) {
    band.style.top = `${padTop + (tops[caret] ?? 0) - scrolled}px`;
    band.style.height = `${heights[caret] ?? 0}px`;
  }
  if (!on || area.hidden) return void (gutter.innerHTML = '');
  const bottom = scrolled + area.clientHeight;
  let html = '';
  for (let i = 0; i < tops.length && tops[i] <= bottom; i++) {
    if (tops[i] + heights[i] < scrolled - padTop) continue;
    html += `<span class="${i === caret ? 'on' : ''}" style="top:${padTop + tops[i] - scrolled}px">${i + 1}</span>`;
  }
  gutter.innerHTML = html;
}

/**
 * The status bar: characters, lines, the caret's line and column, what's selected.
 * @param {View} v
 */
function status(v) {
  const { area, statusEl } = v;
  statusEl.hidden = area.hidden;
  if (area.hidden) return;
  const { value, selectionStart: from, selectionEnd: to } = area;
  const { line, col } = lineCol(value, to);
  const chosen = to - from;
  const chosenLines = chosen ? line - lineCol(value, from).line + 1 : 0;
  statusEl.innerHTML = `<span>Chars ${count([...value].length)}</span><span>Lines ${count(value.split(LF).length)}</span>`
    + `<span>Ln ${count(line)}, Col ${count(col)}</span>`
    + (chosen ? `<span>Selected ${count([...value.slice(from, to)].length)} chars, ${count(chosenLines)} ${chosenLines === 1 ? 'line' : 'lines'}</span>` : '');
}

/**
 * The text's size set (within NP_FONT's bounds), and everything laid out at it.
 * @param {View} v
 * @param {number} px
 */
function resize(v, px) {
  v.setSize(Math.min(NP_FONT.max, Math.max(NP_FONT.min, px)));
  v.editor.style.setProperty(SIZE_VAR, `${v.size()}px`);
  layout(v);
}

/**
 * Follows the text box: typing, scrolling, the caret moving, a resize, and Ctrl+wheel.
 * @param {View} v
 */
function wire(v) {
  const { area, editor } = v;
  const moved = () => requestAnimationFrame(() => {
    place(v);
    status(v);
  });
  area.addEventListener('input', () => {
    layout(v);
    status(v);
  });
  area.addEventListener('scroll', () => place(v), { passive: true });
  for (const kind of ['keydown', 'mousedown', 'mouseup', 'select', 'focus']) area.addEventListener(kind, moved);
  area.addEventListener('mousemove', e => { if (e.buttons) moved(); });
  new ResizeObserver(() => layout(v)).observe(area);
  // Ctrl+wheel: the text bigger or smaller, as in terminals (the page doesn't zoom).
  editor.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    resize(v, v.size() + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
}

/**
 * The view around the Notepad's text box. `size` and `setSize` keep the text's size; `numbers` and `highlight` say
 * whether the page shown has line numbers and its caret's line marked.
 * @param {HTMLTextAreaElement} area
 * @param {HTMLElement} statusEl
 * @param {{ size: () => number, setSize: (px: number) => void, numbers: () => boolean, highlight: () => boolean }} options
 */
export function padView(area, statusEl, options) {
  const editor = /** @type {HTMLElement} */ (area.parentElement);
  /** @type {View} */
  const v = { ...options, area, editor, statusEl, band: part('np-band'), gutter: part('np-gutter'), measure: part('np-measure'), tops: [0], heights: [0] };
  editor.prepend(v.band, v.gutter, v.measure);
  editor.style.setProperty(SIZE_VAR, `${v.size()}px`);
  wire(v);
  return {
    /** A page shown, or one of its view's switches changed: everything drawn again. */
    refresh() {
      layout(v);
      status(v);
    },
    /**
     * Ctrl+= - 0 in the Notepad: true when the key was one of them (and the size changed).
     * @param {KeyboardEvent} e
     */
    sizeKey(e) {
      const step = /** @type {Record<string, number>} */ (SIZE_KEYS)[e.code];
      if (!e.ctrlKey || e.altKey || e.shiftKey || step === undefined) return false;
      resize(v, step === 0 ? NP_FONT.default : v.size() + step);
      return true;
    },
  };
}
