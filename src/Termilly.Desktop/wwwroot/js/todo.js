// @ts-check
// To do's lists: one on each terminal, each workspace and each SSH host, with its note above its tasks. A note stays as
// it always was (js/notes.js); here it's only read and shown. A terminal's and a workspace's tasks are saved with them,
// encrypted with the rest, and a closed terminal keeps its own; a host's are saved in state.todo. js/todopanel.js shows
// a list; anything else opens one with openTodo.

import { state, emit, persist, newId, wsById, tabTitle, isSsh, EVENTS } from './store.js';
import { NOTE_KIND, profileNote, noteTitle, notesFor } from './notes.js';
import { openCount, hoverLines, allTags } from './todolist.js';

/** Which list: a terminal's, a workspace's or a host's, by its id. */
export const LIST_KIND = NOTE_KIND;
/** @typedef {{ kind: string, id: string }} ListRef */

/**
 * A list as the panel shows it.
 * @typedef {object} TodoList
 * @property {ListRef} ref
 * @property {string} name
 * @property {TodoTask[]} tasks
 * @property {string} note
 * @property {boolean} pinned
 */

/**
 * What holds a list's tasks and note, or null when it's gone.
 * @param {ListRef} ref
 * @returns {Tab | Workspace | { id: string } | null}
 */
function ownerOf(ref) {
  if (ref.kind === LIST_KIND.terminal) return state.tabs.get(ref.id) ?? null;
  if (ref.kind === LIST_KIND.workspace) return wsById(ref.id) ?? null;
  return state.profiles.some(p => p.id === ref.id) ? { id: ref.id } : null;
}

/**
 * @param {ListRef} ref
 * @returns {string}
 */
function nameOf(ref) {
  if (ref.kind === LIST_KIND.terminal) return tabTitle(/** @type {Tab} */ (state.tabs.get(ref.id)));
  if (ref.kind === LIST_KIND.workspace) return /** @type {Workspace} */ (wsById(ref.id)).name;
  return state.profiles.find(p => p.id === ref.id)?.name ?? '';
}

/**
 * The tasks of a list, for reading.
 * @param {ListRef} ref
 * @returns {TodoTask[]}
 */
function tasksOf(ref) {
  if (ref.kind === LIST_KIND.host) return state.todo.hosts?.[ref.id] ?? [];
  return /** @type {Tab | Workspace | null} */ (ownerOf(ref))?.tasks ?? [];
}

/**
 * Puts a list's tasks back; an empty list keeps nothing.
 * @param {ListRef} ref
 * @param {TodoTask[]} tasks
 */
function setTasks(ref, tasks) {
  if (ref.kind === LIST_KIND.host) {
    state.todo.hosts ??= {};
    if (tasks.length) state.todo.hosts[ref.id] = tasks;
    else delete state.todo.hosts[ref.id];
    return;
  }
  const owner = /** @type {Tab | Workspace} */ (ownerOf(ref));
  if (tasks.length) owner.tasks = tasks;
  else delete owner.tasks;
}

/**
 * A list as it is now, or null when what it was on is gone.
 * @param {ListRef | null | undefined} ref
 * @returns {TodoList | null}
 */
export function listOf(ref) {
  const owner = ref && ownerOf(ref);
  if (!ref || !owner) return null;
  const note = ref.kind === LIST_KIND.host ? state.settings.shells.notes?.[ref.id] ?? ''
    : /** @type {Tab | Workspace} */ (owner).note?.text ?? '';
  const pinned = ref.kind === LIST_KIND.host || !!/** @type {Tab | Workspace} */ (owner).note?.pinned;
  return { ref, name: nameOf(ref), tasks: tasksOf(ref), note, pinned };
}

/**
 * What a list's note is on, as js/notes.js wants it: a terminal, a workspace or a host's id.
 * @param {ListRef} ref
 * @returns {Tab | Workspace | string}
 */
export const noteTarget = ref => (ref.kind === LIST_KIND.host ? ref.id : /** @type {Tab | Workspace} */ (ownerOf(ref)));

/** @param {ListRef} a @param {ListRef} b */
export const sameList = (a, b) => a.kind === b.kind && a.id === b.id;

/** @param {Tab} tab */
export const terminalList = tab => ({ kind: LIST_KIND.terminal, id: tab.id });
/** @param {Workspace} ws */
export const workspaceList = ws => ({ kind: LIST_KIND.workspace, id: ws.id });
/** @param {string} profile */
export const hostList = profile => ({ kind: LIST_KIND.host, id: profile });

/**
 * Whether a list has anything to show: a note or an open task.
 * @param {ListRef} ref
 */
function hasContent(ref) {
  const list = listOf(ref);
  return !!list && (!!list.note || openCount(list.tasks) > 0);
}

/**
 * The terminal's lists with something in them, its own first: what its mark opens and counts.
 * @param {Tab} tab
 */
function listsOfTab(tab) {
  const ws = wsById(tab.wsId);
  return [terminalList(tab), ...(isSsh(tab) ? [hostList(tab.profile)] : []), ...(ws ? [workspaceList(ws)] : [])].filter(hasContent);
}

