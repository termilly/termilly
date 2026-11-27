// @ts-check
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, access } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, until, terminate } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakes = path.join(root, 'tests/e2e/fakes');
const out = path.join(root, 'tests/e2e/out');

/**
 * Everything this test file started, and the data folders of its apps. They run detached (a process group of their
 * own), and the background host in a session of its own, so a test file ended early (a timeout, Ctrl+C, a cancelled
 * run) left its app, display and host running for days. They're ended with it now: on Linux every process that has
 * one of its apps' data folders in its environment (the app, its display, the host and its shells all inherit it).
 */
const started = new Set();
const dataDirs = new Set();

/** @param {import('node:child_process').ChildProcess} child */
function track(child) {
  started.add(child);
  child.once('exit', () => started.delete(child));
  child.once('error', () => started.delete(child)); // never started: nothing to end
  return child;
}

/** Runs one end: a process that ended meanwhile is fine. @param {() => void} end */
function ending(end) {
  try { end(); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw error; }
}

/** The processes with one of these data folders in their environment (Linux's /proc). @param {Set<string>} dirs */
function processesWith(dirs) {
  const marks = [...dirs].map(dir => `TERMILLY_DATA_DIR=${dir}`);
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    if (pid === process.pid) return false;
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').some(entry => marks.includes(entry));
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ESRCH'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) return false; // gone, or not ours
      throw error;
    }
  });
}

function endStarted() {
  for (const child of started) {
    if (!child.pid) continue;
    const pid = child.pid;
    if (process.platform === 'win32') ending(() => execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }));
    else ending(() => process.kill(-pid, 'SIGKILL'));
  }
  if (process.platform === 'linux' && dataDirs.size) for (const pid of processesWith(dataDirs)) ending(() => process.kill(pid, 'SIGKILL'));
}

