// A test run's report page (scripts/e2e-report.mjs, #97).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJunit, reportHtml, indexHtml, failedCount, testCount, withExit } from '../../scripts/e2e-report.mjs';

const JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="the box keeps &quot;its&quot; text" time="2.5" classname="test"/>
	<testcase name="the font stays &lt;14&gt;" time="4.25" classname="test">
		<failure type="testCodeFailure" message="Settings' font">AssertionError: Settings&apos; font
  actual: 12.5
  expected: 14</failure>
	</testcase>
	<testcase name="skipped here" time="0" classname="test"><skipped type="skipped" message="linux only"/></testcase>
</testsuites>`;

test('a JUnit file reads into each test, its time and its failure', () => {
  const results = readJunit(JUNIT);
  assert.deepEqual(results.map(r => [r.name, r.seconds, !!r.failure, r.skipped]), [
    ['the box keeps "its" text', 2.5, false, false],
    ['the font stays <14>', 4.25, true, false],
    ['skipped here', 0, false, true],
  ]);
  assert.match(/** @type {string} */ (results[1].failure), /Settings' font[\s\S]*actual: 12\.5/);
});

const run = (/** @type {import('../../scripts/e2e-report.mjs').FileRun[]} */ files) => ({
  commit: '0123456789abcdef', subject: 'A fix <for> the box', branch: 'release/1.11.0', base: 'fedcba9876543210',
  changed: ['src/Termilly.Desktop/wwwroot/js/compact.js'], all: false, files, seconds: 75, at: new Date('2026-11-27T12:00:00Z'), machine: 'optiplex',
});

test('the report leads with the failures, with their error, screenshot and log, and escapes what it shows', () => {
  const passed = { file: 'layout-import.e2e.mjs', tests: [{ name: 'ok', seconds: 1, failure: null, skipped: false }], screenshots: [], log: null };
  const failed = { file: 'terminal-size.e2e.mjs', tests: readJunit(JUNIT), screenshots: ['terminal-size/failure.png'], log: 'line 1\nthe end' };
  const report = run([passed, failed]);
  const html = reportHtml(report);
  assert.equal(failedCount(report), 1);
  assert.match(html, /1 of 3 failed<\/b>, 1 skipped/);
  assert.ok(html.indexOf('terminal-size.e2e.mjs') < html.indexOf('layout-import.e2e.mjs'), 'the failed file first');
  assert.match(html, /<img src="terminal-size\/failure.png"/);
  assert.match(html, /the end/);
  assert.match(html, /A fix &lt;for&gt; the box/);
  assert.doesNotMatch(html, /<for>/);
});

test('a run with no failure says all passed and shows no log', () => {
  const html = reportHtml(run([{ file: 'smoke.e2e.mjs', tests: [{ name: 'ok', seconds: 1, failure: null, skipped: false }], screenshots: [], log: 'unused' }]));
  assert.match(html, /All 1 passed/);
  assert.doesNotMatch(html, /unused/);
});

test('the runs page lists each run with its result and a link', () => {
  const html = indexHtml([{ page: 'run-1.html', commit: 'abcdef0123', subject: 'Second', failed: 2, total: 9, at: '2026-11-27T13:00:00Z' },
    { page: 'run-0.html', commit: '0123abcdef', subject: 'First', failed: 0, total: 3, at: '2026-11-27T12:00:00Z' }]);
  assert.match(html, /2 failed[\s\S]*href="run-1.html"[\s\S]*Passed[\s\S]*href="run-0.html"/);
});

test('skipped tests are not counted as passed', () => {
  const skipped = { file: 'real-agents.e2e.mjs', tests: [{ name: 'a', seconds: 0, failure: null, skipped: true }], screenshots: [], log: null };
  const report = run([skipped, { file: 'smoke.e2e.mjs', tests: [{ name: 'ok', seconds: 1, failure: null, skipped: false }], screenshots: [], log: null }]);
  assert.equal(testCount(report), 1);
  assert.match(reportHtml(report), /All 1 passed<\/b>, 1 skipped/);
});

test('a test process that ended badly is a failure, whatever its results say', () => {
  const ok = [{ name: 'ok', seconds: 1, failure: null, skipped: false }];
  assert.deepEqual(withExit(ok, 0), ok);
  assert.equal(withExit([], 0).filter(t => t.failure).length, 1, 'no results at all');
  assert.equal(withExit(ok, 1).filter(t => t.failure).length, 1, 'exit 1 with nothing failed');
  const failed = [{ name: 'bad', seconds: 1, failure: 'x', skipped: false }];
  assert.deepEqual(withExit(failed, 1), failed, 'its failure already says why');
});
