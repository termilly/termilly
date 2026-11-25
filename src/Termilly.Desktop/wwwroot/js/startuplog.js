// @ts-check
// Steps of the page's start for startup.log in the data folder (StartupLog.cs), next to the host's own: how long its
// scripts took, and how long each agent session took to come back. The host logs only a start's first minute, so
// nothing is sent after it.

import { PAGE } from './protocol.js';
import { send } from './host.js';

/** The host logs this long after its start; the page starts a few seconds after it. */
const LOG_FOR_MS = 60_000;
/** When the page's modules started to run: this one runs first in the bundle (scripts/bundle.mjs). */
const RUN_FROM = performance.now();

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
 * Notes that the page's scripts have all run: when its HTML was in, when the libraries before the modules were in
 * (lib/), when the modules were in and started to run. The browser lists only its first 250 files, fewer than an
 * unbundled page has: a time it doesn't list shows as 0.
 */
export function scriptsLoaded() {
  const page = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType('navigation')[0]);
  const files = /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType('resource'));
  const lastIn = (/** @type {RegExp} */ name) => Math.round(Math.max(0, ...files.filter(f => name.test(f.name)).map(f => f.responseEnd)));
  startupStep(`scripts all run: HTML in at ${Math.round(page?.responseEnd ?? 0)} ms, libraries in at ${lastIn(LIBRARY)} ms, `
    + `modules in at ${lastIn(MODULE)} ms and running from ${Math.round(RUN_FROM)} ms`);
}

/** The libraries the page loads before its modules, and its modules. */
const LIBRARY = /\/lib\/[^/]+\.js$/;
const MODULE = /\/js\/[^/]+\.js$/;

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
