// @ts-check
// To do (the title bar's button, or Ctrl+Shift+K): one list at a time, in a panel docked on an edge or in a window of its
// own. A list opens where it was asked for (a terminal's or workspace's mark, their menus), the title bar's button opens
// the one in front, and the name in the panel's header picks another. It stays on its list as terminals change.
// A list's note stays a note, in a text box above its tasks; its right-click menu turns lines of it into tasks.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, persist, newId, lastFolderOf, wsById, tabsOf, tabTitle, isSsh, profileOf, EVENTS } from './store.js';
import { escapeHtml, cssColor, tabBadgeHtml, countText, ICONS } from './ui.js';
import { byId, find, targetOf, WORKSPACE_ID, DOCK_GRIP, PANEL_HEAD, TOOL_COUNT } from './dom.js';
import { showMenu, openPopover, SEPARATOR } from './popups.js';
import { showToast, TOAST } from './toasts.js';
import { setNote } from './notes.js';
import { KEY_ID } from './keymap.js';
import { copyOut, textBoxMenu } from './textmenu.js';
import { COPY_LABEL } from './termclipboard.js';
import { dockPanel, NOTEPAD_DOCK } from './dockpanel.js';
import { TAG_LIST } from './tagpicker.js';
import {
  parseTask, tasksFromLines, tasksFromNote, tagOfHeading, selectedLines, withoutLines, openCount, tagsIn, withTags, moveBefore, labelsForTags, issueBody,
} from './todolist.js';
import {
  LIST_KIND, listOf, noteTarget, sameList, listInFront, openInFront, terminalList, workspaceList, hostList, addTasks, updateTask,
  removeTask, moveTask, reorderTasks, todoTags,
} from './todo.js';

/** @typedef {import('./todo.js').ListRef} ListRef */

const NAME = 'To do';
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
});
/** How long after the last key a note is saved. */
const NOTE_SAVE_MS = 400;
/** The most a note's box grows to before it scrolls (rows). */
const NOTE_MAX_ROWS = 12;
const NOTE_LINE_PX = 20;
const NOTE_PADDING_PX = 12;
/** Where a task's tags show while it's edited. */
const EDIT_TAGS = '.td-edit-tags';
/** A list's tag chip gets one of the theme's colours, always the same for a tag. */
const TAG_HUES = 8;
const TAG_HASH = 31;

const panel = document.createElement('aside');
panel.className = 'notepad-panel todo-panel';
panel.hidden = true;
panel.innerHTML = `
  <div class="${DOCK_GRIP}" title="Drag to resize"></div>
  <div class="files-head">
    <span class="title-icon td-icon"></span>
    <span class="files-title">${NAME}</span>
    <button class="td-pick" data-td="${ACTION.pick}" title="Pick a list"><span class="td-pick-name"></span>${ICONS.chevronDown}</button>
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
const pickName = find(panel, '.td-pick-name');
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
/** Whether done tasks show. */
let showDone = false;
/** The task being edited, in its row, and its tags so far. */
/** @type {string | null} */
let editing = null;
/** @type {string[]} */
let editTags = [];
/** The task an issue is being made from, and what the host said about its repository. */
/** @type {{ taskId: string, requestId: string, repo?: string, labels: string[], ticked: string[], error?: string, busy?: boolean, folder: string | null } | null} */
let issue = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let noteTimer = null;

const shown = () => listOf(current);

// ---- Drawing ----

/**
 * The chip of a tag: its colour comes from its name, so a tag looks the same in every list.
 * @param {string} tag
 */
function tagHue(tag) {
  let hash = 0;
  for (const c of tag) hash = (hash * TAG_HASH + /** @type {number} */ (c.codePointAt(0))) % TAG_HUES;
  return hash;
}

/** @param {string} tag @param {boolean} [on] */
const chip = (tag, on = false) => `<button type="button" class="td-chip hue${tagHue(tag)}${on ? ' on' : ''}" data-td="${ACTION.tag}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;

/** @param {TodoTask} task */
function rowHtml(task) {
  if (task.id === editing) return editorHtml(task);
  const issueChip = task.issue ? `<span class="td-gh" title="${escapeHtml(task.issue.url)}">#${task.issue.number}</span>` : '';
  const hasMeta = !!(task.tags?.length || task.issue);
  return `<div class="td-task${task.done ? ' done' : ''}" data-task="${escapeHtml(task.id)}" draggable="true">
    <input class="td-check" type="checkbox" ${task.done ? 'checked' : ''} aria-label="Done">
    <div class="td-body"><div class="td-text">${escapeHtml(task.text)}</div>
      ${task.details ? `<div class="td-details">${escapeHtml(task.details)}</div>` : ''}
      ${hasMeta ? `<div class="td-meta">${(task.tags ?? []).map(t => chip(t, picked.includes(t))).join('')}${issueChip}</div>` : ''}</div>
    <button class="pane-btn td-more" data-td="${ACTION.more}" title="More">${ICONS.more}</button>
  </div>`;
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
  const tags = editTags.map(tag => `<span class="td-chip hue${tagHue(tag)}">${escapeHtml(tag)}<button type="button" class="td-chip-drop" data-td="${ACTION.dropTag}" data-tag="${escapeHtml(tag)}" title="Remove" aria-label="Remove ${escapeHtml(tag)}">${ICONS.close}</button></span>`);
  return `${tags.join('')}<button type="button" class="td-add-tag" data-td="${ACTION.pickTags}">${ICONS.plus}Tag</button>`;
}

