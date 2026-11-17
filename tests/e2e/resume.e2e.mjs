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
      return { resuming: !!tab.resuming, session: tab.start?.resumeSession ?? null, text: t.text('.xterm-rows') };
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
