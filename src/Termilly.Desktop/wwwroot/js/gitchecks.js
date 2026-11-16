// @ts-check
// A repository's GitHub checks in the Git window (js/gitwindow.js), through gh (the host's github:runs and the rest):
// a dot on each commit in History whose checks ran (failing, running or passing), and a commit's checks in its
// details, each failed job with Why? (the end of its log), Fix with an agent (a To do task with that log, and the
// list's Implement plan started on it, in the branch's own worktree when it has one) and Re-run failed.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { GITHUB_RUN_STATUS, GITHUB_RUN_CONCLUSION } from './constants.js';
import { escapeHtml } from './ui.js';
import { modal } from './dialogs.js';
import { targetOf } from './dom.js';
import { askGitHub } from './github.js';
import { toastHere, TOAST } from './toasts.js';
import { addTasks, findTask } from './todo.js';
import { implement, implementPlace, planOf, cantImplement } from './todoactions.js';
import { listFor } from './issueimplement.js';

/**
 * A workflow run as gh lists it.
 * @typedef {{ id: number, workflow: string, title: string, status: string, conclusion: string | null, event: string,
 *   branch: string | null, headSha: string, url: string, createdAt: string }} Run
 */
/** @typedef {{ id: number, name: string, status: string, conclusion: string | null, url: string, failedStep: string | null }} Job */
/**
 * What checks work with from the window: the repository, where a branch is checked out (the folder an agent fixes
 * it in; null when nowhere), and git's errors.
 * @typedef {{ root: string, folderFor: (branch: string | null) => Promise<string | null>,
 *   showError: (text: string) => unknown }} ChecksContext
 */

/** How a commit's checks went, all told: its dot's class (git.css). */
const CHECK_STATE = Object.freeze({ failing: 'failing', running: 'running', passing: 'passing', other: 'other' });
/** The log's dialog class (dialogs.js). */
const LOG_DIALOG = 'git-log-dialog';
/** How much of a log goes into a task's details (the agent can read the rest with gh). */
const DETAILS_MOST = 12000;
/** Conclusions that count as a failure. */
/** @type {Set<string>} */
const FAILED = new Set([GITHUB_RUN_CONCLUSION.failure, GITHUB_RUN_CONCLUSION.timedOut, GITHUB_RUN_CONCLUSION.startupFailure]);

/** The repository's latest runs, by commit. */
export const checks = {
  /** @type {Map<string, Run[]>} */
  bySha: new Map(),
  loaded: false,
};

let asked = 0;

/**
 * Loads the repository's latest runs; true when it was the latest asking.
 * @param {string} root
 */
export async function loadChecks(root) {
  const mine = ++asked;
  // No checks shown is what a failed asking means here (gh offline, Actions off): Refresh asks again.
  /** @type {Run[]} */
  const runs = await askGitHub(PAGE.githubRuns, { root, branch: null }).catch(() => []);
  if (mine !== asked) return false;
  checks.bySha = new Map();
  for (const run of runs) checks.bySha.set(run.headSha, [...(checks.bySha.get(run.headSha) ?? []), run]);
  checks.loaded = true;
  return true;
}

/** Forgets them (another repository, Refresh). */
export function resetChecks() {
  asked++;
  checks.bySha = new Map();
  checks.loaded = false;
}

/** @param {Run | Job} r */
const stateOf = r => (r.status !== GITHUB_RUN_STATUS.completed ? CHECK_STATE.running
  : FAILED.has(r.conclusion ?? '') ? CHECK_STATE.failing
    : r.conclusion === GITHUB_RUN_CONCLUSION.success ? CHECK_STATE.passing : CHECK_STATE.other);

/**
 * All of a commit's runs, told as one: failing if any failed, else running if any runs, else passing.
 * @param {Run[]} runs
 */
function overall(runs) {
  const states = runs.map(stateOf);
  for (const s of [CHECK_STATE.failing, CHECK_STATE.running, CHECK_STATE.passing]) if (states.includes(s)) return s;
  return CHECK_STATE.other;
}

