// @ts-check
// Paths with spaces in a terminal's output (D:\My reports\Q3 plan.md, "C:\Program Files\app"): the usual path patterns
// stop at a space, so these are found apart. A bare one runs from its root to the first file extension after a space;
// a quoted one is the whole quoted text. They are only guesses: js/changes.js keeps those the host finds on disk.

/** @typedef {{ start: number, end: number, text: string }} SpacedPath */

/** Characters no path has (Windows), and the line's end. */
const NOT_IN_PATH = String.raw`"'<>|*?\n`;
/** Where a bare path's extension ends: the line's end, a space, a closing quote or bracket, or a sentence's full stop. */
const AFTER_EXTENSION = String.raw`(?=$|[\s"'),;:\]]|\.(?:\s|$))`;
const PATTERNS = [
  // In quotes: the whole quoted text, when it starts like a path.
  { re: new RegExp(String.raw`(["'])((?:[A-Za-z]:\\|\\\\|~?\/)[^${NOT_IN_PATH}]+)\1`, 'g'), group: 2 },
  // A Windows path (drive or share) with a space, up to a file extension.
  { re: new RegExp(String.raw`(?<![\w\\])((?:[A-Za-z]:\\|\\\\)[^${NOT_IN_PATH}:]*?\s[^${NOT_IN_PATH}:]*?\.[A-Za-z0-9]{1,10})${AFTER_EXTENSION}`, 'g'), group: 1 },
  // A Unix path (from / or ~/) with a space, up to a file extension.
  { re: new RegExp(String.raw`(?<![\w/.~])(~?\/[^${NOT_IN_PATH}:\\]*?\s[^${NOT_IN_PATH}:\\]*?\.[A-Za-z0-9]{1,10})${AFTER_EXTENSION}`, 'g'), group: 1 },
];

/**
 * The paths with a space in one line of text, by character offset, without overlaps.
 * @param {string} text
 * @returns {SpacedPath[]}
 */
export function findSpacedPaths(text) {
  /** @type {SpacedPath[]} */
  const found = [];
  for (const { re, group } of PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) {
      const path = m[group];
      const start = m.index + m[0].indexOf(path);
      const end = start + path.length;
      if (!/\s/.test(path) || found.some(f => start < f.end && end > f.start)) continue;
      found.push({ start, end, text: path });
    }
  }
  return found;
}
