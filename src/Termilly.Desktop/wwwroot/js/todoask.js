// @ts-check
// Claude Code working on a task silently (Implement's Silent) asks the user for what it isn't allowed to do (the termilly
// MCP server's ask_permission, as its --permission-prompt-tool: AskingRun.cs). The task's row shows what it wants, with
// Allow, Allow all and Deny (js/todopanel.js), and the run waits for the answer. Asks that come while one is shown wait
// their turn. With To do's Allow all in Silent runs on, nobody is asked: it gets what it asks for at once.

import { state } from './store.js';
import { AGENT_STATE } from './constants.js';
import { showToast, TOAST } from './toasts.js';
import { alertTask, withdrawTask } from './notify.js';
import { findTask, updateTask } from './todo.js';

/** The user's answers. */
export const ASK = Object.freeze({ allow: 'allow', all: 'all', deny: 'deny' });

/** What Claude Code is told when the user says no, and when the run ends before they answer. */
const DENIED = 'The user said no to this in Termilly. Go on without it, and say in your reply what is left undone because of it.';
const ENDED = 'The run ended before the user answered.';
/** The longest a request's text is shown. */
const WHAT_CHARS = 300;

/**
 * What a tool would do, as the row says it: the tools that run commands, change files and open pages say so.
 * @type {Readonly<Record<string, string>>}
 */
const VERBS = Object.freeze({
  Bash: 'wants to run', PowerShell: 'wants to run', Edit: 'wants to change', MultiEdit: 'wants to change', Write: 'wants to write',
  NotebookEdit: 'wants to change', WebFetch: 'wants to open', WebSearch: 'wants to search the web for',
});

/** @typedef {{ behavior: string, updatedInput?: object, message?: string }} Answer */
/** @typedef {{ taskId: string, ask: NonNullable<TodoTask['ask']>, allow: Answer, resolve: (answer: Answer) => void }} Waiting */

/**
 * The runs asking: whether the user allowed everything for the rest of the run, and the asks waiting, first shown.
 * @type {Map<string, { allowAll: boolean, waiting: Waiting[] }>}
 */
const runs = new Map();

/**
 * What a tool would do, for the row.
 * @param {string} tool
 * @param {any} input
 * @returns {NonNullable<TodoTask['ask']>}
 */
export function describeAsk(tool, input) {
  const what = input?.command ?? input?.file_path ?? input?.notebook_path ?? input?.url ?? input?.query ?? input?.path ?? JSON.stringify(input ?? {});
  const text = String(what).trim();
  return { verb: VERBS[tool] ?? `wants to use ${tool}:`, what: text.length > WHAT_CHARS ? `${text.slice(0, WHAT_CHARS - 1)}…` : text };
}

/**
 * Shows a run's first waiting ask in its task's row, or none.
 * @param {string} taskId
 * @param {string} run
 */
function show(taskId, run) {
  const found = findTask(taskId);
  if (found && found.task.run === run) updateTask(found.ref, taskId, { ask: runs.get(run)?.waiting[0]?.ask });
}

/**
 * Tells the user: a note in the window, and the phones when they're away, as an agent that needs them does.
 * @param {TodoTask} task
 * @param {NonNullable<TodoTask['ask']>} ask
 */
function tell(task, ask) {
  showToast({ text: `“${task.text}” needs you: Allow or Deny in To do`, state: TOAST.done });
  alertTask(task, AGENT_STATE.needsInput, `${ask.verb} ${ask.what}`);
}

/**
 * Claude Code asks, silently, for a tool it may not use: the answer, once the user gives it.
 * @param {string} run
 * @param {TodoTask} task
 * @param {string} tool
 * @param {any} input
 * @returns {Promise<Answer>}
 */
export function askUser(run, task, tool, input) {
  const asking = runs.get(run) ?? { allowAll: false, waiting: [] };
  runs.set(run, asking);
  /** @type {Answer} */
  const allow = { behavior: ASK.allow, updatedInput: input ?? {} };
  if (asking.allowAll || state.todo.allowAll) return Promise.resolve(allow);
  return new Promise(resolve => {
    const ask = describeAsk(tool, input);
    asking.waiting.push({ taskId: task.id, ask, allow, resolve });
    if (asking.waiting.length > 1) return;
    show(task.id, run);
    tell(task, ask);
  });
}

/**
 * The user answers what a task's run asks: Allow, Allow all (this and everything else the run asks), or Deny.
 * @param {TodoTask} task
 * @param {string} choice one of ASK
 */
export function answerAsk(task, choice) {
  const asking = task.run ? runs.get(task.run) : null;
  if (!asking || !task.run) return;
  withdrawTask(task);
  if (choice === ASK.all) asking.allowAll = true;
  const answered = choice === ASK.all ? asking.waiting.splice(0) : asking.waiting.splice(0, 1);
  for (const waiting of answered) waiting.resolve(choice === ASK.deny ? { behavior: ASK.deny, message: DENIED } : waiting.allow);
  show(task.id, task.run);
  const next = asking.waiting[0];
  if (next) tell(task, next.ask);
}

/**
 * Allow all in Silent runs was turned on: what the runs ask now waits for nobody.
 */
export function allowWaiting() {
  for (const [run, asking] of runs) {
    const taskId = asking.waiting[0]?.taskId;
    for (const waiting of asking.waiting.splice(0)) waiting.resolve(waiting.allow);
    const found = taskId ? findTask(taskId) : null;
    if (!found) continue;
    withdrawTask(found.task);
    show(found.task.id, run);
  }
}

/**
 * A run ended: what it asked and nobody answered is refused, and it's forgotten (the task's ask goes with its status).
 * @param {string} run
 */
export function endAsking(run) {
  const asking = runs.get(run);
  runs.delete(run);
  for (const waiting of asking?.waiting ?? []) waiting.resolve({ behavior: ASK.deny, message: ENDED });
}
