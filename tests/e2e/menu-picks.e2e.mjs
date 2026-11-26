// How menus that pick one mark the chosen item (Settings › Appearance › Layout › Chosen item, js/menulook.js,
// js/popups.js): a tick by default, or a soft or solid accent background, while on/off items keep their tick.
// Run with: npm run e2e (on Linux, under Xvfb).
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

/** Picks a choice of Chosen item in Settings, as the user does, then closes Settings. @param {string} value */
const choose = value => app.eval(async (t, value) => {
  (await t.import('settings.js')).openSettings('appearance-layout');
  await t.waitFor(`[data-setting="interface.menuPick"] [data-value="${value}"]`);
  t.click(`[data-setting="interface.menuPick"] [data-value="${value}"]`);
  await new Promise(r => setTimeout(r, 150));
  (await t.import('settings/page.js')).closeSettings();
  return (await t.import('store.js')).state.settings.interface.menuPick;
}, value);

/** How a menu's rows look: label, ticked, marked chosen, icon showing, background, hint and aria-checked. Run in the page (before() installs it as menuRows). */
const rowsOf = t => t.$$('.context-menu .menu-row').map(r => {
  const view = r.ownerDocument.defaultView;
  const icon = r.querySelector('.menu-icon');
  return {
    label: r.querySelector('.menu-label').textContent.trim(),
    ticked: !!icon.querySelector('svg path[d^="M4 8.5"]'),
    tickedAtEnd: !!r.querySelector('.menu-end svg path[d^="M4 8.5"]'),
    picked: r.classList.contains('picked'),
    iconShows: view.getComputedStyle(icon).display !== 'none' && !!icon.firstElementChild,
    background: view.getComputedStyle(r).backgroundColor,
    hint: r.querySelector('.menu-hint').textContent.trim(),
    checked: r.getAttribute('aria-checked'),
    iconColour: view.getComputedStyle(icon).color,
    swatchStroke: (s => (s ? view.getComputedStyle(s).stroke : null))(icon.querySelector('.workspace-swatch rect')),
    labelInset: Math.round(r.querySelector('.menu-label').getBoundingClientRect().left - r.getBoundingClientRect().left),
  };
});

/** The workspace list (Minimal's dock and strip open it), as shown. */
const workspaceList = () => app.eval(async t => {
  (await t.import('dock.js')).showWorkspaceList(t.$('#sidebar') ?? globalThis.document.body, 'below');
  await new Promise(r => setTimeout(r, 50));
  const rows = globalThis.menuRows(t);
  const probe = globalThis.document.createElement('div');
  globalThis.document.body.append(probe);
  const colour = v => { probe.style.background = `var(${v})`; return globalThis.getComputedStyle(probe).backgroundColor; };
  const colours = { fill: colour('--accent-fill'), accent: colour('--accent'), onAccent: colour('--on-accent') };
  probe.remove();
  (await t.import('popups.js')).closeAll();
  return { rows, colours, attr: globalThis.document.documentElement.dataset.menuPick };
});

/** A dropdown's menu (a select made one with dropdown()), as shown: its rows and whether its icon column shows. */
const dropdownMenu = () => app.eval(async t => {
  const select = globalThis.document.createElement('select');
  select.innerHTML = '<option value="a">Alpha</option><option value="b" selected>Beta</option>';
  globalThis.document.body.append(select);
  const popups = await t.import('popups.js');
  popups.dropdown(select);
  /** @type {HTMLButtonElement} */ (select.nextElementSibling).click();
  const opened = !!t.$('.context-menu');
  await new Promise(r => setTimeout(r, 50));
  const menu = t.$('.context-menu');
  if (!menu) throw new Error(`The dropdown's menu ${opened ? 'opened, then closed' : 'never opened'}; focus on ${globalThis.document.activeElement?.className}`);
  const focused = globalThis.document.activeElement?.querySelector('.menu-label')?.textContent;
  const result = { rows: globalThis.menuRows(t), noIcons: menu.classList.contains('no-icons'), focused };
  popups.closeAll();
  select.nextElementSibling?.remove();
  select.remove();
  return result;
});

