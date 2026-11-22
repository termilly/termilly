// Tests for the keys the compact view follows in an agent's terminal (src/Termilly.Desktop/wwwroot/js/compacttyped.js):
// what they spell since the last Enter, and when the screen's text is used instead.
// Run with: node --test tests/js/compacttyped.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followKeys, exactText, forgetDraft } from '../../src/Termilly.Desktop/wwwroot/js/compacttyped.js';

/** A terminal that types what it's given, as keys pressed in it; its clock says what `at` holds. */
function keyed() {
  /** @type {(data: string) => void} */
  let listener = () => {};
  const at = { now: 0 };
  const keys = followKeys({ onData: (/** @type {(data: string) => void} */ fn) => { listener = fn; return { dispose() {} }; } }, () => at.now);
  /** @param {string[]} pressed */
  const press = (...pressed) => pressed.forEach(data => listener(data));
  return { keys, press, at };
}

test('keys spell the draft: letters, a new line, a backspace and a paste with its line ends', () => {
  const { keys, press } = keyed();
  press('f', 'i', 'x', '\x1b\r', 'a', 'b', '\x7f', '\x1b[200~one\r\ntwo\x1b[201~', ' ');
  assert.equal(keys.draft, 'fix\naone\ntwo ');
});

test('Enter sends the draft: it empties and says when', () => {
  const { keys, press, at } = keyed();
  press('h', 'i');
  at.now = 42;
  press('\r');
  assert.equal(keys.draft, '');
  assert.equal(keys.enteredAt, 42);
});

test('an arrow, Esc or Tab makes the draft unknown until the next Enter', () => {
  for (const key of ['\x1b[D', '\x1b', '\t']) {
    const { keys, press } = keyed();
    press('a', key, 'b');
    assert.equal(keys.draft, null, JSON.stringify(key));
    press('\r', 'c');
    assert.equal(keys.draft, 'c');
  }
});

test("the keys' text is taken only where the screen shows the same but for whitespace", () => {
  const { keys, press } = keyed();
  press('a', 'b', '\n', 'c');
  assert.equal(exactText(keys, 'ab c'), 'ab\nc');
  assert.equal(exactText(keys, 'ab cd'), 'ab cd');
  forgetDraft(keys);
  assert.equal(exactText(keys, 'ab c'), 'ab c');
  assert.equal(exactText(undefined, 'x'), 'x');
});
