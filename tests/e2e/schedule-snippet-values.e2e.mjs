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
  // A schedule uses no defaults: the one with a default isn't filled in, and OK waits for both.
  const asked = await app.eval(t => ({ ok: t.$('.snippet-run [data-ok]').disabled, n: t.$('.snippet-run [data-var="n"]').value, label: t.$('.snippet-run [data-ok]').textContent.trim() }));
  assert.deepEqual(asked, { ok: true, n: '', label: 'OK' });
  const okWithWhoOnly = await app.eval(t => {
    const type = (name, value) => {
      const field = t.$(`.snippet-run [data-var="${name}"]`);
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    type('who', 'ada');
    const ok = !t.$('.snippet-run [data-ok]').disabled;
    type('n', '5');
    t.$('.snippet-run [data-ok]').click();
    return ok;
  });
  assert.equal(okWithWhoOnly, false);
  await app.eval(t => t.waitFor('.sch-values-text'));
  const shown = await form();
  assert.equal(shown.values, 'who: ada, n: 5');
  assert.equal(shown.problem, '');
  assert.equal(shown.canSave, true);
});

step('cancelled, the form says what it needs; Values asks again', async () => {
  await app.eval(async t => {
    t.$('[data-sch="values"]').click();
    await t.waitFor('.snippet-run [data-var="who"]');
    t.$('.snippet-run [data-cancel]').click();
  });
  assert.equal((await form()).values, 'who: ada, n: 5'); // cancelling keeps what was there
  // Another snippet starts without values: its popup cancelled, Save says in a box which ones are missing.
  // Picked from the snippets list with its search, as in the title bar; it picks, nothing runs.
  const listed = await app.eval(async t => {
    t.$('[data-sch="pickSnippet"]').click();
    await t.waitFor('.sp-pop.sp-picking .sp-row');
    const rows = () => t.$$('.sp-pop .sp-row .sp-name').map(r => r.textContent);
    const all = rows();
    const input = t.$('.sp-pop input');
    input.value = 'wav';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const doc = t.$('.schedules-win').ownerDocument;
    return {
      all, found: rows(), selected: t.$('.sp-pop .sp-row.sel .sp-name')?.textContent, runHints: t.$$('.sp-pop .sp-run').some(e => e.offsetParent),
      // In the Schedules window's own window, where it has one.
      sameWindow: t.$('.sp-pop').ownerDocument === doc, windowed: doc.body.classList.contains('detached-window'),
    };
  });
  assert.deepEqual(listed, { all: [SNIPPET, 'Wave'], found: ['Wave'], selected: 'Wave', runHints: false, sameWindow: true, windowed: true });
  await app.eval(async t => {
    t.$('.sp-pop input').dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await t.waitFor('.snippet-run [data-var="name"]');
    t.$('.snippet-run [data-cancel]').click();
  });
  const shown = await form();
  assert.equal(shown.values, 'name: needs a value');
  assert.equal(shown.problem, '');
  assert.equal(shown.canSave, true);
  const box = await app.eval(async t => {
    const before = (await t.import('schedules.js')).schedules().length;
    t.$('[data-sch="save"]').click();
    await t.waitFor('.confirm h3');
    const said = { title: t.$('.confirm h3').textContent, body: t.$('.confirm .dialog-sub').textContent };
    t.$('.confirm [data-ok]').click();
    return { ...said, saved: (await t.import('schedules.js')).schedules().length !== before };
  });
  assert.deepEqual(box, { title: 'Values missing', body: 'Fill in name with the Values button. A schedule doesn\'t use defaults.', saved: false });
  assert.equal(await app.eval(t => t.$('[data-sch="pickSnippet"] .dropdown-label').textContent), 'Wave');
  // Opened again, the list starts on the snippet picked.
  const selected = await app.eval(async t => {
    t.$('[data-sch="pickSnippet"]').click();
    await t.waitFor('.sp-pop.sp-picking .sp-row.sel');
    const name = t.$('.sp-pop .sp-row.sel .sp-name').textContent;
    t.$('.sp-pop input').dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return name;
  });
  assert.equal(selected, 'Wave');
});

step('the title bar\'s snippets list still runs, in the main window, after the Schedules window picked from it', async () => {
  const shown = await app.eval(async t => {
    (await t.import('snippetpick.js')).openSnippetPick();
    await t.waitFor('.sp-pop .sp-row');
    const pop = t.$('.sp-pop');
    const result = {
      main: pop.ownerDocument === globalThis.document, picking: pop.classList.contains('sp-picking'),
      runHints: t.$$('.sp-pop .sp-run').filter(e => e.offsetParent).length, acts: t.$$('.sp-pop .sp-acts').length > 0,
    };
    t.$('.sp-pop input').dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return result;
  });
  assert.deepEqual(shown, { main: true, picking: false, runHints: 5, acts: true });
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

step('a schedule saved with a default left out is saved again only with it, in the form and by an agent', async () => {
  // e2e-greet has who but not n, whose default it ran with before every value was needed.
  const box = await app.eval(async t => {
    (await t.import('scheduleswindow.js')).openSchedules({ scheduleId: 'e2e-greet' });
    await t.waitFor('.sch-values-text');
    const name = t.$('[name="name"]');
    name.value = 'Greet ada again';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    t.$('[data-sch="save"]').click();
    await t.waitFor('.confirm h3');
    const said = t.$('.confirm .dialog-sub').textContent;
    t.$('.confirm [data-ok]').click();
    return { said, name: (await t.import('schedules.js')).scheduleById('e2e-greet').name };
  });
  assert.deepEqual(box, { said: 'Fill in n with the Values button. A schedule doesn\'t use defaults.', name: 'Greet ada' });
  const renamed = await app.eval(async t => {
    try {
      return await (await t.import('api.js')).callApi('schedule_edit', { schedule: 'e2e-greet', name: 'Renamed' });
    } catch (e) {
      return { error: e.message };
    }
  });
  assert.match(renamed.error, /needs values for: n\./);
});

step('a snippet run outside a schedule still starts from its defaults', async () => {
  const n = await app.eval(async (t, command) => {
    const { askValues, placeholders } = await t.import('snippets.js');
    const asked = askValues({ id: 'e2e0', name: 'Greet', command }, placeholders(command), []);
    await t.waitFor('.snippet-run [data-var="n"]');
    const value = t.$('.snippet-run [data-var="n"]').value;
    t.$('.snippet-run [data-cancel]').click();
    await asked;
    return value;
  }, COMMAND);
  assert.equal(n, '3');
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
  // An empty value is none, and a default doesn't stand in for it.
  assert.match((await call({ name: 'Empty n', what: 'snippet', snippet: SNIPPET, vars: { who: 'bob', n: '' }, at: '20:00' })).error, /needs values for: n\./);
  const added = await call({ name: 'With vars', what: 'snippet', snippet: SNIPPET, vars: { who: 'bob', n: '4' }, at: '20:00' });
  assert.deepEqual(added.vars, { who: 'bob', n: '4' });
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
  // New values replace the old ones: leaving out the one with a default is leaving it without a value.
  assert.match((await edit({ schedule: added.id, what: 'snippet', snippet: SNIPPET, vars: { who: 'x' } })).error, /needs values for: n\./);
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
