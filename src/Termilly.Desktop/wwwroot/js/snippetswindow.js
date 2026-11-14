// @ts-check
// The snippets window: the snippets of the repository the focused terminal is in, this computer's, and the
// repository's VS Code tasks, in one place to manage them. The list on the left (searchable, grouped by where each
// one comes from), the selected snippet's editor on the right, saved with Save (leaving a snippet with changes not
// saved asks about them). A task, and a snippet the repository's .termilly.yml lists, are shown as they are: they're
// changed in their file. It opens from the snippets list's New and Manage (js/snippetpick.js) and the palette.

import { state, on, persist, EVENTS } from './store.js';
import { focusedTab, restoreFocus } from './panes.js';
import { closeAll, dropdown } from './popups.js';
import { escapeHtml } from './ui.js';
import { modal, CONFIRM_DIALOG } from './dialogs.js';
import { fuzzyMatch } from './fuzzy.js';
import { PAGE } from './protocol.js';
import { send } from './host.js';
import {
  placeholders, saveSnippet, newSnippetId, globalSnippets, repoHere, whereHtml, whereOf, readEditor,
  SNIPPET_SCOPE, SNIPPET_FIELD, IN_REPO, RUN_LABEL, THIS_COMPUTER,
} from './snippets.js';
import { REPO_FILE, LAYOUT_FILE, TASKS_FILE } from './reposnippets.js';
import { runAny } from './taskrun.js';
import { toggleSnippetPick, SNIPPETS_BUTTON } from './snippetpick.js';
import { byId, find, targetOf } from './dom.js';
import { detach, closeWindow, focusWindow, isDetached } from './windows.js';

/** @typedef {import('./reposnippets.js').ListedSnippet} ListedSnippet */

/**
 * A new snippet not saved yet, with where it's to be kept ('global', or IN_REPO and a repository's folder).
 * @typedef {{ id: string, name: string, command: string, description?: string | null, enter: boolean,
 *   where: string }} Draft
 */

/**
 * A row of the list: a snippet, where it's kept ('global', IN_REPO and its repository, or SNIPPET_SCOPE's shared or
 * task for the ones changed in their file), and whether it's the new one not saved yet.
 * @typedef {{ s: ListedSnippet | Draft, where: string, isDraft?: boolean }} Entry
 */

const CLOSE = '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';

/** The window's buttons (their data-sw). */
const ACTION = Object.freeze({
  new: 'new', close: 'close', save: 'save', delete: 'delete', duplicate: 'duplicate', run: 'run', openFile: 'open-file', copy: 'copy',
});
/** Its window when it's in one of its own (js/windows.js). */
const WINDOW_KEY = 'snippets';
const NAME = 'Snippets';
/** What the "Save the changes?" question can answer, besides Cancel. */
const ANSWER = Object.freeze({ save: 'save', discard: 'discard' });
/** The window's shortcuts with Ctrl (KeyboardEvent.code): save, and a new snippet. */
const KEY = Object.freeze({ save: 'KeyS', newSnippet: 'KeyN' });

const layer = document.createElement('div');
layer.className = 'modal-layer settings-layer snippets-layer';
layer.hidden = true;
layer.innerHTML = `
  <div class="settings snippets-win" role="dialog" aria-modal="true" aria-labelledby="sw-title">
    <div class="set-head">
      <span class="title-icon sw-icon"></span>
      <h2 id="sw-title">Snippets</h2>
      <span class="cw-sub sw-count"></span>
      <span class="spacer"></span>
      <button class="btn small" data-sw="${ACTION.new}">New snippet</button>
      <button class="set-close" data-sw="${ACTION.close}" title="Close (Esc)">${CLOSE}</button>
    </div>
    <div class="cw-main">
      <div class="cw-side sw-side">
        <div class="cw-filter"><input class="field" data-sw-search placeholder="Search snippets and tasks" spellcheck="false" autocomplete="off"></div>
        <div class="sw-list" tabindex="0" role="listbox" aria-label="Snippets"></div>
      </div>
      <div class="sw-edit"></div>
    </div>
  </div>`;
document.body.append(layer);
/** The window itself: over the page, or moved into a window of its own. */
const box = find(layer, '.snippets-win');

/**
 * The window's element a selector finds (the markup above always has it).
 * @param {string} sel
 */
