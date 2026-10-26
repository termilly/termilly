// Tests for findWebLinks (src/Termilly.Desktop/wwwroot/js/webaddress.js): which web addresses in terminal text are links.
// Run with: node --test tests/js/webaddress.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findWebLinks } from '../../src/Termilly.Desktop/wwwroot/js/webaddress.js';

const texts = line => findWebLinks(line).map(l => l.text);

test('http and https addresses are found, with their place in the line', () => {
  const [link] = findWebLinks('Open http://localhost:8791/docs/#actions now');
  assert.deepEqual(link, { start: 5, end: 40, text: 'http://localhost:8791/docs/#actions' });
  assert.deepEqual(texts('a https://termilly.com and http://x.io/a?b=1&c=2'), ['https://termilly.com', 'http://x.io/a?b=1&c=2']);
});

test('what a sentence adds after an address is not part of it', () => {
  assert.deepEqual(texts('See https://termilly.com/docs/.'), ['https://termilly.com/docs/']);
  assert.deepEqual(texts('(see https://a.io/b) and "https://c.io/d",'), ['https://a.io/b', 'https://c.io/d']);
  assert.deepEqual(texts('at https://a.io/x: done'), ['https://a.io/x']);
});

test('a bracket the address opened itself stays', () => {
  assert.deepEqual(texts('https://en.wikipedia.org/wiki/Shell_(computing).'), ['https://en.wikipedia.org/wiki/Shell_(computing)']);
});

test('only real addresses: a scheme and a host', () => {
  assert.deepEqual(texts('http:// alone, ftp://a.io/b, file:///c/d, www.example.com'), []);
});
