// Tests for keyboard selection (src/Termilly.Desktop/wwwroot/js/keyselect.js): which keys select, and where a step goes.
// Run with: node --test tests/js/keyselect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectStep, moveSelectionEnd } from '../../src/Termilly.Desktop/wwwroot/js/keyselect.js';

const key = (name, mods = {}) => ({ key: name, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
/** A buffer of `text`, one character per cell; '_' stands for the second half of a wide character. */
const cells = text => pos => (text[pos] === '_' ? null : text[pos] === ' ' ? '' : text[pos] ?? '');

test('Shift+arrows select by character, Ctrl+Shift+arrows by word', () => {
  assert.deepEqual(selectStep(key('ArrowLeft', { shiftKey: true })), { dir: -1, word: false });
  assert.deepEqual(selectStep(key('ArrowRight', { shiftKey: true, ctrlKey: true })), { dir: 1, word: true });
});

test('Arrows without Shift, Alt+Shift and other keys stay the shell\'s', () => {
  assert.equal(selectStep(key('ArrowLeft')), null);
  assert.equal(selectStep(key('ArrowLeft', { ctrlKey: true })), null);
  assert.equal(selectStep(key('ArrowRight', { shiftKey: true, altKey: true })), null);
  assert.equal(selectStep(key('ArrowUp', { shiftKey: true })), null);
});

test('A character step moves one cell and stops at the buffer\'s ends', () => {
  const text = 'abc';
  assert.equal(moveSelectionEnd(1, { dir: 1, word: false }, cells(text), 3), 2);
  assert.equal(moveSelectionEnd(0, { dir: -1, word: false }, cells(text), 3), 0);
  assert.equal(moveSelectionEnd(3, { dir: 1, word: false }, cells(text), 3), 3);
});

test('A wide character is one character step', () => {
  const text = 'aW_b';
  assert.equal(moveSelectionEnd(1, { dir: 1, word: false }, cells(text), 4), 3);
  assert.equal(moveSelectionEnd(3, { dir: -1, word: false }, cells(text), 4), 1);
});

test('A word step right goes to the next word\'s start, left to the word\'s start', () => {
  const text = 'git commit -m "fix"';
  assert.equal(moveSelectionEnd(0, { dir: 1, word: true }, cells(text), text.length), 4);
  assert.equal(moveSelectionEnd(5, { dir: 1, word: true }, cells(text), text.length), 11);
  assert.equal(moveSelectionEnd(10, { dir: -1, word: true }, cells(text), text.length), 4);
  assert.equal(moveSelectionEnd(4, { dir: -1, word: true }, cells(text), text.length), 0);
  assert.equal(moveSelectionEnd(text.length, { dir: -1, word: true }, cells(text), text.length), 15);
});
