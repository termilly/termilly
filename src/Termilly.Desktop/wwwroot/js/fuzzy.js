// @ts-check
// Fuzzy matching for the "Go to" picker: the query's characters in order, anywhere in the text, scored so that
// runs of characters and matches at word starts ("tm" in "termilly-main") beat scattered ones.

/** How a match scores (higher is better): each character, a word start, a run, a gap, and the whole match. */
const SCORE = Object.freeze({
  /** A character at a word start, on top of the 1 every matched character gets. */
  wordStart: 3,
  /** Taken off per character of the text before the first match: earlier is slightly better. */
  perOffset: 0.05,
  /** A character right after the one before it. */
  run: 4,
  /** Taken off per character skipped between two matched ones, up to maxGap. */
  perGapChar: 0.25,
  maxGap: 3,
  /** The query appearing as one piece. */
  whole: 6,
  /** Taken off per character of the text: shorter texts win ties. */
  perLength: 0.02,
});

/**
 * Where a word starts: the first character, or after a separator or a lower→upper change.
 * @param {string} text
 * @param {number} i
 */
const isWordStart = (text, i) => i === 0 || /[\s\-_./\\:@]/.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

/**
 * Scores `text` against `query` (case-insensitive; spaces in the query are ignored). Returns null when the
 * characters don't all appear in order, else { score, positions } with a higher score for a better match.
 * @param {string} query
 * @param {string} text
 */
export function fuzzyMatch(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, positions: [] };
  const lower = text.toLowerCase();
  const n = q.length;
  const m = lower.length;
  if (n > m) return null;
  // best[i][j]: the best score with query character i matched at text position j (-Infinity: impossible);
  // from[i][j]: where character i - 1 was matched then. The best alignment wins, not the first one found.
  const best = Array.from({ length: n }, () => new Float64Array(m).fill(-Infinity));
  const from = Array.from({ length: n }, () => new Int32Array(m).fill(-1));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < m; j++) {
      if (lower[j] !== q[i]) continue;
      const here = 1 + (isWordStart(text, j) ? SCORE.wordStart : 0);
      if (i === 0) {
        best[0][j] = here - j * SCORE.perOffset; // earlier is slightly better
        continue;
      }
      for (let k = i - 1; k < j; k++) {
        if (best[i - 1][k] === -Infinity) continue;
        const step = k === j - 1 ? SCORE.run : -Math.min(SCORE.maxGap, (j - k - 1) * SCORE.perGapChar); // a run, or a gap
        const score = best[i - 1][k] + step + here;
        if (score > best[i][j]) {
          best[i][j] = score;
          from[i][j] = k;
        }
      }
    }
  }
  let end = -1;
  for (let j = 0; j < m; j++) if (best[n - 1][j] > (end < 0 ? -Infinity : best[n - 1][end])) end = j;
  if (end < 0) return null;
  /** @type {number[]} */
  const positions = [];
  for (let i = n - 1, j = end; i >= 0; j = from[i][j], i--) positions.unshift(j);
  let score = best[n - 1][end];
  if (lower.includes(q)) score += SCORE.whole; // the query as one piece
  score -= text.length * SCORE.perLength; // shorter texts win ties
  return { score, positions };
}

/**
 * Escapes text and marks the matched characters.
 * @param {string} text
 * @param {number[]} positions
 * @param {(text: string) => string} escape
 */
export function highlightPositions(text, positions, escape) {
  const set = new Set(positions);
  let out = '';
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit && !open) { out += '<mark>'; open = true; }
    if (!hit && open) { out += '</mark>'; open = false; }
    out += escape(text[i]);
  }
  return out + (open ? '</mark>' : '');
}
