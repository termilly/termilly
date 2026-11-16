// @ts-check
// Tidying up, in the Git window's Branches tab (js/gitwindow.js): the repository's worktrees (one per agent task,
// often), each to open a terminal in or remove, and Clean up branches, which offers the branches whose work is done
// (merged, or gone from the remote) and the long-untouched ones, deletes the ones ticked and keeps each one's place
// first (a branch backup, gitlocal.js), so Undo puts them all back.

import { PAGE } from './protocol.js';
import { PRUNE_REASON } from './constants.js';
import { escapeHtml } from './ui.js';
import { modal, confirmDialog, CONFIRM_DIALOG } from './dialogs.js';
import { find, showError } from './dom.js';
import { newTab, closeTab } from './panes.js';
import { tabsIn, CLOSE_GRACE_MS } from './worktree.js';
import { toastHere, TOAST, UNDO } from './toasts.js';
import { ago } from './gitsearch.js';

/**
 * A worktree of the repository, as the host lists it.
 * @typedef {{ path: string, branch: string | null, head: string, main: boolean, current: boolean, changes: number,
 *   locked: boolean, prunable: boolean }} Worktree
 */
/** @typedef {{ name: string, reasons: string[], lastDate: string, unmerged: number, worktree: string | null }} PruneCandidate */
/**
 * What tidying up works with from the window.
 * @typedef {import('./gitlocal.js').LocalContext} CleanupContext
 */

/** The Branches tab's worktree rows' kind. */
export const WORKTREE_ITEM = 'worktree';
/** The prune dialog's class (dialogs.js). */
const PRUNE_DIALOG = 'git-prune';
/** Why a branch is offered, in words. @type {Readonly<Record<string, string>>} */
const REASON_WORDS = Object.freeze({
  [PRUNE_REASON.merged]: 'merged',
  [PRUNE_REASON.gone]: 'gone from the remote',
  [PRUNE_REASON.old]: 'no commits for 3 months',
});

/** @param {string} path */
const folderName = path => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;

/**
 * A worktree's row in the Branches tab.
 * @param {Worktree} w
 * @param {number} i
 * @param {boolean} selected
 */
export function worktreeRowHtml(w, i, selected) {
  const what = [w.current ? 'this one' : w.main ? 'main' : '', w.changes ? `${w.changes} uncommitted` : '', w.prunable ? 'folder gone' : '']
    .filter(Boolean).join(' · ');
  return `<div class="cw-row gw-commit${selected ? ' selected' : ''}" data-i="${i}" role="option" title="${escapeHtml(w.path)}">`
    + `<span class="gw-commit-main"><span class="gw-subject">${escapeHtml(folderName(w.path))}</span>${w.branch ? `<span class="gw-ref">${escapeHtml(w.branch)}</span>` : ''}</span>`
    + `<span class="gw-commit-meta"><span class="gw-hash">${escapeHtml(w.head.slice(0, 7))}</span><span>${escapeHtml(what)}</span></span></div>`;
}

/**
 * A worktree on the right: where it is, and its buttons.
 * @param {Worktree} w
 * @param {boolean} remote whether it's on a server
 */
export function worktreeHtml(w, remote) {
  const remove = w.main || w.current ? '' : '<button class="btn small danger-outline" data-wt-remove>Remove worktree</button>';
  // A server's folder opens in a terminal on that server, from its own terminal: not from here.
  const terminal = remote ? '' : '<button class="btn small" data-wt-terminal>Open terminal here</button>';
  return `<div class="gw-commit-info"><div class="gw-commit-subject">${escapeHtml(folderName(w.path))}</div>`
    + `<div class="gw-commit-facts"><span>${escapeHtml(w.path)}</span>${w.branch ? `<span>on ${escapeHtml(w.branch)}</span>` : ''}`
    + `<span>${w.changes ? `${w.changes} uncommitted change${w.changes === 1 ? '' : 's'}` : 'No uncommitted changes'}</span></div>`
    + `<div class="gw-commit-facts">${terminal}${remove}</div></div>`;
}

/**
 * Removes a worktree after asking: its terminals close first (a shell in the folder would hold it), and changes in
 * it are kept in local history before they go.
 * @param {Worktree} w
 * @param {CleanupContext} ctx
 */
