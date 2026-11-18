// Tests for the commit graph's lanes (src/Termilly.Desktop/wwwroot/js/gitgraph.js): a straight history, a branch
// that comes back in a merge, two branch tips, and the SVG a row draws.
// Run with: node --test tests/js/gitgraph.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphRows, graphSvg, graphWidth } from '../../src/Termilly.Desktop/wwwroot/js/gitgraph.js';

test('a straight history stays on one lane', () => {
  const rows = graphRows([{ hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }]);
  assert.deepEqual(rows.map(r => r.lane), [0, 0, 0]);
  assert.deepEqual(rows[2].below, []);
});

test('a merge opens a lane for its second parent, which closes where that branch began', () => {
  // m merges f into main: m <- b (main), m <- f (feature) <- a; b <- a.
  const rows = graphRows([
    { hash: 'm', parents: ['b', 'f'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(rows.map(r => r.lane), [0, 1, 0, 0]);
  assert.deepEqual(rows[0].toParents, [0, 1]);
  // Both lanes wait for a; it takes the first, and the second ends there.
  assert.deepEqual(rows[2].below, ['a', 'a']);
  assert.deepEqual(rows[3].above, ['a', 'a']);
});

test('two branch tips get two lanes, and a freed lane is taken again', () => {
  const rows = graphRows([
    { hash: 'x', parents: ['a'] },
    { hash: 'y', parents: ['a'] },
    { hash: 'a', parents: [] },
    { hash: 'z', parents: [] },
  ]);
  assert.deepEqual(rows.map(r => r.lane), [0, 1, 0, 0]);
  assert.equal(graphWidth(rows), 24);
});

test('a row draws lanes passing by, the line into its dot and its lines to its parents', () => {
  const rows = graphRows([{ hash: 'm', parents: ['b', 'f'] }, { hash: 'b', parents: ['a'] }, { hash: 'f', parents: ['a'] }]);
  const svg = graphSvg(rows[1], 'b', graphWidth(rows), 40, true);
  assert.match(svg, /<path class="gw-lane-1" d="M18 0V40"\/>/); // f's lane passes by
  assert.match(svg, /<path class="gw-lane-0" d="M6 0C6 10 6 10 6 20"\/>|<path class="gw-lane-0" d="M6 0V20"\/>/);
  assert.match(svg, /<circle class="gw-lane-0 head"/);
});
