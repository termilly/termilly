// @ts-check
// Steps of the page's start for startup.log in the data folder (StartupLog.cs), next to the host's own: how long its
// scripts took, and how long each agent session took to come back. The host logs only a start's first minute, so
// nothing is sent after it.

import { PAGE } from './protocol.js';
import { send } from './host.js';

/** The host logs this long after its start; the page starts a few seconds after it. */
const LOG_FOR_MS = 60_000;

/**
 * Notes a step of the start in startup.log, with how long after the page's own start it came.
 * @param {string} step
 */
export function startupStep(step) {
  const at = performance.now();
  if (at > LOG_FOR_MS) return;
  send(PAGE.startupStep, { step: `${step} (page +${Math.round(at)} ms)` });
}

/**
 * Notes that the page's scripts have all run, and when its HTML was in. Not counted from the browser's list of what it
 * loaded: that list stops at 250 entries, fewer than the page's files.
 */
export function scriptsLoaded() {
  const page = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType('navigation')[0]);
  startupStep(`scripts all run, the page's HTML in at ${Math.round(page?.responseEnd ?? 0)} ms`);
}

/** When each terminal's agent session started resuming, by terminal id. @type {Map<string, number>} */
const resumeStarted = new Map();

/**
 * Notes a step of a terminal's agent session coming back, with the time since it started to.
 * @param {string} tabId
 * @param {string} step
 */
export function resumeStep(tabId, step) {
  const now = performance.now();
  if (!resumeStarted.has(tabId)) resumeStarted.set(tabId, now);
  const since = Math.round(now - /** @type {number} */ (resumeStarted.get(tabId)));
  startupStep(`resume ${tabId}: ${step}, ${since} ms in`);
}
