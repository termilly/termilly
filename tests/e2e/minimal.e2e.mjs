// Minimal layout, end to end: the strip and dock take over from the title bar and sidebar and give them back, the dock
// hides to a line and comes back at its edge, its workspace button lists the workspaces, it moves to another edge from
// its menu, and a terminal's name shows on a line or on a bar near its top, whose right-click picks its parts.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
// Covers: js/minimal*.js js/dock*.js js/layouts.js css/minimal.css
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { until, skipTour } from './gitsteps.mjs';

/** Files every Linux has, opened in the file preview: enough tabs for its strip to overflow. */
const PREVIEW_FILES = ['hosts', 'hostname', 'os-release', 'passwd', 'group', 'fstab', 'shells', 'profile', 'environment', 'issue', 'protocols', 'services'].map(name => `/etc/${name}`);

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
  const prefs = await t.import('preferences.js');
  prefs.updateSettings('interface', p);
}, patch);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Moves the pointer to a point, as the mouse would. */
const pointTo = (x, y) => app.eval((t, x, y) => {
  const target = globalThis.document.elementFromPoint(x, y) ?? globalThis.document.body;
  for (const type of ['pointermove', 'mousemove']) {
    const Ev = type === 'pointermove' ? globalThis.PointerEvent : globalThis.MouseEvent;
    target.dispatchEvent(new Ev(type, { clientX: x, clientY: y, bubbles: true }));
  }
}, x, y);

before(async () => {
  app = await startApp({ name: 'minimal' });
  await app.waitFor('.pane .xterm');
  await skipTour(app);
});

after(async () => { await app?.stop({ failed }); });

step('Minimal moves the toolbar into a hidden dock and the sidebar away', async () => {
  await app.screenshot('01-normal');
  await setInterface({ layout: 'minimal' });
  await app.waitFor('#dock:not([hidden])');
  const shown = await app.eval(() => ({
    toolbarInDock: !!globalThis.document.querySelector('#dock .toolbar'),
    sidebar: globalThis.getComputedStyle(globalThis.document.getElementById('sidebar')).display,
    search: globalThis.getComputedStyle(globalThis.document.getElementById('search-button')).display,
    tucked: globalThis.document.getElementById('dock').classList.contains('tucked'),
    line: !globalThis.document.querySelector('.dock-line').hidden,
    side: globalThis.document.getElementById('dock').dataset.side,
    strip: globalThis.document.getElementById('titlebar').getBoundingClientRect().height,
    // The window's buttons stay at the strip's right end (not in the middle, where the search box was).
    controlsAtRight: globalThis.innerWidth - globalThis.document.querySelector('#titlebar .window-controls').getBoundingClientRect().right < 20,
  }));
  assert.deepEqual(shown, { toolbarInDock: true, sidebar: 'none', search: 'none', tucked: true, line: true, side: 'top', strip: 32, controlsAtRight: true });
  await app.screenshot('02-minimal-hidden');
});

step('a new version\'s notice shows on the strip, without the rest of the brand', async () => {
  const look = shown => app.eval((t, shown) => {
    const chip = globalThis.document.getElementById('update-chip');
    chip.hidden = !shown;
    chip.innerHTML = '<span>Update 9.9</span>';
    const css = el => globalThis.getComputedStyle(el).display;
    const box = chip.getBoundingClientRect();
    const strip = globalThis.document.getElementById('titlebar').getBoundingClientRect();
    const crumb = globalThis.document.getElementById('crumb').getBoundingClientRect();
    return { chip: box.width > 0 && box.top >= strip.top && box.bottom <= strip.bottom && box.left >= crumb.right, logo: css(globalThis.document.querySelector('#titlebar .brand .logo')), brand: css(globalThis.document.querySelector('#titlebar .brand')) };
  }, shown);
  assert.deepEqual(await look(true), { chip: true, logo: 'none', brand: 'flex' });
  await pause(1000); // the screenshot grabs the screen, which WebKit repaints a moment later
  await app.screenshot('02b-minimal-update');
  assert.deepEqual(await look(false), { chip: false, logo: 'none', brand: 'none' });
});

