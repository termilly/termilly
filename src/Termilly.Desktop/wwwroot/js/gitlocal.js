// @ts-check
// The Git window's Local history tab (js/gitwindow.js draws its list with the rows made here): the snapshots of
// uncommitted work the host kept (js/gitsafety.js), newest first, and the branches it backed up before deleting or
// moving them. A snapshot shows its files, each to put back as it was, or all of them; putting back keeps what was
// there first, so Undo brings it back. A backup puts its branch back.

import { PAGE } from './protocol.js';
import { SNAPSHOT_REASON, BACKUP_EVENT } from './constants.js';
import { escapeHtml } from './ui.js';
import { targetOf } from './dom.js';
import { ago } from './gitsearch.js';
import { toastHere, TOAST, UNDO } from './toasts.js';
import { LOADING } from './gitissues.js';

/** @typedef {import('./gitsafety.js').Snapshot} Snapshot */
/** @typedef {{ id: string, at: string, event: string, branch: string, hash: string, subject: string }} Backup */
/**
 * What the tab works with from the window: its ask, the repository, what to do after a change, git's errors.
 * @typedef {{ ask: import('./gitsafety.js').Ask, root: string, refresh: () => unknown, showError: (text: string) => unknown }} LocalContext
 */

/**
 * A row of the tab.
 * @typedef {{ kind: 'snapshot', snapshot: Snapshot } | { kind: 'backup', backup: Backup }
 *   | { kind: 'localHeading', label: string, count: number }} LocalItem
 */

/** The tab's row kinds, so gitwindow.js can tell them apart. */
export const LOCAL_ITEM = Object.freeze({ snapshot: 'snapshot', backup: 'backup', heading: 'localHeading' });

/** Why a snapshot was taken, in words. @type {Readonly<Record<string, string>>} */
const REASON_WORDS = Object.freeze({
  [SNAPSHOT_REASON.timer]: 'Kept while an agent worked',
  [SNAPSHOT_REASON.agentStart]: 'Before an agent started',
  [SNAPSHOT_REASON.beforeDiscard]: 'Before changes were thrown away',
  [SNAPSHOT_REASON.beforeRestore]: 'Before putting back a snapshot',
  [SNAPSHOT_REASON.beforeRemove]: 'Before a worktree was removed',
  [SNAPSHOT_REASON.manual]: 'Kept by hand',
});
/** What a backup was taken before, in words. @type {Readonly<Record<string, string>>} */
const EVENT_WORDS = Object.freeze({
  [BACKUP_EVENT.prune]: 'Before cleaning up branches',
  [BACKUP_EVENT.undoCommit]: 'Before undoing a commit',
});

/** What the tab has loaded. */
export const local = {
  /** @type {Snapshot[]} */
  snapshots: [],
  /** @type {Backup[]} */
  backups: [],
  loaded: false,
  /** @type {string | null} */
  error: null,
};

let asked = 0;

/**
 * Loads the snapshots and backups; true when this was the latest asking.
 * @param {LocalContext} ctx
 */
export async function loadLocal(ctx) {
  const mine = ++asked;
  try {
    const [snapshots, backups] = await Promise.all([ctx.ask(PAGE.gitviewSnapshots, { root: ctx.root }), ctx.ask(PAGE.gitviewBackups, { root: ctx.root })]);
    if (mine !== asked) return false;
    Object.assign(local, { snapshots, backups, loaded: true, error: null });
  } catch (e) {
    if (mine !== asked) return false;
    Object.assign(local, { snapshots: [], backups: [], loaded: true, error: /** @type {Error} */ (e).message });
  }
  return true;
}

/** Forgets what was loaded (another repository, the window closed, Refresh). */
export function resetLocal() {
  asked++;
  Object.assign(local, { snapshots: [], backups: [], loaded: false, error: null });
}

/**
 * The list's rows: the snapshots, then the branch backups under their heading.
 * @returns {LocalItem[]}
 */
export function localItems() {
  return /** @type {LocalItem[]} */ ([
    ...local.snapshots.map(snapshot => ({ kind: LOCAL_ITEM.snapshot, snapshot })),
    ...(local.backups.length ? [{ kind: LOCAL_ITEM.heading, label: 'Branch backups', count: local.backups.length }] : []),
    ...local.backups.map(backup => ({ kind: LOCAL_ITEM.backup, backup })),
  ]);
}

/** What the list says with no rows. */
export const localEmptyText = () => local.error
  ?? (local.loaded ? 'Nothing kept yet. Uncommitted work is kept here before an agent starts, every 10 minutes while one works, and before anything is thrown away.' : LOADING);

/** @param {string} iso */
const when = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * A row of the tab.
 * @param {LocalItem} item
 * @param {number} i
 * @param {boolean} selected
 */
