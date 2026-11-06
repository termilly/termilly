// @ts-check
// To do (the title bar's button, or Ctrl+Shift+K): one list at a time, in a panel docked on an edge or in a window of its
// own. A list opens where it was asked for (a terminal's or workspace's mark, their menus), the title bar's button opens
// the one in front, and the name in the panel's header picks another. It stays on its list as terminals change.
// A list's note stays a note, in a text box above its tasks; its right-click menu turns lines of it into tasks.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, persist, newId, lastFolderOf, wsById, tabsOf, tabTitle, isSsh, defaultProfile, EVENTS, TAG_COLORS } from './store.js';
import { newTab } from './panes.js';
import { commandLine } from './quoting.js';
import { escapeHtml, cssColor, tabBadgeHtml, countText, ICONS } from './ui.js';
import { byId, find, targetOf, WORKSPACE_ID, DOCK_GRIP, PANEL_HEAD, TOOL_COUNT } from './dom.js';
import { showMenu, openPopover, closeAll, SEPARATOR } from './popups.js';
import { showToast, TOAST } from './toasts.js';
import { setNote } from './notes.js';
import { KEY_ID } from './keymap.js';
import { copyOut, textBoxMenu } from './textmenu.js';
import { COPY_LABEL } from './termclipboard.js';
import { dockPanel, NOTEPAD_DOCK } from './dockpanel.js';
import { TAG_LIST, swatchesHtml } from './tagpicker.js';
import {
  parseTask, tasksFromLines, tasksFromNote, tagOfHeading, selectedLines, withoutLines, openCount, tagsIn, withTags, moveBefore, labelsForTags, issueBody, treeRows, found,
  detailLines, tickSub, linkSub, subProgress, implementPrompt,
} from './todolist.js';
import {
  LIST_KIND, listOf, noteTarget, sameList, listInFront, openInFront, terminalList, workspaceList, addTasks, updateTask,
  removeTask, moveTask, reorderTasks, todoTags, tagColor, setTagColor, moveHostTasks,
} from './todo.js';

/** @typedef {import('./todo.js').ListRef} ListRef */

const NAME = 'To do';
/** What Implement runs, and the longest name it gives its terminal. */
const AGENT_COMMAND = 'claude';
const MAX_AGENT_NAME = 32;
/** A tag picker's colour field. */
const COLOR_INPUT = 'color';
/** A workspace's own list, in the picker. */
const WORKSPACE_LIST = 'Workspace list';
/** What the code finds in the panel. */
const TASK = '.td-task';
const TASK_TEXT = '.td-text';
const EDIT_TEXT = '.td-edit-text';
const ISSUE_TITLE = '.td-issue-title';
const ISSUE_BODY = '.td-issue-body';
const WINDOW_KEY = 'todo';
/** What its controls do (data-td). */
const ACTION = Object.freeze({
  pick: 'pick', note: 'note', pin: 'pin', detach: 'detach', close: 'close', fold: 'fold', tag: 'tag', more: 'more', save: 'save',
  cancel: 'cancel', label: 'label', create: 'create', backToList: 'backToList', pickTags: 'pickTags', dropTag: 'dropTag',
  implement: 'implement', issue: 'issue', openIssue: 'openIssue',
});
/** How long after the last key a note is saved. */
const NOTE_SAVE_MS = 400;
/** The most a note's box grows to before it scrolls (rows). */
const NOTE_MAX_ROWS = 12;
const NOTE_LINE_PX = 20;
const NOTE_PADDING_PX = 12;
/** Where a task's tags show while it's edited. */
const EDIT_TAGS = '.td-edit-tags';

const panel = document.createElement('aside');
panel.className = 'notepad-panel todo-panel';
panel.hidden = true;
panel.innerHTML = `
  <div class="${DOCK_GRIP}" title="Drag to resize"></div>
  <div class="files-head">
    <span class="title-icon td-icon"></span>
    <span class="files-title">${NAME}</span>
    <button class="td-pick" data-td="${ACTION.pick}" title="Pick a list"><span class="td-pick-icon"></span><span class="td-pick-name"></span><span class="td-pick-sub"></span>${ICONS.chevronDown}</button>
    <span class="files-tools">
      <button class="pane-btn" data-td="${ACTION.note}" title="Show or hide this list’s note">${ICONS.note}</button>
      <span class="np-sep"></span>
      <button class="pane-btn" data-td="${ACTION.detach}" title="Detach to a window">${ICONS.detach}</button>
      <button class="pane-btn" data-td="${ACTION.close}" title="Close (Ctrl+Shift+K)">${ICONS.close}</button>
    </span>
  </div>
  <div class="td-view">
    <div class="td-note" hidden>
      <textarea class="td-note-text" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" placeholder="A note for this list"></textarea>
      <button class="pane-btn td-pin" data-td="${ACTION.pin}" title="Pin the first line to the terminal’s header">${ICONS.pin}</button>
    </div>
    <input class="field td-add" spellcheck="false" autocomplete="off">
    <div class="td-tags" hidden></div>
    <div class="td-list"></div>
  </div>
  <form class="td-issue" hidden></form>`;
byId(WORKSPACE_ID).append(panel);

const button = byId('todo-button');
const countEl = find(button, TOOL_COUNT);
find(panel, '.td-icon').innerHTML = /** @type {Element} */ (button.firstElementChild).outerHTML;
const head = find(panel, PANEL_HEAD);
const pickIcon = find(panel, '.td-pick-icon');
const pickName = find(panel, '.td-pick-name');
const pickSub = find(panel, '.td-pick-sub');
const view = find(panel, '.td-view');
const noteBox = find(panel, '.td-note');
const noteArea = /** @type {HTMLTextAreaElement} */ (find(panel, '.td-note-text'));
const pinButton = find(panel, '.td-pin');
const addField = /** @type {HTMLInputElement} */ (find(panel, '.td-add'));
const tagsEl = find(panel, '.td-tags');
const listEl = find(panel, '.td-list');
const issueForm = /** @type {HTMLFormElement} */ (find(panel, '.td-issue'));

