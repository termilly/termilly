// @ts-check
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trimEnd()) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}

export async function until(check, { timeoutMs = 30_000, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let error;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (e) { error = e; }
    await setTimeout(50);
  }
  throw new Error(`Timed out waiting for ${description}${error ? `: ${error.message}` : ''}`);
}

export async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('close', resolve));
  const signal = value => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill(value);
      else process.kill(-child.pid, value);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  const controller = new AbortController();
  const timer = setTimeout(2000, null, { signal: controller.signal }).then(() => signal('SIGKILL')).catch(error => {
    if (error.name !== 'AbortError') throw error;
  });
  try { await Promise.race([exited, timer.then(() => exited)]); }
  finally { controller.abort(); }
}
