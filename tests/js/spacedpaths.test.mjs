// Tests for paths with spaces in a terminal's output (src/Termilly.Desktop/wwwroot/js/spacedpaths.js).
// Run with: node --test tests/js/spacedpaths.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSpacedPaths } from '../../src/Termilly.Desktop/wwwroot/js/spacedpaths.js';

const texts = line => findSpacedPaths(line).map(p => p.text);

test('a Windows path with spaces runs to its file extension', () => {
  const line = 'Saved to D:\\Development\\termilly-site\\research\\reports\\Terminal competitors from Reddit.md';
  const [found] = findSpacedPaths(line);
  assert.equal(found.text, 'D:\\Development\\termilly-site\\research\\reports\\Terminal competitors from Reddit.md');
  assert.equal(line.slice(found.start, found.end), found.text);
});

test('a sentence\'s full stop or a bracket after the extension is not part of it', () => {
  assert.deepEqual(texts('See C:\\My docs\\plan.md. Then go on.'), ['C:\\My docs\\plan.md']);
  assert.deepEqual(texts('(in C:\\My docs\\plan v2.txt)'), ['C:\\My docs\\plan v2.txt']);
});

test('a quoted path is the whole quoted text, folders too', () => {
  assert.deepEqual(texts('cd "C:\\Program Files\\Termilly"'), ['C:\\Program Files\\Termilly']);
  assert.deepEqual(texts("open '/home/me/My Notes/todo.md' now"), ['/home/me/My Notes/todo.md']);
});

test('a Unix path with spaces runs to its file extension', () => {
  assert.deepEqual(texts('wrote ~/research/reports/Weekly sync notes.md'), ['~/research/reports/Weekly sync notes.md']);
});

test('paths without a space are left to the usual patterns', () => {
  assert.deepEqual(texts('D:\\Development\\termilly\\README.md and /usr/bin/env'), []);
  assert.deepEqual(texts('"C:\\Windows\\notepad.exe"'), []);
});
