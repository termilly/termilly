// @ts-check
// Staging part of a file, in the Git window's diff (js/gitwindow.js): each block of changed lines gets Stage and
// Discard (Unstage on the staged side), and clicking line numbers picks single lines (shift for a run), with a bar
// to stage or discard just those. The page only says which lines, by the numbers the host's diff gave them (a line's
// number before for a removed one, after for an added one); the host works out the new text itself (gitview:
// stageLines). Discarding keeps the lines in local history first, so it offers Undo.

import { PAGE } from './protocol.js';
import { DIFF_ROW, DIFF_LINE_NO, DIFF_ROWS } from './diffrows.js';
import { DIFF_SIDE, STAGE_LINE_ACTION, CHANGE_KIND } from './constants.js';
import { escapeHtml } from './ui.js';
import { targetOf } from './dom.js';
import { toastHere, TOAST, UNDO } from './toasts.js';
import { undoDiscard } from './gitsafety.js';

/** @typedef {import('./diffrows.js').DiffRow} DiffRow */
/**
 * The lines picked: removed ones by their number before, added ones by their number after.
 * @typedef {{ removed: number[], added: number[] }} PickedLines
 */
/**
 * What staging needs from the window: its ask, the file, the diff's side, and what to do after.
 * @typedef {{ ask: import('./gitsafety.js').Ask, root: string, path: string, side: string, refresh: () => unknown,
 *   showError: (text: string) => unknown }} StageContext
 */

/** Taking a file's or its lines' changes out of the next commit. */
export const UNSTAGE_LABEL = 'Unstage';
/** A drawn line's own data (its kind and numbers), set on it here. */
const LINE = '[data-l]';
/** A picked line's class (git.css). */
const PICKED = 'picked';
/** A block's buttons, before its first line. */
const BLOCK_BAR = 'gw-hunk-bar';
/** The bar for the lines picked, over the diff. */
const PICK_BAR = 'gw-pick-bar';

/**
 * One drawn line's change: removed (its number before) or added (its number after); null for an unchanged one.
 * Side by side, a row is two halves, each its own line.
 * @param {DiffRow} row
 * @returns {Array<{ removed?: number, added?: number }>}
 */
function changesOf(row) {
  if (row.t === DIFF_ROW.del && row.a) return [{ removed: row.a }];
  if (row.t === DIFF_ROW.add && row.b) return [{ added: row.b }];
  if (row.t !== DIFF_ROW.pair) return [];
  const out = [];
  if (row.left?.kind === DIFF_ROW.del && row.left.no) out.push({ removed: row.left.no });
  if (row.right?.kind === DIFF_ROW.add && row.right.no) out.push({ added: row.right.no });
  return out;
}

/**
 * The blocks of changed lines: runs of rows with changes, each with every line it changes.
 * @param {DiffRow[]} rows
 * @returns {Array<{ first: number, lines: PickedLines }>}
 */
export function changeBlocks(rows) {
  /** @type {Array<{ first: number, lines: PickedLines }>} */
  const blocks = [];
  /** @type {{ first: number, lines: PickedLines } | null} */
  let open = null;
  rows.forEach((row, i) => {
    const changes = changesOf(row);
    if (!changes.length) {
      open = null;
      return;
    }
    if (!open) blocks.push(open = { first: i, lines: { removed: [], added: [] } });
    for (const c of changes) {
      if (c.removed) open.lines.removed.push(c.removed);
      if (c.added) open.lines.added.push(c.added);
    }
  });
  return blocks;
}

/** @param {string} side */
const actionsOf = side => (side === DIFF_SIDE.staged
  ? [[STAGE_LINE_ACTION.unstage, UNSTAGE_LABEL]]
  : [[STAGE_LINE_ACTION.stage, 'Stage'], [STAGE_LINE_ACTION.discard, 'Discard']]);

/**
 * @param {string} side
 * @param {string} attr the buttons' data attribute
 */
const buttonsHtml = (side, attr) => actionsOf(side)
  .map(([action, label]) => `<button class="btn small${action === STAGE_LINE_ACTION.discard ? ' danger-outline' : ''}" ${attr}="${action}">${label}</button>`).join('');

