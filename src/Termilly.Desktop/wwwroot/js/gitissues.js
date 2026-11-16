// @ts-check
// The Git window's Issues tab: a GitHub repository's issues (open, closed or all, the window's search box filters
// them), and the one picked on the right with its comments and what can be done with it: Implement (an agent works on
// it, js/issueimplement.js), Add to To do, Comment, Close or Reopen, and Open on GitHub. gh does the GitHub part
// through the host; gitwindow.js draws the tab's list with the rows made here.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { escapeHtml } from './ui.js';
import { modal, confirmDialog, FORM_DIALOG } from './dialogs.js';
import { find, showError, targetOf } from './dom.js';
import { toastHere, TOAST } from './toasts.js';
import { askGitHub } from './github.js';
import { filterIssues } from './githubtext.js';
import { ago } from './gitsearch.js';
import { GITHUB_ISSUE_STATE, GITHUB_ISSUE_ACTION } from './constants.js';
import { findIssueTask, openTodo } from './todo.js';
import { statusOf, STATUS_NAME } from './todolist.js';
import { openImplementIssue, addIssueTask } from './issueimplement.js';

/** @typedef {import('./github.js').IssueRow} IssueRow */
/** @typedef {import('./github.js').Issue} Issue */
/** @typedef {import('./github.js').IssueContext} IssueContext */
/**
 * The tab's row kind, so gitwindow.js can tell them apart.
 * @typedef {{ kind: 'issue', issue: IssueRow }} IssueItem
 */

export const ISSUE_ITEM = Object.freeze({ issue: 'issue' });
/** What the buttons over an issue do (data-issue). */
const ISSUE_ACT = Object.freeze({
  implement: 'implement', todo: 'todo', showTask: 'show-task', comment: 'comment', close: 'close', reopen: 'reopen',
  open: 'open', state: 'state',
});
const LOADING = 'Loading';
const CLOSE_LABEL = 'Close';
const REOPEN_LABEL = 'Reopen';
/** The state filter's choices, in order. */
const STATE_CHOICES = [[GITHUB_ISSUE_STATE.open, 'Open'], [GITHUB_ISSUE_STATE.closed, 'Closed'], [GITHUB_ISSUE_STATE.all, 'All']];

/** The tab's state: the issues loaded, which state they're in, what the search keeps, and why there are none. */
export const issues = {
  /** @type {IssueRow[]} */
  list: [],
  /** @type {string} */
  state: GITHUB_ISSUE_STATE.open,
  filter: '',
  loaded: false,
  /** @type {string | null} */
  error: null,
};

/** Which loading of the list is the newest: an answer to an older one (another state, another repository) is dropped. */
let listAsked = 0;

/**
 * Loads the repository's issues in the state picked. False when a newer loading (or a reset) came meanwhile, and
 * this one's answer was dropped.
 * @param {IssueContext} ctx
 */
export async function loadIssues(ctx) {
  const asked = ++listAsked;
  /** @type {IssueRow[]} */
  let list = [];
  /** @type {string | null} */
  let error = null;
  try {
    list = await askGitHub(PAGE.githubIssues, { root: ctx.root, state: issues.state });
  } catch (e) {
    error = /** @type {Error} */ (e).message;
  }
  if (asked !== listAsked) return false;
  issues.list = list;
  issues.error = error;
  issues.loaded = true;
  return true;
}

/**
 * GitHub can't be used for the repository (gh missing, signed out, no answer): the list says why, in place of issues.
 * @param {string} why
 */
export function cantLoadIssues(why) {
  listAsked++;
  issues.list = [];
  issues.error = why;
  issues.loaded = true;
}

/** Forgets the issues (another repository, the window closed, or Refresh): an answer on its way is dropped. */
export function resetIssues() {
  listAsked++;
  issues.list = [];
  issues.loaded = false;
  issues.error = null;
  issues.filter = '';
}

/** The list's rows: the issues the search keeps. @returns {IssueItem[]} */
export const issueItems = () => filterIssues(issues.list, issues.filter).map(issue => ({ kind: ISSUE_ITEM.issue, issue }));

/** What the list says when it has no rows. */
export function issuesEmptyText() {
  if (issues.error) return issues.error;
  if (!issues.loaded) return LOADING;
  if (issues.filter) return 'No issue matches the search.';
  return issues.state === GITHUB_ISSUE_STATE.open ? 'No open issues.' : 'No issues.';
}