/** The list it shows. */
/** @type {ListRef | null} */
let current = null;
/** The tag chips picked, for the list shown. */
/** @type {string[]} */
let picked = [];
/** Whether the note's box shows though the list has no note, and whether it's hidden though it has one. */
let writingNote = false;
let hidingNote = false;
/** The task being edited, in its row, and its tags so far. */
/** @type {string | null} */
let editing = null;
/** @type {string[]} */
let editTags = [];
/** Whether each folder's repository is on GitHub, as far as the host said. */
/** @type {Map<string, boolean>} */
const onGitHub = new Map();
/** The task (or its sub-item, by line) an issue is being made from, and what the host said about its repository. */
/** @type {{ taskId: string, line?: number, title: string, body: string, requestId: string, repo?: string, labels: string[], ticked: string[], error?: string, busy?: boolean, folder: string | null } | null} */
let issue = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let noteTimer = null;

const shown = () => listOf(current);

// ---- Drawing ----

/**
 * What gives a tag's chip its colour.
 * @param {string} tag
 */
const chipStyle = tag => `style="--td-hue:${cssColor(tagColor(tag))}"`;

/** @param {string} tag @param {boolean} [on] */
const chip = (tag, on = false) => `<button type="button" class="td-chip${on ? ' on' : ''}" ${chipStyle(tag)} data-td="${ACTION.tag}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;

/** @param {TodoTask} task */
function rowHtml(task) {
  if (task.id === editing) return editorHtml(task);
  const lines = detailLines(task.details);
  const notes = lines.filter(line => !line.sub).map(line => line.text).join('\n').trim();
  const [doneSubs, subs] = subProgress(task.details);
  const hasMeta = !!(task.tags?.length || task.issue || subs);
  return `<div class="td-task${task.done ? ' done' : ''}" data-task="${escapeHtml(task.id)}" draggable="true">
    <input class="td-check" type="checkbox" ${task.done ? 'checked' : ''} aria-label="Done">
    <div class="td-body"><div class="td-text">${escapeHtml(task.text)}</div>
      ${notes ? `<div class="td-details">${escapeHtml(notes)}</div>` : ''}
      ${hasMeta ? `<div class="td-meta">${subs ? `<span class="td-progress">${doneSubs}/${subs}</span>` : ''}${(task.tags ?? []).map(t => chip(t, picked.includes(t))).join('')}${issueChip(task.issue)}</div>` : ''}</div>
    ${actsHtml(task.issue)}<button class="pane-btn td-more" data-td="${ACTION.more}" title="More">${ICONS.more}</button>
    ${lines.filter(line => line.sub).map(subHtml).join('')}
  </div>`;
}

/** @param {{ url: string, number: number } | undefined} issue */
const issueChip = issue => (issue ? `<button type="button" class="td-gh" data-td="${ACTION.openIssue}" data-url="${escapeHtml(issue.url)}" title="Open issue #${issue.number} on GitHub">#${issue.number}</button>` : '');

/**
 * What a sub-item shows: its tick, its text, and the same actions as its task.
 * @param {import('./todolist.js').DetailLine} line
 */
function subHtml(line) {
  return `<div class="td-sub${line.done ? ' done' : ''}" data-sub="${line.at}">
    <input class="td-check td-sub-check" type="checkbox" ${line.done ? 'checked' : ''} aria-label="Done">
    <span class="td-text">${escapeHtml(line.text)}${issueChip(line.issue)}</span>
    ${actsHtml(line.issue)}
  </div>`;
}

/**
 * Implement, and Create GitHub issue when the folder's repository is on GitHub and there's no issue yet.
 * @param {{ url: string, number: number } | undefined} issue
 */
function actsHtml(issue) {
  const folder = folderOfList();
  const canIssue = !issue && !!folder && onGitHub.get(folder);
  return `<span class="td-acts">
    <button class="pane-btn" data-td="${ACTION.implement}" ${folder ? '' : 'disabled'} title="${folder ? 'Implement: start Claude Code on this in a new terminal' : 'Implement needs a folder on this computer'}">${ICONS.play}</button>
    ${canIssue ? `<button class="pane-btn" data-td="${ACTION.issue}" title="Create GitHub issue">${ICONS.git}</button>` : ''}
  </span>`;
}

/** @param {TodoTask} task */
function editorHtml(task) {
  return `<div class="td-edit" data-task="${escapeHtml(task.id)}">
    <input class="field td-edit-text" value="${escapeHtml(task.text)}" spellcheck="false" autocomplete="off" aria-label="Task">
    <textarea class="field td-edit-details" rows="3" spellcheck="false" placeholder="Details" aria-label="Details">${escapeHtml(task.details ?? '')}</textarea>
    <div class="td-edit-tags">${editTagsHtml()}</div>
    <span class="td-edit-actions"><button type="button" class="btn small" data-td="${ACTION.cancel}">Cancel</button><button type="button" class="btn small primary" data-td="${ACTION.save}">Save</button></span>
  </div>`;
}

/** The tags of the task being edited, each with its × and the button that adds more. */
function editTagsHtml() {
  const tags = editTags.map(tag => `<span class="td-chip" ${chipStyle(tag)} data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}<button type="button" class="td-chip-drop" data-td="${ACTION.dropTag}" data-tag="${escapeHtml(tag)}" title="Remove" aria-label="Remove ${escapeHtml(tag)}">${ICONS.close}</button></span>`);
  return `${tags.join('')}<button type="button" class="td-add-tag" data-td="${ACTION.pickTags}">${ICONS.plus}Tag</button>`;
}

