// @ts-check
// The Git window: a repository's working tree (staged, changed, untracked and conflicted files), any file's diff,
// its history and its branches, read only. The host runs git (GitView.cs); this draws it, with the change
// preview's diff rows (js/diffrows.js). It opens from a branch chip in the sidebar, the workspace and terminal
// menus, the palette and Ctrl+Shift+G, and follows the repository while it's open: after a command ends, when the
// window gets focus, and on Refresh.

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { state, on, emit, isSsh, EVENTS } from './store.js';
import { debounce } from './util.js';
import { restoreFocus } from './panes.js';
import { closeAll, showMenu, SEPARATOR } from './popups.js';
import { confirmDialog, modal } from './dialogs.js';
import { escapeHtml, highlight, ICONS } from './ui.js';
import { buildDiffRows, diffRowHtml, DIFF_SCROLL } from './diffrows.js';
import { remoteGit } from './remotehost.js';
import { SETTING_VALUES, CHANGE_KIND, DIFF_SIDE, GIT_ACTION } from './constants.js';
import { find, field, targetOf, resizeByGrip } from './dom.js';
import {
  ITEM, CONFLICT, found, searching, clearSearch, runSearch, searchCode, searchItems, searchEmptyText, searchRowHtml,
  filtersHtml, stepView, setView, hitKey, markInDiff, ago,
} from './gitsearch.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { changeLayout, changeNewFile, changeView } = SETTING_VALUES;

// What GitView.cs answers with, and what this window keeps.
/**
 * A file in the working tree's status: its path (and where it was renamed from), and git's status letter.
 * @typedef {{ path: string, oldPath?: string | null, status: string }} GitFile
 */
/**
 * A repository's status: where it is, its branch against its upstream, and its files by state.
 * @typedef {{ root: string, name: string, branch?: string | null, detached?: boolean, upstream?: string | null,
 *   ahead?: number, behind?: number, hasCommits?: boolean, staged: GitFile[], unstaged: GitFile[],
 *   untracked: GitFile[], conflicted: GitFile[] }} RepoStatus
 */
/** @typedef {import('./gitsearch.js').Commit} Commit */
/** @typedef {import('./gitsearch.js').Branch} Branch */
/**
 * A file a commit changed: its line counts are null for a binary file.
 * @typedef {{ path: string, oldPath?: string | null, status: string, added?: number | null,
 *   removed?: number | null }} CommitFile
 */
/**
 * A commit in full: its message, people, parents and files.
 * @typedef {{ hash: string, message: string, author: string, committer: string, authorDate: string,
 *   parents: string[], files: CommitFile[] }} CommitDetail
 */
/**
 * A changed file's row: which list it's in (staged, unstaged, untracked), and whether it's in conflict.
 * @typedef {{ kind: 'file', side: string, path: string, oldPath?: string | null, status: string,
 *   conflict: boolean }} FileItem
 */
/**
 * A row of the side list: a section's head, a file, a commit, a branch, "Load more commits", or the search's.
 * @typedef {{ kind: 'section', key: string, label: string, count: number, fixed?: boolean } | FileItem
 *   | { kind: 'commit', commit: Commit } | { kind: 'branch', branch: Branch } | { kind: 'more' }
 *   | import('./gitsearch.js').SearchItem} ListItem
 */
/**
 * A file whose diff can be shown: a changed file's row, or a file in a commit.
 * @typedef {{ path: string, oldPath?: string | null, side?: string, conflict?: boolean }} ShownFile
 */
/**
 * What the right side shows: a file (by side and path), a commit (by hash) or a branch (by ref); and the search's
 * row it was opened from (its hitKey).
 * @typedef {{ kind: string, side?: string, path?: string, hash?: string, ref?: string, hit?: string | null }} Selection
 */
/**
 * A diff as GitView.cs sends it: the change preview's data, and what's said about it.
 * @typedef {import('./diffrows.js').DiffData & { display?: string | null, error?: string | null,
 *   note?: string | null, added?: number, removed?: number, eolOnly?: boolean }} GitDiff
 */
/**
 * The diff shown: what was asked, the answer, the folds opened, and where it's drawn; for a search's hit, the whole
 * file (to show a line that didn't change) and what it found marked.
 * @typedef {{ request: import('./protocol.js').Page_gitviewDiff, data: GitDiff, expanded: Set<string>,
 *   target: Element, label: string | null, find: Find | null }} DiffState
 */
/**
 * A search's hit in a diff: the line to show (the file's, 0 for the first match), and whether the whole file shows.
 * @typedef {{ line: number, wholeFile: boolean }} Find
 */

const CLOSE = '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
const CHEVRON = '<svg viewBox="0 0 12 12"><path d="M4.5 3L7.5 6 4.5 9"/></svg>';
const REFRESH = '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/></svg>';
/** Rows drawn at most for one diff; a longer one says how much is left out. */
const MAX_ROWS = 6000;
/** Commits read at a time in History. */
const HISTORY_PAGE = 100;
/** How near the side list's end (in pixels) History's scroll gets before its next page loads. */
const LOAD_MORE_PX = 200;
/** Commits shown in a branch's latest commits. */
const BRANCH_LOG_COMMITS = 50;
/** How long a Copy button says "Copied". */
const COPIED_MS = 1200;

/** The window's tabs (data-gw-tab), and what the side list shows. */
const GIT_TAB = Object.freeze({ changes: 'changes', history: 'history', branches: 'branches' });
/** The buttons in the window's head (data-gw). */
const HEAD_BUTTON = Object.freeze({ close: 'close', refresh: 'refresh' });
/**
 * Which list a file is in, as GitView.cs takes it for its diff and actions; a file in a commit is on the 'commit'
 * side. 'conflict' is the Conflicts section's own, whose files are unstaged.
 */