/** The state filter over the list. */
export const issueStatesHtml = () => `<span class="seg gw-issue-states">${STATE_CHOICES.map(([value, label]) =>
  `<button data-issue="${ISSUE_ACT.state}" data-state="${value}" class="${issues.state === value ? 'on' : ''}" aria-pressed="${issues.state === value}">${label}</button>`).join('')}</span>`;

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
const labelsHtml = labels => labels.map(l =>
  `<span class="gh-label"${l.color ? ` style="--label: #${escapeHtml(l.color)}"` : ''}>${escapeHtml(l.name)}</span>`).join('');

/**
 * An issue's row.
 * @param {IssueItem} item
 * @param {number} i
 * @param {boolean} selected
 */
export function issueRowHtml(item, i, selected) {
  const { issue } = item;
  const closed = issue.state.toLowerCase() === GITHUB_ISSUE_STATE.closed;
  return `<div class="cw-row gw-commit gw-issue-row${selected ? ' selected' : ''}" data-i="${i}" role="option">`
    + `<span class="gw-commit-main"><span class="gh-num${closed ? ' closed' : ''}">#${issue.number}</span><span class="gw-subject">${escapeHtml(issue.title)}</span></span>`
    + `<span class="gw-commit-meta">${labelsHtml(issue.labels)}<span>${escapeHtml(issue.author)}</span><span>${ago(issue.updatedAt)}</span>`
    + `${issue.comments ? `<span title="Comments">${issue.comments} ${issue.comments === 1 ? 'comment' : 'comments'}</span>` : ''}</span></div>`;
}

// ---- One issue ----

/** The issue on show, and the window's context for it. */
/** @type {{ issue: Issue, ctx: IssueContext, el: HTMLElement } | null} */
let shown = null;
/** Which showing of an issue is the newest: an older one's answer is dropped. */
let issueAsked = 0;

/**
 * The buttons over an issue: Implement and Add to To do, or the task it already is; then the rest.
 * @param {Issue} issue
 * @param {IssueContext} ctx
 */
function issueActionsHtml(issue, ctx) {
  const linked = findIssueTask(ctx.repo, issue.number);
  const open = issue.state.toLowerCase() !== GITHUB_ISSUE_STATE.closed;
  const button = (/** @type {string} */ act, /** @type {string} */ label, primary = false) =>
    `<button class="btn small${primary ? ' primary' : ''}" data-issue="${act}">${label}</button>`;
  return [
    open && !linked ? button(ISSUE_ACT.implement, 'Implement', true) + button(ISSUE_ACT.todo, 'Add to To do') : '',
    linked ? `<span class="gh-linked">In To do: ${STATUS_NAME[statusOf(linked.task)]}</span>${button(ISSUE_ACT.showTask, 'Show task')}` : '',
    button(ISSUE_ACT.comment, 'Comment'),
    button(open ? ISSUE_ACT.close : ISSUE_ACT.reopen, open ? CLOSE_LABEL : REOPEN_LABEL),
    button(ISSUE_ACT.open, 'Open on GitHub'),
  ].join('');
}

/**
 * An issue's text and comments: as written (Markdown isn't drawn), links left to the reader.
 * @param {Issue} issue
 */
function issueHtml(issue) {
  const comments = issue.comments.map(c => `<div class="gh-comment"><div class="gh-comment-head"><b>${escapeHtml(c.author)}</b><span>${ago(c.createdAt)}</span></div><pre class="gh-body">${escapeHtml(c.body)}</pre></div>`).join('');
  return `<div class="gw-commit-info">
      <div class="gw-commit-subject">${escapeHtml(issue.title)} <span class="gh-num">#${issue.number}</span></div>
      <div class="gw-commit-facts"><span class="gh-state" data-state="${escapeHtml(issue.state.toLowerCase())}">${escapeHtml(issue.state.toLowerCase())}</span>
        <span>${escapeHtml(issue.author)} opened it ${ago(issue.createdAt)}</span>${labelsHtml(issue.labels)}</div>
      <div class="gh-actions" data-issue-actions></div>
    </div>
    <div class="gh-thread">${issue.body.trim() ? `<pre class="gh-body">${escapeHtml(issue.body)}</pre>` : '<div class="gw-empty">No description.</div>'}${comments}</div>`;
}