process.once('exit', endStarted);
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
  process.once(signal, () => {
    endStarted();
    // Whoever else listens (the test runner) ends the process its own way; with nobody else, the signal does as usual.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function launch(command, args, env, logs) {
  const child = track(spawn(command, args, { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }));
  child.stdout.on('data', data => logs.push(String(data)));
  child.stderr.on('data', data => logs.push(String(data)));
  child.on('error', error => logs.push(error.stack));
  return child;
}

async function displayFor(env, logs) {
  if (process.platform !== 'linux') return { display: env.E2E_DISPLAY ?? env.DISPLAY, child: null };
  if (env.E2E_DISPLAY) return { display: env.E2E_DISPLAY, child: null };
  const binary = env.E2E_XVFB ?? path.join(homedir(), 'e2e-tools/root/usr/bin/Xvfb');
  const libs = env.E2E_XVFB_LIBS ?? path.join(homedir(), 'e2e-tools/root/usr/lib/x86_64-linux-gnu');
  // Xvfb chooses and reserves the display itself, avoiding collisions between concurrent test files.
  const child = track(spawn(binary, ['-displayfd', '3', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], {
    env: { ...env, LD_LIBRARY_PATH: [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) },
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  }));
  let number = '', error;
  child.stdio[3].on('data', data => { number += data; });
  child.stdout.on('data', data => logs.push(String(data)));
  child.stderr.on('data', data => logs.push(String(data)));
  child.on('error', value => { error = value; });
  try {
    await until(() => { if (error) throw error; return /^\d+\s*$/.test(number); }, { description: 'Xvfb display' });
    const display = `:${number.trim()}`;
    await until(async () => { await access(`/tmp/.X11-unix/X${number.trim()}`); return true; }, { description: 'Xvfb socket' });
    return { display, child };
  } catch (error) { await terminate(child); throw error; }
}

/**
 * Starts one isolated application. Call stop({ failed: true }) from failure cleanup to retain evidence. To start it
 * again on the same data (a restart), stop the first with { keepData: true } and pass its dataDir.
 */
export async function startApp({ folder, gh = {}, agents = {}, env = {}, name = 'test', dataDir: reused } = {}) {
  const dataDir = reused ?? await mkdtemp(path.join(tmpdir(), 'termilly-e2e-'));
  dataDirs.add(dataDir);
  const logs = [], xvfbLogs = [];
  const artifacts = path.join(out, `${name.replace(/[^a-zA-Z0-9_-]/g, '-')}-${path.basename(dataDir)}`);
  const scenario = path.join(dataDir, 'gh-scenario.json'), ghLog = path.join(dataDir, 'gh.jsonl');
  const agentScripts = path.join(dataDir, 'agents.json'), agentLog = path.join(dataDir, 'agents.jsonl');
  let appProcess, xvfb, display, stopped = false, evaluationFailed = false;
  const token = randomBytes(32).toString('hex'), port = await freePort();
  const gitConfig = path.join(dataDir, 'gitconfig');
  // A home of its own: the app's shells never read the real ~/.profile (which can put the real claude ahead of the
  // fakes on PATH) and Termilly's agent setup never touches the real ~/.claude or ~/.codex.
  const home = path.join(dataDir, 'home');
  const appEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', ...env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), USERPROFILE: home,
    PATH: `${fakes}${path.delimiter}${env.PATH ?? process.env.PATH ?? ''}`,
    TERMILLY_DATA_DIR: dataDir, TERMILLY_TEST_DRIVER: String(port), TERMILLY_TEST_TOKEN: token,
    E2E_GH_SCENARIO: scenario, E2E_GH_LOG: ghLog, E2E_AGENTS: agentScripts, E2E_AGENT_LOG: agentLog,
    // What a fake agent drawing a prompt received from its terminal, key by key (compact.e2e.mjs reads it).
    E2E_AGENT_KEYS_LOG: path.join(dataDir, 'keys.jsonl') };
  const app = makeApp();
  try {
    await mkdir(home, { recursive: true });
    await Promise.all([writeFile(gitConfig, ''), writeFile(scenario, JSON.stringify(gh)), writeFile(agentScripts, JSON.stringify(agents))]);
    if (process.platform !== 'win32') await Promise.all(['gh', 'claude', 'codex', 'docker', 'kubectl'].map(file => chmod(path.join(fakes, file), 0o755)));
    ({ display, child: xvfb } = await displayFor(appEnv, xvfbLogs));
    if (display) appEnv.DISPLAY = display;
    if (process.platform === 'linux') { appEnv.GDK_BACKEND = 'x11'; delete appEnv.WAYLAND_DISPLAY; }
    const binary = appEnv.E2E_APP ?? path.join(root, 'src/Termilly.Linux/bin/Debug/net10.0/termilly');
    appProcess = launch(binary, folder ? ['--open', path.resolve(folder)] : [], appEnv, logs);
    await until(async () => {
      if (appProcess.exitCode !== null) throw new Error(`App exited ${appProcess.exitCode}: ${logs.join('')}`);
      return (await request('/ready')).ok;
    }, { timeoutMs: 60_000, description: 'test driver ready' });
    // The recovery code is offered once, when the data folder is new.
    if (!reused) {
      await app.waitFor('.recovery [data-ok]');
      await app.click('.recovery [data-ok]');
      await app.waitFor('.recovery', { gone: true });
    }
    return app;
  } catch (error) { await app.stop({ failed: true }); throw error; }

  function request(route, body) {
    return fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET',
      headers: { 'X-Termilly-Test-Token': token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(35_000) });
  }

  function makeApp() {
    return {
      dataDir, artifacts,
      async eval(fn, ...args) {
        try {
          const response = await request('/eval', { code: `return await (${fn.toString()})(t, ...${JSON.stringify(args)});` });
          if (!response.ok) throw new Error(`Driver HTTP ${response.status}: ${await response.text()}`);
          const result = await response.json();
          if (result.error) throw new Error(typeof result.error === 'string' ? result.error : `${result.error.message}\n${result.error.stack ?? ''}`);
          return result.value;
        } catch (error) { evaluationFailed = true; throw error; }
      },
      click(selector, options = {}) { return this.eval((t, s, o) => { t.click(s, o); }, selector, options); },
      type(selector, text) { return this.eval((t, s, text) => { t.type(s, text); }, selector, text); },
      key(selector, key, options = {}) { return this.eval((t, s, k, o) => { t.key(s, k, o); }, selector, key, options); },
      text(selector) { return this.eval((t, s) => t.text(s), selector); },
      waitFor(selector, options = {}) { return this.eval(async (t, s, o) => { await t.waitFor(s, o); return true; }, selector, options); },
      async screenshot(name = 'screenshot') {
        await mkdir(artifacts, { recursive: true });
        const file = path.join(artifacts, `${name.replace(/[^a-zA-Z0-9_-]/g, '-')}.png`);
        await run('import', ['-window', 'root', file], { env: { ...appEnv, DISPLAY: display } });
        return file;
      },
      ghCalls() { return readCalls(ghLog); },
      agentCalls() { return readCalls(agentLog); },
      async stop({ failed = false, keepData = false } = {}) {
        if (stopped) return;
        stopped = true;
        failed ||= evaluationFailed;
        if (failed) {
          await mkdir(artifacts, { recursive: true });
          try { if (display) await this.screenshot('failure'); } catch (error) { logs.push(`Screenshot failed: ${error.message}\n`); }
        }
        await terminate(appProcess);
        await terminate(xvfb);
        if (failed) await Promise.all([writeFile(path.join(artifacts, 'app.log'), logs.join('')),
          writeFile(path.join(artifacts, 'xvfb.log'), xvfbLogs.join('')), writeFile(path.join(artifacts, 'data-dir.txt'), dataDir)]);
        else if (!keepData) await rm(dataDir, { recursive: true, force: true });
      },
    };
  }
}

async function readCalls(file) {
  try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
