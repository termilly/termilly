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
import { toastHere, TOAST } from './toasts.js';
import { addTasks, updateTask, findTask, findIssueTask, workspaceList, openTodo } from './todo.js';
import { implement, implementPlace, implementing, cantImplement, planOf, ALREADY_IMPLEMENTING } from './todoactions.js';
import { planWords } from './todoplan.js';
import { markWorktree } from './worktree.js';
import { issueBranch, issueDetails } from './githubtext.js';

/** @typedef {import('./github.js').Issue} Issue */
/** @typedef {import('./github.js').IssueContext} IssueContext */

/** How much of an issue's text goes into its task's details (the agent can read the rest on GitHub). */
const DETAILS_MOST = 4000;
/** The Implement dialog's fields (their names). */
const FIELD = Object.freeze({ branch: 'branch', base: 'base', worktree: 'worktree' });

/** @param {string} path */
const folderKey = path => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Whether a folder is the repository's, or inside it (not a sibling that only starts the same: app-other for app).
 * @param {string} folder
 * @param {string} root
 */
const inRepository = (folder, root) => folderKey(folder) === folderKey(root) || folderKey(folder).startsWith(`${folderKey(root)}/`);

/**
 * The To do list an issue's task goes in: the workspace whose folder is in the repository, else the one in front.
 * @param {string} root
 */
export function listFor(root) {
  const ws = state.workspaces.find(w => w.cwd && inRepository(w.cwd, root)) ?? activeWs() ?? state.workspaces[0];
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
  toastHere({ text: `#${issue.number} is in To do`, state: TOAST.done, action: { label: 'Show', run: () => openTodo(ref) } });
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
  // The plan shown is the list the task would go in; a task linked already keeps its own list (and that list's plan).
  const shownPlan = planOf(findIssueTask(ctx.repo, issue.number)?.ref ?? listFor(ctx.root));
  return modal(FORM_DIALOG, implementHtml(issue, ctx, planWords(shownPlan)), (dialog, close) => {
    const ok = /** @type {HTMLButtonElement} */ (find(dialog, '[data-ok]'));
    const error = find(dialog, '[data-error]');
    const inWorktree = () => /** @type {HTMLInputElement} */ (find(dialog, `[name=${FIELD.worktree}]`)).checked;
    find(dialog, `[name=${FIELD.worktree}]`).addEventListener('change', () => {
      find(dialog, '.gh-branch-fields').hidden = !inWorktree();
    });
    const submit = async () => {
      if (ok.disabled) return;
      if (!implementPlace(listFor(ctx.root))) return showError(error, cantImplement(listFor(ctx.root)));
      ok.disabled = true;
      const worktree = inWorktree() ? await makeWorktree(dialog, ctx) : null;
      // Cancelled while the worktree was being made: nothing starts, and the folder made is said.
      if (!dialog.isConnected) return worktreeLeft(worktree);
      if (inWorktree() && !worktree) {
        ok.disabled = false;
        return;
      }
      const started = startOn(issue, ctx, worktree);
      if (started) return close(true);
      // It couldn't start after all (the list's place changed, or an agent took the task meanwhile).
      const why = started === null ? cantImplement(listFor(ctx.root)) : ALREADY_IMPLEMENTING;
      showError(error, worktree ? `${why}. The worktree ${worktree.path} was made: git worktree remove takes it away.` : why);
      ok.disabled = false;
    };
    return { submit };
  });
}

/**
 * The issue's task (made now, or the one it already is), and its list's plan started on it, in the worktree when
 * there's one. True when it started; false when an agent is on the task already; null when it can't run there.
 * @param {Issue} issue
 * @param {IssueContext} ctx
 * @param {import('./protocol.js').Host_worktreeReply_0 | null} worktree
 */
function startOn(issue, ctx, worktree) {
  const { ref, task } = addIssueTask(issue, ctx);
  const place = implementPlace(ref);
  if (!place) return null;
  if (implementing(task)) return false;
  const { started, tab } = implement(ref, task, undefined, planOf(ref), { ...place, folder: worktree?.path ?? ctx.root });
  if (tab && worktree) markWorktree(tab, worktree);
  return started || null;
}

/**
 * Says where a worktree made for a cancelled Implement is, so it can be removed.
 * @param {import('./protocol.js').Host_worktreeReply_0 | null} worktree
 */
function worktreeLeft(worktree) {
  if (worktree) toastHere({ text: `Cancelled. The worktree ${worktree.path} was already made: git worktree remove takes it away.`, state: TOAST.failed, stay: true });
}