const SIDE = Object.freeze({ ...DIFF_SIDE, conflict: CONFLICT });
/** The Branches tab's sections. */
const BRANCH_GROUP = Object.freeze({ current: 'Current', local: 'Local', remote: 'Remote' });
/** The window's title before (or without) a repository. */
const GIT_TITLE = 'Git';
/** A conflicted file's status title, and its side's label over its diff. */
const CONFLICT_LABEL = 'Conflict';
const RESTORE_LABEL = 'Restore';
const STAGE_LABEL = 'Stage';
const COPY_LABEL = 'Copy';
const COPIED_LABEL = 'Copied';
/** The changes window's layout, which this window shares (app.css): a side list's row and the grip between. */
const ROW = '.cw-row';
const GRIP = '.cw-grip';
/** How narrow and how wide the file list can be dragged. */
const SIDE_MIN_PX = 240;
const SIDE_MAX_PX = 720;
/** How long the search waits after a key before it asks git. */
const SEARCH_DELAY = 300;
/** Rows a search's arrow keys show as they reach them (the rest, like "Show all", wait for Enter). */
/** @type {Set<string>} */
const PREVIEWED = new Set([ITEM.file, ITEM.commit, ITEM.branch, ITEM.fileHit, ITEM.commitHit, ITEM.tag]);

const layer = document.createElement('div');
layer.className = 'modal-layer settings-layer changes-layer git-layer';
layer.hidden = true;
layer.innerHTML = `
  <div class="settings changes-win git-win" role="dialog" aria-modal="true" aria-labelledby="gw-title">
    <div class="set-head">
      <span class="gw-mark">${ICONS.git}</span>
      <h2 id="gw-title"></h2>
      <span class="gw-branch"></span>
      <span class="seg gw-tabs" role="tablist">
        <button data-gw-tab="${GIT_TAB.changes}" role="tab">Changes</button>
        <button data-gw-tab="${GIT_TAB.history}" role="tab">History</button>
        <button data-gw-tab="${GIT_TAB.branches}" role="tab">Branches</button>
      </span>
      <button class="pane-btn gw-refresh" data-gw="${HEAD_BUTTON.refresh}" title="Refresh">${REFRESH}</button>
      <button class="set-close" data-gw="${HEAD_BUTTON.close}" title="Close (Esc)">${CLOSE}</button>
    </div>
    <div class="cw-main">
      <div class="cw-side gw-side">
        <div class="cw-filter gw-search">
          <input class="field" placeholder="Search changes, commits, code, branches and tags" aria-label="Search the repository"
            title="Finds text in changed files, commit messages, hashes and authors, the lines commits changed, and branch and tag names (Ctrl+F)"
            spellcheck="false" autocomplete="off">
        </div>
        <div class="pal-filters gw-filters" hidden></div>
        <div class="gw-list" tabindex="0" role="listbox" aria-label="Files"></div>
      </div>
      <div class="cw-grip" title="Drag to resize"></div>
      <div class="gw-right" tabindex="-1"></div>
    </div>
  </div>`;
document.body.append(layer);

const titleEl = find(layer, '#gw-title');
const branchEl = find(layer, '.gw-branch');
const searchEl = field(layer, '.gw-search input');
const filtersEl = find(layer, '.gw-filters');
const listEl = find(layer, '.gw-list');
const sideEl = find(layer, '.gw-side');
const rightEl = find(layer, '.gw-right');

const isOpen = () => !layer.hidden;

// ---- Asking the host ----

/**
 * Asks git, through the host, about the repository (on this PC or the SSH terminal's server): its data, or git's error.
 * @template {keyof import('./protocol.js').PageMessages} K
 * @param {K} type
 * @param {import('./protocol.js').PageMessages[K]} payload
 * @returns {Promise<any>}
 */
async function ask(type, payload) {
  const m = await request(type, { ...payload, remote: server ?? undefined });
  if (m.error) throw new Error(m.error);
  return m.data;
}

// ---- State ----

/** @type {string | null} */
let folder = null; // what it was opened for
/** @type {string | null} */
let server = null; // the SSH terminal whose server the repository is on, or null for this PC
/** @type {RepoStatus | null} */
let repo = null; // the last status: { root, name, branch, staged, unstaged, untracked, conflicted, ... }
/** @type {string} */
let tab = GIT_TAB.changes;
/** @type {ListItem[]} */
let items = []; // the side list's rows: { kind: 'file' | 'section' | 'commit' | 'branch' | 'more', ... }
let cursor = -1; // the row the keyboard is on
/** @type {Commit[]} */
let commits = []; // History, as loaded so far
let historyDone = false;
/** @type {Branch[]} */
let branches = [];
/** @type {Set<string>} */
const collapsedSections = new Set();
/** @type {Selection | null} */
let selection = null; // what the right side shows: a file, a commit, a branch
/** @type {DiffState | null} */
let diffState = null; // { request, data, expanded }

// ---- Opening ----

/**
 * Opens the window on the repository a folder is in; with `remote` (an SSH terminal's id), on the server that
 * terminal is connected to, where git runs over ssh.
 * @param {string | null | undefined} forFolder
 * @param {{ show?: string, remote?: string | null }} [options]
 */
export async function openGitWindow(forFolder, { show = GIT_TAB.changes, remote = null } = {}) {
  if (!forFolder) return;
  closeAll();
  folder = forFolder;
  server = remote || null;
  tab = show;
  repo = null;
  clearSearch();
  searchEl.value = '';
  commits = [];
  historyDone = false;
  branches = [];
  selection = null;
  diffState = null;
  cursor = -1;
  layer.hidden = false;
  titleEl.textContent = GIT_TITLE;
  branchEl.innerHTML = '';
  listEl.innerHTML = '<div class="gw-empty">Loading</div>';
  rightEl.innerHTML = '';
  renderTabs();
  listEl.focus();
  await refresh();
}

/**
 * For an SSH terminal whose server hasn't reported a repository (Termilly isn't set up there, or it's not in one):
 * it says so, rather than showing this PC's.
 */
export function openRemoteGitNotice() {
  closeAll();
  folder = null;
  server = null;
  repo = null;
  items = [];
  selection = null;
  diffState = null;
  cursor = -1;
  layer.hidden = false;
  titleEl.textContent = GIT_TITLE;
  branchEl.innerHTML = '';
  listEl.innerHTML = '<div class="gw-empty">This terminal\'s server hasn\'t said which repository it\'s in. Set up Termilly on this host (in the terminal\'s menu), then cd into a repository.</div>';
  rightEl.innerHTML = '';
  listEl.focus();
}

