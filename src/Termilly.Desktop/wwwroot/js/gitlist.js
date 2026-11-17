// @ts-check
// The Git window's side list (js/gitwindow.js): each tab's rows (Changes' sections and files, History's commits,
// Branches and worktrees, Local history, Issues, Agent changes) or the search's, the row the keyboard is on, and
// opening a row on the right: a file's diff, a commit, a branch, an issue, a snapshot, a worktree.

import { escapeHtml, highlight } from './ui.js';
import {
  ITEM, found, searching, searchCode, searchItems, searchEmptyText, searchRowHtml, filtersHtml, setView, hitKey, ago,
} from './gitsearch.js';
import { AGENT_ITEM, agent, agentItems, agentRowHtml, agentEmptyText, toggleFolder, showAgentFile } from './gitagent.js';
import { samePath } from './changetree.js';
import { ISSUE_ITEM, issueItems, issuesEmptyText, issueRowHtml, showIssue } from './gitissues.js';
import { LOCAL_ITEM, localItems, localEmptyText, localRowHtml, snapshotHtml, backupHtml } from './gitlocal.js';
import { WORKTREE_ITEM, worktreeRowHtml, worktreeHtml } from './gitcleanup.js';
import { historyRowHtml } from './githistory.js';
import { checkDotHtml } from './gitchecks.js';
import { gw, ui, ask, repoNow, GIT_TAB } from './gitwindowstate.js';
import { els, isOpen, useRight, showNothing, ROW, SIDE, CHEVRON, CONFLICT_LABEL } from './gitwindowparts.js';
import { issueContext } from './gitcontexts.js';
import { showFile } from './gitdiffview.js';
import { showCommit, showBranch } from './gitdetails.js';

/** @typedef {import('./gitwindowstate.js').ListItem} ListItem */
/** @typedef {import('./gitwindowstate.js').Branch} Branch */

const { listEl, filtersEl, rightEl } = els;
/** The Branches tab's sections. */
const BRANCH_GROUP = Object.freeze({ current: 'Current', local: 'Local', remote: 'Remote' });
/** @type {Record<string, string>} */
const STATUS_TITLE = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked' };

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

/** The Changes tab's rows: each section's heading and, unless it's folded, its files. */
export function changeItems() {
  /** @type {ListItem[]} */
  const out = [];
  for (const [key, label, side] of SECTIONS) {
    const files = gw.repo?.[key] ?? [];
    if (!files.length) continue;
    out.push({ kind: ITEM.section, key, label, count: files.length });
    if (gw.collapsedSections.has(key)) continue;
    for (const f of files) out.push({ kind: ITEM.file, side: side === SIDE.conflict ? SIDE.unstaged : side, path: f.path, oldPath: f.oldPath, status: side === SIDE.untracked ? 'U' : f.status, conflict: side === SIDE.conflict });
  }
  return out;
}

/** The Branches tab's rows: the current branch, then local ones, then remote ones, then worktrees, each under its heading. */
function branchItems() {
  /** @type {ListItem[]} */
  const out = [];
  const { branches, worktrees } = gw;
  /** @type {Array<[string, Branch[]]>} */
  const groups = [[BRANCH_GROUP.current, branches.filter(b => b.current)], [BRANCH_GROUP.local, branches.filter(b => !b.current && !b.remote)], [BRANCH_GROUP.remote, branches.filter(b => b.remote)]];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    out.push({ kind: ITEM.section, key: `b-${label}`, label, count: list.length, fixed: true });
    for (const b of list) out.push({ kind: ITEM.branch, branch: b });
  }
  // Worktrees once there's more than the repository's own folder.
  if (worktrees.length > 1) {
    out.push({ kind: ITEM.section, key: 'b-worktrees', label: 'Worktrees', count: worktrees.length, fixed: true });
    for (const w of worktrees) out.push({ kind: WORKTREE_ITEM, worktree: w });
  }
  return out;
}

/** The open tab's rows (or the search's), and what the list says with none. @returns {[ListItem[], string]} */
function rowsNow() {
  if (searching()) return [/** @type {ListItem[]} */ (searchItems()), searchEmptyText()];
  switch (gw.tab) {
    case GIT_TAB.agent: return [/** @type {ListItem[]} */ (agentItems()), escapeHtml(agentEmptyText())];
    case GIT_TAB.changes: return [changeItems(), gw.repo?.hasCommits === false ? 'No commits yet, and nothing to add.' : 'Nothing to commit: the working tree is clean.'];
    case GIT_TAB.issues: return [issueItems(), escapeHtml(issuesEmptyText())];
    case GIT_TAB.local: return [localItems(), escapeHtml(localEmptyText())];
    case GIT_TAB.history: {
      /** @type {ListItem[]} */
      const rows = gw.commits.map(c => ({ kind: ITEM.commit, commit: c }));
      if (!gw.historyDone && gw.commits.length) rows.push({ kind: ITEM.more });
      return [rows, 'No commits yet.'];
    }
    default: return [branchItems(), 'No branches yet.'];
  }
}