step('switching workspaces keeps the strip, the window buttons and the dock as they were', async () => {
  const look = () => app.eval(() => ({
    controlsAtRight: globalThis.innerWidth - globalThis.document.querySelector('#titlebar .window-controls').getBoundingClientRect().right < 20,
    strip: globalThis.document.getElementById('titlebar').getBoundingClientRect().height,
    sidebar: globalThis.getComputedStyle(globalThis.document.getElementById('sidebar')).display,
    toolbarInDock: !!globalThis.document.querySelector('#dock .toolbar'),
    needs: !globalThis.document.querySelector('.mini-needs').hidden,
  }));
  const before = await look();
  await app.eval(async t => {
    const { createWorkspace } = await t.import('workspaces.js');
    createWorkspace({ name: 'second' });
  });
  await pause(1500);
  await app.screenshot('02b-second-workspace');
  const second = await look();
  // The workspace left behind prints something: news there is not a terminal needing you.
  await app.eval(async t => {
    const { state } = await t.import('store.js');
    const { noteOutput } = await t.import('panes.js');
    for (const tab of state.tabs.values()) if (tab.wsId !== state.activeId) noteOutput(tab);
  });
  const whileAway = await app.eval(t => t.$('.mini-needs').hidden);
  assert.equal(whileAway, true, 'news in another workspace is not "needs you"');
  await app.eval(async t => {
    const { state } = await t.import('store.js');
    const { switchWorkspace } = await t.import('panes.js');
    switchWorkspace(state.workspaces[0].id);
  });
  await pause(800);
  const back = await look();
  const expected = { controlsAtRight: true, strip: 32, sidebar: 'none', toolbarInDock: true, needs: false };
  assert.deepEqual({ before, second, back }, { before: expected, second: expected, back: expected });
});

step('"needs you" sits before the window buttons, ends with a divider, and goes to the terminal it names', async () => {
  await app.eval(async t => {
    const { state, emit, EVENTS } = await t.import('store.js');
    const waiting = [...state.tabs.values()].find(tab => tab.wsId !== state.activeId);
    waiting.agent = { source: 'hooks', kind: 'claude', state: 'needs-input', at: Date.now() };
    emit(EVENTS.tab, waiting);
  });
  await app.waitFor('#titlebar .mini-needs:not([hidden])');
  const place = await app.eval(() => {
    const needs = globalThis.document.querySelector('#titlebar .mini-needs').getBoundingClientRect();
    const controls = globalThis.document.querySelector('#titlebar .window-controls').getBoundingClientRect();
    const divider = globalThis.getComputedStyle(globalThis.document.querySelector('#titlebar .mini-needs'), '::after').width;
    return { rightHalf: needs.left > globalThis.innerWidth / 2, beforeControls: needs.right <= controls.left, divider };
  });
  assert.deepEqual(place, { rightHalf: true, beforeControls: true, divider: '1px' });
  await pause(300);
  await app.screenshot('02c-needs-you');
  await app.click('#titlebar .mini-needs');
  const went = await app.eval(async t => {
    const { state, focusedTab } = await t.import('store.js');
    const waiting = [...state.tabs.values()].find(tab => tab.agent?.state === 'needs-input');
    return { workspace: waiting.wsId === state.activeId, focused: focusedTab?.() === waiting || waiting.view?.el.classList.contains('focused') };
  });
  assert.deepEqual(went, { workspace: true, focused: true });
  await app.eval(async t => {
    const { state, emit, EVENTS } = await t.import('store.js');
    const { switchWorkspace } = await t.import('panes.js');
    for (const tab of state.tabs.values()) if (tab.agent) { tab.agent = null; emit(EVENTS.tab, tab); }
    switchWorkspace(state.workspaces[0].id);
  });
  await pause(500);
});

