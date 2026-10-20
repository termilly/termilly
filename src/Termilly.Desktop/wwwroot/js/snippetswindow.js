// @ts-check
// The snippets window: every snippet, the global ones and each workspace's, in one place to manage them. The list
// on the left (searchable, grouped by where each one is kept), the selected snippet's editor on the right, saved
// with Save (leaving a snippet with changes not saved asks about them). It opens from the titlebar's snippets
// button, the palette, and Edit or New in the snippets list (js/snippets.js).

import { state, on, wsById, EVENTS } from './store.js';
import { focusedTab, restoreFocus } from './panes.js';
import { closeAll, dropdown } from './popups.js';
import { escapeHtml } from './ui.js';
import { modal, CONFIRM_DIALOG } from './dialogs.js';
import { fuzzyMatch } from './fuzzy.js';
import {
  placeholders, runSnippet, saveSnippet, newSnippetId, SNIPPET_SCOPE, SNIPPET_FIELD, NAME_WORDS, RUN_LABEL,
} from './snippets.js';
import { byId, find, targetOf } from './dom.js';

/**
 * A new snippet not saved yet, with where it's to be kept ('global' or a workspace's id).
 * @typedef {{ id: string, name: string, command: string, description?: string | null, enter: boolean,
 *   where: string }} Draft
 */

/**
 * A row of the list: a snippet, where it's kept, and whether it's the new one not saved yet.
 * @typedef {{ s: SnippetSetting | Draft, where: string, isDraft?: boolean }} Entry
 */

const CLOSE = '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';

/** The window's buttons (their data-sw). */
const ACTION = Object.freeze({
  new: 'new', close: 'close', save: 'save', delete: 'delete', duplicate: 'duplicate', run: 'run',
});
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
      <h2 id="sw-title">Snippets</h2>
      <span class="cw-sub sw-count"></span>
      <span class="spacer"></span>
      <button class="btn small" data-sw="${ACTION.new}">New snippet</button>
      <button class="set-close" data-sw="${ACTION.close}" title="Close (Esc)">${CLOSE}</button>
    </div>
    <div class="cw-main">
      <div class="cw-side sw-side">
        <div class="cw-filter"><input class="field" data-sw-search placeholder="Search snippets" spellcheck="false" autocomplete="off"></div>
        <div class="sw-list" tabindex="0" role="listbox" aria-label="Snippets"></div>
      </div>
      <div class="sw-edit"></div>
    </div>
  </div>`;
document.body.append(layer);

/**
 * The window's element a selector finds (the markup above always has it).
 * @param {string} sel
 */
const $ = sel => /** @type {HTMLElement} */ (layer.querySelector(sel));
const searchEl = /** @type {HTMLInputElement} */ ($('[data-sw-search]'));
const listEl = $('.sw-list');
const editEl = $('.sw-edit');

/** @type {string | null} */
let selectedId = null;
/** @type {Draft | null} */
let draft = null; // a new snippet not saved yet: { id, name, command, description, enter, where }
/** @type {Entry[]} */
let shown = []; // the rows in the list's order

const isOpen = () => !layer.hidden;

/**
 * Every snippet with where it's kept: the global ones, then each workspace's, the one on screen first.
 * @returns {Entry[]}
 */
function everySnippet() {
  /** @type {Entry[]} */
  const list = (state.settings.commands.snippets ?? []).map(s => ({ s, where: SNIPPET_SCOPE.global }));
  // true - false: the booleans count as 1 and 0.
  const spaces = [...state.workspaces].filter(w => !w.tmux).sort((a, b) =>
    /** @type {number} */ (/** @type {unknown} */ (b.id === state.activeId))
    - /** @type {number} */ (/** @type {unknown} */ (a.id === state.activeId)));
  for (const ws of spaces) for (const s of ws.snippets ?? []) list.push({ s, where: ws.id });
  return list;
}

/** @param {string} where */
const whereName = where => (where === SNIPPET_SCOPE.global ? 'All workspaces' : wsById(where)?.name ?? 'Workspace');

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
  const saved = all.filter(e => !e.isDraft).length;
  $('.sw-count').textContent = `${saved} snippet${saved === 1 ? '' : 's'}`;
  /** @type {string | null} */
  let group = null;
  listEl.innerHTML = shown.length ? shown.map(e => {
    const head = e.where !== group ? `<div class="sw-group">${escapeHtml(whereName(e.where))}</div>` : '';
    group = e.where;
    return `${head}<div class="sw-row${e.s.id === selectedId ? ' selected' : ''}" role="option" data-id="${escapeHtml(e.s.id)}" aria-selected="${e.s.id === selectedId}">
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