/** @param {TodoList} list */
function listHtml(list) {
  const tasks = withTags(list.tasks, picked);
  const open = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);
  const empty = !list.tasks.length ? `<p class="td-empty">${list.note ? 'No tasks. Right-click the note to turn its lines into tasks.' : 'Nothing here yet.'}</p>` : '';
  return `${empty}${open.map(rowHtml).join('')}${done.length ? `<button class="td-fold" data-td="${ACTION.fold}" aria-expanded="${!!state.todo.showDone}">${state.todo.showDone ? ICONS.chevronDown : ICONS.chevronRight}Done<span class="td-fold-count">${done.length}</span></button>` : ''}${state.todo.showDone ? done.map(rowHtml).join('') : ''}`;
}

/** @typedef {import('./todo.js').TodoList} TodoList */

/** The note's box as tall as its text, up to a limit. */
function fitNote() {
  noteArea.style.height = 'auto';
  noteArea.style.height = `${Math.min(noteArea.scrollHeight, NOTE_MAX_ROWS * NOTE_LINE_PX + NOTE_PADDING_PX)}px`;
}

/** @param {TodoList} list */
function renderNote(list) {
  noteBox.hidden = hidingNote || (!list.note && !writingNote);
  pinButton.setAttribute('aria-pressed', String(list.pinned));
  // The text being typed stays as it is: a save comes back here.
  if (noteArea.ownerDocument.activeElement !== noteArea) noteArea.value = list.note;
  if (!noteBox.hidden) fitNote();
}

/**
 * What the picker's button says: the list, with its icon, and the workspace a terminal or host is in.
 * @param {TodoList} list
 */
function showPick(list) {
  const tab = list.ref.kind === LIST_KIND.terminal ? state.tabs.get(list.ref.id) : null;
  const ws = list.ref.kind === LIST_KIND.workspace ? wsById(list.ref.id) : null;
  pickName.textContent = list.name;
  pickSub.textContent = tab ? wsById(tab.wsId)?.name ?? '' : '';
  pickIcon.innerHTML = ws ? dotHtml(ws.color) : tab ? tabBadgeHtml(tab) : '';
}

/** @param {string} color */
const dotHtml = color => `<span class="ws-dot" style="background:${cssColor(color)}"></span>`;

/** Draws the list shown; the first list in front when what it was on has gone. */
function render() {
  if (!shown()) {
    current = listInFront();
    picked = [];
  }
  const list = shown();
  checkRepo();
  view.hidden = !!issue;
  issueForm.hidden = !issue;
  if (!list) {
    pickName.textContent = '';
    pickSub.textContent = '';
    pickIcon.innerHTML = '';
    listEl.innerHTML = '';
    return;
  }
  showPick(list);
  addField.placeholder = `Add a task to ${list.name}`;
  renderNote(list);
  const tags = tagsIn(list.tasks);
  picked = picked.filter(t => tags.some(([tag]) => tag === t));
  tagsEl.hidden = !tags.length;
  tagsEl.innerHTML = tags.map(([tag]) => chip(tag, picked.includes(tag))).join('');
  listEl.innerHTML = listHtml(list);
  find(panel, `[data-td="${ACTION.pick}"]`).title = `Pick a list. This one has ${openCount(list.tasks)} open`;
  if (issue) renderIssue(list);
}

/** The title bar button's count: open tasks where you're working, while the panel is closed. */
function showCount() {
  const count = openInFront();
  countEl.hidden = !panel.hidden || !count;
  countEl.textContent = countText(count);
  button.title = `To do (Ctrl+Shift+K)${count ? `: ${count} open` : ''}`;
}

// ---- Opening and closing ----

/** @param {{ quiet?: boolean, here?: boolean }} [options] */
function show({ quiet = false, here = false } = {}) {
  const reopens = dock.reopensWindowed(here);
  dock.setOpen(true);
  render();
  if (reopens) return dock.reopenWindow();
  if (!quiet) addField.focus();
}

/** Its handle in a window of its own on Linux: its title, dragged back into the main window (js/panes.js). */
const HANDLE = '.files-title';

const dock = dockPanel({
  panel, head, key: WINDOW_KEY, name: NAME, icon: /** @type {Element} */ (button.firstElementChild).outerHTML, handle: HANDLE,
  dockVar: '--todo-dock', inside: NOTEPAD_DOCK, stored: () => state.todo, button, showCount, show, render, focus: () => addField.focus(),
});

/**
 * Shows a list.
 * @param {ListRef} ref
 */
function openList(ref) {
  saveNoteNow();
  if (!current || !sameList(current, ref)) {
    picked = [];
    writingNote = false;
    hidingNote = false;
    editing = null;
    issue = null;
  }
  current = ref;
  state.todo.list = ref;
  persist();
  if (panel.hidden) show();
  else {
    render();
    if (dock.isDetached()) dock.toggle();
  }
}

/** To do on or off (its button, its keys, the palette): opened, it's on the list in front. */
export function toggleTodo() {
  if (panel.hidden) {
    const front = listInFront();
    if (front) current = front;
  }
  dock.toggle();
}

/** Shows To do as it was left (main.js, once the saved state is in). */
export function initTodo() {
  moveHostTasks();
  current = state.todo.list ?? null;
  dock.restorePlace();
  showCount();
  if (state.todo.open) show({ quiet: true });
}

// ---- The note ----

function saveNoteNow() {
  if (noteTimer === null) return;
  clearTimeout(noteTimer);
  noteTimer = null;
  const list = shown();
  if (list) writeNote(list, noteArea.value);
}

/** @param {TodoList} list @param {string} text */
function writeNote(list, text) {
  setNote(list.ref.kind, noteTarget(list.ref), text.trim(), list.pinned);
}

/** Turns the selected lines of the note, or all of it, into tasks, and takes them out of the note. */
function noteToTasks() {
  const list = shown();
  if (!list) return;
  const { value, selectionStart, selectionEnd } = noteArea;
  const { from, to } = selectedLines(value, selectionStart, selectionEnd);
  const tasks = tasksFromNote(value.slice(from, to));
  if (!tasks.length) return void showToast({ text: 'No text to turn into tasks here', state: TOAST.failed });
  if (noteTimer !== null) clearTimeout(noteTimer);
  noteTimer = null;
  const rest = withoutLines(value, from, to);
  noteArea.value = rest;
  writeNote(list, rest);
  addTasks(list.ref, tasks);
  showToast({ text: `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} added`, state: TOAST.done });
}

