// Tests for snippetmatch.js (src/Termilly.Desktop/wwwroot/js/snippetmatch.js): when `snippet:` has started, and which
// snippets match the name typed after it. Run with: node --test tests/js/snippetmatch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startsPrefix, hasPrefix, matchSnippets } from '../../src/Termilly.Desktop/wwwroot/js/snippetmatch.js';

test('the start of snippet: can still become it, anything else can\'t', () => {
  for (const typed of ['s', 'sn', 'snip', 'snippet', 'snippet:', 'SNIP']) assert.ok(startsPrefix(typed), typed);
  for (const typed of ['', 'ss', 'sl', 'set', 'snippets', 'x']) assert.ok(!startsPrefix(typed), typed);
});

test('the whole prefix, with or without a name after it', () => {
  assert.ok(hasPrefix('snippet:'));
  assert.ok(hasPrefix('Snippet:deploy'));
  assert.ok(!hasPrefix('snippet'));
  assert.ok(!hasPrefix('ssh'));
});

const snippets = [{ name: 'deploy-staging' }, { name: 'grep-logs' }, { name: 'deploy' }, { name: 'redeploy' }];

test('an exact name first, then names that start with it, then names that contain it', () => {
  assert.deepEqual(matchSnippets(snippets, 'deploy').map(s => s.name), ['deploy', 'deploy-staging', 'redeploy']);
  assert.deepEqual(matchSnippets(snippets, 'DEP').map(s => s.name), ['deploy-staging', 'deploy', 'redeploy']);
});

test('nothing typed yet lists every snippet, in order; no match lists none', () => {
  assert.deepEqual(matchSnippets(snippets, ''), snippets);
  assert.deepEqual(matchSnippets(snippets, 'zz'), []);
});
