// Tests for which edge a dragged panel docks on (src/Termilly.Desktop/wwwroot/js/dom.js).
// Run with: node --test tests/js/dockedge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = /** @type {any} */ ({ documentElement: { dataset: {} }, addEventListener() {} });
globalThis.window = /** @type {any} */ ({ addEventListener() {} });
const { edgeAt } = await import('../../src/Termilly.Desktop/wwwroot/js/dom.js');

const area = { left: 100, right: 1100, top: 50, bottom: 650 };

test('near an edge it is that edge, and the nearest in a corner', () => {
  assert.equal(edgeAt(area, 150, 350, 120), 'left');
  assert.equal(edgeAt(area, 1050, 350, 120), 'right');
  assert.equal(edgeAt(area, 600, 80, 120), 'top');
  assert.equal(edgeAt(area, 600, 620, 120), 'bottom');
  assert.equal(edgeAt(area, 110, 130, 120), 'left');
  assert.equal(edgeAt(area, 180, 60, 120), 'top');
});

test('the middle and outside the area are no edge', () => {
  assert.equal(edgeAt(area, 600, 350, 120), null);
  assert.equal(edgeAt(area, 50, 350, 120), null);
  assert.equal(edgeAt(area, 600, 700, 120), null);
});
