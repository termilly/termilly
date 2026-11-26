// How workspaces look (Settings › Appearance › Layout, js/workspacelook.js): their colour dots in the sidebar and on the
// Minimal dock, and the sidebar's tree lines, each turned off and on again. Run with: npm run e2e (on Linux, under Xvfb).
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

/** Saves interface settings. @param {Record<string, unknown>} values */
const setInterface = values => app.eval(async (t, values) => {
  const { GROUPS } = await t.import('store.js');
  (await t.import('preferences.js')).updateSettings(GROUPS.interface, values);
  await new Promise(r => setTimeout(r, 100));
}, values);

/** What shows: the sidebar's dot and tree line, and the dock's dot. */
const looks = () => app.eval(t => {
  const style = el => (el ? el.ownerDocument.defaultView.getComputedStyle(el) : null);
  const dot = style(t.$('#sidebar .ws-dot'));
  const tree = style(t.$('#sidebar .tab-tree'));
  const dock = style(t.$('.dock-ws-dot'));
  return {
    sidebarDot: dot ? dot.display !== 'none' : null,
    treeLine: tree ? tree.borderLeftColor !== 'rgba(0, 0, 0, 0)' : null,
    dockDot: dock ? dock.display !== 'none' : null,
  };
});

before(async () => {
  app = await startApp({ name: 'workspace-look' });
  await app.waitFor('.pane .xterm');
  await app.waitFor('#sidebar .tab-tree');
});

after(async () => { await app?.stop({ failed }); });

step('by default the sidebar has its dots and tree lines', async () => {
  const shown = await looks();
  assert.equal(shown.sidebarDot, true);
  assert.equal(shown.treeLine, true);
});

step('each setting takes off only its own', async () => {
  await setInterface({ workspaceDots: false });
  assert.deepEqual({ ...(await looks()), dockDot: null }, { sidebarDot: false, treeLine: true, dockDot: null });
  await setInterface({ workspaceDots: true, treeLines: false });
  assert.deepEqual({ ...(await looks()), dockDot: null }, { sidebarDot: true, treeLine: false, dockDot: null });
  await setInterface({ treeLines: true });
});

step('in Minimal the dock\'s dot goes with the setting', async () => {
  await setInterface({ layout: 'minimal' });
  await app.waitFor('.dock-ws-dot');
  assert.equal((await looks()).dockDot, true);
  await setInterface({ workspaceDots: false });
  assert.equal((await looks()).dockDot, false);
  await setInterface({ workspaceDots: true, layout: 'normal' });
});