export function closeGitWindow() {
  if (layer.hidden) return;
  layer.hidden = true;
  listEl.innerHTML = '';
  rightEl.innerHTML = '';
  repo = null;
  restoreFocus();
}

on(EVENTS.openGit, ({ folder: f, show, remote } = {}) => openGitWindow(f, { show, remote }));

/** Looks at the repository again: its status, and whatever the open tab shows. */
async function refresh() {
  if (!isOpen() || !folder) return;
  try {
    repo = await ask(PAGE.gitviewStatus, { folder });
  } catch (e) {
    repo = null;
    titleEl.textContent = GIT_TITLE;
    branchEl.innerHTML = '';
    listEl.innerHTML = `<div class="gw-empty">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
    rightEl.innerHTML = `<div class="gw-message">${escapeHtml(
      /** @type {Error} */ (e).message === 'Not in a git repository.'
        ? `Not in a git repository: ${folder}` : /** @type {Error} */ (e).message)}</div>`;
    return;
  }
  renderHead();
  if (searching()) {
    runSearch(found.text, /** @type {RepoStatus} */ (repo).root, ask, searchChanged);
  } else if (tab === GIT_TAB.changes) {
    renderList();
    // The file shown may have changed on disk, or left the list.
    if (selection?.kind === ITEM.file) {
      const still = /** @type {FileItem | undefined} */ (changeItems().find(i => i.kind === ITEM.file
        && i.side === /** @type {Selection} */ (selection).side
        && i.path === /** @type {Selection} */ (selection).path));
      if (still) showFile(still, { keepScroll: true }); else showNothing();
    } else if (!selection) {
      selectFirst();
    }
  } else if (tab === GIT_TAB.history) {
    commits = [];
    historyDone = false;
    await loadHistory();
  } else {
    await loadBranches();
  }
}

// ---- Head and tabs ----

/** The head: the repository's name and branch (called with a status in hand). */
function renderHead() {
  titleEl.textContent = /** @type {RepoStatus} */ (repo).name;
  titleEl.title = /** @type {RepoStatus} */ (repo).root;
  const ab = [/** @type {RepoStatus} */ (repo).ahead ? `↑${/** @type {RepoStatus} */ (repo).ahead}` : '',
    /** @type {RepoStatus} */ (repo).behind ? `↓${/** @type {RepoStatus} */ (repo).behind}` : '']
    .filter(Boolean).join(' ');
  const name = /** @type {RepoStatus} */ (repo).detached ? 'detached HEAD' : /** @type {RepoStatus} */ (repo).branch;
  branchEl.innerHTML = `<span class="gw-branch-name">${escapeHtml(name ?? '')}</span>${ab ? `<span class="gw-ab">${ab}</span>` : ''}`;
  branchEl.title = /** @type {RepoStatus} */ (repo).upstream
    ? `Tracking ${/** @type {RepoStatus} */ (repo).upstream}` : 'No upstream';
  const n = changeCount();
  find(layer, `[data-gw-tab="${GIT_TAB.changes}"]`).textContent = n ? `Changes ${n}` : 'Changes';
}

const changeCount = () => repo ? repo.staged.length + repo.unstaged.length + repo.untracked.length + repo.conflicted.length : 0;

function renderTabs() {
  // While searching, the list is the search's: no tab is on (a click on one ends the search).
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (layer.querySelectorAll('[data-gw-tab]'))) {
    b.classList.toggle('on', b.dataset.gwTab === tab && !searching());
    b.setAttribute('aria-selected', String(b.dataset.gwTab === tab && !searching()));
  }
  listEl.setAttribute('aria-label',
    /** @type {Record<string, string>} */ ({ changes: 'Changed files', history: 'Commits', branches: 'Branches' })[tab]);
}

/** @param {string} next */
async function switchTab(next) {
  if ((next === tab && !searching()) || !repo) return;
  if (searching()) endSearch();
  tab = next;
  selection = null;
  diffState = null;
  cursor = -1;
  renderTabs();
  showNothing();
  if (tab === GIT_TAB.changes) {
    renderList();
    selectFirst();
  } else if (tab === GIT_TAB.history) {
    if (!commits.length) await loadHistory(); else renderList();
  } else {
    await loadBranches();
  }
  listEl.focus();
}

// ---- The side list ----

/**
 * The Changes tab's sections: the status's list, its heading, and the side its files are on.
 * @type {Array<['conflicted' | 'staged' | 'unstaged' | 'untracked', string, string]>}
 */
const SECTIONS = [
  ['conflicted', 'Conflicts', SIDE.conflict],
  ['staged', 'Staged', SIDE.staged],
  ['unstaged', 'Changes', SIDE.unstaged],
  ['untracked', 'Untracked', SIDE.untracked],
];

function changeItems() {
  /** @type {ListItem[]} */
  const out = [];
  for (const [key, label, side] of SECTIONS) {
    const files = repo?.[key] ?? [];
    if (!files.length) continue;
    out.push({ kind: ITEM.section, key, label, count: files.length });
    if (collapsedSections.has(key)) continue;
    for (const f of files) out.push({ kind: ITEM.file, side: side === SIDE.conflict ? SIDE.unstaged : side, path: f.path, oldPath: f.oldPath, status: side === SIDE.untracked ? 'U' : f.status, conflict: side === SIDE.conflict });
  }
  return out;
}

function renderList() {
  filtersEl.hidden = !searching();
  if (searching()) {
    filtersEl.innerHTML = filtersHtml();
    items = /** @type {ListItem[]} */ (searchItems());
    if (!items.length) {
      listEl.innerHTML = `<div class="gw-empty">${searchEmptyText()}</div>`;
      return;
    }
  } else if (tab === GIT_TAB.changes) {
    items = changeItems();
    if (!items.length) {
      listEl.innerHTML = `<div class="gw-empty">${repo?.hasCommits === false ? 'No commits yet, and nothing to add.' : 'Nothing to commit: the working tree is clean.'}</div>`;
      return;
    }
  } else if (tab === GIT_TAB.history) {
    items = commits.map(c => ({ kind: ITEM.commit, commit: c }));
    if (!historyDone && commits.length) items.push({ kind: ITEM.more });
    if (!items.length) {
      listEl.innerHTML = '<div class="gw-empty">No commits yet.</div>';
      return;
    }
  } else {
    items = [];
    /** @type {Array<[string, Branch[]]>} */
    const groups = [[BRANCH_GROUP.current, branches.filter(b => b.current)], [BRANCH_GROUP.local, branches.filter(b => !b.current && !b.remote)], [BRANCH_GROUP.remote, branches.filter(b => b.remote)]];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      items.push({ kind: ITEM.section, key: `b-${label}`, label, count: list.length, fixed: true });
      for (const b of list) items.push({ kind: ITEM.branch, branch: b });
    }
    if (!items.length) {
      listEl.innerHTML = '<div class="gw-empty">No branches yet.</div>';
      return;
    }
  }
  listEl.innerHTML = items.map((item, i) => rowHtml(item, i)).join('');
  markCursor();
}

/** @type {Record<string, string>} */
const STATUS_TITLE = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked' };

/**
 * @param {ListItem} item
 * @param {number} i
 */
function rowHtml(item, i) {
  const hit = searchRowHtml(item, i, !!selection?.hit && selection.hit === hitKey(/** @type {any} */ (item)));
  if (hit !== null) return hit;
  if (item.kind === ITEM.section) {
    const open = item.fixed || !collapsedSections.has(item.key);
    return `<div class="cw-row gw-section${open ? ' open' : ''}" data-i="${i}"><span class="cw-chev">${item.fixed ? '' : CHEVRON}</span><span class="cw-name">${escapeHtml(item.label)}</span><span class="cw-count">${item.count}</span></div>`;
  }
  if (item.kind === ITEM.file) {
    const slash = item.path.lastIndexOf('/');
    const name = item.path.slice(slash + 1);
    const dir = slash > 0 ? item.path.slice(0, slash) : '';
    const letter = item.conflict ? '!' : item.status;
    const title = item.conflict ? CONFLICT_LABEL : STATUS_TITLE[item.status] ?? item.status;
    const sel = selection?.kind === ITEM.file && selection.side === item.side && selection.path === item.path;
    return `<div class="cw-row gw-file${sel ? ' selected' : ''}" data-i="${i}" role="option" title="${escapeHtml(item.oldPath ? `${item.oldPath} → ${item.path}` : item.path)}">`
      + `<span class="gw-status" data-s="${item.conflict ? SIDE.conflict : item.status}" title="${title}">${escapeHtml(letter)}</span>`
      + `<span class="cw-name">${escapeHtml(name)}</span><span class="gw-dir">${escapeHtml(item.oldPath ? `from ${item.oldPath}` : dir)}</span></div>`;
  }
  if (item.kind === ITEM.commit) {
    const c = item.commit;
    const sel = selection?.kind === ITEM.commit && selection.hash === c.hash;
    return `<div class="cw-row gw-commit${sel ? ' selected' : ''}" data-i="${i}" role="option">`
      + `<span class="gw-commit-main"><span class="gw-subject">${escapeHtml(c.subject || '(no message)')}</span>${refChips(c.refs)}</span>`
      + `<span class="gw-commit-meta"><span class="gw-hash">${escapeHtml(c.short)}</span><span>${escapeHtml(c.author)}</span><span>${ago(c.date)}</span></span></div>`;
  }
  if (item.kind === ITEM.branch) {
    const b = item.branch;
    const sel = selection?.kind === ITEM.branch && selection.ref === b.ref;
    const ab = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : '', b.gone ? 'upstream gone' : ''].filter(Boolean).join(' ');
    return `<div class="cw-row gw-commit gw-branch-row${sel ? ' selected' : ''}" data-i="${i}" role="option">`
      + `<span class="gw-commit-main"><span class="gw-subject${b.current ? ' current' : ''}">${highlight(b.name, found.text.toLowerCase())}</span>${ab ? `<span class="gw-ab">${ab}</span>` : ''}</span>`
      + `<span class="gw-commit-meta"><span class="gw-hash">${escapeHtml(b.short)}</span><span>${escapeHtml(b.subject)}</span><span>${ago(b.date)}</span></span></div>`;
  }
  return `<div class="cw-row gw-more" data-i="${i}">Load more commits</div>`;
}

/**
 * Branch and tag chips on a commit: HEAD's branch first and marked.
 * @param {string[] | null | undefined} refs
 */
function refChips(refs) {
  if (!refs?.length) return '';
  return refs.map(r => {
    if (r.startsWith('HEAD -> ')) return `<span class="gw-ref head" title="The checked-out branch">${escapeHtml(r.slice(8))}</span>`;
    if (r === 'HEAD') return '<span class="gw-ref head">HEAD</span>';
    if (r.startsWith('tag: ')) return `<span class="gw-ref is-tag">${escapeHtml(r.slice(5))}</span>`;
    if (r.startsWith('remote: ')) return `<span class="gw-ref remote">${escapeHtml(r.slice(8))}</span>`;
    return `<span class="gw-ref">${escapeHtml(r)}</span>`;
  }).join('');
}

function markCursor() {
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (listEl.querySelectorAll(ROW))) row.classList.toggle('cursor', Number(row.dataset.i) === cursor);
  listEl.querySelector(`${ROW}.cursor`)?.scrollIntoView({ block: 'nearest' });
}

function selectFirst() {
  const first = items.findIndex(i => i.kind !== ITEM.section);
  if (first >= 0) openItem(first);
  else showNothing();
}

/**
 * Opens a row: a file's diff, a commit, a branch; a section folds.
 * @param {number} i
 */
function openItem(i) {
  const item = items[i];
  if (!item) return;
  cursor = i;
  if (item.kind === ITEM.section) {
    if (item.fixed) return markCursor();
    collapsedSections.has(item.key) ? collapsedSections.delete(item.key) : collapsedSections.add(item.key);
    renderList();
    return;
  }
  if (item.kind === ITEM.more) return loadHistory();
  if (item.kind === ITEM.showAll) {
    setView(item.view);
    cursor = -1;
    return renderList();
  }
  if (item.kind === ITEM.moreCode) return searchCode(/** @type {RepoStatus} */ (repo).root, ask, searchChanged);
  if (item.kind === ITEM.status) return markCursor();
  if (item.kind === ITEM.file) showFile(item);
  else if (item.kind === ITEM.commit) showCommit(item.commit.hash);
  else if (item.kind === ITEM.branch) showBranch(item.branch);
  else openHit(item);
  if (selection) selection.hit = hitKey(/** @type {any} */ (item));
  renderList();
}

/**
 * Opens a search's hit: a changed file at the line found (the whole file, so an unchanged line shows too), a commit
 * at the file whose code matched, a tag's commit.
 * @param {ListItem} item
 */
function openHit(item) {
  if (item.kind === ITEM.fileHit) {
    const { path, side, conflict, line } = item.hit;
    showFile({ path, side, conflict }, { find: { line, wholeFile: line > 0 } });
  } else if (item.kind === ITEM.commitHit) {
    showCommit(item.hit.commit.hash, { path: item.hit.lines[0]?.path ?? null });
  } else if (item.kind === ITEM.tag) {
    showCommit(item.tag.hash);
  }
}

// ---- Searching ----

/** Redraws after the search's answers (or its start). */
function searchChanged() {
  if (!isOpen()) return;
  renderTabs();
  renderList();
}

/** Searches a moment after the last key; an empty box ends the search at once. */
const searchLater = debounce(() => {
  if (!isOpen() || !repo) return;
  cursor = -1;
  if (!searching()) {
    // What the tab showed has nothing to do with the search.
    selection = null;
    showNothing();
  }
  runSearch(searchEl.value.trim(), repo.root, ask, searchChanged);
}, SEARCH_DELAY);

searchEl.addEventListener('input', () => {
  if (searchEl.value.trim()) {
    searchLater();
    return;
  }
  searchLater.cancel();
  endSearch();
  showTab();
});

/** Ends the search: the box empties and the tab's own list comes back (the caller draws it). */
function endSearch() {
  searchLater.cancel();
  clearSearch();
  searchEl.value = '';
  selection = null;
  cursor = -1;
  renderTabs();
}

/** The open tab's list again, after a search. */
function showTab() {
  showNothing();
  if (tab === GIT_TAB.changes) {
    renderList();
    selectFirst();
  } else if (tab === GIT_TAB.history && commits.length) {
    renderList();
    openItem(0);
  } else {
    refresh();
  }
}

/** @param {number} by */
function stepSearchView(by) {
  stepView(by);
  cursor = -1;
  renderList();
}

filtersEl.addEventListener('click', e => {
  const chip = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-search-view]'));
  if (!chip) return;
  setView(/** @type {string} */ (chip.dataset.searchView));
  cursor = -1;
  renderList();
});

searchEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault();
    listEl.focus();
    if (searchEl.value.trim() && searchEl.value.trim() !== found.text && repo) {
      // Enter before the search started: it starts now (its rows open as usual once they're in).
      searchLater.cancel();
      runSearch(searchEl.value.trim(), repo.root, ask, searchChanged);
      return;
    }
    const first = items.findIndex(i => PREVIEWED.has(i.kind));
    if (first >= 0) openItem(first);
  } else if (e.key === 'Tab' && searching()) {
    e.preventDefault();
    stepSearchView(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape' && searchEl.value) {
    // The first Escape ends the search; the next one closes the window.
    e.preventDefault();
    e.stopPropagation();
    endSearch();
    showTab();
  }
});

// ---- History and branches ----

async function loadHistory() {
  try {
    const page = await ask(PAGE.gitviewLog,
      { root: /** @type {RepoStatus} */ (repo).root, skip: commits.length, limit: HISTORY_PAGE });
    commits.push(...page);
    historyDone = page.length < HISTORY_PAGE;
  } catch (e) {
    rightEl.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
    historyDone = true;
  }
  renderList();
  if (!selection && commits.length) openItem(0);
}

async function loadBranches() {
  try {
    branches = await ask(PAGE.gitviewBranches, { root: /** @type {RepoStatus} */ (repo).root });
  } catch (e) {
    branches = [];
    rightEl.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
  }
  renderList();
  if (!selection) selectFirst();
}

// History loads its next page as its end comes near.
listEl.addEventListener('scroll', () => {
  if (tab !== GIT_TAB.history || historyDone || loadingMore) return;
  if (listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - LOAD_MORE_PX) {
    loadingMore = true;
    loadHistory().finally(() => { loadingMore = false; });
  }
});
let loadingMore = false;

// ---- The right side ----

function showNothing() {
  rightEl.innerHTML = '';
}

/**
 * A file's diff: staged, unstaged or untracked (Changes), or in a commit.
 * @param {ShownFile} item
 * @param {{ keepScroll?: boolean, inCommit?: string | null, find?: Find | null }} [options]
 */
async function showFile(item, { keepScroll = false, inCommit = null, find: hit = null } = {}) {
  selection = inCommit ? selection : { kind: ITEM.file, side: item.side, path: item.path };
  const request = { root: /** @type {RepoStatus} */ (repo).root, path: item.path, oldPath: item.oldPath ?? null, side: inCommit ? SIDE.commit : item.side, hash: inCommit };
  const scroll = keepScroll ? rightEl.querySelector(DIFF_SCROLL)?.scrollTop ?? 0 : 0;
  const target = inCommit ? rightEl.querySelector('.gw-commit-diff') : rightEl;
  if (!target) return;
  if (!keepScroll) target.innerHTML = '<div class="gw-message">Loading</div>';
  /** @type {GitDiff} */
  let data;
  try {
    data = await ask(PAGE.gitviewDiff, request);
  } catch (e) {
    target.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
    return;
  }
  // A refresh keeps how the file was shown, and what was found in it.
  const shown = keepScroll ? diffState?.find ?? null : hit;
  diffState = { request, data, expanded: new Set(), target, label: inCommit ? null : sideLabel(item), find: shown };
  const at = drawDiff();
  if (scroll) find(target, DIFF_SCROLL).scrollTop = scroll;
  else at?.scrollIntoView({ block: 'center' });
}

/** @param {ShownFile} item */
const sideLabel = item => item.conflict ? CONFLICT_LABEL : /** @type {Record<string, string>} */ (
  { staged: 'Staged', unstaged: 'Not staged', untracked: 'Untracked' })[/** @type {string} */ (item.side)];

/**
 * Draws the diff in hand (diffState). While searching, what was found is marked: the result is where to scroll.
 * @returns {Element | null}
 */
function drawDiff() {
  const { data, expanded, target, label, find: hit } = /** @type {DiffState} */ (diffState);
  const wholeFile = !!hit?.wholeFile;
  const sideBySide = state.settings.changes.layout === changeLayout.sideBySide && !wholeFile;
  // A file whose lines didn't change (a rename, a mode change) is shown as it is rather than folded away whole.
  const unchanged = data.kind === CHANGE_KIND.modified && data.ops?.length === 1 && data.ops[0][0] === 0;
  const whole = unchanged || ((data.kind === CHANGE_KIND.created || data.kind === CHANGE_KIND.deleted) && state.settings.changes.newFile !== changeNewFile.diff);
  const message = data.error ?? (data.note && data.before == null && data.after == null ? data.note
    : !data.ops?.length && (data.before || data.after) == null ? 'The file is empty.' : null);
  const head = `<div class="gw-diff-head">${label ? `<span class="gw-side-label">${escapeHtml(label)}</span>` : ''}`
    + `<span class="gw-diff-path" title="${escapeHtml(data.path)}">${escapeHtml(data.display ?? data.path)}</span>`
    + `${data.kind !== CHANGE_KIND.modified ? `<span class="pv-badge" data-kind="${data.kind}">${data.kind === CHANGE_KIND.created ? 'new' : data.kind}</span>` : ''}`
    + `<span class="pv-stats">${data.added || data.removed ? `<span class="pv-plus">+${data.added}</span> <span class="pv-minus">−${data.removed}</span>` : ''}</span></div>`;
  if (message) {
    target.innerHTML = `${head}<div class="gw-message">${escapeHtml(message)}</div>`;
    return null;
  }
  let rows = buildDiffRows(data, { mode: wholeFile ? changeView.file : changeView.diff, expanded, whole });
  const notes = [];
  if (unchanged) notes.push(/** @type {DiffState} */ (diffState).request.oldPath ? 'Renamed; its lines are the same.' : 'Its lines are the same.');
  if (data.note) notes.push(data.note);
  if (data.eolOnly) notes.push('Only line endings changed.');
  if (rows.plain) notes.push('Too big to colour quickly, so it’s shown plain.');
  if (rows.length > MAX_ROWS) {
    notes.push(`Showing the first ${MAX_ROWS.toLocaleString()} of ${rows.length.toLocaleString()} lines.`);
    rows = rows.slice(0, MAX_ROWS);
  }
  target.innerHTML = `${head}${notes.length ? `<div class="pv-note">${escapeHtml(notes.join(' '))}</div>` : ''}`
    + `<div class="pv-scroll gw-diff${sideBySide && !whole ? ' sbs' : ''}"><div class="pv-rows">${rows.map(diffRowHtml).join('')}</div></div>`;
  return hit && searching() ? markInDiff(target, hit.line) : null;
}

// A folded run of unchanged lines opens on a click.
rightEl.addEventListener('click', e => {
  const fold = /** @type {HTMLElement | null} */ (targetOf(e).closest('.pv-fold, .pv-delmark'));
  if (fold && diffState && diffState.target.contains(fold)) {
    diffState.expanded.add(/** @type {string} */ (fold.dataset.key));
    const scroll = find(diffState.target, DIFF_SCROLL).scrollTop;
    drawDiff();
    find(diffState.target, DIFF_SCROLL).scrollTop = scroll;
    return;
  }
  const file = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-commit-file]'));
  if (file) {
    for (const el of rightEl.querySelectorAll('[data-commit-file]')) el.classList.toggle('selected', el === file);
    const f = currentCommit?.files[Number(file.dataset.commitFile)];
    if (f) showFile(f, { inCommit: /** @type {CommitDetail} */ (currentCommit).hash, find: searching() ? { line: 0, wholeFile: false } : null });
    return;
  }
  const copy = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-copy]'));
  if (copy) {
    navigator.clipboard.writeText(/** @type {string} */ (copy.dataset.copy));
    copy.textContent = COPIED_LABEL;
    setTimeout(() => { copy.textContent = COPY_LABEL; }, COPIED_MS);
    return;
  }
  if (targetOf(e).closest('[data-switch-branch]') && selection?.kind === ITEM.branch) {
    act(GIT_ACTION.switch, { ref: selection.ref });
    return;
  }
  const commit = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-show-commit]'));
  if (commit) showCommit(/** @type {string} */ (commit.dataset.showCommit));
});

/** @type {CommitDetail | null} */
let currentCommit = null;

/**
 * A commit: its message, author, date and parents, the files it changed, and the selected file's diff below (the
 * first, or `path`). While searching, what was found is marked.
 * @param {string} hash
 * @param {{ path?: string | null }} [options]
 */
async function showCommit(hash, { path = null } = {}) {
  selection = { kind: ITEM.commit, hash };
  rightEl.innerHTML = '<div class="gw-message">Loading</div>';
  /** @type {CommitDetail} */
  let c;
  try {
    c = await ask(PAGE.gitviewCommit, { root: /** @type {RepoStatus} */ (repo).root, hash });
  } catch (e) {
    rightEl.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
    return;
  }
  if (selection?.hash !== hash) return; // another one was picked meanwhile
  currentCommit = c;
  const [subject, ...body] = c.message.split('\n');
  const needle = found.text.toLowerCase();
  const date = new Date(c.authorDate);
  const files = c.files.map((f, i) => {
    const counts = f.added == null ? '<span class="gw-binary">binary</span>'
      : `<span class="pv-plus">+${f.added}</span> <span class="pv-minus">−${f.removed}</span>`;
    return `<div class="cw-row gw-file" data-commit-file="${i}" title="${escapeHtml(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path)}">`
      + `<span class="gw-status" data-s="${f.status}">${escapeHtml(f.status)}</span><span class="cw-name">${escapeHtml(f.path)}</span>`
      + `<span class="gw-counts">${counts}</span></div>`;
  }).join('');
  rightEl.innerHTML = `
    <div class="gw-commit-info">
      <div class="gw-commit-subject">${subject ? highlight(subject, needle) : '(no message)'}</div>
      ${body.join('\n').trim() ? `<pre class="gw-commit-body">${highlight(body.join('\n').trim(), needle)}</pre>` : ''}
      <div class="gw-commit-facts">
        <span>${highlight(c.author, needle)}</span>
        <span title="${escapeHtml(date.toString())}">${escapeHtml(date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</span>
        <span class="gw-hash">${escapeHtml(c.hash.slice(0, 12))}</span><button class="btn small" data-copy="${escapeHtml(c.hash)}" title="Copy the full hash">${COPY_LABEL}</button>
        ${c.parents.length ? `<span>Parent${c.parents.length > 1 ? 's' : ''} ${c.parents.map(p => `<button class="gw-link" data-show-commit="${escapeHtml(p)}">${escapeHtml(p.slice(0, 7))}</button>`).join(' ')}</span>` : '<span>First commit</span>'}
        ${c.committer !== c.author ? `<span>Committed by ${escapeHtml(c.committer)}</span>` : ''}
      </div>
    </div>
    <div class="gw-commit-files">${c.files.length ? files : '<div class="gw-empty">No files changed.</div>'}</div>
    <div class="gw-commit-diff"></div>`;
  // The first file (or the one asked for) opens at once.
  const at = Math.max(0, c.files.findIndex(f => f.path === path));
  const first = /** @type {HTMLElement | null} */ (rightEl.querySelector(`[data-commit-file="${at}"]`));
  if (first) first.click();
}

/**
 * A branch: where it is, how far from its upstream, and its latest commits (each opens).
 * @param {Branch} b
 */
async function showBranch(b) {
  selection = { kind: ITEM.branch, ref: b.ref };
  rightEl.innerHTML = '<div class="gw-message">Loading</div>';
  /** @type {Commit[]} */
  let list;
  try {
    list = await ask(PAGE.gitviewLog, { root: /** @type {RepoStatus} */ (repo).root, skip: 0, limit: BRANCH_LOG_COMMITS, ref: b.ref });
  } catch (e) {
    rightEl.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
    return;
  }
  if (selection?.ref !== b.ref) return;
  const facts = [
    b.current ? 'The checked-out branch' : b.remote ? 'A remote branch' : 'A local branch',
    b.upstream ? `tracking ${b.upstream}${b.gone ? ' (gone)' : b.ahead || b.behind ? `, ${b.ahead} ahead, ${b.behind} behind` : ', up to date'}` : '',
  ].filter(Boolean).join(', ');
  rightEl.innerHTML = `
    <div class="gw-commit-info">
      <div class="gw-commit-subject">${escapeHtml(b.name)}</div>
      <div class="gw-commit-facts"><span>${escapeHtml(facts)}</span>${b.current ? '' : `<button class="btn small" data-switch-branch>${escapeHtml(switchLabel(b))}</button>`}</div>
    </div>
    <div class="gw-branch-log">${list.map(c => `<div class="cw-row gw-commit" data-show-commit="${escapeHtml(c.hash)}">`
      + `<span class="gw-commit-main"><span class="gw-subject">${escapeHtml(c.subject || '(no message)')}</span>${refChips(c.refs)}</span>`
      + `<span class="gw-commit-meta"><span class="gw-hash">${escapeHtml(c.short)}</span><span>${escapeHtml(c.author)}</span><span>${ago(c.date)}</span></span></div>`).join('')}</div>`;
}

// ---- Actions (right-click a file or a branch) ----

/**
 * Runs an action on the repository (GitView.Act), then looks again. git's refusal (a switch that would overwrite
 * changes, a branch that already exists) opens in a popup, in its own words.
 * @param {string} action
 * @param {{ path?: string, ref?: string }} [extra]
 */
async function act(action, extra) {
  try {
    await ask(PAGE.gitviewAct, { root: /** @type {RepoStatus} */ (repo).root, action,
      hasCommits: /** @type {RepoStatus} */ (repo).hasCommits !== false, ...extra });
  } catch (e) {
    await showGitError(/** @type {Error} */ (e).message);
  }
  emit(EVENTS.gitChanged); // the sidebar's chips (gitstatus.js)
  await refresh();
}

/**
 * What a changed, staged, untracked or conflicted file's menu offers.
 * @param {FileItem} item
 * @returns {import('./popups.js').MenuEntry[]}
 */
function fileMenu(item) {
  const name = item.path.split('/').pop();
  const sep = server || !/** @type {RepoStatus} */ (repo).root.includes('\\') ? '/' : '\\';
  const where = /** @type {RepoStatus} */ (repo).root.replace(/[\\/]+$/, '') + sep + item.path.split('/').join(sep);
  const copy = { label: 'Copy path', action: () => navigator.clipboard.writeText(where) };
  if (item.conflict) {
    return [{ label: 'Mark as resolved', action: () => act(GIT_ACTION.stage, { path: item.path }) }, SEPARATOR, copy];
  }
  if (item.side === SIDE.staged) {
    return [
      { label: 'Unstage', action: () => act(GIT_ACTION.unstage, { path: item.path }) },
      ...(item.status !== 'A' && /** @type {RepoStatus} */ (repo).hasCommits !== false ? [{
        label: RESTORE_LABEL, danger: true,
        action: async () => {
          if (await confirmDialog({ title: `Restore ${name}?`, body: `Its staged and unsaved changes are undone, back to the last commit. This can't be undone.`, confirm: RESTORE_LABEL })) act(GIT_ACTION.discardAll, { path: item.path });
        },
      }] : []),
      SEPARATOR, copy,
    ];
  }
  if (item.side === SIDE.untracked) {
    return [
      { label: STAGE_LABEL, action: () => act(GIT_ACTION.stage, { path: item.path }) },
      { label: 'Add to .gitignore', action: () => act(GIT_ACTION.ignore, { path: item.path }) },
      {
        label: 'Delete', danger: true,
        action: async () => {
          if (await confirmDialog({ title: `Delete ${name}?`, body: `git doesn't have this file, so it can't be brought back.`, confirm: 'Delete' })) act(GIT_ACTION.delete, { path: item.path });
        },
      },
      SEPARATOR, copy,
    ];
  }
  return [
    { label: STAGE_LABEL, action: () => act(GIT_ACTION.stage, { path: item.path }) },
    {
      label: RESTORE_LABEL, danger: true,
      action: async () => {
        if (await confirmDialog({ title: `Restore ${name}?`, body: `Its changes that aren't staged are undone. This can't be undone.`, confirm: RESTORE_LABEL })) act(GIT_ACTION.discard, { path: item.path });
      },
    },
    SEPARATOR, copy,
  ];
}

