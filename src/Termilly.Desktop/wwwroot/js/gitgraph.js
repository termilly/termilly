// @ts-check
// The commit graph beside History's rows (js/gitwindow.js): each commit on a lane, lines down to its parents, merges
// and new branches as curves between lanes. Commits come newest first, children before parents (git log
// --date-order), as the host sends them; the lanes are worked out here, again each time more commits are loaded.
// A lane keeps its place while it runs, so a line never jumps sideways; a freed lane is taken by the next new one.

/** How many colours the lanes take turns with (git.css: .gw-lane-0 to .gw-lane-7). */
export const LANE_COLOURS = 8;
/** Pixels between two lanes, and from the column's edge to the first. */
const LANE_PX = 12;
/** A commit's dot. */
const DOT_RADIUS = 3.5;
/** Lanes drawn at most; a busier history's further lanes are cut at the column's edge. */
const MOST_LANES = 14;

/**
 * One commit's place in the graph: its lane, the lanes running into its row from above (each the hash it waits
 * for, or null where free), those leaving below, and which lanes below start at this commit (its parents).
 * @typedef {{ lane: number, above: (string | null)[], below: (string | null)[], toParents: number[] }} GraphRow
 */

/**
 * The first free lane, or a new one at the end.
 * @param {(string | null)[]} lanes
 */
function freeLane(lanes) {
  const at = lanes.indexOf(null);
  return at >= 0 ? at : lanes.length;
}

/**
 * The graph's rows, one per commit, in the commits' order.
 * @param {{ hash: string, parents?: string[] | null }[]} commits
 * @returns {GraphRow[]}
 */
export function graphRows(commits) {
  /** @type {(string | null)[]} */
  let lanes = [];
  return commits.map(({ hash, parents: given }) => {
    const parents = given ?? [];
    const above = lanes.slice();
    let lane = lanes.indexOf(hash);
    if (lane < 0) lane = freeLane(lanes);
    // Other lanes waiting for this commit end here (it's where their branches came from).
    const below = lanes.map(h => (h === hash ? null : h));
    while (below.length <= lane) below.push(null);
    below[lane] = parents[0] ?? null;
    const toParents = parents.length ? [lane] : [];
    for (const parent of parents.slice(1)) {
      let to = below.indexOf(parent);
      if (to < 0) {
        to = freeLane(below);
        below[to] = parent;
      }
      toParents.push(to);
    }
    while (below.length && below[below.length - 1] === null) below.pop();
    lanes = below;
    return { lane, above, below, toParents };
  });
}

/** @param {number} lane */
const xOf = lane => LANE_PX / 2 + Math.min(lane, MOST_LANES) * LANE_PX;

/**
 * A line from one point to another, bending halfway when it changes lanes.
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 @param {number} lane its colour's lane
 */
function line(x1, y1, x2, y2, lane) {
  const mid = (y1 + y2) / 2;
  const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
  return `<path class="gw-lane-${lane % LANE_COLOURS}" d="${d}"/>`;
}

/**
 * How wide the graph's column is for these rows: their busiest one.
 * @param {GraphRow[]} rows
 */
export const graphWidth = rows => xOf(Math.max(0, ...rows.map(r => Math.max(r.above.length, r.below.length, r.lane + 1))) - 1) + LANE_PX / 2;

/**
 * One row's piece of the graph, as SVG: lanes passing by, those ending at the commit, its dot and the lines to its
 * parents. A merge's lines take its parents' lanes' colours, so a branch keeps its colour into the merge.
 * @param {GraphRow} row
 * @param {string} hash the row's commit
 * @param {number} width the column's (graphWidth)
 * @param {number} height the row's, in pixels
 * @param {boolean} head whether it's the checked-out commit (a ring rather than a dot)
 */
export function graphSvg(row, hash, width, height, head) {
  const mid = height / 2;
  const x = xOf(row.lane);
  const parts = [];
  row.above.forEach((h, i) => {
    if (!h) return;
    if (h === hash) parts.push(line(xOf(i), 0, x, mid, i));
    else if (row.below[i] === h) parts.push(line(xOf(i), 0, xOf(i), height, i));
  });
  for (const to of row.toParents) parts.push(line(x, mid, xOf(to), height, to));
  const dot = `<circle class="gw-lane-${row.lane % LANE_COLOURS}${head ? ' head' : ''}" cx="${x}" cy="${mid}" r="${DOT_RADIUS}"/>`;
  return `<svg class="gw-graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${parts.join('')}${dot}</svg>`;
}
