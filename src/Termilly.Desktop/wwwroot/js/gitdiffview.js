// @ts-check
// A file's diff in the Git window (js/gitwindow.js): staged, unstaged or untracked (Changes), or in a commit, drawn
// with the change preview's rows (js/diffrows.js), its folds opened on a click, Wrap, what a search found marked, and
// blocks and lines to stage on their own (js/gitstage.js).

import { PAGE } from './protocol.js';
import { state, on, EVENTS } from './store.js';
import { toggleWrap } from './preview.js';
import { imagesHtml, measureImages } from './pictures.js';
import { escapeHtml } from './ui.js';
import { buildDiffRows, diffRowHtml, DIFF_SCROLL } from './diffrows.js';
import { SETTING_VALUES, CHANGE_KIND } from './constants.js';
import { find, targetOf } from './dom.js';
import { ITEM, searching, markInDiff } from './gitsearch.js';
import { canStageParts, setUpStaging, stagingClicked } from './gitstage.js';
import { gw, ask, repoNow } from './gitwindowstate.js';
import { els, isOpen, useRight, SIDE, CONFLICT_LABEL } from './gitwindowparts.js';
import { stageContext } from './gitcontexts.js';

/** @typedef {import('./gitwindowstate.js').GitDiff} GitDiff */
/** @typedef {import('./gitwindowstate.js').ShownFile} ShownFile */
/** @typedef {import('./gitwindowstate.js').DiffState} DiffState */

/** The choices of the settings used here (C#'s SettingValues). */
const { changeLayout, changeNewFile, changeView } = SETTING_VALUES;
/** Rows drawn at most for one diff; a longer one says how much is left out. */
const MAX_ROWS = 6000;
const { rightEl } = els;

/**
 * Whether two of the host's diffs of a file say the same (nothing changed between two looks).
 * @param {GitDiff} a
 * @param {GitDiff} b
 */
const sameDiff = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @param {ShownFile} item */
const sideLabel = item => (item.conflict ? CONFLICT_LABEL : /** @type {Record<string, string>} */ (
  { staged: 'Staged', unstaged: 'Not staged', untracked: 'Untracked' })[/** @type {string} */ (item.side)]);

/**
 * A file's diff: staged, unstaged or untracked (Changes), or in a commit.
 * @param {ShownFile} item
 * @param {{ keepScroll?: boolean, inCommit?: string | null, find?: import('./gitwindowstate.js').Find | null }} [options]
 */
export async function showFile(item, { keepScroll = false, inCommit = null, find: hit = null } = {}) {
  if (!inCommit) useRight(false);
  gw.selection = inCommit ? gw.selection : { kind: ITEM.file, side: item.side, path: item.path };
  const request = { root: repoNow().root, path: item.path, oldPath: item.oldPath ?? null, side: inCommit ? SIDE.commit : item.side, hash: inCommit };
  const scroll = keepScroll ? rightEl.querySelector(DIFF_SCROLL)?.scrollTop ?? 0 : 0;
  const target = inCommit ? rightEl.querySelector('.gw-commit-diff') : rightEl;
  if (!target) return;
  if (!keepScroll) target.innerHTML = '<div class="gw-message">Loading</div>';
  /** @type {GitDiff} */
  let data;
  try {
    data = await ask(PAGE.gitviewDiff, request);
  } catch (e) {
    target.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
    return;
  }
  // Looked at again (a command ended, the window came back) and the same: it stays as drawn, with its folds open and
  // the lines picked for staging still picked.
  const shown = gw.diffState;
  if (keepScroll && shown?.target === target && shown.request.path === request.path
    && shown.request.side === request.side && sameDiff(shown.data, data)) return;
  // A refresh keeps how the file was shown, and what was found in it.
  gw.diffState = { request, data, expanded: new Set(), target, label: inCommit ? null : sideLabel(item), find: keepScroll ? shown?.find ?? null : hit };
  const at = drawDiff();
  if (scroll) find(target, DIFF_SCROLL).scrollTop = scroll;
  else at?.scrollIntoView({ block: 'center' });
}

/**
 * The diff's head: which side, the path, a new or deleted file's badge, and its line counts.
 * @param {GitDiff} data
 * @param {string | null} label
 */
const headHtml = (data, label) => `<div class="gw-diff-head">${label ? `<span class="gw-side-label">${escapeHtml(label)}</span>` : ''}`
  + `<span class="gw-diff-path" title="${escapeHtml(data.path)}">${escapeHtml(data.display ?? data.path)}</span>`
  + `${data.kind !== CHANGE_KIND.modified ? `<span class="pv-badge" data-kind="${data.kind}">${data.kind === CHANGE_KIND.created ? 'new' : data.kind}</span>` : ''}`
  + `<span class="pv-stats">${data.added || data.removed ? `<span class="pv-plus">+${data.added}</span> <span class="pv-minus">−${data.removed}</span>` : ''}</span>`;

