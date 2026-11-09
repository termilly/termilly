// @ts-check
// Implement's hidden runs: nobody is watching, so an agent (Claude Code or Codex) works in a hidden shell, as a schedule's agent
// prompt does (the host's ScheduleRunner). A run does a task's work, reviews another agent's work on it, or fixes what a review
// found (js/todoreview.js decides which, and what follows). What Claude Code needs beyond changing files it asks the user for in
// the task's row (js/todoask.js), unless To do's settings allow it all. On an SSH host (the list's terminal is there) a run is
// there, in the folder that terminal is in; nobody can be asked from there, so it's refused what it would ask for, or with Allow
// all, gets it. A run outlives nothing: closing Termilly ends it.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, newId, sourceOf, EVENTS } from './store.js';
import { PROFILE_SOURCE, PROFILE_ICON, AGENT_KIND } from './constants.js';
import { quoteArg } from './quoting.js';
import { addApiMethods } from './api.js';
import { askUser, endAsking } from './todoask.js';
import { agentCommand, readResult } from './agentcli.js';
import { plainText } from './schedulereport.js';
import { findTask, releaseClosed } from './todo.js';

/** What a hidden run is for. */
export const ROLE = Object.freeze({ work: 'work', review: 'review', fix: 'fix' });
/** The longest a run may take before it's stopped. */
const LIMIT_SECONDS = 3600;
/** A summary of output that wasn't the agent's result: its last line. */
const LAST_LINE_CHARS = 200;

/**
 * @typedef {{ folder: string, profile: SessionProfile, server: string | null }} RunPlace where a run is: server is the SSH
 *   host's name, or null for this computer
 * @typedef {{ taskId: string, line?: number, role: string, kind: string }} HiddenRun its task, the sub-item's line when it's on
 *   one, what it's for (ROLE) and its agent (AGENT_KIND)
 * @typedef {{ result: import('./agentcli.js').AgentResult | null, stopped: boolean, why: string }} RunOutcome result: what the
 *   agent said, or null when it was stopped or gave no result; why: what to say then
 */

/**
 * The runs going, by run.
 * @type {Map<string, HiddenRun>}
 */
const going = new Map();

/** @param {string} run */
export const isRunning = run => going.has(run);

/**
 * Who hears of a run that ended (js/todoreview.js).
 * @type {(id: string, run: HiddenRun, outcome: RunOutcome) => void}
 */
let ended = () => {};

/** @param {typeof ended} fn */
export function onRunEnded(fn) {
  ended = fn;
}

/**
 * A command for an SSH host, in its user's login shell: ssh runs one without the login files, and those are what put an agent
 * on PATH (~/.local/bin, where Claude Code's installer puts it). It reads nothing, so it doesn't wait for input that never comes.
 * @param {string} command
 */
const loginShell = command => `"$SHELL" -l -c ${quoteArg(`${command} < /dev/null`, PROFILE_ICON.ssh)}`;

/**
 * Starts an agent in a hidden shell on a task.
 * @param {{ taskId: string, line?: number, role: string, kind: string, place: RunPlace, prompt: string }} run a review reads and
 *   changes nothing; the work and a fix may change files
 * @returns {string} the run's id
 */
export function runHidden({ taskId, line, role, kind, place, prompt }) {
  const { folder, profile } = place;
  const id = newId('t');
  const review = role === ROLE.review;
  // A shell on this computer reaches Termilly's pipe, so Claude Code there can ask the user. A reviewer has nothing to ask for.
  const ask = !review && kind === AGENT_KIND.claude && sourceOf(profile) === PROFILE_SOURCE.local;
  const all = !ask && state.todo.allowAll === true;
  const agent = agentCommand(prompt, { kind, shell: profile.shellIcon ?? profile.icon, changes: !review, all, json: true, ask, review });
  going.set(id, { taskId, line, role, kind });
  send(PAGE.scheduleRun, { runId: id, profile: profile.id, cwd: folder, command: place.server ? loginShell(agent) : agent, limitSeconds: LIMIT_SECONDS, ask });
  return id;
}

/**
 * Stops a task's runs: the one it shows, and any other going for it (reviewers work at the same time).
 * @param {TodoTask} task
 */
export function stopRun(task) {
  const runs = new Set([...(task.run ? [task.run] : []), ...[...going].filter(([, run]) => run.taskId === task.id).map(([id]) => id)]);
  for (const runId of runs) send(PAGE.scheduleStop, { runId });
}

/**
 * The last line of output that isn't empty, for saying why a run failed.
 * @param {string} text
 */
const lastLine = text => (text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? '').slice(0, LAST_LINE_CHARS);

/**
 * A run ended: who waits for it hears what its agent said, or why there's nothing.
 * @param {{ runId?: string, exitCode?: number | null, tail?: string, stopped?: boolean, error?: string | null }} m
 */
async function runEnded(m) {
  const id = m.runId ?? '';
  const run = going.get(id);
  if (!run) return;
  // It stays among the runs going until its output is read, so its task isn't taken for one nobody works on.
  const text = await plainText(m.tail ?? '');
  going.delete(id);
  endAsking(id);
  // The reply is kept with the task; the host's copy of the output isn't needed.
  send(PAGE.scheduleForget, { runIds: [id] });
  const result = m.stopped || m.error ? null : readResult(text, run.kind);
  const why = m.stopped ? 'It was stopped.' : m.error || (result?.errored ? result.why : '') || lastLine(text) || `${run.kind} didn’t answer.`;
  ended(id, run, { result, stopped: !!m.stopped, why });
}

onHost(HOST.scheduleEnded, m => void runEnded(m));

// Claude Code working silently asks for what it may not do (the termilly MCP server's ask_permission): the user answers in
// the task's row, and the call waits for that.
addApiMethods({
  task_ask: ({ run, tool_name: tool, input }) => {
    const asking = going.get(String(run ?? ''));
    const found = asking ? findTask(asking.taskId) : null;
    if (!found || found.task.run !== run) throw new Error('That run has ended.');
    return askUser(String(run), found.task, String(tool ?? ''), input);
  },
});

// Runs don't outlive Termilly: tasks still marked as running when it starts go back to Open.
let looked = false;
on(EVENTS.workspaces, () => {
  if (looked || !state.tabs.size) return;
  looked = true;
  releaseClosed(isRunning);
});
