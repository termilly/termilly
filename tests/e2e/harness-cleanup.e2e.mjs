// The harness itself: a test app sees only what its test sets up, and a test process ended early (a timeout, Ctrl+C,
// a cancelled run) takes its app, display and background host with it. Run with: npm run e2e (on Linux, under Xvfb).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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

/** The processes with this data folder in their environment: everything a test app started. @param {string} dir */
function withDataDir(dir) {
  const mark = `TERMILLY_DATA_DIR=${dir}`;
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split(String.fromCharCode(0)).includes(mark);
    } catch {
      return false; // gone, or not ours
    }
  });
}

/** A process's program name. @param {number} pid */
const programOf = pid => {
  try {
    return path.basename(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(String.fromCharCode(0))[0]);
  } catch {
    return '';
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

test('a test process ended early takes its app, display, background host and shells with it', { skip: process.platform !== 'linux' }, async () => {
  // The host starts in a session of its own (setsid), out of the app's process group: it has to go too. A pipe of the
  // test's own keeps it apart from any host the machine runs.
  const script = `import { startApp } from ${JSON.stringify(harness)};
    import { readFile } from 'node:fs/promises';
    const env = { TERMILLY_HOST_PIPE: 'termilly-host-e2e-cleanup-' + process.pid };
    let app = await startApp({ name: 'harness-cleanup', env });
    await app.eval(async t => (await t.import('./preferences.js')).setSetting('session.backgroundShells', true));
    while (!/"backgroundShells":\\s*true/.test(await readFile(app.dataDir + '/settings.json', 'utf8'))) await new Promise(r => setTimeout(r, 100));
    const dataDir = app.dataDir;
    await app.stop({ keepData: true });
    app = await startApp({ name: 'harness-cleanup', env, dataDir });
    console.log('ready ' + dataDir);
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let started = [];
  try {
    const dataDir = await new Promise((resolve, reject) => {
      child.stdout.on('data', data => { const ready = /ready (\S+)/.exec(String(data)); if (ready) resolve(ready[1]); });
      child.once('exit', code => reject(new Error(`the test process ended first (${code})`)));
    });
    for (let waited = 0; waited < GONE_WITHIN_MS && !withDataDir(dataDir).map(programOf).includes('termilly-host'); waited += STEP_MS) await delay(STEP_MS);
    started = withDataDir(dataDir);
    const programs = started.map(programOf);
    assert.ok(['Xvfb', 'termilly', 'termilly-host'].every(p => programs.includes(p)), `display, app and host running (${programs.join(', ')})`);

    child.kill('SIGTERM');
    for (let waited = 0; waited < GONE_WITHIN_MS && started.some(alive); waited += STEP_MS) await delay(STEP_MS);
    assert.deepEqual(started.filter(alive).map(programOf), [], 'nothing it started is left running');
  } finally {
    child.kill('SIGKILL');
    for (const pid of started.filter(alive)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ }
    }
  }
});