/** @param {MouseEvent} e */
function noteMenu(e) {
  const selected = noteArea.selectionStart !== noteArea.selectionEnd;
  textBoxMenu(e, noteArea, NAME, [
    {
      label: selected ? 'Turn selection into tasks' : 'Turn note into tasks', icon: ICONS.todo, disabled: !noteArea.value.trim(),
      title: 'Each list line is a task; a paragraph is one task with details; a heading tags what’s under it. The lines leave the note.',
      action: noteToTasks,
    },
  ]);
}

// ---- Picking a list ----

/** The workspaces in the tree, each with its terminals. */
function treeGroups() {
  return state.workspaces.map(ws => ({
    list: /** @type {TodoList} */ (listOf(workspaceList(ws))), color: ws.color,
    terms: tabsOf(ws).filter(t => !t.virtual).map(t => ({ list: /** @type {TodoList} */ (listOf(terminalList(t))), badge: tabBadgeHtml(t) })),
  }));
}

/** Workspaces folded or opened by hand; the others start open only when they hold the list shown or are in front. */
/** @type {Map<string, boolean>} */
const foldedByHand = new Map();

/** @param {import('./todolist.js').TreeGroup} group */
function isOpenInTree(group) {
  const hand = foldedByHand.get(group.list.ref.id);
  if (hand !== undefined) return hand;
  const shownNow = current;
  const holdsShown = !!shownNow && (sameList(group.list.ref, shownNow) || group.terms.some(t => sameList(t.list.ref, shownNow)));
  return holdsShown || group.list.ref.id === state.activeId;
}

/** @param {import('./todolist.js').TreeRow} row @param {number} at */
function treeRowHtml(row, at) {
  const { ref, name, note, tasks } = row.list;
  const icon = row.depth === 0 ? dotHtml(row.color ?? '') : row.badge ?? '';
  const on = current && sameList(ref, current) ? ' on' : '';
  const empty = note || openCount(tasks) || row.depth === 0 ? '' : ' dim';
  const fold = row.foldable ? `<span class="td-fold-mark" data-fold="${escapeHtml(ref.id)}">${row.open ? ICONS.chevronDown : ICONS.chevronRight}</span>` : row.depth === 0 ? '<span class="td-fold-mark"></span>' : '';
  return `<button class="td-tree-row depth${row.depth}${on}${empty}" data-row="${at}" role="option" aria-selected="${!!on}">${fold}${icon}<span class="td-tree-name">${escapeHtml(name)}</span>${row.count ? `<span class="tp-count">${row.count}</span>` : ''}</button>`;
}

/**
 * The picker while it's open: its search box and list, the rows shown and the one Enter opens.
 * @typedef {{ input: HTMLInputElement, body: HTMLElement, rows: import('./todolist.js').TreeRow[], active: number }} TreeView
 */

/** @param {TreeView} tree */
function markTree(tree) {
  for (const [i, row] of [...tree.body.children].entries()) row.classList.toggle('active', i === tree.active);
  tree.body.children[tree.active]?.scrollIntoView({ block: 'nearest' });
}

/** @param {TreeView} tree */
function drawTree(tree) {
  tree.rows = treeRows(treeGroups(), {
    query: tree.input.value, only: !!state.todo.onlyWithTasks, isOpen: isOpenInTree, isCurrent: list => !!current && sameList(list.ref, current),
  });
  // Typing, Enter opens the first list that was itself found, not one only shown as the way to it.
  const query = tree.input.value.trim().toLowerCase();
  tree.active = tree.rows.findIndex(r => (query ? found(r.list, query) : !!current && sameList(r.list.ref, current)));
  tree.body.innerHTML = tree.rows.map(treeRowHtml).join('') || '<div class="tp-empty">Nothing found</div>';
  markTree(tree);
}

/**
 * @param {TreeView} tree
 * @param {number} at
 */
function chooseRow(tree, at) {
  const row = tree.rows[at];
  if (!row) return;
  closeAll();
  openList(row.list.ref);
}

/** @param {TreeView} tree */
function wireTree(tree) {
  const { input, body } = tree;
  input.addEventListener('input', () => drawTree(tree));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') chooseRow(tree, tree.active < 0 ? 0 : tree.active);
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && tree.rows.length) {
      tree.active = (tree.active + (e.key === 'ArrowDown' ? 1 : tree.rows.length - 1)) % tree.rows.length;
      markTree(tree);
    } else return;
    e.preventDefault();
  });
  body.addEventListener('mousedown', e => e.preventDefault());
  body.addEventListener('click', e => {
    const fold = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-fold]'));
    if (fold) {
      const group = treeGroups().find(g => g.list.ref.id === fold.dataset.fold);
      if (group) foldedByHand.set(group.list.ref.id, !isOpenInTree(group));
      return drawTree(tree);
    }
    const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-row]'));
    if (row) chooseRow(tree, Number(row.dataset.row));
  });
}

/**
 * The picker: a search box over a tree shaped like the sidebar. Arrow keys and Enter work from the search box.
 * @param {HTMLElement} at
 */
function openTree(at) {
  const picker = at.ownerDocument.createElement('div');
  picker.className = 'popover td-tree';
  picker.hidden = true;
  picker.innerHTML = `<input class="field" placeholder="Find a list or task" spellcheck="false" aria-label="Find a list or task"><div class="tp-list" role="listbox"></div><label class="td-only"><input type="checkbox" ${state.todo.onlyWithTasks ? 'checked' : ''}> Only with tasks</label>`;
  /** @type {TreeView} */
  const tree = { input: /** @type {HTMLInputElement} */ (find(picker, 'input')), body: find(picker, TAG_LIST), rows: [], active: -1 };
  wireTree(tree);
  find(picker, '.td-only input').addEventListener('change', e => {
    state.todo.onlyWithTasks = /** @type {HTMLInputElement} */ (e.target).checked;
    persist();
    drawTree(tree);
    tree.input.focus();
  });
  drawTree(tree);
  openPopover(picker, at, { dynamic: true, refocus: () => addField.focus() });
  tree.input.focus();
}

