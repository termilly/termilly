// edit_schedule and delete_schedule, as an agent's call reaches the page (js/scheduleagent.js): what's given changes and
// the rest stays, a new kind of when starts afresh, what the user allowed an agent schedule stays unless the edit lowers
// it (never raises it), and a deleted schedule
// leaves the open Schedules window. Run with: npm run e2e (on Linux, under Xvfb).
// Covers: js/schedule*.js src/Termilly.Agent/Api.cs src/Termilly.App/Features/Schedules.cs
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

/** What the user allowed an agent schedule, as the Schedules window saves it. @param {string} id @param {{ allowChanges: boolean, allowAll: boolean }} allowed */
const allow = (id, allowed) => app.eval(async (t, id, allowed) => {
  const { scheduleById, saveSchedule } = await t.import('schedules.js');
  saveSchedule({ .../** @type {any} */ (scheduleById(id)), ...allowed });
}, id, allowed);
/** @param {string} id */
const allowed = async id => { const s = await stored(id); return [s.allowChanges, s.allowAll]; };
const EVERYTHING = { allowChanges: true, allowAll: true };

step('an edit keeps what the user allowed an agent schedule: a new prompt or folder too', async () => {
  const added = await call('schedule_add', { name: 'Review', what: 'agent', prompt: 'Look at the diff', at: '09:00' });
  assert.deepEqual(await allowed(added.id), [false, false], 'a new one only reads files');
  await allow(added.id, EVERYTHING);
  await call('schedule_edit', { schedule: added.id, name: 'Morning review' });
  await call('schedule_edit', { schedule: added.id, prompt: 'Look at the diff and fix it' });
  await call('schedule_edit', { schedule: added.id, cwd: '/somewhere/else' });
  const s = await stored(added.id);
  assert.deepEqual([s.prompt, s.cwd], ['Look at the diff and fix it', '/somewhere/else']);
  assert.deepEqual(await allowed(added.id), [true, true]);
  assert.equal((await call('schedules', {})).schedules.find(x => x.id === added.id).permissions, 'everything');
  // A command schedule turned into an agent one starts at reading files, as a new one does.
  const command = await call('schedule_add', { name: 'Was a command', command: 'echo hi', at: '09:00' });
  await app.eval(async (t, id) => {
    const { scheduleById, saveSchedule } = await t.import('schedules.js');
    saveSchedule({ .../** @type {any} */ (scheduleById(id)), allowChanges: true, allowAll: true, agent: 'gone-agent' });
  }, command.id);
  await call('schedule_edit', { schedule: command.id, what: 'agent', prompt: 'Now a prompt' });
  assert.deepEqual(await allowed(command.id), [false, false]);
  assert.equal((await stored(command.id)).agent, 'gone-agent', 'the agent it had stays');
});

step('edit_schedule permissions only lowers what the user allowed', async () => {
  const added = await call('schedule_add', { name: 'Fixer', what: 'agent', prompt: 'Fix lint', at: '09:00' });
  await allow(added.id, EVERYTHING);
  await call('schedule_edit', { schedule: added.id, permissions: 'change_files' });
  assert.deepEqual(await allowed(added.id), [true, false]);
  assert.match((await call('schedule_edit', { schedule: added.id, permissions: 'everything' })).error, /only the user allows more/);
  await call('schedule_edit', { schedule: added.id, permissions: 'change_files' });
  assert.deepEqual(await allowed(added.id), [true, false], 'the same level is no change');
  await call('schedule_edit', { schedule: added.id, permissions: 'read_only' });
  assert.deepEqual(await allowed(added.id), [false, false]);
  assert.match((await call('schedule_edit', { schedule: added.id, permissions: 'change_files' })).error, /only the user allows more/);
  assert.deepEqual(await allowed(added.id), [false, false]);
  assert.match((await call('schedule_edit', { schedule: added.id, permissions: 'all' })).error, /read_only, change_files or everything/);
  const command = await call('schedule_add', { name: 'Plain', command: 'echo hi', at: '09:00' });
  assert.match((await call('schedule_edit', { schedule: command.id, permissions: 'read_only' })).error, /agent schedules/);
});

step('on_start: false alone keeps the time; a production schedule keeps what it runs', async () => {
  const added = await call('schedule_add', { name: 'Timed', command: 'echo t', at: '06:45' });
  await call('schedule_edit', { schedule: added.id, on_start: false });
  assert.deepEqual([(await stored(added.id)).when.kind, (await stored(added.id)).when.at], ['time', '06:45']);
  await app.eval(async (t, id) => {
    const { state } = await t.import('store.js');
    const { scheduleById, saveSchedule } = await t.import('schedules.js');
    state.profiles.push(/** @type {any} */ ({ id: 'prod-shell', name: 'Prod', tags: ['prod'] }));
    saveSchedule({ .../** @type {any} */ (scheduleById(id)), profile: 'prod-shell' });
  }, added.id);
  assert.match((await call('schedule_edit', { schedule: added.id, command: 'rm -rf /' })).error, /runs on production/);
  assert.match((await call('schedule_edit', { schedule: added.id, cwd: '/' })).error, /runs on production/);
  assert.equal((await stored(added.id)).command, 'echo t');
  // One that types into a terminal: which one it finds is only known when it runs.
  await app.eval(async (t, id) => {
    const { scheduleById, saveSchedule } = await t.import('schedules.js');
    saveSchedule({ .../** @type {any} */ (scheduleById(id)), profile: null, where: 'terminal', terminal: 'Web' });
  }, added.id);
  assert.match((await call('schedule_edit', { schedule: added.id, command: 'echo other' })).error, /types into a terminal/);
  // Its name and time are still the agent's to change.
  await call('schedule_edit', { schedule: added.id, name: 'Timed, renamed', at: '07:00' });
  assert.equal((await stored(added.id)).name, 'Timed, renamed');
  await call('schedule_delete', { schedule: added.id });
  await app.eval(async t => {
    const { state } = await t.import('store.js');
    state.profiles = state.profiles.filter(p => p.id !== 'prod-shell');
  });
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
