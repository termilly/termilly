// @ts-check
// To do on a phone (phone/todo.js): what its snapshot says about each list, and what it may do through the manage op. All of
// it needs Settings › Remote › Allow typing, and Implement needs Allow creating too (Features/Phone.cs). Tags are only picked
// here: Manage tags stays on the PC.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, newId, tabTitle } from './store.js';
import { setNote } from './notes.js';
import { listOf, noteTarget, addTasks, updateTask, removeTask, moveTask, setStatus, findTask, todoTags, tagColor } from './todo.js';
import {
  AGENT_COMMAND, agentWorking, folderOfList, implementPlace, cantImplement, isOnGitHub, checkRepo, keepIssue,
  implement as startImplement, planOf, agentsFor, reviewersAt,
} from './todoactions.js';
import { stopRun } from './todorun.js';
import { agentKind } from './agentkinds.js';
import { RUN, fitPlan, stageWords } from './todoplan.js';
import { parseTask, detailLines, statusOf, splitNote, tickSub, issueBody, labelsForTags, TASK_STATUS } from './todolist.js';

/** @typedef {import('./todo.js').ListRef} ListRef */

/** What a phone may ask about tasks (the message's "action"). Features/Phone.cs knows Implement's: it needs more. */
export const TODO_ACTION = Object.freeze({
  add: 'taskAdd', status: 'taskStatus', tick: 'taskTick', edit: 'taskEdit', move: 'taskMove', remove: 'taskDelete',
  implement: 'taskImplement', noteTasks: 'noteTasks', issueInfo: 'issueInfo', issueCreate: 'issueCreate',
});

/**
 * @param {TodoTask} task
 */
function taskForPhone(task) {
  const lines = detailLines(task.details);
  const tab = task.terminal ? state.tabs.get(task.terminal) : null;
  return {
    id: task.id, text: task.text, status: statusOf(task), tags: task.tags ?? [], details: task.details ?? '',
    notes: lines.filter(line => !line.sub).map(line => line.text).join('\n').trim(),
    steps: lines.filter(line => line.sub).map(({ at, text, done }) => ({ at, text, done })),
    agent: tab ? { id: tab.id, title: `${task.plan ? agentKind(task.plan.by).program : AGENT_COMMAND} in ${tabTitle(tab)}` } : null, working: agentWorking(task),
    // Implemented silently: no terminal to show, but an agent has it.
    running: !!task.run,
    // Who has it now, in words, while its agents work and review (js/todoplan.js).
    now: task.plan && statusOf(task) === TASK_STATUS.progress ? stageWords(task.plan, task.stage).text : null,
    review: task.review ?? null, issue: task.issue ?? null,
  };
}

/**
 * A list as a phone shows it: its tasks, and what can be done with them from this computer.
 * @param {ListRef} ref
 */
export function listForPhone(ref) {
  const tasks = listOf(ref)?.tasks ?? [];
  const folder = folderOfList(ref);
  if (folder && tasks.length) checkRepo(folder);
  // What Implement's sheet on the phone picks from: the list's plan, the agents that can do the work, and those that can review.
  const agents = agentsFor(ref).map(kind => ({ kind, name: agentKind(kind).name }));
  return { tasks: tasks.map(taskForPhone), implement: !!implementPlace(ref), github: !!folder && isOnGitHub(folder), plan: planOf(ref), agents, reviewers: reviewersAt(ref) };
}

/** To do's tags to pick from, with their colours. */
export const tagsForPhone = () => todoTags().map(([name]) => ({ name, color: tagColor(name) }));

/** @param {Record<string, any>} m */
function taskOf(m) {
  const found = findTask(String(m.task ?? ''));
  if (!found) throw new Error('That task is gone.');
  return found;
}

/**
 * @param {unknown} kind
 * @param {unknown} id
 * @returns {ListRef}
 */
function listNamed(kind, id) {
  const ref = { kind: String(kind ?? ''), id: String(id ?? '') };
  if (!listOf(ref)) throw new Error('That list is gone.');
  return ref;
}

/**
 * The tags a phone picked for a new task, each as a #tag in a task's text would be; what isn't one whole tag is left out.
 * @param {unknown} tags
 */
const phoneTags = tags => (Array.isArray(tags) ? tags.flatMap(tag => {
  const read = parseTask(`#${String(tag).replace(/^#+/, '')}`);
  return read.text ? [] : read.tags;
}) : []);

/** @param {Record<string, any>} m its text, details and the tags picked for it */
function add(m) {
  const ref = listNamed(m.kind, m.id);
  const task = parseTask(String(m.text ?? ''));
  if (!task.text) throw new Error('A task needs some text.');
  const tags = [...new Set([...task.tags, ...phoneTags(m.tags)])];
  addTasks(ref, [{ ...task, tags, details: String(m.details ?? '').trim() }]);
  return {};
}

/** @param {Record<string, any>} m */
function status(m) {
  const { ref, task } = taskOf(m);
  if (!Object.values(TASK_STATUS).includes(m.status)) throw new Error('That isn’t a status.');
  // Taken off In progress while it runs silently: its run stops, as on the PC.
  if (m.status !== TASK_STATUS.progress && task.run) stopRun(task);
  setStatus(ref, task.id, m.status, { review: task.review, terminal: task.terminal, run: task.run });
  return {};
}

/** @param {Record<string, any>} m */
function tick(m) {
  const { ref, task } = taskOf(m);
  updateTask(ref, task.id, { details: tickSub(task.details ?? '', Number(m.at), !!m.done) });
  return {};
}