/**
 * A menu of lists: the workspace in front's, then each other workspace in a submenu of its own.
 * @param {(ws: Workspace) => import('./popups.js').MenuEntry[]} entriesOf
 * @returns {import('./popups.js').MenuEntry[]}
 */
function perWorkspace(entriesOf) {
  const active = wsById(state.activeId);
  const others = state.workspaces.filter(w => w !== active);
  return /** @type {import('./popups.js').MenuEntry[]} */ ([
    ...(active ? entriesOf(active) : []),
    ...(others.length ? [SEPARATOR] : []),
    ...others.map(w => ({ label: w.name, icon: dotHtml(w.color), submenu: () => entriesOf(w) })),
  ]);
}

/** @param {HTMLElement} at */
function pickList(at) {
  openTree(at);
}

// ---- A task ----

/** @param {string} id */
const taskById = id => shown()?.tasks.find(t => t.id === id) ?? null;

function saveEdit() {
  const row = listEl.querySelector('.td-edit');
  const list = shown();
  if (!row || !list || !editing) return;
  const text = /** @type {HTMLInputElement} */ (find(row, EDIT_TEXT)).value.trim();
  if (!text) return;
  const details = /** @type {HTMLTextAreaElement} */ (find(row, '.td-edit-details')).value.trim();
  const id = editing;
  editing = null;
  updateTask(list.ref, id, { text, details: details || undefined, tags: editTags.length ? [...editTags] : undefined });
}

/** @param {string} id */
function beginEdit(id) {
  editing = id;
  editTags = [...(taskById(id)?.tags ?? [])];
  render();
  /** @type {HTMLInputElement | null} */ (listEl.querySelector(EDIT_TEXT))?.focus();
}

/** Draws the edited task's tags again; the rest of its form stays as typed. */
function showEditTags() {
  const tags = panel.querySelector(EDIT_TAGS);
  if (tags) tags.innerHTML = editTagsHtml();
}

/**
 * The tag picker while it's open: the colour a new tag gets, and the existing tag whose colours show.
 * @typedef {{ color: string, recolor: string | null }} TagPick
 */

/**
 * The list a task's tags are picked from: To do's tags, ticked when the task has them, each with its colour, and a new
 * one from what's typed.
 * @param {string} query
 * @param {TagPick} pick
 */
function tagRowsHtml(query, pick) {
  const known = todoTags().map(([tag, count]) => /** @type {[string, number]} */ ([tag, count]));
  for (const tag of editTags) if (!known.some(([name]) => name === tag)) known.push([tag, 0]);
  const rows = known.filter(([tag]) => tag.includes(query)).map(([tag, count]) => `
    <button class="tp-row" data-tag="${escapeHtml(tag)}" role="option" aria-selected="${editTags.includes(tag)}">
      <span class="check${editTags.includes(tag) ? ' on' : ''}"><svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg></span>
      <span class="td-chip" ${chipStyle(tag)}>${escapeHtml(tag)}</span><span class="tp-count">${count || ''}</span>
      <span class="td-tag-color" data-recolor="${escapeHtml(tag)}" style="background:${cssColor(tagColor(tag))}" title="Change the colour"></span>
    </button>${pick.recolor === tag ? swatchesHtml(tagColor(tag)) : ''}`);
  if (query && !known.some(([tag]) => tag === query)) {
    rows.push(`<button class="tp-row tp-create" data-tag="${escapeHtml(query)}" data-new><span class="menu-icon">${ICONS.plus}</span>Create<span class="td-chip" style="--td-hue:${cssColor(pick.color)}">${escapeHtml(query)}</span></button>${swatchesHtml(pick.color)}`);
  }
  return rows.join('') || '<div class="tp-empty">Type a name to create a tag</div>';
}

/**
 * Picks a colour: the existing tag's whose colours show, everywhere it's shown now, else the new tag's.
 * @param {TagPick} pick
 * @param {string} color
 */
function pickColor(pick, color) {
  if (!pick.recolor) {
    pick.color = color;
    return;
  }
  setTagColor(pick.recolor, color);
  for (const chipEl of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('.td-chip'))) {
    if (chipEl.dataset.tag === pick.recolor) chipEl.style.setProperty('--td-hue', color);
  }
}

/**
 * The list's clicks (a tag, its colour, Create, a swatch) and the colour field.
 * @param {HTMLElement} list
 * @param {TagPick} pick
 * @param {{ draw: () => void, choose: (tag: string, isNew: boolean) => void, focus: () => void }} handlers
 */
function wireTagList(list, pick, { draw, choose, focus }) {
  // The focus stays in the search field while tags are ticked; the colour field needs it.
  list.addEventListener('mousedown', e => {
    if (/** @type {HTMLInputElement} */ (e.target).type !== COLOR_INPUT) e.preventDefault();
  });
  list.addEventListener('click', e => {
    const swatch = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-color]'));
    const recolor = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-recolor]'));
    const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tag]'));
    if (swatch) pickColor(pick, /** @type {string} */ (swatch.dataset.color));
    else if (recolor) pick.recolor = pick.recolor === recolor.dataset.recolor ? null : recolor.dataset.recolor ?? null;
    else if (row) return choose(/** @type {string} */ (row.dataset.tag), 'new' in row.dataset);
    else return;
    draw();
  });
  // While the colour picker is open the chips follow it; choosing draws the swatches again.
  list.addEventListener('input', e => {
    const box = /** @type {HTMLInputElement} */ (e.target);
    if (box.type !== COLOR_INPUT) return;
    pickColor(pick, box.value);
    list.querySelector('.tp-create .td-chip')?.setAttribute('style', `--td-hue:${cssColor(box.value)}`);
  });
  list.addEventListener('change', e => {
    if (/** @type {HTMLInputElement} */ (e.target).type !== COLOR_INPUT) return;
    draw();
    focus();
  });
}

