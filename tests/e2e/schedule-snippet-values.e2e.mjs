// A schedule that runs a snippet with variables: the form asks for the values a picked snippet needs in a popup, keeps
// them with the schedule and runs the snippet with them; a run whose snippet gained a variable since fails and says which;
// add_schedule takes them as vars. Run with: npm run e2e (on Linux, under Xvfb).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';

const SNIPPET = 'Greet';
const COMMAND = 'echo hello-{{who}}-{{n=3}}';
const OTHER = { name: 'Wave', command: 'echo wave-{{name}}' };

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

/** Saves this computer's snippets. @param {{ name: string, command: string }[]} snippets */
const setSnippets = snippets => app.eval(async (t, snippets) => {
  const { GROUPS } = await t.import('store.js');
  const { updateSettings } = await t.import('preferences.js');
  updateSettings(GROUPS.commands, { snippets: snippets.map((s, i) => ({ id: `e2e${i}`, ...s })) });
}, snippets);

/** The shown schedule's form: its problem, its values line, and whether Save can be pressed. */
const form = () => app.eval(t => ({
  problem: t.$('.sch-problem')?.textContent.trim() ?? '',
  values: t.$('.sch-values-text')?.textContent.trim() ?? null,
  canSave: !t.$('[data-sch="save"]')?.disabled,
}));

/** Waits for a schedule's latest run to end; that run. @param {string} id */
const ended = id => app.eval(async (t, id) => {
  const { runsOf } = await t.import('schedules.js');
  for (let i = 0; i < 100; i++) {
    const run = runsOf(id).sort((a, b) => b.at - a.at)[0];
    if (run && run.status !== 'running') return run;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}, id);

before(async () => {
  app = await startApp({ name: 'schedule-snippet-values' });
  await app.waitFor('.pane .xterm');
  await setSnippets([{ name: SNIPPET, command: COMMAND }, OTHER]);
});

after(async () => { await app?.stop({ failed }); });

step('picking a snippet with a variable asks for it, and the form keeps the values', async () => {
  await app.eval(async t => {
    (await t.import('scheduleswindow.js')).openSchedules();
    await t.waitFor('[data-sch="add"]');
    t.$('[data-sch="add"]').click();
    await t.waitFor('[data-seg="what"][data-value="snippet"]');
    t.$('[data-seg="what"][data-value="snippet"]').click();
  });
  await app.waitFor('.snippet-run [data-var="who"]');
  // OK waits for the value without a default; the one with a default is filled in.
  const asked = await app.eval(t => ({ ok: t.$('.snippet-run [data-ok]').disabled, n: t.$('.snippet-run [data-var="n"]').value, label: t.$('.snippet-run [data-ok]').textContent.trim() }));
  assert.deepEqual(asked, { ok: true, n: '3', label: 'OK' });
  await app.eval(t => {
    const who = t.$('.snippet-run [data-var="who"]');
    who.value = 'ada';
    who.dispatchEvent(new Event('input', { bubbles: true }));
    t.$('.snippet-run [data-ok]').click();
  });
  await app.eval(t => t.waitFor('.sch-values-text'));
  const shown = await form();
  assert.equal(shown.values, 'who: ada, n: 3');
  assert.equal(shown.problem, '');
  assert.equal(shown.canSave, true);
});

step('cancelled, the form says what it needs; Values asks again', async () => {
  await app.eval(async t => {
    t.$('[data-sch="values"]').click();
    await t.waitFor('.snippet-run [data-var="who"]');
    t.$('.snippet-run [data-cancel]').click();
  });
  assert.equal((await form()).values, 'who: ada, n: 3'); // cancelling keeps what was there
  // Another snippet starts without values: its popup cancelled, the form can't be saved and says why.
  await app.eval(async t => {
    const select = t.$('.schedules-win select[name="snippet"]');
    select.value = 'Wave';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await t.waitFor('.snippet-run [data-var="name"]');
    t.$('.snippet-run [data-cancel]').click();
  });
  const shown = await form();
  assert.equal(shown.values, 'name: needs a value');
  assert.equal(shown.problem, 'It needs a value for name.');
  assert.equal(shown.canSave, false);
});

step('a saved schedule runs the snippet with its values', async () => {
  const id = await app.eval(async (t, snippet) => {
    const { saveSchedule, runNow } = await t.import('schedules.js');
    const { newSchedule } = await t.import('schedulerules.js');
    const s = { ...newSchedule('e2e-greet'), name: 'Greet ada', what: 'snippet', snippet, values: { who: 'ada' }, on: false };
    saveSchedule(s);
    runNow(s.id);
    return s.id;
  }, SNIPPET);
  const run = await ended(id);
  assert.equal(run?.status, 'worked', run?.summary);
  const report = await app.eval(async (t, runId) => (await t.import('schedulereport.js')).reportText(runId), run.id);
  assert.match(report, /hello-ada-3/);
});

step('a snippet that gained a variable since fails its run and says which', async () => {
  await setSnippets([{ name: SNIPPET, command: `${COMMAND} {{place}}` }, OTHER]);
  await app.eval(async t => (await t.import('schedules.js')).runNow('e2e-greet'));
  const run = await ended('e2e-greet');
  assert.equal(run.status, 'failed');
  assert.equal(run.summary, `The snippet ${SNIPPET} needs a value for place.`);
  await setSnippets([{ name: SNIPPET, command: COMMAND }, OTHER]);
});

step('add_schedule takes the values as vars, and refuses a snippet without them', async () => {
  const call = args => app.eval(async (t, args) => {
    try {
      return await (await t.import('api.js')).callApi('schedule_add', args);
    } catch (e) {
      return { error: e.message };
    }
  }, args);
  assert.match((await call({ name: 'No vars', what: 'snippet', snippet: SNIPPET, at: '20:00' })).error, /needs values for: who/);
  const added = await call({ name: 'With vars', what: 'snippet', snippet: SNIPPET, vars: { who: 'bob', n: '' }, at: '20:00' });
  assert.deepEqual(added.vars, { who: 'bob' }); // an empty one runs with its default
  const edit = args => app.eval(async (t, args) => {
    try {
      return await (await t.import('api.js')).callApi('schedule_edit', args);
    } catch (e) {
      return { error: e.message };
    }
  }, args);
  // Run as a command, the values go; back to the snippet, it needs them again.
  await edit({ schedule: added.id, what: 'command', command: 'echo x' });
  assert.match((await edit({ schedule: added.id, what: 'snippet', snippet: SNIPPET })).error, /needs values for: who/);
  assert.match((await edit({ schedule: added.id, vars: { who: 'x' } })).error, /vars are for what = snippet/);
});

step('a variable named like an object property still needs its value', async () => {
  await setSnippets([{ name: 'Proto', command: 'echo {{constructor}}' }]);
  const missing = await app.eval(async t => {
    const { missingValues, fill } = await t.import('snippets.js');
    return { missing: missingValues('echo {{constructor}}', {}), filled: fill('echo {{constructor}}', {}) };
  });
  assert.deepEqual(missing, { missing: ['constructor'], filled: 'echo ' });
});
