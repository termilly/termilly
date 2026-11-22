// The notification center as a sidebar (js/inboxpanel.js): the title bar's button docks it on the right and takes it
// away again; its notes sit in groups (Needs you, Errors, Finished, Schedules); a permission is answered with Allow, a
// question with a reply; a group folds and clears. Run with: npm run e2e (on Linux, under Xvfb).
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

/** The room the sidebar takes on the right of the terminals, in pixels. */
const room = () => app.eval(t => parseFloat(t.$('#workspace').style.getPropertyValue('--inbox-dock')) || 0);

/** The groups shown, each with its entries' terminal names. */
const lanes = () => app.eval(t => [...t.$$('.inbox-lane')].map(l => ({
  lane: l.dataset.lane, names: [...l.querySelectorAll('.inbox-item .name')].map(n => n.textContent),
})));

/**
 * Says what a terminal's agent does now, as its hooks would: three terminals, by name.
 * @param {string} name
 * @param {object} agent
 */
const agentSays = (name, agent) => app.eval(async (t, name, agent) => {
  const { state, emit, EVENTS } = await t.import('store.js');
  const tab = [...state.tabs.values()].find(tab => tab.name === name);
  tab.agent = { at: Date.now(), ...agent };
  emit(EVENTS.agent, tab);
  emit(EVENTS.tab, tab);
}, name, agent);

before(async () => {
  app = await startApp({ name: 'inbox-sidebar' });
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

step('the button docks the notification center on the right, and no dropdown opens', async () => {
  assert.equal(await room(), 0);
  await app.click('#inbox-button');
  await app.waitFor('#inbox.inbox-panel .inbox-empty', { text: 'No notifications.' });
  await until(async () => (await room()) > 0, 'the terminals make room for it');
  assert.equal(await app.eval(t => !!t.$('.popover.inbox:not([hidden])')), false);
  assert.equal(await app.eval(async t => (await t.import('store.js')).state.inbox.open), true);
});

step('each note lands in its group, Needs you on top', async () => {
  await agentSays('asks', { state: 'needs-input', tool: 'Bash', target: 'npm test' });
  await agentSays('fails', { state: 'error', reason: 'Connection refused' });
  await agentSays('ends', { state: 'done', message: 'All done', unread: true });
  await app.eval(async t => (await t.import('inbox.js')).addScheduleNote({ id: 'r1', title: 'Nightly', detail: 'Worked', failed: false, at: Date.now() }));
  await until(async () => (await lanes()).length === 4, 'four groups');
  assert.deepEqual(await lanes(), [
    { lane: 'needs-you', names: ['asks'] },
    { lane: 'errors', names: ['fails'] },
    { lane: 'finished', names: ['ends'] },
    { lane: 'schedules', names: ['Nightly'] },
  ]);
});

step('a permission is answered with Allow, and its buttons go', async () => {
  await app.waitFor('[data-lane="needs-you"] [data-answer="approve"]', { text: 'Allow' });
  await app.click('[data-lane="needs-you"] [data-answer="approve"]');
  await until(() => app.eval(async t => [...(await t.import('store.js')).state.tabs.values()].find(x => x.name === 'asks').agent.state === 'working'), 'the agent works on');
  await app.waitFor('[data-lane="needs-you"] .inbox-answer', { gone: true });
});

step('Preview shows the whole permission prompt, and a choice picked there answers it', async () => {
  const prompt = ['', '', '  Would you like to run the following command?', '', '  $ npm test', '', '› 1. Yes, proceed (y)', '  2. No, and tell the agent what to do differently (esc)', ''];
  await app.eval(async (t, prompt) => {
    const { state } = await t.import('store.js');
    const tab = [...state.tabs.values()].find(x => x.name === 'asks');
    await new Promise(done => tab.view.term.write(`\x1b[2J\x1b[H${prompt.join('\r\n')}`, done));
  }, prompt);
  await agentSays('asks', { state: 'needs-input', tool: 'Bash', target: 'npm test' });
  await app.click('[data-lane="needs-you"] [data-preview]');
  await app.waitFor('.cv-preview .cv-preview-text', { text: '$ npm test' });
  await app.waitFor('.cv-preview [data-choice="1"]');
  await app.click('.cv-preview [data-choice="1"]');
  await app.waitFor('.cv-preview', { gone: true });
  await until(() => app.eval(async t => [...(await t.import('store.js')).state.tabs.values()].find(x => x.name === 'asks').agent.state === 'working'), 'the choice answered it');
});

step('a question gets a reply typed into its terminal', async () => {
  await agentSays('asks', { state: 'attention', message: 'Which port?' });
  await app.waitFor('[data-lane="needs-you"] .inbox-reply');
  // With no prompt to read, Preview shows what the terminal's screen shows.
  await app.click('[data-lane="needs-you"] [data-preview]');
  await app.waitFor('.cv-preview .cv-preview-text', { text: 'npm test' });
  await app.click('.cv-preview [data-cancel]');
  await app.waitFor('.cv-preview', { gone: true });
  await app.type('[data-lane="needs-you"] .inbox-reply', '8080');
  await app.key('[data-lane="needs-you"] .inbox-reply', 'Enter');
  await until(() => app.eval(async t => [...(await t.import('store.js')).state.tabs.values()].find(x => x.name === 'asks').agent.state === 'idle'), 'the agent took the reply');
  await app.waitFor('[data-lane="needs-you"] .inbox-reply', { gone: true });
});

step('a group folds, stays folded, and opens again', async () => {
  await app.click('[data-fold="finished"]');
  await until(async () => (await lanes()).find(l => l.lane === 'finished')?.names.length === 0, 'Finished folded');
  assert.deepEqual(await app.eval(async t => (await t.import('store.js')).state.inbox.folded), ['finished']);
  await app.click('[data-fold="finished"]');
  await until(async () => (await lanes()).find(l => l.lane === 'finished')?.names.length === 1, 'Finished open');
});

step('a group\'s Clear clears only that group', async () => {
  await app.click('[data-clear-lane="schedules"]');
  await until(async () => !(await lanes()).some(l => l.lane === 'schedules'), 'Schedules gone');
  assert.equal((await lanes()).some(l => l.lane === 'errors'), true);
});

step('the button takes it away again, and the terminals get their room back', async () => {
  await app.click('#inbox-button');
  await app.waitFor('#inbox.inbox-panel', { gone: true });
  await until(async () => (await room()) === 0, 'the room given back');
  assert.equal(await app.eval(async t => (await t.import('store.js')).state.inbox.open), false);
});
