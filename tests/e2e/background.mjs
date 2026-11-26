// @ts-check
// Shared by the background host's end-to-end tests.
import { readdir, readFile } from 'node:fs/promises';

/**
 * Ends a test's background host, and its shells with it, whichever window got as far: found by the pipe name only
 * that test gives it.
 * @param {string} pipe
 */
export async function endHost(pipe) {
  const ids = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
  for (const id of ids) {
    let environment;
    try {
      environment = await readFile(`/proc/${id}/environ`, 'utf8');
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ESRCH'].includes(/** @type {any} */ (error).code)) continue; // gone, or not ours
      throw error;
    }
    if (!environment.split('\0').includes(`TERMILLY_HOST_PIPE=${pipe}`)) continue;
    try {
      process.kill(Number(id), 'SIGKILL');
    } catch (error) {
      if (/** @type {any} */ (error).code !== 'ESRCH') throw error; // ended since
    }
  }
}
