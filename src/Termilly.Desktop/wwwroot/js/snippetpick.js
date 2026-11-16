// @ts-check
// The snippets list, as VS Code's quick pick: the snippets button (or the palette, a terminal's menu, its shortcut)
// opens a search box under it with the keyboard in it, and below it this repository's snippets, this computer's and
// the repository's VS Code tasks, each group with the file it comes from, the last run first. Typing searches names,
// commands and descriptions. Enter runs the picked one in the focused terminal (a task in a new terminal, as VS Code
// does), Alt+Enter types it without Enter, Ctrl+Enter runs it in a new terminal. With nothing matching, Enter saves
// what was typed as a new snippet.

import { state, on, emit, EVENTS } from './store.js';
import { focusedTab } from './panes.js';
import { openPopover, closePopover, placeAgain, SIDE } from './popups.js';
import { escapeHtml, ICONS } from './ui.js';
import { fuzzyMatch, highlightPositions } from './fuzzy.js';
import { byId, find, field, targetOf } from './dom.js';
import { globalSnippets, editSnippet } from './snippets.js';
import { SOURCE, REPO_FILE, LAYOUT_FILE, taskFiles, repoOfTab, folderOfTab, loadRepo } from './reposnippets.js';
import { runAny, RUN_MODE } from './taskrun.js';

/** @typedef {import('./reposnippets.js').ListedSnippet} ListedSnippet */
/** @typedef {{ key: string, title: string, file: string, rows: ListedSnippet[], empty?: string }} Group */

const EDIT_ICON = ICONS.rename;
const NEW_TERMINAL_ICON = ICONS.terminal;
/** The row's buttons and the footer's (data-sp). */
const ACT = Object.freeze({ edit: 'edit', newTerminal: 'new-terminal', create: 'new', manage: 'manage' });
/** Where the list opens when the title bar's button isn't shown: under the top of the window, in the middle. */
const FALLBACK_TOP = 44;
const WIDTH = 560;
const ROW = '.sp-row';
const SELECTED = 'sel';
/** The title bar's button the list opens under. */
export const SNIPPETS_BUTTON = 'snippets-button';

const pop = document.createElement('section');
pop.className = 'popover sp-pop';
pop.hidden = true;
pop.innerHTML = `
  <div class="bp-search">${ICONS.search}<input type="text" spellcheck="false" autocomplete="off" placeholder="Search snippets and tasks"></div>
  <div class="sp-list" role="listbox"></div>
  <div class="sp-foot">
    <span><kbd>Enter</kbd> run</span><span><kbd>Alt</kbd>+<kbd>Enter</kbd> type only</span><span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> new terminal</span>
    <span class="spacer"></span>
    <button data-sp="${ACT.create}">New</button><button data-sp="${ACT.manage}">Manage</button>
  </div>`;

const input = field(pop, 'input');
const listEl = find(pop, '.sp-list');

/**
 * What the list shows, flat in its order, the row picked, and whether it's open.
 * @type {{ shown: ListedSnippet[], cursor: number, open: boolean }}
 */
const pick = { shown: [], cursor: 0, open: false };

/**
 * Newest run first; those never run keep the file's order.
 * @param {ListedSnippet[]} rows
 */
function byUse(rows) {
  const used = state.settings.data.snippetUsed ?? {};
  return [...rows].sort((a, b) => (used[b.id] ?? 0) - (used[a.id] ?? 0));
}

/** The groups for the focused terminal: its repository's (when it's in one), this computer's, the repository's tasks. */
function groups() {
  const tab = focusedTab();
  const repo = repoOfTab(tab);
  /** @type {Group[]} */
  const list = [];
  if (repo) {
    list.push({
      key: SOURCE.repo, title: 'This repo', file: REPO_FILE, rows: byUse([...repo.snippets, ...repo.shared]),
      empty: `No snippets in this repo yet. New keeps them in <code>${REPO_FILE}</code>, shared with everyone who clones it.`,
    });
  }
  list.push({ key: SOURCE.global, title: 'This computer', file: '', rows: byUse(globalSnippets()) });
  if (repo?.tasks.length) list.push({ key: SOURCE.task, title: 'VS Code tasks', file: taskFiles(repo.allTasks), rows: byUse(repo.tasks) });
  return list;
}

/**
 * @param {string} text
 * @param {string} q
 */
function marked(text, q) {
  const m = q ? fuzzyMatch(q, text) : null;
  return m ? highlightPositions(text, m.positions, escapeHtml) : escapeHtml(text);
}

/**
 * @param {ListedSnippet} s
 * @param {number} i
 * @param {string} q
 */
function rowHtml(s, i, q) {
  const meta = s.scope === SOURCE.shared ? LAYOUT_FILE : s.scope === SOURCE.task ? s.description ?? '' : '';
  return `<div class="sp-row${i === pick.cursor ? ' sel' : ''}" data-i="${i}" role="option" title="${escapeHtml(`${s.command}${s.description ? `\n${s.description}` : ''}`)}">
    <span class="sp-text"><span class="sp-name">${marked(s.name, q)}</span><code class="sp-cmd">${marked(s.command, q)}</code></span>
    ${meta ? `<span class="sp-meta">${escapeHtml(meta)}</span>` : ''}
    <span class="sp-acts">${s.task || s.scope === SOURCE.shared ? '' : `<button data-sp="${ACT.edit}" title="Edit">${EDIT_ICON}</button>`}<button data-sp="${ACT.newTerminal}" title="Run in a new terminal (Ctrl+Enter)">${NEW_TERMINAL_ICON}</button></span>
  </div>`;
}

