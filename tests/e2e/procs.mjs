// @ts-check
// The test machine's processes found by their environment: what a test app started (the app, its display, the
// background host and its shells all inherit the variables the harness gives it). Linux reads /proc; macOS has none,
// and ps -E shows each of the user's processes with its environment after its command. The same answer on both.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** ps's output can be long: every process, with its whole environment. */
const PS_BUFFER = 64 * 1024 * 1024;

/**
 * A process found: its id and its program's name.
 * @typedef {{ pid: number, program: string }} Found
 */

/** Whether processes can be found by their environment here (not on Windows). */
export const findsByEnvironment = process.platform === 'linux' || process.platform === 'darwin';

/** Linux: each process's environment from /proc. @param {string[]} marks @returns {Found[]} */
function fromProc(marks) {
  /** @type {Found[]} */
  const found = [];
  for (const name of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    try {
      const environment = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
      if (!marks.some(mark => environment.includes(mark))) continue;
      found.push({ pid: Number(name), program: path.basename(readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0')[0]) });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ESRCH'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) throw error;
      // gone, or not ours
    }
  }
  return found;
}

/** macOS: each process's command and environment from ps -E. @param {string[]} marks @returns {Found[]} */
function fromPs(marks) {
  return execFileSync('ps', ['-E', '-ax', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: PS_BUFFER }).split('\n')
    .filter(line => marks.some(mark => ` ${line} `.includes(` ${mark} `)))
    .map(line => {
      const [pid, command = ''] = line.trim().split(/\s+/);
      return { pid: Number(pid), program: path.basename(command) };
    });
}

/**
 * The processes with any of these variables (NAME=value) in their environment, this process aside; none where they
 * can't be found this way.
 * @param {string[]} marks
 * @returns {Found[]}
 */
export function processesWith(marks) {
  if (!findsByEnvironment || marks.length === 0) return [];
  return (process.platform === 'darwin' ? fromPs(marks) : fromProc(marks)).filter(p => p.pid !== process.pid);
}
