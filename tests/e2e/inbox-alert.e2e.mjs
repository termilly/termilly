// What comes in while the notification center is closed (js/inboxalert.js): in Normal the center's button flashes
// once; in Minimal a tab on the right edge has a dot per notification, and one that needs the user or failed peeks out
// of it. Finished ones only add a dot. A click on the peek opens the center, and the tab goes while it's open.
// Run with: npm run e2e (on Linux, under Xvfb).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { until } from './gitsteps.mjs';

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

/** Says what a terminal's agent does now, as its hooks would. @param {string} name @param {object} agent */
const agentSays = (name, agent) => app.eval(async (t, name, agent) => {
  const { state, emit, EVENTS } = await t.import('store.js');
  const tab = [...state.tabs.values()].find(tab => tab.name === name);
  tab.agent = { at: Date.now(), ...agent };
  emit(EVENTS.agent, tab);
  emit(EVENTS.tab, tab);
}, name, agent);

const setLayout = layout => app.eval(async (t, layout) => {
  const prefs = await import(new URL('js/preferences.js', globalThis.location.href).href);
  prefs.updateSettings('interface', { layout });
}, layout);

/** The edge tab as it is: shown or not, its dots' kinds, its count, and the peek's text. */
const edge = () => app.eval(t => ({
  shown: !t.$('.inbox-edge').hidden,
  dots: [...t.$$('.inbox-edge-tab .inbox-dot')].map(d => d.className.replace('inbox-dot', '').trim()),
  count: t.$('.inbox-edge-count')?.textContent ?? '',
  peek: t.$('.inbox-peek').hidden ? '' : t.$('.inbox-peek').textContent,
}));

before(async () => {
  app = await startApp({ name: 'inbox-alert' });
  await app.waitFor('.pane .xterm');
  await app.eval(async t => {
    const { state } = await t.import('store.js');
    const { newTab } = await t.import('panes.js');
    [...state.tabs.values()][0].name = 'asks';
    newTab({ name: 'fails' });
    newTab({ name: 'ends' });
  });
});

after(async () => { await app?.stop({ failed }); });

step('in Normal, something that needs you flashes the closed center\'s button, and no tab shows', async () => {
  await app.eval(t => {
    globalThis.inboxFlashed = false;
    new globalThis.MutationObserver(() => { if (t.$('#inbox-button > .pane-arrived')) globalThis.inboxFlashed = true; })
      .observe(t.$('#inbox-button'), { childList: true });
  });
  await agentSays('asks', { state: 'needs-input', tool: 'Bash', target: 'npm test' });
  await until(() => app.eval(() => globalThis.inboxFlashed), 'the button flashed');
  assert.equal((await edge()).shown, false);
});

step('in Minimal, the tab has a dot per notification, and an error peeks out', async () => {
  await setLayout('minimal');
  await until(async () => (await edge()).shown, 'the tab shows');
  assert.deepEqual((await edge()).dots, ['ask']);
  await agentSays('fails', { state: 'error', reason: 'Connection refused' });
  await until(async () => (await edge()).peek.includes('Connection refused'), 'the error peeks out');
  const now = await edge();
  assert.deepEqual(now.dots, ['err', 'ask']);
  assert.equal(now.count, '2');
});

step('a finished agent only adds a dot', async () => {
  await app.eval(t => { t.$('.inbox-peek').hidden = true; });
  await agentSays('ends', { state: 'done', message: 'All done', unread: true });
  await until(async () => (await edge()).count === '3', 'three dots');
  assert.equal((await edge()).peek, '');
});

step('a click on the peek opens the center, and the tab goes while it\'s open', async () => {
  await agentSays('ends', { state: 'needs-input', tool: 'Edit', target: 'a.txt' });
  await until(async () => (await edge()).peek !== '', 'it peeks');
  await app.click('.inbox-peek');
  await app.waitFor('#inbox.inbox-panel:not([hidden])');
  assert.equal((await edge()).shown, false);
  await app.click('[data-inbox="close"]');
  await until(async () => (await edge()).shown, 'back when it closes');
  await setLayout('normal');
  await until(async () => !(await edge()).shown, 'gone in Normal');
});
