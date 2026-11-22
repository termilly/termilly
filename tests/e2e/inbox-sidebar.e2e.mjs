// The notification center as a sidebar (js/inboxpanel.js), design B: the title bar's button docks it on the right and
// takes it away again; its sources (All, workspaces, terminals, Schedules) sit beside the feed, newest first; picking
// one shows only its entries; a permission is answered with Allow, a question with a reply; narrow, the sources hide.
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

/** The room the sidebar takes on the right of the terminals, in pixels. */
const room = () => app.eval(t => parseFloat(t.$('#workspace').style.getPropertyValue('--inbox-dock')) || 0);

/** The feed's head and its rows' names, top to bottom. */
const feed = () => app.eval(t => ({
  head: t.$('.inbox-feed-head').textContent.trim(),
  names: [...t.$$('.inbox-feed .inbox-item .name')].map(n => n.textContent),
}));

/** The sources listed, as their names. */
const sources = () => app.eval(t => [...t.$$('.inbox-source .name')].map(n => n.textContent));

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

/** A row of the feed by its terminal's name, as a selector. @param {string} name */
const rowOf = name => app.eval(async (t, name) => {
  const { state } = await t.import('store.js');
  return `.inbox-feed .inbox-row[data-pane="${[...state.tabs.values()].find(x => x.name === name).id}"]`;
}, name);

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

step('the feed has every note, newest first, and each terminal with one is a source', async () => {
  await agentSays('asks', { state: 'needs-input', tool: 'Bash', target: 'npm test' });
  await agentSays('fails', { state: 'error', reason: 'Connection refused' });
  await agentSays('ends', { state: 'done', message: 'All done', unread: true });
  await app.eval(async t => (await t.import('inbox.js')).addScheduleNote({ id: 'r1', title: 'Nightly', detail: 'Worked', failed: false, at: Date.now() }));
  await until(async () => (await feed()).names.length === 4, 'four rows');
  assert.deepEqual((await feed()).names, ['Nightly', 'ends', 'fails', 'asks']);
  const listed = await sources();
  for (const name of ['All', 'asks', 'fails', 'ends', 'Schedules']) assert.ok(listed.includes(name), `${name} is a source`);
  assert.equal(await app.eval(t => t.$(`.inbox-source.on .name`).textContent), 'All');
});

step('a terminal\'s source shows only its notes, and is remembered', async () => {
  await app.eval(async t => {
    const { state } = await t.import('store.js');
    t.click(`[data-source="tab:${[...state.tabs.values()].find(x => x.name === 'fails').id}"]`);
  });
  await until(async () => (await feed()).names.join() === 'fails', 'only fails');
  assert.match((await feed()).head, /^fails/);
  assert.match(await app.eval(async t => (await t.import('store.js')).state.inbox.source), /^tab:/);
  await app.click('[data-source="schedules"]');
  await until(async () => (await feed()).names.join() === 'Nightly', 'only the schedule');
  await app.click('[data-source="all"]');
  await until(async () => (await feed()).names.length === 4, 'all again');
});

step('Preview of a permission whose prompt can\'t be read shows the screen, with no choices', async () => {
  await app.click(`${await rowOf('asks')} [data-preview]`);
  await app.waitFor('.cv-preview .cv-preview-text');
  assert.equal(await app.eval(t => t.$$('.cv-preview [data-choice]').length), 0);
  await app.click('.cv-preview [data-cancel]');
  await app.waitFor('.cv-preview', { gone: true });
});

step('a permission is answered with Allow, and its buttons go', async () => {
  const row = await rowOf('asks');
  await app.waitFor(`${row} [data-answer="approve"]`, { text: 'Allow' });
  await app.click(`${row} [data-answer="approve"]`);
  await until(() => app.eval(async t => [...(await t.import('store.js')).state.tabs.values()].find(x => x.name === 'asks').agent.state === 'working'), 'the agent works on');
  await app.waitFor(`${row} .inbox-answer`, { gone: true });
});

step('a question gets a reply typed into its terminal', async () => {
  await agentSays('asks', { state: 'attention', message: 'Which port?' });
  const row = await rowOf('asks');
  await app.waitFor(`${row} .inbox-reply`);
  await app.type(`${row} .inbox-reply`, '8080');
  await app.key(`${row} .inbox-reply`, 'Enter');
  await until(() => app.eval(async t => [...(await t.import('store.js')).state.tabs.values()].find(x => x.name === 'asks').agent.state === 'idle'), 'the agent took the reply');
  await app.waitFor(`${row} .inbox-reply`, { gone: true });
});

step('narrow, the sources hide and the feed shows All', async () => {
  await app.click('[data-source="schedules"]');
  await until(async () => (await feed()).names.join() === 'Nightly', 'only the schedule');
  await app.eval(async t => {
    const panel = t.$('#inbox');
    panel.style.width = '320px';
    (await t.import('inbox.js')).addScheduleNote({ id: 'r2', title: 'Hourly', detail: 'Worked', failed: false, at: Date.now() });
  });
  await until(() => app.eval(t => t.$('#inbox').classList.contains('narrow')), 'narrow');
  assert.equal(await app.eval(t => getComputedStyle(t.$('.inbox-sources')).display), 'none');
  assert.match((await feed()).head, /^All/);
  await app.eval(async t => {
    t.$('#inbox').style.width = '';
    (await t.import('inbox.js')).clear('r2');
  });
});

step('a row\'s × clears it, and Clear all the rest', async () => {
  await app.click('[data-source="all"]');
  await app.click('.inbox-feed [data-clear="r1"]');
  await until(async () => !(await feed()).names.includes('Nightly'), 'Nightly gone');
  await app.click('[data-inbox="clearAll"]');
  await app.waitFor('#inbox .inbox-empty', { text: 'No notifications.' });
});

step('the button takes it away again, and the terminals get their room back', async () => {
  await app.click('#inbox-button');
  await app.waitFor('#inbox.inbox-panel', { gone: true });
  await until(async () => (await room()) === 0, 'the room given back');
  assert.equal(await app.eval(async t => (await t.import('store.js')).state.inbox.open), false);
});
