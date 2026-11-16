// @ts-check
// The Git window's write side: the commit box under Changes, Push (a dialog that says where the commits go and shows
// what the repository's own pre-push hook said), Create pull request (gh, on this computer), and Undo on a commit
// that isn't pushed yet. git and gh do the work through the host (GitView.cs, the GitHub service); Termilly adds no
// rules of its own about what a commit may say.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { escapeHtml } from './ui.js';
import { modal, confirmDialog, FORM_DIALOG } from './dialogs.js';
import { find, field, showError } from './dom.js';
import { showToast, TOAST } from './toasts.js';
import { askGitHub } from './github.js';
import { pullRequestDraft } from './githubtext.js';

/**
 * What the write side needs from the window: the repository, asking git about it, looking again, git's errors, and
 * GitHub when it's there.
 * @typedef {object} WriteContext
 * @property {import('./gitsearch.js').RepoStatus} repo
 * @property {(type: any, payload: any) => Promise<any>} ask git through the host, on this PC or the terminal's server
 * @property {() => Promise<void>} refresh
 * @property {(text: string) => Promise<void>} showGitError
 * @property {import('./github.js').GitHubStatus | null} github null on a server, or while it's asked
 */
/**
 * What gitview:pushInfo answers: where the branch goes and what goes with it.
 * @typedef {{ branch: string, remote: string, remoteUrl?: string | null, upstream?: string | null, newBranch: boolean,
 *   commits: { hash: string, subject: string, author: string }[], hasPrePushHook: boolean }} PushInfo
 */

/** The commit box's parts (data-commit). */
const BOX = Object.freeze({ message: 'message', all: 'all', go: 'go' });
/** The pull request dialog's fields (their names). */
const PR_FIELD = Object.freeze({ base: 'base', title: 'title', body: 'body', draft: 'draft' });
/** The head's write buttons (data-gw). */
export const WRITE_BUTTON = Object.freeze({ push: 'push', pr: 'pr', openPr: 'open-pr' });
const PUSH_LABEL = 'Push';
const CREATE_PR_LABEL = 'Create pull request';
/** The toast's button that opens the new pull request. */
const OPEN_LABEL = 'Open';
/** A pull request's state while it's open, as gh says it (lower-cased). */
const PR_OPEN = 'open';
/** Commits a push dialog lists before it says how many more. */
const PUSH_LIST_MOST = 8;

// ---- Commit ----

/**
 * The commit box under the Changes list: a message, and whether everything goes in (on when nothing is staged).
 * @param {import('./gitsearch.js').RepoStatus} repo
 */
export function commitBoxHtml(repo) {
  const nothingStaged = !repo.staged.length;
  return `<textarea class="field gw-commit-msg" data-commit="${BOX.message}" rows="3" placeholder="Commit message" spellcheck="true"></textarea>
    <div class="gw-commit-row">
      <label class="gw-commit-all" title="Stages every change and new file first"><input type="checkbox" data-commit="${BOX.all}"${nothingStaged ? ' checked' : ''}> All changes</label>
      <button class="btn small primary" data-commit="${BOX.go}" title="Commit (Ctrl+Enter)">Commit</button>
    </div>`;
}

/**
 * Commits what the box says; the box empties and the window looks again. git's refusal shows in its own words.
 * @param {HTMLElement} box
 * @param {WriteContext} ctx
 */
export async function commitFrom(box, ctx) {
  const message = /** @type {HTMLTextAreaElement} */ (find(box, `[data-commit="${BOX.message}"]`));
  const all = /** @type {HTMLInputElement} */ (find(box, `[data-commit="${BOX.all}"]`)).checked;
  const button = /** @type {HTMLButtonElement} */ (find(box, `[data-commit="${BOX.go}"]`));
  if (!message.value.trim()) {
    message.focus();
    return;
  }
  button.disabled = true;
  try {
    const { hash } = await ctx.ask(PAGE.gitviewCommitCreate, { root: ctx.repo.root, message: message.value, all });
    message.value = '';
    showToast({ text: `Committed ${String(hash).slice(0, 7)}`, state: TOAST.done });
  } catch (e) {
    await ctx.showGitError(/** @type {Error} */ (e).message);
  } finally {
    button.disabled = false;
  }
  await ctx.refresh();
}

/**
 * Wires a commit box: its button, and Ctrl+Enter in the message.
 * @param {HTMLElement} box
 * @param {() => WriteContext | null} context
 */
export function wireCommitBox(box, context) {
  box.addEventListener('click', e => {
    const ctx = context();
    if (ctx && /** @type {HTMLElement} */ (e.target).closest(`[data-commit="${BOX.go}"]`)) commitFrom(box, ctx);
  });
  box.addEventListener('keydown', e => {
    const ctx = context();
    if (ctx && e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      commitFrom(box, ctx);
    }
  });
}

