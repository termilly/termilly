// Tests for rowtext.js: a line written out again, every cell as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOutput } from '../../src/Termilly.Desktop/wwwroot/js/rowtext.js';

/**
 * A stand-in for xterm's cells: a character ('' for a cell nothing was written in), its width, and its style.
 * @typedef {{ ch: string, width?: number, bold?: boolean, fgMode?: number, fg?: number, bgMode?: number, bg?: number }} Cell
 */
/** How xterm's cells say how a colour was given. */
const BASIC = 0x1000000, PALETTE = 0x2000000, RGB = 0x3000000;
const STYLE_METHODS = ['isDim', 'isItalic', 'isUnderline', 'isBlink', 'isInverse', 'isInvisible', 'isStrikethrough', 'isOverline'];

/** @param {Cell[][]} rows each row's cells, as many as the terminal is wide */
function bufferOf(rows) {
  /** @type {any} */
  const cell = { c: { ch: '' } };
  for (const m of STYLE_METHODS) cell[m] = () => false;
  Object.assign(cell, {
    getChars() { return this.c.ch; },
    getWidth() { return this.c.width ?? 1; },
    isBold() { return !!this.c.bold; },
    getFgColorMode() { return this.c.fgMode ?? 0; },
    getFgColor() { return this.c.fg ?? -1; },
    getBgColorMode() { return this.c.bgMode ?? 0; },
    getBgColor() { return this.c.bg ?? -1; },
    isAttributeDefault() { return !this.c.bold && !this.c.fgMode && !this.c.bgMode; },
  });
  const lines = rows.map(r => ({ length: r.length, getCell: (/** @type {number} */ x, /** @type {any} */ into) => { into.c = r[x]; return into; } }));
  return { getNullCell: () => cell, getLine: (/** @type {number} */ y) => lines[y] };
}

/** @param {string} text @param {number} width */
const plain = (text, width) => [...text.padEnd(width, '\0')].map(ch => ({ ch: ch === '\0' ? '' : ch }));
/** Takes the SGR sequences out, to read the characters alone. @param {string} s */
const charsOf = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('a cell nothing was written in goes out as a space, so a wrapped line keeps its first letters', () => {
  // ConPTY skips spaces by moving the cursor: the wrapped row starts with an empty cell, not a space.
  const out = lineOutput(bufferOf([plain('a pale morning', 14), [{ ch: '' }, ...plain('sky.', 13)]]), 0, 2);
  assert.equal(charsOf(out), 'a pale morning sky.');
});

test('every row but the last fills the width, so writing it wraps as the line did', () => {
  const out = lineOutput(bufferOf([plain('short', 10), plain('end', 10)]), 0, 2);
  assert.equal(charsOf(out), 'short     end');
});

test('the last row ends at its last character, or its last coloured cell', () => {
  assert.equal(charsOf(lineOutput(bufferOf([plain('done', 10)]), 0, 1)), 'done');
  const coloured = [...plain('ok', 4), { ch: '', bgMode: BASIC, bg: 1 }, ...plain('', 3)];
  assert.equal(charsOf(lineOutput(bufferOf([coloured]), 0, 1)), 'ok   ');
});

test('a wrapped line whose last row is blank still takes that row', () => {
  const out = lineOutput(bufferOf([plain('full', 4), plain('', 4)]), 0, 2);
  assert.equal(charsOf(out), 'full ');
});

test('styles and colours go out where they change, and the line ends plain', () => {
  const row = [{ ch: 'a', bold: true, fgMode: BASIC, fg: 1 }, { ch: 'b', bold: true, fgMode: BASIC, fg: 1 }, { ch: 'c', fgMode: RGB, fg: 0x10ff20 }];
  const out = lineOutput(bufferOf([row]), 0, 1);
  assert.equal(out, '\x1b[0;1;31mab\x1b[0;38;2;16;255;32mc\x1b[0m');
});

test('a colour comes back given as it was: basic, bright, one of the 256, or a background', () => {
  // Bold brightens only the basic colours, so 31 and 38;5;1 look different and must stay apart.
  const row = [{ ch: 'a', fgMode: BASIC, fg: 9 }, { ch: 'b', fgMode: PALETTE, fg: 1 }, { ch: 'c', bgMode: BASIC, bg: 2 }, { ch: 'd', bgMode: PALETTE, bg: 200 }];
  const out = lineOutput(bufferOf([row]), 0, 1);
  assert.equal(out, '\x1b[0;91ma\x1b[0;38;5;1mb\x1b[0;42mc\x1b[0;48;5;200md\x1b[0m');
});

test('a wide character is written once', () => {
  const out = lineOutput(bufferOf([[{ ch: '界', width: 2 }, { ch: '', width: 0 }, { ch: 'x' }]]), 0, 1);
  assert.equal(charsOf(out), '界x');
});
