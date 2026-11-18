// To do's edit_task and delete_task, as an agent's call reaches the page (js/todoagent.js): a title, details and tags
// changed with the rest kept, a task deleted with a notice whose Undo puts it back in its place, one being worked on
// kept, and another terminal's task out of reach. Run with: npm run e2e (on Linux, under Xvfb).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';

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

/** Calls a To do method as the MCP server's tool would, from the first terminal; its error message when it fails. */
const call = (method, args) => app.eval(async (t, method, args) => {
  const { state } = await t.import('store.js');
  const { callApi } = await t.import('api.js');
  const from = [...state.tabs.values()].find(tab => tab.view?.term)?.id;
  try {
    return await callApi(method, { ...args, from });
  } catch (e) {
    return { error: e.message };
  }
}, method, args);

/** The first terminal's tasks: title, details and tags, in order. */
const tasks = () => app.eval(async t => {
  const { state } = await t.import('store.js');
  const { listOf, terminalList } = await t.import('todo.js');
  const tab = [...state.tabs.values()].find(x => x.view?.term);
  return listOf(terminalList(tab)).tasks.map(task => ({ id: task.id, text: task.text, details: task.details ?? null, tags: task.tags ?? null }));
});

before(async () => {
  app = await startApp({ name: 'todo-tools' });
  await app.waitFor('.pane .xterm');
  await call('task_add', { title: 'First', details: 'Old notes', tags: 'one' });
  await call('task_add', { title: 'Second' });
  await call('task_add', { title: 'Third' });
});

after(async () => { await app?.stop({ failed }); });

step('edit_task changes what it is given and keeps the rest', async () => {
  const [first] = await tasks();
  const edited = await call('task_edit', { task: first.id, title: 'First, renamed', tags: 'two, #three' });
  assert.equal(edited.title, 'First, renamed');
  assert.deepEqual((await tasks())[0], { id: first.id, text: 'First, renamed', details: 'Old notes', tags: ['two', 'three'] });
  await call('task_edit', { task: first.id, details: '', tags: '' });
  assert.deepEqual((await tasks())[0], { id: first.id, text: 'First, renamed', details: null, tags: null });
  assert.match((await call('task_edit', { task: first.id })).error, /Give a title, details or tags/);
  assert.match((await call('task_edit', { task: first.id, title: '  ' })).error, /needs a title/);
});

step('delete_task deletes it with a notice, and Undo puts it back where it was', async () => {
  const before = await tasks();
  const second = before[1];
  const done = await call('task_delete', { task: second.id });
  assert.equal(done.deleted.title, 'Second');
  assert.deepEqual((await tasks()).map(task => task.text), ['First, renamed', 'Third']);
  await app.waitFor('.toast', { text: 'deleted “Second”' });
  await app.screenshot('deleted-toast');
  await app.eval(t => [...t.$$('.toast button')].find(b => b.textContent.trim() === 'Undo').click());
  assert.deepEqual((await tasks()).map(task => task.text), ['First, renamed', 'Second', 'Third']);
});

step('a task being worked on, or in another terminal\'s list, is not deleted', async () => {
  const [, , third] = await tasks();
  await app.eval(async (t, id) => {
    const { state } = await t.import('store.js');
    const { updateTask, terminalList } = await t.import('todo.js');
    const tab = [...state.tabs.values()].find(x => x.view?.term);
    updateTask(terminalList(tab), id, { run: 'r1' });
  }, third.id);
  assert.match((await call('task_delete', { task: third.id })).error, /being worked on/);
  // A task in a terminal of another workspace: out of this terminal's reach.
  const other = await app.eval(async t => {
    const { createWorkspace } = await t.import('workspaces.js');
    const { state } = await t.import('store.js');
    const { addTasks, terminalList } = await t.import('todo.js');
    const { switchWorkspace } = await t.import('panes.js');
    const first = state.activeId;
    createWorkspace({ name: 'other' });
    await new Promise(r => setTimeout(r, 1000));
    const tab = [...state.tabs.values()].find(x => x.wsId === state.activeId);
    const [id] = addTasks(terminalList(tab), [{ text: 'Not yours' }]);
    switchWorkspace(first);
    return id;
  });
  await new Promise(r => setTimeout(r, 500));
  assert.match((await call('task_delete', { task: other })).error, /another terminal's list/);
  assert.match((await call('task_edit', { task: other, title: 'Mine now' })).error, /another terminal's list/);
});