/** @param {Run[]} runs */
function summary(runs) {
  const failed = runs.filter(r => stateOf(r) === CHECK_STATE.failing).length;
  const running = runs.filter(r => stateOf(r) === CHECK_STATE.running).length;
  if (failed) return `${failed} of ${runs.length} check${runs.length === 1 ? '' : 's'} failed`;
  if (running) return `${running} check${running === 1 ? '' : 's'} running`;
  return `All ${runs.length} check${runs.length === 1 ? '' : 's'} passed`;
}

/**
 * A commit's dot in History; nothing when no checks ran on it.
 * @param {string} sha
 */
export function checkDotHtml(sha) {
  const runs = checks.bySha.get(sha);
  return runs?.length ? `<span class="gw-check" data-check="${overall(runs)}" title="${escapeHtml(summary(runs))}"></span>` : '';
}

/**
 * Where a commit's checks go in its details, filled in once they're known (fillChecks).
 * @param {string} sha
 */
export const checksSlotHtml = sha => `<div class="gw-checks" data-checks-for="${escapeHtml(sha)}"></div>`;

/**
 * A failed job's line: what failed, and its buttons.
 * @param {Run} run
 * @param {Job} job
 */
const jobHtml = (run, job) => `<div class="gw-check-job"><span class="gw-check" data-check="${stateOf(job)}"></span>`
  + `<span class="gw-check-name">${escapeHtml(job.name)}${job.failedStep ? ` · ${escapeHtml(job.failedStep)}` : ''}</span>`
  + `<button class="btn small" data-check-why="${run.id}:${job.id}">Why?</button>`
  + `<button class="btn small" data-check-fix="${run.id}:${job.id}">Fix with an agent</button></div>`;

/**
 * A run's lines: its state, its workflow and title, and for a failed one its failed jobs and Re-run failed.
 * @param {Run} run
 * @param {Job[]} jobs
 */
function runHtml(run, jobs) {
  const failed = stateOf(run) === CHECK_STATE.failing;
  return `<div class="gw-check-run"><span class="gw-check" data-check="${stateOf(run)}"></span>`
    + `<button class="gw-link" data-check-open="${escapeHtml(run.url)}">${escapeHtml(run.workflow)}</button>`
    + `<span class="gw-check-name">${escapeHtml(run.event)}</span>`
    + `${failed ? `<button class="btn small" data-check-rerun="${run.id}">Re-run failed</button>` : ''}</div>`
    + jobs.filter(j => stateOf(j) === CHECK_STATE.failing).map(j => jobHtml(run, j)).join('');
}

/** Each run's jobs, as asked, by run. @type {Map<number, Job[]>} */
const jobsOf = new Map();

/**
 * Fills in a commit's checks: its runs, and each failed one's failed jobs.
 * @param {HTMLElement} rightEl
 * @param {string} sha
 * @param {string} root
 */
export async function fillChecks(rightEl, sha, root) {
  const slot = /** @type {HTMLElement | null} */ (rightEl.querySelector(`[data-checks-for="${CSS.escape(sha)}"]`));
  const runs = checks.bySha.get(sha) ?? [];
  if (!slot || !runs.length) return;
  for (const run of runs.filter(r => stateOf(r) === CHECK_STATE.failing && !jobsOf.has(r.id))) {
    jobsOf.set(run.id, await askGitHub(PAGE.githubRunJobs, { root, runId: run.id }).catch(() => []));
  }
  if (!slot.isConnected) return; // another commit was picked meanwhile
  slot.innerHTML = `<div class="gw-checks-head"><span class="gw-check" data-check="${overall(runs)}"></span>${escapeHtml(summary(runs))}</div>`
    + runs.map(r => runHtml(r, jobsOf.get(r.id) ?? [])).join('');
}

/**
 * A failed job's log, as gh gives its end.
 * @param {string} root
 * @param {number} runId
 * @param {number} jobId
 * @returns {Promise<{ text: string, url: string, cut: boolean }>}
 */
const failedLog = (root, runId, jobId) => askGitHub(PAGE.githubFailedLog, { root, runId, jobId });

/** @param {string} key "run:job" @returns {[number, number]} */
const idsOf = key => /** @type {[number, number]} */ (key.split(':').map(Number));

/** @param {number} runId */
const runById = runId => [...checks.bySha.values()].flat().find(r => r.id === runId);

