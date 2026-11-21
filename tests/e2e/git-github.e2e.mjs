// The Git window's GitHub parts, end to end, against a fake gh (tests/e2e/fakes/gh.mjs): the Issues tab, reading and
// commenting on an issue, the dot of a failed check on a commit in History, its details with Why? (the failed log),
// Fix with an agent (a To do task, and an agent started in the repository) and Re-run failed.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until, openGit, tab, clickText, confirm } from './gitsteps.mjs';

const RUN_ID = 11;
const JOB_ID = 21;
const LOG_LINE = 'Error: expected 2 to equal 3';
const ISSUE = {
  number: 12, title: 'The login page shows an error', state: 'OPEN', labels: [{ name: 'bug', color: 'd73a4a' }],
  author: { login: 'rosa' }, updatedAt: '2026-11-16T10:00:00Z', createdAt: '2026-11-15T10:00:00Z', comments: [],
  url: 'https://github.com/acme/demo/issues/12', body: 'Signing in shows "Something went wrong".',
};

/** The issue as GitHub's search lists it. */
const SEARCH_ROW = { number: 12, title: ISSUE.title, state: 'open', labels: ISSUE.labels, user: ISSUE.author, comments: 0,
  created_at: ISSUE.createdAt, updated_at: ISSUE.updatedAt, html_url: ISSUE.url };

/** What gh answers for the repository acme/demo, with one open issue and one failed run on HEAD. @param {string} head */
function scenario(head) {
  return [
    { prefix: ['auth', 'token'], response: 'gho_fake' },
    { prefix: ['repo', 'view'], response: { json: { nameWithOwner: 'acme/demo', defaultBranchRef: { name: 'main' }, isPrivate: false } } },
    { prefix: ['api', 'user'], response: 'tester' },
    { prefix: ['api', '-X', 'GET', 'search/issues'], response: { json: { total_count: 1, items: [SEARCH_ROW] } } },
    { prefix: ['issue', 'view', '12'], response: { json: ISSUE } },
    { prefix: ['issue', 'comment', '12'], response: '' },
    { prefix: ['pr', 'list'], response: { json: [] } },
    { prefix: ['run', 'list'], response: { json: [{
      databaseId: RUN_ID, workflowName: 'Build', displayTitle: 'First', status: 'completed', conclusion: 'failure', event: 'push',
      headBranch: 'main', headSha: head, url: 'https://github.com/acme/demo/actions/runs/11', createdAt: '2026-11-16T10:00:00Z',
    }] } },
    { prefix: ['run', 'view', String(RUN_ID), '--json', 'jobs'], response: { json: { jobs: [{
      databaseId: JOB_ID, name: 'test', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/demo/actions/runs/11/job/21',
      steps: [{ name: 'Run tests', conclusion: 'failure' }],
    }] } } },
    { prefix: ['run', 'view', String(RUN_ID), '--json', 'url'], response: { json: { url: 'https://github.com/acme/demo/actions/runs/11' } } },
    { prefix: ['run', 'view', String(RUN_ID), '--log-failed'], response: `test\tRun tests\t${LOG_LINE}\n` },
    { prefix: ['run', 'rerun', String(RUN_ID)], response: '' },
  ];
}

let repo;
let app;
let failed = false;

/**
 * A test that marks the run failed (with a screenshot of the moment) when it throws.
 * @param {string} name
 * @param {() => Promise<void>} run
 */
const step = (name, run) => test(name, async () => {
  try {
    await run();
  } catch (e) {
    failed = true;
    await app?.screenshot(name.replace(/\W+/g, '-')).catch(() => null);
    throw e;
  }
});

/** Whether gh was called with arguments starting with these. @param {string[]} start */
const called = async start => (await app.ghCalls()).some(args => start.every((a, i) => args[i] === a));

before(async () => {
  repo = await makeRepo({ files: { 'a.txt': 'a\n' } });
  // GitHub's parts show for a repository whose origin is on GitHub; nothing reaches it (gh is the fake).
  await repo.git('remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  const head = await repo.git('rev-parse', 'HEAD');
  app = await startApp({ folder: repo.path, gh: scenario(head), agents: { claude: 'Looking at the failing test.' } });
  await openGit(app);
});

after(async () => {
  await app?.stop({ failed });
  await repo?.dispose();
});

step('the Issues tab lists the repository\'s issues, and one opens with its text', async () => {
  await app.waitFor('[data-gw-tab="issues"]');
  await tab(app, 'Issues');
  await app.waitFor('.gw-list .cw-row', { text: ISSUE.title });
  await clickText(app, '.gw-list .cw-row', ISSUE.title);
  await app.waitFor('.gh-md', { text: 'Something went wrong' });
});

step('a comment on the issue goes to GitHub through gh', async () => {
  await clickText(app, '[data-issue]', 'Comment');
  await app.waitFor('textarea[name="body"]');
  await app.type('textarea[name="body"]', 'Looking into it.');
  await confirm(app);
  await until(() => called(['issue', 'comment', '12']), 'gh issue comment');
});

step('a commit whose check failed gets a red dot in History, and its details say which', async () => {
  await tab(app, 'History');
  await app.waitFor('.gw-graph-row .gw-check[data-check="failing"]');
  await clickText(app, '.gw-graph-row', 'Initial files');
  await app.waitFor('.gw-checks-head', { text: '1 of 1 check failed' });
  await app.waitFor('.gw-check-job', { text: 'Run tests' });
});

step('Why? shows the end of the failed log', async () => {
  await app.click('[data-check-why]');
  await app.waitFor('.gw-check-log', { text: LOG_LINE });
  await app.click('[data-cancel]');
  await app.waitFor('.gw-check-log', { gone: true });
});

step('Fix with an agent adds a To do task with the log and starts the agent in the repository', async () => {
  await app.click('[data-check-fix]');
  // The call with the task in it: Termilly also runs claude --version on its own, to see that it's installed.
  const call = await until(async () => (await app.agentCalls()).find(c => c.agent === 'claude' && c.args.some(x => x.includes('failing check'))), 'the agent started on the task');
  assert.equal(call.cwd.replace(/\/+$/, ''), repo.path.replace(/\/+$/, ''));
  const task = await app.eval(async t => {
    const { findTaskWhere } = await t.import('todo.js');
    const found = findTaskWhere(x => x.text.startsWith('Fix the failing check'));
    return found ? { text: found.task.text, details: found.task.details } : null;
  });
  assert.equal(task?.text, 'Fix the failing check: Build / test on main');
  assert.match(task.details, /expected 2 to equal 3/);
});

step('Re-run failed asks gh to run the failed jobs again', async () => {
  await tab(app, 'History');
  await clickText(app, '.gw-graph-row', 'Initial files');
  await app.waitFor('[data-check-rerun]');
  await app.click('[data-check-rerun]');
  await until(() => called(['run', 'rerun', String(RUN_ID)]), 'gh run rerun');
});
