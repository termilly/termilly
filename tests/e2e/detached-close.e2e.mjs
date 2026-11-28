// A window of its own (Schedules, Snippets) shows one Close: the window's, at the end of its buttons. Its header's own
// close hides while it's detached, and the window's Close still closes it. Run with: npm run e2e (on Linux, under Xvfb).
// Covers: js/windows.js js/detached*.js src/Termilly.Desktop/DetachedWindow.cs src/Termilly.Linux/*Detached*.cs
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

/** The Close buttons a window's header shows, and whether it's in a window of its own. @param {string} win */
const closes = win => app.eval((t, sel) => {
  const box = t.$(sel);
  const doc = box?.ownerDocument;
  const shown = el => !!el.getClientRects().length && doc.defaultView.getComputedStyle(el).display !== 'none';
  const buttons = [...(doc?.querySelectorAll('.set-close, .window-controls [data-window="close"]') ?? [])].filter(shown);
  return { detached: !!doc?.body.classList.contains('detached-window'), closes: buttons.length, windowsOwn: buttons.every(b => b.matches('[data-window="close"]')) };
}, win);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Whether a window of its own is open. @param {string} key */
const detached = key => app.eval(async (t, k) => (await t.import('windows.js')).isDetached(k), key);

/** Checks the window shows one Close, closes it with that, and checks it went. @param {string} win @param {string} key */
async function oneClose(win, key) {
  await app.waitFor(win);
  await pause(500);
  assert.deepEqual(await closes(win), { detached: true, closes: 1, windowsOwn: true });
  // Its own Close: at the end of its header, or on macOS among the traffic lights at its start.
  await app.click('.detached-window :is(.detached-controls, .mac-lights) [data-window="close"]');
  await pause(500);
  assert.equal(await detached(key), false, "the window's Close closes it");
}

before(async () => {
  app = await startApp({ name: 'detached-close' });
  await app.waitFor('.pane .xterm');
});

after(async () => { await app?.stop({ failed }); });

step('detached Schedules shows one Close, and it closes the window', async () => {
  await app.eval(async t => (await t.import('scheduleswindow.js')).openSchedules());
  await oneClose('.schedules-win', 'schedules');
});

step('detached Snippets shows one Close, and it closes the window', async () => {
  await app.eval(async t => (await t.import('snippetswindow.js')).openSnippetsWindow());
  await oneClose('.snippets-win:not(.schedules-win)', 'snippets');
});
