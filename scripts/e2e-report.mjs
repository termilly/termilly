// @ts-check
// A test run's report page (scripts/e2e-run.mjs, #97): what changed, which tests ran and why, and for each failure its
// error, screenshot and the end of the app's log. Plain HTML, no scripts, readable in light and dark.

/** How much of an app's log a failure shows: its end, where the failure is. */
const LOG_TAIL_LINES = 60;

/**
 * One test's result, as node's JUnit reporter writes it.
 * @typedef {{ name: string, seconds: number, failure: string | null, skipped: boolean }} TestResult
 */

/**
 * One test file's run: its results, and what it left behind on failure (screenshots, the app's log).
 * @typedef {{ file: string, tests: TestResult[], screenshots: string[], log: string | null }} FileRun
 */

/**
 * A run: the commit, the change it tested, which tests it picked, and their runs.
 * @typedef {{ commit: string, subject: string, branch: string, base: string, changed: string[], all: boolean,
 *   files: FileRun[], seconds: number, at: Date, machine: string }} Run
 */

/** @param {string} text */
const unescapeXml = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** @param {string} text */
export const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The tests in node's JUnit output, in order.
 * @param {string} xml
 * @returns {TestResult[]}
 */
export function readJunit(xml) {
  const results = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1], body = m[3] ?? '';
    const name = unescapeXml(/name="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const seconds = Number(/time="([^"]*)"/.exec(attrs)?.[1] ?? 0);
    const failure = /<failure\b([^>]*)>([\s\S]*?)<\/failure>|<failure\b([^>]*)\/>/.exec(body);
    const message = failure ? unescapeXml((failure[2] ?? '').trim() || (/message="([^"]*)"/.exec(failure[1] ?? failure[3] ?? '')?.[1] ?? 'failed')) : null;
    results.push({ name, seconds, failure: message, skipped: /<skipped\b/.test(body) });
  }
  return results;
}

/** @param {number} seconds */
const duration = seconds => (seconds >= 60 ? `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s` : `${seconds.toFixed(1)} s`);

/** @param {Run} run */
export const failedCount = run => run.files.reduce((n, f) => n + f.tests.filter(t => t.failure).length, 0);

/** The tests that ran, skipped ones aside. @param {Run} run */
export const testCount = run => run.files.reduce((n, f) => n + f.tests.filter(t => !t.skipped).length, 0);

/** @param {Run} run */
export const skippedCount = run => run.files.reduce((n, f) => n + f.tests.filter(t => t.skipped).length, 0);

/**
 * A test file's results with how its process ended: a process that failed, or left no results, is a failure even when
 * the results it wrote say nothing failed (killed while writing them, or ended before any test).
 * @param {TestResult[]} tests
 * @param {number} exitCode
 * @returns {TestResult[]}
 */
export function withExit(tests, exitCode) {
  if (tests.some(t => t.failure)) return tests;
  if (exitCode === 0 && tests.length) return tests;
  const why = tests.length ? `The test process ended with code ${exitCode}, its results incomplete.` : `No results: the test process ended with code ${exitCode} before any test.`;
  return [...tests, { name: 'the test file ran to its end', seconds: 0, failure: why, skipped: false }];
}

/** The last lines of a log. @param {string} log */
const tail = log => log.split('\n').slice(-LOG_TAIL_LINES).join('\n');

/** @param {FileRun} file */
function fileHtml(file) {
  const failed = file.tests.filter(t => t.failure);
  const rows = file.tests.map(t => `<tr><td class="${t.failure ? 'bad' : t.skipped ? 'muted' : 'ok'}">${t.failure ? 'Failed' : t.skipped ? 'Skipped' : 'Passed'}</td>`
    + `<td>${escapeHtml(t.name)}</td><td class="n">${duration(t.seconds)}</td></tr>`).join('');
  const failures = failed.map(t => `<h4>${escapeHtml(t.name)}</h4><pre>${escapeHtml(t.failure ?? '')}</pre>`).join('');
  const shots = file.screenshots.map(s => `<a href="${escapeHtml(s)}"><img src="${escapeHtml(s)}" alt="Screenshot at the failure"></a>`).join('');
  const log = failed.length && file.log ? `<details><summary>The app's log, its end</summary><pre>${escapeHtml(tail(file.log))}</pre></details>` : '';
  return `<section class="card${failed.length ? ' failed' : ''}"><h3>${escapeHtml(file.file)}</h3>
    <div class="table-wrap"><table>${rows}</table></div>${failures}${shots}${log}</section>`;
}

