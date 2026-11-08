// @ts-check
// Implement's Silent: nobody is watching, so Claude Code works on a task in a hidden shell, as a schedule's agent prompt
// does (the host's ScheduleRunner), allowed to change files. What else it needs, it asks the user for in the task's row
// (js/todoask.js), unless To do's settings allow it all. On an SSH host (the list's terminal is there) it runs there, in the
// folder that terminal is in; nobody can be asked from there, so it's refused what it would ask for, or with Allow all, gets it.
// The task is In progress while it runs, and goes to Review with its reply, or back to Open, with why, when it fails or is
// stopped. A run outlives nothing: closing Termilly ends it.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, newId, sourceOf, EVENTS } from './store.js';
import { PROFILE_SOURCE, AGENT_STATE } from './constants.js';
import { addApiMethods } from './api.js';
import { askUser, endAsking } from './todoask.js';
import { agentCommand, readResult, AGENT_COMMAND } from './agentcli.js';
import { plainText } from './schedulereport.js';
import { showToast, TOAST } from './toasts.js';
import { alertReview, alertTask } from './notify.js';
import { implementPlace } from './todoactions.js';
import { findTask, setStatus, updateTask, releaseClosed } from './todo.js';
import { silentPrompt, tickSub, TASK_STATUS } from './todolist.js';

/** @typedef {import('./todo.js').ListRef} ListRef */

/** Who a run's reply is from, in Review. */
export const SILENT_BY = 'Claude Code, silently';
/** The longest a run may take before it's stopped. */
const LIMIT_SECONDS = 3600;
/** A summary of output that wasn't Claude Code's result: its last line. */
const LAST_LINE_CHARS = 200;

/**
 * The runs going: by run, its task, and its sub-item's line when it's on one.
 * @type {Map<string, { taskId: string, line?: number }>}
 */
const going = new Map();

/** @param {string} run */
export const isRunning = run => going.has(run);

/**
 * Starts Claude Code silently on a task, or one of its sub-items, in the list's folder.
 * @param {ListRef} ref
 * @param {TodoTask} task
 * @param {import('./todolist.js').DetailLine} [sub]
 * @returns {boolean} whether it started
 */
export function implementSilently(ref, task, sub) {
  const place = implementPlace(ref);
  if (!place) return false;
  const { folder, profile } = place;
  const run = newId('t');
  // A shell on this computer reaches Termilly's pipe, so Claude Code there can ask the user.
  const ask = sourceOf(profile) === PROFILE_SOURCE.local;
  const all = !ask && state.todo.allowAll === true;
  const command = agentCommand(silentPrompt(task, sub), { shell: profile.shellIcon ?? profile.icon, changes: true, all, json: true, ask });
  going.set(run, { taskId: task.id, line: sub?.at });
  setStatus(ref, task.id, TASK_STATUS.progress, { run });
  send(PAGE.scheduleRun, { runId: run, profile: profile.id, cwd: folder, command, limitSeconds: LIMIT_SECONDS, ask });
  return true;
}

/**
 * Stops a task's run.
 * @param {TodoTask} task
 */
export function stopRun(task) {
  if (task.run) send(PAGE.scheduleStop, { runId: task.run });
}

/**
 * The last line of output that isn't empty, for saying why a run failed.
 * @param {string} text
 */
const lastLine = text => (text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? '').slice(0, LAST_LINE_CHARS);

/**
 * A run ended: its task goes to Review with the reply, or back to Open with why.
 * @param {{ runId?: string, exitCode?: number | null, tail?: string, stopped?: boolean, error?: string | null }} m
 */
async function ended(m) {
  const id = m.runId ?? '';
  const run = going.get(id);
  if (!run) return;
  going.delete(id);
  endAsking(id);
  // The reply is kept with the task; the host's copy of the output isn't needed.
  send(PAGE.scheduleForget, { runIds: [id] });
  const found = findTask(run.taskId);
  if (!found || found.task.run !== id) return;
  const text = await plainText(m.tail ?? '');
  const result = m.stopped || m.error ? null : readResult(text);
  const name = `“${found.task.text}”`;
  // Refused a tool, it still did what it could: that goes to Review, saying what it wasn't let do.
  if (!result || result.errored) {
    setStatus(found.ref, found.task.id, TASK_STATUS.open);
    const why = m.stopped ? 'It was stopped.' : m.error || result?.why || lastLine(text) || `${AGENT_COMMAND} didn’t answer.`;
    showToast({ text: `${name} is open again. ${why}`, state: m.stopped ? TOAST.done : TOAST.failed });
    if (!m.stopped) alertTask(found.task, AGENT_STATE.error, why);
    return;
  }
  const summary = [result.reply.trim(), result.failed ? result.why : ''].filter(Boolean).join('\n\n');
  if (run.line !== undefined) updateTask(found.ref, found.task.id, { details: tickSub(found.task.details ?? '', run.line, true) });
  setStatus(found.ref, found.task.id, TASK_STATUS.review, { review: { summary, by: SILENT_BY } });
  alertReview(found.task, summary.split(/\r?\n/)[0] ?? '', null);
  showToast({ text: `${name} waits for review`, state: TOAST.done });
}

onHost(HOST.scheduleEnded, m => void ended(m));

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