step('the hidden dock comes back at its edge and lists the workspaces', async () => {
  const box = await app.eval(() => { const r = globalThis.document.querySelector('.dock-line').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 4 }; });
  assert.ok(box.y < 10, `the line is at the window's top edge, over the strip (y ${box.y})`);
  assert.equal(await app.eval(() => globalThis.document.getElementById('dock').inert), true, 'hidden, its buttons are out of reach of Tab');
  await pointTo(box.x, box.y);
  await app.waitFor('#dock:not(.tucked)');
  await pause(300);
  const dockTop = await app.eval(() => Math.round(globalThis.document.getElementById('dock').getBoundingClientRect().top));
  assert.ok(dockTop <= 10, `shown, it sits a few pixels under the window's edge (top ${dockTop})`);
  assert.equal(await app.eval(() => globalThis.document.getElementById('dock').inert), false);
  // On to it, off it again: it hides a moment later, however often that happens.
  const on = await app.eval(() => { const r = globalThis.document.getElementById('dock').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
  for (let round = 0; round < 2; round++) {
    await pointTo(box.x, 20);
    await pointTo(on.x, on.y);
    await pointTo(on.x, 500);
    await pause(1200);
    await pointTo(on.x, 520);
    assert.equal(await app.eval(() => globalThis.document.getElementById('dock').classList.contains('tucked')), true, `hidden again after leaving it (round ${round + 1})`);
    await pointTo(box.x, box.y);
    await app.waitFor('#dock:not(.tucked)');
  }
  await app.click('.dock-ws');
  await app.waitFor('.context-menu .menu-row');
  const rows = await app.eval(t => t.$$('.context-menu .menu-label').map(el => el.textContent));
  assert.ok(rows.includes('New workspace'), rows.join(', '));
  await pause(300);
  await app.screenshot('03-dock-workspaces');
  await app.key('.context-menu', 'Escape');
});

step("the strip's workspace opens the same list, switches workspace, and leaves the terminal its focus", async () => {
  const crumb = await app.eval(() => {
    const el = globalThis.document.getElementById('crumb');
    const box = el.getBoundingClientRect();
    // What a real click at its middle would land on: the crumb, not the dock floating over the strip.
    const hit = globalThis.document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { role: el.getAttribute('role'), arrow: globalThis.getComputedStyle(el.querySelector('.dock-chev')).display, clickable: globalThis.getComputedStyle(el).pointerEvents, reachable: el.contains(hit) };
  });
  assert.deepEqual(crumb, { role: 'button', arrow: 'block', clickable: 'auto', reachable: true });
  const labels = () => app.eval(t => t.$$('.context-menu .menu-label').map(el => el.textContent));
  const inTerminal = () => app.eval(() => !!globalThis.document.activeElement?.closest('.pane .xterm'));
  await app.click('.dock-ws');
  await app.waitFor('.context-menu .menu-row');
  const fromDock = await labels();
  await app.key('.context-menu', 'Escape');
  await pause(300);
  await app.eval(() => globalThis.document.querySelector('.ws-layer.active .pane.focused .xterm textarea')?.focus());
  assert.equal(await inTerminal(), true, 'the terminal has the focus before the click');
  await app.click('#crumb');
  await app.waitFor('.context-menu .menu-row');
  assert.deepEqual(await labels(), fromDock, 'the same rows as the dock');
  await pause(300);
  await app.screenshot('03b-strip-workspaces');
  // The menu holds the keys while it's open (as the dock's does); closed, the terminal has them again.
  await app.key('.context-menu', 'Escape');
  await pause(300);
  assert.equal(await inTerminal(), true, 'the focus is back in the terminal once the menu closes');
  await app.click('#crumb');
  await app.waitFor('.context-menu .menu-row');
  await app.eval(t => [...t.$$('.context-menu .menu-row')].find(r => r.textContent.includes('second')).click());
  const switched = await app.eval(async t => {
    const { state, wsById } = await t.import('store.js');
    return { active: wsById(state.activeId)?.name, shown: t.$('#crumb .crumb-name').textContent };
  });
  assert.deepEqual(switched, { active: 'second', shown: 'second' });
  // From the keyboard too, reached with the focus on it: Enter and Space. Then back to the first workspace for the
  // steps after.
  for (const key of ['Enter', ' ']) {
    await app.eval(() => globalThis.document.getElementById('crumb').focus());
    await app.key(null, key);
    await app.waitFor('.context-menu .menu-row');
    if (key === 'Enter') { await app.key('.context-menu', 'Escape'); await pause(300); }
  }
  await app.eval(async t => {
    const { state } = await t.import('store.js');
    [...t.$$('.context-menu .menu-row')].find(r => r.textContent.includes(state.workspaces[0].name)).click();
  });
  await pause(500);
});

step('a split shows two name lines, the one in focus with its buttons', async () => {
  await app.click('#dock [data-command="splitRight"]');
  await pause(800);
  const lines = await app.eval(() => [...globalThis.document.querySelectorAll('.ws-layer.active .pane > .pane-header')].map(h => Math.round(h.getBoundingClientRect().height)));
  assert.ok(lines.length >= 2 && lines.every(h => h === 24), JSON.stringify(lines));
  const edge = await app.eval(() => globalThis.getComputedStyle(globalThis.document.querySelector('.ws-layer.active .pane.focused'), '::after').boxShadow);
  assert.match(edge, /2px 0px 0px 0px inset|inset 2px 0px 0px/);
  await app.screenshot('04-line');
});

step('double-click on a name line\'s name renames the terminal, as in Normal', async () => {
  // As the header's pointer capture (Windows, macOS) sends it: to the header, at the name.
  const at = await app.eval(() => { const r = globalThis.document.querySelector('.ws-layer.active .pane > .pane-header .pane-name').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await app.eval((t, at) => globalThis.document.querySelector('.ws-layer.active .pane > .pane-header').dispatchEvent(new globalThis.MouseEvent('dblclick', { clientX: at.x, clientY: at.y, bubbles: true, detail: 2 })), at);
  await app.waitFor('.ws-layer.active .pane > .pane-header .rename-input');
  await app.key('.ws-layer.active .pane > .pane-header .rename-input', 'Escape');
  await app.waitFor('.ws-layer.active .pane > .pane-header .rename-input', { gone: true });
});

step('right-click on a name line opens the terminal menu, whose Title bar picks its parts; a part turned off goes from every line', async () => {
  const at = await app.eval(() => { const r = globalThis.document.querySelector('.ws-layer.active .pane > .pane-header').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 10 }; });
  await app.eval((t, at) => globalThis.document.querySelector('.ws-layer.active .pane > .pane-header').dispatchEvent(new globalThis.MouseEvent('contextmenu', { clientX: at.x, clientY: at.y, bubbles: true })), at);
  await app.waitFor('.context-menu .menu-row');
  const labels = await app.eval(t => t.$$('.context-menu .menu-label').map(el => el.textContent));
  assert.ok(labels.includes('Rename') && labels.includes('Title bar') && labels.includes('Close') && !labels.includes('Agent view switch'), labels.join(', '));
  await app.eval(t => [...t.$$('.context-menu .menu-row')].find(r => r.textContent.includes('Title bar')).click());
  await until(() => app.eval(t => t.$$('.context-menu .menu-label').some(el => el.textContent === 'Agent view switch')), 'the Title bar submenu');
  await pause(300);
  await app.screenshot('05-line-menu');
  await app.eval(t => [...t.$$('.context-menu .menu-row')].find(r => r.textContent.includes('Tag button')).click());
  const off = await app.eval(() => [...globalThis.document.querySelectorAll('.ws-layer.active .pane-header .tag-btn')].every(b => globalThis.getComputedStyle(b).display === 'none'));
  assert.equal(off, true);
});

step('on hover, the bar shows near a terminal\'s top only, and typing hides it', async () => {
  await setInterface({ paneNames: 'hover' });
  await pause(300);
  const pane = await app.eval(() => { const r = globalThis.document.querySelector('.ws-layer.active .pane').getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom }; });
  await pointTo(pane.x, pane.bottom - 60);
  const far = await app.eval(() => globalThis.getComputedStyle(globalThis.document.querySelector('.ws-layer.active .pane > .pane-header')).opacity);
  await pointTo(pane.x, pane.top + 12);
  await pause(300);
  const near = await app.eval(() => globalThis.getComputedStyle(globalThis.document.querySelector('.ws-layer.active .pane > .pane-header')).opacity);
  assert.deepEqual({ far, near }, { far: '0', near: '1' });
  await app.screenshot('06-hover-bar');
  await app.eval(() => globalThis.document.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'a' })));
  assert.equal(await app.eval(() => globalThis.document.querySelector('.pane.bar-near')), null);
});