/**
 * Switching to a branch: a remote one becomes a local branch that tracks it.
 * @param {Branch} b
 */
const switchLabel = b => (b.remote ? `Switch to ${b.name.replace(/^[^/]+\//, '')} (tracking ${b.name})` : `Switch to ${b.name}`);

/**
 * @param {Branch} b
 * @returns {import('./popups.js').MenuEntry[]}
 */
function branchMenu(b) {
  return [{ label: switchLabel(b), action: () => act(GIT_ACTION.switch, { ref: b.ref }) }];
}

listEl.addEventListener('contextmenu', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
  const item = row && items[Number(row.dataset.i)];
  if (!item || (item.kind !== ITEM.file && item.kind !== ITEM.branch)
    || /** @type {{ branch?: Branch }} */ (item).branch?.current) return;
  e.preventDefault();
  openItem(Number(/** @type {HTMLElement} */ (row).dataset.i));
  showMenu(item.kind === ITEM.file ? fileMenu(item) : branchMenu(item.branch), { x: e.clientX, y: e.clientY }, { className: 'git-menu' });
});

/**
 * git's own words when an action failed, in a popup over the window; the window keeps the keyboard after.
 * @param {string} text
 */
async function showGitError(text) {
  await modal('git-error', `
    <h3>Git didn't do that</h3>
    <pre class="git-error-text">${escapeHtml(text)}</pre>
    <div class="dialog-actions"><button class="btn primary" data-ok autofocus>OK</button></div>`, (dialog, close) => {
    return { submit: () => close(true) };
  });
  listEl.focus();
}