/**
 * The report page.
 * @param {Run} run
 */
export function reportHtml(run) {
  const failed = failedCount(run), total = testCount(run), skipped = skippedCount(run);
  const skippedText = skipped ? `, ${skipped} skipped` : '';
  const verdict = failed ? `<b class="bad">${failed} of ${total} failed</b>${skippedText}` : `<b class="ok">All ${total} passed</b>${skippedText}`;
  const why = run.all ? 'All tests: the change reaches code no test claims, or the tests themselves.' : 'The tests that cover what changed.';
  const changed = run.changed.map(f => `<li><code>${escapeHtml(f)}</code></li>`).join('');
  const order = [...run.files].sort((a, b) => Number(b.tests.some(t => t.failure)) - Number(a.tests.some(t => t.failure)));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="research-topic" content="tests">
<title>Test run ${escapeHtml(run.commit.slice(0, 8))}</title>
<style>
  :root { --bg: #ffffff; --card: #f6f6f8; --line: #dcdce2; --text: #1d1d22; --muted: #6b6b76; --ok: #1a7f37; --bad: #cf222e; --code: #4b3fc8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d0d10; --card: #16161b; --line: #2a2a31; --text: #e6e6e6; --muted: #9a9aa5; --ok: #6fd08c; --bad: #ff7b72; --code: #c9c2ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 1000px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 24px; margin: 0 0 6px; } h3 { margin: 4px 0 8px; font-size: 16px; } h4 { margin: 14px 0 4px; font-size: 14px; }
  .sub, .muted { color: var(--muted); }
  .card { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 12px 16px; margin: 12px 0; }
  .card.failed { border-color: var(--bad); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; } td.n { text-align: right; white-space: nowrap; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  code, pre { font: 12.5px ui-monospace, Consolas, monospace; color: var(--code); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
  img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; margin-top: 8px; }
</style>
</head>
<body>
<main>
  <h1>Test run ${escapeHtml(run.commit.slice(0, 8))}</h1>
  <p class="sub">${escapeHtml(run.subject)} · ${escapeHtml(run.branch)} · ${escapeHtml(run.at.toISOString().replace('T', ' ').slice(0, 16))} UTC · ${escapeHtml(run.machine)} · ${duration(run.seconds)}</p>
  <p>${verdict}. ${escapeHtml(why)}</p>
  <details><summary>What changed since ${escapeHtml(run.base.slice(0, 8))} (${run.changed.length} files)</summary><ul>${changed}</ul></details>
  ${order.map(fileHtml).join('\n')}
</main>
</body>
</html>
`;
}

/**
 * The runs page: the newest first, each with its result.
 * @param {{ page: string, commit: string, subject: string, failed: number, total: number, at: string }[]} runs
 */
export function indexHtml(runs) {
  const rows = runs.map(r => `<tr><td class="${r.failed ? 'bad' : 'ok'}">${r.failed ? `${r.failed} failed` : 'Passed'}</td>`
    + `<td><a href="${escapeHtml(r.page)}">${escapeHtml(r.commit.slice(0, 8))}</a> ${escapeHtml(r.subject)}</td><td class="n">${r.total} tests</td>`
    + `<td class="n">${escapeHtml(r.at.replace('T', ' ').slice(0, 16))}</td></tr>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="research-topic" content="tests">
<title>Test runs</title>
<style>
  :root { --bg: #ffffff; --line: #dcdce2; --text: #1d1d22; --muted: #6b6b76; --ok: #1a7f37; --bad: #cf222e; --link: #4b3fc8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d0d10; --line: #2a2a31; --text: #e6e6e6; --muted: #9a9aa5; --ok: #6fd08c; --bad: #ff7b72; --link: #c9c2ff; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 1000px; margin: 0 auto; padding: 32px 16px 64px; } a { color: var(--link); }
  .table-wrap { overflow-x: auto; } table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); } td.n { text-align: right; white-space: nowrap; color: var(--muted); }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
</style>
</head>
<body>
<main>
  <h1>Test runs</h1>
  <p style="color:var(--muted)">Each run tests what one change touched (scripts/e2e-run.mjs). The newest first.</p>
  <div class="table-wrap"><table>${rows}</table></div>
</main>
</body>
</html>
`;
}
