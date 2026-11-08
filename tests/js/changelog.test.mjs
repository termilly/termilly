// Tests for changelog.js: how What's new reads CHANGELOG.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChangelog, compareVersions, releasesSince } from '../../src/Termilly.Desktop/wwwroot/js/changelog.js';

const SAMPLE = [
  '# Changelog',
  '',
  'What changed in each release.',
  '',
  '## 1.7.0 (draft)',
  '',
  '- **Not out yet:** left out.',
  '',
  '## 1.6.2 (2026-11-06)',
  '',
  '- **Detachable windows:** move terminals into their own windows.',
  '- **Zoom:** use keyboard shortcuts to zoom.',
  '',
  'Fixes:',
  '',
  '- **Linux:** no white flash at start.',
  '- Various smaller improvements and bug fixes.',
  '',
  '## 1.6.1 (2026-11-02)',
  '',
  'A paragraph, kept as a plain line.',
  '',
  '- **Remote**: a terminal badge.',
  '  - a sub-item, left out',
  '',
  '## 1.5.0 (2026-10-30)',
  '',
  '- Notepad',
].join('\r\n');

test('released versions with their topics and fixes, a draft left out', () => {
  const releases = parseChangelog(SAMPLE);
  assert.deepEqual(releases.map(r => r.version), ['1.6.2', '1.6.1', '1.5.0']);
  assert.deepEqual(releases[0], {
    version: '1.6.2', date: '2026-11-06',
    topics: [{ name: 'Detachable windows', text: 'move terminals into their own windows.' }, { name: 'Zoom', text: 'use keyboard shortcuts to zoom.' }],
    fixes: [{ name: 'Linux', text: 'no white flash at start.' }, { name: '', text: 'Various smaller improvements and bug fixes.' }],
  });
});

test('a colon after the bold, sub-items and paragraphs', () => {
  const [, older, oldest] = parseChangelog(SAMPLE);
  assert.deepEqual(older.topics, [{ name: '', text: 'A paragraph, kept as a plain line.' }, { name: 'Remote', text: 'a terminal badge.' }]);
  assert.deepEqual(oldest.topics, [{ name: '', text: 'Notepad' }]);
});

test('versions compare by number, not as text', () => {
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
  assert.ok(compareVersions('1.6.1', '1.6.2') < 0);
  assert.equal(compareVersions('1.6', '1.6.0'), 0);
});

test('what is new since a version, newest first', () => {
  const releases = parseChangelog(SAMPLE);
  assert.deepEqual(releasesSince(releases, '1.5.0', '1.6.2').map(r => r.version), ['1.6.2', '1.6.1']);
  assert.deepEqual(releasesSince(releases, '1.6.1', '1.6.2').map(r => r.version), ['1.6.2']);
  assert.deepEqual(releasesSince(releases, '1.6.2', '1.6.2'), []);
  // An update from a version that didn't keep what it had seen: only this version's.
  assert.deepEqual(releasesSince(releases, null, '1.6.2').map(r => r.version), ['1.6.2']);
  // A version not in the changelog (a build between releases): nothing.
  assert.deepEqual(releasesSince(releases, null, '1.6.3'), []);
});

test('the real changelog reads, every version with something in it', () => {
  const releases = parseChangelog(readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'));
  assert.ok(releases.length >= 5);
  for (const r of releases) assert.ok(r.topics.length + r.fixes.length > 0, r.version);
});
