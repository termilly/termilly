// @ts-check
// What the Git window's tabs load and how they follow their bars and buttons (js/gitwindow.js): History by pages (of
// the branch, of every branch, or of one path), Branches with the worktrees, Issues and Local history, and the
// buttons on the right side for an issue, a snapshot or backup, and a worktree.

import { PAGE } from './protocol.js';
import { escapeHtml } from './ui.js';
import { targetOf } from './dom.js';
import { history } from './githistory.js';
import { ISSUE_ITEM, issues, loadIssues, loadMoreIssues, cantLoadIssues, issueBarHtml, stateClicked } from './gitissues.js';
import { forgetIssue, issueClicked } from './gitissueview.js';
import { whyNoGitHub } from './github.js';
import { LOCAL_ITEM, local, loadLocal, localClicked } from './gitlocal.js';
import { WORKTREE_ITEM, worktreeClicked, openPrune } from './gitcleanup.js';
import { gw, ui, ask, repoNow, GIT_TAB } from './gitwindowstate.js';
import { els, isOpen, showNothing } from './gitwindowparts.js';
import { issueContext, localContext } from './gitcontexts.js';
import { renderList, openItem, selectFirst } from './gitlist.js';

/** Commits read at a time in History. */
const HISTORY_PAGE = 100;
/** How near the side list's end (in pixels) History's scroll gets before its next page loads. */
const LOAD_MORE_PX = 200;
const { listEl, rightEl, historyBarEl, issueBarEl } = els;

/** History's next page; the first one opens its newest commit. */
export async function loadHistory() {
  const loading = gw.commits;
  try {
    const page = await ask(PAGE.gitviewLog, {
      root: repoNow().root, skip: gw.commits.length, limit: HISTORY_PAGE, all: history.all, path: history.path ?? undefined,
    });
    if (loading !== gw.commits) return; // History started again meanwhile (All branches, another path)
    gw.commits.push(...page);
    gw.historyDone = page.length < HISTORY_PAGE;
  } catch (e) {
    rightEl.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
    gw.historyDone = true;
  }
  renderList();
  if (!gw.selection && gw.commits.length) openItem(0);
}

/** History again from its start: All branches switched, or another path's history picked. */
async function reloadHistory() {
  gw.commits = [];
  gw.historyDone = false;
  gw.selection = null;
  gw.cursor = -1;
  showNothing();
  if (gw.tab !== GIT_TAB.history) return ui.switchTab(GIT_TAB.history);
  ui.renderTabs();
  await loadHistory();
}

/**
 * A file's or a folder's history, in History.
 * @param {string} path
 */
export function showPathHistory(path) {
  history.path = path;
  reloadHistory();
}

historyBarEl.addEventListener('change', e => {
  const box = /** @type {HTMLInputElement} */ (e.target);
  if (!box.matches('[data-history-all]')) return;
  history.all = box.checked;
  reloadHistory();
});

historyBarEl.addEventListener('click', e => {
  if (targetOf(e).closest('[data-prune]')) return void openPrune(localContext());
  if (!targetOf(e).closest('[data-history-whole]')) return;
  history.path = null;
  reloadHistory();
});

// History and Issues load their next page as their end comes near.
listEl.addEventListener('scroll', () => {
  if (listEl.scrollTop + listEl.clientHeight <= listEl.scrollHeight - LOAD_MORE_PX) return;
  if (gw.tab === GIT_TAB.issues) return void moreIssues();
  if (gw.tab !== GIT_TAB.history || gw.historyDone || gw.loadingMore) return;
  gw.loadingMore = true;
  loadHistory().finally(() => { gw.loadingMore = false; });
});

/** Branches, with the repository's worktrees. */
export async function loadBranches() {
  try {
    const { root } = repoNow();
    [gw.branches, gw.worktrees] = await Promise.all([ask(PAGE.gitviewBranches, { root }), ask(PAGE.gitviewWorktrees, { root }).catch(() => [])]);
  } catch (e) {
    gw.branches = [];
    rightEl.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
  }
  renderList();
  if (!gw.selection) selectFirst();
}

/** Opens the row of the list whose item this is, else the first. @param {(item: import('./gitwindowstate.js').ListItem) => boolean} is */
function reopen(is) {
  const at = gw.items.findIndex(is);
  if (at >= 0) openItem(at); else selectFirst();
}

/** The Issues tab: the state filter over the list, the issues loaded, the one picked (or the first) shown. */
export async function showIssuesTab() {
  issueBarEl.innerHTML = issueBarHtml();
  if (gw.github && !gw.github.available) {
    cantLoadIssues(whyNoGitHub(gw.github));
    return renderList();
  }
  if (!issues.loaded) {
    renderList();
    if (!await loadIssues(issueContext())) return; // a newer loading draws instead
  }
  if (gw.tab !== GIT_TAB.issues || !isOpen()) return;
  issueBarEl.innerHTML = issueBarHtml(); // with how many there are
  renderList();
  reopen(i => i.kind === ISSUE_ITEM.issue && i.issue.number === gw.selection?.number);
}

/** The Local history tab: what was kept, loaded once a window opening (Refresh and changes load it again). */
export async function showLocalTab() {
  if (!local.loaded) {
    renderList();
    if (!await loadLocal(localContext())) return; // a newer loading draws instead
  }
  if (gw.tab !== GIT_TAB.local || !isOpen()) return;
  renderList();
  reopen(i => (i.kind === LOCAL_ITEM.snapshot && i.snapshot.id === gw.selection?.id) || (i.kind === LOCAL_ITEM.backup && i.backup.id === gw.selection?.id));
}

/** The snapshot or backup the right side shows, in the Local history tab. */
function shownLocal() {
  const sel = gw.selection;
  if (sel?.kind === LOCAL_ITEM.snapshot) return { snapshot: local.snapshots.find(s => s.id === sel.id) };
  if (sel?.kind === LOCAL_ITEM.backup) return { backup: local.backups.find(b => b.id === sel.id) };
  return null;
}

/** Issues' next page, onto the list: its last row says it's loading meanwhile. */
async function moreIssues() {
  const loading = loadMoreIssues(issueContext());
  renderList();
  await loading;
  if (gw.tab === GIT_TAB.issues && isOpen()) renderList();
}

/** Issues from their first page again, for another state or other search words. */
async function reloadIssues() {
  if (!gw.repo) return;
  Object.assign(issues, { list: [], more: false, loaded: false });
  gw.selection = null;
  gw.cursor = -1;
  forgetIssue(); // the issue on its way was the other list's
  showNothing();
  await showIssuesTab();
}

// The Issues tab's state filter (the list again, in that state).
issueBarEl.addEventListener('click', e => {
  if (stateClicked(e)) reloadIssues();
});

// The right side's buttons for a snapshot or backup, a worktree, and an issue (GitHub changed: the list and the issue again).
rightEl.addEventListener('click', e => {
  if (gw.tab === GIT_TAB.local && localClicked(e, shownLocal(), localContext())) return;
  const sel = gw.selection;
  if (sel?.kind === WORKTREE_ITEM && worktreeClicked(targetOf(e), gw.worktrees.find(w => w.path === sel.path), localContext())) return;
  if (gw.tab !== GIT_TAB.issues || !gw.repo) return;
  issueClicked(e, async () => {
    await loadIssues(issueContext());
    issueBarEl.innerHTML = issueBarHtml();
    renderList();
    reopen(i => i.kind === ISSUE_ITEM.issue && i.issue.number === gw.selection?.number);
  });
});

Object.assign(ui, { loadMoreIssues: moreIssues, reloadIssues });
