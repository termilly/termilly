// @ts-check
// A Claude Code session resuming after a restart (js/resuming.js), end to end: when the session is gone, `claude
// --resume` says so and exits at once, and the spinner over the terminal goes with it (it used to spin until Esc),
// leaving Claude's words on screen; the session isn't tried again at the next start.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until } from './gitsteps.mjs';

const SESSION = '0e4444a1-30c0-4b76-9b2e-9994ffbea699';
const GONE = `No conversation found with session ID: ${SESSION}`;
/** How long the fake Codex loads, silent, before drawing its screen. */
const LOADS_MS = 4000;

test('resuming a session that is gone ends the spinner, with Claude\'s words left on screen', async () => {
  const repo = await makeRepo({ files: { 'a.txt': 'a\n' } });
  let app, failed = true;
  try {
    app = await startApp({ folder: repo.path, name: 'resume', agents: { claude: { stdout: `${GONE}\n`, exitCode: 1 } } });
    await app.waitFor('.xterm');
    // The shell's first prompt has come (its marks say so), as it would before a restart's resume is typed.
    await until(() => app.eval(async t => {
      const { state } = await t.import('./store.js');
      return !![...state.tabs.values()][0]?.shellMarks;
    }), 'the shell\'s first prompt');
    // What a restart does for a terminal whose Claude session was running (snapshot.js, terminals.js runPendingCommand).
    await app.eval(async (t, session) => {
      const { state } = await t.import('./store.js');
      const { startResuming, resumeTyped } = await t.import('./resuming.js');
      const { send } = await t.import('./host.js');
      const { PAGE } = await t.import('./protocol.js');
      const tab = [...state.tabs.values()][0];
      tab.start = { output: null, command: null, resumeSession: session, resumeKind: 'claude', done: true };
      startResuming(tab, session, 'claude');
      const command = `claude --resume ${session}`;
      send(PAGE.input, { id: tab.id, data: `${command}\r` });
      resumeTyped(tab, command);
    }, SESSION);
    await app.waitFor('.resume-overlay');
    // Well before the retry (15 s): the command's end is what ends it.
    await app.waitFor('.resume-overlay', { gone: true });
    const after = await app.eval(async t => {
      const { state } = await t.import('./store.js');
      const tab = [...state.tabs.values()][0];
      const buffer = tab.view.term.buffer.active;
      const lines = Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '');
      return { resuming: !!tab.resuming, session: tab.start?.resumeSession ?? null, text: lines.join(' ') };
    });
    assert.equal(after.resuming, false);
    assert.equal(after.session, null);
    assert.ok(after.text.includes(GONE), after.text);
    failed = false;
  } finally {
    await app?.stop({ failed });
    await repo.dispose();
  }
});

/**
 * A Codex session resuming with the activity spinner off (the host then reports nothing of what a terminal runs, so
 * the resume can't wait for Codex's program to be seen): Codex draws its screen after `loadsMs` of silence, and the
 * spinner ends only once it has, before the retry (15 s).
 * @param {string} name
 * @param {number} loadsMs
 */
async function quietCodexResume(name, loadsMs) {
  const repo = await makeRepo({ files: { 'a.txt': 'a\n' } });
  let app, failed = true;
  try {
    app = await startApp({ folder: repo.path, name, agents: { codex: { stdout: '', prompt: { lines: ['Codex is back'], input: '› ', drawAfterMs: loadsMs } } } });
    await app.waitFor('.xterm');
    await app.eval(async t => {
      const { GROUPS } = await t.import('./store.js');
      (await t.import('./preferences.js')).updateSettings(GROUPS.interface, { showActivity: false });
    });
    await until(() => app.eval(async t => {
      const { state } = await t.import('./store.js');
      return !![...state.tabs.values()][0]?.shellMarks && state.settings.interface.showActivity === false;
    }), 'the shell\'s first prompt, the spinner off');
    await app.eval(async (t, session) => {
      const { state } = await t.import('./store.js');
      const { startResuming, resumeTyped } = await t.import('./resuming.js');
      const { send } = await t.import('./host.js');
      const { PAGE } = await t.import('./protocol.js');
      const tab = [...state.tabs.values()][0];
      tab.start = { output: null, command: null, resumeSession: session, resumeKind: 'codex', done: true };
      startResuming(tab, session, 'codex');
      const command = `codex resume ${session}`;
      send(PAGE.input, { id: tab.id, data: `${command}\r` });
      resumeTyped(tab, command);
    }, SESSION);
    await app.waitFor('.resume-overlay');
    if (loadsMs) {
      await new Promise(r => setTimeout(r, loadsMs - 1000));
      assert.equal(await app.eval(t => !!t.$('.resume-overlay')), true, 'the spinner went before Codex drew its screen');
    }
    await app.waitFor('.resume-overlay', { gone: true, timeoutMs: 10_000 });
    const after = await app.eval(async t => {
      const { state } = await t.import('./store.js');
      const tab = [...state.tabs.values()][0];
      const buffer = tab.view.term.buffer.active;
      const lines = Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '');
      return { resuming: !!tab.resuming, text: lines.join(' ') };
    });
    assert.equal(after.resuming, false);
    assert.ok(after.text.includes('Codex is back'), after.text);
    failed = false;
  } finally {
    await app?.stop({ failed });
    await repo.dispose();
  }
}

test('with the activity spinner off, a Codex session drawn at once ends the spinner', () => quietCodexResume('resume-quiet-at-once', 0));

test('with the activity spinner off, a Codex session that loads silently first keeps the spinner till it draws', () => quietCodexResume('resume-quiet-loads', LOADS_MS));
