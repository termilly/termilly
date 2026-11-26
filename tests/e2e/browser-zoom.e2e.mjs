// No browser zoom (js/browserzoom.js): a touchpad pinch, which comes as Ctrl+wheel, zooms nothing where Termilly has no
// zoom of its own, such as the title bar; over a terminal it still sizes the font. Run with: npm run e2e (on Linux, under Xvfb).
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

/** A pinch over an element: whether the browser would still zoom (the event not taken from it). @param {string} selector */
const pinch = selector => app.eval((t, selector) => {
  const el = t.$(selector);
  const realm = el.ownerDocument.defaultView;
  return el.dispatchEvent(new realm.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10 }));
}, selector);

before(async () => {
  app = await startApp({ name: 'browser-zoom' });
  await app.waitFor('.pane .xterm');
});

after(async () => { await app?.stop({ failed }); });

step('a pinch over the title bar, the sidebar or the page zooms nothing', async () => {
  for (const selector of ['#titlebar', '#sidebar', 'body']) assert.equal(await pinch(selector), false, selector);
});

step('a pinch over a terminal still sizes its font', async () => {
  const size = () => app.eval(async t => (await t.import('store.js')).state.settings.terminal.fontSize);
  const before = await size();
  assert.equal(await pinch('.ws-layer.active .pane .xterm'), false);
  await app.eval(() => new Promise(r => setTimeout(r, 100)));
  assert.equal(await size(), before + 1);
});

step('a plain wheel still scrolls', async () => {
  const scrolled = await app.eval(t => {
    const el = t.$('#titlebar');
    return el.dispatchEvent(new el.ownerDocument.defaultView.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 10 }));
  });
  assert.equal(scrolled, true);
});