async function removeWorktree(w, ctx) {
  // Termilly's terminals in it are this computer's; local history too.
  const terminals = ctx.remote ? [] : tabsIn(w);
  const changes = `${w.changes} uncommitted change${w.changes === 1 ? '' : 's'}`;
  const body = [
    w.changes ? (ctx.remote ? `Its ${changes} will be lost.` : `Its ${changes} ${w.changes === 1 ? 'is' : 'are'} kept in Local history first.`) : '',
    terminals.length ? `${terminals.length === 1 ? 'Its terminal closes' : `Its ${terminals.length} terminals close`}.` : '',
    w.branch ? `The branch ${w.branch} stays.` : '',
  ].filter(Boolean).join(' ');
  if (!await confirmDialog({ title: `Remove the worktree ${folderName(w.path)}?`, body, confirm: 'Remove worktree' })) return;
  for (const t of terminals) closeTab(t);
  if (terminals.length) await new Promise(r => setTimeout(r, CLOSE_GRACE_MS));
  try {
    await ctx.ask(PAGE.gitviewWorktreeRemove, { root: ctx.root, path: w.path, force: w.changes > 0 });
    toastHere({ text: `Removed the worktree ${folderName(w.path)}`, state: TOAST.done });
    await ctx.refresh();
  } catch (e) {
    ctx.showError(/** @type {Error} */ (e).message);
  }
}

/**
 * A worktree's buttons on the right; true when the click was one.
 * @param {Element} t what was clicked
 * @param {Worktree | null | undefined} w
 * @param {CleanupContext} ctx
 */
export function worktreeClicked(t, w, ctx) {
  if (!w) return false;
  if (t.closest('[data-wt-terminal]') && !ctx.remote) return newTab({ cwd: w.path }), true;
  if (t.closest('[data-wt-remove]')) return removeWorktree(w, ctx), true;
  return false;
}

/**
 * A candidate's line in the dialog: ticked when its work is done (merged or gone with nothing of its own).
 * @param {PruneCandidate} b
 * @param {number} k
 */
function candidateHtml(b, k) {
  const done = b.reasons.includes(PRUNE_REASON.merged) || (b.reasons.includes(PRUNE_REASON.gone) && !b.unmerged);
  const why = b.reasons.map(r => REASON_WORDS[r] ?? r).join(', ');
  const own = b.unmerged ? `, ${b.unmerged} commit${b.unmerged === 1 ? '' : 's'} only on it` : '';
  return `<label class="dialog-check gw-prune-row"><input type="checkbox" data-k="${k}"${done ? ' checked' : ''}>`
    + `<span class="gw-prune-name">${escapeHtml(b.name)}</span><span class="gw-prune-why">${escapeHtml(why + own)}, ${ago(b.lastDate)}</span></label>`;
}

/**
 * Undo for a clean-up: each branch back where it was.
 * @param {CleanupContext} ctx
 * @param {string[]} backups
 */
async function putBranchesBack(ctx, backups) {
  try {
    for (const id of backups) await ctx.ask(PAGE.gitviewBackupRestore, { root: ctx.root, id });
    await ctx.refresh();
  } catch (e) {
    ctx.showError(/** @type {Error} */ (e).message);
  }
}

/**
 * Clean up branches: the candidates, ticked when their work is done, and Delete for the ones ticked, with Undo.
 * @param {CleanupContext} ctx
 */
export async function openPrune(ctx) {
  /** @type {{ base: string, branches: PruneCandidate[] }} */
  let found;
  try {
    found = await ctx.ask(PAGE.gitviewPruneCandidates, { root: ctx.root });
  } catch (e) {
    return ctx.showError(/** @type {Error} */ (e).message);
  }
  const list = found.branches;
  const rows = list.length ? list.map(candidateHtml).join('') : '<p>Nothing to clean up: every branch has work of its own.</p>';
  return modal(`${CONFIRM_DIALOG} ${PRUNE_DIALOG}`, `<h3>Clean up branches</h3>
    <p class="dialog-sub">Compared with ${escapeHtml(found.base)}. Each one deleted is kept 30 days in Local history, and Undo puts them back.</p>
    <div class="gw-prune-list">${rows}</div>
    <p class="dialog-error" data-error hidden></p>
    <div class="dialog-actions"><button class="btn" data-cancel data-no-enter>Cancel</button><button class="btn danger" data-ok${list.length ? '' : ' disabled'}>Delete</button></div>`,
  (dialog, close) => ({
    submit: async () => {
      const picked = [...dialog.querySelectorAll('[data-k]:checked')].map(el => list[Number(/** @type {HTMLElement} */ (el).dataset.k)].name);
      if (!picked.length) return showError(find(dialog, '[data-error]'), 'Tick the branches to delete.');
      try {
        const { deleted, backups } = await ctx.ask(PAGE.gitviewPruneBranches, { root: ctx.root, branches: picked });
        close(true);
        await ctx.refresh();
        toastHere({ text: `Deleted ${deleted.length} branch${deleted.length === 1 ? '' : 'es'}`, state: TOAST.done, action: { label: UNDO, run: () => putBranchesBack(ctx, backups) } });
      } catch (e) {
        showError(find(dialog, '[data-error]'), /** @type {Error} */ (e).message);
      }
    },
  }));
}
