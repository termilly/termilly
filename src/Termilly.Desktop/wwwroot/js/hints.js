// @ts-check
// Keyboard hints (Ctrl+Shift+E): every link, file path and commit hash on the focused terminal's screen gets a
// short label; typing it opens the link (or copies the path or hash), and Shift with it copies the link (or shows
// the path in Explorer). Esc, or any other key, closes them.

import { send } from './host.js';
import { PAGE } from './protocol.js';
import { focusedTab } from './panes.js';
import { find } from './dom.js';

/**
 * A link, path or hash on the screen: what it is, and the row and column it starts at.
 * @typedef {{ text: string, kind: string, row: number, col: number }} FoundHint
 */
/**
 * A found hint with the label that picks it.
 * @typedef {FoundHint & { label: string }} Hint
 */

const KINDS = [
  { kind: 'url', re: /\bhttps?:\/\/[^\s"'<>`]+/g },
  { kind: 'path', re: /(?:\b[A-Za-z]:\\|\\\\)[^\s"'<>|*?]+/g },
  { kind: 'path', re: /(?:^|[\s(])((?:~|\.{1,2})?\/[\w.\-@+]+(?:\/[\w.\-@+]+)+)/g, group: 1 },
  { kind: 'hash', re: /\b[0-9a-f]{7,40}\b/g },
];
/** The file path patterns, shared with the change preview's Ctrl+click links (js/changes.js). */
export const PATH_PATTERNS = KINDS.filter(k => k.kind === 'path');
const LETTERS = 'asdfghjklqwertyuiopzxcvbnm';
/** The fewest characters a hint's text has (shorter matches aren't worth a label). */
const MIN_HINT_LENGTH = 3;

/**
 * The hints on show: the terminal, its hints, the keys typed so far and the layer that draws them.
 * @typedef {{ tab: Tab, hints: Hint[], typed: string, overlay: HTMLDivElement }} ActiveHints
 */

/** @type {ActiveHints | null} */
let active = null; // { tab, hints: [{ label, text, kind }], typed, overlay }

/**
 * Labels in order: a, s, d, … then aa, as, … so the first hints are one key away.
 * @param {number} count
 */
function labels(count) {
  if (count <= LETTERS.length) return [...LETTERS.slice(0, count)];
  const out = [];
  for (const a of LETTERS) for (const b of LETTERS) out.push(a + b);
  return out.slice(0, count);
}

/** The links, paths and hashes on the visible rows: { text, kind, row, col }. Trailing punctuation is dropped.
 * @param {string[]} rows
 */
export function findHints(rows) {
  /** @type {FoundHint[]} */
  const found = [];
  rows.forEach((line, row) => {
    /** @type {[number, number][]} */
    const taken = [];
    for (const { kind, re, group } of KINDS) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(line));) {
        let text = group ? m[group] : m[0];
        const col = m.index + (group ? m[0].indexOf(text) : 0);
        text = text.replace(/[.,;:!?)\]}'"]+$/, '');
        if (kind === 'hash' && !/[a-f]/.test(text)) continue; // digits only: a number, not a hash
        if (text.length < MIN_HINT_LENGTH || taken.some(([s, e]) => col < e && col + text.length > s)) continue;
        taken.push([col, col + text.length]);
        found.push({ text, kind, row, col });
      }
    }
  });
  return found;
}

export function toggleHints() {
  if (active) return closeHints();
  const tab = focusedTab();
  const term = tab?.view?.term;
  if (!term) return;
  const buffer = term.buffer.active;
  const rows = [];
  for (let r = 0; r < term.rows; r++) rows.push(buffer.getLine(buffer.viewportY + r)?.translateToString(false) ?? '');
  const found = findHints(rows);
  if (!found.length) return;

  const screen = find(/** @type {TabView} */ (tab.view).body, '.xterm-screen');
  const box = screen.getBoundingClientRect();
  const cellW = box.width / term.cols;
  const cellH = box.height / term.rows;
  const overlay = document.createElement('div');
  overlay.className = 'hint-layer';
  const names = labels(found.length);
  const hints = found.map((h, i) => ({ ...h, label: names[i] }));
  overlay.innerHTML = hints.map(h =>
    `<span class="hint hint-${h.kind}" data-label="${h.label}" style="left:${h.col * cellW}px;top:${h.row * cellH}px">${h.label}</span>`).join('');
  screen.append(overlay);
  active = { tab, hints, typed: '', overlay };
  document.addEventListener('keydown', onKey, true);
}

function closeHints() {
  active?.overlay.remove();
  active = null;
  document.removeEventListener('keydown', onKey, true);
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (['Shift', 'Control', 'Alt'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  const key = e.key.toLowerCase();
  if (!active || e.key === 'Escape' || !LETTERS.includes(key)) return closeHints();
  active.typed += key;
  const hit = active.hints.find(h => h.label === /** @type {ActiveHints} */ (active).typed);
  if (hit) {
    closeHints();
    act(hit, e.shiftKey);
    return;
  }
  const left = active.hints.filter(h => h.label.startsWith(/** @type {ActiveHints} */ (active).typed));
  if (!left.length) return closeHints();
  for (const el of /** @type {HTMLCollectionOf<HTMLElement>} */ (active.overlay.children)) {
    el.classList.toggle('dim', !/** @type {string} */ (el.dataset.label).startsWith(active.typed));
  }
}

/**
 * Opens or copies a hint: links open (Shift copies), paths and hashes copy (Shift shows a path in Explorer).
 * @param {Hint} hint
 * @param {boolean} shift
 */
function act(hint, shift) {
  if (hint.kind === 'url' && !shift) send(PAGE.openUrl, { url: hint.text });
  else if (hint.kind === 'path' && shift) send(PAGE.openPath, { path: hint.text });
  else navigator.clipboard.writeText(hint.text);
}