/** The terminal in front, if there is one. */
function frontTab() {
  const ws = wsById(state.activeId);
  return ws?.focusId ? state.tabs.get(ws.focusId) ?? null : null;
}

/**
 * The list the title bar's button opens: the terminal in front's, else its host's or workspace's if only they have
 * something, else the terminal's empty one, ready for a first task.
 * @returns {ListRef | null}
 */
export function listInFront() {
  const tab = frontTab();
  if (tab) return listsOfTab(tab)[0] ?? terminalList(tab);
  const ws = wsById(state.activeId);
  return ws ? workspaceList(ws) : null;
}

/** Open tasks where you're working: the terminal in front's and its workspace's, for the title bar's button. */
export function openInFront() {
  const tab = frontTab();
  const ws = wsById(state.activeId);
  return openCount(tab?.tasks) + openCount(ws?.tasks);
}

/**
 * What a terminal's mark opens, or null with nothing on it (no mark then). Pinned workspace notes count, as they show
 * on the terminal; an unpinned workspace's list is marked on the workspace's own row.
 * @param {Tab} tab
 * @returns {ListRef | null}
 */
export function markedList(tab) {
  if (hasContent(terminalList(tab))) return terminalList(tab);
  if (isSsh(tab) && hasContent(hostList(tab.profile))) return hostList(tab.profile);
  return notesFor(tab).length && wsById(tab.wsId) ? workspaceList(/** @type {Workspace} */ (wsById(tab.wsId))) : null;
}

/**
 * The hover of a terminal's mark: its notes' first lines, then its open tasks.
 * @param {Tab} tab
 */
export function tabHover(tab) {
  const host = isSsh(tab) && !profileNote(tab) ? state.todo.hosts?.[tab.profile] : null;
  return [...(notesFor(tab).length ? [noteTitle(notesFor(tab))] : []), ...hoverLines(tab.tasks), ...hoverLines(host)].join('\n');
}

/** To do's tags, from every list there is: a closed terminal's stay with it until it's reopened. */
export const todoTags = () => allTags([
  ...[...state.tabs.values()].map(tab => tab.tasks),
  ...state.workspaces.map(ws => ws.tasks),
  ...Object.values(state.todo.hosts ?? {}),
]);

/**
 * Asks for a list to be shown, in the panel.
 * @param {ListRef} ref
 */
export const openTodo = ref => emit(EVENTS.openTodo, ref);

/**
 * A list changed: what shows it is told, and it's saved.
 * @param {ListRef} ref
 */
function changed(ref) {
  if (ref.kind === LIST_KIND.terminal) {
    const tab = state.tabs.get(ref.id);
    if (tab) emit(EVENTS.tab, tab);
  } else if (ref.kind === LIST_KIND.workspace) {
    emit(EVENTS.workspaces);
  } else {
    for (const tab of state.tabs.values()) if (tab.profile === ref.id) emit(EVENTS.tab, tab);
  }
  emit(EVENTS.todo);
  persist();
}

/**
 * Adds tasks to the end of a list's open ones, or the start of its done ones: they show in the order given.
 * @param {ListRef} ref
 * @param {{ text: string, tags?: string[], done?: boolean, details?: string }[]} tasks
 */
export function addTasks(ref, tasks) {
  const created = Date.now();
  /** @type {TodoTask[]} */
  const added = tasks.map(task => ({
    id: newId('k'), text: task.text, created,
    ...(task.tags?.length ? { tags: task.tags } : {}),
    ...(task.done ? { done: true } : {}),
    ...(task.details ? { details: task.details } : {}),
  }));
  setTasks(ref, [...tasksOf(ref), ...added]);
  changed(ref);
}

/**
 * Changes one task.
 * @param {ListRef} ref
 * @param {string} id
 * @param {Partial<TodoTask>} change a field left undefined is removed
 */
export function updateTask(ref, id, change) {
  setTasks(ref, tasksOf(ref).map(task => {
    if (task.id !== id) return task;
    const next = { ...task, ...change };
    for (const key of /** @type {(keyof TodoTask)[]} */ (Object.keys(change))) if (change[key] === undefined) delete next[key];
    return next;
  }));
  changed(ref);
}

/**
 * @param {ListRef} ref
 * @param {string} id
 */
export function removeTask(ref, id) {
  setTasks(ref, tasksOf(ref).filter(task => task.id !== id));
  changed(ref);
}

/**
 * Moves a task to the end of another list.
 * @param {ListRef} from
 * @param {string} id
 * @param {ListRef} to
 */
export function moveTask(from, id, to) {
  const task = tasksOf(from).find(t => t.id === id);
  if (!task || sameList(from, to)) return;
  setTasks(from, tasksOf(from).filter(t => t.id !== id));
  setTasks(to, [...tasksOf(to), task]);
  changed(from);
  changed(to);
}

/**
 * Keeps a list's tasks in a new order (a drag).
 * @param {ListRef} ref
 * @param {(tasks: TodoTask[]) => void} reorder changes the list it's given
 */
export function reorderTasks(ref, reorder) {
  const tasks = [...tasksOf(ref)];
  reorder(tasks);
  setTasks(ref, tasks);
  changed(ref);
}
