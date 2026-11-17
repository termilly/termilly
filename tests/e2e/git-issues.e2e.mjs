// The Git window's Issues tab, end to end, against a fake gh (tests/e2e/fakes/gh.mjs) for a repository with 120 open
// issues: newest first, 50 at a time (the next page as the list scrolls to its end), how many there are, a state
// asked again from its first page, GitHub searching for the search box's words, and an issue's text drawn from its
// Markdown with nothing in it reaching the page as HTML.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until, openGit, tab, clickText } from './gitsteps.mjs';

const TOTAL = 120;
const PAGE_SIZE = 50;
const ROW = '.gw-list .gw-issue-row';
const BODY = [
  '<!-- Please describe the problem -->',
  '### What happened',
  'The app **crashed** on start, see https://example.com/log.',
  '',
  '- [x] Reinstalled',
  '- [ ] Tried safe mode',
  '',
  '```js',
  'start(<script>alert(1)</script>);',
  '```',
  '<script>window.hacked = true</script>',
].join('\n');

/** A listed issue, as GitHub's search answers it: the newest has the highest number. @param {number} number */
const searchRow = number => ({
  number, title: `Issue number ${number}`, state: 'open', labels: number % 2 ? [] : [{ name: 'bug', color: 'd73a4a' }],
  user: { login: 'rosa' }, comments: number % 3, created_at: new Date(Date.UTC(2026, 9, 1) + number * 3_600_000).toISOString(),
  updated_at: '2026-11-16T10:00:00Z', html_url: `https://github.com/acme/demo/issues/${number}`,
});

/** gh's arguments for a page of the search. @param {string} query @param {number} page */
const searchArgs = (query, page) => ['api', '-X', 'GET', 'search/issues', '-f', `q=repo:acme/demo is:issue ${query}`.trim(),
  '-f', 'sort=created', '-f', 'order=desc', '-f', `per_page=${PAGE_SIZE}`, '-f', `page=${page}`];

/** The open issues' pages: 120 down to 71, 70 down to 21, 20 down to 1. @param {number} page */
const openPage = page => {
  const from = TOTAL - (page - 1) * PAGE_SIZE;
  const numbers = Array.from({ length: Math.min(PAGE_SIZE, from) }, (_, i) => from - i);
  return { json: { total_count: TOTAL, items: numbers.map(searchRow) } };
};

function scenario() {
  return [
    { prefix: ['auth', 'token'], response: 'gho_fake' },
    { prefix: ['repo', 'view'], response: { json: { nameWithOwner: 'acme/demo', defaultBranchRef: { name: 'main' }, isPrivate: false } } },
    { prefix: ['api', 'user'], response: 'tester' },
    ...[1, 2, 3].map(page => ({ args: searchArgs('is:open', page), response: openPage(page) })),
    { args: searchArgs('is:closed', 1), response: { json: { total_count: 1, items: [{ ...searchRow(3), title: 'An old one', state: 'closed' }] } } },
    { args: searchArgs('is:open crash', 1), response: { json: { total_count: 1, items: [{ ...searchRow(77), title: 'Crash on start' }] } } },
    { prefix: ['issue', 'view', '120'], response: { json: {
      number: 120, title: 'Issue number 120', state: 'OPEN', labels: [{ name: 'bug', color: 'd73a4a' }], author: { login: 'rosa' },
      createdAt: '2026-11-15T10:00:00Z', url: 'https://github.com/acme/demo/issues/120', body: BODY,
      comments: [{ author: { login: 'rosa' }, body: 'Still **happens**.', createdAt: '2026-11-16T10:00:00Z' }],
    } } },
    { prefix: ['issue', 'view'], response: { json: { number: 1, title: 'x', state: 'OPEN', labels: [], author: null, createdAt: '', url: '', body: '', comments: [] } } },
    { prefix: ['pr', 'list'], response: { json: [] } },
    { prefix: ['run', 'list'], response: { json: [] } },
  ];
}

let repo;
let app;
let failed = false;

/** A test that marks the run failed (with a screenshot of the moment) when it throws. @param {string} name @param {() => Promise<void>} run */
const step = (name, run) => test(name, async () => {
  try {
    await run();
  } catch (e) {
    failed = true;
    await app?.screenshot(name.replace(/\W+/g, '-')).catch(() => null);
    throw e;
  }
});