/**
 * Undoes the newest commit, keeping its changes staged; only one that isn't on a remote (the host checks).
 * @param {WriteContext} ctx
 * @param {string} subject
 */
export async function undoCommit(ctx, subject) {
  const ok = await confirmDialog({
    title: 'Undo this commit?', confirm: 'Undo commit',
    body: `"${subject}" is taken off the branch. Its changes stay, staged, so you can commit them again.`,
  });
  if (!ok) return;
  try {
    await ctx.ask(PAGE.gitviewUndoCommit, { root: ctx.repo.root });
  } catch (e) {
    await ctx.showGitError(/** @type {Error} */ (e).message);
  }
  await ctx.refresh();
}

// ---- Head buttons ----

/**
 * Whether the branch has commits to push: ahead of its upstream, or none yet.
 * @param {import('./gitsearch.js').RepoStatus} repo
 */
export const canPush = repo => !!repo.branch && !repo.detached && repo.hasCommits !== false && (!repo.upstream || !!repo.ahead);

/**
 * Whether a pull request can be made from the branch: on GitHub, pushed, and not the default branch.
 * @param {WriteContext} ctx
 */
export const canOpenPullRequest = ctx => !!ctx.github?.available && !!ctx.repo.upstream && !ctx.repo.ahead
  && !!ctx.repo.branch && ctx.repo.branch !== ctx.github.defaultBranch;

/**
 * The head's buttons: Push when there's something to push, else Create pull request when one can be made, or the
 * branch's open pull request.
 * @param {WriteContext} ctx
 * @param {{ number: number, url: string, state: string } | null} pr the branch's pull request, if it has one
 */
export function headActionsHtml(ctx, pr) {
  if (canPush(ctx.repo)) return `<button class="btn small" data-gw="${WRITE_BUTTON.push}" title="Push this branch">${PUSH_LABEL}${ctx.repo.ahead ? ` ${ctx.repo.ahead}` : ''}</button>`;
  // gh lists merged and closed ones too: only an open one stands in for Create pull request.
  if (pr?.state.toLowerCase() === PR_OPEN) return `<button class="btn small" data-gw="${WRITE_BUTTON.openPr}" data-url="${escapeHtml(pr.url)}" title="Open it on GitHub">Pull request #${pr.number}</button>`;
  return canOpenPullRequest(ctx) ? `<button class="btn small" data-gw="${WRITE_BUTTON.pr}">${CREATE_PR_LABEL}</button>` : '';
}

// ---- Push ----

/**
 * The push dialog's inside: where it goes, the commits, and what's checked first.
 * @param {PushInfo} info
 * @param {WriteContext} ctx
 */
function pushHtml(info, ctx) {
  const to = info.upstream ? `To <b>${escapeHtml(info.upstream)}</b>` : `To <b>${escapeHtml(info.remote)}</b>, a new branch there`;
  const where = info.remoteUrl ? ` (${escapeHtml(info.remoteUrl)})` : '';
  const listed = info.commits.slice(0, PUSH_LIST_MOST).map(c =>
    `<div class="gw-push-commit"><span class="gw-hash">${escapeHtml(c.hash.slice(0, 7))}</span><span>${escapeHtml(c.subject)}</span></div>`).join('');
  const more = info.commits.length > PUSH_LIST_MOST ? `<div class="dialog-sub">and ${info.commits.length - PUSH_LIST_MOST} more</div>` : '';
  const checks = [
    info.hasPrePushHook ? '<li>The repository\'s pre-push hook runs first; what it says shows here.</li>' : '',
    info.newBranch && ctx.github?.isPublic ? '<li class="gw-warn">A new branch on a public repository: anyone can see it.</li>' : '',
  ].join('');
  const offerPr = !!ctx.github?.available && info.branch !== ctx.github.defaultBranch;
  return `<h3>Push ${escapeHtml(info.branch)}</h3>
    <p class="dialog-sub">${to}${where}</p>
    <div class="gw-push-list">${listed || '<div class="dialog-sub">No new commits.</div>'}${more}</div>
    ${checks ? `<ul class="gw-push-checks">${checks}</ul>` : ''}
    ${offerPr ? `<label class="dialog-check"><input type="checkbox" name="then-pr"${info.newBranch ? ' checked' : ''}> Then create a pull request</label>` : ''}
    <p class="dialog-error" data-error hidden></p>
    <div class="dialog-actions">
      <button class="btn" data-cancel data-no-enter>Cancel</button>
      <button class="btn primary" data-ok>${PUSH_LABEL}</button>
    </div>`;
}

/**
 * Push: asks first with where it goes and what goes, then pushes (the first push sets the upstream). A hook or git
 * that refuses says why in the dialog. Ticked, Create pull request follows.
 * @param {WriteContext} ctx
 */
