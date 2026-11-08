// @ts-check
// To do's lists: one on each terminal and each workspace, with its note above its tasks. A note stays as it always was
// (js/notes.js); here it's only read and shown. Tasks are saved with their terminal or workspace, encrypted with the rest,
// and a closed terminal keeps its own. js/todopanel.js shows a list; anything else opens one with openTodo.

import { state, emit, persist, newId, wsById, tabTitle, EVENTS, TAG_COLORS } from './store.js';
import { PAGE } from './protocol.js';
import { send } from './host.js';
import { NOTE_KIND, noteTitle, notesFor } from './notes.js';
import { openCount, hoverLines, allTags, tagHash, retag, TASK_STATUS } from './todolist.js';

/** Which list: a terminal's or a workspace's, by its id. */
export const LIST_KIND = Object.freeze({ terminal: NOTE_KIND.terminal, workspace: NOTE_KIND.workspace });
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
 * @returns {Tab | Workspace | null}
 */
function ownerOf(ref) {
  if (ref.kind === LIST_KIND.terminal) return state.tabs.get(ref.id) ?? null;
  return ref.kind === LIST_KIND.workspace ? wsById(ref.id) ?? null : null;
}

/**
 * @param {ListRef} ref
 * @returns {string}
 */
function nameOf(ref) {
  if (ref.kind === LIST_KIND.terminal) return tabTitle(/** @type {Tab} */ (state.tabs.get(ref.id)));
  return /** @type {Workspace} */ (wsById(ref.id)).name;
}

/**
 * The tasks of a list, for reading.
 * @param {ListRef} ref
 * @returns {TodoTask[]}
 */
function tasksOf(ref) {
  return ownerOf(ref)?.tasks ?? [];
}

/**
 * Tags outlive their tasks: what's on a task is kept, for picking again and for Manage tags.
 * @param {TodoTask[]} tasks
 */
function keepTags(tasks) {
  const kept = new Set(state.todo.tags);
  for (const task of tasks) for (const tag of task.tags ?? []) kept.add(tag);
  if (kept.size !== state.todo.tags?.length) state.todo.tags = [...kept];
}

/**
 * Puts a list's tasks back; an empty list keeps nothing.
 * @param {ListRef} ref
 * @param {TodoTask[]} tasks
 */
function setTasks(ref, tasks) {
  const owner = /** @type {Tab | Workspace} */ (ownerOf(ref));
  keepTags([...(owner.tasks ?? []), ...tasks]);
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
  return { ref, name: nameOf(ref), tasks: tasksOf(ref), note: owner.note?.text ?? '', pinned: !!owner.note?.pinned };
}

/**
 * What a list's note is on, as js/notes.js wants it.
 * @param {ListRef} ref
 */
export const noteTarget = ref => /** @type {Tab | Workspace} */ (ownerOf(ref));

/** @param {ListRef} a @param {ListRef} b */
export const sameList = (a, b) => a.kind === b.kind && a.id === b.id;

/** @param {Tab} tab */
export const terminalList = tab => ({ kind: LIST_KIND.terminal, id: tab.id });
/** @param {Workspace} ws */
export const workspaceList = ws => ({ kind: LIST_KIND.workspace, id: ws.id });

/**
 * Whether a list has anything to show: a note or an open task.
 * @param {ListRef} ref
 */
function hasContent(ref) {
  const list = listOf(ref);
  return !!list && (!!list.note || openCount(list.tasks) > 0);
}

/**
 * Whether a list gets a mark in the sidebar: a note or any task, even when all of them are done.
 * @param {ListRef} ref
 */
export function isMarked(ref) {
  const list = listOf(ref);
  return !!list && (!!list.note || list.tasks.length > 0);
}

/**
 * The terminal's lists with something in them, its own first: what its mark opens and counts.
 * @param {Tab} tab
 */
function listsOfTab(tab) {
  const ws = wsById(tab.wsId);
  return [terminalList(tab), ...(ws ? [workspaceList(ws)] : [])].filter(hasContent);
}