/**
 * @param {ListedSnippet} s
 * @param {string} q
 */
const matches = (s, q) => !q || !!fuzzyMatch(q, `${s.name} ${s.command} ${s.description ?? ''}`);

/** A match in the name ranks above any in the command or description. */
const NAME_BONUS = 1000;

/**
 * How well a row matches what's typed (higher is better).
 * @param {ListedSnippet} s
 * @param {string} q
 */
function rank(s, q) {
  const name = fuzzyMatch(q, s.name);
  return name ? NAME_BONUS + name.score : fuzzyMatch(q, `${s.command} ${s.description ?? ''}`)?.score ?? -Infinity;
}

/**
 * The groups with the rows that match: while searching, the best match first, in its group, and that group first.
 * @param {string} q
 */
function matching(q) {
  const list = groups().map(g => ({ ...g, rows: g.rows.filter(s => matches(s, q)) }));
  if (!q) return list;
  const best = (/** @type {ListedSnippet[]} */ rows) => Math.max(...rows.map(s => rank(s, q)));
  for (const g of list) g.rows.sort((a, b) => rank(b, q) - rank(a, q));
  return list.sort((a, b) => best(b.rows) - best(a.rows));
}

function render() {
  if (!pick.open) return;
  const q = input.value.trim();
  let html = '';
  pick.shown = [];
  for (const g of matching(q)) {
    const rows = g.rows;
    if (!rows.length && (q || !g.empty)) continue;
    html += `<div class="sp-group"><span>${escapeHtml(g.title)}</span>${g.file ? `<code>${escapeHtml(g.file)}</code>` : ''}</div>`;
    if (!rows.length) html += `<div class="sp-empty">${g.empty}</div>`;
    for (const s of rows) html += rowHtml(s, pick.shown.push(s) - 1, q);
  }
  pick.cursor = Math.min(pick.cursor, Math.max(0, pick.shown.length - 1));
  if (!pick.shown.length) {
    html += q ? `<div class="sp-empty">No snippet or task matches. <b>Enter</b> saves “${escapeHtml(q)}” as a new snippet.</div>`
      : '<div class="sp-empty">No snippets yet. Make one with New, or use “Save the last command as a snippet” in a terminal’s menu.</div>';
  }
  listEl.innerHTML = html;
  listEl.querySelector(`${ROW}.${SELECTED}`)?.scrollIntoView({ block: 'nearest' });
  placeAgain(pop);
}

/**
 * Runs a row and closes the list.
 * @param {number} i
 * @param {string} mode
 */
function run(i, mode) {
  const s = pick.shown[i];
  if (!s) return;
  closePopover(pop);
  setTimeout(() => runAny(s, mode));
}

/** @param {{ id?: string, create?: boolean }} options */
function manage(options) {
  closePopover(pop);
  setTimeout(() => emit(EVENTS.openSnippets, options));
}

input.addEventListener('input', () => {
  pick.cursor = 0;
  render();
});

input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    pick.cursor = Math.max(0, Math.min(pick.shown.length - 1, pick.cursor + (e.key === 'ArrowDown' ? 1 : -1)));
    render();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const q = input.value.trim();
    if (!pick.shown.length) {
      if (!q) return;
      closePopover(pop);
      setTimeout(() => editSnippet({ command: q }));
      return;
    }
    run(pick.cursor, e.ctrlKey ? RUN_MODE.newTerminal : e.altKey ? RUN_MODE.typeOnly : RUN_MODE.focused);
  }
});

pop.addEventListener('mousedown', e => {
  // The search box keeps the keyboard.
  if (targetOf(e).closest(`${ROW}, button`)) e.preventDefault();
});

pop.addEventListener('click', e => {
  const button = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-sp]'));
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
  const i = Number(row?.dataset.i ?? -1);
  const act = button?.dataset.sp;
  if (act === ACT.create) return manage({ create: true });
  if (act === ACT.manage) return manage({ id: pick.shown[pick.cursor]?.id });
  if (act === ACT.edit) return manage({ id: pick.shown[i]?.id });
  if (row) run(i, act === ACT.newTerminal ? RUN_MODE.newTerminal : RUN_MODE.focused);
});

pop.addEventListener('mousemove', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
  const i = Number(row?.dataset.i ?? -1);
  if (row && i !== pick.cursor) {
    pick.cursor = i;
    for (const r of listEl.querySelectorAll(ROW)) r.classList.toggle(SELECTED, r === row);
  }
});

on(EVENTS.snippets, render);

/** Opens the list under the snippets button (or near the top of the window when it isn't shown). */
export function openSnippetPick() {
  const button = byId(SNIPPETS_BUTTON);
  const anchor = button.offsetParent ? button : { x: Math.max(0, (window.innerWidth - WIDTH) / 2), y: FALLBACK_TOP };
  input.value = '';
  // Open once it's placed: placing it closes it first when it was open, and that says it's shut.
  openPopover(pop, anchor, { side: SIDE.below, dynamic: true, onClose: () => { pick.open = false; } });
  Object.assign(pick, { cursor: 0, open: true });
  render();
  input.focus();
  // Read again: the repository's files may have changed while nothing watched them (a network share).
  loadRepo(folderOfTab(focusedTab()));
}

/** Opens the list, or closes it when it's open (the title bar's button). */
export const toggleSnippetPick = () => (pick.open ? closePopover(pop) : openSnippetPick());