// ---- Clicks and keys ----

listEl.addEventListener('click', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
  if (row) openItem(Number(row.dataset.i));
});

listEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = cursor + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= items.length) return;
    cursor = next;
    // Moving onto a file or a commit shows it, as in a file explorer's preview.
    if (PREVIEWED.has(items[next].kind)) openItem(next); else markCursor();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openItem(cursor);
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    openItem(e.key === 'Home' ? 0 : items.length - 1);
  } else if (e.key === 'Tab' && searching()) {
    e.preventDefault();
    stepSearchView(e.shiftKey ? -1 : 1);
  } else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    // Typing goes to the search box (the key lands there).
    searchEl.focus();
  }
});

layer.addEventListener('click', e => {
  const t = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-gw-tab]'));
  if (t) return switchTab(/** @type {string} */ (t.dataset.gwTab));
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-gw]'))?.dataset.gw;
  if (action === HEAD_BUTTON.close) closeGitWindow();
  else if (action === HEAD_BUTTON.refresh) refresh();
});

layer.addEventListener('mousedown', e => {
  if (e.target === layer) closeGitWindow();
});

// Keys in the window stay in it (no app shortcuts, no terminal); Escape closes it.
layer.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault();
    closeGitWindow();
  } else if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
    e.preventDefault();
    refresh();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
  }
  e.stopPropagation();
});

