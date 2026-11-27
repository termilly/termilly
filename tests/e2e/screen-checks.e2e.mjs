// Checks of what a user sees (js/testscreen.js, #98): the helpers on shapes whose answer is known, then a remote
// terminal wider than its pane (#95), which stays readable and can be scrolled to all of its edges. Run with:
// npm run e2e (on Linux, under Xvfb).
// Covers: js/testscreen.js js/testdriver.js js/phone.js js/remotepc.js css/panes.css
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { until } from './gitsteps.mjs';

let app;
let failed = false;

before(async () => {
  app = await startApp({ name: 'screen-checks' });
  await app.waitFor('.xterm');
});

after(async () => { await app?.stop({ failed }); });

/** @param {string} name @param {() => Promise<void>} body */
const step = (name, body) => test(name, async () => {
  try { await body(); } catch (e) {
    failed = true;
    await app?.screenshot(name.replace(/\W+/g, '-')).catch(() => null);
    throw e;
  }
});

step('the helpers measure, and tell cut off from cut off but scrollable', async () => {
  const seen = await app.eval(t => {
    const doc = globalThis.document;
    const make = (/** @type {string} */ id, /** @type {string} */ overflow, /** @type {string} */ inner) => {
      const box = doc.createElement('div');
      box.id = id;
      box.style.cssText = `position:fixed;left:40px;top:40px;width:100px;height:60px;overflow:${overflow}`;
      box.innerHTML = `<div class="inner" style="${inner}">text</div>`;
      doc.body.append(box);
    };
    make('fits', 'hidden', 'width:80px;height:20px;font-size:13px');
    make('hidden', 'hidden', 'width:150px;height:20px');
    make('scrolls', 'auto', 'width:150px;height:20px');
    make('before', 'auto', 'width:150px;height:20px;margin-left:-30px');
    const result = {
      box: t.box('#fits .inner'),
      font: t.fontSize('#fits .inner'),
      fits: [t.clipped('#fits .inner'), t.reachable('#fits .inner')],
      hidden: [t.clipped('#hidden .inner'), t.reachable('#hidden .inner')],
      scrolls: [t.clipped('#scrolls .inner'), t.reachable('#scrolls .inner')],
      before: [t.clipped('#before .inner'), t.reachable('#before .inner')],
      none: t.box('#nothing-here'),
    };
    for (const id of ['fits', 'hidden', 'scrolls', 'before']) doc.getElementById(id)?.remove();
    return result;
  });
  assert.deepEqual(seen.box, { x: 40, y: 40, width: 80, height: 20 });
  assert.equal(seen.font, 13);
  assert.deepEqual(seen.fits, [false, true], 'all of it shows');
  assert.deepEqual(seen.hidden, [true, false], 'cut off where nothing scrolls');
  assert.deepEqual(seen.scrolls, [true, true], 'cut off, but scrolling shows the rest');
  assert.deepEqual(seen.before, [true, false], 'cut off before the start, where no scrolling reaches');
  assert.equal(seen.none, null);
});

step("a remote terminal wider than its pane stays readable, and every edge can be scrolled to (#95)", async () => {
  await app.eval(async t => {
    const { state } = await t.import('store.js');
    const { showAtSize } = await t.import('phone.js');
    const tab = [...state.tabs.values()].find(tab => tab.view?.term);
    // Another computer's size, far wider and taller than this pane: Keep remote size draws it at that size.
    showAtSize(tab, { cols: 400, rows: 80 }, { label: '', computer: true });
  });
  await new Promise(r => setTimeout(r, 800)); // every fitting frame has run
  const font = await app.eval(async t => {
    const { state } = await t.import('store.js');
    return [...state.tabs.values()].find(tab => tab.view?.term).view.term.options.fontSize;
  });
  assert.ok(font >= 9, `a readable font, not ${font}px`);
  await until(() => app.eval(t => t.reachable('.pane-body.phone-sized > .xterm')), 'every edge of it can be scrolled to');
  assert.equal(await app.eval(t => t.clipped('.pane-body.phone-sized > .xterm')), true, 'it is wider than its pane: the pane scrolls');
});
