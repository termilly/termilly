// A schedule's Clear button in its Runs view (js/scheduleswindow.js): it asks first, then the runs that ended go with
// their reports, while a run going on and another schedule's runs stay. Run with: npm run e2e (on Linux, under Xvfb).
// Covers: js/schedule*.js src/Termilly.App/Features/Schedules.cs
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

/** Two schedules, the first with runs that ended and one going on, the second with one that ended; each has a report. */
const seed = () => app.eval(async t => {
  const { state, emit, EVENTS } = await t.import('store.js');
  const { send } = await t.import('host.js');
  const { PAGE } = await t.import('protocol.js');
  const { saveSchedule } = await t.import('schedules.js');
  const { newSchedule, RUN } = await t.import('schedulerules.js');
  for (const [id, name] of [['s1', 'Nightly'], ['s2', 'Other']]) saveSchedule({ ...newSchedule(id), name, command: 'echo hi', on: false });
  const run = (id, scheduleId, status) => ({ id, scheduleId, name: scheduleId, at: Date.now(), ms: 0, status, code: null, summary: id });
  state.schedules.runs = [run('going', 's1', RUN.running), run('worked', 's1', RUN.worked), run('failed', 's1', RUN.failed), run('elsewhere', 's2', RUN.worked)];
  for (const r of state.schedules.runs) send(PAGE.scheduleKeep, { runId: r.id, output: `output of ${r.id}` });
  emit(EVENTS.schedules);
});

/** The runs' ids, and which of them still have a report. */
const kept = () => app.eval(async t => {
  const { state } = await t.import('store.js');
  const { readReport } = await t.import('schedulereport.js');
  const reports = [];
  for (const id of ['going', 'worked', 'failed', 'elsewhere']) if (await readReport(id) !== null) reports.push(id);
  return { runs: state.schedules.runs.map(r => r.id), reports };
});

before(async () => {
  app = await startApp({ name: 'schedules-clear' });
  await app.waitFor('.pane .xterm');
  await seed();
});

after(async () => { await app?.stop({ failed }); });

step('every run starts with its report kept', async () => {
  assert.deepEqual(await kept(), { runs: ['going', 'worked', 'failed', 'elsewhere'], reports: ['going', 'worked', 'failed', 'elsewhere'] });
});

step('Clear asks first, and Cancel keeps everything', async () => {
  await app.eval(async t => (await t.import('scheduleswindow.js')).openSchedules({ scheduleId: 's1', runId: 'worked' }));
  await app.waitFor('.sch-report', { text: 'output of worked' });
  await app.click('.sch-runs-head [data-sch="clear"]');
  await app.waitFor('.dialog-actions [data-ok]', { text: 'Clear' });
  await app.screenshot('clear-asks');
  await app.click('.dialog-actions [data-cancel]');
  await app.waitFor('.dialog-actions [data-ok]', { gone: true });
  assert.deepEqual((await kept()).runs, ['going', 'worked', 'failed', 'elsewhere']);
});

step('Clear takes the ended runs and their reports; the run going on and the other schedule\'s stay', async () => {
  await app.click('.sch-runs-head [data-sch="clear"]');
  await app.click('.dialog-actions [data-ok]');
  await app.waitFor('.sch-run[data-run="worked"]', { gone: true });
  await app.waitFor('.sch-run[data-run="going"]');
  assert.equal(await app.eval(t => t.visible('.sch-report')), false, 'the cleared run\'s report is closed');
  assert.equal(await app.eval(t => t.visible('.sch-runs-head')), false, 'nothing left to clear: no Clear button');
  assert.deepEqual(await kept(), { runs: ['going', 'elsewhere'], reports: ['going', 'elsewhere'] });
  await app.screenshot('cleared');
});
