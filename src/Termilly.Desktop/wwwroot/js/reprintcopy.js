// @ts-check
// Finding the copy a program's redraw left behind, and the rewrite that takes it out (reprint.js does the when).
// The copy was drawn at the old width and xterm may have wrapped it again, so lines are compared without their
// whitespace, as earlier.js compares a redraw with what it kept.

/**
 * Less than this many characters repeated isn't taken for a copy: a line or two can come again for real. What's cut
 * is always on screen again right after, in the redraw.
 */
const MIN_CHARS = 80;
/** How far back from the redraw a copy is looked for, in rows. */
const LOOKBACK_ROWS = 1000;
/**
 * Save the cursor (DECSC: its column and the text style in use, which the program goes on writing with), plain
 * attributes (an erase fills with the background in use), erase the scrollback, go to the top left, erase the screen.
 * Under ConPTY a program's own DECSC stays in the pseudo console, so the terminal's saved cursor is free to use.
 */
const WIPE = '\x1b7\x1b[0m\x1b[3J\x1b[H\x1b[2J';
/**
 * Restore what WIPE saved (DECRC), then the cursor's row on the screen (VPA): xterm saved it as a row of the whole
 * buffer, and the rows before it are fewer now.
 * @param {number} screenRow
 */
const restore = screenRow => `\x1b8\x1b[${screenRow + 1}d`;
const NEXT_ROW = '\r\n';

/**
 * The lines of rows [from, to), a wrapped line read as one (never past `to`): the row it starts on, how many rows it
 * takes, and its text without whitespace.
 * @param {any} buffer xterm's buffer
 * @param {number} from
 * @param {number} to
 * @returns {{ row: number, rows: number, text: string }[]}
 */
export function linesOf(buffer, from, to) {
  const out = [];
  let y = from;
  while (y < to) {
    const row = y;
    let text = buffer.getLine(y)?.translateToString(true) ?? '';
    y++;
    while (y < to && buffer.getLine(y)?.isWrapped) text += buffer.getLine(y++)?.translateToString(true) ?? '';
    out.push({ row, rows: y - row, text: text.replace(/\s+/g, '') });
  }
  return out;
}

/**
 * The rows the redraw made a copy of, [from, to): from the earliest line before `top` (the row the redraw started on)
 * from which everything up to `top` is what the redraw drew at its start. The redraw's top row can be the middle of a
 * paragraph, so its first line can be the end of the line kept just above the copy: that bit goes too, while it's
 * above the screen (`screenTop`), where the program draws no more. Null when there's no copy.
 * @param {any} buffer
 * @param {number} top
 * @param {number} screenTop
 * @returns {{ from: number, to: number } | null}
 */
export function staleCopy(buffer, top, screenTop) {
  const fresh = linesOf(buffer, top, buffer.length);
  const drawn = fresh.map(l => l.text).join('');
  const firstLength = fresh.find(l => l.text)?.text.length ?? 0;
  const before = linesOf(buffer, Math.max(0, top - LOOKBACK_ROWS), top);
  let tail = '';
  let found = null;
  for (let i = before.length - 1; i >= 0; i--) {
    // A blank line adds nothing to compare: it stays (the gap before the copy) and isn't counted in.
    if (!before[i].text) continue;
    tail = before[i].text + tail;
    if (tail.length < MIN_CHARS) continue;
    const at = drawn.indexOf(tail);
    if (at < 0) break; // no longer in the redraw: nothing further back can be
    if (at <= firstLength) found = { i, at };
  }
  if (!found) return null;
  const kept = before.slice(0, found.i).findLast(l => l.text);
  return { from: before[found.i].row, to: top + fragmentRows(fresh, found.at, kept?.text ?? '', screenTop - top) };
}

/**
 * How many of the redraw's first rows are the end of the line kept above the copy, when they're above the screen.
 * @param {{ row: number, rows: number, text: string }[]} fresh
 * @param {number} length how much of the redraw's text comes before the copy
 * @param {string} kept the text of the line kept just above the copy
 * @param {number} aboveScreen how many of the redraw's rows are above the screen
 */
function fragmentRows(fresh, length, kept, aboveScreen) {
  if (!length) return 0;
  let text = '';
  let rows = 0;
  for (const line of fresh) {
    if (text.length >= length) break;
    text += line.text;
    rows += line.rows;
  }
  return text.length === length && kept.endsWith(text) && rows <= aboveScreen ? rows : 0;
}

/**
 * Draws one line, rows [from, to) of the buffer (rowtext.js's lineOutput).
 * @typedef {(buffer: any, from: number, to: number) => string} LineOutput
 */

/**
 * Rows [from, to) written out again, a line at a time, each on rows of its own.
 * @param {any} buffer
 * @param {LineOutput} output
 * @param {number} from
 * @param {number} to
 */
function rowsText(buffer, output, from, to) {
  return linesOf(buffer, from, to).map(l => output(buffer, l.row, l.row + l.rows)).join(NEXT_ROW);
}

/**
 * What to write so the terminal holds everything but rows [from, to), with the screen and the cursor as they are: the
 * screen keeps the rows the program draws on, so it goes on drawing in the right places. Null when too little would
 * be left to fill the screen.
 * @param {any} buffer
 * @param {number} screenRows
 * @param {{ from: number, to: number }} copy
 * @param {LineOutput} output
 */
export function withoutCopy(buffer, screenRows, { from, to }, output) {
  const end = buffer.length;
  // Only rows above the screen go: the screen is the program's, row for row.
  if (from < 0 || from >= to || to > buffer.baseY || from + (end - to) < screenRows) return null;
  const head = from > 0 ? rowsText(buffer, output, 0, from) + NEXT_ROW : '';
  return WIPE + head + rowsText(buffer, output, to, end) + restore(buffer.cursorY);
}

/**
 * Where a view scrolled up to `row` goes once the copy's rows [from, to) are gone: the same row when it's above them,
 * the first row after them when it was in them, and moved up with the rest when below.
 * @param {number} row
 * @param {{ from: number, to: number }} copy
 */
export function rowAfterCut(row, { from, to }) {
  if (row < from) return row;
  return row < to ? from : row - (to - from);
}
