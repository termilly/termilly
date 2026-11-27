// @ts-check
// Background shells turned off in Settings while the background host runs this window's terminals: they keep running
// until Termilly quits, which ends them with the host; at the next start an agent that had a conversation there
// resumes it, as with the setting off, and nothing runs in a background host any more.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
// Covers: js/snapshot.js js/resuming.js js/closing.js js/settings/session*.js src/Termilly.App/Features/BackgroundHost.cs src/Termilly.App/HostClient.cs src/Termilly.Host/**
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until } from './gitsteps.mjs';
import { endHost, processesOf } from './background.mjs';

const SESSION = '5b2f1c9e-7d4a-4e8b-9c1f-2a3b4c5d6e7f';
// Split so the typed command doesn't count as its output.
const BEFORE = 'BEFOREOFF';
const TYPED_BEFORE = 'echo BEFORE""OFF\r';
/** Long enough for anything turning the setting off might wrongly do at once (end the shells) to have happened. */
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

/** @param {any} app @returns {Promise<string[]>} */
const hostShells = app => app.eval(async t => {
  const { request } = await t.import('./host.js');
  const { PAGE } = await t.import('./protocol.js');
  return (await request(PAGE.hostShells)).ids;
});

/** @param {any} app @returns {Promise<{ ids: string[], exited: boolean }>} */
const terminals = app => app.eval(async t => {
  const tabs = [...(await t.import('./store.js')).state.tabs.values()];
  return { ids: tabs.map(tab => tab.id), exited: tabs.some(tab => tab.exited) };
});

test('background shells turned off run on until Termilly quits, and the agent resumes at the next start', async () => {
  const env = { TERMILLY_HOST_PIPE: `termilly-host-e2e-${process.pid}-${Date.now()}` };
  const repo = await makeRepo({ files: { 'a.txt': 'a\n' } });
  let app, dataDir, failed = true;
  try {
    app = await startApp({ folder: repo.path, name: 'background-turn-off', env });
    dataDir = app.dataDir;
    await app.eval(async t => {
      const { setSetting } = await t.import('./preferences.js');
      setSetting('session.backgroundShells', true);
      setSetting('interface.confirmQuit', false); // the quit below isn't to ask
    });
    await until(async () => /"backgroundShells":\s*true/.test(await readFile(path.join(dataDir, 'settings.json'), 'utf8')), 'the setting saved');
    await app.stop({ keepData: true });

    // Its shells now run in the background host, the first with a Claude Code session that had a turn there.
    app = await startApp({ folder: repo.path, name: 'background-turn-off', env, dataDir });
    await firstPrompt(app);
    const before = await terminals(app);
    const kept = await hostShells(app);
    assert.ok(before.ids.every(id => kept.includes(id)), JSON.stringify({ kept, before }));
    await app.eval(async (t, text) => {
      const { state } = await t.import('./store.js');
      const { send } = await t.import('./host.js');
      const { PAGE } = await t.import('./protocol.js');
      send(PAGE.input, { id: [...state.tabs.values()][0].id, data: text });
    }, TYPED_BEFORE);
    await until(async () => (await screen(app)).some(line => line.trim() === BEFORE), 'the command before');
    await app.eval(async (t, session, folder) => {
      const tab = [...(await t.import('./store.js')).state.tabs.values()][0];
      tab.agent = { state: 'done', session, hadTurn: true, kind: 'claude', folder, at: Date.now() };
    }, SESSION, repo.path);

    // Turned off in Settings, as the user does: asked, then confirmed.
    await app.eval(async t => (await t.import('settings.js')).openSettings('workspaces'));
    await app.click('.switch[data-setting="session.backgroundShells"]');
    await app.waitFor('.dialog [data-ok]');
    assert.match(await app.text('.dialog .dialog-sub'), /keep running until Termilly closes/);
    await app.click('.dialog [data-ok]');
    await until(async () => /"backgroundShells":\s*false/.test(await readFile(path.join(dataDir, 'settings.json'), 'utf8')), 'the setting off, saved');

    // Nothing ends now: the same terminals, in the background host still.
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    assert.deepEqual(await terminals(app), { ids: before.ids, exited: false });
    assert.deepEqual([...await hostShells(app)].sort(), [...kept].sort());
    assert.equal((await app.agentCalls()).filter(call => call.args.includes(SESSION)).length, 0, 'nothing resumed yet');

    // Quitting ends them with the host (its last snapshot keeps the session), and nothing of this test runs on.
    await app.eval(async t => {
      const { send } = await t.import('./host.js');
      const { PAGE } = await t.import('./protocol.js');
      send(PAGE.window, { action: 'quit' });
    });
    await until(async () => (await processesOf(env.TERMILLY_HOST_PIPE)).length === 0, 'the app, the host and its shells gone');
    await app.stop({ keepData: true });

    // The next start resumes the session in a shell of its own, as it would with the setting never on.
    app = await startApp({ folder: repo.path, name: 'background-turn-off', env, dataDir });
    await until(async () => (await app.agentCalls()).some(call => call.agent === 'claude' && call.args.includes('--resume') && call.args.includes(SESSION)), 'the session resumed');
    assert.deepEqual(await hostShells(app), [], 'its shells run in this window');
    assert.ok((await screen(app)).some(line => line.trim() === BEFORE), 'the output before is kept');
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