/** @param {TodoList} list */
function listHtml(list) {
  const tasks = withTags(list.tasks, picked);
  const open = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);
  const empty = !list.tasks.length ? `<p class="td-empty">${list.note ? 'No tasks. Right-click the note to turn its lines into tasks.' : 'Nothing here yet.'}</p>` : '';
  return `${empty}${open.map(rowHtml).join('')}${done.length ? `<button class="td-fold" data-td="${ACTION.fold}" aria-expanded="${showDone}">${done.length} done</button>` : ''}${showDone ? done.map(rowHtml).join('') : ''}`;
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
  pinButton.hidden = list.ref.kind === LIST_KIND.host;
  pinButton.setAttribute('aria-pressed', String(list.pinned));
  // The text being typed stays as it is: a save comes back here.
  if (noteArea.ownerDocument.activeElement !== noteArea) noteArea.value = list.note;
  if (!noteBox.hidden) fitNote();
}

/** Draws the list shown; the first list in front when what it was on has gone. */
function render() {
  if (!shown()) {
    current = listInFront();
    picked = [];
  }
  const list = shown();
  view.hidden = !!issue;
  issueForm.hidden = !issue;
  if (!list) {
    pickName.textContent = '';
    listEl.innerHTML = '';
    return;
  }
  pickName.textContent = list.name;
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

/** @param {ListRef} ref */
function countHint(ref) {
  const open = openCount(listOf(ref)?.tasks);
  return open ? String(open) : '';
}

/**
 * The picker's entries for a workspace: its own list, its terminals', and the hosts they're on.
 * @param {Workspace} ws
 */
function listsOf(ws) {
  const tabs = tabsOf(ws).filter(t => !t.virtual);
  const hosts = [...new Map(tabs.filter(isSsh).map(t => [t.profile, profileOf(t)])).values()];
  return [
    { label: WORKSPACE_LIST, icon: ICONS.workspaces, hint: countHint(workspaceList(ws)), action: () => openList(workspaceList(ws)) },
    ...tabs.map(t => ({ label: tabTitle(t), icon: tabBadgeHtml(t), hint: countHint(terminalList(t)), action: () => openList(terminalList(t)) })),
    ...hosts.map(p => ({ label: `Host ${p?.name ?? ''}`, icon: ICONS.link, hint: countHint(hostList(p?.id ?? '')), action: () => openList(hostList(p?.id ?? '')) })),
  ];
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
    ...others.map(w => ({ label: w.name, icon: `<span class="ws-dot" style="background:${cssColor(w.color)}"></span>`, submenu: () => entriesOf(w) })),
  ]);
}

/** @param {HTMLElement} at */
function pickList(at) {
  showMenu(perWorkspace(listsOf), at);
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
 * The list a task's tags are picked from: To do's tags, ticked when the task has them, and a new one from what's typed.
 * @param {string} query
 */
function tagRowsHtml(query) {
  const known = todoTags().map(([tag, count]) => /** @type {[string, number]} */ ([tag, count]));
  for (const tag of editTags) if (!known.some(([name]) => name === tag)) known.push([tag, 0]);
  const rows = known.filter(([tag]) => tag.includes(query)).map(([tag, count]) => `
    <button class="tp-row" data-tag="${escapeHtml(tag)}" role="option" aria-selected="${editTags.includes(tag)}">
      <span class="check${editTags.includes(tag) ? ' on' : ''}"><svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg></span>
      <span class="td-chip hue${tagHue(tag)}">${escapeHtml(tag)}</span><span class="tp-count">${count || ''}</span>
    </button>`);
  if (query && !known.some(([tag]) => tag === query)) {
    rows.push(`<button class="tp-row tp-create" data-tag="${escapeHtml(query)}"><span class="menu-icon">${ICONS.plus}</span>Create<span class="td-chip hue${tagHue(query)}">${escapeHtml(query)}</span></button>`);
  }
  return rows.join('') || '<div class="tp-empty">Type a name to create a tag</div>';
}

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
  const draw = () => { list.innerHTML = tagRowsHtml(query()); };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !query()) return;
    e.preventDefault();
    toggleEditTag(query());
    input.value = '';
    draw();
  });
  // The focus stays in the field while tags are ticked.
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', e => {
    const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tag]'));
    if (!row) return;
    toggleEditTag(/** @type {string} */ (row.dataset.tag));
    input.value = '';
    draw();
  });
  draw();
  openPopover(picker, at, { dynamic: true, refocus: () => /** @type {HTMLElement | null} */ (panel.querySelector(EDIT_TEXT))?.focus() });
  input.focus();
}

/** @param {TodoTask} task */
function issueItems(task) {
  if (!task.issue) return [{ label: 'Create GitHub issue', icon: ICONS.git, action: () => beginIssue(task) }];
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

/** @param {TodoTask} task */
function beginIssue(task) {
  const folder = folderOfList();
  issue = { taskId: task.id, requestId: newId('i'), labels: [], ticked: [], folder, error: folder ? undefined : 'This list has no folder on this computer, so there’s no repository to use.' };
  render();
  if (folder) send(PAGE.todoIssueInfo, { requestId: issue.requestId, folder });
}

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
    <input class="field td-issue-title" value="${escapeHtml(task.text)}" spellcheck="false" autocomplete="off" aria-label="Title">
    <textarea class="field td-issue-body" rows="8" spellcheck="false" placeholder="Body" aria-label="Body">${escapeHtml(issueBody(task))}</textarea>
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
  const { taskId, repo } = issue;
  issue = null;
  updateTask(/** @type {ListRef} */ (current), taskId, { issue: { repo: repo ?? '', number: m.number, url: m.url } });
  showToast({ text: `Issue #${m.number} created in ${repo}`, state: TOAST.done });
});

// ---- Wiring ----

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
      showDone = !showDone;
      return render();
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
    else if (!panel.hidden) pickName.textContent = shown()?.name ?? '';
  });
}
