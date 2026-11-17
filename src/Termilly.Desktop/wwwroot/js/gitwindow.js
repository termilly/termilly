// @ts-check
// The Git window: a repository's working tree (staged, changed, untracked and conflicted files), any file's diff,
// its history and its branches, its local history, its issues on GitHub, and the files Claude changed in the
// terminal it was opened from (Agent changes, js/gitagent.js). The host runs git (GitView.cs); this draws it. It opens
// from a branch chip in the sidebar, the workspace and terminal menus, the toolbar, the palette, Ctrl+Shift+G, and a
// terminal's changed files (Ctrl+Shift+D, "Show all", the preview's Git button), and follows the repository while
// it's open: after a command ends, when the window gets focus, and on Refresh. Outside a repository it shows only a
// terminal's Agent changes.
// This module opens and closes it, reads the repository, and draws its head and tabs; its parts are in
// gitwindowstate.js (what it shows), gitwindowparts.js (its markup), gitlist.js, gitdiffview.js, gitdetails.js,
// gitloaders.js, gitactions.js, gitsearchui.js and gitwindowkeys.js.

import { PAGE } from './protocol.js';
import { state, on, emit, isSsh, wsById, tabTitle, EVENTS } from './store.js';
import { debounce } from './util.js';
import { restoreFocus } from './panes.js';
import { closeAll } from './popups.js';
import { escapeHtml } from './ui.js';
import { remoteGit } from './remotehost.js';
import { find } from './dom.js';
import { history, historyBarHtml } from './githistory.js';
import { resetLocal } from './gitlocal.js';
import { checks, loadChecks, resetChecks } from './gitchecks.js';
import { ITEM, found, searching, clearSearch, runSearch } from './gitsearch.js';
import { agent, startAgent, agentCount, showAgentFile, showFirstAgentFile, keepAgentFile } from './gitagent.js';
import { samePath } from './changetree.js';
import { gitHubOf, forgetGitHub, askGitHub } from './github.js';
import { issues, resetIssues } from './gitissues.js';
import { forgetIssue } from './gitissueview.js';
import { commitBoxHtml, wireCommitBox, followStaged, headActionsHtml, canOpenPullRequest } from './gitwrite.js';
import { gw, ui, ask, repoNow, changeCount, GIT_TAB } from './gitwindowstate.js';
import {
  els, frame, isOpen, showTitle, useRight, showNothing, onGitHub, GIT_TITLE, AGENT_TITLE, SEARCH_REPO, SEARCH_AGENT, SEARCH_ISSUES,
} from './gitwindowparts.js';
import { writeContext } from './gitcontexts.js';
import { showFile } from './gitdiffview.js';
import { changeItems, renderList, selectFirst, searchChanged, cursorOnAgentFile } from './gitlist.js';
import { loadHistory, loadBranches, showIssuesTab, showLocalTab } from './gitloaders.js';
import { searchScope, endSearch } from './gitsearchui.js';
import './gitactions.js'; // the file and branch menus
import './gitwindowkeys.js'; // the window's clicks and keys

export { GIT_TAB } from './gitwindowstate.js';
export { GIT_BUTTON_ID } from './gitwindowparts.js';

/** @typedef {import('./gitwindowstate.js').FileItem} FileItem */

/** The Branches tab's bar: tidying branches up. */
const PRUNE_BUTTON = '<button class="btn small" data-prune title="Delete branches whose work is done, with Undo">Clean up branches</button>';
/** How long after a command ends (or the window comes back) the working tree is read again. */
const REFRESH_DELAY = 600;
/** What the side list is called, by tab, for screen readers. */
const LIST_LABEL = Object.freeze({ agent: 'Files Claude changed', changes: 'Changed files', history: 'Commits', branches: 'Branches', local: 'Local history', issues: 'Issues' });
const { box, repoEl, branchEl, searchEl, listEl, rightEl, actionsEl, issueBarEl, historyBarEl, commitBoxEl } = els;

/**
 * Asks, beside git and without holding it up, whether the repository is on GitHub (once a window opening) and
 * whether the branch has a pull request (only one that could); then the head and the tabs show what it said.
 */
