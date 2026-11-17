// @ts-check
// The Git window's Issues tab: a GitHub repository's issues, newest first as GitHub lists them, a page at a time
// with numbered pages under the list: open, closed or all, and the window's search box searches them on GitHub. The one picked shows on the right (js/gitissueview.js). gh does the GitHub part through the host;
// gitwindow.js draws the tab's list with the rows made here.

import { PAGE } from './protocol.js';
import { escapeHtml } from './ui.js';
import { targetOf } from './dom.js';
import { askGitHub } from './github.js';
import { ago } from './gitsearch.js';
import { GITHUB_ISSUE_STATE } from './constants.js';
import { pageNumbers } from './githubtext.js';

/** @typedef {import('./github.js').IssueRow} IssueRow */
/** @typedef {import('./github.js').IssuePage} IssuePage */
/**
 * The tab's rows, so gitwindow.js can tell them apart.
 * @typedef {{ kind: 'issue', issue: IssueRow }} IssueItem
 */

export const ISSUE_ITEM = Object.freeze({ issue: 'issue' });
/** What the buttons over and on an issue do (data-issue). */
export const ISSUE_ACT = Object.freeze({
  implement: 'implement', todo: 'todo', showTask: 'show-task', comment: 'comment', close: 'close', reopen: 'reopen',
  open: 'open', state: 'state', page: 'page',
});
export const LOADING = 'Loading';
/** The state filter's choices, in order, and what a count of each is called. */
const STATE_CHOICES = [[GITHUB_ISSUE_STATE.open, 'Open'], [GITHUB_ISSUE_STATE.closed, 'Closed'], [GITHUB_ISSUE_STATE.all, 'All']];
/** @type {Record<string, string>} */
const COUNT_WORD = { [GITHUB_ISSUE_STATE.open]: 'open', [GITHUB_ISSUE_STATE.closed]: 'closed', [GITHUB_ISSUE_STATE.all]: 'issues' };
/** GitHub's icons for an open and a closed issue, and a comment's, drawn on the pixel grid at 16 px. */
const OPEN_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/></svg>';
const CLOSED_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor"/><path d="M5 8.5l2 2 4-4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const COMMENT_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 3.5h11v7.5h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>';

/**
 * The tab's state: the page of issues shown, how many GitHub has, which page this is of how many, where it starts,
 * whether GitHub stops short of them all, which state they're in, what the search asked GitHub for, and why there
 * are none.
 */
export const issues = {
  /** @type {IssueRow[]} */
  list: [],
  total: 0,
  page: 1,
  pages: 0,
  first: 1,
  capped: false,
  /** @type {string} */
  state: GITHUB_ISSUE_STATE.open,
  filter: '',
  loaded: false,
  /** @type {string | null} */
  error: null,
};

/** Which loading of the list is the newest: an answer to an older one (another state, search or repository) is dropped. */
let listAsked = 0;

/** @param {{ state: string }} issue */
export const isClosed = issue => issue.state.toLowerCase() === GITHUB_ISSUE_STATE.closed;

/** @param {boolean} closed */
export const stateIconHtml = closed => (closed ? CLOSED_ICON : OPEN_ICON);

/**
 * A page of the issues in the state picked, matching the search.
 * @param {{ root: string }} ctx
 * @param {number} page
 * @returns {Promise<IssuePage>}
 */
const askPage = (ctx, page) => askGitHub(PAGE.githubIssues, { root: ctx.root, state: issues.state, search: issues.filter.trim() || null, page });

/**
 * Loads the page picked (issues.page). False when a newer loading (or a reset) came meanwhile, and this one's answer
 * was dropped.
 * @param {{ root: string }} ctx
 */
export async function loadIssues(ctx) {
  const asked = ++listAsked;
  /** @type {IssuePage | null} */
  let page = null;
  /** @type {string | null} */
  let error = null;
  try {
    page = await askPage(ctx, issues.page);
  } catch (e) {
    error = /** @type {Error} */ (e).message;
  }
  if (asked !== listAsked) return false;
  Object.assign(issues, { list: page?.issues ?? [], total: page?.total ?? 0, pages: page?.pages ?? 0, first: page?.first ?? 1,
    capped: !!page?.capped, error, loaded: true });
  return true;
}

/**
 * GitHub can't be used for the repository (gh missing, signed out, no answer): the list says why, in place of issues.
 * @param {string} why
 */
export function cantLoadIssues(why) {
  listAsked++;
  Object.assign(issues, { list: [], total: 0, pages: 0, error: why, loaded: true });
}

/** Forgets the issues (another repository, the window closed, or Refresh): an answer on its way is dropped. */
export function resetIssues() {
  listAsked++;
  Object.assign(issues, { list: [], total: 0, pages: 0, page: 1, loaded: false, error: null, filter: '' });
}

/** The list's rows: the page's issues. @returns {IssueItem[]} */
export const issueItems = () => issues.list.map(issue => ({ kind: ISSUE_ITEM.issue, issue }));

