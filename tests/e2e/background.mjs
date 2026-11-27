// @ts-check
// Shared by the background host's end-to-end tests.
import { processesWith } from './procs.mjs';

/** The virtual display the harness runs the app on (harness.mjs). */
const DISPLAY_PROGRAM = 'Xvfb';

/**
 * The processes a test gave its own background host pipe: its app, the host, and the shells the host runs.
 * @param {string} pipe
 * @returns {Promise<number[]>}
 */
export async function processesOf(pipe) {
  // The harness's display gets the test's environment too, and stays till the harness ends it.
  return processesWith([`TERMILLY_HOST_PIPE=${pipe}`]).filter(p => p.program !== DISPLAY_PROGRAM).map(p => p.pid);
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
