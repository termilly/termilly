// @ts-check
// What the Git window does to the repository from a right click (js/gitwindow.js): a file's menu (stage, unstage,
// restore, delete, ignore, its history, copy its path), a branch's (switch to it), and running each action, with Undo
// for what a Restore or Delete threw away (local history kept it first).

import { PAGE } from './protocol.js';
import { emit, EVENTS } from './store.js';
import { showMenu, SEPARATOR } from './popups.js';
import { confirmDialog } from './dialogs.js';
import { GIT_ACTION } from './constants.js';
import { targetOf } from './dom.js';
import { ITEM } from './gitsearch.js';
import { undoDiscard } from './gitsafety.js';
import { toastHere, TOAST, UNDO } from './toasts.js';
import { UNSTAGE_LABEL } from './gitstage.js';
import { gw, ui, ask, askHere, repoNow } from './gitwindowstate.js';
import { els, ROW, SIDE, showGitError } from './gitwindowparts.js';
import { switchLabel } from './gitdetails.js';
import { openItem } from './gitlist.js';
import { showPathHistory } from './gitloaders.js';
import { systemClipboard } from './sysclipboard.js';

/** @typedef {import('./gitwindowstate.js').FileItem} FileItem */
/** @typedef {import('./gitwindowstate.js').Branch} Branch */

const RESTORE_LABEL = 'Restore';
const STAGE_LABEL = 'Stage';
const DELETE_LABEL = 'Delete';
const { listEl, rightEl } = els;

/**
 * Runs an action on the repository (GitView.Act), then looks again. git's refusal (a switch that would overwrite
 * changes, a branch that already exists) opens in a popup, in its own words.
 * @param {string} action
 * @param {{ path?: string, ref?: string }} [extra]
 */
export async function act(action, extra) {
  const { root, hasCommits } = repoNow();
  const on = askHere();
  /** @type {{ kept?: string | null } | null} */
  let done = null;
  try {
    done = await ask(PAGE.gitviewAct, { root, action, hasCommits: hasCommits !== false, ...extra });
  } catch (e) {
    await showGitError(/** @type {Error} */ (e).message);
  }
  emit(EVENTS.gitChanged); // the sidebar's chips (gitstatus.js)
  await ui.refresh();
  // What a Restore or Delete threw away was kept in local history first: Undo puts it back.
  const kept = done?.kept;
  const path = extra?.path;
  if (!kept || !path) return;
  toastHere({
    text: `${action === GIT_ACTION.delete ? 'Deleted' : 'Restored'} ${path.split('/').pop()}`, state: TOAST.done,
    action: { label: UNDO, run: () => undoDiscard(on, root, kept, [path]).then(() => ui.refresh(), e => showGitError(e.message)) },
  });
}

/** Whether what a Restore or Delete throws away comes back: local history keeps it on this computer only. */
const undoNote = () => (gw.server ? 'This can\x27t be undone.' : 'Local history keeps a copy first, so Undo brings it back.');

/**
 * Asks before an action that throws something away, then runs it.
 * @param {string} title
 * @param {string} body
 * @param {string} confirm
 * @param {string} action
 * @param {string} path
 */
const askThenAct = async (title, body, confirm, action, path) => {
  if (await confirmDialog({ title, body, confirm })) act(action, { path });
};

/**
 * A file's own entries: its history and its folder's (only what git has: an untracked file has none), and its path.
 * @param {FileItem} item
 */
function fileEntries(item) {
  const { root } = repoNow();
  const sep = gw.server || !root.includes('\\') ? '/' : '\\';
  const where = root.replace(/[\\/]+$/, '') + sep + item.path.split('/').join(sep);
  const folder = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : null;
  const histories = item.side === SIDE.untracked ? [] : [
    { label: 'History of this file', action: () => showPathHistory(item.path) },
    ...(folder ? [{ label: 'History of its folder', action: () => showPathHistory(folder) }] : []),
  ];
  return [...histories, { label: 'Copy path', action: () => systemClipboard().writeText(where) }];
}

/**
 * What a changed, staged, untracked or conflicted file's menu offers.
 * @param {FileItem} item
 * @returns {import('./popups.js').MenuEntry[]}
 */
function fileMenu(item) {
  const name = item.path.split('/').pop();
  const { path } = item;
  const own = fileEntries(item);
  if (item.conflict) return [{ label: 'Mark as resolved', action: () => act(GIT_ACTION.stage, { path }) }, SEPARATOR, ...own];
  if (item.side === SIDE.staged) {
    const restore = item.status !== 'A' && repoNow().hasCommits !== false ? [{
      label: RESTORE_LABEL, danger: true,
      action: () => askThenAct(`Restore ${name}?`, `Its staged and unsaved changes are undone, back to the last commit. ${undoNote()}`, RESTORE_LABEL, GIT_ACTION.discardAll, path),
    }] : [];
    return [{ label: UNSTAGE_LABEL, action: () => act(GIT_ACTION.unstage, { path }) }, ...restore, SEPARATOR, ...own];
  }
  if (item.side === SIDE.untracked) {
    return [
      { label: STAGE_LABEL, action: () => act(GIT_ACTION.stage, { path }) },
      { label: 'Add to .gitignore', action: () => act(GIT_ACTION.ignore, { path }) },
      {
        label: DELETE_LABEL, danger: true,
        action: () => askThenAct(`Delete ${name}?`, gw.server ? 'git doesn\'t have this file, so it can\'t be brought back.' : undoNote(), DELETE_LABEL, GIT_ACTION.delete, path),
      },
      SEPARATOR, ...own,
    ];
  }
  return [
    { label: STAGE_LABEL, action: () => act(GIT_ACTION.stage, { path }) },
    {
      label: RESTORE_LABEL, danger: true,
      action: () => askThenAct(`Restore ${name}?`, `Its changes that aren't staged are undone. ${undoNote()}`, RESTORE_LABEL, GIT_ACTION.discard, path),
    },
    SEPARATOR, ...own,
  ];
}

/**
 * @param {Branch} b
 * @returns {import('./popups.js').MenuEntry[]}
 */
const branchMenu = b => [{ label: switchLabel(b), action: () => act(GIT_ACTION.switch, { ref: b.ref }) }];

listEl.addEventListener('contextmenu', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
  const item = row && gw.items[Number(row.dataset.i)];
  if (!item || (item.kind !== ITEM.file && item.kind !== ITEM.branch)
    || /** @type {{ branch?: Branch }} */ (item).branch?.current) return;
  e.preventDefault();
  openItem(Number(/** @type {HTMLElement} */ (row).dataset.i));
  showMenu(item.kind === ITEM.file ? fileMenu(item) : branchMenu(item.branch), { x: e.clientX, y: e.clientY }, { className: 'git-menu' });
});

// A branch's Switch button on the right.
rightEl.addEventListener('click', e => {
  const sel = gw.selection;
  if (targetOf(e).closest('[data-switch-branch]') && sel?.kind === ITEM.branch) act(GIT_ACTION.switch, { ref: sel.ref });
});
