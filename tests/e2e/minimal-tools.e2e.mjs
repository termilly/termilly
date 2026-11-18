// @ts-check
// Minimal's tools beside the terminals (Notepad, To do, Clipboard, Files, the File Explorer): flush against them with
// Minimal's 1px line, no frame, and a 24px name line like a terminal's; back in Normal, its 6px gap and framed panels.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { until } from './gitsteps.mjs';

/** Each docked tool: its panel, and how the page opens and closes it. */
const TOOLS = [
  { name: 'Notepad', panel: '.notepad-panel:not(.todo-panel)', module: 'notepad.js', toggle: 'toggleNotepadFromKeys' },
  { name: 'To do', panel: '.todo-panel', module: 'todopanel.js', toggle: 'toggleTodo' },
  { name: 'Clipboard', panel: '.clips-panel', module: 'clipboard.js', toggle: 'toggleClips' },
  { name: 'Files', panel: '.files-panel', module: 'filepanel.js', toggle: 'toggleFiles' },
];

/** Opens or closes a tool as its toolbar button does. */
const toggle = (app, tool) => app.eval(async (t, m, f) => (await t.import(m))[f](), tool.module, tool.toggle);

/** How a tool sits: the gap to the terminals, its corners, and its name line's height. */
const measure = (app, tool) => app.eval((t, sel) => {
  const panel = t.$(sel);
  const layer = t.$('.ws-layer.active').getBoundingClientRect();
  const style = globalThis.getComputedStyle(panel);
  return { gap: Math.round(panel.getBoundingClientRect().left - layer.right), radius: style.borderTopLeftRadius, head: panel.querySelector(':scope > .files-head').offsetHeight };
}, tool.panel);

/** Sets the layout as Settings › Appearance does. */
const layout = (app, value) => app.eval(async (t, v) => (await t.import('preferences.js')).updateSettings('interface', { layout: v }), value);

/** Each tool, opened alone, sits as `want` says; closed again after. */
async function eachTool(app, want) {
  for (const tool of TOOLS) {
    await toggle(app, tool);
    await app.waitFor(tool.panel);
    // Its room is taken once it's laid out (a ResizeObserver): the terminals end where it starts.
    await until(async () => (await measure(app, tool)).gap === want.gap, `${tool.name} ${want.gap}px from the terminals`);
    const got = await measure(app, tool);
    assert.equal(got.radius === '0px', want.flush, `${tool.name}: corners ${got.radius}`);
    if (want.head) assert.equal(got.head, want.head, `${tool.name}: name line`);
    await toggle(app, tool);
    await app.waitFor(tool.panel, { gone: true });
  }
}

test('in Minimal the tools sit flush with a 1px line and a 24px name line; in Normal as before', async () => {
  let app, failed = true;
  try {
    app = await startApp({ name: 'minimal-tools' });
    await app.waitFor('.pane .xterm');
    await eachTool(app, { gap: 6, flush: false });
    await layout(app, 'minimal');
    await eachTool(app, { gap: 1, flush: true, head: 24 });
    // The File Explorer is a pane there: its name as a terminal's, not bold.
    await app.eval(async t => {
      const { state } = await t.import('store.js');
      const tab = [...state.tabs.values()].find(x => x.view?.term);
      (await t.import('preview.js')).showMessage(tab, 'Nothing to show yet');
    });
    await app.waitFor('.preview-pane .pv-name');
    assert.equal(await app.eval(t => globalThis.getComputedStyle(t.$('.preview-pane .pv-name')).fontWeight), '500');
    await app.eval(async t => (await t.import('preview.js')).closePreview());
    // Back to Normal with a tool open: its room takes the 6px gap again, without being moved.
    await toggle(app, TOOLS[0]);
    await until(async () => (await measure(app, TOOLS[0])).gap === 1, 'Notepad 1px from the terminals');
    await layout(app, 'normal');
    await until(async () => (await measure(app, TOOLS[0])).gap === 6, 'Notepad 6px from the terminals again');
    failed = false;
  } finally {
    await app?.stop({ failed });
  }
});
