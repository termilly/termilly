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

/**
 * Picks a choice of Agent cost in Settings, as the user does, and reads the sidebar (behind Settings) two frames
 * later: soon enough that nothing else has drawn it again in between.
 * @param {string} value
 */
const choose = value => app.eval(async (t, value) => {
  const frame = () => new Promise(r => globalThis.requestAnimationFrame(() => r(undefined)));
  await t.waitFor(`[data-setting="agents.costDisplay"] [data-value="${value}"]`);
  t.click(`[data-setting="agents.costDisplay"] [data-value="${value}"]`);
  const { state } = await t.import('store.js');
  for (let i = 0; i < 50 && state.settings.agents.costDisplay !== value; i++) await new Promise(r => setTimeout(r, 10));
  await frame();
  await frame();
  return {
    chip: t.$('#sidebar .cost-chip')?.textContent.trim() ?? null,
    workspace: t.$('#sidebar .ws-cost')?.textContent.trim() ?? null,
  };
}, value);

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
  // An agent in the first terminal that has cost $1.84 for 1,500 tokens, as its hooks and transcript report it.
  await app.eval(async t => {
    const { state, emit, EVENTS } = await t.import('store.js');
    const tab = [...state.tabs.values()][0];
    tab.cost = { usd: 1.84, durationMs: 1000 };
    tab.claude = { ...tab.claude, usage: { input: 1000, cacheWrite: 0, cacheRead: 0, output: 500 } };
    emit(EVENTS.tab, tab);
  });
  await app.waitFor('#sidebar .cost-chip');
  await app.eval(async t => (await t.import('settings.js')).openSettings('terminal'));
});

after(async () => { await app?.stop({ failed }); });

step('the sidebar shows each choice of Agent cost at once', async () => {
  assert.deepEqual(await choose('cost'), { chip: '$1.84', workspace: '$1.84' });
  assert.deepEqual(await choose('off'), { chip: null, workspace: null });
  const tokens = await choose('tokens');
  assert.match(tokens.chip ?? '', /tok$/);
  assert.equal(tokens.workspace, null);
  assert.deepEqual(await choose('cost'), { chip: '$1.84', workspace: '$1.84' });
});