async function loadGitHub() {
  if (gw.server || !gw.repo) return;
  const { root, branch } = gw.repo;
  const asked = gw.opening;
  // The same window opening, repository and branch: else the answer is for what was there before.
  const still = () => asked === gw.opening && gw.repo?.root === root && gw.repo.branch === branch;
  const status = await gitHubOf(root);
  if (!still()) return;
  gw.github = status;
  // The checks on the latest commits, for History's dots: once a window opening (Refresh asks again).
  if (status.available && !checks.loaded) loadChecks(root).then(fresh => { if (fresh && still() && gw.tab === GIT_TAB.history) renderList(); });
  const ctx = writeContext();
  if (ctx && status.available && gw.pullRequestOf !== (branch ?? '')) {
    gw.pullRequestOf = branch ?? '';
    const pr = canOpenPullRequest(ctx) || (!!ctx.repo.upstream && !!ctx.repo.ahead)
      ? await askGitHub(PAGE.githubPrFor, { root, branch }).catch(() => null) // only a hint
      : null;
    if (!still()) return;
    gw.pullRequest = pr;
  }
  renderHead();
  renderTabs();
}

/** Refresh (its button, F5): GitHub is asked again too, and the issues loaded anew. */
function refreshAll() {
  forgetGitHub();
  resetLocal();
  resetChecks();
  gw.pullRequestOf = null;
  const { filter } = issues;
  resetIssues();
  issues.filter = filter; // what the box says still filters
  return refresh();
}

// ---- Opening ----

/** Forgets what the window showed: another repository (or none) is next. */
function forgetShown() {
  clearSearch();
  searchEl.value = '';
  Object.assign(gw, {
    repo: null, commits: [], historyDone: false, branches: [], selection: null, diffState: null, cursor: -1,
    github: null, pullRequest: null, pullRequestOf: null,
  });
  forgetGitHub();
  resetIssues();
  forgetIssue();
  history.path = null; // another repository's history starts whole
  resetLocal();
  resetChecks();
}

/**
 * Opens the window on the repository a folder is in; with `remote` (an SSH terminal's id), on the server that
 * terminal is connected to, where git runs over ssh. With `agent` (a terminal), its Agent changes are a tab too, and
 * the whole window without a folder or a repository; `path` is the changed file to show first.
 * @param {string | null | undefined} forFolder
 * @param {{ show?: string, remote?: string | null, agent?: Tab | null, path?: string | null }} [options]
 */
export async function openGitWindow(forFolder, { show = GIT_TAB.changes, remote = null, agent: forAgent = null, path = null } = {}) {
  if (!forFolder && !forAgent) return;
  closeAll();
  gw.folder = forFolder ?? null;
  gw.server = remote || null;
  gw.tab = forAgent || show !== GIT_TAB.agent ? show : GIT_TAB.changes;
  startAgent(forAgent);
  agent.selected = path;
  forgetShown();
  gw.opening++;
  frame.show();
  showTitle(GIT_TITLE);
  branchEl.innerHTML = '';
  actionsEl.innerHTML = '';
  commitBoxEl.innerHTML = '';
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
  Object.assign(gw, { folder: null, server: null, repo: null, items: [], selection: null, diffState: null, cursor: -1 });
  frame.show();
  showTitle(GIT_TITLE);
  branchEl.innerHTML = '';
  listEl.innerHTML = '<div class="gw-empty">This terminal\'s server hasn\'t said which repository it\'s in. Set up Termilly on this host (in the terminal\'s menu), then cd into a repository.</div>';
  rightEl.innerHTML = '';
  listEl.focus();
}

export function closeGitWindow() {
  if (!isOpen()) return;
  frame.hide();
  closed();
}

/** What closing leaves: nothing open, and the answers on their way dropped. */
function closed() {
  gw.opening++;
  useRight(false);
  startAgent(null);
  forgetIssue();
  listEl.innerHTML = '';
  rightEl.innerHTML = '';
  gw.repo = null;
  restoreFocus();
}

on(EVENTS.openGit, ({ folder: f, show, remote, agent: forAgent } = {}) => openGitWindow(f, { show, remote, agent: forAgent }));

/**
 * The window on a terminal's Agent changes, at a file (or the newest): in the repository the terminal works in, on
 * this PC or its server, else alone.
 * @param {Tab | null | undefined} forTab
 * @param {string | null} [path]
 */
export function openAgentChanges(forTab, path = null) {
  if (!forTab) return;
  const git = remoteGit(forTab);
  const where = git ? git.root : gitFolderOf(forTab, wsById(forTab.wsId));
  openGitWindow(where, { show: GIT_TAB.agent, remote: git ? forTab.id : null, agent: forTab, path: path ?? forTab.changes?.[0]?.path ?? null });
}

on(EVENTS.openAgentChanges, ({ tab: t, path } = {}) => openAgentChanges(t, path));

/**
 * The status couldn't be read: outside a repository the terminal's changes show (when there's a terminal), else why.
 * @param {Error} e
 */