/** A workspace's Background submenu (its rows keep their icons and say "current" in their hint with ticks), as shown. */
const backgroundMenu = () => app.eval(async t => {
  const { state } = await t.import('store.js');
  const ws = state.workspaces.find(w => w.id === state.activeId);
  const item = (await t.import('workspacebackground.js')).backgroundMenuItem(ws);
  const popups = await t.import('popups.js');
  popups.showMenu(item.submenu(), { x: 40, y: 40 });
  const rows = globalThis.menuRows(t);
  popups.closeAll();
  return rows;
});

/** Minimal's Title bar submenu: on/off parts and a pick-one name place, none with an icon, as shown. */
const titleBarMenu = () => app.eval(async t => {
  const item = (await t.import('panebar.js')).paneBarItem();
  const popups = await t.import('popups.js');
  popups.showMenu(item.submenu(), { x: 40, y: 40 });
  const result = { rows: globalThis.menuRows(t), noIcons: t.$('.context-menu').classList.contains('no-icons') };
  popups.closeAll();
  return result;
});

/** A terminal's "Keep in history after closing" row, an on/off item. */
const keepRow = () => app.eval(async t => {
  const { state } = await t.import('store.js');
  const tab = [...state.tabs.values()].find(x => x.wsId === state.activeId);
  (await t.import('tabmenu.js')).openTabMenu(tab, { x: 40, y: 40 });
  const row = globalThis.menuRows(t).find(r => r.label === 'Keep in history after closing');
  (await t.import('popups.js')).closeAll();
  return row;
});

before(async () => {
  app = await startApp({ name: 'menu-picks' });
  await app.waitFor('.pane .xterm');
  // No welcome tour: its card, offered a few seconds after a first start, would close the menus being read.
  await app.eval(async t => {
    const { GROUPS } = await t.import('store.js');
    (await t.import('preferences.js')).updateSettings(GROUPS.uiState, { tourSeen: true });
  });
  await app.eval(async t => (await t.import('workspaces.js')).createWorkspace({ name: 'second', stay: true }));
  await app.eval((t, source) => { globalThis.menuRows = (0, eval)(source); }, rowsOf.toString());
});

after(async () => { await app?.stop({ failed }); });

step('by default the chosen workspace has a tick, in place of its swatch, as before', async () => {
  const { rows, colours } = await workspaceList();
  const [chosen, other] = rows;
  assert.deepEqual({ ticked: chosen.ticked, picked: chosen.picked }, { ticked: true, picked: false });
  assert.deepEqual({ ticked: other.ticked, iconShows: other.iconShows }, { ticked: false, iconShows: false });
  const dropdown = await dropdownMenu();
  // No icons in it: no icon column, the tick at the end instead.
  assert.equal(dropdown.noIcons, true);
  assert.deepEqual(dropdown.rows.map(r => [r.ticked, r.tickedAtEnd, r.iconShows]), [[false, false, false], [false, true, false]]);
  // Its labels start at the row's padding (8px), with nothing before them; it opens on the chosen one.
  assert.deepEqual(dropdown.rows.map(r => r.labelInset), [8, 8]);
  assert.equal(dropdown.focused, 'Beta');
  // A menu mixing switches and a pick-one, none with an icon: every tick at the end.
  const bar = await titleBarMenu();
  assert.equal(bar.noIcons, true);
  const name = bar.rows.find(r => r.label === 'Name');
  const line = bar.rows.find(r => r.label === 'Name on a line');
  assert.deepEqual([name.ticked, name.tickedAtEnd, name.labelInset], [false, true, 8]);
  assert.deepEqual([line.ticked, line.tickedAtEnd, line.labelInset], [false, true, 8]);
  // A list that keeps its icons says "current" beside the chosen one, as before; now it's announced as chosen too.
  const [same, none, gradient] = await backgroundMenu();
  assert.deepEqual([same.hint, same.checked, same.picked], ['current', 'true', false]);
  assert.deepEqual([none.hint, none.checked], ['', 'false']);
  assert.deepEqual([gradient.ticked, gradient.iconShows], [false, true]);
  // Its icons keep their own colour; only a tick is in the accent.
  const picture = (await backgroundMenu()).find(r => r.label === 'Picture');
  assert.notEqual(picture.iconColour, colours.accent);
  assert.equal(chosen.iconColour, colours.accent);
});