/** Draws the side list: the open tab's rows, or the search's. */
export function renderList() {
  filtersEl.hidden = !searching();
  if (searching()) filtersEl.innerHTML = filtersHtml();
  const [rows, empty] = rowsNow();
  gw.items = rows;
  if (!rows.length) {
    listEl.innerHTML = `<div class="gw-empty">${empty}</div>`;
    return;
  }
  listEl.innerHTML = rows.map((item, i) => rowHtml(item, i)).join('');
  markCursor();
}

/**
 * A changed file's row.
 * @param {import('./gitwindowstate.js').FileItem} item
 * @param {number} i
 */
function fileRowHtml(item, i) {
  const slash = item.path.lastIndexOf('/');
  const name = item.path.slice(slash + 1);
  const dir = slash > 0 ? item.path.slice(0, slash) : '';
  const letter = item.conflict ? '!' : item.status;
  const title = item.conflict ? CONFLICT_LABEL : STATUS_TITLE[item.status] ?? item.status;
  const sel = gw.selection?.kind === ITEM.file && gw.selection.side === item.side && gw.selection.path === item.path;
  return `<div class="cw-row gw-file${sel ? ' selected' : ''}" data-i="${i}" role="option" title="${escapeHtml(item.oldPath ? `${item.oldPath} → ${item.path}` : item.path)}">`
    + `<span class="gw-status" data-s="${item.conflict ? SIDE.conflict : item.status}" title="${title}">${escapeHtml(letter)}</span>`
    + `<span class="cw-name">${escapeHtml(name)}</span><span class="gw-dir">${escapeHtml(item.oldPath ? `from ${item.oldPath}` : dir)}</span></div>`;
}

/**
 * A branch's row.
 * @param {Branch} b
 * @param {number} i
 */
function branchRowHtml(b, i) {
  const sel = gw.selection?.kind === ITEM.branch && gw.selection.ref === b.ref;
  const ab = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : '', b.gone ? 'upstream gone' : ''].filter(Boolean).join(' ');
  return `<div class="cw-row gw-commit gw-branch-row${sel ? ' selected' : ''}" data-i="${i}" role="option">`
    + `<span class="gw-commit-main"><span class="gw-subject${b.current ? ' current' : ''}">${highlight(b.name, found.text.toLowerCase())}</span>${ab ? `<span class="gw-ab">${ab}</span>` : ''}</span>`
    + `<span class="gw-commit-meta"><span class="gw-hash">${escapeHtml(b.short)}</span><span>${escapeHtml(b.subject)}</span><span>${ago(b.date)}</span></span></div>`;
}

/**
 * @param {ListItem} item
 * @param {number} i
 */
function rowHtml(item, i) {
  const sel = gw.selection;
  const hit = searchRowHtml(item, i, !!sel?.hit && sel.hit === hitKey(/** @type {any} */ (item))) ?? agentRowHtml(item, i);
  if (hit !== null) return hit;
  if (item.kind === LOCAL_ITEM.snapshot || item.kind === LOCAL_ITEM.backup || item.kind === LOCAL_ITEM.heading) {
    return localRowHtml(item, i, !!sel?.id && sel.id === (item.kind === LOCAL_ITEM.snapshot ? item.snapshot.id : item.kind === LOCAL_ITEM.backup ? item.backup.id : null));
  }
  if (item.kind === WORKTREE_ITEM) return worktreeRowHtml(item.worktree, i, sel?.kind === WORKTREE_ITEM && sel.path === item.worktree.path);
  if (item.kind === ISSUE_ITEM.issue) return issueRowHtml(item, i, sel?.kind === ISSUE_ITEM.issue && sel.number === item.issue.number);
  if (item.kind === ITEM.section) {
    const open = item.fixed || !gw.collapsedSections.has(item.key);
    return `<div class="cw-row gw-section${open ? ' open' : ''}" data-i="${i}"><span class="cw-chev">${item.fixed ? '' : CHEVRON}</span><span class="cw-name">${escapeHtml(item.label)}</span><span class="cw-count">${item.count}</span></div>`;
  }
  if (item.kind === ITEM.file) return fileRowHtml(item, i);
  if (item.kind === ITEM.commit) {
    const at = gw.commits.indexOf(item.commit);
    return historyRowHtml(gw.commits, at, i, sel?.kind === ITEM.commit && sel.hash === item.commit.hash, checkDotHtml(item.commit.hash));
  }
  if (item.kind === ITEM.branch) return branchRowHtml(item.branch, i);
  return `<div class="cw-row gw-more" data-i="${i}">Load more commits</div>`;
}

