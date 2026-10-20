// Tests for the Results detectors (src/Termilly.Desktop/wwwroot/js/resultdetect.js), against real tool output.
// Run with: node --test tests/js/resultdetect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectResults } from '../../src/Termilly.Desktop/wwwroot/js/resultdetect.js';

const kinds = lines => {
  const state = {};
  return lines.flatMap(l => detectResults(l, state)).map(r => [r.kind, r.url, r.title]);
};

test('gh pr create and gh issue create print the new URL', () => {
  assert.deepEqual(kinds(['https://github.com/alexunder18/termilly/pull/42']),
    [['pr', 'https://github.com/alexunder18/termilly/pull/42', 'PR #42 · alexunder18/termilly']]);
  assert.deepEqual(kinds(['Created issue https://github.com/o/r/issues/7.']),
    [['issue', 'https://github.com/o/r/issues/7', 'Issue #7 · o/r']]);
});

test('GitLab merge requests and Azure DevOps pull requests', () => {
  assert.equal(kinds(['View it on GitLab: https://gitlab.com/group/sub/proj/-/merge_requests/9'])[0][2], 'PR #9 · group/sub/proj');
  assert.equal(kinds(['https://dev.azure.com/acme/web/_git/site/pullrequest/12'])[0][0], 'pr');
});

test('dev servers: Vite, Next.js, ASP.NET, Flask', () => {
  assert.deepEqual(kinds(['  ➜  Local:   http://localhost:5173/', '  ➜  Network: use --host to expose']).map(r => r[1]), ['http://localhost:5173/']);
  assert.deepEqual(kinds(['   ▲ Next.js 15.2.0', '   - Local:        http://localhost:3000']).map(r => r[1]), ['http://localhost:3000']);
  assert.deepEqual(kinds(['info: Microsoft.Hosting.Lifetime[14]', '      Now listening on: http://localhost:5000']).map(r => r[1]), ['http://localhost:5000']);
  assert.deepEqual(kinds([' * Running on http://127.0.0.1:5000']).map(r => r[1]), ['http://127.0.0.1:5000']);
  assert.deepEqual(kinds(['Server listening at http://0.0.0.0:8080']).map(r => r[1]), ['http://localhost:8080']);
  assert.deepEqual(kinds(['no port here: http://localhost/']), []);
});

test('git commit and git push', () => {
  assert.deepEqual(kinds(['[main 1a2b3c4] Fix the login redirect', ' 2 files changed, 10 insertions(+)']),
    [['commit', null, '1a2b3c4 Fix the login redirect']]);
  const push = kinds([
    'Enumerating objects: 5, done.',
    'To github.com:alexunder18/termilly.git',
    '   1a2b3c4..5d6e7f8  issue/33-results -> issue/33-results',
  ]);
  assert.deepEqual(push, [['push', 'https://github.com/alexunder18/termilly/tree/issue/33-results', 'Pushed issue/33-results → alexunder18/termilly']]);
  assert.equal(kinds(['To https://gitlab.com/g/p.git', ' * [new branch]      feat -> feat'])[0][1], 'https://gitlab.com/g/p/-/tree/feat');
});

test('plain lines produce nothing', () => {
  assert.deepEqual(kinds(['npm WARN deprecated', 'see https://github.com/o/r for docs', 'All 42 tests passed']), []);
});
