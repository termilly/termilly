// The harness itself: a test app sees only what its test sets up, and a test process ended early (a timeout, Ctrl+C,
// a cancelled run) takes its app and its display with it. Run with: npm run e2e (on Linux, under Xvfb).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const harness = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'harness.mjs')).href;
const GONE_WITHIN_MS = 5000;
const STEP_MS = 100;

/** Whether a process is still there (a zombie waiting for its parent counts as gone). @param {number} pid */
function alive(pid) {
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch {
    return false;
  }
}

/** The processes a process started. @param {number} pid */
const childrenOf = pid => {
  try {
    return execFileSync('ps', ['-o', 'pid=', '--ppid', String(pid)], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean);
  } catch {
    return [];
  }
};

test("a test app sees none of the test machine's containers or pods", async () => {
  const { startApp } = await import(harness);
  const app = await startApp({ name: 'harness-isolation' });
  let failed = true;
  try {
    // They're read in the background after start (DynamicSources.cs): long enough for docker and kubectl to answer.
    await delay(3000);
    const found = await app.eval(async t => {
      const { state } = await t.import('store.js');
      return state.profiles.filter(p => p.source === 'docker' || p.source === 'k8s').map(p => p.name);
    });
    assert.deepEqual(found, [], 'only what a test sets up');
    failed = false;
  } finally { await app.stop({ failed }); }
});

test('a test process ended early takes its app and its display with it', { skip: process.platform !== 'linux' }, async () => {
  const script = `import { startApp } from ${JSON.stringify(harness)};
    await startApp({ name: 'harness-cleanup' });
    console.log('ready');
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let started = [];
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', data => { if (String(data).includes('ready')) resolve(); });
      child.once('exit', code => reject(new Error(`the test process ended first (${code})`)));
    });
    started = childrenOf(child.pid);
    assert.ok(started.length >= 2, `an app and a display started (${started.join(', ')})`);

    child.kill('SIGTERM');
    for (let waited = 0; waited < GONE_WITHIN_MS && started.some(alive); waited += STEP_MS) await delay(STEP_MS);
    assert.deepEqual(started.filter(alive), [], 'nothing it started is left running');
  } finally {
    child.kill('SIGKILL');
    for (const pid of started.filter(alive)) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone already */ }
    }
  }
});
