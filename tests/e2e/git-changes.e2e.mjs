// The Git window, end to end: opening it, Changes, staging a block of a file and single lines, discarding with Undo,
// Restore from a file's menu with Undo, committing from the box, and the commit in History beside the graph.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
// Covers: js/changes.js js/changetree.js js/diffrows.js js/gitdiffview.js src/Termilly.App/Features/Changes*.cs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until, openGit, filesIn, openFile, menu, confirm, noteAction, tab } from './gitsteps.mjs';

const LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
let repo;
let app;
const file = () => fs.readFileSync(path.join(repo.path, 'a.txt'), 'utf8');

/** Whether a test failed: the app's data, logs and a screenshot are kept then. */
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
    await app?.screenshot(name.replace(/W+/g, '-')).catch(() => null);
    throw e;
  }
});

before(async () => {
  repo = await makeRepo({ files: { 'a.txt': `${LINES.join('\n')}\n` } });
  const changed = LINES.slice();
  changed[1] = 'two changed';
  changed[7] = 'eight changed';
  fs.writeFileSync(path.join(repo.path, 'a.txt'), `${changed.join('\n')}\n`);
  fs.writeFileSync(path.join(repo.path, 'new.txt'), 'new\n');
  app = await startApp({ folder: repo.path });
});

after(async () => {
  await app?.stop({ failed });
  await repo?.dispose();
});

step('the Git button opens the Git window in a window of its own, on the repository', async () => {
  await openGit(app);
  await app.waitFor('.git-win .gw-repo', { text: path.basename(repo.path) });
  const own = await app.eval(t => t.$('.git-win').ownerDocument !== t.$('.xterm').ownerDocument);
  assert.equal(own, true, 'the Git window should be in its own window');
});

step('Changes lists the changed file and the new one', async () => {
  assert.deepEqual(await filesIn(app, 'Changes'), ['a.txt']);
  assert.deepEqual(await filesIn(app, 'Untracked'), ['new.txt']);
});

step('one block of a file is staged on its own', async () => {
  await openFile(app, 'Changes', 'a.txt');
  assert.equal(await app.eval(t => t.$$('.gw-hunk-bar').length), 2);
  await app.click('.gw-hunk-bar [data-block-act="stage"]');
  const staged = await until(async () => {
    const diff = await repo.git('diff', '--cached');
    return diff.includes('two changed') && diff;
  }, 'the first block staged');
  assert.ok(!staged.includes('eight changed'), 'the second block should stay unstaged');
  await until(async () => (await filesIn(app, 'Staged')).includes('a.txt'), 'a.txt under Staged');
});

step('a picked line is discarded, and Undo brings it back', async () => {
  await openFile(app, 'Changes', 'a.txt');
  // Its unstaged diff (one block left, to stage), not one still shown from before: a line picked there has no Discard.
  await until(() => app.eval(t => t.$$('.gw-hunk-bar').length === 1 && !!t.$('.gw-hunk-bar [data-block-act="stage"]')), 'a.txt\'s unstaged diff');
  await app.click('[data-l="a8"] .pv-no');
  await app.waitFor('.gw-pick-bar', { text: '1 line picked' });
  await app.click('.gw-pick-bar [data-pick-act="discard"]');
  await until(() => !file().includes('eight changed'), 'line 8 discarded');
  await noteAction(app, 'Discarded 1 line');
  await until(() => file().includes('eight changed'), 'line 8 back after Undo');
});

step('Restore from a file\'s menu keeps a copy first, and Undo brings it back', async () => {
  await openFile(app, 'Changes', 'a.txt');
  await menu(app, '.gw-file.selected', 'Restore');
  await confirm(app);
  await until(() => !file().includes('eight changed'), 'a.txt restored');
  await noteAction(app, 'Restored a.txt');
  await until(() => file().includes('eight changed'), 'a.txt back after Undo');
});

step('the commit box commits what\'s staged', async () => {
  await tab(app, 'Changes');
  await app.waitFor('.gw-commit-msg');
  await app.type('.gw-commit-msg', 'Change line two');
  await app.click('[data-commit="go"]');
  await until(async () => await repo.git('log', '-1', '--format=%s') === 'Change line two', 'the commit');
  // What wasn't staged stays a change.
  assert.ok((await repo.git('diff')).includes('eight changed'));
});

step('History shows the commit beside its piece of the graph', async () => {
  await tab(app, 'History');
  await app.waitFor('.gw-graph-row', { text: 'Change line two' });
  const graphs = await app.eval(t => t.$$('.gw-graph-row svg.gw-graph').length);
  assert.ok(graphs >= 2, 'each commit row draws its graph');
});
