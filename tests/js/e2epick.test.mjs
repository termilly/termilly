// Which end-to-end tests a change runs (scripts/e2e-pick.mjs, #97).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageOf, importersOf, pick, globToRegExp } from '../../scripts/e2e-pick.mjs';

const JS = 'src/Termilly.Desktop/wwwroot/js/';

const tests = new Map([
  ['compact.e2e.mjs', coverageOf('// Covers: js/compact*.js src/Termilly.App/Features/Compact*.cs\nimport x;')],
  ['layout-import.e2e.mjs', coverageOf('// Covers: js/layouts.js')],
  ['smoke.e2e.mjs', coverageOf('// Covers: always')],
]);
// compact.js uses compactlines.js, which uses util.js; layouts.js uses util.js too. store.js nobody covered uses.
const importers = importersOf(new Map([
  [`${JS}compact.js`, "import { a } from './compactlines.js';"],
  [`${JS}compactlines.js`, "import { b } from './util.js';"],
  [`${JS}layouts.js`, "import { c } from './util.js';"],
  [`${JS}settings/page.js`, "import { d } from '../store.js';"],
  [`${JS}util.js`, ''],
]));
const run = (/** @type {string[]} */ ...changed) => pick({ changed, tests, importers });

test('shorthands and globs name repository paths', () => {
  assert.ok(globToRegExp('js/compact*.js').test(`${JS}compactinput.js`));
  assert.ok(!globToRegExp('js/compact*.js').test(`${JS}settings/compact.js`));
  assert.ok(globToRegExp('src/Termilly.Host/**').test('src/Termilly.Host/Program.cs'));
});

test("a covered module's own change runs its tests, with the ones that always run", () => {
  assert.deepEqual(run(`${JS}compact.js`), { all: false, tests: ['compact.e2e.mjs', 'smoke.e2e.mjs'] });
  assert.deepEqual(run('src/Termilly.App/Features/CompactFiles.cs').tests, ['compact.e2e.mjs', 'smoke.e2e.mjs']);
});

test('a module the covered ones use, directly or through others, runs their tests', () => {
  assert.deepEqual(run(`${JS}compactlines.js`).tests, ['compact.e2e.mjs', 'smoke.e2e.mjs']);
  assert.deepEqual(run(`${JS}util.js`).tests, ['compact.e2e.mjs', 'layout-import.e2e.mjs', 'smoke.e2e.mjs']);
});

test('what no test claims runs all of them', () => {
  assert.deepEqual(run(`${JS}store.js`), { all: true, tests: ['compact.e2e.mjs', 'layout-import.e2e.mjs', 'smoke.e2e.mjs'] });
  assert.equal(run('src/Termilly.App/Features/Unknown.cs').all, true);
  assert.equal(run('tests/e2e/harness.mjs').all, true, 'the harness runs every test');
});

test('a changed test runs itself; changes outside the app run none', () => {
  assert.deepEqual(run('tests/e2e/layout-import.e2e.mjs'), { all: false, tests: ['layout-import.e2e.mjs'] });
  assert.deepEqual(run('docs/coding-standards.md', 'tests/js/suggest.test.mjs'), { all: false, tests: [] });
});
