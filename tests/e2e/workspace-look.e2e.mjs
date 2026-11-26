// How workspaces look (Settings › Appearance › Layout, js/workspacelook.js): their colour (the sidebar's dots, the
// title bar's, the collapsed sidebar's tiles, the swatches in menus, the Minimal dock's dot) and the sidebar's tree
// lines, each switched off and on with its switch in Settings. Run with: npm run e2e (on Linux, under Xvfb).
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

/** Flips a switch in Settings › Appearance › Layout, as the user does, then closes Settings. @param {string} key */
const flip = key => app.eval(async (t, key) => {
  (await t.import('settings.js')).openSettings('appearance-layout');
  await t.waitFor(`[data-setting="interface.${key}"]`);
  t.click(`[data-setting="interface.${key}"]`);
  await new Promise(r => setTimeout(r, 150));
  (await t.import('settings/page.js')).closeSettings();
  const { state } = await t.import('store.js');
  return state.settings.interface[key];
}, key);

/** Saves interface settings that have no switch here (the layout). @param {Record<string, unknown>} values */
const setInterface = values => app.eval(async (t, values) => {
  const { GROUPS } = await t.import('store.js');
  (await t.import('preferences.js')).updateSettings(GROUPS.interface, values);
  await new Promise(r => setTimeout(r, 150));
}, values);

/** Whether each place shows its workspace colour, and the sidebar its tree line. */
const looks = () => app.eval(async t => {
  const shows = el => !!el && el.ownerDocument.defaultView.getComputedStyle(el).display !== 'none';
  const tree = t.$('#sidebar .tab-tree');
  // A swatch as the Move to workspace menu draws it.
  const { workspaceSwatch } = await t.import('workspacelist.js');
  const probe = t.$('body').ownerDocument.createElement('div');
  probe.innerHTML = workspaceSwatch('#ff0000');
  t.$('body').append(probe);
  const swatch = shows(probe.firstElementChild);
  probe.remove();
  return {
    sidebarDot: shows(t.$('#sidebar .ws-dot')),
    crumbDot: shows(t.$('.crumb-dot')),
    swatch,
    treeLine: tree ? tree.ownerDocument.defaultView.getComputedStyle(tree).borderLeftColor !== 'rgba(0, 0, 0, 0)' : null,
  };
});

before(async () => {
  app = await startApp({ name: 'workspace-look' });
  await app.waitFor('.pane .xterm');
  await app.waitFor('#sidebar .tab-tree');
});

after(async () => { await app?.stop({ failed }); });

step('by default the colours and tree lines show', async () => {
  const shown = await looks();
  assert.deepEqual({ sidebarDot: shown.sidebarDot, crumbDot: shown.crumbDot, swatch: shown.swatch, treeLine: shown.treeLine },
    { sidebarDot: true, crumbDot: true, swatch: true, treeLine: true });
});

step('Colour dots off takes every workspace colour away, and only that', async () => {
  assert.equal(await flip('workspaceDots'), false);
  const shown = await looks();
  assert.deepEqual({ sidebarDot: shown.sidebarDot, crumbDot: shown.crumbDot, swatch: shown.swatch, treeLine: shown.treeLine },
    { sidebarDot: false, crumbDot: false, swatch: false, treeLine: true });
  // The collapsed sidebar's tiles go plain: the muted text colour, not the workspace's.
  await app.eval(async t => (await t.import('sidebar.js')).setSidebarOpen(false));
  await app.waitFor('.rail-tile');
  const tile = await app.eval(t => {
    const el = t.$('.rail-tile');
    const style = prop => el.ownerDocument.defaultView.getComputedStyle(prop ? el : el.ownerDocument.documentElement);
    return { colour: style(true).getPropertyValue('--c').trim(), muted: style(false).getPropertyValue('--muted').trim() };
  });
  assert.equal(tile.colour, tile.muted);
  await app.eval(async t => (await t.import('sidebar.js')).setSidebarOpen(true));
  assert.equal(await flip('workspaceDots'), true);
  assert.equal((await looks()).sidebarDot, true);
});

step('Tree lines off takes only the lines away', async () => {
  assert.equal(await flip('treeLines'), false);
  const shown = await looks();
  assert.deepEqual({ sidebarDot: shown.sidebarDot, treeLine: shown.treeLine }, { sidebarDot: true, treeLine: false });
  assert.equal(await flip('treeLines'), true);
  assert.equal((await looks()).treeLine, true);
});

step("in Minimal the dock's dot beside the name goes with Colour dots", async () => {
  await setInterface({ layout: 'minimal' });
  await app.waitFor('.dock-ws-dot');
  const dock = () => app.eval(t => {
    const dot = t.$('.dock-ws-dot');
    const style = dot.ownerDocument.defaultView.getComputedStyle(dot);
    return { shows: style.display !== 'none' };
  });
  assert.equal((await dock()).shows, true);
  assert.equal(await flip('workspaceDots'), false);
  assert.equal((await dock()).shows, false);
  assert.equal(await flip('workspaceDots'), true);
  assert.equal((await dock()).shows, true);
  await setInterface({ layout: 'normal' });
});
