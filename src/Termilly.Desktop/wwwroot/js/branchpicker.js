// @ts-check
// The status bar's branch picker, as Visual Studio's: a search box that has the keyboard as it opens, the local
// branches (the current one ticked, the most recent first) until something is typed, then local and remote ones that
// match, grouped by remote. Enter switches; a remote branch is checked out as a new local one that tracks it. When
// nothing matches, Enter makes a branch of that name. git does the work in the background (GitView.Act), and when it
// refuses, what it said is shown here as it would be in a terminal.

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { emit, EVENTS } from './store.js';
import { openPopover, closePopover, placeAgain, SIDE } from './popups.js';
import { escapeHtml, highlight, formatWhen, ICONS } from './ui.js';
import { tabRepo } from './gitstatus.js';
import { onServer, GIT_TAB } from './gitwindow.js';
import { find, field, targetOf } from './dom.js';
import { GIT_ACTION } from './constants.js';

/** @typedef {import('./gitsearch.js').Branch} Branch */

/** The most rows a search shows of each group: a repository can have thousands of remote branches. */
const MAX_ROWS = 50;
const ROW = '.bp-row';
/** The group of local branches, above the remotes' (named after their remote). */
const LOCAL_GROUP = 'Local';
/** The current branch's tick, drawn at the size it shows (12px). */
const CHECK = '<svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.5 2.5 4.5-5"/></svg>';

/** What Enter does with the text in the box: switch to the branch picked, or make a new one of that name. */
const MODE = Object.freeze({ pick: 'pick', create: 'create' });
/** What the line under the list says: before anything is typed, and while searching. */
const BROWSE_HINT = 'Type to search remote branches too';
const SEARCH_HINT = 'Enter switches. A remote branch becomes a local one that tracks it.';
/** The footer's buttons (data-bp). */
const FOOT = Object.freeze({ newBranch: 'new-branch', fetch: 'fetch', manage: 'manage' });

const pop = document.createElement('section');
pop.className = 'popover bp-pop';
pop.hidden = true;
pop.innerHTML = `
  <div class="bp-search">${ICONS.search}<input type="text" spellcheck="false" autocomplete="off"></div>
  <div class="bp-list" role="listbox"></div>
  <div class="bp-error" hidden><div class="bp-error-head">Git didn’t do that</div><pre class="bp-error-text"></pre></div>
  <div class="bp-hint"></div>
  <div class="bp-foot">
    <button data-bp="${FOOT.newBranch}">${ICONS.plus}<span>New branch</span></button>
    <button data-bp="${FOOT.fetch}">${ICONS.history}<span>Fetch</span></button>
    <button data-bp="${FOOT.manage}" class="bp-right">${ICONS.git}<span>Manage branches</span></button>
  </div>`;

const input = field(pop, 'input');
const listEl = find(pop, '.bp-list');
const hintEl = find(pop, '.bp-hint');
const errorEl = find(pop, '.bp-error');

/**
 * The picker's terminal and repository, what git listed, what the list shows and which row is picked.
 * @type {{ tab: Tab | null, root: string, remote: string | undefined, current: string | null, branches: Branch[],
 *   shown: Branch[], cursor: number, mode: string, busy: boolean }}
 */
const picker = { tab: null, root: '', remote: undefined, current: null, branches: [], shown: [], cursor: 0, mode: MODE.pick, busy: false };

/**
 * Asks git, through the host, about the terminal's repository (on this PC or its SSH server).
 * @template {'gitview:branches' | 'gitview:act'} K
 * @param {K} type
 * @param {import('./protocol.js').PageMessages[K]} payload
 * @returns {Promise<any>}
 */
async function ask(type, payload) {
  const m = await request(type, { ...payload, root: picker.root, remote: picker.remote });
  if (m.error) throw new Error(m.error);
  return m.data;
}

/**
 * Opens the picker over a terminal's branch in its status bar.
 * @param {Tab} tab
 * @param {HTMLElement} anchor
 */
export async function openBranchPicker(tab, anchor) {
  const repo = tabRepo(tab);
  if (!repo) return;
  Object.assign(picker, { tab, root: repo.root, remote: onServer(tab) ? tab.id : undefined, current: repo.branch ?? null, branches: [], shown: [], cursor: 0, busy: false });
  setMode(MODE.pick);
  showError(null);
  listEl.innerHTML = '<div class="bp-empty">Loading</div>';
  openPopover(pop, anchor, { side: SIDE.above, dynamic: true, onClose: () => { picker.tab = null; } });
  input.focus();
  await loadBranches();
}

async function loadBranches() {
  try {
    picker.branches = await ask(PAGE.gitviewBranches, {});
  } catch (e) {
    picker.branches = [];
    showError(/** @type {Error} */ (e).message);
  }
  render();
}

/** @param {string} mode */
function setMode(mode) {
  picker.mode = mode;
  input.value = '';
  input.placeholder = mode === MODE.create ? `New branch from ${picker.current ?? 'HEAD'}` : 'Search local and remote branches';
  hintEl.textContent = mode === MODE.create ? 'Enter makes the branch and switches to it' : BROWSE_HINT;
}

/**
 * git's own words when it refused (or couldn't be asked), or none.
 * @param {string | null} text
 */
function showError(text) {
  errorEl.hidden = !text;
  find(errorEl, '.bp-error-text').textContent = text ?? '';
  placeAgain(pop);
}

/**
 * The remote a remote branch is on ("origin" of "origin/main").
 * @param {Branch} b
 */
const remoteOf = b => b.name.split('/')[0];

