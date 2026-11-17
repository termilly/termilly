// @ts-check
// The issue picked in the Git window's Issues tab (js/gitissues.js lists them), on the right: its title, state and
// labels over what can be done with it (Implement: an agent works on it, js/issueimplement.js; Add to To do, Comment,
// Close or Reopen, Open on GitHub), then its text and comments as GitHub draws them (js/markdown.js). Links in them
// open in the browser.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { escapeHtml } from './ui.js';
import { modal, confirmDialog, FORM_DIALOG } from './dialogs.js';
import { find, showError, targetOf } from './dom.js';
import { toastHere, TOAST } from './toasts.js';
import { askGitHub } from './github.js';
import { ago } from './gitsearch.js';
import { GITHUB_ISSUE_STATE, GITHUB_ISSUE_ACTION } from './constants.js';
import { findIssueTask, openTodo } from './todo.js';
import { statusOf, STATUS_NAME } from './todolist.js';
import { openImplementIssue, addIssueTask } from './issueimplement.js';
import { markdownHtml, LINK_HREF } from './markdown.js';
import { LOADING, ISSUE_ACT, labelsHtml, stateIconHtml, isClosed } from './gitissues.js';

/** @typedef {import('./github.js').Issue} Issue */
/** @typedef {import('./github.js').IssueContext} IssueContext */

const CLOSE_LABEL = 'Close';
const REOPEN_LABEL = 'Reopen';
/** What GitHub calls an account that was deleted. */
const DELETED_ACCOUNT = 'ghost';
/** A person's colour: a hue from their name, so the same person looks the same everywhere. */
const HUE_TURN = 360;
const HUE_STEP = 47;

/** The issue on show, and the window's context for it. */
/** @type {{ issue: Issue, ctx: IssueContext, el: HTMLElement } | null} */
let shown = null;
/** Which showing of an issue is the newest: an older one's answer is dropped. */
let issueAsked = 0;

/** @param {number} n */
const commentsText = n => `${n} ${n === 1 ? 'comment' : 'comments'}`;

/** @param {string} name */
function hueOf(name) {
  let hue = 0;
  for (const c of name) hue = (hue * HUE_STEP + /** @type {number} */ (c.codePointAt(0))) % HUE_TURN;
  return hue;
}

/**
 * The buttons over an issue: Implement and Add to To do, or the task it already is; then the rest.
 * @param {Issue} issue
 * @param {IssueContext} ctx
 */
function issueActionsHtml(issue, ctx) {
  const linked = findIssueTask(ctx.repo, issue.number);
  const open = !isClosed(issue);
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
 * The issue's text or a comment: who wrote it and when, over what they wrote.
 * @param {{ author: string, when: string, body: string, byOpener: boolean }} post
 */
function postHtml({ author, when, body, byOpener }) {
  const name = author || DELETED_ACCOUNT;
  return `<article class="gh-post"><div class="gh-post-head">`
    + `<span class="gh-avatar" style="--hue: ${hueOf(name)}">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`
    + `<b>${escapeHtml(name)}</b><span class="gh-when">${escapeHtml(when)}</span>${byOpener ? '<span class="gh-badge">Author</span>' : ''}</div>`
    + `<div class="gh-md">${body.trim() ? markdownHtml(body) : '<p class="gh-none">No description.</p>'}</div></article>`;
}

/**
 * An issue: its head (title, state, who opened it, labels, buttons) over its thread.
 * @param {Issue} issue
 */
function issueHtml(issue) {
  const closed = isClosed(issue);
  const posts = [
    postHtml({ author: issue.author, when: `opened this ${ago(issue.createdAt)}`, body: issue.body, byOpener: false }),
    ...issue.comments.map(c => postHtml({ author: c.author, when: `commented ${ago(c.createdAt)}`, body: c.body, byOpener: !!c.author && c.author === issue.author })),
  ];
  return `<div class="gh-issue-head">
      <div class="gh-issue-title">${escapeHtml(issue.title)} <span class="gh-issue-num">#${issue.number}</span></div>
      <div class="gh-issue-sub"><span class="gh-state" data-state="${closed ? GITHUB_ISSUE_STATE.closed : GITHUB_ISSUE_STATE.open}">${stateIconHtml(closed)}${closed ? 'Closed' : 'Open'}</span>
        <span><b>${escapeHtml(issue.author || DELETED_ACCOUNT)}</b> opened this ${escapeHtml(ago(issue.createdAt))} · ${commentsText(issue.comments.length)}</span></div>
      ${issue.labels.length ? `<div class="gh-labels">${labelsHtml(issue.labels)}</div>` : ''}
      <div class="gh-actions" data-issue-actions></div>
    </div>
    <div class="gh-thread">${posts.join('')}</div>`;
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
 * A click on an issue: a link in its text (to the browser), or one of its buttons. `changed` loads the list and the
 * issue again after GitHub changed.
 * @param {MouseEvent} e
 * @param {() => void} changed
 */
export async function issueClicked(e, changed) {
  const link = /** @type {HTMLElement | null} */ (targetOf(e).closest(`[${LINK_HREF}]`));
  if (link) return void send(PAGE.openUrl, { url: link.getAttribute(LINK_HREF) });
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
