// @ts-check
// The Git window's History rows (js/gitwindow.js): each commit beside its piece of the graph (js/gitgraph.js), with
// its branches and tags, and what it's of: the checked-out branch, every branch (All branches, the repository's
// whole history) or one file or folder (its history, from a file's menu).

import { escapeHtml } from './ui.js';
import { graphRows, graphSvg, graphWidth } from './gitgraph.js';
import { ago } from './gitsearch.js';

/** @typedef {import('./gitsearch.js').Commit} Commit */

/** A History row's height: the graph's pieces meet from one row to the next (git.css .gw-graph-row). */
export const HISTORY_ROW_PX = 40;
/** The refs git marks the checked-out commit with. */
const HEAD_PREFIX = 'HEAD -> ';
export const HEAD_REF = 'HEAD';

/**
 * What History shows: every branch or the checked-out one, and a path's history when one is picked (null: all of
 * the repository's). The graph is worked out again from the commits loaded whenever they change.
 */
export const history = {
  all: false,
  /** @type {string | null} */
  path: null,
  /** @type {{ rows: import('./gitgraph.js').GraphRow[], width: number, of: Commit[] | null, count: number }} */
  graph: { rows: [], width: 0, of: null, count: 0 },
};

/**
 * The graph for these commits, worked out once for each set (more loaded, or new ones).
 * @param {Commit[]} commits
 */
function graphOf(commits) {
  const g = history.graph;
  if (g.of !== commits || g.count !== commits.length) {
    const rows = graphRows(commits);
    history.graph = { rows, width: graphWidth(rows), of: commits, count: commits.length };
  }
  return history.graph;
}

/** @param {string[] | null | undefined} refs */
export const isHead = refs => !!refs?.some(r => r === HEAD_REF || r.startsWith(HEAD_PREFIX));

/**
 * Branch and tag chips on a commit: HEAD's branch first and marked.
 * @param {string[] | null | undefined} refs
 */
export function refChips(refs) {
  if (!refs?.length) return '';
  return refs.map(r => {
    if (r.startsWith(HEAD_PREFIX)) return `<span class="gw-ref head" title="The checked-out branch">${escapeHtml(r.slice(HEAD_PREFIX.length))}</span>`;
    if (r === HEAD_REF) return '<span class="gw-ref head">HEAD</span>';
    if (r.startsWith('tag: ')) return `<span class="gw-ref is-tag">${escapeHtml(r.slice(5))}</span>`;
    if (r.startsWith('remote: ')) return `<span class="gw-ref remote">${escapeHtml(r.slice(8))}</span>`;
    return `<span class="gw-ref">${escapeHtml(r)}</span>`;
  }).join('');
}

/**
 * A commit's row in History, with the graph beside it; `at` is its place in the commits loaded, `extra` what goes
 * after its subject (its checks' dot).
 * @param {Commit[]} commits
 * @param {number} at
 * @param {number} i the list's row index
 * @param {boolean} selected
 * @param {string} [extra]
 */
export function historyRowHtml(commits, at, i, selected, extra = '') {
  const c = commits[at];
  const g = graphOf(commits);
  const row = g.rows[at];
  const graph = row ? graphSvg(row, c.hash, g.width, HISTORY_ROW_PX, isHead(c.refs)) : '';
  return `<div class="cw-row gw-commit gw-graph-row${selected ? ' selected' : ''}" data-i="${i}" role="option" style="height:${HISTORY_ROW_PX}px">${graph}`
    + `<span class="gw-commit-text"><span class="gw-commit-main">${extra}<span class="gw-subject">${escapeHtml(c.subject || '(no message)')}</span>${refChips(c.refs)}</span>`
    + `<span class="gw-commit-meta"><span class="gw-hash">${escapeHtml(c.short)}</span><span>${escapeHtml(c.author)}</span><span>${ago(c.date)}</span></span></span></div>`;
}

/** What History's bar says: the switch for every branch, and the path whose history it shows, with a way back. */
export function historyBarHtml() {
  const path = history.path
    ? `<span class="gw-history-path" title="${escapeHtml(history.path)}">History of ${escapeHtml(history.path)}</span><button class="link-btn" data-history-whole>Whole repository</button>`
    : '';
  return `<label class="dialog-check gw-all"><input type="checkbox" data-history-all${history.all ? ' checked' : ''}> All branches</label>${path}`;
}
