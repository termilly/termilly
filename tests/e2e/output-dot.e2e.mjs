// The grey new-output dot of a terminal out of sight, end to end: an agent's first report takes back the dot its own
// start drew (a resumed Claude Code draws before its hooks say it's there), and nothing else does.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { until, skipTour } from './gitsteps.mjs';

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
 * The first workspace's terminal, out of sight: its output while away, then what its agent reports, as the host's
 * agent message does (main.js). Returns whether its dot shows, in the state and on its sidebar row.
 * @param {{ agent: object | null, reportedBefore?: boolean, report?: object | null }} scene
 */
const dotAfter = scene => app.eval(async (t, scene) => {
  const { state, emit, EVENTS } = await t.import('store.js');
  const { noteOutput, agentReported } = await t.import('panes.js');
  const tab = [...state.tabs.values()].find(x => x.wsId === state.workspaces[0].id);
  tab.attention = false;
  tab.quietUntil = 0;
  tab.agent = scene.agent;
  noteOutput(tab);
  if (scene.agent && !tab.attention) {
    tab.attention = true; // an agent already reporting draws no dot itself: one from before it
    emit(EVENTS.tab, tab);
  }
  if (scene.report !== undefined) {
    tab.agent = scene.report;
    agentReported(tab, scene.reportedBefore ?? false);
  }
  return tab.attention;
}, scene);

before(async () => {
  app = await startApp({ name: 'output-dot' });
  await app.waitFor('.pane .xterm');
  await skipTour(app);
  await app.eval(async t => (await t.import('workspaces.js')).createWorkspace({ name: 'second' }));
  await until(() => app.eval(async t => {
    const { state } = await t.import('store.js');
    return state.activeId !== state.workspaces[0].id;
  }), 'the second workspace shown');
});

after(async () => { await app?.stop({ failed }); });

step('a terminal out of sight that prints gets the dot', async () => {
  assert.equal(await dotAfter({ agent: null }), true);
  await until(() => app.eval(t => !!t.$('#sidebar .attn')), 'the dot on its sidebar row');
});

step('Claude Code reporting in for the first time takes back the dot its start drew', async () => {
  assert.equal(await dotAfter({ agent: null, report: { source: 'hooks', kind: 'claude', state: 'idle' } }), false);
  await until(() => app.eval(t => !t.$('#sidebar .attn')), 'the dot gone from its sidebar row');
  assert.equal(await dotAfter({ agent: null, report: { source: 'poll', kind: 'claude', state: 'idle' } }), false, 'the poll counts too');
});

step('the dot stays for later reports, an agent that exits, and an agent that does not report', async () => {
  const reporting = { source: 'hooks', kind: 'claude', state: 'working' };
  assert.equal(await dotAfter({ agent: reporting, reportedBefore: true, report: { ...reporting, state: 'idle' } }), true, 'a later report');
  assert.equal(await dotAfter({ agent: reporting, reportedBefore: true, report: null }), true, 'its agent exited');
  assert.equal(await dotAfter({ agent: null, report: { kind: 'codex', state: 'idle' } }), true, 'no hooks, no poll');
});