/**
 * Draws the diff in hand (gw.diffState). While searching, what was found is marked: the result is where to scroll.
 * @returns {Element | null}
 */
export function drawDiff() {
  const shown = /** @type {DiffState} */ (gw.diffState);
  const { data, expanded, target, label, find: hit } = shown;
  const wholeFile = !!hit?.wholeFile;
  const sideBySide = state.settings.changes.layout === changeLayout.sideBySide && !wholeFile;
  // The change preview's setting: one choice for both (its Wrap button and this one flip it).
  const wrap = !!state.settings.changes.wrap;
  // A file whose lines didn't change (a rename, a mode change) is shown as it is rather than folded away whole.
  const unchanged = data.kind === CHANGE_KIND.modified && data.ops?.length === 1 && data.ops[0][0] === 0;
  const whole = unchanged || ((data.kind === CHANGE_KIND.created || data.kind === CHANGE_KIND.deleted) && state.settings.changes.newFile !== changeNewFile.diff);
  const message = data.error ?? (data.note && data.before == null && data.after == null ? data.note
    : !data.ops?.length && (data.before || data.after) == null ? 'The file is empty.' : null);
  const head = headHtml(data, label);
  const wrapButton = `<span class="seg pv-seg"><button class="${wrap ? 'on' : ''}" data-gw-wrap title="Wrap long lines">Wrap</button></span>`;
  const pictures = imagesHtml(data);
  // A binary image is only its pictures (no lines to wrap); an SVG's text diff follows them.
  if (pictures && data.before == null && data.after == null) {
    target.innerHTML = `${head}</div><div class="pv-scroll gw-diff">${pictures}</div>`;
    measureImages(target);
    return null;
  }
  if (message) {
    target.innerHTML = `${head}${wrapButton}</div><div class="gw-message">${escapeHtml(message)}</div>`;
    return null;
  }
  let rows = buildDiffRows(data, { mode: wholeFile ? changeView.file : changeView.diff, expanded, whole });
  const notes = [];
  if (unchanged) notes.push(shown.request.oldPath ? 'Renamed; its lines are the same.' : 'Its lines are the same.');
  if (data.note) notes.push(data.note);
  if (data.eolOnly) notes.push('Only line endings changed.');
  if (rows.plain) notes.push('Too big to colour quickly, so it’s shown plain.');
  if (rows.length > MAX_ROWS) {
    notes.push(`Showing the first ${MAX_ROWS.toLocaleString()} of ${rows.length.toLocaleString()} lines.`);
    rows = rows.slice(0, MAX_ROWS);
  }
  target.innerHTML = `${head}${wrapButton}</div>${notes.length ? `<div class="pv-note">${escapeHtml(notes.join(' '))}</div>` : ''}`
    + `<div class="pv-scroll gw-diff${sideBySide && !whole ? ' sbs' : ''}${wrap ? ' wrap' : ''}">${pictures}<div class="pv-rows">${rows.map(diffRowHtml).join('')}</div></div>`;
  if (pictures) measureImages(target);
  // Blocks and lines can be staged on their own where the diff is of the working tree, shown as a diff.
  const side = shown.request.side ?? '';
  const parts = !wholeFile && !rows.plain && canStageParts(side, data.kind ?? '', !!shown.request.oldPath);
  shown.rows = parts ? rows : null;
  if (parts) setUpStaging(/** @type {HTMLElement} */ (target), rows, side);
  return hit && searching() ? markInDiff(target, hit.line) : null;
}

/** Draws the diff again where it was scrolled to (its folds opened, a setting it follows changed). */
function redrawInPlace() {
  const target = /** @type {DiffState} */ (gw.diffState).target;
  const scroll = target.querySelector(DIFF_SCROLL)?.scrollTop ?? 0;
  drawDiff();
  const scroller = target.querySelector(DIFF_SCROLL);
  if (scroller) scroller.scrollTop = scroll;
}

// Staging a block or picked lines, Wrap, and a folded run of unchanged lines opening on a click.
rightEl.addEventListener('click', e => {
  const shown = gw.diffState;
  if (shown?.rows && stagingClicked(e, /** @type {HTMLElement} */ (shown.target), shown.rows, stageContext(shown))) return;
  if (targetOf(e).closest('[data-gw-wrap]')) {
    toggleWrap(); // the diff redraws on the change (below)
    return;
  }
  const fold = /** @type {HTMLElement | null} */ (targetOf(e).closest('.pv-fold, .pv-delmark'));
  if (fold && shown && shown.target.contains(fold)) {
    shown.expanded.add(/** @type {string} */ (fold.dataset.key));
    redrawInPlace();
  }
});

// A setting the diff follows (its layout, Wrap): drawn again where it was.
on(EVENTS.settings, () => {
  if (isOpen() && gw.diffState && !rightEl.hidden) redrawInPlace();
});
