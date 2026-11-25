// Agents' questions in the notification center (js/questions.js, js/questioncards.js), as the MCP server's notify_user
// asks them through the API: an options question shows four choices then More and returns the pick with a note;
// approve returns Approved or Denied; ask takes a suggestion or words; an update returns at once; × puts a question
// away; an agent that stops waiting closes its card. Run with: npm run e2e (on Linux, under Xvfb).
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

/**
 * Asks as an agent in the first terminal would (the API's notify, as the host passes it on); the answer is kept in
 * the page under its id until it comes.
 * @param {object} question
 */
const ask = question => app.eval(async (t, question) => {
  const { state } = await t.import('store.js');
  const { callApi } = await t.import('api.js');
  const from = [...state.tabs.values()][0].id;
  globalThis.__answers ??= {};
  Promise.resolve(callApi('notify', { ...question, from })).then(answer => { globalThis.__answers[question.id] = answer; });
}, question);

/** What the agent heard for a question, once it did. @param {string} id */
const heard = async id => {
  await until(() => app.eval((t, id) => !!globalThis.__answers?.[id], id), `an answer to ${id}`);
  return app.eval((t, id) => globalThis.__answers[id], id);
};

/** A card's selector. @param {string} id */
const card = id => `.inbox-feed .q-card[data-question="q:${id}"]`;

before(async () => {
  app = await startApp({ name: 'agent-questions' });
  await app.waitFor('.pane .xterm');
  await app.click('#inbox-button');
  await app.waitFor('#inbox .inbox-empty');
});

after(async () => { await app?.stop({ failed }); });

step('an options question shows four choices, the rest under More, and returns the pick with a note', async () => {
  const choices = ['Postgres', 'Redis', 'SQLite', 'Files', 'Memory', 'S3'].map((label, i) => ({ label, recommended: i === 0 }));
  await ask({ id: 'q1', ui: 'options', title: 'Which session store?', details: 'Redis is down twice a week.', choices });
  await app.waitFor(`${card('q1')} .q-title`, { text: 'Which session store?' });
  assert.equal(await app.eval((t, s) => t.$$(`${s} .q-choice`).length, card('q1')), 4);
  assert.match(await app.text(`${card('q1')} .q-choice.primary`), /Postgres.*Recommended/);
  await app.click(`${card('q1')} [data-q="more"]`);
  await until(() => app.eval((t, s) => t.$$(`${s} .q-choice`).length === 6, card('q1')), 'all six');
  await app.click(`${card('q1')} [data-q="details"]`);
  await app.waitFor(`${card('q1')} .q-details`, { text: 'Redis is down twice a week.' });
  // The title bar's count has it, and its card shows it waits.
  assert.equal(await app.text('#inbox-button .tool-count'), '1');
  await app.waitFor(`${card('q1')} .inbox-dot.ask`);
  await app.click(`${card('q1')} [data-q="note"]`);
  await app.type(`${card('q1')} .q-box`, 'try it on staging');
  await app.click(`${card('q1')} [data-q="pick"][data-value="SQLite"]`);
  assert.deepEqual(await heard('q1'), { answer: 'SQLite', note: 'try it on staging' });
  await app.waitFor(`${card('q1')} .q-said`, { text: 'Sent: SQLite' });
});

step('approve returns Denied or Approved', async () => {
  await ask({ id: 'q2', ui: 'approve', title: 'Deploy to production?' });
  await app.click(`${card('q2')} [data-q="deny"]`);
  assert.deepEqual(await heard('q2'), { approved: false });
  await app.waitFor(`${card('q2')} .q-said`, { text: 'Sent: Denied' });
});

step('ask takes words typed with Enter, or a suggestion', async () => {
  await ask({ id: 'q3', ui: 'ask', title: 'What port?', suggestions: ['8080', '3000'] });
  await app.type(`${card('q3')} .q-box`, '5173');
  await app.key(`${card('q3')} .q-box`, 'Enter');
  assert.deepEqual(await heard('q3'), { answer: '5173' });
  await ask({ id: 'q4', ui: 'ask', title: 'Which branch?', suggestions: ['main', 'develop'] });
  await app.click(`${card('q4')} [data-q="pick"][data-value="develop"]`);
  assert.deepEqual(await heard('q4'), { answer: 'develop' });
});

step('an update returns at once and shows its button', async () => {
  await ask({ id: 'q5', ui: 'info', title: 'Tests pass on all three platforms', button: { label: 'Open run', url: 'https://example.com/run' } });
  assert.deepEqual(await heard('q5'), { delivered: true });
  await app.waitFor(`${card('q5')} [data-q="link"]`, { text: 'Open run' });
});

step('× on a waiting question puts it away, and the agent hears it was skipped', async () => {
  await ask({ id: 'q6', ui: 'approve', title: 'Delete the old branches?' });
  await app.waitFor(card('q6'));
  await app.click(`${card('q6')} [data-clear="q:q6"]`);
  assert.deepEqual(await heard('q6'), { skipped: true });
  await app.waitFor(card('q6'), { gone: true });
});

step('an agent that stops waiting closes its card, and Clear all keeps waiting ones', async () => {
  await ask({ id: 'q7', ui: 'ask', title: 'Name the release?' });
  await ask({ id: 'q8', ui: 'ask', title: 'Who reviews it?' });
  await app.waitFor(card('q8'));
  await app.eval(async t => (await t.import('api.js')).callApi('notify_cancel', { id: 'q7' }));
  assert.deepEqual(await heard('q7'), { closed: true });
  await app.waitFor(card('q7'), { gone: true });
  await app.click('[data-inbox="clearAll"]');
  await app.waitFor(card('q1'), { gone: true });
  await app.waitFor(card('q8'));
});