/** The colour a new tag starts with: the next one round the palette. */
const nextColor = () => TAG_COLORS[todoTags().length % TAG_COLORS.length];

/** @param {string} tag */
function toggleEditTag(tag) {
  editTags = editTags.includes(tag) ? editTags.filter(t => t !== tag) : [...editTags, tag];
  showEditTags();
}

/**
 * The picker of a task's tags, under its Tag button: tick existing tags, or type a new name and press Enter.
 * @param {HTMLElement} at
 */
function pickTags(at) {
  const doc = at.ownerDocument;
  const picker = doc.createElement('div');
  picker.className = 'popover tag-picker';
  picker.hidden = true;
  picker.innerHTML = `<input class="field" placeholder="Find or create a tag" spellcheck="false" aria-label="Tag"><div class="tp-list" role="listbox"></div>`;
  const input = /** @type {HTMLInputElement} */ (find(picker, 'input'));
  const list = find(picker, TAG_LIST);
  const query = () => tagOfHeading(input.value.replace(/^#/, ''));
  /** @type {TagPick} */
  const pick = { color: nextColor(), recolor: null };
  const draw = () => { list.innerHTML = tagRowsHtml(query(), pick); };
  /** @param {string} tag @param {boolean} isNew */
  const choose = (tag, isNew) => {
    if (isNew) {
      setTagColor(tag, pick.color);
      pick.color = nextColor();
    }
    toggleEditTag(tag);
    input.value = '';
    draw();
  };
  // Typing leaves a tag's colours: a swatch then is for the tag being typed.
  input.addEventListener('input', () => {
    pick.recolor = null;
    draw();
  });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !query()) return;
    e.preventDefault();
    choose(query(), !todoTags().some(([tag]) => tag === query()) && !editTags.includes(query()));
  });
  wireTagList(list, pick, { draw, choose, focus: () => input.focus() });
  draw();
  openPopover(picker, at, { dynamic: true, refocus: () => /** @type {HTMLElement | null} */ (panel.querySelector(EDIT_TEXT))?.focus() });
  input.focus();
}

/** @param {TodoTask} task */
function issueItems(task) {
  if (!task.issue) {
    const folder = folderOfList();
    return folder && onGitHub.get(folder) ? [{ label: 'Create GitHub issue', icon: ICONS.git, action: () => beginIssue(task) }] : [];
  }
  const { url, number } = task.issue;
  return [
    { label: `Open issue #${number} on GitHub`, icon: ICONS.link, action: () => send(PAGE.openUrl, { url }) },
    { label: 'Copy the link', icon: ICONS.copy, action: () => copyOut(url, NAME) },
    { label: 'Unlink the issue', icon: ICONS.close, title: 'The issue itself stays on GitHub', action: () => updateTask(/** @type {ListRef} */ (current), task.id, { issue: undefined }) },
  ];
}

/**
 * Where a task can move: the other lists of the workspace, and the other workspaces.
 * @param {TodoTask} task
 */
function moveItems(task) {
  const from = /** @type {ListRef} */ (current);
  /** @param {ListRef} to @param {string} label @param {string} icon */
  const entry = (to, label, icon) => (sameList(from, to) ? [] : [{ label, icon, action: () => moveTask(from, task.id, to) }]);
  /** @param {Workspace} ws */
  const lists = ws => [
    ...entry(workspaceList(ws), WORKSPACE_LIST, ICONS.workspaces),
    ...tabsOf(ws).filter(t => !t.virtual).flatMap(t => entry(terminalList(t), tabTitle(t), tabBadgeHtml(t))),
  ];
  return perWorkspace(lists);
}

/**
 * @param {TodoTask} task
 * @param {import('./popups.js').Anchor} at
 */
function taskMenu(task, at) {
  const ref = /** @type {ListRef} */ (current);
  showMenu([
    { label: 'Edit', icon: ICONS.rename, action: () => beginEdit(task.id) },
    { label: 'Move to', icon: ICONS.move, submenu: () => moveItems(task) },
    { label: COPY_LABEL, icon: ICONS.copy, action: () => copyOut(task.details ? `${task.text}\n${task.details}` : task.text, NAME) },
    SEPARATOR,
    ...issueItems(task),
    SEPARATOR,
    { label: 'Delete', icon: ICONS.trash, action: () => removeTask(ref, task.id) },
  ], at);
}

// ---- A GitHub issue from a task ----

/** The folder an issue is made from: where the list's terminal or workspace is, on this computer. */
function folderOfList() {
  const ref = /** @type {ListRef} */ (current);
  if (ref.kind === LIST_KIND.terminal) {
    const tab = state.tabs.get(ref.id);
    return tab && !isSsh(tab) ? lastFolderOf(tab) ?? wsById(tab.wsId)?.cwd ?? null : null;
  }
  return ref.kind === LIST_KIND.workspace ? wsById(ref.id)?.cwd ?? null : null;
}

/**
 * Starts the form that makes an issue from a task or one of its sub-items.
 * @param {TodoTask} task
 * @param {import('./todolist.js').DetailLine} [sub]
 */
function beginIssue(task, sub) {
  const folder = folderOfList();
  issue = {
    taskId: task.id, line: sub?.at, title: sub?.text ?? task.text, body: sub ? `Part of: ${task.text}` : issueBody(task),
    requestId: newId('i'), labels: [], ticked: [], folder, error: folder ? undefined : 'This list has no folder on this computer, so there’s no repository to use.',
  };
  render();
  if (folder) send(PAGE.todoIssueInfo, { requestId: issue.requestId, folder });
}

/**
 * Starts Claude Code in a new terminal, in the list's folder, on a task or one of its sub-items.
 * @param {TodoTask} task
 * @param {import('./todolist.js').DetailLine} [sub]
 */
