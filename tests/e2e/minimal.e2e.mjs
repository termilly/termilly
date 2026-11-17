// Minimal layout, end to end: the strip and dock take over from the title bar and sidebar and give them back, the dock
// hides to a line and comes back at its edge, its workspace button lists the workspaces, it moves to another edge from
// its menu, and a terminal's name shows on a line or on a bar near its top, whose right-click picks its parts.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
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

/** Changes interface settings the way Settings does. @param {Record<string, string>} patch */
const setInterface = patch => app.eval(async (t, p) => {
  const prefs = await import(new URL('js/preferences.js', location.href).href);
  prefs.updateSettings('interface', p);
}, patch);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Moves the pointer to a point, as the mouse would. */
const pointTo = (x, y) => app.eval((t, x, y) => {
  const target = document.elementFromPoint(x, y) ?? document.body;
  for (const type of ['pointermove', 'mousemove']) {
    const Ev = type === 'pointermove' ? PointerEvent : MouseEvent;
    target.dispatchEvent(new Ev(type, { clientX: x, clientY: y, bubbles: true }));
  }
}, x, y);

before(async () => {
  app = await startApp({ name: 'minimal' });
  await app.waitFor('.pane .xterm');
  // The welcome tour a first start offers would sit over everything.
  await app.eval(async t => {
    for (let i = 0; i < 20 && !document.querySelector('.tour-skip, [data-tour="skip"]'); i++) await new Promise(r => setTimeout(r, 100));
    const skip = [...document.querySelectorAll('button, a, span')].find(el => el.textContent.trim() === 'Skip tour');
    skip?.click();
  });
});

after(async () => { await app?.stop({ failed }); });

step('Minimal moves the toolbar into a hidden dock and the sidebar away', async () => {
  await app.screenshot('01-normal');
  await setInterface({ layout: 'minimal' });
  await app.waitFor('#dock:not([hidden])');
  const shown = await app.eval(() => ({
    toolbarInDock: !!document.querySelector('#dock .toolbar'),
    sidebar: getComputedStyle(document.getElementById('sidebar')).display,
    search: getComputedStyle(document.getElementById('search-button')).display,
    tucked: document.getElementById('dock').classList.contains('tucked'),
    line: !document.querySelector('.dock-line').hidden,
    side: document.getElementById('dock').dataset.side,
    strip: document.getElementById('titlebar').getBoundingClientRect().height,
  }));
  assert.deepEqual(shown, { toolbarInDock: true, sidebar: 'none', search: 'none', tucked: true, line: true, side: 'top', strip: 32 });
  await app.screenshot('02-minimal-hidden');
});

step('the hidden dock comes back at its edge and lists the workspaces', async () => {
  const box = await app.eval(() => { const r = document.querySelector('.dock-line').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 4 }; });
  await pointTo(box.x, box.y);
  await app.waitFor('#dock:not(.tucked)');
  await app.click('.dock-ws');
  await app.waitFor('.context-menu .menu-row');
  const rows = await app.eval(t => t.$$('.context-menu .menu-label').map(el => el.textContent));
  assert.ok(rows.includes('New workspace'), rows.join(', '));
  await pause(300);
  await app.screenshot('03-dock-workspaces');
  await app.key('.context-menu', 'Escape');
});

step('a split shows two name lines, the one in focus with its buttons', async () => {
  await app.click('#dock [data-command="splitRight"]');
  await pause(800);
  const lines = await app.eval(() => [...document.querySelectorAll('.ws-layer.active .pane > .pane-header')].map(h => Math.round(h.getBoundingClientRect().height)));
  assert.ok(lines.length >= 2 && lines.every(h => h === 24), JSON.stringify(lines));
  const edge = await app.eval(() => getComputedStyle(document.querySelector('.ws-layer.active .pane.focused'), '::after').boxShadow);
  assert.match(edge, /inset 2px 0px 0px/);
  await app.screenshot('04-line');
});

step('right-click on a name line picks its parts; a part turned off goes from every line', async () => {
  const at = await app.eval(() => { const r = document.querySelector('.ws-layer.active .pane > .pane-header').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 10 }; });
  await app.eval((t, at) => document.querySelector('.ws-layer.active .pane > .pane-header').dispatchEvent(new MouseEvent('contextmenu', { clientX: at.x, clientY: at.y, bubbles: true })), at);
  await app.waitFor('.context-menu .menu-row');
  const labels = await app.eval(t => t.$$('.context-menu .menu-label').map(el => el.textContent));
  assert.ok(labels.includes('Agent view switch') && labels.includes('Terminal menu') && !labels.includes('Close'), labels.join(', '));
  await pause(300);
  await app.screenshot('05-line-menu');
  await app.eval(t => [...t.$$('.context-menu .menu-row')].find(r => r.textContent.includes('Tag button')).click());
  const off = await app.eval(() => [...document.querySelectorAll('.ws-layer.active .pane-header .tag-btn')].every(b => getComputedStyle(b).display === 'none'));
  assert.equal(off, true);
});

step('on hover, the bar shows near a terminal\'s top only, and typing hides it', async () => {
  await setInterface({ paneNames: 'hover' });
  await pause(300);
  const pane = await app.eval(() => { const r = document.querySelector('.ws-layer.active .pane').getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom }; });
  await pointTo(pane.x, pane.bottom - 60);
  const far = await app.eval(() => getComputedStyle(document.querySelector('.ws-layer.active .pane > .pane-header')).opacity);
  await pointTo(pane.x, pane.top + 12);
  await pause(300);
  const near = await app.eval(() => getComputedStyle(document.querySelector('.ws-layer.active .pane > .pane-header')).opacity);
  assert.deepEqual({ far, near }, { far: '0', near: '1' });
  await app.screenshot('06-hover-bar');
  await app.eval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
  assert.equal(await app.eval(() => document.querySelector('.pane.bar-near')), null);
});

step('the dock moves to another edge from its menu, and stays shown with hiding off', async () => {
  await app.eval(() => document.getElementById('dock').dispatchEvent(new MouseEvent('contextmenu', { clientX: 600, clientY: 60, bubbles: true })));
  await app.waitFor('.context-menu .menu-row');
  await app.eval(t => [...t.$$('.context-menu .menu-row')].find(r => r.textContent.trim().startsWith('Right')).click());
  await app.eval(() => document.getElementById('dock').dispatchEvent(new MouseEvent('contextmenu', { clientX: 600, clientY: 60, bubbles: true })));
  await app.waitFor('.context-menu .menu-row');
  await app.eval(t => [...t.$$('.context-menu .menu-row')].find(r => r.textContent.includes('Hide when not in use')).click());
  await pause(400);
  const dock = await app.eval(() => ({ side: document.getElementById('dock').dataset.side, tucked: document.getElementById('dock').classList.contains('tucked') }));
  assert.deepEqual(dock, { side: 'right', tucked: false });
  await app.screenshot('07-dock-right');
});

step('Normal gives the title bar, sidebar and toolbar back', async () => {
  await setInterface({ layout: 'normal' });
  await pause(400);
  const back = await app.eval(() => ({
    toolbarInTitle: !!document.querySelector('#titlebar .toolbar'),
    dock: document.getElementById('dock').hidden,
    sidebar: getComputedStyle(document.getElementById('sidebar')).display !== 'none',
    header: Math.round(document.querySelector('.ws-layer.active .pane > .pane-header').getBoundingClientRect().height),
  }));
  assert.deepEqual(back, { toolbarInTitle: true, dock: true, sidebar: true, header: 30 });
  await app.screenshot('08-normal-again');
});
