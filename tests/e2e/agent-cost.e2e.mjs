// An agent's cost in the sidebar (js/cost.js, js/sidebar.js) follows Settings › Terminal › Agent cost at once, without
// anything else having to draw the sidebar again. Run with: npm run e2e (on Linux, under Xvfb).
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

/** Picks a choice of Agent cost in Settings, as the user does, and closes Settings. @param {string} value */
const choose = value => app.eval(async (t, value) => {
  (await t.import('settings.js')).openSettings('terminal');
  await t.waitFor(`[data-setting="agents.costDisplay"] [data-value="${value}"]`);
  t.click(`[data-setting="agents.costDisplay"] [data-value="${value}"]`);
  await new Promise(r => setTimeout(r, 150));
  (await t.import('settings/page.js')).closeSettings();
  await new Promise(r => setTimeout(r, 100));
}, value);

/** What the sidebar shows: the terminal's cost chip, and its workspace's cost. */
const shown = () => app.eval(t => ({
  chip: t.$('#sidebar .cost-chip')?.textContent.trim() ?? null,
  workspace: t.$('#sidebar .ws-cost')?.textContent.trim() ?? null,
}));

before(async () => {
  app = await startApp({ name: 'agent-cost' });
  await app.waitFor('.pane .xterm');
  // No welcome tour: its card would sit over Settings.
  await app.eval(async t => {
    const { GROUPS } = await t.import('store.js');
    (await t.import('preferences.js')).updateSettings(GROUPS.uiState, { tourSeen: true });
    const tour = await t.import('tour.js');
    if (tour.tourActive()) tour.stopTour();
  });
  // An agent that has cost $1.84 in the first terminal, as its hooks report it.
  await app.eval(async t => {
    const { state, emit, EVENTS } = await t.import('store.js');
    const tab = [...state.tabs.values()][0];
    tab.cost = { usd: 1.84, durationMs: 1000 };
    emit(EVENTS.tab, tab);
  });
  await app.waitFor('#sidebar .cost-chip');
});

after(async () => { await app?.stop({ failed }); });

step('Off takes the costs out of the sidebar at once, and Dollars brings them back', async () => {
  assert.deepEqual(await shown(), { chip: '$1.84', workspace: '$1.84' });
  await choose('off');
  assert.deepEqual(await shown(), { chip: null, workspace: null });
  await choose('tokens');
  assert.equal((await shown()).workspace, null);
  await choose('cost');
  assert.deepEqual(await shown(), { chip: '$1.84', workspace: '$1.84' });
});