/** The terminal in front, if there is one. */
function frontTab() {
  const ws = wsById(state.activeId);
  return ws?.focusId ? state.tabs.get(ws.focusId) ?? null : null;
}

/**
 * The list the title bar's button opens: the terminal in front's, else its workspace's if only that has something, else
 * the terminal's empty one, ready for a first task.
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
 * What a terminal's mark opens, or null with nothing on it (no mark then). A pinned workspace note counts, as it shows
 * on the terminal, and so does a host's note, opening the terminal's list.
 * @param {Tab} tab
 * @returns {ListRef | null}
 */
export function markedList(tab) {
  if (isMarked(terminalList(tab))) return terminalList(tab);
  const ws = wsById(tab.wsId);
  if (ws && notesFor(tab).some(n => n.kind === NOTE_KIND.workspace)) return workspaceList(ws);
  return notesFor(tab).length ? terminalList(tab) : null;
}

/**
 * The hover of a terminal's mark: its notes' first lines, then its open tasks.
 * @param {Tab} tab
 */
export function tabHover(tab) {
  return [...(notesFor(tab).length ? [noteTitle(notesFor(tab))] : []), ...hoverLines(tab.tasks)].join('\n');
}

/** To do's tags with how many tasks have each: the kept ones, a coloured one, and any on a list there is. */
export const todoTags = () => allTags([
  ...[...state.tabs.values()].map(tab => tab.tasks),
  ...state.workspaces.map(ws => ws.tasks),
], [...(state.todo.tags ?? []), ...Object.keys(state.todo.tagColors ?? {})]);

/** The colour a new tag starts with: the next one round the palette. */
export const nextTagColor = () => TAG_COLORS[todoTags().length % TAG_COLORS.length];

/**
 * A tag's colour: the one picked for it, else one of the palette's from its name.
 * @param {string} tag
 */
export const tagColor = tag => state.todo.tagColors?.[tag] ?? TAG_COLORS[tagHash(tag) % TAG_COLORS.length];

/**
 * Picks a tag's colour, for every task that has it.
 * @param {string} tag
 * @param {string} color
 */
export function setTagColor(tag, color) {
  state.todo.tagColors = { ...state.todo.tagColors, [tag]: color };
  persist();
}

/**
 * Makes a tag no task has yet.
 * @param {string} tag
 * @param {string} color
 */
export function addTag(tag, color) {
  state.todo.tags = [...new Set([...(state.todo.tags ?? []), tag])];
  if (!state.todo.tagColors?.[tag]) setTagColor(tag, color);
  emit(EVENTS.todo);
}

/**
 * Changes a tag on every task.
 * @param {string} from
 * @param {string | null} to null takes it off
 */
function retagEverywhere(from, to) {
  for (const ref of allLists()) {
    const tasks = tasksOf(ref);
    if (!tasks.some(task => task.tags?.includes(from))) continue;
    setTasks(ref, tasks.map(task => {
      if (!task.tags?.includes(from)) return task;
      const { tags, ...rest } = task;
      const left = retag(tags ?? [], from, to);
      return left.length ? { ...rest, tags: left } : rest;
    }));
    changed(ref);
  }
}

/**
 * Takes a tag out of what's kept, with its colour.
 * @param {string} tag
 */
function forgetTag(tag) {
  state.todo.tags = state.todo.tags?.filter(name => name !== tag);
  const { [tag]: color, ...colors } = state.todo.tagColors ?? {};
  state.todo.tagColors = colors;
  return color;
}

/**
 * Renames a tag on every task, with its colour. To a tag there is, they become one, which keeps its own colour.
 * @param {string} from
 * @param {string} to
 */
export function renameTag(from, to) {
  retagEverywhere(from, to);
  const color = forgetTag(from);
  addTag(to, color ?? tagColor(from));
  persist();
}

