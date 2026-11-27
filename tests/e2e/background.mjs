// @ts-check
// Shared by the background host's end-to-end tests.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** The virtual display the harness runs the app on (harness.mjs). */
const DISPLAY_PROGRAM = 'Xvfb';

/**
 * The processes a test gave its own background host pipe: its app, the host, and the shells the host runs.
 * @param {string} pipe
 * @returns {Promise<number[]>}
 */
export async function processesOf(pipe) {
  const found = [];
  for (const id of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    let environment, program;
    try {
      environment = await readFile(`/proc/${id}/environ`, 'utf8');
      program = path.basename((await readFile(`/proc/${id}/cmdline`, 'utf8')).split('\0')[0]);
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ESRCH'].includes(/** @type {any} */ (error).code)) continue; // gone, or not ours
      throw error;
    }
    if (!environment.split('\0').includes(`TERMILLY_HOST_PIPE=${pipe}`)) continue;
    // The harness's display gets the test's environment too, and stays till the harness ends it.
    if (program === DISPLAY_PROGRAM) continue;
    found.push(Number(id));
  }
  return found;
}

/**
 * Ends a test's background host, and its shells with it, whichever window got as far: found by the pipe name only
 * that test gives it.
 * @param {string} pipe
 */
export async function endHost(pipe) {
  for (const id of await processesOf(pipe)) {
    try {
      process.kill(id, 'SIGKILL');
    } catch (error) {
      if (/** @type {any} */ (error).code !== 'ESRCH') throw error; // ended since
    }
  }
}
