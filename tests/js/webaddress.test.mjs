// Tests for findWebLinks (src/Termilly.Desktop/wwwroot/js/webaddress.js): which web addresses in terminal text are links.
// Run with: node --test tests/js/webaddress.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findWebLinks, cleanWebAddress, webAddressAlone } from '../../src/Termilly.Desktop/wwwroot/js/webaddress.js';

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

test('Markdown around an address is not part of it (#77)', () => {
  const link = 'http://192.168.0.108:8790/mockups/git-github/';
  for (const line of [`**${link}**`, `*${link}*`, `***${link}***`, `~~${link}~~`, `_${link}_`, `__${link}__`,
    `**${link}**.`, `(**${link}**)`, `See **${link}**, then`, `**See ${link}**`, `_see ${link}_`, `[**${link}**]`]) {
    assert.deepEqual(texts(line), [link], line);
  }
  const [bold] = findWebLinks(`**${link}**`);
  assert.deepEqual([bold.start, bold.end], [2, 2 + link.length]);
});

test('markers inside an address, and an underscore no italic opened, stay', () => {
  assert.deepEqual(texts('https://a.io/a*b/c_d/~user/x~y'), ['https://a.io/a*b/c_d/~user/x~y']);
  assert.deepEqual(texts('https://a.io/snake_case_'), ['https://a.io/snake_case_']);
  assert.deepEqual(texts('https://en.wikipedia.org/wiki/Shell_(computing)**'), ['https://en.wikipedia.org/wiki/Shell_(computing)']);
  assert.deepEqual(texts('xhttps://a.io/b'), []);
});

test('a marked link is cleaned the same way', () => {
  assert.equal(cleanWebAddress('https://a.io/b/**'), 'https://a.io/b/');
  assert.equal(cleanWebAddress('https://a.io/b_'), 'https://a.io/b_');
  assert.equal(cleanWebAddress('https://a.io/b_', '_'), 'https://a.io/b');
});

test('a selection that is one address, maybe in Markdown or a sentence end, is that address', () => {
  assert.equal(webAddressAlone(' **https://a.io/b/**. '), 'https://a.io/b/');
  assert.equal(webAddressAlone('"https://a.io/b"'), 'https://a.io/b');
  assert.equal(webAddressAlone('https://a.io/b'), 'https://a.io/b');
  assert.equal(webAddressAlone('see https://a.io/b'), null);
  assert.equal(webAddressAlone('https://a.io/b https://c.io/d'), null);
  assert.equal(webAddressAlone('not an address'), null);
});
