// Tests for reprintcopy.js: finding the copy Claude Code's redraw leaves under ConPTY, and the rewrite without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linesOf, staleCopy, withoutCopy, rowAfterCut } from '../../src/Termilly.Desktop/wwwroot/js/reprintcopy.js';

/**
 * A stand-in for xterm's buffer: rows of text, a row starting with '~' continuing the one before (wrapped).
 * @param {string[]} rows
 * @param {{ cursorX?: number, cursorY?: number }} [cursor]
 */
function bufferOf(rows, { cursorX = 0, cursorY = 0 } = {}) {
  const lines = rows.map(r => ({ isWrapped: r.startsWith('~'), translateToString: () => r.replace(/^~/, '') }));
  return { length: lines.length, baseY: lines.length, cursorX, cursorY, getLine: (/** @type {number} */ y) => lines[y] };
}

const REPLY_NARROW = ['● 1. The sea stretches far beyond the', '     horizon, endless and blue.', '  2. Waves roll gently onto the', '     sand, leaving lacy foam.'];
const REPLY_WIDE = ['● 1. The sea stretches far beyond the horizon, endless and blue.', '  2. Waves roll gently onto the sand, leaving lacy foam.', '  3. Seagulls circle above the water.'];
const PROMPT = ['❯ Write about the sea', ''];
/** Every row of the redraw is on the screen. */
const ALL_ON_SCREEN = Infinity;

test('a wrapped line is read as one, without its whitespace', () => {
  const lines = linesOf(bufferOf(['ab cd', '~ef', 'gh']), 0, 3);
  assert.deepEqual(lines, [{ row: 0, rows: 2, text: 'abcdef' }, { row: 2, rows: 1, text: 'gh' }]);
});

test('the copy before the redraw is found from its first line, wrapped at another width', () => {
  const top = PROMPT.length + REPLY_NARROW.length;
  assert.deepEqual(staleCopy(bufferOf([...PROMPT, ...REPLY_NARROW, ...REPLY_WIDE]), top, ALL_ON_SCREEN), { from: PROMPT.length, to: top });
});

test('the blank line before the copy stays', () => {
  const top = 3 + REPLY_NARROW.length;
  assert.deepEqual(staleCopy(bufferOf(['❯ Write about the sea', '', '', ...REPLY_NARROW, ...REPLY_WIDE]), top, ALL_ON_SCREEN), { from: 3, to: top });
});

test('nothing is taken when what comes before is different', () => {
  const rows = [...PROMPT, 'Something else entirely, not the reply at all.', ...REPLY_WIDE];
  assert.equal(staleCopy(bufferOf(rows), PROMPT.length + 1, ALL_ON_SCREEN), null);
});

test('a short line that comes again is real output, not a copy', () => {
  const rows = ['  2. Waves roll gently onto the sand, leaving lacy foam.', ...REPLY_WIDE.slice(1)];
  assert.equal(staleCopy(bufferOf(rows), 1, ALL_ON_SCREEN), null);
});

// The redraw starts in the middle of item 1: its first row is the end of item 1, which is kept whole above the copy.
const KEPT = ['  1. The sea stretches far beyond the horizon, endless and blue.', '  2. Waves roll gently onto the sand, leaving lacy foam on it.', '  3. Seagulls circle above the water, calling as the boats return.'];
const REDRAW = ['     endless and blue.', ...KEPT.slice(1).map(l => l.replace(/, /, ',\n     ').split('\n')).flat(), '  4. The tide comes in.'];

test('the end of a kept line the redraw starts with goes too, when it is above the screen', () => {
  const rows = [...KEPT, ...REDRAW];
  assert.deepEqual(staleCopy(bufferOf(rows), KEPT.length, KEPT.length + 1), { from: 1, to: KEPT.length + 1 });
});

test('the end of a kept line the redraw starts with stays when it is on the screen', () => {
  const rows = [...KEPT, ...REDRAW];
  assert.deepEqual(staleCopy(bufferOf(rows), KEPT.length, KEPT.length), { from: 1, to: KEPT.length });
});

test('the rewrite keeps what came before, the redraw and the cursor, without the copy', () => {
  const rows = [...PROMPT, ...REPLY_NARROW, ...REPLY_WIDE];
  const top = PROMPT.length + REPLY_NARROW.length;
  const buffer = bufferOf(rows, { cursorX: 4, cursorY: 1 });
  const output = (/** @type {any} */ _, /** @type {number} */ from, /** @type {number} */ to) => rows.slice(from, to).join('|');
  const text = withoutCopy(buffer, 3, { from: PROMPT.length, to: top }, output);
  assert.ok(text);
  // The cursor is saved first and restored last (its column, its text style), its row set on the screen; the erase
  // comes after plain attributes, so it doesn't paint the background in use.
  assert.ok(text.startsWith('\x1b7\x1b[0m\x1b[3J\x1b[H\x1b[2J'));
  assert.ok(text.endsWith('\x1b8\x1b[2d'));
  assert.ok(text.includes('❯ Write about the sea'));
  assert.equal(text.split('The sea stretches').length - 1, 1);
  // Each kept line takes its own rows: two before the redraw, three of the redraw.
  assert.equal(text.split('\r\n').length, PROMPT.length + REPLY_WIDE.length);
});

test('no rewrite when too little would be left to fill the screen', () => {
  const rows = [...PROMPT, ...REPLY_NARROW, ...REPLY_WIDE];
  const copy = { from: PROMPT.length, to: PROMPT.length + REPLY_NARROW.length };
  assert.equal(withoutCopy(bufferOf(rows), 40, copy, () => ''), null);
});

test('no rewrite when the copy reaches into the screen, which is the program\'s', () => {
  const rows = [...PROMPT, ...REPLY_NARROW, ...REPLY_WIDE];
  const buffer = { ...bufferOf(rows), baseY: PROMPT.length + 1 };
  assert.equal(withoutCopy(buffer, 3, { from: PROMPT.length, to: PROMPT.length + REPLY_NARROW.length }, () => ''), null);
});

test('a view scrolled up stays on what it showed once the copy is gone', () => {
  const copy = { from: 10, to: 40 };
  assert.equal(rowAfterCut(3, copy), 3);
  assert.equal(rowAfterCut(25, copy), 10);
  assert.equal(rowAfterCut(50, copy), 20);
});