function implement(task, sub) {
  const folder = folderOfList();
  if (!folder || !current) return;
  const tab = current.kind === LIST_KIND.terminal ? state.tabs.get(current.id) : null;
  const wsId = tab?.wsId ?? current.id;
  const profile = tab?.profile ?? defaultProfile();
  const shell = state.profiles.find(p => p.id === profile);
  // Windows PowerShell 5.1 breaks a program's argument at double quotes inside it: the prompt has none.
  const prompt = implementPrompt(task, sub).replaceAll('"', "'");
  newTab({ wsId, profile, cwd: folder, name: (sub?.text ?? task.text).slice(0, MAX_AGENT_NAME).trimEnd(), command: commandLine([AGENT_COMMAND, prompt], shell?.shellIcon ?? shell?.icon) });
}

/** Asks the host once whether the folder shown is on GitHub: the issue buttons wait for the answer. */
function checkRepo() {
  const folder = folderOfList();
  if (!folder || onGitHub.has(folder)) return;
  onGitHub.set(folder, false);
  send(PAGE.todoRepoCheck, { folder });
}

onHost(HOST.todoRepoChecked, m => {
  if (!m.folder || !m.onGitHub) return;
  onGitHub.set(m.folder, true);
  if (!panel.hidden && !editing) render();
});

/** @param {TodoList} list */
function renderIssue(list) {
  const task = list.tasks.find(t => t.id === issue?.taskId);
  if (!task || !issue) {
    issue = null;
    return void render();
  }
  const ready = !!issue.repo && !issue.busy;
  issueForm.innerHTML = `
    <h3>Create a GitHub issue</h3>
    <p class="td-issue-repo">${issue.repo ? escapeHtml(issue.repo) : issue.error ? '' : 'Finding the repository'}</p>
    ${issue.error ? `<p class="td-issue-error">${escapeHtml(issue.error)}</p>` : ''}
    <input class="field td-issue-title" value="${escapeHtml(issue.title)}" spellcheck="false" autocomplete="off" aria-label="Title">
    <textarea class="field td-issue-body" rows="8" spellcheck="false" placeholder="Body" aria-label="Body">${escapeHtml(issue.body)}</textarea>
    ${issue.labels.length ? `<div class="td-labels">${issue.labels.map(l => `<button type="button" class="td-label${issue?.ticked.includes(l) ? ' on' : ''}" data-td="${ACTION.label}" data-label="${escapeHtml(l)}" aria-pressed="${issue?.ticked.includes(l)}">${escapeHtml(l)}</button>`).join('')}</div>` : ''}
    <span class="td-edit-actions"><button type="button" class="btn small" data-td="${ACTION.backToList}">Cancel</button><button type="button" class="btn small primary" data-td="${ACTION.create}" ${ready ? '' : 'disabled'}>${issue.busy ? 'Creating' : 'Create issue'}</button></span>`;
}

function createIssue() {
  if (!issue?.repo || issue.busy || !issue.folder) return;
  const title = /** @type {HTMLInputElement} */ (find(issueForm, ISSUE_TITLE)).value.trim();
  if (!title) return;
  const body = /** @type {HTMLTextAreaElement} */ (find(issueForm, ISSUE_BODY)).value;
  issue = { ...issue, busy: true, error: undefined };
  send(PAGE.todoIssueCreate, { requestId: issue.requestId, folder: issue.folder, title, body, labels: issue.ticked });
  redrawIssue();
}

/** Draws the form again, keeping what was typed: the fields start from the task's text. */
function redrawIssue() {
  const title = /** @type {HTMLInputElement | null} */ (issueForm.querySelector(ISSUE_TITLE))?.value;
  const body = /** @type {HTMLTextAreaElement | null} */ (issueForm.querySelector(ISSUE_BODY))?.value;
  render();
  const newTitle = /** @type {HTMLInputElement | null} */ (issueForm.querySelector(ISSUE_TITLE));
  const newBody = /** @type {HTMLTextAreaElement | null} */ (issueForm.querySelector(ISSUE_BODY));
  if (newTitle && title !== undefined) newTitle.value = title;
  if (newBody && body !== undefined) newBody.value = body;
}

/** @param {string} label */
function toggleLabel(label) {
  if (!issue) return;
  issue = { ...issue, ticked: issue.ticked.includes(label) ? issue.ticked.filter(l => l !== label) : [...issue.ticked, label] };
  redrawIssue();
}

onHost(HOST.todoIssueInfo, m => {
  if (m.requestId !== issue?.requestId) return;
  const task = taskById(issue.taskId);
  issue = { ...issue, repo: m.repo ?? undefined, labels: m.labels ?? [], ticked: labelsForTags(m.labels ?? [], task?.tags ?? []), error: m.error ?? undefined };
  redrawIssue();
});

onHost(HOST.todoIssueCreated, m => {
  if (m.requestId !== issue?.requestId) return;
  if (m.error || !m.url || !m.number) {
    issue = { ...issue, busy: false, error: m.error ?? 'GitHub didn’t say where the issue is.' };
    return redrawIssue();
  }
  const { taskId, line, repo } = issue;
  issue = null;
  const details = taskById(taskId)?.details ?? '';
  updateTask(/** @type {ListRef} */ (current), taskId, line === undefined ? { issue: { repo: repo ?? '', number: m.number, url: m.url } } : { details: linkSub(details, line, m.url) });
  showToast({ text: `Issue #${m.number} created in ${repo}`, state: TOAST.done });
});

// ---- Wiring ----

/**
 * Implement or Create GitHub issue, on the task or sub-item the button is in.
 * @param {HTMLElement} control
 */
function rowAction(control) {
  const row = /** @type {HTMLElement | null} */ (control.closest('[data-task]'));
  const task = row && taskById(/** @type {string} */ (row.dataset.task));
  if (!task) return;
  const sub = /** @type {HTMLElement | null} */ (control.closest('[data-sub]'));
  const line = sub ? detailLines(task.details).find(l => l.at === Number(sub.dataset.sub)) : undefined;
  if (control.dataset.td === ACTION.implement) implement(task, line);
  else beginIssue(task, line);
}

