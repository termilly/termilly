// @ts-check
// Implement, from start to Review: the agent picked does the task's work (silently, js/todorun.js, or in a terminal,
// js/todoactions.js), then the agents picked to review it read what it did, each silently and changing nothing. What they find
// goes back to the agent that did the work, which fixes it, and they look again, for as many rounds as the plan allows
// (js/todoplan.js). A silent agent fixes in the session it did the work in, so it still knows what it did and why (should that
// session not open again, in a new one, told what was found); a reviewer starts anew each round, to look with fresh eyes. The task stays In progress all that time, its row saying who has it now, and reaches the user's Review with
// the reviewers' verdict and what each one said. With nobody reviewing, the work's reply goes straight to Review, as before.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, runningAgent } from './store.js';
import { AGENT_STATE } from './constants.js';
import { agentKind } from './agentkinds.js';
import { beforeEnter } from './api.js';
import { showToast, TOAST } from './toasts.js';
import { alertReview, alertTask } from './notify.js';
import { findTask, setStatus, updateTask } from './todo.js';
import { silentPrompt, detailLines, tickSub, statusOf, TASK_STATUS } from './todolist.js';
import { runHidden, onRunEnded, ROLE } from './todorun.js';
import { STAGE, RUN, reviewPrompt, fixPrompt, readReview } from './todoplan.js';

/** @typedef {import('./todo.js').ListRef} ListRef */
/** @typedef {import('./todoplan.js').ImplementPlan} ImplementPlan */
/** @typedef {import('./todoplan.js').AgentReview} AgentReview */
/** @typedef {import('./todorun.js').RunPlace} RunPlace */

/**
 * A task on its way through Implement with reviewers.
 * @typedef {object} Loop
 * @property {string} taskId
 * @property {number} [line] the sub-item's line, when Implement is on one
 * @property {ImplementPlan} plan
 * @property {RunPlace} place
 * @property {string | null} terminal the terminal the work is done in, or null when it's silent
 * @property {number} round the review round going, from 1; 0 before the first
 * @property {string} reply what the agent that does the work said last
 * @property {string} by who did the work, as Review names it
 * @property {AgentReview[]} reviews this round's reviews so far
 * @property {AgentReview[]} before what the round before found
 * @property {Set<string>} waiting this round's reviews still running, by run
 * @property {{ round: number, found: number }[]} earlier the rounds that found something, and how much
 * @property {string | null} session the silent agent's session, which its fix goes on from; null in a terminal, or unknown
 * @property {AgentReview[]} open the findings last handed back, should the fix have to start again
 */

/**
 * The tasks on their way, by task.
 * @type {Map<string, Loop>}
 */
const loops = new Map();

/** Who a silent run's reply is from, in Review. @param {string} kind */
export const silentBy = kind => `${agentKind(kind).name}, silently`;

/**
 * A task's row line for a prompt: its text, or the step of it Implement is on, and what its details say.
 * @param {TodoTask} task
 * @param {number} [line]
 */
function taskWords(task, line) {
  const lines = detailLines(task.details);
  const step = line === undefined ? null : lines.find(l => l.at === line);
  if (step) return `${step.text} (a step of '${task.text}')`;
  const notes = lines.filter(l => !l.sub).map(l => l.text).join(' ').trim();
  return notes ? `${task.text}. Details: ${notes}` : task.text;
}

/**
 * The loop's task, while it's still on its way: In progress with its plan (taking it off In progress by hand drops the plan).
 * @param {Loop} loop
 */
function live(loop) {
  const found = findTask(loop.taskId);
  if (found && statusOf(found.task) === TASK_STATUS.progress && found.task.plan) return found;
  loops.delete(loop.taskId);
  return null;
}

/**
 * Starts a loop for a task whose work has just begun, when its plan has reviewers.
 * @param {TodoTask} task
 * @param {ImplementPlan} plan
 * @param {RunPlace} place
 * @param {{ line?: number, terminal?: string | null }} [where]
 */