const $ = sel => /** @type {HTMLElement} */ (box.querySelector(sel));
const searchEl = /** @type {HTMLInputElement} */ ($('[data-sw-search]'));
const listEl = $('.sw-list');
const editEl = $('.sw-edit');
/** Its header: its title bar in a window of its own, and what drags it out into one. */
const head = $('.set-head');
/** The title bar's button that opens the snippets list. */
const openButton = byId(SNIPPETS_BUTTON);

/** @type {string | null} */
let selectedId = null;
/** @type {Draft | null} */
let draft = null; // a new snippet not saved yet: { id, name, command, description, enter, where }
/** @type {Entry[]} */
let shown = []; // the rows in the list's order

const isOpen = () => !layer.hidden || isDetached(WINDOW_KEY);

/** Whether a row is changed in its file rather than here (a task, a .termilly.yml snippet). */
const isFromFile = (/** @type {Entry} */ e) => e.where === SNIPPET_SCOPE.task || e.where === SNIPPET_SCOPE.shared;

/**
 * Every snippet with where it's kept: the focused terminal's repository's, this computer's, then its tasks.
 * @returns {Entry[]}
 */
function everySnippet() {
  const repo = repoHere();
  return [
    ...(repo?.snippets ?? []).map(s => ({ s, where: whereOf(s) })),
    ...(repo?.shared ?? []).map(s => ({ s, where: SNIPPET_SCOPE.shared })),
    ...globalSnippets().map(s => ({ s, where: SNIPPET_SCOPE.global })),
    ...(repo?.tasks ?? []).map(s => ({ s, where: SNIPPET_SCOPE.task })),
  ];
}

/**
 * A group's heading: where its snippets come from, and the file.
 * @param {string} where
 */
function groupHtml(where) {
  const repo = repoHere();
  const [title, file] = where === SNIPPET_SCOPE.global ? [THIS_COMPUTER, '']
    : where === SNIPPET_SCOPE.task ? ['VS Code tasks', TASKS_FILE]
      : where === SNIPPET_SCOPE.shared ? [repo?.name ?? 'This repo', LAYOUT_FILE] : [repo?.name ?? 'This repo', REPO_FILE];
  return `<div class="sw-group"><span>${escapeHtml(title)}</span>${file ? `<code>${file}</code>` : ''}</div>`;
}

/** @returns {Entry | null} */
function current() {
  if (draft && draft.id === selectedId) return { s: draft, where: draft.where, isDraft: true };
  return everySnippet().find(e => e.s.id === selectedId) ?? null;
}

// ---- The list ----

function renderList() {
  const q = searchEl.value.trim();
  const all = everySnippet();
  if (draft) all.unshift({ s: draft, where: draft.where, isDraft: true });
  shown = all.filter(e => e.isDraft || !q || fuzzyMatch(q, `${e.s.name} ${e.s.command} ${e.s.description ?? ''}`));
  const saved = all.filter(e => !e.isDraft && !isFromFile(e)).length;
  $('.sw-count').textContent = `${saved} snippet${saved === 1 ? '' : 's'}`;
  /** @type {string | null} */
  let group = null;
  listEl.innerHTML = shown.length ? shown.map(e => {
    const heading = e.where !== group ? groupHtml(e.where) : '';
    group = e.where;
    return `${heading}<div class="sw-row${e.s.id === selectedId ? ' selected' : ''}${isFromFile(e) ? ' from-file' : ''}" role="option" data-id="${escapeHtml(e.s.id)}" aria-selected="${e.s.id === selectedId}">
      <span class="sw-name">${escapeHtml(e.s.name || 'New snippet')}</span>
      <code class="sw-cmd">${escapeHtml(e.s.command || ' ')}</code>
    </div>`;
  }).join('') : `<p class="set-desc sw-empty">${q ? 'No snippet matches.' : 'No snippets yet. Make one with New snippet, or use “Save the last command as a snippet” in a terminal’s menu.'}</p>`;
  listEl.querySelector('.sw-row.selected')?.scrollIntoView({ block: 'nearest' });
}

/** @param {string | null} id */
function select(id) {
  if (id === selectedId) return;
  // A new snippet that's left (saved or not) is done with.
  if (draft && draft.id === selectedId) draft = null;
  selectedId = id;
  renderList();
  renderEditor();
}

// ---- The editor ----

/**
 * A task or a .termilly.yml snippet: shown as it is, with its file to open, a copy to make here, and Run.
 * @param {Entry} e
 */
