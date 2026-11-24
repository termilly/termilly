// edit_schedule and delete_schedule, as an agent's call reaches the page (js/scheduleagent.js): what's given changes and
// the rest stays, a new kind of when starts afresh, a changed agent prompt only reads files again, and a deleted schedule
// leaves the open Schedules window. Run with: npm run e2e (on Linux, under Xvfb).
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

/** Calls a schedule method as the MCP server's tool would, from the first terminal; its error message when it fails. */
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

/** A saved schedule, as the store keeps it. @param {string} id */
const stored = id => app.eval(async (t, id) => (await t.import('schedules.js')).scheduleById(id) ?? null, id);

before(async () => {
  app = await startApp({ name: 'schedule-tools' });
  await app.waitFor('.pane .xterm');
});

after(async () => { await app?.stop({ failed }); });

step('edit_schedule changes what it is given and keeps the rest', async () => {
  const added = await call('schedule_add', { name: 'Nightly', command: 'echo hi', at: '20:00', days: 'Mon,Wed', cwd: '/tmp', on: false });
  const edited = await call('schedule_edit', { schedule: added.id, name: 'Nightly build', at: '21:15' });
  assert.equal(edited.name, 'Nightly build');
  const s = await stored(added.id);
  assert.equal(s.command, 'echo hi');
  assert.equal(s.cwd, '/tmp');
  assert.equal(s.on, false);
  assert.deepEqual([s.when.kind, s.when.at, s.when.days], ['time', '21:15', [1, 3]]);
  // Days alone keep the time; empty is every day.
  await call('schedule_edit', { schedule: added.id, days: '' });
  assert.deepEqual([(await stored(added.id)).when.at, (await stored(added.id)).when.days], ['21:15', []]);
  // Every switches the kind; the time doesn't carry over into it.
  await call('schedule_edit', { schedule: added.id, every: 2, unit: 'minutes' });
  const every = (await stored(added.id)).when;
  assert.deepEqual([every.kind, every.every, every.unit], ['every', 2, 'minutes']);
  assert.match((await call('schedule_edit', { schedule: added.id })).error, /Say what to change/);
  assert.match((await call('schedule_edit', { schedule: added.id, name: ' ' })).error, /needs a name/);
  assert.match((await call('schedule_edit', { schedule: 'nope', name: 'x' })).error, /no schedule nope/);
});

step('a changed agent prompt only reads files again; a new name keeps what the user allowed', async () => {
  const added = await call('schedule_add', { name: 'Review', what: 'agent', prompt: 'Look at the diff', at: '09:00' });
  await app.eval(async (t, id) => {
    const { scheduleById, saveSchedule } = await t.import('schedules.js');
    saveSchedule({ .../** @type {any} */ (scheduleById(id)), allowChanges: true });
  }, added.id);
  await call('schedule_edit', { schedule: added.id, name: 'Morning review' });
  assert.equal((await stored(added.id)).allowChanges, true);
  await call('schedule_edit', { schedule: added.id, prompt: 'Look at the diff and fix it' });
  const s = await stored(added.id);
  assert.equal(s.prompt, 'Look at the diff and fix it');
  assert.equal(s.allowChanges, false);
});

step('delete_schedule deletes it, and the open Schedules window follows', async () => {
  const added = await call('schedule_add', { name: 'Doomed', command: 'echo bye', at: '10:00' });
  await app.eval(async (t, id) => (await t.import('scheduleswindow.js')).openSchedules({ scheduleId: id }), added.id);
  const fields = () => app.eval(t => t.$$('.schedules-win input, .schedules-win textarea').map(i => /** @type {HTMLInputElement} */ (i).value));
  assert.ok((await fields()).includes('echo bye'), 'the form shows it');
  await call('schedule_edit', { schedule: added.id, command: 'echo changed' });
  assert.ok((await fields()).includes('echo changed'), 'the form follows the edit');
  await app.screenshot('edited-in-form');
  const done = await call('schedule_delete', { schedule: added.id });
  assert.deepEqual(done, { deleted: added.id, name: 'Doomed' });
  assert.equal(await stored(added.id), null);
  assert.match((await call('schedule_delete', { schedule: added.id })).error, /no schedule/);
  assert.ok(!(await fields()).includes('Doomed'), 'the deleted schedule left the form');
});
