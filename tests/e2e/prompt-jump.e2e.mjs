// My prompts in the compact and minimal views: a prompt picked from the list is scrolled to and marked in the view
// (the terminal under it is hidden), not in the terminal. Run with: npm run e2e (on Linux, under Xvfb).
// Covers: js/myprompts.js js/commands.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';

const FIRST = 'fix the retry backoff in the http client';
const SECOND = 'add a csv export to the orders page';
const FILLER = Array.from({ length: 40 }, (_, i) => `Step ${i + 1} of the work, written out so the feed is long enough to scroll.`);

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

before(async () => {
  app = await startApp({ name: 'prompt-jump' });
  await app.waitFor('.pane .xterm');
  // An agent's terminal: its two prompts in the output (where My prompts finds them without a transcript) and in the
  // view's feed, each followed by a long answer.
  await app.eval(async (t, first, second, filler) => {
    const { state } = await t.import('store.js');
    const tab = [...state.tabs.values()].find(x => x.view?.term);
    const lines = [];
    for (const prompt of [first, second]) {
      lines.push({ kind: 'prompt', text: prompt }, ...filler.map(text => ({ kind: 'reply', text, final: true })), { kind: 'end', detail: '12s' });
    }
    tab.compact = { lines, session: null, el: null, frame: 0, frameWin: null, sending: Promise.resolve(), writes: null };
    tab.agent = { source: 'hooks', kind: 'claude', state: 'idle' };
    tab.view.term.write(`\r\n> ${first}\r\n${filler.join('\r\n')}\r\n> ${second}\r\n${filler.join('\r\n')}\r\n`);
  }, FIRST, SECOND, FILLER);
});

after(async () => { await app?.stop({ failed }); });

for (const view of ['Compact', 'Minimal']) {
  step(`in the ${view} view, a prompt picked in My prompts is scrolled to and marked there`, async () => {
    await app.eval(async (t, view) => {
      const { state } = await t.import('store.js');
      const { openViewMenu } = await t.import('compact.js');
      const tab = [...state.tabs.values()].find(x => x.view?.term);
      openViewMenu(tab, tab.view.header.querySelector('.menu-btn'));
      await t.waitFor('.menu-row');
      [...t.$$('.menu-row')].find(r => r.textContent.includes(view)).click();
      await t.waitFor('.cv-prompt');
      const feed = t.$('.cv-feed');
      feed.scrollTop = feed.scrollHeight;
      const { openPrompts } = await t.import('myprompts.js');
      await openPrompts(tab, tab.view.header.querySelector('.menu-btn'));
    }, view);
    await app.waitFor('.prompt-row');
    await app.eval((t, first) => [...t.$$('.prompt-row')].find(r => r.textContent.includes(first)).click(), FIRST);
    const shown = await app.eval(async t => {
      await new Promise(r => setTimeout(r, 200));
      const feed = t.$('.cv-feed').getBoundingClientRect();
      const found = t.$('.cv-found');
      const box = found?.getBoundingClientRect();
      return { found: found?.textContent.trim() ?? null, inside: !!box && box.top >= feed.top && box.bottom <= feed.bottom, popover: !!t.$('.prompts-pop:not([hidden])') };
    });
    assert.deepEqual(shown, { found: FIRST, inside: true, popover: false });
    await app.screenshot(`jump-${view}`);
  });
}