export async function openPush(ctx) {
  /** @type {PushInfo} */
  let info;
  try {
    info = await ctx.ask(PAGE.gitviewPushInfo, { root: ctx.repo.root });
  } catch (e) {
    await ctx.showGitError(/** @type {Error} */ (e).message);
    return;
  }
  const thenPr = await modal(FORM_DIALOG, pushHtml(info, ctx), (dialog, close) => {
    const ok = /** @type {HTMLButtonElement} */ (find(dialog, '[data-ok]'));
    const submit = async () => {
      if (ok.disabled) return;
      ok.disabled = true;
      ok.textContent = 'Pushing…';
      try {
        await ctx.ask(PAGE.gitviewPush, { root: ctx.repo.root });
        close(!!/** @type {HTMLInputElement | null} */ (dialog.querySelector('[name=then-pr]'))?.checked);
      } catch (e) {
        showError(find(dialog, '[data-error]'), /** @type {Error} */ (e).message);
        ok.disabled = false;
        ok.textContent = PUSH_LABEL;
      }
    };
    return { submit };
  });
  await ctx.refresh();
  if (thenPr) await openPullRequest(ctx);
}

// ---- Pull request ----

/**
 * The pull request dialog's inside.
 * @param {string} branch
 * @param {string} base
 * @param {{ title: string, body: string }} draft
 */
function pullRequestHtml(branch, base, draft) {
  return `<h3>${CREATE_PR_LABEL}</h3>
    <p class="dialog-sub">From <b>${escapeHtml(branch)}</b>, on GitHub.</p>
    <label class="dialog-field">Into
      <input class="field" name="${PR_FIELD.base}" value="${escapeHtml(base)}" spellcheck="false">
    </label>
    <label class="dialog-field">Title
      <input class="field" name="${PR_FIELD.title}" value="${escapeHtml(draft.title)}" autofocus>
    </label>
    <label class="dialog-field">Description
      <textarea class="field" name="${PR_FIELD.body}" rows="6">${escapeHtml(draft.body)}</textarea>
    </label>
    <label class="dialog-check"><input type="checkbox" name="${PR_FIELD.draft}"> Draft</label>
    <p class="dialog-error" data-error hidden></p>
    <div class="dialog-actions">
      <button class="btn" data-cancel data-no-enter>Cancel</button>
      <button class="btn primary" data-ok>Create</button>
    </div>`;
}

/**
 * The branch's newest commit's subject, for the pull request's first title.
 * @param {WriteContext} ctx
 */
async function lastSubject(ctx) {
  try {
    const [commit] = await ctx.ask(PAGE.gitviewLog, { root: ctx.repo.root, skip: 0, limit: 1 });
    return commit?.subject ?? '';
  } catch {
    return ''; // only a suggestion: the field starts empty
  }
}

/**
 * Create pull request: into the default branch (or another), titled after the branch's issue or newest commit,
 * closing the issue the branch names. The new one opens in the browser.
 * @param {WriteContext} ctx
 * @param {{ number: number, title: string } | null} [issue]
 */
export async function openPullRequest(ctx, issue = null) {
  const branch = /** @type {string} */ (ctx.repo.branch);
  const draft = pullRequestDraft(branch, await lastSubject(ctx), issue);
  const created = await modal(FORM_DIALOG, pullRequestHtml(branch, ctx.github?.defaultBranch ?? '', draft), (dialog, close) => {
    const ok = /** @type {HTMLButtonElement} */ (find(dialog, '[data-ok]'));
    /** @param {string} name */
    const value = name => field(dialog, `[name=${name}]`).value.trim();
    const submit = async () => {
      if (ok.disabled) return;
      if (!value(PR_FIELD.title) || !value(PR_FIELD.base)) return field(dialog, `[name=${value(PR_FIELD.base) ? PR_FIELD.title : PR_FIELD.base}]`).focus();
      ok.disabled = true;
      try {
        close(await askGitHub(PAGE.githubPrCreate, {
          root: ctx.repo.root, base: value(PR_FIELD.base), head: branch, title: value(PR_FIELD.title),
          body: /** @type {HTMLTextAreaElement} */ (find(dialog, `[name=${PR_FIELD.body}]`)).value,
          draft: /** @type {HTMLInputElement} */ (find(dialog, `[name=${PR_FIELD.draft}]`)).checked,
        }));
      } catch (e) {
        showError(find(dialog, '[data-error]'), /** @type {Error} */ (e).message);
        ok.disabled = false;
      }
    };
    return { submit };
  });
  if (!created) return;
  showToast({ text: `Pull request #${created.number} created`, state: TOAST.done, action: { label: OPEN_LABEL, run: () => send(PAGE.openUrl, { url: created.url }) } });
  await ctx.refresh();
}