/** The numbers of the issues listed, in order. */
const listed = () => app.eval((t, s) => t.$$(s).map(el => Number(/#(\d+)/.exec(el.textContent)?.[1])), ROW);
/** The pages gh was asked for, with the query's state and words. */
const asked = async () => (await app.ghCalls()).filter(a => a[3] === 'search/issues').map(a => `${a[5]} ${a[13]}`);

before(async () => {
  repo = await makeRepo({ files: { 'a.txt': 'a\n' } });
  await repo.git('remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  app = await startApp({ folder: repo.path, gh: scenario() });
  await openGit(app);
});

after(async () => {
  await app?.stop({ failed });
  await repo?.dispose();
});

step('Issues lists the first 50, newest first, and says how many there are', async () => {
  await app.waitFor('[data-gw-tab="issues"]');
  await tab(app, 'Issues');
  await app.waitFor(ROW, { text: 'Issue number 120' });
  const numbers = await listed();
  assert.equal(numbers.length, PAGE_SIZE);
  assert.deepEqual(numbers.slice(0, 3), [120, 119, 118]);
  assert.equal(await app.text('.gw-issue-count'), '120 open');
  assert.deepEqual(await asked(), ['q=repo:acme/demo is:issue is:open page=1']);
  await app.waitFor('.gw-list .gw-more', { text: 'Load more issues' });
});

step('scrolling to the end loads the next page, until there are no more', async () => {
  for (const expected of [100, 120]) {
    await app.eval((t, s) => { const list = t.$(s); list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll')); }, '.gw-list');
    await until(async () => (await listed()).length === expected, `${expected} issues listed`);
  }
  const numbers = await listed();
  assert.deepEqual([numbers[0], numbers.at(-1)], [120, 1]);
  assert.equal(new Set(numbers).size, TOTAL);
  assert.equal(await app.eval((t, s) => t.$$(s).length, '.gw-list .gw-more'), 0);
});

step('an issue opens with its Markdown drawn and nothing in it running', async () => {
  await clickText(app, ROW, 'Issue number 120');
  await app.waitFor('.gh-md h3', { text: 'What happened' });
  const shown = await app.eval(t => ({
    strong: t.text('.gh-md strong'),
    tasks: t.$$('.gh-md .md-task input').map(i => i.checked),
    code: t.text('.gh-md .md-code'),
    link: t.$('.gh-md .md-link')?.getAttribute('data-href'),
    href: t.$('.gh-md .md-link')?.hasAttribute('href'),
    scripts: t.$$('.gh-thread script').length,
    hacked: !!globalThis.hacked,
    template: t.text('.gh-thread').includes('Please describe'),
    posts: t.$$('.gh-post').length,
    badge: t.text('.gh-post:nth-child(2) .gh-badge'),
  }));
  assert.deepEqual(shown, {
    strong: 'crashed', tasks: [true, false], code: 'start(<script>alert(1)</script>);', link: 'https://example.com/log',
    href: false, scripts: 0, hacked: false, template: false, posts: 2, badge: 'Author',
  });
});

step('another state is asked from its first page', async () => {
  await clickText(app, '.gw-issue-states button', 'Closed');
  await app.waitFor(ROW, { text: 'An old one' });
  assert.equal(await app.text('.gw-issue-count'), '1 closed');
  assert.equal((await asked()).at(-1), 'q=repo:acme/demo is:issue is:closed page=1');
  await clickText(app, '.gw-issue-states button', 'Open');
  await app.waitFor(ROW, { text: 'Issue number 120' });
});

step('the search box asks GitHub, and emptying it brings the whole list back', async () => {
  await app.type('.gw-search input', 'crash');
  await app.waitFor(ROW, { text: 'Crash on start' });
  assert.deepEqual(await listed(), [77]);
  assert.equal((await asked()).at(-1), 'q=repo:acme/demo is:issue is:open crash page=1');
  await app.key('.gw-search input', 'Escape');
  await app.waitFor(ROW, { text: 'Issue number 120' });
  assert.equal((await listed()).length, PAGE_SIZE);
});
