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
const { drawerHolds, liveRow, typedPrompt } = await import('../../src/Termilly.Desktop/wwwroot/js/compactdrawer.js');

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

test("a list of the agent's own opens the drawer as a list, so it closes once the list goes", () => {
  const rows = ['● Done.', '', ' Select model', '', ' ❯ 1. Default', '   2. Opus', '   3. Haiku', '', ' Enter to confirm · Esc to exit'];
  const found = liveRow(/** @type {any} */ ({ view: { term: termOf(rows, 8) }, agent: { state: 'idle' } }));
  assert.equal(found.menu, true);
  assert.ok(found.row >= 0 && found.row <= 4);
});

test('words typed in the input line open the drawer, not as a list', () => {
  const term = termOf(['● Done.', RULE, '> fix the tests', RULE], 2);
  term.buffer.active.cursorX = 10;
  assert.deepEqual(liveRow(/** @type {any} */ ({ view: { term }, agent: { state: 'idle' } })), { row: 1, menu: false });
});

/**
 * A terminal of 60 columns showing these rows, its cursor at a column of a row.
 * @param {string[]} rows
 * @param {number} cursorY
 * @param {number} cursorX
 */
const typedTerm = (rows, cursorY, cursorX) => {
  const term = /** @type {any} */ ({ cols: 60, ...termOf(rows, cursorY) });
  term.buffer.active.cursorX = cursorX;
  return term;
};

const CLAUDE_FOOTER = ['  Opus 5.5', '  ⏵⏵ auto mode on (shift+tab to cycle)'];
const CODEX_FOOTER = ['', '  GPT-6.2-Sol default · /tmp', '  ← for agents · ? for shortcuts'];

test("Claude Code's unsent prompt: wrapped rows run on, a new line stays one, and its keys clear it", () => {
  const rows = [' ▐▛███▛█   Claude Code', '', RULE, '❯ hello world this is a long prompt that will surely wrap',
    '  onto the next row of the box', '  second line here', RULE, ...CLAUDE_FOOTER];
  const typed = typedPrompt(typedTerm(rows, 5, 18));
  const text = 'hello world this is a long prompt that will surely wrap onto the next row of the box\nsecond line here';
  assert.equal(typed?.text, text);
  const keys = text.length;
  assert.equal(typed?.clear, '\x1b[3~'.repeat(keys) + '\x7f'.repeat(keys));
});

test("Codex's unsent prompt, blank lines in it kept and the ones after it left out", () => {
  const rows = ['  >_ OpenAI Codex', '', '', '› aa', '', '  bb', '', '', ...CODEX_FOOTER];
  assert.equal(typedPrompt(typedTerm(rows, 7, 2))?.text, 'aa\n\nbb');
});

test("an empty input line's hint is no prompt", () => {
  assert.equal(typedPrompt(typedTerm(['', RULE, '❯ Try "fix lint errors"', RULE, ...CLAUDE_FOOTER], 2, 2)), null);
  assert.equal(typedPrompt(typedTerm(['', '', '› Ask Codex to do anything', ...CODEX_FOOTER], 2, 2)), null);
});

test('a paste or a picture the agent shows folded up stays where it is', () => {
  assert.equal(typedPrompt(typedTerm(['', RULE, '❯ look at [Pasted text #1 +20 lines]', RULE], 2, 37)), null);
  assert.equal(typedPrompt(typedTerm(['', RULE, '❯ [Image #1] what is this', RULE], 2, 25)), null);
});

test('an input line whose top is off the screen stays where it is', () => {
  assert.equal(typedPrompt(typedTerm(['  more of it', '  and the end', RULE, ...CLAUDE_FOOTER], 1, 13)), null);
});

test('a word too long for a row runs on with no space', () => {
  const long = `❯ ${'a'.repeat(58)}`;
  assert.equal(typedPrompt(typedTerm(['', RULE, long, '  bcd', RULE], 3, 5))?.text, `${'a'.repeat(58)}bcd`);
});

test('a line of ─ typed in the prompt is part of it, not the rule under it', () => {
  const rows = ['', RULE, '❯ above', '  ───', '  below', RULE, ...CLAUDE_FOOTER];
  assert.equal(typedPrompt(typedTerm(rows, 2, 7))?.text, 'above\n───\nbelow');
});

test('spaces typed at the start of the prompt are kept', () => {
  assert.equal(typedPrompt(typedTerm(['', RULE, '❯   indented', RULE], 2, 12))?.text, '  indented');
});