/** @param {HTMLElement} control */
function act(control) {
  const row = /** @type {HTMLElement | null} */ (control.closest('[data-task]'));
  switch (control.dataset.td) {
    case ACTION.pick: return pickList(control);
    case ACTION.note:
      hidingNote = !noteBox.hidden;
      writingNote = !hidingNote;
      render();
      if (!hidingNote) noteArea.focus();
      return;
    case ACTION.pin: {
      const list = shown();
      if (list) setNote(list.ref.kind, noteTarget(list.ref), noteArea.value.trim(), !list.pinned);
      return render();
    }
    case ACTION.detach: return void dock.detach();
    case ACTION.close: return dock.hide();
    case ACTION.fold:
      state.todo.showDone = !state.todo.showDone;
      persist();
      return render();
    case ACTION.implement:
    case ACTION.issue: return rowAction(control);
    case ACTION.openIssue: return send(PAGE.openUrl, { url: control.dataset.url });
    case ACTION.tag: {
      const tag = /** @type {string} */ (control.dataset.tag);
      picked = picked.includes(tag) ? picked.filter(t => t !== tag) : [...picked, tag];
      return render();
    }
    case ACTION.more: {
      const task = row && taskById(/** @type {string} */ (row.dataset.task));
      if (task) taskMenu(task, control);
      return;
    }
    case ACTION.save: return saveEdit();
    case ACTION.cancel:
      editing = null;
      return render();
    case ACTION.pickTags: return pickTags(control);
    case ACTION.dropTag: return toggleEditTag(/** @type {string} */ (control.dataset.tag));
    case ACTION.label: return toggleLabel(/** @type {string} */ (control.dataset.label));
    case ACTION.create: return createIssue();
    case ACTION.backToList:
      issue = null;
      return render();
    default: return undefined;
  }
}

panel.addEventListener('click', e => {
  const control = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-td]'));
  if (control) act(control);
});

panel.addEventListener('change', e => {
  const box = targetOf(e);
  if (!box.classList.contains('td-check')) return;
  const row = /** @type {HTMLElement} */ (box.closest('[data-task]'));
  const sub = /** @type {HTMLElement | null} */ (box.closest('[data-sub]'));
  if (sub) {
    const details = taskById(/** @type {string} */ (row.dataset.task))?.details ?? '';
    return updateTask(/** @type {ListRef} */ (current), /** @type {string} */ (row.dataset.task), { details: tickSub(details, Number(sub.dataset.sub), /** @type {HTMLInputElement} */ (box).checked) });
  }
  updateTask(/** @type {ListRef} */ (current), /** @type {string} */ (row.dataset.task), { done: /** @type {HTMLInputElement} */ (box).checked ? true : undefined });
});

listEl.addEventListener('dblclick', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(TASK));
  if (row && targetOf(e).closest(TASK_TEXT)) beginEdit(/** @type {string} */ (row.dataset.task));
});

listEl.addEventListener('contextmenu', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(TASK));
  const task = row && taskById(/** @type {string} */ (row.dataset.task));
  if (!task) return;
  e.preventDefault();
  taskMenu(task, { x: e.clientX, y: e.clientY });
});

/** The task being dragged to another place in its list. */
/** @type {string | null} */
let dragged = null;
listEl.addEventListener('dragstart', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(TASK));
  dragged = row?.dataset.task ?? null;
  if (dragged && e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row?.querySelector(TASK_TEXT)?.textContent ?? '');
  }
});
listEl.addEventListener('dragover', e => {
  if (dragged && targetOf(e).closest(TASK)) e.preventDefault();
});
listEl.addEventListener('drop', e => {
  const over = /** @type {HTMLElement | null} */ (targetOf(e).closest(TASK));
  if (!dragged || !over || !current) return;
  e.preventDefault();
  const id = dragged;
  dragged = null;
  reorderTasks(current, tasks => moveBefore(tasks, id, /** @type {string} */ (over.dataset.task)));
});

addField.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !addField.value.trim() || !current) return;
  e.preventDefault();
  const task = parseTask(addField.value);
  if (!task.text) return;
  addField.value = '';
  addTasks(current, [task]);
});

// Lines pasted are a task each; one line is left to the field, to be edited first.
addField.addEventListener('paste', e => {
  const text = e.clipboardData?.getData('text') ?? '';
  if (!text.includes('\n') || !current) return;
  e.preventDefault();
  const tasks = tasksFromLines(text);
  if (tasks.length) addTasks(current, tasks);
});

noteArea.addEventListener('input', () => {
  fitNote();
  if (noteTimer !== null) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    noteTimer = null;
    const list = shown();
    if (list) writeNote(list, noteArea.value);
  }, NOTE_SAVE_MS);
});
noteArea.addEventListener('blur', saveNoteNow);
noteArea.addEventListener('contextmenu', noteMenu);

listEl.addEventListener('keydown', e => {
  if (!editing) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    editing = null;
    render();
  } else if (e.key === 'Enter' && (e.ctrlKey || !targetOf(e).matches('textarea'))) {
    e.preventDefault();
    saveEdit();
  }
});

issueForm.addEventListener('submit', e => e.preventDefault());

panel.addEventListener('keydown', e => {
  if (!dock.closeKeys(e, KEY_ID.todo)) return;
  e.preventDefault();
  e.stopPropagation();
});

button.addEventListener('click', toggleTodo);

on(EVENTS.openTodo, openList);
on(EVENTS.todo, () => {
  showCount();
  if (!panel.hidden) render();
});
// A terminal or workspace in front changed, or closed: its count, and the list shown when what it's on has gone.
for (const event of [EVENTS.focus, EVENTS.workspaces, EVENTS.tab]) {
  on(event, () => {
    showCount();
    if (!panel.hidden && !shown()) render();
    else if (!panel.hidden) showPick(/** @type {TodoList} */ (shown()));
  });
}