function fileEntryHtml(e) {
  const s = /** @type {ListedSnippet} */ (e.s);
  const task = e.where === SNIPPET_SCOPE.task;
  return `
    <h3 class="sw-title">${escapeHtml(s.name)}</h3>
    <p class="dialog-sub">${task ? 'VS Code task' : 'Listed in the workspace layout'} · <code>${task ? TASKS_FILE : LAYOUT_FILE}</code></p>
    <label class="dialog-field">Command<textarea class="field snippet-command" rows="5" readonly>${escapeHtml(s.command)}</textarea></label>
    ${task && s.task?.dependsOn.length ? `<p class="dialog-sub">Runs first: ${s.task.dependsOn.map(escapeHtml).join(', ')}</p>` : ''}
    ${task && s.task?.cwd ? `<p class="dialog-sub">Runs in <code>${escapeHtml(s.task.cwd)}</code></p>` : ''}
    <p class="sw-note">Termilly doesn’t change this file. Edit it, or copy this as a snippet to change it here.</p>
    <div class="dialog-actions">
      <button class="btn" data-sw="${ACTION.openFile}">Open ${task ? 'tasks.json' : LAYOUT_FILE}</button>
      <button class="btn" data-sw="${ACTION.copy}">Copy as snippet</button>
      <span class="spacer"></span>
      <button class="btn primary" data-sw="${ACTION.run}">${RUN_LABEL}</button>
    </div>`;
}

function renderEditor() {
  const e = current();
  if (!e) {
    editEl.innerHTML = `<p class="set-desc sw-none">${shown.length ? 'Pick a snippet on the left.' : ''}</p>`;
    return;
  }
  if (isFromFile(e)) {
    editEl.innerHTML = fileEntryHtml(e);
    return;
  }
  const { s, where } = e;
  editEl.innerHTML = `
    <label class="dialog-field">Name<input class="field" name="name" value="${escapeHtml(s.name)}" placeholder="Tail pod logs" spellcheck="false"></label>
    <label class="dialog-field">Command<textarea class="field snippet-command" name="command" rows="5" spellcheck="false" placeholder="kubectl logs -f {{pod}} -n {{namespace=default}}">${escapeHtml(s.command)}</textarea></label>
    <p class="dialog-sub">Write <code>{{name}}</code> for a value to ask for when it runs, <code>{{name=default}}</code> with a default. Don’t put secrets in a snippet.</p>
    <label class="dialog-field">Description<input class="field" name="description" value="${escapeHtml(s.description ?? '')}" placeholder="optional"></label>
    ${whereHtml(where, repoHere())}
    <label class="note-pin"><input type="checkbox" name="enter" ${s.enter === false ? '' : 'checked'}> Press Enter after it</label>
    <div class="sw-vars"></div>
    <div class="dialog-actions">
      <button class="btn" data-sw="${ACTION.delete}">${e.isDraft ? 'Discard' : 'Delete'}</button>
      <button class="btn" data-sw="${ACTION.duplicate}"${e.isDraft ? ' hidden' : ''}>Duplicate</button>
      <span class="spacer"></span>
      <button class="btn" data-sw="${ACTION.save}" title="Save (Ctrl+S)">Save</button>
      <button class="btn primary" data-sw="${ACTION.run}">${RUN_LABEL}</button>
    </div>`;
  dropdown(/** @type {HTMLSelectElement} */ (editEl.querySelector(`select[name="${SNIPPET_FIELD.where}"]`)));
  renderState();
}

/**
 * The editor's field by its name; the inputs, textarea and select all have a value.
 * @param {string} name
 */
const field = name => /** @type {HTMLInputElement} */ (editEl.querySelector(`[name="${name}"]`));

function read() {
  return {
    name: field(SNIPPET_FIELD.name).value.trim(),
    command: field(SNIPPET_FIELD.command).value.trim(),
    description: field(SNIPPET_FIELD.description).value.trim() || undefined,
    enter: field(SNIPPET_FIELD.enter).checked,
    where: field(SNIPPET_FIELD.where).value,
    onlyMe: field(SNIPPET_FIELD.onlyMe)?.checked ?? false,
  };
}

/** Whether the editor holds anything not saved: a new snippet with something in it, or a changed one. */
function isDirty() {
  const e = current();
  if (!e || !editEl.querySelector('[name="name"]')) return false;
  const now = read();
  if (e.isDraft) return !!(now.name || now.command || now.description);
  return now.name !== e.s.name || now.command !== e.s.command || (now.description ?? '') !== (e.s.description ?? '')
    || now.enter !== (e.s.enter !== false) || now.where !== e.where || now.onlyMe !== (repoHere()?.onlyMe ?? false);
}