step('on hover, a bar a button was clicked in hides again, and a working agent keeps only Stop, at the right', async () => {
  const pane = await app.eval(() => { const r = globalThis.document.querySelector('.ws-layer.active .pane').getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom, right: r.right }; });
  // Focus left on one of its buttons kept the bar shown for good.
  await pointTo(pane.x, pane.top + 12);
  // As a click leaves it: focused, but not by the keyboard (keyboard focus shows the bar).
  await app.eval(() => globalThis.document.querySelector('.ws-layer.active .pane > .pane-header .menu-btn').focus({ focusVisible: false }));
  await pointTo(pane.x, pane.bottom - 60);
  await pause(300);
  assert.equal(await app.eval(() => globalThis.getComputedStyle(globalThis.document.querySelector('.ws-layer.active .pane > .pane-header')).opacity), '0');
  // An agent at work: hidden, the bar leaves its Stop alone at the right end; near the top, the whole bar again.
  await app.eval(async t => {
    const { state, emit, EVENTS } = await t.import('store.js');
    const tab = [...state.tabs.values()].find(x => x.view?.el === globalThis.document.querySelector('.ws-layer.active .pane'));
    tab.agent = { source: 'hooks', kind: 'claude', state: 'working', at: Date.now() };
    emit(EVENTS.tab, tab);
  });
  await pause(300);
  const look = () => app.eval(() => {
    const header = globalThis.document.querySelector('.ws-layer.active .pane > .pane-header');
    const stop = header.querySelector('.agent-stop-btn');
    const pane = header.parentElement.getBoundingClientRect();
    return {
      stop: globalThis.getComputedStyle(stop).display !== 'none' && globalThis.getComputedStyle(header).opacity === '1',
      stopAtRight: pane.right - stop.getBoundingClientRect().right < 24,
      menu: globalThis.getComputedStyle(header.querySelector('.menu-btn')).display === 'none' ? 'hidden' : 'visible',
      name: globalThis.getComputedStyle(header.querySelector('.pane-title')).display === 'none' ? 'hidden' : 'visible',
    };
  });
  assert.deepEqual(await look(), { stop: true, stopAtRight: true, menu: 'hidden', name: 'hidden' });
  await app.screenshot('06c-stop-alone');
  await pointTo(pane.x, pane.top + 12);
  await pause(300);
  // The whole bar again, Stop where it was (the last button), so a click aimed at it still lands on it.
  assert.deepEqual(await look(), { stop: true, stopAtRight: true, menu: 'visible', name: 'visible' });
  await app.eval(async t => {
    const { state, emit, EVENTS } = await t.import('store.js');
    for (const tab of state.tabs.values()) if (tab.agent) { tab.agent = null; emit(EVENTS.tab, tab); }
  });
});

