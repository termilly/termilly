// Pushing from the Git window, end to end, to a bare origin on this machine: the Push button with the commits to push,
// a new branch's first push, the repository's own pre-push hook (what it said is one click away), and a hook that
// refuses the push (its words in the dialog, nothing pushed). Undo this commit on a commit not pushed yet.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until, openGit, confirm, noteAction, tab, clickText } from './gitsteps.mjs';

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

/** The repository's pre-push hook, saying something and then letting the push go (0) or not (1). */
const hook = (words, exit) => {
  const file = path.join(repo.path, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(file, `#!/bin/sh\necho "${words}" >&2\nexit ${exit}\n`);
  fs.chmodSync(file, 0o755);
};

/** The branch's commit on the origin, or '' when it isn't there. @param {string} branch */
const onOrigin = async branch => {
  try {
    return await repo.git(`--git-dir=${repo.origin}`, 'rev-parse', '--verify', '-q', branch);
  } catch {
    return '';
  }
};

before(async () => {
  repo = await makeRepo({ files: { 'a.txt': 'a\n' }, remote: 'bare' });
  await repo.git('switch', '-q', '-c', 'topic');
  fs.writeFileSync(path.join(repo.path, 'a.txt'), 'a on topic\n');
  await repo.git('commit', '-qam', 'Topic work');
  app = await startApp({ folder: repo.path });
  await openGit(app);
});

after(async () => {
  await app?.stop({ failed });
  await repo?.dispose();
});

step('a hook that refuses the push shows its words, and nothing is pushed', async () => {
  hook('tests must pass first', 1);
  await app.waitFor('[data-gw="push"]');
  await app.click('[data-gw="push"]');
  await app.waitFor('[data-ok]', { text: 'Push' });
  await app.click('[data-ok]');
  await app.waitFor('.dialog-error', { text: 'tests must pass first' });
  assert.equal(await onOrigin('topic'), '');
  await app.click('[data-cancel]');
});

step('a new branch is pushed, and what the hook said is one click away', async () => {
  hook('lint passed', 0);
  await app.click('[data-gw="push"]');
  await app.waitFor('[data-ok]', { text: 'Push' });
  const said = await app.eval(t => t.$('[data-ok]').parentElement.parentElement.textContent);
  assert.match(said, /new branch/i, 'the dialog says the branch is new there');
  await confirm(app);
  await until(async () => (await onOrigin('topic')) === await repo.git('rev-parse', 'HEAD'), 'topic on the origin');
  await noteAction(app, 'Pushed topic');
  await app.waitFor('pre, .gw-push-output', { text: 'lint passed' });
});

step('Undo this commit takes a commit that isn\'t pushed off the branch, its changes staged', async () => {
  await app.key(null, 'Escape');
  fs.writeFileSync(path.join(repo.path, 'b.txt'), 'b\n');
  await repo.git('add', 'b.txt');
  await repo.git('commit', '-qm', 'Not pushed yet');
  await tab(app, 'History');
  await app.click('.gw-refresh');
  await clickText(app, '.gw-graph-row', 'Not pushed yet');
  await app.waitFor('[data-undo-commit]');
  await app.click('[data-undo-commit]');
  await until(async () => (await repo.git('log', '-1', '--format=%s')) === 'Topic work', 'the commit taken off');
  assert.match(await repo.git('diff', '--cached', '--name-only'), /b\.txt/);
});