export function markCursor() {
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (listEl.querySelectorAll(ROW))) row.classList.toggle('cursor', Number(row.dataset.i) === gw.cursor);
  listEl.querySelector(`${ROW}.cursor`)?.scrollIntoView({ block: 'nearest' });
}

export function selectFirst() {
  const first = gw.items.findIndex(i => i.kind !== ITEM.section);
  if (first >= 0) openItem(first);
  else showNothing();
}

/** Redraws after the search's answers (or its start). */
export function searchChanged() {
  if (!isOpen()) return;
  ui.renderTabs();
  renderList();
}

/** The keyboard on the Agent changes' selected file's row. */
export function cursorOnAgentFile() {
  const at = gw.items.findIndex(i => i.kind === AGENT_ITEM.file && samePath(i.file.path, agent.selected));
  if (at >= 0) {
    gw.cursor = at;
    markCursor();
  }
}

/**
 * A row that changes the list rather than the right side (a section folds, more commits, a search's view, an Agent
 * changes' folder); true when it was one.
 * @param {ListItem} item
 */
function listRow(item) {
  if (item.kind === ITEM.section) {
    if (item.fixed) return markCursor(), true;
    const folded = gw.collapsedSections;
    folded.has(item.key) ? folded.delete(item.key) : folded.add(item.key);
    return renderList(), true;
  }
  if (item.kind === ITEM.more) return ui.loadHistory(), true;
  if (item.kind === ITEM.showAll) {
    setView(item.view);
    gw.cursor = -1;
    return renderList(), true;
  }
  if (item.kind === ITEM.moreCode) return searchCode(repoNow().root, ask, searchChanged), true;
  if (item.kind === ITEM.status || item.kind === LOCAL_ITEM.heading) return markCursor(), true;
  if (item.kind === AGENT_ITEM.folder) return toggleFolder(item.folder), renderList(), true;
  if (item.kind === AGENT_ITEM.file) return showAgentFile(item.file.path), renderList(), true;
  return false;
}

/**
 * Opens a row: a file's diff, a commit, a branch, an issue, a snapshot, a worktree; a section folds.
 * @param {number} i
 */
export function openItem(i) {
  const item = gw.items[i];
  if (!item) return;
  gw.cursor = i;
  if (listRow(item)) return;
  if (item.kind === WORKTREE_ITEM) {
    useRight(false);
    gw.selection = { kind: WORKTREE_ITEM, path: item.worktree.path };
    rightEl.innerHTML = worktreeHtml(item.worktree, !!gw.server);
    return renderList();
  }
  if (item.kind === LOCAL_ITEM.snapshot || item.kind === LOCAL_ITEM.backup) {
    useRight(false);
    gw.selection = { kind: item.kind, id: item.kind === LOCAL_ITEM.snapshot ? item.snapshot.id : item.backup.id };
    rightEl.innerHTML = item.kind === LOCAL_ITEM.snapshot ? snapshotHtml(item.snapshot) : backupHtml(item.backup);
  } else if (item.kind === ISSUE_ITEM.issue) {
    useRight(false);
    gw.selection = { kind: ISSUE_ITEM.issue, number: item.issue.number };
    showIssue(rightEl, item.issue.number, issueContext());
  } else if (item.kind === ITEM.file) showFile(item);
  else if (item.kind === ITEM.commit) showCommit(item.commit.hash);
  else if (item.kind === ITEM.branch) showBranch(item.branch);
  else openHit(item);
  if (gw.selection) gw.selection.hit = hitKey(/** @type {any} */ (item));
  renderList();
}

/**
 * Opens a search's hit: a changed file at the line found (the whole file, so an unchanged line shows too), a commit
 * at the file whose code matched, a tag's commit.
 * @param {ListItem} item
 */
function openHit(item) {
  if (item.kind === ITEM.agentHit) {
    gw.selection = { kind: ITEM.agentHit };
    useRight(true);
    showAgentFile(item.hit.path, { line: item.hit.line || null });
  } else if (item.kind === ITEM.fileHit) {
    const { path, side, conflict, line } = item.hit;
    showFile({ path, side, conflict }, { find: { line, wholeFile: line > 0 } });
  } else if (item.kind === ITEM.commitHit) {
    showCommit(item.hit.commit.hash, { path: item.hit.lines[0]?.path ?? null });
  } else if (item.kind === ITEM.tag) {
    showCommit(item.tag.hash);
  }
}
