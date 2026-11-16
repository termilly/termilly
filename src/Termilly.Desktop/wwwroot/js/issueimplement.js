// @ts-check
// From a GitHub issue to work: Add to To do makes a task linked to the issue (its #number chip, the issue's text in
// its details), and Implement does that and starts the To do list's plan on it, in its own worktree on a new branch
// (bugfix/72-remote-render-fix, from the branch picked) or in the repository as it is. The task then goes the usual
// way: In progress while the agent works, Review when it's done.

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { state, activeWs } from './store.js';
import { escapeHtml } from './ui.js';
import { modal, FORM_DIALOG } from './dialogs.js';
import { find, field, showError } from './dom.js';
import { showToast, TOAST } from './toasts.js';
import { addTasks, updateTask, findTask, findIssueTask, workspaceList, openTodo } from './todo.js';
import { implement, implementPlace, cantImplement, planOf } from './todoactions.js';
import { planWords } from './todoplan.js';
import { markWorktree } from './worktree.js';
import { issueBranch, issueDetails } from './githubtext.js';

/** @typedef {import('./gitissues.js').Issue} Issue */
/** @typedef {import('./gitissues.js').IssueContext} IssueContext */

/** How much of an issue's text goes into its task's details (the agent can read the rest on GitHub). */
const DETAILS_MOST = 4000;
/** The Implement dialog's fields (their names). */
const FIELD = Object.freeze({ branch: 'branch', base: 'base', worktree: 'worktree' });

/** @param {string} path */
const folderKey = path => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The To do list an issue's task goes in: the workspace whose folder is in the repository, else the one in front.
 * @param {string} root
 */
function listFor(root) {
  const key = folderKey(root);
  const ws = state.workspaces.find(w => w.cwd && folderKey(w.cwd).startsWith(key)) ?? activeWs() ?? state.workspaces[0];
  return workspaceList(ws);
}

/**
 * Add to To do: a task for the issue, linked to it, at the top of the repository's workspace's list; the task it
 * already is, when there's one.
 * @param {Issue} issue
 * @param {IssueContext} ctx
 */
export function addIssueTask(issue, ctx) {
  const linked = findIssueTask(ctx.repo, issue.number);
  if (linked) return linked;
  const ref = listFor(ctx.root);
  const [id] = addTasks(ref, [{ text: `#${issue.number} ${issue.title}`, details: issueDetails(issue, DETAILS_MOST) }]);
  updateTask(ref, id, { issue: { repo: ctx.repo, number: issue.number, url: issue.url } });
  const found = /** @type {NonNullable<ReturnType<typeof findTask>>} */ (findTask(id));
  showToast({ text: `#${issue.number} is in To do`, state: TOAST.done, action: { label: 'Show', run: () => openTodo(ref) } });
  return found;
}

/**
 * The Implement dialog's inside.
 * @param {Issue} issue
 * @param {IssueContext} ctx
 * @param {string} plan the list's plan in words
 */
function implementHtml(issue, ctx, plan) {
  return `<h3>Implement #${issue.number}</h3>
    <p class="dialog-sub">${escapeHtml(issue.title)}</p>
    <label class="dialog-check"><input type="checkbox" name="${FIELD.worktree}" checked> In its own worktree, on a new branch</label>
    <div class="gh-branch-fields">
      <label class="dialog-field">Branch<input class="field" name="${FIELD.branch}" value="${escapeHtml(issueBranch(issue))}" spellcheck="false"></label>
      <label class="dialog-field">From<input class="field" name="${FIELD.base}" value="${escapeHtml(ctx.branch ?? ctx.defaultBranch ?? '')}" spellcheck="false"></label>
    </div>
    <p class="dialog-sub">${escapeHtml(plan)}, as the To do list's Implement plan says. The task goes to Review when it's done.</p>
    <p class="dialog-error" data-error hidden></p>
    <div class="dialog-actions"><button class="btn" data-cancel data-no-enter>Cancel</button><button class="btn primary" data-ok>Start</button></div>`;
}

/**
 * Makes the worktree the dialog asks for; its folder, or null with the host's reason shown.
 * @param {HTMLElement} dialog
 * @param {IssueContext} ctx
 */
async function makeWorktree(dialog, ctx) {
  const m = await request(PAGE.worktreeCreate, {
    folder: ctx.root, branch: field(dialog, `[name=${FIELD.branch}]`).value.trim(), base: field(dialog, `[name=${FIELD.base}]`).value.trim() || undefined,
  });
  if (m.ok) return m;
  showError(find(dialog, '[data-error]'), m.message);
  return null;
}

/**
 * Implement from an issue: asks where (a worktree on a new branch, or the repository as it is), then the To do list's
 * plan starts on the issue's task. True when it started.
 * @param {Issue} issue
 * @param {IssueContext} ctx
 */
export function openImplementIssue(issue, ctx) {
  const ref = listFor(ctx.root);
  const plan = planOf(ref);
  return modal(FORM_DIALOG, implementHtml(issue, ctx, planWords(plan)), (dialog, close) => {
    const ok = /** @type {HTMLButtonElement} */ (find(dialog, '[data-ok]'));
    const inWorktree = () => /** @type {HTMLInputElement} */ (find(dialog, `[name=${FIELD.worktree}]`)).checked;
    find(dialog, `[name=${FIELD.worktree}]`).addEventListener('change', () => {
      find(dialog, '.gh-branch-fields').hidden = !inWorktree();
    });
    const submit = async () => {
      const place = implementPlace(ref);
      if (ok.disabled) return;
      if (!place) return showError(find(dialog, '[data-error]'), cantImplement(ref));
      ok.disabled = true;
      const worktree = inWorktree() ? await makeWorktree(dialog, ctx) : null;
      if (inWorktree() && !worktree) {
        ok.disabled = false;
        return;
      }
      const { task } = addIssueTask(issue, ctx);
      const { started, tab } = implement(ref, task, undefined, plan, { ...place, folder: worktree?.path ?? ctx.root });
      if (tab && worktree) markWorktree(tab, worktree);
      close(started);
    };
    return { submit };
  });
}