function noRepository(e) {
  gw.repo = null;
  if (agent.tab) return showAgentOnly(); // a terminal's changes, outside a repository
  showTitle(GIT_TITLE);
  branchEl.innerHTML = '';
  listEl.innerHTML = `<div class="gw-empty">${escapeHtml(e.message)}</div>`;
  rightEl.innerHTML = `<div class="gw-message">${escapeHtml(e.message === 'Not in a git repository.' ? `Not in a git repository: ${gw.folder}` : e.message)}</div>`;
}

/** Changes again: the file shown, if it's still in the list, drawn again where it was; else the first. */
function refreshChanges() {
  renderList();
  const sel = gw.selection;
  if (sel?.kind === ITEM.file) {
    const still = /** @type {FileItem | undefined} */ (changeItems().find(i => i.kind === ITEM.file && i.side === sel.side && i.path === sel.path));
    if (still) showFile(still, { keepScroll: true }); else showNothing();
  } else if (!sel) {
    selectFirst();
  }
}

/** Looks at the repository again: its status, and whatever the open tab shows. */
async function refresh() {
  if (!isOpen()) return;
  if (!gw.folder) return showAgentOnly();
  try {
    gw.repo = await ask(PAGE.gitviewStatus, { folder: gw.folder });
  } catch (e) {
    return noRepository(/** @type {Error} */ (e));
  }
  loadGitHub(); // draws the head and tabs again when GitHub answers
  if (gw.tab === GIT_TAB.issues && !onGitHub()) gw.tab = GIT_TAB.changes;
  renderHead();
  renderTabs();
  if (searching()) runSearch(found.text, searchScope(), ask, searchChanged);
  else if (gw.tab === GIT_TAB.agent) showAgentTab();
  else if (gw.tab === GIT_TAB.changes) refreshChanges();
  else if (gw.tab === GIT_TAB.history) {
    gw.commits = [];
    gw.historyDone = false;
    await loadHistory();
  } else await showTabsOwn();
}

/** Issues, Local history or Branches, loaded again. */
async function showTabsOwn() {
  if (gw.tab === GIT_TAB.issues) {
    await showIssuesTab();
  } else if (gw.tab === GIT_TAB.local) {
    resetLocal(); // kept since it was last shown: a discard, the timer, a removed worktree
    await showLocalTab();
  } else {
    await loadBranches();
  }
}

// ---- Head and tabs ----

/** The head: the repository's name and branch (called with a status in hand). */
function renderHead() {
  const repo = repoNow();
  showTitle(repo.name);
  repoEl.title = repo.root;
  const ab = [repo.ahead ? `↑${repo.ahead}` : '', repo.behind ? `↓${repo.behind}` : ''].filter(Boolean).join(' ');
  const name = repo.detached ? 'detached HEAD' : repo.branch;
  branchEl.innerHTML = `<span class="gw-branch-name">${escapeHtml(name ?? '')}</span>${ab ? `<span class="gw-ab">${ab}</span>` : ''}`;
  branchEl.title = repo.upstream ? `Tracking ${repo.upstream}` : 'No upstream';
  const n = changeCount();
  find(box, `[data-gw-tab="${GIT_TAB.changes}"]`).textContent = n ? `Changes ${n}` : 'Changes';
  const ctx = writeContext();
  actionsEl.innerHTML = ctx ? headActionsHtml(ctx, gw.pullRequest) : '';
}

function renderTabs() {
  const { tab, repo } = gw;
  // While searching, the list is the search's: no tab is on (a click on one ends the search).
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (box.querySelectorAll('[data-gw-tab]'))) {
    b.classList.toggle('on', b.dataset.gwTab === tab && !searching());
    b.setAttribute('aria-selected', String(b.dataset.gwTab === tab && !searching()));
    // Agent changes with a terminal (in a repository, once Claude changed something or when asked for); the rest
    // with a repository.
    b.hidden = b.dataset.gwTab === GIT_TAB.agent
      ? !agent.tab || (!!repo && !agentCount() && tab !== GIT_TAB.agent)
      : !repo && !!agent.tab;
  }
  // Issues only where gh can reach the repository's GitHub; Local history is kept on this computer only.
  find(box, `[data-gw-tab="${GIT_TAB.issues}"]`).hidden = !onGitHub();
  find(box, `[data-gw-tab="${GIT_TAB.local}"]`).hidden = !repo || !!gw.server;
  const n = agentCount();
  find(box, `[data-gw-tab="${GIT_TAB.agent}"]`).textContent = n ? `${AGENT_TITLE} ${n}` : AGENT_TITLE;
  searchEl.placeholder = tab === GIT_TAB.issues ? SEARCH_ISSUES : repo || !agent.tab ? SEARCH_REPO : SEARCH_AGENT;
  listEl.setAttribute('aria-label', /** @type {Record<string, string>} */ (LIST_LABEL)[tab]);
  issueBarEl.hidden = tab !== GIT_TAB.issues;
  // History's switches, and Branches' Clean up (its backups are kept on this computer only).
  historyBarEl.hidden = searching() || !(tab === GIT_TAB.history || (tab === GIT_TAB.branches && !gw.server));
  if (!historyBarEl.hidden) historyBarEl.innerHTML = tab === GIT_TAB.history ? historyBarHtml() : PRUNE_BUTTON;
  showCommitBox();
}

