// Tests for the compact view's drawer (src/Termilly.Desktop/wwwroot/js/compactdrawer.js): whether a drawer left open
// still shows the agent's input line, or only rows a closed prompt of its own left blank.
// Run with: node --test tests/js/compactdrawer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough of a page for the modules to load (ui.js loads host.js).
globalThis.window = /** @type {any} */ ({ addEventListener() {}, external: { receiveMessage() {}, sendMessage() {} } });
globalThis.document = /** @type {any} */ ({ documentElement: { dataset: {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
globalThis.localStorage = /** @type {any} */ ({ getItem: () => null, setItem() {} });
globalThis.addEventListener = () => {};
const { drawerHolds } = await import('../../src/Termilly.Desktop/wwwroot/js/compactdrawer.js');

/**
 * A terminal showing these rows, with no scrollback, and its cursor on a row.
 * @param {string[]} rows
 * @param {number} cursorY
 */
const termOf = (rows, cursorY) => ({
  buffer: { active: { baseY: 0, length: rows.length, cursorY, getLine: (/** @type {number} */ y) => ({ translateToString: () => rows[y] }) } },
});

const RULE = '─'.repeat(40);

test('the input line still in the drawer keeps it', () => {
  const term = termOf(['● Done.', '', RULE, '> fix the tests', RULE, '  ? for shortcuts'], 3);
  assert.equal(drawerHolds(term, 2), true);
});

test('a rating prompt answered: the input line moved up out of the drawer, which closes', () => {
  const term = termOf(['● Done.', '', RULE, '> ', RULE, '', '', ''], 3);
  assert.equal(drawerHolds(term, 5), false);
});

test('only blank rows left in the drawer close it, wherever the cursor is', () => {
  const term = termOf(['● Done.', RULE, '> ', RULE, '', '', ''], 6);
  assert.equal(drawerHolds(term, 4), false);
});

test('no drawer row: nothing to hold', () => {
  assert.equal(drawerHolds(termOf(['> '], 0), -1), false);
});