/**
 * Fix with an agent: a task in the repository's To do list with the failed job's log, and the list's Implement plan
 * started on it, in the branch's worktree when it has one (else the repository, when the branch is checked out there).
 * @param {ChecksContext} ctx
 * @param {Run} run
 * @param {Job} job
 * @param {string} log
 */
async function fixWithAgent(ctx, run, job, log) {
  const folder = await ctx.folderFor(run.branch);
  if (!folder) return ctx.showError(`${run.branch} isn't checked out anywhere. Check it out, or make a worktree for it, first.`);
  const ref = listFor(ctx.root);
  const place = implementPlace(ref);
  if (!place) return ctx.showError(cantImplement(ref));
  const text = `Fix the failing check: ${run.workflow} / ${job.name}${run.branch ? ` on ${run.branch}` : ''}`;
  const details = `${job.url}\n\nThe end of its log:\n\n${log.slice(-DETAILS_MOST)}`;
  const [id] = addTasks(ref, [{ text, details }]);
  const found = findTask(id);
  if (!found) return null;
  const { started } = implement(ref, found.task, undefined, planOf(ref), { ...place, folder });
  toastHere({ text: started ? 'An agent is on it, from To do' : 'The task is in To do', state: TOAST.done });
  return started;
}

/**
 * Why? for a failed job: the end of its log in a dialog, with Copy, Open on GitHub and Fix with an agent.
 * @param {ChecksContext} ctx
 * @param {Run} run
 * @param {Job} job
 */
async function showWhy(ctx, run, job) {
  let log;
  try {
    log = await failedLog(ctx.root, run.id, job.id);
  } catch (e) {
    return ctx.showError(/** @type {Error} */ (e).message);
  }
  return modal(LOG_DIALOG, `<h3>${escapeHtml(job.name)} failed</h3>
    <p class="dialog-sub">${escapeHtml(run.workflow)}${job.failedStep ? `, at ${escapeHtml(job.failedStep)}` : ''}${log.cut ? '. The end of its log:' : ''}</p>
    <pre class="gw-check-log">${escapeHtml(log.text)}</pre>
    <div class="dialog-actions"><button class="btn" data-copy-log>Copy log</button><button class="btn" data-open-job>Open on GitHub</button><span class="spacer"></span>
    <button class="btn" data-cancel>Close</button><button class="btn primary" data-ok>Fix with an agent</button></div>`, (dialog, close) => {
    dialog.addEventListener('click', e => {
      if (targetOf(e).closest('[data-copy-log]')) navigator.clipboard.writeText(log.text);
      if (targetOf(e).closest('[data-open-job]')) send(PAGE.openUrl, { url: job.url || log.url });
    });
    return { submit: async () => close(await fixWithAgent(ctx, run, job, log.text) !== null) };
  });
}

/**
 * The checks' buttons in a commit's details; true when the click was one.
 * @param {MouseEvent} e
 * @param {ChecksContext} ctx
 */
export function checksClicked(e, ctx) {
  const t = targetOf(e);
  const open = /** @type {HTMLElement | null} */ (t.closest('[data-check-open]'));
  if (open) return send(PAGE.openUrl, { url: /** @type {string} */ (open.dataset.checkOpen) }), true;
  const rerun = /** @type {HTMLElement | null} */ (t.closest('[data-check-rerun]'));
  if (rerun) {
    askGitHub(PAGE.githubRerunFailed, { root: ctx.root, runId: Number(rerun.dataset.checkRerun) })
      .then(() => toastHere({ text: 'Running the failed jobs again', state: TOAST.done }), err => ctx.showError(err.message));
    return true;
  }
  const button = /** @type {HTMLElement | null} */ (t.closest('[data-check-why], [data-check-fix]'));
  if (!button) return false;
  const [runId, jobId] = idsOf(/** @type {string} */ (button.dataset.checkWhy ?? button.dataset.checkFix));
  const run = runById(runId);
  const job = jobsOf.get(runId)?.find(j => j.id === jobId);
  if (!run || !job) return true;
  if (button.dataset.checkWhy) showWhy(ctx, run, job);
  else failedLog(ctx.root, runId, jobId).then(log => fixWithAgent(ctx, run, job, log.text), err => ctx.showError(err.message));
  return true;
}