step('Soft: no tick, the chosen row on the soft accent, every workspace with its swatch', async () => {
  assert.equal(await choose('soft'), 'soft');
  const { rows, colours, attr } = await workspaceList();
  assert.equal(attr, 'soft');
  const [chosen, other] = rows;
  assert.deepEqual({ ticked: chosen.ticked, picked: chosen.picked, iconShows: chosen.iconShows }, { ticked: false, picked: true, iconShows: true });
  assert.equal(chosen.background, colours.fill);
  assert.deepEqual({ picked: other.picked, iconShows: other.iconShows }, { picked: false, iconShows: true });
  // A dropdown has no icons: its icon column goes.
  const dropdown = await dropdownMenu();
  assert.equal(dropdown.noIcons, true);
  assert.deepEqual(dropdown.rows.map(r => [r.picked, r.iconShows, r.tickedAtEnd, r.labelInset]), [[false, false, false, 8], [true, false, false, 8]]);
  assert.equal(dropdown.focused, 'Beta');
  // The mixed Title bar menu: its switches ticked at the end, its pick on the soft accent.
  const bar = await titleBarMenu();
  const name = bar.rows.find(r => r.label === 'Name');
  const line = bar.rows.find(r => r.label === 'Name on a line');
  assert.deepEqual([name.ticked, name.tickedAtEnd, name.labelInset], [false, true, 8]);
  assert.deepEqual([line.picked, line.tickedAtEnd, line.background, line.labelInset], [true, false, colours.fill, 8]);
  // The Background list marks its chosen row the same way, without "current".
  const [same] = await backgroundMenu();
  assert.deepEqual([same.hint, same.picked, same.background], ['', true, colours.fill]);
  // An on/off item keeps its tick.
  assert.equal((await keepRow()).ticked, true);
});

step('Solid: the chosen row on the accent itself', async () => {
  assert.equal(await choose('solid'), 'solid');
  const { rows, colours } = await workspaceList();
  assert.equal(rows[0].picked, true);
  assert.equal(rows[0].background, colours.accent);
  // Its icon takes the colour of text on the accent, and its swatch an edge in it, not lost in the accent.
  assert.equal(rows[0].iconColour, colours.onAccent);
  assert.equal(rows[0].swatchStroke, colours.onAccent);
  assert.equal((await keepRow()).ticked, true);
  // A dropdown: no icon column; the mixed Title bar menu: its switches ticked at the end, its pick on the accent.
  const dropdown = await dropdownMenu();
  assert.deepEqual(dropdown.rows.map(r => [r.picked, r.tickedAtEnd, r.labelInset]), [[false, false, 8], [true, false, 8]]);
  assert.equal(dropdown.rows[1].background, colours.accent);
  assert.equal(dropdown.focused, 'Beta');
  const bar = await titleBarMenu();
  const name = bar.rows.find(r => r.label === 'Name');
  const line = bar.rows.find(r => r.label === 'Name on a line');
  assert.deepEqual([name.tickedAtEnd, name.labelInset], [true, 8]);
  assert.deepEqual([line.picked, line.tickedAtEnd, line.background, line.labelInset], [true, false, colours.accent, 8]);
});

step('Checkbox brings the ticks back', async () => {
  assert.equal(await choose('check'), 'check');
  const { rows } = await workspaceList();
  assert.deepEqual({ ticked: rows[0].ticked, picked: rows[0].picked }, { ticked: true, picked: false });
});

step('with Colour dots off the workspace list has no icon column, in every style', async () => {
  const setDots = on => app.eval(async (t, on) => {
    const { GROUPS } = await t.import('store.js');
    (await t.import('preferences.js')).updateSettings(GROUPS.interface, { workspaceDots: on });
    await new Promise(r => setTimeout(r, 150));
  }, on);
  await setDots(false);
  try {
    for (const style of ['check', 'soft', 'solid']) {
      assert.equal(await choose(style), style);
      const { rows } = await workspaceList();
      const chosen = rows[0];
      assert.deepEqual([chosen.iconShows, chosen.labelInset], [false, 8], style);
      assert.equal(chosen.tickedAtEnd, style === 'check', style);
    }
  } finally {
    await choose('check');
    await setDots(true);
  }
});
