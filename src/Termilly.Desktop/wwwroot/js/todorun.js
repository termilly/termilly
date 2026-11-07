// @ts-check
// Implement out of sight: Claude Code works on a task in a hidden shell, as a schedule's agent prompt does (the host's
// ScheduleRunner), allowed to change files. The task is In progress while it runs, and goes to Review with its reply,
// or back to Open, with why, when it fails or is stopped. A run outlives nothing: closing Termilly ends it.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, newId, isSsh, defaultProfile, EVENTS } from './store.js';
import { agentCommand, readResult, AGENT_COMMAND } from './agentcli.js';
import { plainText } from './schedulereport.js';
import { showToast, TOAST } from './toasts.js';
import { alertReview } from './notify.js';
import { folderOfList, agentInstalled } from './todoactions.js';
import { LIST_KIND, findTask, setStatus, updateTask, releaseClosed } from './todo.js';
import { outOfSightPrompt, tickSub, TASK_STATUS } from './todolist.js';

/** @typedef {import('./todo.js').ListRef} ListRef */

/** Who a run's reply is from, in Review. */
export const OUT_OF_SIGHT_BY = 'Claude Code, out of sight';
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
 * The shell a list's run goes in: its terminal's when that's on this computer, else the default one.
 * @param {ListRef} ref
 */
function profileFor(ref) {
  const tab = ref.kind === LIST_KIND.terminal ? state.tabs.get(ref.id) : null;
  const id = tab && !isSsh(tab) ? tab.profile : defaultProfile();
  return state.profiles.find(p => p.id === id) ?? null;
}

/**
 * Starts Claude Code out of sight on a task, or one of its sub-items, in the list's folder.
 * @param {ListRef} ref
 * @param {TodoTask} task
 * @param {import('./todolist.js').DetailLine} [sub]
 * @returns {boolean} whether it started
 */
export function implementOutOfSight(ref, task, sub) {
  const folder = folderOfList(ref);
  const profile = profileFor(ref);
  if (!folder || !profile || !agentInstalled()) return false;
  const run = newId('t');
  const command = agentCommand(outOfSightPrompt(task, sub), { shell: profile.shellIcon ?? profile.icon, changes: true, json: true });
  going.set(run, { taskId: task.id, line: sub?.at });
  setStatus(ref, task.id, TASK_STATUS.progress, { run });
  send(PAGE.scheduleRun, { runId: run, profile: profile.id, cwd: folder, command, limitSeconds: LIMIT_SECONDS });
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
  // The reply is kept with the task; the host's copy of the output isn't needed.
  send(PAGE.scheduleForget, { runIds: [id] });
  const found = findTask(run.taskId);
  if (!found || found.task.run !== id) return;
  const text = await plainText(m.tail ?? '');
  const result = m.stopped || m.error ? null : readResult(text);
  const name = `“${found.task.text}”`;
  if (!result || result.failed) {
    setStatus(found.ref, found.task.id, TASK_STATUS.open);
    const why = m.stopped ? 'It was stopped.' : m.error || result?.why || lastLine(text) || `${AGENT_COMMAND} didn’t answer.`;
    showToast({ text: `${name} is open again. ${why}`, state: m.stopped ? TOAST.done : TOAST.failed });
    return;
  }
  const summary = result.reply.trim();
  if (run.line !== undefined) updateTask(found.ref, found.task.id, { details: tickSub(found.task.details ?? '', run.line, true) });
  setStatus(found.ref, found.task.id, TASK_STATUS.review, { review: { summary, by: OUT_OF_SIGHT_BY } });
  alertReview(found.task, summary.split(/\r?\n/)[0] ?? '', null);
  showToast({ text: `${name} waits for review`, state: TOAST.done });
}

onHost(HOST.scheduleEnded, m => void ended(m));

// Runs don't outlive Termilly: tasks still marked as running when it starts go back to Open.
let looked = false;
on(EVENTS.workspaces, () => {
  if (looked || !state.tabs.size) return;
  looked = true;
  releaseClosed(isRunning);
});