step('on hover, an agent terminal in its compact view shows its bar over the view', async () => {
  // An agent's terminal in the compact view: the view is drawn over the terminal, and the bar must be over both.
  await app.eval(async t => {
    const { state } = await t.import('store.js');
    const { openViewMenu } = await t.import('compact.js');
    const tab = [...state.tabs.values()].find(x => x.view?.el.closest('.ws-layer.active'));
    tab.compact = { lines: [{ kind: 'prompt', text: 'hello' }], session: null, el: null, frame: 0, frameWin: null, sending: Promise.resolve(), writes: null };
    tab.agent = { source: 'hooks', kind: 'claude', state: 'idle' };
    openViewMenu(tab, tab.view.header.querySelector('.menu-btn'));
    await t.waitFor('.menu-row');
    [...t.$$('.menu-row')].find(r => r.textContent.includes('Compact')).click();
    await t.waitFor('.ws-layer.active .compact-view:not([hidden])');
  });
  const pane = await app.eval(() => { const r = globalThis.document.querySelector('.ws-layer.active .pane.compact-on').getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top }; });
  await pointTo(pane.x, pane.top + 12);
  await pause(300);
  const onTop = await app.eval(() => {
    const bar = globalThis.document.querySelector('.ws-layer.active .pane.compact-on > .pane-header').getBoundingClientRect();
    const hit = globalThis.document.elementFromPoint(bar.left + bar.width / 2, bar.top + bar.height / 2);
    return !!hit?.closest('.pane-header');
  });
  assert.equal(onTop, true, 'the bar is the topmost thing where it shows');
  await app.screenshot('06b-hover-bar-compact');
});