export function watchWork(task, plan, place, { line, terminal = null } = {}) {
  loops.delete(task.id);
  if (!plan.reviewers.length) return;
  loops.set(task.id, { taskId: task.id, line, plan, place, terminal, round: 0, reply: '', by: '', reviews: [], before: [], waiting: new Set(), earlier: [], session: null, open: [] });
}

/**
 * Starts the agent of a plan silently on a task, or one of its sub-items.
 * @param {ListRef} ref
 * @param {TodoTask} task
 * @param {import('./todolist.js').DetailLine | undefined} sub
 * @param {ImplementPlan} plan
 * @param {RunPlace} place
 */
export function implementSilently(ref, task, sub, plan, place) {
  // With reviewers its session is kept, for the fixes to go on from; with none, nothing would.
  const run = runHidden({ taskId: task.id, line: sub?.at, role: ROLE.work, kind: plan.by, place, prompt: silentPrompt(task, sub), keep: plan.reviewers.length > 0 });
  watchWork(task, plan, place, { line: sub?.at });
  setStatus(ref, task.id, TASK_STATUS.progress, { run, plan, stage: { what: STAGE.working, round: 0 } });
}

/**
 * The work on a task is done, as its agent in a terminal says (its finish_task, or its turn's end on an SSH host). With
 * reviewers, they get it now and the task stays In progress.
 * @param {TodoTask} task
 * @param {string} summary what the agent said it did
 * @param {string} by who, as Review names it
 * @param {boolean} [partial] it finished a step and others are left
 * @returns {boolean} whether reviewers took it; false: it's the caller's to put in Review
 */
export function workDone(task, summary, by, partial = false) {
  const loop = loops.get(task.id);
  if (!loop || !live(loop)) return false;
  // One step of a task Implement is on as a whole: its review waits for the rest.
  if (partial && loop.line === undefined) return false;
  // Said again while its review is still going: the review under way stands.
  if (loop.waiting.size) return true;
  loop.reply = summary;
  loop.by = by;
  startReviews(loop);
  return true;
}

/**
 * A review round: every reviewer reads the work at the same time, each on its own.
 * @param {Loop} loop
 */
function startReviews(loop) {
  const found = live(loop);
  if (!found) return;
  loop.round += 1;
  loop.before = loop.reviews.filter(r => !r.agrees);
  loop.reviews = [];
  const prompt = reviewPrompt(taskWords(found.task, loop.line), agentKind(loop.plan.by).name, loop.reply, loop.before);
  for (const kind of loop.plan.reviewers) {
    loop.waiting.add(runHidden({ taskId: loop.taskId, line: loop.line, role: ROLE.review, kind, place: loop.place, prompt }));
  }
  setStatus(found.ref, loop.taskId, TASK_STATUS.progress, {
    terminal: loop.terminal ?? undefined, run: [...loop.waiting][0], plan: loop.plan, stage: { what: STAGE.reviewing, round: loop.round },
  });
}

/**
 * The task waits for the user, with the reviewers' verdict.
 * @param {Loop} loop
 * @param {boolean} agreed
 */
function toReview(loop, agreed) {
  const found = live(loop);
  loops.delete(loop.taskId);
  if (!found) return;
  const { ref, task } = found;
  const review = {
    summary: loop.reply, by: loop.by, kind: loop.plan.by, reviews: loop.reviews, rounds: loop.round, earlier: loop.earlier, agreed,
    terminal: loop.terminal ?? undefined, session: loop.session ?? undefined,
  };
  setStatus(ref, task.id, TASK_STATUS.review, { plan: loop.plan, review });
  const tab = loop.terminal ? state.tabs.get(loop.terminal) ?? null : null;
  alertReview(task, loop.reply.split(/\r?\n/)[0] ?? '', tab);
  showToast({ text: `“${task.text}” waits for review`, state: TOAST.done });
}

/**
 * Types a prompt into the terminal of the agent that does the work, and sends it.
 * @param {Tab} tab
 * @param {string} prompt
 */