/** What the list says when it has no rows. */
export function issuesEmptyText() {
  if (issues.error) return issues.error;
  if (!issues.loaded) return LOADING;
  if (issues.filter.trim()) return 'No issue matches the search.';
  return issues.state === GITHUB_ISSUE_STATE.open ? 'No open issues.' : 'No issues.';
}

/** The bar over the list: the state filter, and which issues the page shows of how many GitHub has in that state. */
export function issueBarHtml() {
  const states = STATE_CHOICES.map(([value, label]) =>
    `<button data-issue="${ISSUE_ACT.state}" data-state="${value}" class="${issues.state === value ? 'on' : ''}" aria-pressed="${issues.state === value}">${label}</button>`).join('');
  const range = issues.list.length ? `${issues.first.toLocaleString()}–${lastShown().toLocaleString()} of ` : '';
  const count = issues.loaded && !issues.error ? `${range}${issues.total.toLocaleString()} ${COUNT_WORD[issues.state]}` : '';
  return `<span class="seg gw-issue-states">${states}</span><span class="gw-issue-count" title="Newest first">${count}</span>`;
}

/** The number of the page's last issue, counted from the newest. */
const lastShown = () => issues.first + issues.list.length - 1;

/**
 * A pager button: a page's number, or Previous or Next (which can't go past the ends).
 * @param {number} to
 * @param {string} label
 * @param {{ name?: string, on?: boolean }} [how]
 */
function pageButtonHtml(to, label, { name, on = false } = {}) {
  const off = to < 1 || to > issues.pages;
  return `<button class="gw-page${on ? ' on' : ''}" data-issue="${ISSUE_ACT.page}" data-page="${to}"${name ? ` aria-label="${name}"` : ''}`
    + `${on ? ' aria-current="page"' : ''}${off ? ' disabled' : ''}>${label}</button>`;
}

/** The numbered pages under the list (none for one page), and a word on the last when GitHub shows no further. */
export function issuePagerHtml() {
  if (!issues.loaded || issues.pages <= 1) return '';
  const { page, pages } = issues;
  const numbers = pageNumbers(page, pages).map(p => (p === null ? '<span class="gw-page-gap">…</span>'
    : pageButtonHtml(p, String(p), { on: p === page })));
  const capped = issues.capped && page === pages
    ? `<div class="gw-page-note">GitHub shows the first ${lastShown().toLocaleString()}. Search to find older ones.</div>` : '';
  return `<div class="gw-pages">${pageButtonHtml(page - 1, '‹', { name: 'Previous page' })}${numbers.join('')}`
    + `${pageButtonHtml(page + 1, '›', { name: 'Next page' })}</div>${capped}`;
}

/**
 * The page a click in the pager picks, or null when it wasn't on one.
 * @param {MouseEvent} e
 */
export function pageClicked(e) {
  const button = /** @type {HTMLButtonElement | null} */ (targetOf(e).closest(`[data-issue="${ISSUE_ACT.page}"]`));
  return button && !button.disabled ? Number(button.dataset.page) : null;
}

/**
 * Picks a state from the filter; true when it was a click on one (the caller loads and draws again).
 * @param {MouseEvent} e
 */
export function stateClicked(e) {
  const button = /** @type {HTMLElement | null} */ (targetOf(e).closest(`[data-issue="${ISSUE_ACT.state}"]`));
  if (!button?.dataset.state) return false;
  issues.state = button.dataset.state;
  return true;
}

/** @param {IssueRow['labels']} labels */
export const labelsHtml = labels => labels.map(l =>
  `<span class="gh-label"${l.color ? ` style="--label: #${escapeHtml(l.color)}"` : ''}>${escapeHtml(l.name)}</span>`).join('');

/**
 * An issue's row: its state, title and labels, then its number, when it was opened and by whom, and its comments.
 * @param {IssueItem} item
 * @param {number} i
 * @param {boolean} selected
 */
export function issueRowHtml(item, i, selected) {
  const { issue } = item;
  const closed = isClosed(issue);
  const comments = issue.comments
    ? `<span class="gh-row-comments" title="${issue.comments} ${issue.comments === 1 ? 'comment' : 'comments'}">${COMMENT_ICON}${issue.comments}</span>` : '';
  return `<div class="cw-row gw-issue-row${selected ? ' selected' : ''}" data-i="${i}" role="option">`
    + `<span class="gh-state-icon" data-state="${closed ? GITHUB_ISSUE_STATE.closed : GITHUB_ISSUE_STATE.open}">${stateIconHtml(closed)}</span>`
    + `<span class="gh-row-text"><span class="gh-row-title">${escapeHtml(issue.title)}</span>`
    + `${issue.labels.length ? `<span class="gh-row-labels">${labelsHtml(issue.labels)}</span>` : ''}`
    + `<span class="gh-row-meta">#${issue.number} opened ${escapeHtml(ago(issue.createdAt))}${issue.author ? ` by ${escapeHtml(issue.author)}` : ''}</span></span>`
    + `${comments}</div>`;
}