/** @param {Record<string, any>} m the task's new text and details, or its tags */
function edit(m) {
  const { ref, task } = taskOf(m);
  if (Array.isArray(m.tags)) {
    updateTask(ref, task.id, { tags: m.tags.length ? m.tags.map(String) : undefined });
    return {};
  }
  const text = String(m.text ?? '').trim();
  if (!text) throw new Error('A task needs some text.');
  updateTask(ref, task.id, { text, details: String(m.details ?? '').trim() || undefined });
  return {};
}

/** @param {Record<string, any>} m */
function move(m) {
  const { ref, task } = taskOf(m);
  moveTask(ref, task.id, listNamed(m.toKind, m.toId));
  return {};
}

/** @param {Record<string, any>} m */
function remove(m) {
  const { ref, task } = taskOf(m);
  removeTask(ref, task.id);
  return {};
}

/**
 * The plan a phone's Implement runs: the list's, with what the phone picked instead (the agent, the reviewers, the rounds, and
 * silent or not), fitted to the agents there are.
 * @param {import('./todo.js').ListRef} ref
 * @param {Record<string, any>} m
 */
function phonePlan(ref, m) {
  const saved = planOf(ref);
  const picked = {
    by: typeof m.by === 'string' ? m.by : saved.by,
    reviewers: Array.isArray(m.reviewers) ? m.reviewers.map(String) : saved.reviewers,
    rounds: m.rounds === undefined ? saved.rounds : Number(m.rounds),
    run: m.silent === undefined ? saved.run : m.silent ? RUN.silent : RUN.terminal,
  };
  const plan = fitPlan(picked, agentsFor(ref));
  const can = reviewersAt(ref);
  return { ...plan, reviewers: plan.reviewers.filter(kind => can.includes(kind)) };
}

/** @param {Record<string, any>} m */
function implement(m) {
  const { ref, task } = taskOf(m);
  const sub = m.at === undefined ? undefined : detailLines(task.details).find(line => line.sub && line.at === Number(m.at));
  const { started, tab } = startImplement(ref, task, sub, phonePlan(ref, m));
  if (!started) throw new Error(`${cantImplement(ref)}.`);
  return tab ? { id: tab.id } : { silent: true };
}

/**
 * The note's selected lines, or all of it, become tasks; the rest stays the note.
 * @param {Record<string, any>} m
 */
function noteTasks(m) {
  const ref = listNamed(m.kind, m.id);
  const { tasks, rest } = splitNote(String(m.text ?? ''), Number(m.from ?? 0), Number(m.to ?? 0));
  if (!tasks.length) throw new Error('There’s no text to turn into tasks here.');
  setNote(ref.kind, noteTarget(ref), rest.trim(), !!m.pinned);
  addTasks(ref, tasks);
  return { count: tasks.length };
}

/** The host's answers about issues still waited for, by request. */
/** @type {Map<string, (m: Record<string, any>) => void>} */
const waiting = new Map();

/**
 * Asks the host about an issue and waits for its answer.
 * @param {(requestId: string) => void} ask sends the request
 * @returns {Promise<Record<string, any>>}
 */
function askHost(ask) {
  const requestId = newId('i');
  return new Promise(resolve => {
    waiting.set(requestId, resolve);
    ask(requestId);
  });
}

/** @param {Record<string, any>} m */
function answerAsked(m) {
  waiting.get(m.requestId)?.(m);
  waiting.delete(m.requestId);
}
onHost(HOST.todoIssueInfo, answerAsked);
onHost(HOST.todoIssueCreated, answerAsked);

/** @param {ListRef} ref */
function folderFor(ref) {
  const folder = folderOfList(ref);
  if (!folder) throw new Error('This list has no folder on the PC, so there’s no repository to use.');
  return folder;
}

/**
 * What the issue form starts with: the repository, its labels, those that match the task's tags, and its text.
 * @param {Record<string, any>} m
 */
async function issueInfo(m) {
  const { ref, task } = taskOf(m);
  const folder = folderFor(ref);
  const info = await askHost(requestId => send(PAGE.todoIssueInfo, { requestId, folder }));
  if (info.error) throw new Error(info.error);
  const labels = info.labels ?? [];
  return { task: task.id, repo: info.repo, labels, ticked: labelsForTags(labels, task.tags ?? []), title: task.text, body: issueBody(task) };
}

/** @param {Record<string, any>} m */
async function issueCreate(m) {
  const { ref, task } = taskOf(m);
  const folder = folderFor(ref);
  const made = await askHost(requestId => send(PAGE.todoIssueCreate, { requestId, folder, title: String(m.title ?? ''), body: String(m.body ?? ''), labels: m.labels ?? [] }));
  if (made.error || !made.url || !made.number) throw new Error(made.error ?? 'GitHub didn’t say where the issue is.');
  keepIssue(ref, task, undefined, { repo: String(m.repo ?? ''), number: made.number, url: made.url });
  return { number: made.number };
}

/** @type {Record<string, (m: Record<string, any>) => object | Promise<object>>} */
export const TODO_DO = {
  [TODO_ACTION.add]: add,
  [TODO_ACTION.status]: status,
  [TODO_ACTION.tick]: tick,
  [TODO_ACTION.edit]: edit,
  [TODO_ACTION.move]: move,
  [TODO_ACTION.remove]: remove,
  [TODO_ACTION.implement]: implement,
  [TODO_ACTION.noteTasks]: noteTasks,
  [TODO_ACTION.issueInfo]: issueInfo,
  [TODO_ACTION.issueCreate]: issueCreate,
};