/**
 * Marks the drawn lines with their changes and puts a bar before each block. The rows are the ones just drawn into
 * `rowsEl`, one element each, in order.
 * @param {HTMLElement} rowsEl
 * @param {DiffRow[]} rows
 * @param {string} side
 */
function decorate(rowsEl, rows, side) {
  const els = /** @type {HTMLElement[]} */ ([...rowsEl.children]);
  rows.forEach((row, i) => {
    const el = els[i];
    if (!el) return;
    if (row.t === DIFF_ROW.pair) {
      const halves = el.querySelectorAll('.pv-half');
      changesOf(row).forEach(c => {
        const half = /** @type {HTMLElement | undefined} */ (c.removed ? halves[0] : halves[1]);
        if (half) half.dataset.l = c.removed ? `r${c.removed}` : `a${c.added}`;
      });
      return;
    }
    const [c] = changesOf(row);
    if (c) el.dataset.l = c.removed ? `r${c.removed}` : `a${c.added}`;
  });
  // Each changed line's number is a box to tick, from the keyboard too.
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (rowsEl.querySelectorAll(LINE))) {
    const no = /** @type {HTMLElement | null} */ (el.querySelector(DIFF_LINE_NO));
    if (!no) continue;
    const l = /** @type {string} */ (el.dataset.l);
    Object.assign(no, { tabIndex: 0 });
    no.setAttribute('role', 'checkbox');
    no.setAttribute('aria-checked', String(false));
    no.setAttribute('aria-label', `${l[0] === 'r' ? 'Removed' : 'Added'} line ${l.slice(1)}`);
  }
  changeBlocks(rows).forEach((block, k) => {
    els[block.first]?.insertAdjacentHTML('beforebegin', `<div class="${BLOCK_BAR}" data-block="${k}">${buttonsHtml(side, 'data-block-act')}</div>`);
  });
}

/**
 * The lines picked in the diff, by their numbers.
 * @param {HTMLElement} target
 * @returns {PickedLines}
 */
function pickedLines(target) {
  /** @type {PickedLines} */
  const lines = { removed: [], added: [] };
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (target.querySelectorAll(`${LINE}.${PICKED}`))) {
    const l = /** @type {string} */ (el.dataset.l);
    (l[0] === 'r' ? lines.removed : lines.added).push(Number(l.slice(1)));
  }
  return lines;
}

/**
 * The bar over the diff while lines are picked; gone when none are.
 * @param {HTMLElement} target
 * @param {string} side
 */
function showPickBar(target, side) {
  const { removed, added } = pickedLines(target);
  const n = removed.length + added.length;
  target.querySelector(`.${PICK_BAR}`)?.remove();
  if (!n) return;
  const what = `${n} line${n === 1 ? '' : 's'}`;
  const labels = actionsOf(side).map(([action, label]) => `<button class="btn small${action === STAGE_LINE_ACTION.discard ? ' danger-outline' : ''}" data-pick-act="${action}">${escapeHtml(label)} ${what}</button>`).join('');
  target.querySelector('.gw-diff-head')?.insertAdjacentHTML('afterend', `<div class="${PICK_BAR}"><span>${what} picked</span>${labels}<button class="link-btn" data-pick-clear>Clear</button></div>`);
}

/**
 * Runs an action on some lines; after a discard, a note with Undo (local history kept them).
 * @param {StageContext} ctx
 * @param {string} action
 * @param {PickedLines} lines
 */
async function run(ctx, action, lines) {
  const n = lines.removed.length + lines.added.length;
  /** @type {{ kept?: string | null }} */
  let done;
  try {
    done = await ctx.ask(PAGE.gitviewStageLines, { root: ctx.root, path: ctx.path, side: ctx.side, action, ...lines });
  } catch (e) {
    return ctx.showError(/** @type {Error} */ (e).message);
  }
  await ctx.refresh();
  if (action !== STAGE_LINE_ACTION.discard) return;
  const { kept } = done;
  toastHere({
    text: `Discarded ${n} line${n === 1 ? '' : 's'}`, state: TOAST.done,
    action: kept ? { label: UNDO, run: () => undoDiscard(ctx.ask, ctx.root, kept, [ctx.path]).then(() => ctx.refresh(), e => ctx.showError(e.message)) } : null,
  });
}

