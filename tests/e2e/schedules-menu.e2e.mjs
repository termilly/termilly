// Right-clicks in the Schedules window (js/scheduleswindow.js): the browser's menu shows nowhere in it, text fields
// included, and a schedule in the list has its own menu to run or delete it. Run with: npm run e2e (on Linux, under Xvfb).
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

step('no browser menu anywhere in the window, text fields included', async () => {
  const shown = await app.eval(t => ['[name="name"]', '.sch-edit', '.sch-list'].map(selector => {
    const el = t.$(selector);
    const realm = el.ownerDocument.defaultView;
    // dispatchEvent is false once a listener took the browser's menu away.
    return el.dispatchEvent(new realm.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }));
  assert.deepEqual(shown, [false, false, false]);
  assert.equal(await menuShown(), null);
});

step('a schedule in the list runs from its menu, the one shown staying', async () => {
  await app.eval(t => t.contextmenu('.sch-list [data-id="s2"]'));
  assert.deepEqual(await menuShown(), ['Run', 'Delete']);
  await app.eval(t => t.click('.context-menu .menu-row'));
  const after = await app.eval(async t => {
    const { runsOf } = await t.import('schedules.js');
    return { runs: runsOf('s2').length, shown: t.$('.sch-list .selected')?.dataset.id };
  });
  assert.deepEqual(after, { runs: 1, shown: 's1' });
});

step('Delete in its menu asks first, then the schedule goes', async () => {
  await app.eval(t => t.contextmenu('.sch-list [data-id="s2"]'));
  await app.eval(t => t.$$('.context-menu .menu-row').find(b => b.querySelector('.menu-label').textContent.trim() === 'Delete').click());
  await app.waitFor('.dialog-actions [data-ok]', { text: 'Delete' });
  await app.click('.dialog-actions [data-ok]');
  const left = await app.eval(async t => {
    for (let i = 0; i < 50 && t.$('.sch-list [data-id="s2"]'); i++) await new Promise(r => setTimeout(r, 50));
    return { ids: (await t.import('schedules.js')).schedules().map(s => s.id), shown: t.$('.sch-list .selected')?.dataset.id };
  });
  assert.deepEqual(left, { ids: ['s1'], shown: 's1' });
});
