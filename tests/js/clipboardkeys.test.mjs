// Tests for clipboardAction (src/Termilly.Desktop/wwwroot/js/clipboardkeys.js): which keys copy, paste, or stay the shell's.
// Run with: node --test tests/js/clipboardkeys.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardAction, CLIPBOARD_ACTION } from '../../src/Termilly.Desktop/wwwroot/js/clipboardkeys.js';

const key = (code, mods = {}, name = '') => ({ code, key: name, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
const ctrl = { ctrlKey: true };
const ctrlShift = { ctrlKey: true, shiftKey: true };

test('Ctrl+C copies a selection, and is the shell\'s ^C without one', () => {
  assert.equal(clipboardAction(key('KeyC', ctrl), true), CLIPBOARD_ACTION.copy);
  assert.equal(clipboardAction(key('KeyC', ctrl), false), null);
});

test('Ctrl+Shift+C and Ctrl+Insert copy', () => {
  assert.equal(clipboardAction(key('KeyC', ctrlShift), false), CLIPBOARD_ACTION.copy);
  assert.equal(clipboardAction(key('Insert', ctrl, 'Insert'), true), CLIPBOARD_ACTION.copy);
});

test('Ctrl+V, Ctrl+Shift+V and Shift+Insert paste', () => {
  assert.equal(clipboardAction(key('KeyV', ctrl), false), CLIPBOARD_ACTION.paste);
  assert.equal(clipboardAction(key('KeyV', ctrlShift), true), CLIPBOARD_ACTION.paste);
  assert.equal(clipboardAction(key('Insert', { shiftKey: true }, 'Insert'), false), CLIPBOARD_ACTION.paste);
});

test('AltGr (Ctrl+Alt), Alt and plain letters stay the shell\'s', () => {
  assert.equal(clipboardAction(key('KeyC', { ctrlKey: true, altKey: true }), true), null);
  assert.equal(clipboardAction(key('KeyV', { altKey: true }), false), null);
  assert.equal(clipboardAction(key('KeyC'), true), null);
  assert.equal(clipboardAction(key('KeyX', ctrl), true), null);
});
