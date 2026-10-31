// @ts-check
// Leaving out what a program draws again (js/earlier.js): runs of lines found in what a terminal kept already.
// They're compared by pieces of their text without the spaces, so a redraw at another width, wrapped differently,
// still counts as the same; a short line that comes again is real output and stays.

/** The pieces of text compared (characters, spaces left out); one in SAMPLE is kept, picked by its hash so the same text picks the same pieces. */
const PIECE = 16;
const SAMPLE = 4;
/** A line counts as kept already when this share of its pieces is. */
const FOUND_SHARE = 0.8;
/** Only runs of kept lines this long (characters) are left out. */
const LEAST_RUN = 300;
/** Pieces remembered per terminal before it starts over. */
const MOST_PIECES = 200_000;
/** FNV-1a. */
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
/** How a line compares with what's kept. */
const LINE = Object.freeze({ blank: 0, found: 1, fresh: 2 });

/**
 * Calls back with each sampled piece of the lines' text (spaces left out, across line ends), and the line it lies
 * in: -1 for one across a line end (still a piece of the text, but it says nothing of either line).
 * @param {string[]} lines
 * @param {(hash: number, line: number) => void} each
 * @returns {string[]} The lines without their spaces.
 */
export function piecesOf(lines, each) {
  const bare = lines.map(l => l.replace(/\s+/g, ''));
  const text = bare.join('');
  let line = 0, lineEnd = bare[0]?.length ?? 0;
  for (let i = 0; i + PIECE <= text.length; i++) {
    while (i >= lineEnd && line + 1 < bare.length) lineEnd += bare[++line].length;
    let h = FNV_OFFSET;
    for (let k = i; k < i + PIECE; k++) h = Math.imul(h ^ text.charCodeAt(k), FNV_PRIME) >>> 0;
    if (h % SAMPLE === 0) each(h, i + PIECE <= lineEnd ? line : -1);
  }
  return bare;
}

/**
 * The lines without the long runs already kept (a program drawing again what it drew before). The pieces learn the lines.
 * @param {string[]} lines
 * @param {Set<number>} pieces
 */
export function leaveOutRepeats(lines, pieces) {
  const total = new Array(lines.length).fill(0), found = new Array(lines.length).fill(0);
  /** @type {number[]} */
  const learnt = [];
  const bare = piecesOf(lines, (h, line) => {
    if (!pieces.has(h)) learnt.push(h);
    if (line < 0) return;
    total[line]++;
    if (pieces.has(h)) found[line]++;
  });
  const kind = lines.map((_, i) => (!total[i] ? LINE.blank : found[i] / total[i] >= FOUND_SHARE ? LINE.found : LINE.fresh));
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (kind[i] === LINE.fresh) {
      out.push(lines[i++]);
      continue;
    }
    let j = i, size = 0, anyFound = false;
    for (; j < lines.length && kind[j] !== LINE.fresh; j++) {
      size += bare[j].length;
      anyFound ||= kind[j] === LINE.found;
    }
    if (!anyFound || size < LEAST_RUN) out.push(...lines.slice(i, j));
    i = j;
  }
  if (pieces.size + learnt.length > MOST_PIECES) pieces.clear();
  for (const h of learnt) pieces.add(h);
  return out;
}