function renderEditor() {
  const e = current();
  if (!e) {
    editEl.innerHTML = `<p class="set-desc sw-none">${shown.length ? 'Pick a snippet on the left.' : ''}</p>`;
    return;
  }
  const { s, where } = e;
  const spaces = state.workspaces.filter(w => !w.tmux);
  editEl.innerHTML = `
    <label class="dialog-field">Name<input class="field" name="name" value="${escapeHtml(s.name)}" placeholder="Tail pod logs" spellcheck="false"></label>
    <label class="dialog-field">Command<textarea class="field snippet-command" name="command" rows="5" spellcheck="false" placeholder="kubectl logs -f {{pod}} -n {{namespace=default}}">${escapeHtml(s.command)}</textarea></label>
    <p class="dialog-sub">Write <code>{{name}}</code> for a value to ask for when it runs, <code>{{name=default}}</code> with a default. Don’t put secrets in a snippet.</p>
    <label class="dialog-field">Description<input class="field" name="description" value="${escapeHtml(s.description ?? '')}" placeholder="optional"></label>
    <label class="dialog-field">Keep it in
      <select class="field" name="where">
        <option value="${SNIPPET_SCOPE.global}"${where === SNIPPET_SCOPE.global ? ' selected' : ''}>All workspaces</option>
        ${spaces.map(w => `<option value="${escapeHtml(w.id)}"${where === w.id ? ' selected' : ''}>${escapeHtml(w.name)} (saved in its layout file too)</option>`).join('')}
      </select></label>
    <label class="note-pin"><input type="checkbox" name="enter" ${s.enter === false ? '' : 'checked'}> Press Enter after it</label>
    <div class="sw-vars"></div>
    <div class="dialog-actions">
      <button class="btn" data-sw="${ACTION.delete}">${e.isDraft ? 'Discard' : 'Delete'}</button>
      <button class="btn" data-sw="${ACTION.duplicate}"${e.isDraft ? ' hidden' : ''}>Duplicate</button>
      <span class="spacer"></span>
      <button class="btn" data-sw="${ACTION.save}" title="Save (Ctrl+S)">Save</button>
      <button class="btn primary" data-sw="${ACTION.run}">${RUN_LABEL}</button>
    </div>`;
  dropdown(/** @type {HTMLSelectElement} */ (editEl.querySelector('select[name="where"]')));
  renderState();
}

function read() {
  /**
   * The editor's field by its name; the inputs, textarea and select all have a value.
   * @param {string} name
   */
  const field = name => /** @type {HTMLInputElement} */ (editEl.querySelector(`[name="${name}"]`));
  return {
    name: field(SNIPPET_FIELD.name).value.trim(),
    command: field(SNIPPET_FIELD.command).value.trim(),
    description: field(SNIPPET_FIELD.description).value.trim() || undefined,
    enter: field(SNIPPET_FIELD.enter).checked,
    where: field('where').value,
  };
}

/** Whether the editor holds anything not saved: a new snippet with something in it, or a changed one. */
function isDirty() {
  const e = current();
  if (!e || !editEl.querySelector('[name="command"]')) return false;
  const now = read();
  if (e.isDraft) return !!(now.name || now.command || now.description);
  return now.name !== e.s.name || now.command !== e.s.command || (now.description ?? '') !== (e.s.description ?? '')
    || now.enter !== (e.s.enter !== false) || now.where !== e.where;
}

