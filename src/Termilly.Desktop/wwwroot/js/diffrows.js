// @ts-check
// Diff rows as the change preview draws them (js/preview.js), shared with the Git window (js/gitwindow.js): the
// host's diff runs turned into rows (folded unchanged runs, removed and added lines, side by side when Settings say
// so), coloured for the file's language, and one row's HTML.

import { state } from './store.js';
import { languageOf, highlightLines } from './highlight.js';
import { SETTING_VALUES, CHANGE_KIND } from './constants.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { changeLayout, changeView, changeContext } = SETTING_VALUES;

/**
 * A diff row's kind (DiffRow.t), which is also its class in app.css: an unchanged line, an added or a removed line, a
 * folded run of unchanged lines, a removed run's marker (file mode) and a side-by-side pair of lines.
 */
export const DIFF_ROW = Object.freeze({
  ctx: 'ctx', add: 'add', del: 'del', fold: 'fold', delmark: 'delmark', pair: 'pair',
});
/** The scrolling box the rows are drawn in, in the change preview and the Git window. */
export const DIFF_SCROLL = '.pv-scroll';
/** A drawn line (any row), and the class that marks the one a jump went to. */
export const DIFF_LINE = '.pv-row';
export const DIFF_TARGET = 'pv-target';

/**
 * A file's change as the host sends it (the change preview's view, the Git window's diff): the texts before and
 * after, and the diff runs.
 * @typedef {{ path?: string | null, kind?: string | null, before?: string | null, after?: string | null,
 *   ops?: Array<[number, number]> | null }} DiffData
 */
/**
 * One side of a side-by-side row: a line's number and HTML, and whether it was removed or added.
 * @typedef {{ no?: number, html?: string, kind?: string }} DiffSide
 */
/**
 * A row to draw: t is its kind ('ctx', 'add', 'del', 'fold', 'delmark' or 'pair'); a and b are its line numbers
 * before and after, key and n a fold's (or removed marker's) key and line count, left and right a pair's sides.
 * @typedef {{ t: string, a?: number, b?: number, html?: string, whole?: boolean, key?: string, n?: number,
 *   left?: DiffSide | null, right?: DiffSide | null }} DiffRow
 */
/**
 * The rows, and whether a language's colouring was left out because the file is too big.
 * @typedef {DiffRow[] & { plain?: boolean }} DiffRows
 */

/**
 * The rows to draw, from the host's diff runs ([[kind, count]]: 0 same, 1 removed, 2 added). Diff mode keeps a few
 * unchanged lines around each change and folds the rest; file mode shows the whole new file, with removed lines as
 * markers that open on a click. Side by side pairs removed and added lines.
 * @param {DiffData} data
 * @param {{ mode?: string, expanded?: Set<string>, whole?: boolean }} [options]
 */