resizeByGrip(find(layer, GRIP), sideEl, SIDE_MIN_PX, SIDE_MAX_PX);

// ---- Keeping up ----

/** How long after a command ends (or the window comes back) the working tree is read again. */
const REFRESH_DELAY = 600;
const refreshLater = debounce(() => refresh(), REFRESH_DELAY);
// Not while searching: the results would be searched again (code too) under the reader.
const refreshSoon = () => {
  if (isOpen() && tab === GIT_TAB.changes && !searching()) refreshLater();
};
// A command ended (a commit, a checkout, an edit) or the window came back: the working tree may have moved on.
on(EVENTS.commandEnding, refreshSoon);
addEventListener('focus', refreshSoon);
on(EVENTS.settings, () => { if (isOpen() && diffState) drawDiff(); });

/**
 * A terminal whose shell runs on a server: its folders aren't this PC's.
 * @param {Tab | null | undefined} tab
 */
export const onServer = tab => !!tab && (!!remoteGit(tab) || isSsh(tab));

/**
 * The folder to open the window on for a terminal: where it works, else its workspace's folder. None for a terminal
 * on a server, whose folder isn't on this PC (and the workspace's would be the wrong repository).
 * @param {Tab | null | undefined} tab
 * @param {Workspace | null | undefined} ws
 */
export const gitFolderOf = (tab, ws) => (onServer(tab) ? null : tab?.cwd ?? ws?.cwd ?? null);

/**
 * So other modules can open it without importing this one (they'd make a cycle through the panes).
 * @param {string | null | undefined} f
 * @param {string} [show]
 */
export const requestGit = (f, show) => emit(EVENTS.openGit, { folder: f, show });
