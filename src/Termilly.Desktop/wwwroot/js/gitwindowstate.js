// @ts-check
// The Git window's state, which its parts share (js/gitwindow.js and the modules it's split into): the repository
// it shows, the tab, the side list and what the right side shows, and how they ask the host. Parts lower down call
// the main ones back through `ui`, which gitwindow.js fills in, so no part imports one above it.

import { request } from './host.js';

// What GitView.cs answers with, and what this window keeps.
/** @typedef {import('./gitsearch.js').RepoStatus} RepoStatus */
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
 *   | import('./gitsearch.js').SearchItem | import('./gitagent.js').AgentItem | import('./gitissues.js').IssueItem
 *   | import('./gitissues.js').IssueMoreItem
 *   | import('./gitlocal.js').LocalItem | { kind: 'worktree', worktree: import('./gitcleanup.js').Worktree }} ListItem
 */
/**
 * A file whose diff can be shown: a changed file's row, or a file in a commit.
 * @typedef {{ path: string, oldPath?: string | null, side?: string, conflict?: boolean }} ShownFile
 */
/**
 * What the right side shows: a file (by side and path), a commit (by hash), a branch (by ref) or an issue (by
 * number); and the search's row it was opened from (its hitKey).
 * @typedef {{ kind: string, side?: string, path?: string, hash?: string, ref?: string, number?: number, id?: string,
 *   hit?: string | null }} Selection
 */
/**
 * A diff as GitView.cs sends it: the change preview's data, and what's said about it. An image comes as pictures
 * too (data: URLs).
 * @typedef {import('./diffrows.js').DiffData & { display?: string | null, error?: string | null,
 *   note?: string | null, added?: number, removed?: number, eolOnly?: boolean, beforeSize?: number,
 *   afterSize?: number, beforeImage?: string | null, afterImage?: string | null }} GitDiff
 */
/**
 * The diff shown: what was asked, the answer, the folds opened, and where it's drawn; for a search's hit, the whole
 * file (to show a line that didn't change) and what it found marked; its rows, when parts of it can be staged.
 * @typedef {{ request: import('./protocol.js').Page_gitviewDiff, data: GitDiff, expanded: Set<string>,
 *   target: Element, label: string | null, find: Find | null, rows?: import('./diffrows.js').DiffRow[] | null }} DiffState
 */
/**
 * A search's hit in a diff: the line to show (the file's, 0 for the first match), and whether the whole file shows.
 * @typedef {{ line: number, wholeFile: boolean }} Find
 */

/** The window's tabs (data-gw-tab), and what the side list shows. */
export const GIT_TAB = Object.freeze({ agent: 'agent', changes: 'changes', history: 'history', branches: 'branches', local: 'local', issues: 'issues' });

/**
 * The window's state.
 * @type {{
 *   folder: string | null, server: string | null, repo: RepoStatus | null, tab: string, items: ListItem[], cursor: number,
 *   commits: Commit[], historyDone: boolean, loadingMore: boolean, branches: Branch[],
 *   worktrees: import('./gitcleanup.js').Worktree[], collapsedSections: Set<string>, selection: Selection | null,
 *   diffState: DiffState | null, currentCommit: CommitDetail | null, github: import('./github.js').GitHubStatus | null,
 *   pullRequest: { number: number, url: string, state: string } | null, pullRequestOf: string | null, opening: number,
 * }}
 */
export const gw = {
  folder: null, // what it was opened for
  server: null, // the SSH terminal whose server the repository is on, or null for this PC
  repo: null, // the last status: { root, name, branch, staged, unstaged, untracked, conflicted, ... }
  tab: GIT_TAB.changes,
  items: [], // the side list's rows
  cursor: -1, // the row the keyboard is on
  commits: [], // History, as loaded so far
  historyDone: false,
  loadingMore: false, // History's next page is on its way
  branches: [],
  worktrees: [], // the Branches tab's, with them
  collapsedSections: new Set(),
  selection: null, // what the right side shows
  diffState: null,
  currentCommit: null, // the commit the right side shows
  github: null, // the repository on GitHub, through gh on this PC; null on a server or until it's known
  pullRequest: null, // the branch's open pull request, when it has one
  pullRequestOf: null, // the branch it was asked for: asked again only for another branch, or after a write
  opening: 0, // counts the window's openings and closings: an answer for an earlier one is dropped
};

const later = async () => {};

/** The window's main steps, for the parts below them to call (gitwindow.js and gitloaders.js fill them in). */
export const ui = {
  /** Looks at the repository again: its status, and whatever the open tab shows. @type {() => Promise<void>} */
  refresh: later,
  /** Refresh (its button, F5): GitHub asked again too. @type {() => Promise<void>} */
  refreshAll: later,
  /** @type {() => void} */
  renderTabs: () => {},
  /** @type {(next: string) => Promise<void>} */
  switchTab: later,
  /** @type {() => void} */
  showAgentTab: () => {},
  /** @type {() => Promise<void>} */
  loadHistory: later,
  /** Issues' next page, onto the list. @type {() => Promise<void>} */
  loadMoreIssues: later,
  /** Issues from their first page again: another state, or other search words. @type {() => Promise<void>} */
  reloadIssues: later,
  /** Closes the window (its Close, Escape, its window's X). @type {() => void} */
  close: () => {},
  /** What closing leaves: also when the window went without asking. @type {() => void} */
  closed: () => {},
  /** Reads the working tree again a moment later, when Changes shows. @type {() => void} */
  refreshSoon: () => {},
};

/**
 * Asks git, through the host, about the repository on a machine: this PC (null) or an SSH terminal's server. Its
 * data, or git's error.
 * @param {string | null} on
 * @param {any} type
 * @param {any} payload
 * @returns {Promise<any>}
 */
export async function askOn(on, type, payload) {
  const m = await request(type, { ...payload, remote: on ?? undefined });
  if (m.error) throw new Error(m.error);
  return m.data;
}

/**
 * Asks about the repository the window is on now.
 * @template {keyof import('./protocol.js').PageMessages} K
 * @param {K} type
 * @param {import('./protocol.js').PageMessages[K]} payload
 * @returns {Promise<any>}
 */
export const ask = (type, payload) => askOn(gw.server, type, payload);

/**
 * An ask tied to the machine the window is on now: what an Undo or a dialog keeps, so it acts where it was offered
 * even after the window moved to another repository.
 * @returns {import('./gitsafety.js').Ask}
 */
export const askHere = () => {
  const on = gw.server;
  return (type, payload) => askOn(on, type, payload);
};

/** The repository shown; only called with one in hand. */
export const repoNow = () => /** @type {RepoStatus} */ (gw.repo);

/** How many files the repository has changed, staged, new or in conflict. */
export const changeCount = () => (gw.repo ? gw.repo.staged.length + gw.repo.unstaged.length + gw.repo.untracked.length + gw.repo.conflicted.length : 0);