export function buildDiffRows(data, { mode = changeView.diff, expanded = new Set(), whole = false } = {}) {
  const s = state.settings;
  const language = s.changes.highlight ? languageOf(data.path) : null;
  const rows = /** @type {DiffRows} */ ([]);
  const old = data.before == null ? null : highlightLines(data.before, language);
  const now = data.after == null ? null : highlightLines(data.after, language);
  const before = old?.lines ?? [];
  const after = now?.lines ?? [];
  // A language, but a file too big to colour quickly: say why it's plain.
  rows.plain = !!language && (old?.coloured === false || now?.coloured === false);
  if (whole) {
    // The new file as it is now, the deleted file as it was, or a file with nothing to compare: no added or removed
    // colouring.
    const lines = data.kind === CHANGE_KIND.deleted ? before : after;
    lines.forEach((html, k) => rows.push({ t: DIFF_ROW.ctx, b: k + 1, html, whole: true }));
    return rows;
  }
  const ops = data.ops ?? [];
  const context = s.changes.context ?? changeContext.default;
  const sideBySide = s.changes.layout === changeLayout.sideBySide && mode === changeView.diff;
  let i = 0; // line in before
  let j = 0; // line in after

  /**
   * @param {number} n
   * @param {number} oi
   * @param {number} nj
   */
  const same = (n, oi, nj) => {
    for (let k = 0; k < n; k++) rows.push({ t: DIFF_ROW.ctx, a: oi + k + 1, b: nj + k + 1, html: after[nj + k] ?? before[oi + k] ?? '' });
  };

  for (let r = 0; r < ops.length; r++) {
    const [kind, count] = ops[r];
    if (kind === 0) {
      const key = `f${i}`;
      const first = r === 0;
      const last = r === ops.length - 1;
      const keepStart = mode === changeView.file || first ? 0 : context;
      const keepEnd = mode === changeView.file || last ? 0 : context;
      if (mode === changeView.file || expanded.has(key) || count <= keepStart + keepEnd + 1) {
        same(count, i, j);
      } else {
        same(keepStart, i, j);
        const hidden = count - keepStart - keepEnd;
        rows.push({ t: DIFF_ROW.fold, key, n: hidden });
        same(keepEnd, i + count - keepEnd, j + count - keepEnd);
      }
      i += count;
      j += count;
    } else if (kind === 1) {
      const next = ops[r + 1];
      const added = next?.[0] === 2 ? next[1] : 0;
      if (mode === changeView.file) {
        const key = `d${i}`;
        if (expanded.has(key)) {
          for (let k = 0; k < count; k++) rows.push({ t: DIFF_ROW.del, a: i + k + 1, html: before[i + k] ?? '' });
        } else {
          rows.push({ t: DIFF_ROW.delmark, key, n: count });
        }
      } else if (sideBySide) {
        for (let k = 0; k < Math.max(count, added); k++) {
          rows.push({
            t: DIFF_ROW.pair,
            left: k < count ? { no: i + k + 1, html: before[i + k] ?? '', kind: DIFF_ROW.del } : null,
            right: k < added ? { no: j + k + 1, html: after[j + k] ?? '', kind: DIFF_ROW.add } : null,
          });
        }
        j += added;
        r += added ? 1 : 0;
      } else {
        for (let k = 0; k < count; k++) rows.push({ t: DIFF_ROW.del, a: i + k + 1, html: before[i + k] ?? '' });
      }
      i += count;
    } else {
      for (let k = 0; k < count; k++) {
        rows.push(sideBySide
          ? { t: DIFF_ROW.pair, left: null, right: { no: j + k + 1, html: after[j + k] ?? '', kind: DIFF_ROW.add } }
          : { t: DIFF_ROW.add, b: j + k + 1, html: after[j + k] ?? '' });
      }
      j += count;
    }
  }
  if (sideBySide) {
    // Unchanged lines show on both sides.
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k];
      if (row.t === DIFF_ROW.ctx) rows[k] = { t: DIFF_ROW.pair, left: { no: row.a, html: row.html }, right: { no: row.b, html: row.html } };
    }
  }
  return rows;
}

/** @type {Record<string, string>} */
const SIGN = { add: '+', del: '−', ctx: ' ' };

/** @param {DiffRow} row */
export function diffRowHtml(row) {
  /** @param {number | undefined} n */
  const no = n => `<span class="pv-no">${n ?? ''}</span>`;
  if (row.t === DIFF_ROW.fold) return `<div class="pv-row pv-fold" data-key="${row.key}">⋯ ${row.n} unchanged line${row.n === 1 ? '' : 's'}</div>`;
  if (row.t === DIFF_ROW.delmark) return `<div class="pv-row pv-delmark" data-key="${row.key}">− ${row.n} line${row.n === 1 ? '' : 's'} removed</div>`;
  if (row.t === DIFF_ROW.pair) {
    /** @param {DiffSide | null | undefined} s */
    const side = s => (s
      ? `<span class="pv-half ${s.kind ?? DIFF_ROW.ctx}">${no(s.no)}<span class="pv-code">${s.html || ' '}</span></span>`
      : '<span class="pv-half empty"></span>');
    return `<div class="pv-row pv-pair">${side(row.left)}${side(row.right)}</div>`;
  }
  if (row.whole) return `<div class="pv-row ctx">${no(row.b)}<span class="pv-code">${row.html || ' '}</span></div>`;
  // One column of line numbers: the file's lines as they are now, and a removed line's number from before.
  return `<div class="pv-row ${row.t}">${no(row.b ?? row.a)}<span class="pv-sign">${SIGN[row.t]}</span><span class="pv-code">${row.html || ' '}</span></div>`;
}
