// @ts-check
// To do's tag suggestions: typing `:` at the start of a word in a task's field lists the tags there are under the caret.
// The arrows move through them, Enter or Tab (or a click) picks one, Escape closes them.

import { openPopover, closePopover, isOpen } from './popups.js';
import { escapeHtml, cssColor } from './ui.js';
import { find, targetOf, CANVAS_2D } from './dom.js';
import { tagTypedAt, tagSuggestions } from './todolist.js';
import { todoTags, tagColor } from './todo.js';

const ROW = '.tp-row';
const PICK_KEYS = ['Enter', 'Tab'];
/** Keys that move the caret: the suggestions look again at where it is. */
const CARET_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

/**
 * One field's suggestions: the field, what it was asked to do, and what shows.
 * @typedef {{ field: HTMLInputElement, taken: () => string[], chosen?: (tag: string) => void, box: HTMLElement | null,
 *   tags: [string, number][], active: number, start: number, leaving: boolean }} Completion
 */

/**
 * The suggestions' rows: each tag's chip and how many tasks have it, the one picked with the keys lit.
 * @param {[string, number][]} tags
 * @param {number} active
 */
const rowsHtml = (tags, active) => tags.map(([tag, count], i) => `
  <button type="button" class="tp-row${i === active ? ' on' : ''}" data-tag="${escapeHtml(tag)}" role="option" aria-selected="${i === active}" tabindex="-1">
    <span class="td-chip" style="--td-hue:${cssColor(tagColor(tag))}">${escapeHtml(tag)}</span><span class="tp-count">${count || ''}</span>
  </button>`).join('');

/**
 * Where in the window the text of a field reaches at `index`: under it, the suggestions open.
 * @param {HTMLInputElement} field
 * @param {number} index
 */
function caretPoint(field, index) {
  const view = /** @type {Window} */ (field.ownerDocument.defaultView);
  const style = view.getComputedStyle(field);
  const canvas = field.ownerDocument.createElement('canvas').getContext(CANVAS_2D);
  let width = 0;
  if (canvas) {
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    width = canvas.measureText(field.value.slice(0, index)).width;
  }
  const rect = field.getBoundingClientRect();
  const left = rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) + width - field.scrollLeft;
  return { x: Math.min(Math.max(left, rect.left), rect.right), y: rect.bottom };
}

/** @param {Completion} c */
const close = c => {
  if (c.box) closePopover(c.box);
};

/** @param {Completion} c */
const draw = c => {
  if (c.box) find(c.box, '.tp-list').innerHTML = rowsHtml(c.tags, c.active);
};

/**
 * Opens the suggestions under the typed colon.
 * @param {Completion} c
 */
function open(c) {
  const doc = c.field.ownerDocument;
  const box = doc.createElement('div');
  box.className = 'popover tag-picker td-complete';
  box.hidden = true;
  box.innerHTML = '<div class="tp-list" role="listbox" aria-label="Tags"></div>';
  // A click on a tag keeps the focus in the field.
  box.addEventListener('mousedown', e => e.preventDefault());
  box.addEventListener('click', e => {
    const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
    if (row?.dataset.tag) pick(c, row.dataset.tag);
  });
  c.box = box;
  draw(c);
  // In the field's own window, a detached To do's too.
  doc.body.append(box);
  openPopover(box, caretPoint(c.field, c.start), {
    dynamic: true,
    onClose: () => { if (c.box === box) c.box = null; },
    refocus: () => { if (!c.leaving) c.field.focus(); },
  });
}

/**
 * Shows the tags for what's typed before the caret, or closes them when nothing is.
 * @param {Completion} c
 */
function update(c) {
  const { field } = c;
  const typed = field.selectionStart === field.selectionEnd ? tagTypedAt(field.value, field.selectionStart ?? 0) : null;
  c.tags = typed ? tagSuggestions(todoTags(), typed.query, c.taken()) : [];
  if (!typed || !c.tags.length) return close(c);
  c.active = 0;
  if (c.box && isOpen(c.box) && typed.start === c.start) return draw(c);
  close(c);
  c.start = typed.start;
  open(c);
}

/**
 * Puts the picked tag in for the typed one: `:tag: `, or nothing when it's handed over.
 * @param {Completion} c
 * @param {string} tag
 */
function pick(c, tag) {
  const { field } = c;
  const before = field.value.slice(0, c.start);
  const after = field.value.slice(field.selectionStart ?? field.value.length).replace(/^\s+/, '');
  close(c);
  const put = c.chosen ? '' : `:${tag}: `;
  field.value = before + put + after;
  field.setSelectionRange(before.length + put.length, before.length + put.length);
  // What listens to the field sees the tag put in (the add field's chips).
  field.dispatchEvent(new Event('input', { bubbles: true }));
  c.chosen?.(tag);
  field.focus();
}

/**
 * The keys while the suggestions show: the arrows move, Enter or Tab picks; moving the caret looks again.
 * @param {Completion} c
 * @param {KeyboardEvent} e
 */
function onKey(c, e) {
  if (!c.box || !isOpen(c.box) || !c.tags.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    c.active = (c.active + (e.key === 'ArrowDown' ? 1 : c.tags.length - 1)) % c.tags.length;
    draw(c);
  } else if (PICK_KEYS.includes(e.key) && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    pick(c, c.tags[c.active][0]);
  } else {
    if (CARET_KEYS.includes(e.key)) setTimeout(() => update(c));
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
}

/**
 * Suggests tags in a task's field as `:tag` is typed in it. Picking one puts `:tag: ` in its place, or, given `chosen`,
 * takes the typed `:tag` out and hands the tag over (the editor's chips).
 * Its keys come before the field's own: while the suggestions show, Enter is theirs.
 * @param {HTMLInputElement} field
 * @param {{ taken: () => string[], chosen?: (tag: string) => void }} options taken: the tags not to suggest
 */
export function tagCompletion(field, { taken, chosen }) {
  /** @type {Completion} */
  const c = { field, taken, chosen, box: null, tags: [], active: 0, start: -1, leaving: false };
  field.addEventListener('input', () => update(c));
  field.addEventListener('click', () => update(c));
  field.addEventListener('keydown', e => onKey(c, e), true);
  field.addEventListener('blur', () => {
    c.leaving = true;
    close(c);
    c.leaving = false;
  });
}
