// @ts-check
// To do on a phone (phone/todo.js): what its snapshot says about each list, and what it may do through the manage op. All of
// it needs Settings › Remote › Allow typing, and Implement needs Allow creating too (Features/Phone.cs). Tags are only picked
// here: Manage tags stays on the PC.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, newId, tabTitle } from './store.js';
import { setNote } from './notes.js';
import { listOf, noteTarget, addTasks, updateTask, removeTask, moveTask, setStatus, findTask, todoTags, tagColor } from './todo.js';
import { AGENT_COMMAND, agentInstalled, folderOfList, isOnGitHub, checkRepo, implementTask, keepIssue } from './todoactions.js';
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
    agent: tab ? { id: tab.id, title: `${AGENT_COMMAND} in ${tabTitle(tab)}` } : null,
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
  return { tasks: tasks.map(taskForPhone), implement: !!folder && agentInstalled(), github: !!folder && isOnGitHub(folder) };
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

/** @param {Record<string, any>} m */
function add(m) {
  const ref = listNamed(m.kind, m.id);
  const task = parseTask(String(m.text ?? ''));
  if (!task.text) throw new Error('A task needs some text.');
  addTasks(ref, [{ ...task, details: String(m.details ?? '').trim() }]);
  return {};
}

/** @param {Record<string, any>} m */
function status(m) {
  const { ref, task } = taskOf(m);
  if (!Object.values(TASK_STATUS).includes(m.status)) throw new Error('That isn’t a status.');
  setStatus(ref, task.id, m.status, { review: task.review, terminal: task.terminal });
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

/** @param {Record<string, any>} m */
function implement(m) {
  const { ref, task } = taskOf(m);
  const sub = m.at === undefined ? undefined : detailLines(task.details).find(line => line.sub && line.at === Number(m.at));
  const agent = implementTask(ref, task, sub);
  if (!agent) throw new Error('Implement needs Claude Code and a folder on the PC.');
  return { id: agent.id };
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

