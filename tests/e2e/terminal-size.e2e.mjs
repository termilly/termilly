// A terminal drawn at another size (a phone's or another computer's, js/phone.js showAtSize) and given its own back:
// it ends at Settings' font, fitted to its pane, whatever was still queued. Run with: npm run e2e (on Linux, under
// Xvfb).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';

let app;
let failed = false;

before(async () => {
  app = await startApp({ name: 'terminal-size' });
  await app.waitFor('.xterm');
});

after(async () => { await app?.stop({ failed }); });

test("taken back while a phone's size is still being fitted, the terminal keeps Settings' font", async () => {
  try {
    const result = await app.eval(async t => {
      const { state } = await t.import('store.js');
      const { showAtSize } = await t.import('phone.js');
      const tab = [...state.tabs.values()].find(tab => tab.view?.term);
      // A phone far wider than the pane, so fitting it would shrink the font, then Take back in the same moment.
      showAtSize(tab, { cols: 400, rows: 120 }, { label: 'Phone', computer: false });
      showAtSize(tab, null);
      await new Promise(r => setTimeout(r, 500)); // every queued frame has run
      return { font: tab.view.term.options.fontSize, settings: state.settings.terminal.fontSize, phoneSized: !!tab.phoneSize };
    });
    assert.equal(result.phoneSized, false);
    assert.equal(result.font, result.settings, "Settings' font, not a phone's shrunk one");
  } catch (e) {
    failed = true;
    await app?.screenshot('terminal-size').catch(() => null);
    throw e;
  }
});