/** The variables the command uses, "Only for me" only for a repository, and what Save and Run can do now. */
function renderState() {
  if (!editEl.querySelector('[name="name"]')) return;
  const { command, enter, where } = read();
  editEl.querySelector('[data-only-me]')?.toggleAttribute('hidden', !where.startsWith(IN_REPO));
  const vars = placeholders(command);
  find(editEl, '.sw-vars').innerHTML = vars.length
    ? `<span class="sw-vars-head">Variables used</span>${vars.map(v => `<code class="sw-var">${escapeHtml(v.name)}${v.def ? ` = ${escapeHtml(v.def)}` : ''}</code>`).join('')}` : '';
  const dirty = isDirty();
  /** @type {HTMLButtonElement} */ (editEl.querySelector(`[data-sw="${ACTION.save}"]`)).disabled = !dirty || !command;
  const run = /** @type {HTMLButtonElement} */ (editEl.querySelector(`[data-sw="${ACTION.run}"]`));
  run.disabled = dirty || !command || !focusedTab();
  run.title = dirty ? 'Save the changes first' : 'Run it in the focused terminal';
  run.textContent = enter ? RUN_LABEL : 'Type it';
}

/** Saves what the editor holds; false when it can't (no command). The name falls back to the command's first words. */
async function save() {
  const e = current();
  if (!e) return false;
  const next = readEditor(field, e.s.id);
  if (!next) {
    find(editEl, '[name="command"]').focus();
    return false;
  }
  const { where, onlyMe } = read();
  const saved = await write(next.id, next, where, onlyMe);
  // Not written (a file that can't be): the editor keeps what was typed.
  if (!saved.ok) return false;
  if (e.isDraft) draft = null;
  selectedId = saved.id ?? next.id;
  renderList();
  renderEditor();
  return true;
}

let saving = false;

/**
 * Saves through snippets.js without the window redrawing itself from the change it made; resolves what it did.
 * @param {string} id
 * @param {SnippetSetting | null} next
 * @param {string} where
 * @param {boolean} [onlyMe]
 */
async function write(id, next, where, onlyMe) {
  saving = true;
  try { return await saveSnippet(id, next, where, { onlyMe }); } finally { saving = false; }
}

editEl.addEventListener('input', renderState);
editEl.addEventListener('change', renderState);

/**
 * Before leaving the snippet on screen: with changes not saved, asks whether to save them. False when the user
 * stays (Cancel, or Save without a command).
 */
async function leave() {
  if (!isDirty()) return true;
  const name = read().name || current()?.s.name || 'this snippet';
  const answer = await modal(CONFIRM_DIALOG, `
    <h3>Save the changes to ${escapeHtml(name)}?</h3>
    <p class="dialog-sub">They’re lost if you don’t save them.</p>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      <span class="spacer"></span>
      <button class="btn" data-discard>Don’t save</button>
      <button class="btn primary" data-ok autofocus>Save</button>
    </div>`, (dialog, close) => {
    find(dialog, '[data-discard]').addEventListener('click', () => close(ANSWER.discard));
    return { submit: () => close(ANSWER.save) };
  });
  if (answer === ANSWER.save) return save();
  if (answer === ANSWER.discard) {
    if (draft && draft.id === selectedId) draft = null;
    renderEditor();
    return true;
  }
  /** @type {HTMLElement | null} */ (editEl.querySelector('[name="name"]'))?.focus();
  return false;
}

/**
 * Goes to another snippet, once the one on screen is saved or let go.
 * @param {string | null} id
 * @param {{ focusList?: boolean }} [options]
 */
async function go(id, { focusList = false } = {}) {
  if (id === selectedId || !(await leave())) return;
  select(id);
  if (focusList) listEl.focus();
}

/**
 * A new snippet, kept in the focused terminal's repository when it's in one.
 * @param {Partial<Draft>} [from] what it starts with (a copy of a task)
 */
async function newSnippet(from = {}) {
  if (!(await leave())) return;
  const repo = repoHere();
  draft = { id: newSnippetId(), name: '', command: '', description: undefined, enter: true, where: repo ? `${IN_REPO}${repo.root}` : SNIPPET_SCOPE.global, ...from };
  searchEl.value = '';
  selectedId = null;
  select(draft.id);
  /** @type {HTMLElement | null} */ (editEl.querySelector('[name="name"]'))?.focus();
}