/**
 * The branches the list shows: the local ones, and once something is typed, the matching remote ones too (local first,
 * then by remote, each as git sorted them, newest first).
 * @param {string} query
 */
function shownBranches(query) {
  const q = query.trim().toLowerCase();
  const matches = picker.branches.filter(b => (!q ? !b.remote : b.name.toLowerCase().includes(q)));
  const local = matches.filter(b => !b.remote).slice(0, MAX_ROWS);
  const remotes = [...new Set(matches.filter(b => b.remote).map(remoteOf))];
  return [...local, ...remotes.flatMap(r => matches.filter(b => b.remote && remoteOf(b) === r).slice(0, MAX_ROWS))];
}

/**
 * @param {Branch} b
 * @param {number} i its place in the list
 * @param {string} q what was typed, lower case
 */
function rowHtml(b, i, q) {
  const track = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' ');
  const name = b.remote ? `<span class="bp-remote">${escapeHtml(remoteOf(b))}/</span>${highlight(b.name.slice(remoteOf(b).length + 1), q)}` : highlight(b.name, q);
  return `<div class="bp-row${b.current ? ' current' : ''}${i === picker.cursor ? ' sel' : ''}" data-i="${i}" role="option" title="${escapeHtml(`${b.name}\n${b.short} ${b.subject}`)}">
      <span class="bp-check">${b.current ? CHECK : ''}</span><span class="bp-name">${name}</span>
      <span class="bp-meta">${track ? `<span class="bp-ab">${track}</span> · ` : ''}${b.gone ? 'gone · ' : ''}${escapeHtml(b.date ? formatWhen(Date.parse(b.date)) : '')}</span></div>`;
}

/**
 * @param {string} label
 * @param {number} count
 */
const groupHtml = (label, count) => `<div class="bp-group">${label === LOCAL_GROUP ? ICONS.monitor : ICONS.remote}<span>${escapeHtml(label)}</span><span class="bp-count">${count}</span></div>`;

function render() {
  fillList();
  placeAgain(pop);
}

/** What the list shows: nothing while a new branch is named, the branches, or why there are none. */
function fillList() {
  if (picker.mode === MODE.create) {
    listEl.innerHTML = '';
    return;
  }
  const q = input.value.trim().toLowerCase();
  picker.shown = shownBranches(q);
  picker.cursor = Math.min(picker.cursor, Math.max(0, picker.shown.length - 1));
  if (!picker.shown.length) {
    listEl.innerHTML = picker.branches.length || !errorEl.hidden
      ? `<div class="bp-empty">${q ? `No branch matches “${escapeHtml(q)}”. Enter makes it, from ${escapeHtml(picker.current ?? 'HEAD')}.` : 'No branches yet.'}</div>`
      : '<div class="bp-empty">Loading</div>';
    return;
  }
  let html = '';
  let group = '';
  picker.shown.forEach((b, i) => {
    const g = b.remote ? remoteOf(b) : LOCAL_GROUP;
    if (g !== group) {
      group = g;
      html += groupHtml(g, picker.shown.filter(x => (x.remote ? remoteOf(x) : LOCAL_GROUP) === g).length);
    }
    html += rowHtml(b, i, q);
  });
  listEl.innerHTML = html;
  listEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

/**
 * Has git do something to the repository; on success the picker closes and the status bars follow, on a refusal git's
 * words stay in the picker.
 * @param {string} action
 * @param {string} [ref]
 * @param {string} [busyText]
 */
async function act(action, ref, busyText = 'Switching') {
  if (picker.busy) return false;
  picker.busy = true;
  hintEl.textContent = busyText;
  showError(null);
  try {
    await ask(PAGE.gitviewAct, { action, ref, hasCommits: true });
    return true;
  } catch (e) {
    showError(/** @type {Error} */ (e).message);
    return false;
  } finally {
    picker.busy = false;
    emit(EVENTS.gitChanged); // the status bars and the Git window follow
  }
}

/** @param {Branch} b */
async function switchTo(b) {
  if (b.current) return closePopover(pop);
  if (await act(GIT_ACTION.switch, b.ref, `Switching to ${b.name}`)) closePopover(pop);
  else setMode(picker.mode);
}

/** @param {string} name */
async function createBranch(name) {
  if (!name.trim()) return;
  if (await act(GIT_ACTION.newBranch, name.trim(), `Making ${name.trim()}`)) closePopover(pop);
  else hintEl.textContent = '';
}

async function fetchRemotes() {
  if (await act(GIT_ACTION.fetch, undefined, 'Fetching')) hintEl.textContent = 'Fetched';
  await loadBranches();
}

function manage() {
  const { root, remote } = picker;
  closePopover(pop);
  emit(EVENTS.openGit, { folder: root, show: GIT_TAB.branches, remote });
}

input.addEventListener('input', () => {
  picker.cursor = 0;
  if (picker.mode === MODE.pick) hintEl.textContent = input.value.trim() ? SEARCH_HINT : BROWSE_HINT;
  render();
});

input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    picker.cursor = Math.max(0, Math.min(picker.shown.length - 1, picker.cursor + step));
    render();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const picked = picker.shown[picker.cursor];
    if (picker.mode === MODE.create || !picked) createBranch(input.value);
    else switchTo(picked);
  }
});

listEl.addEventListener('click', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
  if (row) switchTo(picker.shown[Number(row.dataset.i)]);
});

find(pop, '.bp-foot').addEventListener('click', e => {
  const button = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-bp]'));
  if (!button) return;
  if (button.dataset.bp === FOOT.newBranch) {
    setMode(MODE.create);
    render();
    input.focus();
  } else if (button.dataset.bp === FOOT.fetch) fetchRemotes();
  else manage();
});