step('on hover, a file preview\'s long bar shows only from its top right corner, so its tabs stay in reach', async () => {
  // Enough files for the tab strip to overflow; the last one opened is in front, scrolled into view as the preview does.
  await app.eval(async (t, files) => {
    const { state } = await t.import('store.js');
    const tab = [...state.tabs.values()].find(x => x.view?.term);
    const { showChange } = await t.import('preview.js');
    for (const file of files) await showChange(tab, file, { wholeFile: true, focus: false });
  }, PREVIEW_FILES);
  await until(async () => (await app.eval(t => t.$$('.preview-pane .pv-tab').length)) === PREVIEW_FILES.length, 'a tab for each file');
  await pause(300);
  const overflows = await app.eval(t => { const strip = t.$('.preview-pane .pv-tabs'); return strip.scrollWidth > strip.clientWidth; });
  const at = await app.eval(() => {
    const middle = el => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; };
    const strip = globalThis.document.querySelector('.preview-pane .pv-tabs').getBoundingClientRect();
    const pane = globalThis.document.querySelector('.preview-pane').getBoundingClientRect();
    const tabs = [...globalThis.document.querySelectorAll('.preview-pane .pv-tab')];
    const shownTab = tabs.find(el => el.getBoundingClientRect().left >= strip.left);
    return { tab: middle(shownTab), lastClose: middle(tabs.at(-1).querySelector('.pv-tab-close')), corner: { x: pane.right - 12, y: pane.top + 12 } };
  });
  // Each point is checked to land on what it names: a missed point would pass for a hidden bar.
  const hoverAt = async point => {
    await pointTo(point.x, point.y);
    await pause(300);
    return app.eval((t, x, y) => {
      const hit = globalThis.document.elementFromPoint(x, y);
      const on = hit?.closest('.pv-tab-close') ? 'close' : hit?.closest('.pv-tab') ? 'tab' : hit?.closest('.pane-header') ? 'bar' : 'other';
      return `${on} ${globalThis.getComputedStyle(globalThis.document.querySelector('.preview-pane > .pane-header')).opacity}`;
    }, point.x, point.y);
  };
  const overTab = await hoverAt(at.tab);
  // The newest tab, scrolled into view, stops short of the corner: its Close doesn't bring the bar up.
  const lastClose = await hoverAt(at.lastClose);
  const inCorner = await hoverAt(at.corner);
  await app.screenshot('06c-preview-corner');
  // Along the bar, leftward from the corner, it stays.
  const head = await app.eval(() => { const b = globalThis.document.querySelector('.preview-pane > .pane-header').getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; });
  const alongBar = await hoverAt(head);
  // Scrolled to their end by hand, the tabs still leave the corner free.
  await pointTo(at.tab.x, at.tab.y + 200);
  await pause(300);
  await app.eval(t => { const strip = t.$('.preview-pane .pv-tabs'); strip.scrollLeft = strip.scrollWidth; });
  const cornerAtEnd = await hoverAt(at.corner);
  // A terminal's bar still shows anywhere along its top.
  const pane = await app.eval(() => { const r = globalThis.document.querySelector('.ws-layer.active .pane:not(.preview-pane)').getBoundingClientRect(); return { x: r.left + 40, top: r.top }; });
  await pointTo(pane.x, pane.top + 12);
  await pause(300);
  const terminal = await app.eval(() => globalThis.document.querySelector('.ws-layer.active .pane:not(.preview-pane)').classList.contains('bar-near'));
  await app.eval(async t => (await t.import('preview.js')).closePreview());
  assert.deepEqual({ overflows, overTab, lastClose, inCorner, alongBar, cornerAtEnd, terminal },
    { overflows: true, overTab: 'tab 0', lastClose: 'close 0', inCorner: 'bar 1', alongBar: 'bar 1', cornerAtEnd: 'bar 1', terminal: true });
});

