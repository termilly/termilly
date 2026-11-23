// @ts-check
// A shell kept by the background host, taken back by the next window: its missed output is drawn again, and the
// terminal queries in it (here "what terminal are you?") aren't answered again into the live prompt.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startApp } from './harness.mjs';
import { until } from './gitsteps.mjs';

const ASK_TERMINAL = 'printf \'\\033[c\'';
// Split so the typed command doesn't count as its output.
const QUERIED = 'QUERIED';
const ASKED = `stty -echo; ${ASK_TERMINAL}; read -rs -d c -t 2 reply; stty echo; echo QUER""IED\r`;
const DONE = 'AFTERWARDS';
const TYPED_LATER = 'echo AFTER""WARDS\r';
/** xterm's answer, as it would show at the prompt: numbers with semicolons ending in "c". */
const ANSWER = /\d+;\d+[;\d]*c/;

/** @param {any} app */
const screen = app => app.eval(async t => {
  const { state } = await t.import('./store.js');
  const tab = [...state.tabs.values()][0];
  const buffer = tab?.view?.term?.buffer.active;
  return buffer ? Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '') : [];
});

/** @param {any} app @param {string} data */
const typeIn = (app, data) => app.eval(async (t, text) => {
  const { state } = await t.import('./store.js');
  const { send } = await t.import('./host.js');
  const { PAGE } = await t.import('./protocol.js');
  send(PAGE.input, { id: [...state.tabs.values()][0].id, data: text });
}, data);

/** @param {any} app */
const firstPrompt = app => until(() => app.eval(async t => {
  const { state } = await t.import('./store.js');
  return !![...state.tabs.values()][0]?.shellMarks;
}), 'the shell\'s first prompt');

test('a kept shell taken back doesn\'t get terminal answers typed at its prompt', async () => {
  const env = { TERMILLY_HOST_PIPE: `termilly-host-e2e-${process.pid}-${Date.now()}` };
  let app, dataDir, failed = true;
  try {
    app = await startApp({ name: 'background-replay', env });
    dataDir = app.dataDir;
    await app.eval(async t => {
      const { setSetting } = await t.import('./preferences.js');
      setSetting('session.backgroundShells', true);
    });
    await until(async () => /"backgroundShells":\s*true/.test(await readFile(path.join(dataDir, 'settings.json'), 'utf8')), 'the setting saved');
    await app.stop({ keepData: true });

    // Its shell now runs in the background host: something in it asks the terminal what it is, then the window closes.
    app = await startApp({ name: 'background-replay', env, dataDir });
    await firstPrompt(app);
    await typeIn(app, ASKED);
    await until(async () => (await screen(app)).some(line => line.trim() === QUERIED), 'the query asked');
    await app.stop({ keepData: true });

    // The next window takes the shell back: the old output, query and all, is drawn again.
    app = await startApp({ name: 'background-replay', env, dataDir });
    await until(async () => (await screen(app)).some(line => line.trim() === QUERIED), 'the missed output replayed');
    await typeIn(app, TYPED_LATER);
    await until(async () => (await screen(app)).some(line => line.includes('AFTER""WARDS')), 'the command typed afterwards');
    const typed = (await screen(app)).find(line => line.includes('AFTER""WARDS')) ?? '';
    assert.doesNotMatch(typed, ANSWER, typed);
    await until(async () => (await screen(app)).some(line => line.trim() === DONE), 'the command run');
    failed = false;
  } finally {
    // Ends the background host and its shell.
    await app?.eval(async t => {
      const { send } = await t.import('./host.js');
      const { PAGE } = await t.import('./protocol.js');
      send(PAGE.hostShutdown);
    }).catch(error => console.error('Background host not stopped:', error.message));
    await app?.stop({ failed });
    if (dataDir && !failed) await rm(dataDir, { recursive: true, force: true });
  }
});
