// @ts-check
// Background shells turned off in Settings while the background host runs this window's terminals: each one starts
// again in this window at once, its output kept, and an agent that had a conversation there resumes it. The host's
// own report of the old shell's end doesn't reach the new one.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until } from './gitsteps.mjs';
import { endHost } from './background.mjs';

const SESSION = '5b2f1c9e-7d4a-4e8b-9c1f-2a3b4c5d6e7f';
// Split so the typed command doesn't count as its output.
const BEFORE = 'BEFOREOFF';
const TYPED_BEFORE = 'echo BEFORE""OFF\r';
const NOTE = 'starting again in this window';
/** Long enough for a late exit report from the old host to have come. */
const SETTLE_MS = 3000;

/** @param {any} app */
const screen = app => app.eval(async t => {
  const { state } = await t.import('./store.js');
  const tab = [...state.tabs.values()][0];
  const buffer = tab?.view?.term?.buffer.active;
  return buffer ? Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '') : [];
});

/** @param {any} app */
const firstPrompt = app => until(() => app.eval(async t => {
  const { state } = await t.import('./store.js');
  return !![...state.tabs.values()][0]?.shellMarks;
}), 'the shell\'s first prompt');

/** @param {any} app */
const hostShells = app => app.eval(async t => {
  const { request } = await t.import('./host.js');
  const { PAGE } = await t.import('./protocol.js');
  return (await request(PAGE.hostShells)).ids;
});

test('turning background shells off starts their terminals again here, and an agent resumes', async () => {
  const env = { TERMILLY_HOST_PIPE: `termilly-host-e2e-${process.pid}-${Date.now()}` };
  const repo = await makeRepo({ files: { 'a.txt': 'a\n' } });
  let app, dataDir, failed = true;
  try {
    app = await startApp({ folder: repo.path, name: 'background-turn-off', env });
    dataDir = app.dataDir;
    await app.eval(async t => (await t.import('./preferences.js')).setSetting('session.backgroundShells', true));
    await until(async () => /"backgroundShells":\s*true/.test(await readFile(path.join(dataDir, 'settings.json'), 'utf8')), 'the setting saved');
    await app.stop({ keepData: true });

    // Its shells now run in the background host, with a Claude Code session that had a turn there.
    app = await startApp({ folder: repo.path, name: 'background-turn-off', env, dataDir });
    await firstPrompt(app);
    const kept = await hostShells(app);
    const tabIds = await app.eval(async t => [...(await t.import('./store.js')).state.tabs.keys()]);
    assert.ok(tabIds.every(id => kept.includes(id)), JSON.stringify({ kept, tabIds }));
    await app.eval(async (t, text) => {
      const { state } = await t.import('./store.js');
      const { send } = await t.import('./host.js');
      const { PAGE } = await t.import('./protocol.js');
      send(PAGE.input, { id: [...state.tabs.values()][0].id, data: text });
    }, TYPED_BEFORE);
    await until(async () => (await screen(app)).some(line => line.trim() === BEFORE), 'the command before');
    await app.eval(async (t, session, folder) => {
      const { state } = await t.import('./store.js');
      const tab = [...state.tabs.values()][0];
      tab.agent = { state: 'done', session, hadTurn: true, kind: 'claude', folder, at: Date.now() };
    }, SESSION, repo.path);

    // Turned off in Settings, as the user does: asked, then confirmed.
    await app.eval(async t => (await t.import('settings.js')).openSettings('workspaces'));
    await app.click('.switch[data-setting="session.backgroundShells"]');
    await app.waitFor('.dialog [data-ok]');
    assert.match(await app.text('.dialog .dialog-sub'), /start again in this window/);
    await app.click('.dialog [data-ok]');

    await until(async () => (await screen(app)).some(line => line.includes(NOTE)), 'the terminal started again');
    await until(async () => (await app.agentCalls()).some(call => call.agent === 'claude' && call.args.includes(SESSION)), 'the session resumed');
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    const after = await app.eval(async t => {
      const { state } = await t.import('./store.js');
      const tabs = [...state.tabs.values()];
      return { tabs: tabs.map(tab => tab.id), exited: tabs.some(tab => tab.exited), on: state.settings.session.backgroundShells };
    });
    assert.deepEqual(after, { tabs: tabIds, exited: false, on: false });
    const lines = await screen(app);
    assert.ok(lines.some(line => line.trim() === BEFORE), 'the output before is kept');
    assert.ok(!lines.some(line => line.includes('process exited')), lines.join('\n'));
    assert.deepEqual(await hostShells(app), [], 'their new shells run in this window');
    assert.match(await readFile(path.join(dataDir, 'settings.json'), 'utf8'), /"backgroundShells":\s*false/);
    failed = false;
  } finally {
    try {
      await app?.stop({ failed });
    } finally {
      await endHost(env.TERMILLY_HOST_PIPE);
      await repo.dispose();
    }
    if (dataDir && !failed) await rm(dataDir, { recursive: true, force: true });
  }
});
