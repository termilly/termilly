// @ts-check
// Selecting a terminal's text from the keyboard: Shift+Left/Right a character at a time, Ctrl+Shift+Left/Right a word,
// starting at the cursor (or growing a selection made with the mouse). Ctrl+C then copies it (clipboardkeys.js).
// Full-screen programs (vim, less, htop) keep the keys. No imports, so the tests can load it on its own.

/** xterm's own word separators, for when its option isn't set. */
const WORD_SEPARATORS = ' ()[]{}\',"`';
const KEY = Object.freeze({ left: 'ArrowLeft', right: 'ArrowRight' });
/** xterm's name for the buffer full-screen programs draw in. */
const ALTERNATE_BUFFER = 'alternate';

/**
 * @typedef {{ key: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey?: boolean }} KeyLike
 * @typedef {{ dir: -1 | 1, word: boolean }} SelectStep
 */

/**
 * The step a key moves a keyboard selection's end by, or null when the key isn't one of them.
 * @param {KeyLike} e
 * @returns {SelectStep | null}
 */
export function selectStep(e) {
  if (!e.shiftKey || e.altKey || e.metaKey) return null;
  if (e.key !== KEY.left && e.key !== KEY.right) return null;
  return { dir: e.key === KEY.left ? -1 : 1, word: e.ctrlKey };
}

/**
 * Where a selection's end goes from `pos`, a cell counted from the buffer's start (row * cols + column).
 * A word step goes to the next word's start (right) or the word's start (left), as in a text box.
 * @param {number} pos
 * @param {SelectStep} step
 * @param {(pos: number) => string | null} charAt the cell's character, '' when empty, null for the second half of a wide one
 * @param {number} end the count of cells
 * @param {string} [separators]
 */
export function moveSelectionEnd(pos, { dir, word }, charAt, end, separators = WORD_SEPARATORS) {
  const inBuffer = (/** @type {number} */ i) => Math.min(Math.max(i, 0), end);
  if (!word) {
    let next = inBuffer(pos + dir);
    // A wide character is one step: the end never sits on its second half.
    while (next > 0 && next < end && charAt(next) === null) next = inBuffer(next + dir);
    return next;
  }
  const isWord = (/** @type {number} */ i) => {
    const ch = charAt(i);
    return ch === null || (ch !== '' && !separators.includes(ch));
  };
  let i = pos;
  if (dir > 0) {
    while (i < end && isWord(i)) i++;
    while (i < end && !isWord(i)) i++;
  } else {
    while (i > 0 && !isWord(i - 1)) i--;
    while (i > 0 && isWord(i - 1)) i--;
  }
  return i;
}

/** @type {WeakMap<object, { anchor: number, focus: number }>} the keyboard selection's fixed and moving ends */
const selections = new WeakMap();

/**
 * xterm's key hook for selecting with the keyboard: false when the key moved the selection, so it doesn't reach the shell.
 * @param {any} term xterm
 * @param {KeyboardEvent} e
 */
export function selectionKey(term, e) {
  const step = selectStep(e);
  if (!step) return true;
  const buffer = term.buffer.active;
  if (buffer.type === ALTERNATE_BUFFER) return true;
  if (e.type !== 'keydown') return false;
  e.preventDefault();

  const cols = term.cols;
  const at = (/** @type {number} */ x, /** @type {number} */ y) => y * cols + x;
  let anchor;
  let focus;
  const sel = term.hasSelection() ? term.getSelectionPosition() : undefined;
  const mine = selections.get(term);
  if (sel) {
    const start = at(sel.start.x, sel.start.y);
    const stop = at(sel.end.x, sel.end.y);
    // Still the one these keys made: carry on from its moving end. Otherwise (the mouse's) grow it from its end.
    if (mine && Math.min(mine.anchor, mine.focus) === start && Math.max(mine.anchor, mine.focus) === stop) ({ anchor, focus } = mine);
    else [anchor, focus] = [start, stop];
  } else {
    anchor = focus = at(buffer.cursorX, buffer.baseY + buffer.cursorY);
  }

  const charAt = (/** @type {number} */ pos) => {
    const cell = buffer.getLine(Math.floor(pos / cols))?.getCell(pos % cols);
    if (!cell) return '';
    return cell.getWidth() === 0 ? null : cell.getChars();
  };
  focus = moveSelectionEnd(focus, step, charAt, buffer.length * cols, term.options.wordSeparator ?? WORD_SEPARATORS);
  selections.set(term, { anchor, focus });
  if (focus === anchor) {
    term.clearSelection();
    return false;
  }
  const from = Math.min(anchor, focus);
  term.select(from % cols, Math.floor(from / cols), Math.abs(focus - anchor));
  // Keep the moving end in view.
  const row = Math.floor(focus / cols);
  if (row < buffer.viewportY) term.scrollToLine(row);
  else if (row >= buffer.viewportY + term.rows) term.scrollToLine(row - term.rows + 1);
  return false;
}
