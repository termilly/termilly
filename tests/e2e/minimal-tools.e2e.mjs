// @ts-check
// Minimal's tools beside the terminals (Notepad, To do, Clipboard, Files, the File Explorer): flush against them with
// Minimal's 1px line, no frame, and a 24px name line like a terminal's whose buttons fade out but stay in reach of Tab;
// back in Normal, its 6px gap and framed panels; a tool in a window of its own keeps its own look either way.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
// Covers: js/minimal*.js js/preview.js js/dock*.js css/minimal.css
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { until } from './gitsteps.mjs';

/** A title bar's height in Normal for the tools that have a terminal's (windows.css), and Minimal's name line. */
const NORMAL_TITLE_BAR = 30;
const NAME_LINE = 24;
/** The gap between the terminals and a tool: Normal's, and Minimal's line. */
const NORMAL_GAP = 6;
const MINIMAL_GAP = 1;

/** Each docked tool: its panel, how the page opens and closes it, and its title bar's height in Normal when fixed. */
const TOOLS = [
  { name: 'Notepad', panel: '.notepad-panel:not(.todo-panel)', module: 'notepad.js', toggle: 'toggleNotepadFromKeys', normalHead: NORMAL_TITLE_BAR },
  { name: 'To do', panel: '.todo-panel', module: 'todopanel.js', toggle: 'toggleTodo', normalHead: NORMAL_TITLE_BAR },
  { name: 'Clipboard', panel: '.clips-panel', module: 'clipboard.js', toggle: 'toggleClips' },
  { name: 'Files', panel: '.files-panel', module: 'filepanel.js', toggle: 'toggleFiles' },
];
const NOTEPAD = TOOLS[0];

/** Opens or closes a tool as its toolbar button does. */
const toggle = (app, tool) => app.eval(async (t, m, f) => (await t.import(m))[f](), tool.module, tool.toggle);

/** How a tool sits: the gap to the terminals, its corners, and its title bar's height. */
const measure = (app, tool) => app.eval((t, sel) => {
  const panel = t.$(sel);
  const layer = t.$('.ws-layer.active').getBoundingClientRect();
  const style = globalThis.getComputedStyle(panel);
  return { gap: Math.round(panel.getBoundingClientRect().left - layer.right), radius: style.borderTopLeftRadius, head: panel.querySelector(':scope > .files-head').offsetHeight };
}, tool.panel);

/** Sets a group of settings as the Settings window does. */
const setting = (app, group, patch) => app.eval(async (t, g, p) => (await t.import('preferences.js')).updateSettings(g, p), group, patch);
const layout = (app, value) => setting(app, 'interface', { layout: value });

/** Opens the File Explorer with a message, on the first terminal. */
const showExplorer = app => app.eval(async t => {
  const { state } = await t.import('store.js');
  const tab = [...state.tabs.values()].find(x => x.view?.term);
  (await t.import('preview.js')).showMessage(tab, 'Nothing to show yet');
});
const closeExplorer = app => app.eval(async t => (await t.import('preview.js')).closePreview());

/** Each tool, opened alone, sits as `minimal` says it should there, or as in Normal; closed again after. */
async function eachTool(app, minimal) {
  const gap = minimal ? MINIMAL_GAP : NORMAL_GAP;
  for (const tool of TOOLS) {
    await toggle(app, tool);
    await app.waitFor(tool.panel);
    // Its room is taken once it's laid out (a ResizeObserver): the terminals end where it starts.
    await until(async () => (await measure(app, tool)).gap === gap, `${tool.name} ${gap}px from the terminals`);
    const got = await measure(app, tool);
    assert.equal(got.radius === '0px', minimal, `${tool.name}: corners ${got.radius}`);
    const head = minimal ? NAME_LINE : tool.normalHead;
    if (head) assert.equal(got.head, head, `${tool.name}: title bar`);
    await toggle(app, tool);
    await app.waitFor(tool.panel, { gone: true });
  }
}

/** The Notepad's New page button: faded out while the Notepad isn't in use, but reached by Tab, which shows it. */
async function buttonsInReach(app) {
  await toggle(app, NOTEPAD);
  await app.waitFor('[data-np="new"]');
  const opacity = () => app.eval(t => globalThis.getComputedStyle(t.$('[data-np="new"]')).opacity);
  await app.eval(t => t.$('.xterm textarea').focus());
  await until(async () => (await opacity()) === '0', 'faded while another terminal is in use');
  // In the Tab order while faded: shown to the browser (not hidden or left out), with no negative tabindex. The
  // harness's keys are synthetic and move no focus, so a real Tab can't be pressed here.
  const order = await app.eval(t => {
    const button = t.$('[data-np="new"]');
    const style = globalThis.getComputedStyle(button);
    return { visibility: style.visibility, display: style.display, tabIndex: button.tabIndex };
  });
  assert.equal(order.visibility, 'visible', 'in the Tab order: not hidden');
  assert.notEqual(order.display, 'none', 'in the Tab order: not left out');
  assert.equal(order.tabIndex, 0, 'in the Tab order: no negative tabindex');
  await app.eval(t => t.$('[data-np="new"]').focus());
  await until(async () => (await opacity()) === '1', 'shown once it has the focus');
  await toggle(app, NOTEPAD);
}

/** The File Explorer: as a pane, its name as a terminal's (not bold); over the right edge, a line, not a floating card. */
async function explorer(app) {
  await showExplorer(app);
  await app.waitFor('.preview-pane .pv-name');
  assert.equal(await app.eval(t => globalThis.getComputedStyle(t.$('.preview-pane .pv-name')).fontWeight), '500');
  await closeExplorer(app);
  await setting(app, 'changes', { placement: 'panel' });
  await showExplorer(app);
  await app.waitFor('.preview-panel');
  const panel = await app.eval(t => { const s = globalThis.getComputedStyle(t.$('.preview-panel')); return { radius: s.borderTopLeftRadius, shadow: s.boxShadow }; });
  assert.equal(panel.radius, '0px');
  assert.match(panel.shadow, /-1px 0px 0px 0px/);
  await closeExplorer(app);
  await setting(app, 'changes', { placement: 'split' });
}

/** A Notepad in a window of its own keeps the window's look when the main window goes Minimal. */
async function detachedKeepsItsLook(app) {
  await toggle(app, NOTEPAD);
  await app.click('[data-np="detach"]');
  await until(() => app.eval(t => !!t.$('.notepad-panel:not(.todo-panel)')?.ownerDocument.body.classList.contains('detached-window')), 'Notepad in a window of its own');
  await layout(app, 'minimal');
  assert.equal(await app.eval(t => t.$('.notepad-panel:not(.todo-panel) > .files-head').offsetHeight), NORMAL_TITLE_BAR);
}

test('in Minimal the tools sit flush with a 1px line and a 24px name line; in Normal as before', async () => {
  let app, failed = true;
  try {
    app = await startApp({ name: 'minimal-tools' });
    await app.waitFor('.pane .xterm');
    await eachTool(app, false);
    await layout(app, 'minimal');
    await eachTool(app, true);
    await buttonsInReach(app);
    await explorer(app);
    // Back to Normal with a tool open: its room takes the 6px gap again, without being moved.
    await toggle(app, NOTEPAD);
    await until(async () => (await measure(app, NOTEPAD)).gap === MINIMAL_GAP, 'Notepad 1px from the terminals');
    await layout(app, 'normal');
    await until(async () => (await measure(app, NOTEPAD)).gap === NORMAL_GAP, 'Notepad 6px from the terminals again');
    await detachedKeepsItsLook(app);
    failed = false;
  } finally {
    await app?.stop({ failed });
  }
});
