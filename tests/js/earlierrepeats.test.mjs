// Tests for leaving out what a program draws again (src/Termilly.Desktop/wwwroot/js/earlierrepeats.js).
// Run with: node --test tests/js/earlierrepeats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaveOutRepeats } from '../../src/Termilly.Desktop/wwwroot/js/earlierrepeats.js';

const sentence = i => `Paragraph ${i}: the research web server runs at http://192.168.0.108:8790/ and serves every report and mockup.`;
const paragraphs = Array.from({ length: 12 }, (_, i) => sentence(i));

/** The text wrapped at a width, as a terminal of that size shows it. */
const wrapped = (texts, width) => texts.flatMap(t => {
  const rows = [];
  let row = '';
  for (const word of t.split(' ')) {
    if (row && row.length + 1 + word.length > width) {
      rows.push(row);
      row = word;
    } else row = row ? `${row} ${word}` : word;
  }
  return [...rows, row, ''];
});

test('what is kept the first time is kept whole', () => {
  const lines = wrapped(paragraphs, 120);
  assert.deepEqual(leaveOutRepeats(lines, new Set()), lines);
});

test('a redraw at another width is left out, and what is new after it stays', () => {
  const pieces = new Set();
  leaveOutRepeats(wrapped(paragraphs, 120), pieces);
  const redraw = [...wrapped(paragraphs, 60), 'A new line Claude wrote after the redraw, about something else entirely.'];
  assert.deepEqual(leaveOutRepeats(redraw, pieces), ['A new line Claude wrote after the redraw, about something else entirely.']);
});

test('a short line that comes again is real output and stays', () => {
  const pieces = new Set();
  leaveOutRepeats(['PASS  tests/api.test.js (2.1 s)', 'Tests: 12 passed, 12 total'], pieces);
  const again = ['$ npm test', 'PASS  tests/api.test.js (2.1 s)', 'Tests: 12 passed, 12 total'];
  assert.deepEqual(leaveOutRepeats(again, pieces), again);
});
