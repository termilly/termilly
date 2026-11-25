// @ts-check
// An agent's background tasks (Features/BackgroundTasks.cs, js/backgroundtasks.js), end to end: Claude Code's hooks
// say a command started in the background (here fed to Termilly's own hook helper from the terminal), its output
// file says how it goes. While it runs the terminal spins, its row is in the sidebar and its chip in the bar, and the
// agent's "done" waits; once the file says it exited, the row shows ✓, the chip goes and "done" comes through.
// Run with: npm run e2e (on Linux, under Xvfb; see tests/e2e/harness.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startApp } from './harness.mjs';
import { until } from './process.mjs';

const SESSION = '5a7d0c11-2222-4333-8444-555566667777';
const TASK = 'bktest001';
const USE_ID = 'toolu_bg1';
const NAME = 'Codex review';

/** Waits for what a step leads to. @param {() => Promise<unknown>} check @param {string} description */
const soon = (check, description) => until(check, { description, timeoutMs: 20_000 });

/** A hook payload as Claude Code sends it, for a background Bash call. @param {string | null} taskId */
const bashCall = taskId => ({
  session_id: SESSION, tool_name: 'Bash', tool_use_id: USE_ID,
  tool_input: { command: 'codex exec -s read-only "Review the branch"', description: NAME, run_in_background: true },
  tool_response: taskId ? { stdout: '', backgroundTaskId: taskId } : null,
});

test('a background task keeps the spinner, shows its row and chip, and holds "done" until it ends', async () => {
  const work = path.join(tmpdir(), `termilly-bg-${process.pid}`);
  // The app's temp folder, where it looks for Claude Code's task files.
  const temp = path.join(work, 'tmp');
  const tasks = path.join(temp, 'claude', 'project', SESSION, 'tasks');
  const output = path.join(tasks, `${TASK}.output`);
  await mkdir(tasks, { recursive: true });
  await writeFile(output, 'Reading src/EarlyShell.cs\n');
  // Each hook as the helper gets it: the payload on its standard input.
  const hooks = [
    ['SessionStart', { session_id: SESSION, source: 'startup', cwd: work }],
    ['PreToolUse', bashCall(null)],
    ['PostToolUse', bashCall(TASK)],
    ['Stop', { session_id: SESSION, last_assistant_message: 'Codex is reviewing in the background.' }],
  ];
  const script = path.join(work, 'hooks.sh');
  await writeFile(script, hooks.map(([event, payload], i) => {
    const file = path.join(work, `hook${i}.json`);
    return { file, line: `termilly-hook hook 1 ${event} < '${file}'`, payload };
  }).map(h => h.line).join('\n') + '\n');
  await Promise.all(hooks.map(([, payload], i) => writeFile(path.join(work, `hook${i}.json`), JSON.stringify(payload))));

  let app, failed = true;
  try {
    app = await startApp({ name: 'background-tasks', env: { TMPDIR: temp, TMP: temp, TEMP: temp } });
    await app.waitFor('.xterm');
    await soon(() => app.eval(async t => !![...(await t.import('store.js')).state.tabs.values()][0]?.shellMarks), 'the first prompt');
    await app.eval(async (t, script) => {
      const { state } = await t.import('store.js');
      const { send } = await t.import('host.js');
      const { PAGE } = await t.import('protocol.js');
      send(PAGE.input, { id: [...state.tabs.values()][0].id, data: `sh '${script}'\r` });
    }, script);

    // Running: the row, the chip, the spinner, and a "done" held back.
    await app.waitFor('.task-row.running', { text: NAME });
    await app.waitFor('.tasks-chip', { text: '1 task' });
    // The turn has ended (Stop) while the task runs.
    await soon(() => app.eval(async t => [...(await t.import('store.js')).state.tabs.values()][0]?.agent?.state === 'done'), 'the turn ended');
    const running = await app.eval(async t => {
      const { state, activityOf } = await t.import('store.js');
      const tab = [...state.tabs.values()][0];
      return { spin: activityOf(tab)?.kind, state: tab.agent?.state, held: !!tab.agent?.heldDone };
    });
    assert.deepEqual(running, { spin: 'spin', state: 'done', held: true });

    // Settings › Terminal: Workspace off takes the rows away, the chip stays; on again brings them back.
    await app.eval(async t => (await t.import('settings.js')).openSettings('terminal'));
    await app.click('[data-flag="agents.tasksInSidebar"]');
    await app.waitFor('.task-row', { gone: true });
    await app.waitFor('.tasks-chip', { text: '1 task' });
    await app.click('[data-flag="agents.tasksInSidebar"]');
    await app.waitFor('.task-row.running', { text: NAME });
    await app.key('body', 'Escape');

    // Ended: ✓ in its row, the chip gone, "done" through.
    await writeFile(output, 'Reading src/EarlyShell.cs\nNo findings\n\n[exited with code 0]\n');
    await app.waitFor('.task-row.done', { text: NAME });
    await app.waitFor('.tasks-chip', { gone: true });
    const ended = await app.eval(async t => {
      const { state, activityOf } = await t.import('store.js');
      const tab = [...state.tabs.values()][0];
      return { activity: activityOf(tab)?.kind ?? null, held: !!tab.agent?.heldDone, last: tab.shellTasks?.[0]?.lastLine };
    });
    assert.notEqual(ended.activity, 'spin');
    assert.equal(ended.held, false);
    assert.equal(ended.last, 'No findings');
    failed = false;
  } finally {
    await app?.stop({ failed });
    if (!failed) await rm(work, { recursive: true, force: true });
  }
});