/**
 * The commit box under Changes, while there's something to commit. It's drawn once a window opening, so a message
 * being written stays through other tabs and searches (a commit empties it).
 */
function showCommitBox() {
  const { repo } = gw;
  const show = gw.tab === GIT_TAB.changes && !searching() && !!repo && changeCount() > repo.conflicted.length;
  if (show && !commitBoxEl.firstElementChild) commitBoxEl.innerHTML = commitBoxHtml(repoNow());
  if (show) followStaged(commitBoxEl, repoNow());
  commitBoxEl.hidden = !show;
}

wireCommitBox(commitBoxEl, writeContext);

/** Outside a repository (or without a folder): the terminal's Agent changes are all the window shows. */
function showAgentOnly() {
  gw.repo = null;
  gw.tab = GIT_TAB.agent;
  showTitle(AGENT_TITLE);
  repoEl.title = '';
  branchEl.textContent = agent.tab ? tabTitle(agent.tab) : '';
  branchEl.title = '';
  renderTabs();
  if (searching()) runSearch(found.text, searchScope(), ask, searchChanged);
  else showAgentTab();
}

/** The Agent changes tab: the tree on the left, the file selected (or the first) in the preview on the right. */
function showAgentTab() {
  useRight(true);
  if (agent.selected) showAgentFile(agent.selected); else showFirstAgentFile();
  renderList();
  cursorOnAgentFile();
}

/** @param {string} next */
async function switchTab(next) {
  if ((next === gw.tab && !searching()) || (!gw.repo && next !== GIT_TAB.agent)) return;
  // The box is the repository's search on the other tabs and the issues' filter on Issues: it starts empty on
  // either, and a search still waiting for its keys is dropped.
  if (searching() || searchEl.value || gw.tab === GIT_TAB.issues || next === GIT_TAB.issues) endSearch();
  forgetIssue();
  Object.assign(gw, { tab: next, selection: null, diffState: null, cursor: -1 });
  renderTabs();
  showNothing();
  if (next === GIT_TAB.agent) {
    showAgentTab();
  } else if (next === GIT_TAB.changes) {
    renderList();
    selectFirst();
  } else if (next === GIT_TAB.history) {
    if (!gw.commits.length) await loadHistory(); else renderList();
  } else {
    await showTabsOwn();
  }
  listEl.focus();
}

// ---- Keeping up ----

const refreshLater = debounce(() => refresh(), REFRESH_DELAY);
// Not while searching: the results would be searched again (code too) under the reader.
const refreshSoon = () => {
  if (isOpen() && gw.tab === GIT_TAB.changes && !searching()) refreshLater();
};

Object.assign(ui, { refresh, refreshAll, renderTabs, switchTab, showAgentTab, loadHistory, close: closeGitWindow, closed, refreshSoon });

// A command ended (a commit, a checkout, an edit) or the window came back: the working tree may have moved on.
on(EVENTS.commandEnding, refreshSoon);
addEventListener('focus', refreshSoon);

// Claude changed a file (or one was taken off the list, or Clear): Agent changes follow.
on(EVENTS.changes, t => {
  if (!isOpen() || t !== agent.tab) return;
  renderTabs();
  if (gw.tab !== GIT_TAB.agent || searching()) return;
  const keep = listEl.scrollTop;
  keepAgentFile();
  renderList();
  cursorOnAgentFile();
  listEl.scrollTop = keep;
});

// The preview moved to another file (N, P): the tree follows.
on(EVENTS.previewShown, ({ tab: t, path }) => {
  if (!isOpen() || t !== agent.tab || gw.tab !== GIT_TAB.agent || searching() || samePath(path, agent.selected)) return;
  agent.selected = path;
  renderList();
  cursorOnAgentFile();
});

// The terminal closed: its changes go, and so does the window when they were all it showed.
on(EVENTS.workspaces, () => {
  if (!isOpen() || !agent.tab || state.tabs.has(agent.tab.id)) return;
  if (!gw.repo) return closeGitWindow();
  startAgent(null);
  if (gw.tab === GIT_TAB.agent) switchTab(GIT_TAB.changes); else renderTabs();
});

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