export function localRowHtml(item, i, selected) {
  const sel = selected ? ' selected' : '';
  if (item.kind === 'localHeading') {
    return `<div class="cw-row gw-section open" data-i="${i}"><span class="cw-chev"></span><span class="cw-name">${escapeHtml(item.label)}</span><span class="cw-count">${item.count}</span></div>`;
  }
  if (item.kind === 'snapshot') {
    const s = item.snapshot;
    const n = s.files.length;
    return `<div class="cw-row gw-commit${sel}" data-i="${i}" role="option"><span class="gw-commit-main"><span class="gw-subject">${escapeHtml(when(s.at))}</span>${s.branch ? `<span class="gw-ref">${escapeHtml(s.branch)}</span>` : ''}</span>`
      + `<span class="gw-commit-meta"><span>${escapeHtml(REASON_WORDS[s.reason] ?? s.reason)}</span><span>${n} file${n === 1 ? '' : 's'}</span><span>${ago(s.at)}</span></span></div>`;
  }
  const b = item.backup;
  return `<div class="cw-row gw-commit${sel}" data-i="${i}" role="option"><span class="gw-commit-main"><span class="gw-subject">${escapeHtml(b.branch)}</span></span>`
    + `<span class="gw-commit-meta"><span>${escapeHtml(EVENT_WORDS[b.event] ?? b.event)}</span><span>${escapeHtml(b.subject)}</span><span>${ago(b.at)}</span></span></div>`;
}

/**
 * A snapshot on the right: its files, each to put back, and all of them.
 * @param {Snapshot} s
 */
export function snapshotHtml(s) {
  const files = s.files.map((f, k) => `<div class="cw-row gw-file gw-local-file" data-local-file="${k}" title="${escapeHtml(f.path)}"><span class="gw-status" data-s="${escapeHtml(f.status)}">${escapeHtml(f.status)}</span><span class="cw-name">${escapeHtml(f.path)}</span><button class="btn small" data-local-restore="${k}">Put back</button></div>`).join('');
  const skipped = s.skipped ? `<p class="gw-local-note">${s.skipped} file${s.skipped === 1 ? ' was' : 's were'} too big to keep.</p>` : '';
  return `<div class="gw-commit-info"><div class="gw-commit-subject">${escapeHtml(when(s.at))}</div>`
    + `<div class="gw-commit-facts"><span>${escapeHtml(REASON_WORDS[s.reason] ?? s.reason)}</span>${s.branch ? `<span>on ${escapeHtml(s.branch)}</span>` : ''}<button class="btn small" data-local-restore-all>Put all back</button></div></div>`
    + `<div class="gw-local-files">${files || '<div class="gw-empty">It had no changes to the last commit.</div>'}${skipped}</div>`;
}

/**
 * A branch backup on the right: where the branch was, and the way to put it back.
 * @param {Backup} b
 */
export const backupHtml = b => `<div class="gw-commit-info"><div class="gw-commit-subject">${escapeHtml(b.branch)}</div>`
  + `<div class="gw-commit-facts"><span>${escapeHtml(EVENT_WORDS[b.event] ?? b.event)}, ${escapeHtml(when(b.at))}</span><span class="gw-hash">${escapeHtml(b.hash.slice(0, 7))}</span><span>${escapeHtml(b.subject)}</span><button class="btn small" data-local-branch>Restore branch</button></div></div>`;

/**
 * Puts a snapshot's files back (all of them, or some), with Undo: the snapshot restoring took of what was there.
 * @param {LocalContext} ctx
 * @param {Snapshot} s
 * @param {string[] | null} paths
 */
async function putBack(ctx, s, paths) {
  try {
    const { before } = await ctx.ask(PAGE.gitviewSnapshotRestore, { root: ctx.root, id: s.id, paths });
    await ctx.refresh();
    const what = paths?.length === 1 ? paths[0].split('/').pop() : 'The files';
    toastHere({
      text: `${what} put back as they were ${ago(s.at)}`, state: TOAST.done,
      action: before ? { label: UNDO, run: () => ctx.ask(PAGE.gitviewSnapshotRestore, { root: ctx.root, id: before, paths }).then(() => ctx.refresh(), e => ctx.showError(e.message)) } : null,
    });
  } catch (e) {
    ctx.showError(/** @type {Error} */ (e).message);
  }
}

/**
 * The right side's buttons for a snapshot or a backup; true when the click was the tab's.
 * @param {MouseEvent} e
 * @param {{ snapshot?: Snapshot, backup?: Backup } | null} shown
 * @param {LocalContext} ctx
 */
export function localClicked(e, shown, ctx) {
  const t = targetOf(e);
  if (shown?.snapshot) {
    const s = shown.snapshot;
    if (t.closest('[data-local-restore-all]')) return putBack(ctx, s, null), true;
    const one = /** @type {HTMLElement | null} */ (t.closest('[data-local-restore]'));
    if (one) return putBack(ctx, s, [s.files[Number(one.dataset.localRestore)].path]), true;
  }
  if (shown?.backup && t.closest('[data-local-branch]')) {
    const b = shown.backup;
    ctx.ask(PAGE.gitviewBackupRestore, { root: ctx.root, id: b.id })
      .then(({ branch }) => {
        toastHere({ text: `Branch ${branch} is back`, state: TOAST.done });
        return ctx.refresh();
      }, err => ctx.showError(err.message));
    return true;
  }
  return false;
}
