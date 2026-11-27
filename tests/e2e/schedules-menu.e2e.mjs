// Right-clicks in the Schedules window (js/scheduleswindow.js): the browser's menu shows nowhere in it, text fields
// included, and a schedule in the list has its own menu to run or delete it. Run with: npm run e2e (on Linux, under Xvfb).
// Covers: js/schedule*.js js/popups.js
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

/** The labels of the right-click menu open now, or null when none is. */
const menuShown = () => app.eval(t => {
  const menu = t.$('.context-menu');
  return menu ? t.$$('.context-menu .menu-row').map(b => b.querySelector('.menu-label').textContent.trim()) : null;
});

before(async () => {
  app = await startApp({ name: 'schedules-menu' });
  await app.waitFor('.pane .xterm');
  await app.eval(async t => {
    const { saveSchedule } = await t.import('schedules.js');
    const { newSchedule } = await t.import('schedulerules.js');
    for (const [id, name] of [['s1', 'Nightly'], ['s2', 'Other']]) saveSchedule({ ...newSchedule(id), name, command: 'echo hi', on: false });
    (await t.import('scheduleswindow.js')).openSchedules({ scheduleId: 's1' });
    await t.waitFor('.sch-list [data-id="s2"]');
  });
});

after(async () => { await app?.stop({ failed }); });

step('no browser menu anywhere in its own window; a text field there gets Termilly\'s text menu', async () => {
  const shown = await app.eval(t => {
    const own = t.$('.sch-list').ownerDocument;
    // Its lists, its window's own edges (outside the panel), then a text field.
    return [t.$('.sch-edit'), t.$('.sch-list'), own.documentElement, t.$('[name="name"]')].map(el => {
      const realm = el.ownerDocument.defaultView;
      // dispatchEvent is false once a listener took the browser's menu away.
      return el.dispatchEvent(new realm.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
  });
  assert.deepEqual(shown, [false, false, false, false]);
  assert.deepEqual(await menuShown(), ['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all']);
  await app.eval(async t => (await t.import('popups.js')).closeAll());
  assert.equal(await menuShown(), null);
});

step('a schedule in the list runs from its menu, the one shown staying', async () => {
  await app.eval(t => t.contextmenu('.sch-list [data-id="s2"]'));
  assert.deepEqual(await menuShown(), ['Run', 'Delete']);
  await app.eval(t => t.click('.context-menu .menu-row'));
  const after = await app.eval(async t => {
    const { runsOf } = await t.import('schedules.js');
    // It ran, and worked: a run that failed to start leaves a record too.
    let run;
    for (let i = 0; i < 100 && (!(run = runsOf('s2')[0]) || run.status === 'running'); i++) await new Promise(r => setTimeout(r, 100));
    return { runs: runsOf('s2').length, status: run?.status, shown: t.$('.sch-list .selected')?.dataset.id };
  });
  assert.deepEqual(after, { runs: 1, status: 'worked', shown: 's1' });
});

step('Run is off for the shown schedule while its changes are not saved', async () => {
  const run = await app.eval(async t => {
    const name = t.$('[name="name"]');
    name.value = 'Nightly changed';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    t.contextmenu('.sch-list [data-id="s1"]');
    const rows = t.$$('.context-menu .menu-row');
    const off = rows.find(b => b.querySelector('.menu-label').textContent.trim() === 'Run')?.disabled;
    rows[0].ownerDocument.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    name.value = 'Nightly';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    return off;
  });
  assert.equal(run, true);
});

step('Delete in its menu asks first, then the schedule goes', async () => {
  await app.eval(t => t.contextmenu('.sch-list [data-id="s2"]'));
  await app.eval(t => t.$$('.context-menu .menu-row').find(b => b.querySelector('.menu-label').textContent.trim() === 'Delete').click());
  await app.waitFor('.dialog-actions [data-ok]', { text: 'Delete' });
  // Still there while it asks, and the question has no browser menu either.
  const asking = await app.eval(async t => {
    const dialog = t.$('.dialog-actions [data-ok]').closest('.modal-layer');
    const realm = dialog.ownerDocument.defaultView;
    return {
      kept: !!(await t.import('schedules.js')).scheduleById('s2'),
      browserMenu: dialog.dispatchEvent(new realm.MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    };
  });
  assert.deepEqual(asking, { kept: true, browserMenu: false });
  await app.click('.dialog-actions [data-ok]');
  const left = await app.eval(async t => {
    for (let i = 0; i < 50 && t.$('.sch-list [data-id="s2"]'); i++) await new Promise(r => setTimeout(r, 50));
    return { ids: (await t.import('schedules.js')).schedules().map(s => s.id), shown: t.$('.sch-list .selected')?.dataset.id };
  });
  assert.deepEqual(left, { ids: ['s1'], shown: 's1' });
});