step('the dock moves to another edge from its menu, and stays shown with hiding off', async () => {
  await app.eval(() => globalThis.document.getElementById('dock').dispatchEvent(new globalThis.MouseEvent('contextmenu', { clientX: 600, clientY: 60, bubbles: true })));
  await app.waitFor('.context-menu .menu-row');
  await app.eval(t => [...t.$$('.context-menu .menu-row')].find(r => r.textContent.trim().startsWith('Right')).click());
  await app.eval(() => globalThis.document.getElementById('dock').dispatchEvent(new globalThis.MouseEvent('contextmenu', { clientX: 600, clientY: 60, bubbles: true })));
  await app.waitFor('.context-menu .menu-row');
  await app.eval(t => [...t.$$('.context-menu .menu-row')].find(r => r.textContent.includes('Hide when not in use')).click());
  await pause(400);
  const dock = await app.eval(() => ({ side: globalThis.document.getElementById('dock').dataset.side, tucked: globalThis.document.getElementById('dock').classList.contains('tucked') }));
  assert.deepEqual(dock, { side: 'right', tucked: false });
  await app.screenshot('07-dock-right');
});

step("right-click on a workspace in the strip's list closes it, asked first as in the sidebar", async () => {
  const names = () => app.eval(async t => (await t.import('store.js')).state.workspaces.map(ws => ws.name));
  const menus = () => app.eval(t => t.$$('.context-menu').length);
  /** Right-clicks a workspace's row in the open list, as a mouse would, at its left end. */
  const rightClickRow = async name => {
    await app.eval((t, n) => {
      const row = [...t.$$('.context-menu .menu-row')].find(r => r.querySelector('.menu-label')?.textContent === n);
      const box = row.getBoundingClientRect();
      for (const type of ['mousedown', 'mouseup', 'contextmenu']) {
        row.dispatchEvent(new globalThis.MouseEvent(type, { clientX: box.left + 4, clientY: box.top + 2, button: 2, bubbles: true, cancelable: true }));
      }
    }, name);
    await app.waitFor('.context-menu .menu-row.danger');
  };
  /** Opens the strip's list and right-clicks a workspace's row. */
  const rightClick = async name => {
    await app.click('#crumb');
    await app.waitFor('.context-menu .menu-row');
    await rightClickRow(name);
  };
  assert.ok((await names()).includes('second'));
  await rightClick('second');
  assert.equal(await menus(), 2, 'the list stays open under the workspace menu');
  await pause(400);
  await app.screenshot('08-workspace-close-menu');
  // Another row's right-click replaces it; Escape closes it and gives the list its keys back.
  await rightClickRow('workspace');
  assert.equal(await menus(), 2, 'one workspace menu at a time');
  await app.key('.context-menu .menu-row.danger', 'Escape');
  await pause(300);
  assert.deepEqual({ menus: await menus(), keys: await app.eval(() => !!globalThis.document.activeElement?.closest('.context-menu .menu-row')) }, { menus: 1, keys: true });
  await app.key('.context-menu', 'Escape');
  await pause(300);
  await rightClick('second');
  await app.click('.context-menu .menu-row.danger');
  await app.waitFor('[data-cancel]');
  assert.equal(await app.text('.dialog h3, dialog h3'), 'Close “second”?');
  await app.click('[data-cancel]');
  await pause(300);
  assert.ok((await names()).includes('second'), 'Cancel keeps it');
  await rightClick('second');
  await app.click('.context-menu .menu-row.danger');
  await app.waitFor('[data-ok]');
  await app.click('[data-ok]');
  await pause(500);
  assert.ok(!(await names()).includes('second'), 'closed');
});

step('Normal gives the title bar, sidebar and toolbar back', async () => {
  await setInterface({ layout: 'normal' });
  await pause(400);
  const back = await app.eval(() => ({
    toolbarInTitle: !!globalThis.document.querySelector('#titlebar .toolbar'),
    dock: globalThis.document.getElementById('dock').hidden,
    sidebar: globalThis.getComputedStyle(globalThis.document.getElementById('sidebar')).display !== 'none',
    header: Math.round(globalThis.document.querySelector('.ws-layer.active .pane > .pane-header').getBoundingClientRect().height),
    // The workspace is a label again, as Normal always had it: no button, no arrow, no clicks.
    crumb: (el => ({ role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), arrow: globalThis.getComputedStyle(el.querySelector('.dock-chev')).display, clickable: globalThis.getComputedStyle(el).pointerEvents }))(globalThis.document.getElementById('crumb')),
  }));
  assert.deepEqual(back, { toolbarInTitle: true, dock: true, sidebar: true, header: 30, crumb: { role: null, tabindex: null, arrow: 'none', clickable: 'none' } });
  await app.screenshot('08-normal-again');
});