/**
 * Deletes a tag: it comes off every task, and is gone from the lists to pick from.
 * @param {string} tag
 */
export function deleteTag(tag) {
  retagEverywhere(tag, null);
  forgetTag(tag);
  emit(EVENTS.todo);
  persist();
}

/** Tasks from when SSH hosts had lists go to the host's first terminal; a host with no terminal keeps them until it has. */
export function moveHostTasks() {
  for (const [profile, tasks] of Object.entries(state.todo.hosts ?? {})) {
    const tab = [...state.tabs.values()].find(t => t.profile === profile);
    if (!tab) continue;
    tab.tasks = [...(tab.tasks ?? []), ...tasks];
    delete state.todo.hosts?.[profile];
    persist();
  }
}

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
  if (ref.kind === LIST_KIND.workspace) emit(EVENTS.workspaces);
  else {
    const tab = state.tabs.get(ref.id);
    if (tab) emit(EVENTS.tab, tab);
  }
  emit(EVENTS.todo);
  persist();
}

/**
 * Adds tasks on top of a list, under the field they're typed in (done ones go to its done part): they show in the order given.
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
  setTasks(ref, [...added, ...tasksOf(ref)]);
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

/** Every list there is. */
function allLists() {
  return [...[...state.tabs.values()].map(terminalList), ...state.workspaces.map(workspaceList)];
}

/**
 * A task, wherever it is, and its list.
 * @param {string} id
 * @returns {{ ref: ListRef, task: TodoTask } | null}
 */
export function findTask(id) {
  for (const ref of allLists()) {
    const task = tasksOf(ref).find(t => t.id === id);
    if (task) return { ref, task };
  }
  return null;
}

/**
 * The lists an agent sees: its terminal's and its workspace's; every list when it isn't in a terminal.
 * @param {string | undefined} from the terminal that asks
 * @returns {TodoList[]}
 */
export function listsOfAsker(from) {
  const tab = from ? state.tabs.get(from) : null;
  const ws = tab ? wsById(tab.wsId) : null;
  const refs = tab ? [terminalList(tab), ...(ws ? [workspaceList(ws)] : [])] : allLists();
  return refs.flatMap(ref => listOf(ref) ?? []);
}

/**
 * Moves a task to a status. What only one status has goes with it: its terminal, and what its agent said.
 * @param {ListRef} ref
 * @param {string} id
 * @param {string} status
 * @param {{ terminal?: string, run?: string, review?: TodoTask['review'] }} [with_]
 */
export function setStatus(ref, id, status, { terminal, run, review } = {}) {
  const middle = status === TASK_STATUS.progress || status === TASK_STATUS.review;
  // An alert about it may wait for the user to leave the PC.
  if (status !== TASK_STATUS.review) send(PAGE.phoneWithdraw, { id });
  // What the agent said stays with a task accepted (Done), to read again in its row; a new run or Back to open clears it.
  const said = status === TASK_STATUS.done ? {} : { review: status === TASK_STATUS.review ? review : undefined };
  updateTask(ref, id, {
    done: status === TASK_STATUS.done ? true : undefined, status: middle ? status : undefined,
    terminal: status === TASK_STATUS.progress ? terminal : undefined, run: status === TASK_STATUS.progress ? run : undefined,
    // Nothing is asked for once it's off In progress, and a new run hasn't asked yet.
    ask: undefined,
    ...said,
  });
}

/**
 * A task whose terminal closed before its agent finished goes back to Open: nobody works on it now. So does one whose run out
 * of sight isn't going any more (Termilly was closed while it ran).
 * @param {(run: string) => boolean} [running] whether a run out of sight is going; left out, those aren't looked at
 */
export function releaseClosed(running) {
  for (const ref of allLists()) {
    for (const task of tasksOf(ref)) {
      const gone = (task.terminal && !state.tabs.has(task.terminal)) || (running && task.run && !running(task.run));
      if (gone) setStatus(ref, task.id, TASK_STATUS.open);
    }
  }
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