async function typeTo(tab, prompt) {
  send(PAGE.input, { id: tab.id, data: `\x1b[200~${prompt.replace(/\s*\r?\n\s*/g, ' ')}\x1b[201~` });
  await beforeEnter(tab);
  send(PAGE.input, { id: tab.id, data: '\r' });
}

/**
 * What a review found goes back to the agent that did the work: typed into its terminal, or as a new silent run.
 * @param {Loop} loop
 * @param {AgentReview[]} open the reviews that found something
 * @returns {boolean} whether it could be handed back
 */
function startFix(loop, open) {
  const found = live(loop);
  if (!found) return true;
  const found_ = open.reduce((sum, r) => sum + (r.count ?? 0), 0);
  const stage = { what: STAGE.fixing, round: loop.round + 1, count: found_ || null };
  const words = taskWords(found.task, loop.line);
  if (loop.terminal) {
    const tab = state.tabs.get(loop.terminal);
    if (!tab || !runningAgent(tab)) return false;
    loop.earlier.push({ round: loop.round, found: found_ });
    void typeTo(tab, fixPrompt(words, open, ` When you finish, call the termilly MCP tool finish_task with task ${found.task.id} and a one-line summary again.`));
    setStatus(found.ref, loop.taskId, TASK_STATUS.progress, { terminal: loop.terminal, plan: loop.plan, stage });
    return true;
  }
  loop.earlier.push({ round: loop.round, found: found_ });
  loop.open = open;
  fixSilently(loop, found, stage);
  return true;
}

/**
 * The agent that did the work silently fixes what was found: in the session it worked in, where that's known, else in a new one.
 * @param {Loop} loop
 * @param {{ ref: ListRef, task: TodoTask }} found
 * @param {TodoTask['stage']} stage
 */
function fixSilently(loop, found, stage) {
  const prompt = fixPrompt(taskWords(found.task, loop.line), loop.open, '');
  const run = runHidden({ taskId: loop.taskId, line: loop.line, role: ROLE.fix, kind: loop.plan.by, place: loop.place, prompt, keep: true, resume: loop.session });
  setStatus(found.ref, loop.taskId, TASK_STATUS.progress, { run, plan: loop.plan, stage });
}

/**
 * Every reviewer of a round has answered: they agree, or what they found goes back while rounds are left.
 * @param {Loop} loop
 */
function roundOver(loop) {
  const open = loop.reviews.filter(r => !r.agrees);
  if (!open.length) toReview(loop, true);
  else if (loop.round >= loop.plan.rounds || !startFix(loop, open)) toReview(loop, false);
}

/**
 * A task whose agents were stopped, or whose work gave nothing, is Open again, and the user is told why.
 * @param {string} taskId
 * @param {import('./todorun.js').RunOutcome} outcome
 */
function backToOpen(taskId, outcome) {
  const loop = loops.get(taskId);
  loops.delete(taskId);
  const found = findTask(taskId);
  if (!found || statusOf(found.task) !== TASK_STATUS.progress) return;
  // A terminal's agent is still there to go on with: only its review ends.
  if (loop?.terminal && outcome.stopped) {
    setStatus(found.ref, taskId, TASK_STATUS.progress, { terminal: loop.terminal });
    showToast({ text: `The review of “${found.task.text}” was stopped`, state: TOAST.done });
    return;
  }
  setStatus(found.ref, taskId, TASK_STATUS.open);
  showToast({ text: `“${found.task.text}” is open again. ${outcome.why}`, state: outcome.stopped ? TOAST.done : TOAST.failed });
  if (!outcome.stopped) alertTask(found.task, AGENT_STATE.error, outcome.why);
}

/**
 * The work's silent run, or a fix's, ended: its reply goes to the reviewers, or with none, to Review.
 * @param {string} id
 * @param {import('./todorun.js').HiddenRun} run
 * @param {import('./todorun.js').RunOutcome} outcome
 */