/**
 * Shows an issue on the right.
 * @param {HTMLElement} el the window's right side
 * @param {number} number
 * @param {IssueContext} ctx
 */
export async function showIssue(el, number, ctx) {
  const asked = ++issueAsked;
  shown = null;
  el.innerHTML = `<div class="gw-message">${LOADING}</div>`;
  /** @type {Issue} */
  let issue;
  try {
    issue = await askGitHub(PAGE.githubIssue, { root: ctx.root, number });
  } catch (e) {
    if (asked === issueAsked) el.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
    return;
  }
  // Another issue was picked meanwhile, or the tab or the window changed: this answer is no longer wanted.
  if (asked !== issueAsked) return;
  shown = { issue, ctx, el };
  el.innerHTML = issueHtml(issue);
  drawActions();
}

/** The issue's buttons again: a task made from it, or its state changed. */
function drawActions() {
  if (!shown) return;
  const at = shown.el.querySelector('[data-issue-actions]');
  if (at) at.innerHTML = issueActionsHtml(shown.issue, shown.ctx);
}

/** The issue shown is gone from the right side, and one on its way won't be shown. */
export function forgetIssue() {
  shown = null;
  issueAsked++;
}

/**
 * A comment on the issue, written in a dialog.
 * @param {Issue} issue
 * @param {IssueContext} ctx
 */
function commentOn(issue, ctx) {
  return modal(FORM_DIALOG, `<h3>Comment on #${issue.number}</h3>
    <label class="dialog-field">Comment<textarea class="field" name="body" rows="7" autofocus></textarea></label>
    <p class="dialog-error" data-error hidden></p>
    <div class="dialog-actions"><button class="btn" data-cancel data-no-enter>Cancel</button><button class="btn primary" data-ok>Comment</button></div>`,
  (dialog, close) => {
    const body = /** @type {HTMLTextAreaElement} */ (find(dialog, '[name=body]'));
    const submit = async () => {
      if (!body.value.trim()) return body.focus();
      try {
        await askGitHub(PAGE.githubIssueAct, { root: ctx.root, number: issue.number, action: GITHUB_ISSUE_ACTION.comment, body: body.value });
        close(true);
      } catch (e) {
        showError(find(dialog, '[data-error]'), /** @type {Error} */ (e).message);
      }
    };
    return { submit };
  });
}

/**
 * Closes or reopens the issue, after asking for a close.
 * @param {Issue} issue
 * @param {IssueContext} ctx
 * @param {string} action
 */
async function setIssueState(issue, ctx, action) {
  if (action === GITHUB_ISSUE_ACTION.close
    && !await confirmDialog({ title: `Close #${issue.number}?`, body: `"${issue.title}" is closed on GitHub. It can be reopened.`, confirm: 'Close issue' })) return false;
  try {
    await askGitHub(PAGE.githubIssueAct, { root: ctx.root, number: issue.number, action });
    return true;
  } catch (e) {
    toastHere({ text: /** @type {Error} */ (e).message, state: TOAST.failed });
    return false;
  }
}

/**
 * A click on an issue's buttons. `changed` loads the list and the issue again after GitHub changed.
 * @param {MouseEvent} e
 * @param {() => void} changed
 */
export async function issueClicked(e, changed) {
  const act = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-issue]'))?.dataset.issue;
  if (!act || !shown || act === ISSUE_ACT.state) return;
  const { issue, ctx } = shown;
  if (act === ISSUE_ACT.open) send(PAGE.openUrl, { url: issue.url });
  else if (act === ISSUE_ACT.implement) { if (await openImplementIssue(issue, ctx)) drawActions(); }
  else if (act === ISSUE_ACT.todo) { addIssueTask(issue, ctx); drawActions(); }
  else if (act === ISSUE_ACT.showTask) { const linked = findIssueTask(ctx.repo, issue.number); if (linked) openTodo(linked.ref); }
  else if (act === ISSUE_ACT.comment) { if (await commentOn(issue, ctx)) changed(); }
  else if (await setIssueState(issue, ctx, act === ISSUE_ACT.close ? GITHUB_ISSUE_ACTION.close : GITHUB_ISSUE_ACTION.reopen)) changed();
}
