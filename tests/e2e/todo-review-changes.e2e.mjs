// Review's Git changes on a To do task (js/todopanel.js, js/todoactions.js): a task Implement worked on keeps where it was
// worked through In progress and Review, and Git changes opens the Git window there on what changed. A task with no such
// place has no button, and Accept lets the place go. Run with: npm run e2e (on Linux, under Xvfb).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';

let app;
let repo;
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

/**
 * Adds a task to the list in front and takes it to Review as Implement does, out of sight in a folder when one is
 * given; its id.
 */
const reviewed = (title, folder) => app.eval(async (t, title, folder) => {
  const { addTasks, setStatus, listInFront, listOf, workedIn } = await t.import('todo.js');
  const { TASK_STATUS } = await t.import('todolist.js');
  const ref = listInFront();
  addTasks(ref, [{ text: title }]);
  const task = listOf(ref).tasks.find(x => x.text === title);
  const plan = { by: 'claude', reviewers: [], rounds: 1, run: 'silent' };
  setStatus(ref, task.id, TASK_STATUS.progress, { run: 'r1', plan, ...(folder ? { workedIn: workedIn({ folder, server: null }) } : {}) });
  setStatus(ref, task.id, TASK_STATUS.review, { plan, review: { summary: 'Changed a.txt', by: 'Claude Code' } });
  return task.id;
}, title, folder);

/** A task of the list in front as it is now. @param {string} id */
const taskById = id => app.eval(async (t, id) => {
  const { listInFront, listOf } = await t.import('todo.js');
  return listOf(listInFront()).tasks.find(x => x.id === id) ?? null;
}, id);

/** A task's row in the To do panel. @param {string} id */
const row = id => `.td-task[data-task="${id}"]`;

before(async () => {
  repo = await makeRepo({ files: { 'a.txt': 'one\n' } });
  fs.writeFileSync(path.join(repo.path, 'a.txt'), 'one\ntwo\n');
  app = await startApp({ name: 'todo-review-changes', folder: repo.path });
  await app.waitFor('.pane .xterm');
});

after(async () => {
  await app?.stop({ failed });
  await repo?.dispose();
});

let withPlace;
let without;

step('a task in Review keeps where Implement worked, and shows Git changes', async () => {
  withPlace = await reviewed('Worked here', repo.path);
  without = await reviewed('Worked nowhere known', null);
  assert.deepEqual((await taskById(withPlace)).workedIn, { folder: repo.path });
  await app.eval(async t => (await t.import('todopanel.js')).toggleTodo());
  await app.waitFor(`${row(withPlace)} [data-td="changes"]`, { text: 'Git changes' });
  await app.waitFor(`${row(without)} [data-td="accept"]`);
  assert.equal(await app.eval((t, s) => t.visible(s), `${row(without)} [data-td="changes"]`), false, 'no place known: no Git changes');
  await app.screenshot('review-buttons');
});

step('Git changes opens the Git window on the folder, with the changed file', async () => {
  await app.click(`${row(withPlace)} [data-td="changes"]`);
  await app.waitFor('.git-win .gw-repo', { text: path.basename(repo.path) });
  await app.waitFor('.git-win .gw-file', { text: 'a.txt' });
  await app.screenshot('git-changes');
});

step('Accept lets the place go', async () => {
  await app.eval(async t => (await t.import('gitwindow.js')).closeGitWindow());
  await app.waitFor('.git-win', { gone: true });
  await app.screenshot('review-row');
  await app.click(`${row(withPlace)} [data-td="accept"]`);
  assert.equal((await taskById(withPlace)).workedIn, undefined);
});