function workEnded(id, run, outcome) {
  const found = findTask(run.taskId);
  if (!found || found.task.run !== id) return;
  const { result } = outcome;
  const loop = loops.get(run.taskId);
  // Refused a tool, it still did what it could: that goes on, saying what it wasn't let do.
  if (!result || result.errored) {
    // Its session wouldn't open again (cleared, or the agent's files moved): the fix starts over in a new one.
    if (run.role === ROLE.fix && run.resumed && loop && !outcome.stopped) {
      loop.session = null;
      fixSilently(loop, found, found.task.stage);
    }
    // A fix that gave nothing leaves the work as the reviewers last saw it: that's the user's to judge.
    else if (run.role === ROLE.fix && loop && !outcome.stopped) toReview(loop, false);
    else backToOpen(run.taskId, outcome);
    return;
  }
  const summary = [result.reply.trim(), result.failed ? result.why : ''].filter(Boolean).join('\n\n');
  if (run.line !== undefined) updateTask(found.ref, found.task.id, { details: tickSub(found.task.details ?? '', run.line, true) });
  if (loop) {
    loop.reply = summary;
    loop.by = silentBy(run.kind);
    loop.session = result.session ?? loop.session;
    startReviews(loop);
    return;
  }
  setStatus(found.ref, found.task.id, TASK_STATUS.review, { plan: found.task.plan, review: { summary, by: silentBy(run.kind), kind: run.kind } });
  alertReview(found.task, summary.split(/\r?\n/)[0] ?? '', null);
  showToast({ text: `“${found.task.text}” waits for review`, state: TOAST.done });
}

/**
 * A reviewer's run ended: its review is kept, and with the round's last one, the round is over.
 * @param {string} id
 * @param {import('./todorun.js').HiddenRun} run
 * @param {import('./todorun.js').RunOutcome} outcome
 */
function reviewEnded(id, run, outcome) {
  const loop = loops.get(run.taskId);
  if (!loop || !loop.waiting.has(id)) return;
  if (outcome.stopped) {
    backToOpen(run.taskId, outcome);
    return;
  }
  loop.waiting.delete(id);
  const { result } = outcome;
  loop.reviews.push(result && !result.errored
    ? readReview(run.kind, result.reply)
    : { kind: run.kind, agrees: false, count: null, text: `It couldn’t review this. ${outcome.why}` });
  const found = live(loop);
  if (!found) return;
  if (loop.waiting.size) {
    // The task shows one of the runs still going, so Stop and a restart find it.
    if (found.task.run === id) updateTask(found.ref, loop.taskId, { run: [...loop.waiting][0] });
    return;
  }
  roundOver(loop);
}

onRunEnded((id, run, outcome) => (run.role === ROLE.review ? reviewEnded(id, run, outcome) : workEnded(id, run, outcome)));

/**
 * One more round for a task in Review whose reviewers didn't agree: what's still open goes back to the agent that did the
 * work, and they look again.
 * @param {ListRef} ref
 * @param {TodoTask} task
 * @param {RunPlace} place
 * @returns {boolean} whether it started
 */
export function oneMoreRound(ref, task, place) {
  const { plan, review } = task;
  const open = (review?.reviews ?? []).filter(r => !r.agrees);
  if (!plan || !review || !open.length) return false;
  const terminal = review.terminal && plan.run === RUN.terminal && state.tabs.has(review.terminal) ? review.terminal : null;
  const round = review.rounds ?? 1;
  /** @type {Loop} */
  const loop = {
    taskId: task.id, plan: { ...plan, rounds: round + 1 }, place, terminal, round, reply: review.summary, by: review.by,
    reviews: review.reviews ?? [], before: [], waiting: new Set(), earlier: [...(review.earlier ?? [])], session: review.session ?? null, open: [],
  };
  loops.set(task.id, loop);
  setStatus(ref, task.id, TASK_STATUS.progress, { terminal: terminal ?? undefined, plan: loop.plan, stage: { what: STAGE.fixing, round: round + 1 } });
  if (startFix(loop, open)) return true;
  // Its terminal's agent is gone: the fix runs silently instead.
  loop.terminal = null;
  return startFix(loop, open);
}