async function remove() {
  const e = current();
  if (!e || isFromFile(e)) return;
  const at = shown.findIndex(x => x.s.id === e.s.id);
  if (e.isDraft) draft = null;
  else await write(e.s.id, null, e.where);
  const rest = shown.filter(x => x.s.id !== e.s.id);
  selectedId = null;
  select(rest[Math.min(at, rest.length - 1)]?.s.id ?? null);
}

async function duplicate() {
  if (!(await leave())) return;
  const e = current();
  if (!e || e.isDraft || isFromFile(e)) return;
  const copy = { ...e.s, id: newSnippetId(), name: `${e.s.name} copy` };
  const saved = await write(copy.id, /** @type {SnippetSetting} */ (copy), e.where);
  if (!saved.ok) return;
  selectedId = null;
  select(saved.id ?? copy.id);
  /** @type {HTMLInputElement | null} */ (editEl.querySelector('[name="name"]'))?.select();
}

/** Runs the snippet shown (a task in a new terminal); the window stays open for the next one. */
function run() {
  const e = current();
  if (!e || e.isDraft || isDirty() || !e.s.command) return;
  runAny(/** @type {ListedSnippet} */ (e.s));
}

/** A task's or .termilly.yml snippet's file, opened in the app that opens it. */
function openFile() {
  const e = current();
  const root = /** @type {ListedSnippet | undefined} */ (e?.s)?.root;
  if (!e || !root) return;
  send(PAGE.openPath, { path: `${root}/${e.where === SNIPPET_SCOPE.task ? TASKS_FILE : LAYOUT_FILE}` });
}

/** A task or .termilly.yml snippet copied as a new snippet, to change here. */
function copyAsSnippet() {
  const e = current();
  if (!e) return;
  newSnippet({ name: e.s.name, command: e.s.command, description: e.where === SNIPPET_SCOPE.task ? undefined : e.s.description });
}

// ---- Opening and closing ----

/** Opens the window, on a given snippet (by id), a new one, or the first. */
on(EVENTS.openSnippets, options => openSnippetsWindow(options));

/** @param {{ id?: string | null, create?: boolean }} [options] */
export function openSnippetsWindow({ id = null, create = false } = {}) {
  closeAll();
  if (isDetached(WINDOW_KEY)) {
    // Already open in its own window: that comes to the front, on what was asked for (asking about changes first).
    focusWindow(WINDOW_KEY);
    if (create) newSnippet(); else if (id) go(id);
    return;
  }
  // Laid out over the page but not shown there: it opens in a window of its own, at that size (or its last place).
  layer.hidden = false;
  layer.style.visibility = HIDDEN;
  searchEl.value = '';
  draft = null;
  selectedId = null;
  editEl.innerHTML = '';
  renderList();
  if (create) newSnippet();
  else {
    select(id ?? shown[0]?.s.id ?? null);
    if (!shown.length) renderEditor();
  }
  keepOpen(true);
  // What has the keyboard once it's open: what's edited, else the search.
  focusOnOpen = /** @type {HTMLElement | null} */ (id || create ? editEl.querySelector('[name="command"], [name="name"]') : null) ?? searchEl;
  // Where there are no windows of its own (macOS for now), over the page as before.
  if (!detachSnippets()) {
    layer.style.visibility = '';
    focusOnOpen.focus();
  }
}

/** What gets the keyboard once the window has opened in its own window. */
/** @type {HTMLElement | null} */
let focusOnOpen = null;

/** The layer's visibility while the window is laid out there on its way into a window of its own. */
const HIDDEN = 'hidden';

/**
 * Closes the window; changes not saved are asked about first.
 * @param {{ force?: boolean }} [options]
 */
export async function closeSnippetsWindow({ force = false } = {}) {
  if (!isOpen() || (!force && !(await leave()))) return;
  if (isDetached(WINDOW_KEY)) {
    closeWindow(WINDOW_KEY, { quiet: true });
    backInLayer();
  }
  closed();
}

/**
 * Whether it's open, kept for the next start (it opens again after a restart).
 * @param {boolean} open
 */
function keepOpen(open) {
  if (state.snippetsWindow.open === open) return;
  state.snippetsWindow.open = open;
  persist();
}

/** At start: open again if it was open when Termilly closed. */
export function initSnippetsWindow() {
  if (state.snippetsWindow.open) openSnippetsWindow();
}

/** Shut, its window gone: back in its place in the page, hidden, nothing being edited. */
function closed() {
  keepOpen(false);
  layer.hidden = true;
  layer.style.visibility = '';
  draft = null;
  editEl.innerHTML = '';
  restoreFocus();
}

