// @ts-check
// To do and agents: what the termilly command and its MCP tools (list_tasks, get_task, add_task, tick_task, finish_task)
// can do with a task. An agent reads tasks, adds one when asked, ticks sub-items and finishes; it never edits or deletes one. A finish waits in Review
// for the user, and a task whose terminal closes before its agent finished goes back to Open.

import { state, on, tabTitle, runningAgent, wsById, EVENTS } from './store.js';
import { agentKind } from './agentkinds.js';
import { addApiMethods } from './api.js';
import { findTask, listsOfAsker, updateTask, setStatus, releaseClosed, addTasks, terminalList, workspaceList, nameOf, LIST_KIND } from './todo.js';
import { TASK_STATUS, detailLines, statusOf, subProgress, tickByNumber } from './todolist.js';
import { alertReview } from './notify.js';
import { workDone } from './todoreview.js';

/**
 * How the API names a task's statuses.
 * @type {Readonly<Record<string, string>>}
 */
const API_STATUS = Object.freeze({
  [TASK_STATUS.open]: 'open', [TASK_STATUS.progress]: 'in_progress', [TASK_STATUS.review]: 'review', [TASK_STATUS.done]: 'done',
});
/** Who finished a task, when it's not a terminal that says. */
const AN_AGENT = 'An agent';

/** @param {TodoTask} task */
const stepsOf = task => detailLines(task.details).filter(line => line.sub).map((line, i) => ({ number: i + 1, text: line.text, done: line.done }));

/** @param {TodoTask} task */
const describeTask = task => ({ id: task.id, title: task.text, status: API_STATUS[statusOf(task)], tags: task.tags ?? [], steps: stepsOf(task) });

/** @param {any} args */
function taskFor(args) {
  const found = findTask(String(args.task ?? ''));
  if (!found) throw new Error(`There's no task ${args.task}. list_tasks (termilly tasks) shows them.`);
  return found;
}

/**
 * Who finished a task: the agent in the terminal that asks, by its command (claude, codex), and that terminal. Not
 * tab.agentType: that's whether agents may type there (js/together.js), which named it "true" once that was on.
 * @param {string | undefined} from the terminal that asks
 */
function whoIs(from) {
  const tab = from ? state.tabs.get(from) : null;
  return tab ? `${agentKind(runningAgent(tab)).program} in ${tabTitle(tab)}` : AN_AGENT;
}

/**
 * Ticks sub-items, by number from 1.
 * @param {import('./todo.js').ListRef} ref
 * @param {TodoTask} task
 * @param {number[]} numbers
 */
function tick(ref, task, numbers) {
  const details = numbers.reduce((text, n) => tickByNumber(text, n), task.details ?? '');
  if (details !== (task.details ?? '')) updateTask(ref, task.id, { details });
}

/**
 * Adds a task the asking agent was told to add: to its terminal's list, or its workspace's.
 * @param {any} args
 */
function addTask({ title, details, tags, list, from }) {
  const tab = from ? state.tabs.get(from) : null;
  if (!tab) throw new Error('add_task adds to the To do list of the terminal you run in; run it from a Termilly terminal.');
  const text = String(title ?? '').trim();
  if (!text) throw new Error('A task needs a title.');
  const ws = wsById(tab.wsId);
  const ref = list === LIST_KIND.workspace && ws ? workspaceList(ws) : terminalList(tab);
  const tagList = String(tags ?? '').split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
  const [id] = addTasks(ref, [{ text, details: String(details ?? '').trim() || undefined, tags: tagList.length ? tagList : undefined }]);
  return { ...describeTask(/** @type {TodoTask} */ (findTask(id)?.task)), list: nameOf(ref) };
}

addApiMethods({
  task_add: args => addTask(args),
  tasks: ({ from }) => ({ tasks: listsOfAsker(from).flatMap(list => list.tasks.map(task => ({ ...describeTask(task), list: list.name }))) }),
  task: args => {
    const { task } = taskFor(args);
    return { ...describeTask(task), details: detailLines(task.details).filter(line => !line.sub).map(line => line.text).join('\n').trim() };
  },
  task_tick: ({ tick: numbers, ...args }) => {
    const { ref, task } = taskFor(args);
    tick(ref, task, String(numbers ?? '').split(',').map(Number).filter(n => n > 0));
    return describeTask(/** @type {TodoTask} */ (findTask(task.id)?.task));
  },
  // A finished step ticks it; its task waits in Review once every step is done, and until then it stays In progress.
  task_done: ({ summary, step, from, ...args }) => {
    const { ref, task } = taskFor(args);
    if (step) tick(ref, task, [Number(step)]);
    const now = /** @type {TodoTask} */ (findTask(task.id)?.task);
    const [done, all] = subProgress(now.details);
    const said = String(summary ?? '').trim();
    // Implement's reviewers look at it first, when it has some: the task stays In progress until they're done.
    if (workDone(now, said, whoIs(from), !!step && done < all)) return { ...describeTask(now), note: 'It is being reviewed. What the review finds comes back to you here; fix it and finish the task again.' };
    if (step && done < all) return { ...describeTask(now), note: `Step ${step} is ticked. The task stays in progress: ${all - done} left.` };
    setStatus(ref, task.id, TASK_STATUS.review, { plan: now.plan, review: { summary: said, by: whoIs(from) } });
    alertReview(now, said, from ? state.tabs.get(from) ?? null : null);
    return { ...describeTask(/** @type {TodoTask} */ (findTask(task.id)?.task)), note: 'It waits in Review for the user.' };
  },
});

// Closing a terminal changes the workspaces, so that's when to look. Before any are restored there's nothing to see.
on(EVENTS.workspaces, () => {
  if (state.tabs.size) releaseClosed();
});
