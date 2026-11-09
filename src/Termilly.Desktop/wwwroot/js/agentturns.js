// @ts-check
// An agent's turns in a terminal, counted, so a wait for "the turn after this prompt" can't miss one that ended before
// the wait began (together.js waitForTurn): every prompt the agent takes starts a turn (tab.agentTurns), every report
// it makes is counted (tab.agentReports), and text typed into it notes both as it goes in. The turn after it is over
// once a later one has started and the agent isn't working now, by a report made after the typing (an answer typed to
// a permission prompt isn't answered by that same prompt still showing). Its answer is kept with its turn, so a wait
// still gets it after the agent has exited.

import { AGENT_STATE, AGENT_SOURCE, HOOK_EVENT } from './constants.js';

/**
 * What of a terminal this keeps and reads.
 * @typedef {{ agent?: { state: string, message?: string | null } | null, agentTurns?: number, agentReports?: number,
 *   agentReply?: { turn: number, text: string | null } }} TurnTab
 */
/**
 * Where turns and reports stood when text was typed in (kept with the terminal's access, together.js): the last
 * typing (its turn, its reports, its id), and the reports at the last typing for each turn a send gave back, so a
 * wait given that turn (after_turn) is held to the same reports.
 * @typedef {{ typedAt?: number | null, typedReports?: number | null, typedId?: number, byTurn?: Map<number, number> }} Typed
 */
/** @typedef {{ baseline: number, typedReports: number | null, typedId: number | null }} WaitPlan */

/** The typings remembered by turn, at most (the latest ones). */
const MAX_TYPINGS = 16;

/**
 * Whether an agent's report starts a turn: the prompt it took (its hooks' UserPromptSubmit), or, from the poll, which
 * has no events, starting to work.
 * @param {{ event?: string, source?: string, state?: string }} report
 * @param {string | null | undefined} before the state it was in
 */
export const startsTurn = (report, before) => report.event === HOOK_EVENT.userPromptSubmit
  || (report.source === AGENT_SOURCE.poll && report.state === AGENT_STATE.working && before !== AGENT_STATE.working);

/**
 * Counts an agent's report, before tab.agent takes it: the report, the turn it starts, and the answer it gives.
 * @param {TurnTab} tab
 * @param {{ event?: string, source?: string, state?: string, message?: string | null }} report
 */
export function recordReport(tab, report) {
  tab.agentReports = (tab.agentReports ?? 0) + 1;
  if (startsTurn(report, tab.agent?.state)) tab.agentTurns = (tab.agentTurns ?? 0) + 1;
  if (report.state === AGENT_STATE.done) tab.agentReply = { turn: tab.agentTurns ?? 0, text: report.message ?? null };
}

/**
 * The turn count text typed now is waited out after: between turns it starts the next one; in a turn (working, or
 * asking the user, as a permission answer is typed) it belongs to the one going on.
 * @param {number} turns turns started so far
 * @param {string | null | undefined} state the agent's state now
 */
export const typedBaseline = (turns, state) =>
  (state === AGENT_STATE.working || state === AGENT_STATE.needsInput ? turns - 1 : turns);

/**
 * Notes, as text goes into the terminal, where its agent's turns and reports stood; returns the turn noted.
 * @param {TurnTab} tab
 * @param {Typed} typed
 */
export function noteTyping(tab, typed) {
  const at = typedBaseline(tab.agentTurns ?? 0, tab.agent?.state);
  const reports = tab.agentReports ?? 0;
  Object.assign(typed, { typedAt: at, typedReports: reports, typedId: (typed.typedId ?? 0) + 1 });
  typed.byTurn ??= new Map();
  typed.byTurn.delete(at); // re-added as the newest
  typed.byTurn.set(at, reports);
  if (typed.byTurn.size > MAX_TYPINGS) typed.byTurn.delete(/** @type {number} */ (typed.byTurn.keys().next().value));
  return at;
}

/**
 * Which turn a wait waits out: the one after `afterTurn` when asked, else after what was typed in last (counting only
 * reports since), else the one going on, else the next.
 * @param {TurnTab} tab
 * @param {Typed | null | undefined} typed
 * @param {number | null | undefined} afterTurn
 * @returns {WaitPlan}
 */
export function planWait(tab, typed, afterTurn) {
  if (typeof afterTurn === 'number' && Number.isFinite(afterTurn)) {
    return { baseline: afterTurn, typedReports: typed?.byTurn?.get(afterTurn) ?? null, typedId: null };
  }
  if (typeof typed?.typedAt === 'number') {
    return { baseline: typed.typedAt, typedReports: typed.typedReports ?? null, typedId: typed.typedId ?? null };
  }
  return { baseline: typedBaseline(tab.agentTurns ?? 0, tab.agent?.state), typedReports: null, typedId: null };
}

/**
 * A wait is over: the typing it waited after is used up, so a next wait without new typing is for a later turn; but
 * only if it's still the last typing (a newer send's isn't another wait's to clear).
 * @param {Typed | null | undefined} typed
 * @param {WaitPlan} plan
 */
export function waitDone(typed, plan) {
  if (typed && plan.typedId !== null && typed.typedId === plan.typedId) typed.typedAt = null;
}

/**
 * Whether the turn a wait waits out is over: one has started since its baseline, the agent isn't working now (done,
 * failed, asking, stopped, or gone), and, after typing, it has reported since.
 * @param {TurnTab} tab
 * @param {WaitPlan} plan
 */
export const isOver = (tab, { baseline, typedReports }) => (tab.agentTurns ?? 0) > baseline
  && tab.agent?.state !== AGENT_STATE.working && (typedReports === null || (tab.agentReports ?? 0) > typedReports);

/**
 * The answer a finished wait gives: the agent's when it's done now, or, gone since, the last it gave in a turn the
 * wait waited out.
 * @param {TurnTab} tab
 * @param {WaitPlan} plan
 */
export function replyOf(tab, { baseline }) {
  if (tab.agent?.state === AGENT_STATE.done) return tab.agent.message ?? null;
  return !tab.agent && (tab.agentReply?.turn ?? 0) > baseline ? tab.agentReply?.text ?? null : null;
}