export const toggleSnippetsWindow = () => (isDetached(WINDOW_KEY) ? focusWindow(WINDOW_KEY)
  : isOpen() ? closeSnippetsWindow() : openSnippetsWindow());

/**
 * Always in a window of its own, where it opened last (else where it's laid out over the page); its header is the
 * window's title bar, with no Return: it's never back over the page. Close and Alt+F4 ask about changes not saved, as
 * its own Close does. False when no window could be opened.
 */
function detachSnippets() {
  const close = () => closeSnippetsWindow();
  return detach(WINDOW_KEY, {
    el: box, title: NAME, askClose: close, close, header: head, remember: true, returnable: false,
    // The first time ever: over the main window's middle, most of its size (then wherever it was last).
    firstPlace: overTheMiddle(),
    // Its window gone without asking (Termilly closing): shut.
    onClosed: () => {
      backInLayer();
      closed();
    },
    onMoved: () => {
      layer.hidden = true;
      layer.style.visibility = '';
      (focusOnOpen ?? searchEl).focus();
    },
  });
}

/** How much of the main window the Snippets window takes the first time it opens. */
const FIRST_SHARE = 0.8;

/** Over the main window's middle, FIRST_SHARE of its size (screen and page pixels, as window.open takes them). */
function overTheMiddle() {
  const w = Math.round(innerWidth * FIRST_SHARE), h = Math.round(innerHeight * FIRST_SHARE);
  return { x: Math.round(screenX + (innerWidth - w) / 2), y: Math.round(screenY + (innerHeight - h) / 2), w, h };
}

/** Back in its place in the page, from its window. */
function backInLayer() {
  layer.append(box);
}

// Snippets changed somewhere else (a workspace's layout file, Settings, an edit from the run form).
on(EVENTS.snippets, () => {
  if (!isOpen() || saving) return;
  renderList();
  if (!current()) select(shown[0]?.s.id ?? null);
});
// The focused terminal moved to another repository: its snippets.
on(EVENTS.workspaces, () => { if (isOpen() && !saving) renderList(); });

// ---- Mouse and keys ----

box.addEventListener('click', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('.sw-row'));
  if (row) { go(/** @type {string} */ (row.dataset.id), { focusList: true }); return; }
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-sw]'))?.dataset.sw;
  if (action === ACTION.close) closeSnippetsWindow();
  if (action === ACTION.new) newSnippet();
  else if (action === ACTION.delete) remove();
  if (action === ACTION.save) save();
  if (action === ACTION.duplicate) duplicate();
  if (action === ACTION.run) run();
  if (action === ACTION.openFile) openFile();
  if (action === ACTION.copy) copyAsSnippet();
});
layer.addEventListener('mousedown', e => {
  if (e.target === layer) closeSnippetsWindow();
});

// Searching narrows the list; the snippet on screen stays there even when it no longer matches.
searchEl.addEventListener('input', renderList);

/** @param {number} by */
function step(by) {
  if (!shown.length) return;
  const at = shown.findIndex(e => e.s.id === selectedId);
  go(shown[Math.max(0, Math.min(shown.length - 1, at + by))].s.id);
}

searchEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); listEl.focus(); if (e.key === 'ArrowDown') step(1); }
  else if (e.key === 'Escape' && searchEl.value) {
    e.preventDefault();
    searchEl.value = '';
    renderList();
  }
});
listEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'Enter') { e.preventDefault(); run(); }
  else if (e.key === 'Delete') { e.preventDefault(); remove(); }
});

// Keys in the window stay in it (no app shortcuts, no terminal); Escape closes it, Ctrl+S saves, Ctrl+N makes a
// snippet.
box.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault();
    closeSnippetsWindow();
  } else if (e.ctrlKey && !e.shiftKey && e.code === KEY.save) {
    e.preventDefault();
    if (!(/** @type {HTMLButtonElement | null} */ (editEl.querySelector(`[data-sw="${ACTION.save}"]`)))?.disabled) save();
  } else if (e.ctrlKey && !e.shiftKey && e.code === KEY.newSnippet) {
    e.preventDefault();
    newSnippet();
  }
  e.stopPropagation();
});

openButton.addEventListener('click', () => toggleSnippetPick());

// Its title bar starts with the toolbar button's icon, as a window's does.
$('.sw-icon').innerHTML = /** @type {Element} */ (openButton.firstElementChild).outerHTML;
