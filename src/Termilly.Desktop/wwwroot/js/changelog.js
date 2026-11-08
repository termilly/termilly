// @ts-check
// CHANGELOG.md as What's new reads it (js/whatsnew.js): each released version's topics and fixes, the way a release entry
// is written: a few `- **Topic:** one line` items, then a `Fixes:` line and its items. A paragraph counts as an item
// (1.0.0 has only "Initial version."); older entries' sub-items (`  - `) are left out. Nothing here touches the page,
// so tests/js/changelog.test.mjs runs it as it is.

/** A released version's heading: `## 1.6.2 (2026-11-06)`. A draft (`## 1.7.0 (draft)`) isn't one. */
const VERSION_HEAD = /^## (\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)\s*$/;
/** An item's bold start, its topic: `**To do:** the rest`, the colon inside the bold or after it. */
const TOPIC = /^\*\*(.+?):?\*\*:?\s*(.*)$/;
/** The line that starts a version's fixes. */
const FIXES = /^fixes:?$/i;
const ITEM = '- ';
/** A line inside an item, such as a sub-item: left out. */
const INDENTED = /^\s/;

/**
 * One item: its topic (empty for an item that has none) and the rest of its line.
 * @typedef {{ name: string, text: string }} Topic
 */
/**
 * @typedef {{ version: string, date: string, topics: Topic[], fixes: Topic[] }} Release
 */

/** @param {string} line @returns {Topic} */
function topicOf(line) {
  const m = line.match(TOPIC);
  return m ? { name: m[1].trim(), text: m[2].trim() } : { name: '', text: line.trim() };
}

/**
 * The released versions in a changelog, newest first as the file lists them.
 * @param {string} markdown
 * @returns {Release[]}
 */
export function parseChangelog(markdown) {
  /** @type {Release[]} */
  const releases = [];
  /** @type {Release | null} */
  let release = null;
  let inFixes = false;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      const m = line.match(VERSION_HEAD);
      release = m ? { version: m[1], date: m[2], topics: [], fixes: [] } : null;
      if (release) releases.push(release);
      inFixes = false;
    } else if (!release) continue;
    else if (FIXES.test(line.trim())) inFixes = true;
    else if (line.startsWith(ITEM)) (inFixes ? release.fixes : release.topics).push(topicOf(line.slice(ITEM.length)));
    else if (line.trim() && !INDENTED.test(line)) (inFixes ? release.fixes : release.topics).push(topicOf(line));
  }
  return releases;
}

/**
 * Compares two versions part by part: below zero when `a` is older.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * What's new on `to` since `from`: the versions after `from` up to `to`, newest first. Without `from` (an update from a
 * version that didn't keep it), only `to`'s.
 * @param {Release[]} releases
 * @param {string | null} from
 * @param {string} to
 */
export function releasesSince(releases, from, to) {
  return releases
    .filter(r => compareVersions(r.version, to) <= 0 && (from ? compareVersions(r.version, from) > 0 : r.version === to))
    .sort((a, b) => compareVersions(b.version, a.version));
}