/** The variables the command uses, and what Save and Run can do now. */
function renderState() {
  if (!editEl.querySelector('[name="command"]')) return;
  const { command, enter } = read();
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
function save() {
  const e = current();
  if (!e) return false;
  const { name, command, description, enter, where } = read();
  if (!command) {
    find(editEl, '[name="command"]').focus();
    return false;
  }
  // Saved as it is: a description left empty isn't kept (undefined isn't written).
  const next = /** @type {SnippetSetting} */ ({ id: e.s.id, name: name || command.split(/\s+/).slice(0, NAME_WORDS).join(' '), command, description, enter });
  if (e.isDraft) draft = null;
  write(next.id, next, where);
  renderList();
  renderEditor();
  return true;
}

let saving = false;

/**
 * Saves through snippets.js without the window redrawing itself from the change it made.
 * @param {string} id
 * @param {SnippetSetting | null} next
 * @param {string} where
 */
function write(id, next, where) {
  saving = true;
  try { saveSnippet(id, next, where); } finally { saving = false; }
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

async function newSnippet() {
  if (!(await leave())) return;
  draft = { id: newSnippetId(), name: '', command: '', description: undefined, enter: true, where: SNIPPET_SCOPE.global };
  searchEl.value = '';
  selectedId = null;
  select(draft.id);
  /** @type {HTMLElement | null} */ (editEl.querySelector('[name="name"]'))?.focus();
}

function remove() {
  const e = current();
  if (!e) return;
  const at = shown.findIndex(x => x.s.id === e.s.id);
  if (e.isDraft) draft = null;
  else write(e.s.id, null, e.where);
  const rest = shown.filter(x => x.s.id !== e.s.id);
  selectedId = null;
  select(rest[Math.min(at, rest.length - 1)]?.s.id ?? null);
}

async function duplicate() {
  if (!(await leave())) return;
  const e = current();
  if (!e || e.isDraft) return;
  const copy = { ...e.s, id: newSnippetId(), name: `${e.s.name} copy` };
  // Not the new one (that has no copy), so a saved snippet.
  write(copy.id, /** @type {SnippetSetting} */ (copy), e.where);
  selectedId = null;
  select(copy.id);
  /** @type {HTMLInputElement | null} */ (editEl.querySelector('[name="name"]'))?.select();
}

function run() {
  const e = current();
  const tab = focusedTab();
  if (!e || e.isDraft || isDirty() || !tab || !e.s.command) return;
  closeSnippetsWindow({ force: true });
  setTimeout(() => runSnippet(/** @type {SnippetSetting} */ (e.s), { tab }));
}

// ---- Opening and closing ----

/** Opens the window, on a given snippet (by id), a new one, or the first. */
on(EVENTS.openSnippets, options => openSnippetsWindow(options));

/** @param {{ id?: string | null, create?: boolean }} [options] */
export function openSnippetsWindow({ id = null, create = false } = {}) {
  closeAll();
  layer.hidden = false;
  searchEl.value = '';
  draft = null;
  selectedId = null;
  editEl.innerHTML = '';
  renderList();
  if (create) return newSnippet();
  select(id ?? shown[0]?.s.id ?? null);
  if (!shown.length) renderEditor();
  /** @type {HTMLElement | null} */ (id ? editEl.querySelector('[name="command"]') : searchEl)?.focus();
}

/**
 * Closes the window; changes not saved are asked about first.
 * @param {{ force?: boolean }} [options]
 */
export async function closeSnippetsWindow({ force = false } = {}) {
  if (layer.hidden || (!force && !(await leave()))) return;
  layer.hidden = true;
  draft = null;
  editEl.innerHTML = '';
  restoreFocus();
}

export const toggleSnippetsWindow = () => (isOpen() ? closeSnippetsWindow() : openSnippetsWindow());

// Snippets changed somewhere else (a workspace's layout file, Settings, an edit from the run form).
on(EVENTS.snippets, () => {
  if (!isOpen() || saving) return;
  renderList();
  if (!current()) select(shown[0]?.s.id ?? null);
});
on(EVENTS.workspaces, () => { if (isOpen() && !saving) renderList(); });

// ---- Mouse and keys ----

layer.addEventListener('click', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('.sw-row'));
  if (row) { go(/** @type {string} */ (row.dataset.id), { focusList: true }); return; }
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-sw]'))?.dataset.sw;
  if (action === ACTION.close) closeSnippetsWindow();
  if (action === ACTION.new) newSnippet();
  if (action === ACTION.save) save();
  if (action === ACTION.delete) remove();
  if (action === ACTION.duplicate) duplicate();
  if (action === ACTION.run) run();
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
layer.addEventListener('keydown', e => {
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

byId('snippets-button').addEventListener('click', toggleSnippetsWindow);