/** The line picked last, for a shift-click's run. */
let lastPicked = -1;

/**
 * A click on a line's number picks it (shift: the run from the last one picked); a block's or the bar's button acts.
 * True when the click was staging's.
 * @param {MouseEvent} e
 * @param {HTMLElement} target the diff's element
 * @param {DiffRow[]} rows
 * @param {StageContext} ctx
 */
export function stagingClicked(e, target, rows, ctx) {
  const t = targetOf(e);
  const blockAct = /** @type {HTMLElement | null} */ (t.closest('[data-block-act]'));
  if (blockAct) {
    const k = Number(/** @type {HTMLElement} */ (blockAct.closest('[data-block]')).dataset.block);
    run(ctx, /** @type {string} */ (blockAct.dataset.blockAct), changeBlocks(rows)[k].lines);
    return true;
  }
  const pickAct = /** @type {HTMLElement | null} */ (t.closest('[data-pick-act]'));
  if (pickAct) {
    run(ctx, /** @type {string} */ (pickAct.dataset.pickAct), pickedLines(target));
    return true;
  }
  if (t.closest('[data-pick-clear]')) {
    clearPicked(target, ctx.side);
    return true;
  }
  const line = /** @type {HTMLElement | null} */ (t.closest(DIFF_LINE_NO)?.closest(LINE) ?? null);
  if (!line) return false;
  pickLine(line, e.shiftKey, target, ctx.side);
  return true;
}

/**
 * Picks a line, or lets it go; with shift, the run from the line picked last.
 * @param {HTMLElement} line
 * @param {boolean} run
 * @param {HTMLElement} target
 * @param {string} side
 */
function pickLine(line, run, target, side) {
  const all = /** @type {HTMLElement[]} */ ([...target.querySelectorAll(LINE)]);
  const at = all.indexOf(line);
  if (run && lastPicked >= 0) {
    for (let i = Math.min(at, lastPicked); i <= Math.max(at, lastPicked); i++) all[i].classList.add(PICKED);
  } else {
    line.classList.toggle(PICKED);
  }
  for (const el of all) el.querySelector(DIFF_LINE_NO)?.setAttribute('aria-checked', String(el.classList.contains(PICKED)));
  lastPicked = at;
  showPickBar(target, side);
}

/**
 * Space or Enter on a line's number picks it, as a click does (shift: the run). True when the key was staging's.
 * @param {KeyboardEvent} e
 * @param {HTMLElement} target
 * @param {string} side
 */
export function stagingKey(e, target, side) {
  if (e.key !== ' ' && e.key !== 'Enter') return false;
  const line = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.(DIFF_LINE_NO)?.closest(LINE) ?? null);
  if (!line || !target.contains(line)) return false;
  e.preventDefault();
  pickLine(line, e.shiftKey, target, side);
  return true;
}

/**
 * Lets go of the lines picked.
 * @param {HTMLElement} target
 * @param {string} side
 */
export function clearPicked(target, side) {
  for (const el of target.querySelectorAll(`.${PICKED}`)) el.classList.remove(PICKED);
  for (const no of target.querySelectorAll('[aria-checked="true"]')) no.setAttribute('aria-checked', String(false));
  lastPicked = -1;
  showPickBar(target, side);
}

/**
 * Whether a diff can be staged in parts: a changed file's (not a new, deleted or renamed one), shown as a diff.
 * @param {string} side
 * @param {string} kind its CHANGE_KIND
 * @param {boolean} renamed
 */
export const canStageParts = (side, kind, renamed) => (side === DIFF_SIDE.unstaged || side === DIFF_SIDE.staged) && kind === CHANGE_KIND.modified && !renamed;

/**
 * Sets the drawn diff up for staging in parts.
 * @param {HTMLElement} target
 * @param {DiffRow[]} rows
 * @param {string} side
 */
export function setUpStaging(target, rows, side) {
  const rowsEl = /** @type {HTMLElement | null} */ (target.querySelector(DIFF_ROWS));
  if (!rowsEl) return;
  lastPicked = -1;
  decorate(rowsEl, rows, side);
}
