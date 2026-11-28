// @ts-check
// An agent session resuming before the page is up (Features/EarlyAgents.cs), end to end: the snapshot says how the
// terminal's agent starts again, the next start runs it in the agent's folder at once (before the page asks), and
// the page takes the shell over with what it printed meanwhile, typing the resume command no second time.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
// Covers: js/resuming.js js/snapshot.js src/Termilly.App/Features/EarlyAgents.cs src/Termilly.App/EarlyShell*.cs src/Termilly.App/AgentStarts.cs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until } from './process.mjs';

/** Waits for what a step leads to. @param {() => Promise<unknown>} check @param {string} description */
const soon = (check, description, timeoutMs = 30_000) => until(check, { description, timeoutMs });

const SESSION = '0e5555b2-41d1-4c87-8a3f-0aa5ffcbe7aa';
const READY = 'Fake Claude ready';
/** The snapshot is saved every half minute (js/snapshot.js). */
const SNAPSHOT_MS = 45_000;
/** Claude stays on screen, as a resumed session does, until the test is over. */
const agents = { claude: { stdout: '', prompt: { lines: [READY], input: '> ', timeoutMs: 180_000 } } };

const resumeCalls = calls => calls.filter(c => c.agent === 'claude' && c.args.includes('--resume') && c.args.includes(SESSION));

test('a resumed agent starts before the page is up, and the page takes its terminal over', async () => {
  const repo = await makeRepo({ files: { 'a.txt': 'a\n' } });
  let app, dataDir, failed = true;
  try {
    app = await startApp({ folder: repo.path, name: 'early-resume', agents });
    dataDir = app.dataDir;
    await app.waitFor('.xterm');
    await soon(() => app.eval(async t => !![...(await t.import('./store.js')).state.tabs.values()][0]?.shellMarks), 'the first prompt');
    // A Claude session running in the terminal, as its hooks would have reported it.
    const before = (await stat(path.join(dataDir, 'session.tms')).catch(() => null))?.mtimeMs ?? 0;
    await app.eval(async (t, session, folder) => {
      const tab = [...(await t.import('./store.js')).state.tabs.values()][0];
      tab.agent = { session, kind: 'claude', folder, hadTurn: true, state: 'idle' };
    }, SESSION, repo.path);
    await soon(async () => ((await stat(path.join(dataDir, 'session.tms')).catch(() => null))?.mtimeMs ?? 0) > before,
      'the snapshot saved', SNAPSHOT_MS);
    await app.stop({ keepData: true });

    app = await startApp({ name: 'early-resume', agents, dataDir });
    await app.waitFor('.xterm');
    await soon(async () => resumeCalls(await app.agentCalls()).length > 0, 'claude --resume run');
    await soon(() => app.eval(async (t, ready) => {
      const tab = [...(await t.import('./store.js')).state.tabs.values()][0];
      const buffer = tab?.view?.term?.buffer.active;
      return !!buffer && Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join(' ').includes(ready);
    }, READY), 'the agent on screen');
    const calls = resumeCalls(await app.agentCalls());
    assert.equal(calls.length, 1, JSON.stringify(calls));
    // As the process sees it: real paths (on macOS the temp folder is under /private, through a link).
    assert.equal(realpathSync(calls[0].cwd), realpathSync(repo.path));
    const log = await readFile(path.join(dataDir, 'startup.log'), 'utf8');
    assert.match(log, /early start: 1 agent session/);
    assert.match(log, /taken over from the early start/);
    failed = false;
  } finally {
    await app?.stop({ failed });
    await repo.dispose();
    if (dataDir && !failed) await rm(dataDir, { recursive: true, force: true });
  }
});
