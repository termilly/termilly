// @ts-check
// Picking a To do list from a menu: the workspace in front's lists first, then each other workspace's in a submenu. To do's
// own Move to uses it (js/todopanel.js), and so does Add to To do list in the right-click menus of a terminal's selection
// (js/actions.js) and the Notepad (js/notepad.js): the text becomes tasks as a note's lines do (js/todolist.js
// tasksFromNote), on top of the list picked, and a toast offers to show them there.

import { state, wsById, tabsOf, tabTitle } from './store.js';
import { SEPARATOR } from './popups.js';
import { showToast, TOAST, SHOW } from './toasts.js';
import { ICONS, tabBadgeHtml, cssColor } from './ui.js';
import { addTasks, openTodo, listOf, sameList, workspaceList, terminalList } from './todo.js';
import { tasksFromNote } from './todolist.js';

/** @typedef {import('./todo.js').ListRef} ListRef */

/** A workspace's own list, in the menus. */
const WORKSPACE_LIST = 'Workspace list';
/** The right-click menus' item. */
const ADD_LABEL = 'Add to To do list';

/** @param {string} color */
export const dotHtml = color => `<span class="ws-dot" style="background:${cssColor(color)}"></span>`;

/**
 * Menu entries for every workspace: the one in front's own, the others each in a submenu.
 * @param {(ws: Workspace) => import('./popups.js').MenuEntry[]} entriesOf
 */
export function perWorkspace(entriesOf) {
  const active = wsById(state.activeId);
  const others = state.workspaces.filter(w => w !== active);
  return /** @type {import('./popups.js').MenuEntry[]} */ ([
    ...(active ? entriesOf(active) : []),
    ...(others.length ? [SEPARATOR] : []),
    ...others.map(w => ({ label: w.name, icon: dotHtml(w.color), submenu: () => entriesOf(w) })),
  ]);
}

/**
 * The lists to pick from, each workspace's and its terminals', but `skip`.
 * @param {(to: ListRef) => void} pick
 * @param {ListRef} [skip]
 */
export function listItems(pick, skip) {
  /** @param {ListRef} to @param {string} label @param {string} icon */
  const entry = (to, label, icon) => (skip && sameList(skip, to) ? [] : [{ label, icon, action: () => pick(to) }]);
  /** @param {Workspace} ws */
  const lists = ws => [
    ...entry(workspaceList(ws), WORKSPACE_LIST, ICONS.workspaces),
    ...tabsOf(ws).filter(t => !t.virtual).flatMap(t => entry(terminalList(t), tabTitle(t), tabBadgeHtml(t))),
  ];
  return perWorkspace(lists);
}

/**
 * Adds text to a list as tasks, saying so with a way to see them.
 * @param {ListRef} ref
 * @param {string} text
 */
function addText(ref, text) {
  const tasks = tasksFromNote(text);
  const list = listOf(ref);
  if (!tasks.length || !list) return void showToast({ text: 'No text to turn into tasks here', state: TOAST.failed });
  addTasks(ref, tasks);
  const what = tasks.length === 1 ? `“${tasks[0].text}”` : `${tasks.length} tasks`;
  showToast({ text: `${what} added to ${list.name}`, state: TOAST.done, action: { label: SHOW, run: () => openTodo(ref) } });
}

/**
 * Add to To do list, for a right-click menu: the text as tasks in the list picked from its submenu.
 * @param {string} text
 * @returns {import('./popups.js').MenuItem}
 */
export function addToTodoItem(text) {
  return { label: ADD_LABEL, icon: ICONS.todo, disabled: !text.trim(), submenu: () => listItems(to => addText(to, text)) };
}
