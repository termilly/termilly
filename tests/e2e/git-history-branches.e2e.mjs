// The Git window, end to end: History of the checked-out branch and of every branch (the graph's lanes), a file's
// own history, worktrees in Branches (removing one keeps its work in Local history), Clean up branches with Undo,
// and Local history putting a file back.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until, openGit, menu, openFile, confirm, noteAction, tab, clickText } from './gitsteps.mjs';

let repo;
let app;
let linked;

/** @param {string} name @param {string} text */
const write = (name, text) => fs.writeFileSync(path.join(repo.path, name), text);
/** @param {string} message */
const commitAll = async message => {
  await repo.git('add', '-A');
  await repo.git('commit', '-q', '-m', message);
};

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
  repo = await makeRepo({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
  // done: merged into main; wip: a commit of its own, never merged; side: merged with a merge commit (two lanes).
  await repo.git('branch', 'done');
  await repo.git('switch', '-q', '-c', 'side');
  write('a.txt', 'a on side\n');
  await commitAll('Side work');
  await repo.git('switch', '-q', 'main');
  write('b.txt', 'b on main\n');
  await commitAll('Main work on b');
  await repo.git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  await repo.git('switch', '-q', '-c', 'wip');
  write('c.txt', 'wip\n');
  await commitAll('Work in progress');
  await repo.git('switch', '-q', 'main');
  linked = `${repo.path}-task`;
  await repo.git('worktree', 'add', '-q', '-b', 'task', linked);
  fs.writeFileSync(path.join(linked, 'task.txt'), 'unsaved task work\n');
  write('b.txt', 'b changed now\n');
  app = await startApp({ folder: repo.path });
  await openGit(app);
});

after(async () => {
  await app?.stop({ failed });
  if (fs.existsSync(linked)) await repo.git('worktree', 'remove', '--force', linked);
  await repo?.dispose();
});

step('History shows the checked-out branch, and All branches adds the others with their lanes', async () => {
  await tab(app, 'History');
  await app.waitFor('.gw-graph-row', { text: 'Merge side' });
  const subjects = () => app.eval(t => t.$$('.gw-graph-row .gw-subject').map(e => e.textContent));
  assert.ok(!(await subjects()).includes('Work in progress'), 'wip is another branch');
  // The merge draws a second lane for the side branch.
  const lanes = await app.eval(t => new Set(t.$$('.gw-graph circle').map(c => c.getAttribute('cx'))).size);
  assert.ok(lanes >= 2, 'a merge shows two lanes');
  await app.click('[data-history-all]');
  await until(async () => (await subjects()).includes('Work in progress'), 'wip\'s commit with All branches on');
  await app.click('[data-history-all]');
  await until(async () => !(await subjects()).includes('Work in progress'), 'back to the checked-out branch');
});

step('a file\'s menu shows its own history, and Whole repository goes back', async () => {
  await tab(app, 'Changes');
  await openFile(app, 'Changes', 'b.txt');
  await menu(app, '.gw-file.selected', 'History of this file');
  await app.waitFor('.gw-history-path', { text: 'b.txt' });
  await until(async () => {
    const subjects = await app.eval(t => t.$$('.gw-graph-row .gw-subject').map(e => e.textContent));
    return subjects.includes('Main work on b') && !subjects.includes('Side work') && subjects;
  }, 'only the commits that changed b.txt');
  await app.click('[data-history-whole]');
  await app.waitFor('.gw-graph-row', { text: 'Side work' });
});

step('Branches lists the worktrees; removing one with work in it keeps that work in Local history', async () => {
  await tab(app, 'Branches');
  await app.waitFor('.gw-section', { text: 'Worktrees' });
  await clickText(app, '.gw-list .cw-row', path.basename(linked));
  await app.waitFor('[data-wt-remove]');
  await app.click('[data-wt-remove]');
  await app.waitFor('[data-ok]');
  const asked = await app.eval(t => t.$('[data-ok]').parentElement.parentElement.textContent);
  assert.match(asked, /kept in Local history/);
  await confirm(app);
  await until(() => !fs.existsSync(linked), 'the worktree folder gone');
  assert.ok((await repo.git('branch', '--list', 'task')).includes('task'), 'its branch stays');
  await tab(app, 'Local history');
  await app.waitFor('.gw-list .cw-row', { text: 'Before a worktree was removed' });
});

step('Clean up branches offers the merged ones ticked, deletes them, and Undo brings them back', async () => {
  await tab(app, 'Branches');
  await app.click('[data-prune]');
  await app.waitFor('.gw-prune-row', { text: 'done' });
  const rows = await app.eval(t => t.$$('.gw-prune-row').map(r => [r.querySelector('.gw-prune-name').textContent, r.querySelector('input').checked]));
  assert.deepEqual(Object.fromEntries(rows).done, true, 'a merged branch is ticked');
  assert.notEqual(Object.fromEntries(rows).wip, true, 'a branch with its own work isn\'t ticked');
  await confirm(app);
  await until(async () => !(await repo.git('branch', '--list', 'done')), 'done deleted');
  assert.ok(await repo.git('branch', '--list', 'wip'), 'wip stays');
  await noteAction(app, 'Deleted');
  await until(async () => await repo.git('branch', '--list', 'done'), 'done back after Undo');
});

step('Local history puts a thrown-away file back, and Undo takes it away again', async () => {
  await tab(app, 'Changes');
  await openFile(app, 'Changes', 'b.txt');
  await menu(app, '.gw-file.selected', 'Restore');
  await confirm(app);
  await until(() => fs.readFileSync(path.join(repo.path, 'b.txt'), 'utf8') === 'b on main\n', 'b.txt restored');
  await tab(app, 'Local history');
  await clickText(app, '.gw-list .cw-row', 'Before changes were thrown away');
  await app.waitFor('[data-local-restore]');
  await app.click('[data-local-restore]');
  await until(() => fs.readFileSync(path.join(repo.path, 'b.txt'), 'utf8') === 'b changed now\n', 'b.txt put back');
  await noteAction(app, 'put back');
  await until(() => fs.readFileSync(path.join(repo.path, 'b.txt'), 'utf8') === 'b on main\n', 'Undo of putting back');
});
