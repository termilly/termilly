// @ts-check
// Shared by the background host's end-to-end tests.
import { readdir, readFile } from 'node:fs/promises';

/**
 * The processes a test gave its own background host pipe: its app, the host, and the shells the host runs.
 * @param {string} pipe
 * @returns {Promise<number[]>}
 */
export async function processesOf(pipe) {
  const found = [];
  for (const id of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    let environment;
    try {
      environment = await readFile(`/proc/${id}/environ`, 'utf8');
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ESRCH'].includes(/** @type {any} */ (error).code)) continue; // gone, or not ours
      throw error;
    }
    if (environment.split('\0').includes(`TERMILLY_HOST_PIPE=${pipe}`)) found.push(Number(id));
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
