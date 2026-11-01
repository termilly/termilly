// @ts-check
// Search's Files view (palette.js): the files, folders and web addresses the terminals printed, open and closed ones,
// found by name or by a pattern like *.txt or *.html. A path counts only where it leads somewhere real: the host looks
// it up from where the terminal works, as Ctrl+click does, so the list holds real files with their whole paths. Web
// addresses count as they are. Each shows once, with the terminal that printed it last, and leads back there.

import { findLinks, resolvePath, openChange } from './changes.js';
import { focusedTab } from './panes.js';
import { findWebLinks } from './webaddress.js';
import { send } from './host.js';
import { PAGE } from './protocol.js';
import { tabTitle, wsById } from './store.js';
import { parentOf, joinPath } from './filepaths.js';
import { escapeHtml, highlight, ICONS } from './ui.js';

/** What a result is. */
export const FILE_WHAT = Object.freeze({ file: 'file', folder: 'folder', web: 'web' });
/** At most this many printed paths are looked up per search (the newest first). */
const MOST_LOOKUPS = 400;
/** Paths looked up are remembered; more than this and they're looked up again. */
const MOST_REMEMBERED = 5000;
/**
 * A file name on its own (README.md, claude-output.txt): Ctrl+click needs a folder in it, but here the lookup says
 * whether it's real, so a word that only looks like one (v1.5, e.g.) drops out.
 */
const BARE_NAME = /(?<![\w/\\.:@-])([\w@][\w.@-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?![\w/\\])/g;
/** A pattern's wildcards, as in file names. */
const WILDCARD = /[*?]/;

/**
 * A file, folder or web address a terminal printed: where (an open terminal, or a closed one's entry with a stand-in
 * tab for looking its paths up), the line and its place in the terminal's lines.
 * @typedef {{ kind: 'files', what: string, path: string, text: string, tab: Tab, entry?: any, line: string,
 *   index: number, lines: string[], count: number }} FileResult
 */
/** @typedef {{ tab: Tab, lines: string[], entry?: any }} FileSource */

/** Lookups at a time, how long one may take (ms), and how often the list is drawn again as answers come (ms). */
const AT_ONCE = 16;
const WAIT_MS = 4000;
const REDRAW_MS = 200;
/** A whole path: a drive (C:\), Git Bash's drive (/d/), or a root. */
const WHOLE_PATH = /^(?:[A-Za-z]:[\\/]|\/[A-Za-z]\/|[\\/])/;

/** Where each printed path leads (by terminal and text): its real path and whether it's a folder, or null for nowhere. */
/** @type {Map<string, { path: string, folder: boolean } | null>} */
const looked = new Map();
/** Lookups asked for or waiting their turn, by key. */
/** @type {Set<string>} */
const asking = new Set();
/** @type {Array<() => Promise<void>>} */
const waiting = [];
let running = 0;
let redrawTimer = 0;

/** How many printed paths are still being looked up (the list fills in as they are). */
export const stillLooking = () => asking.size;

/** @param {string} path */
const nameOf = path => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * What a search text matches: with * or ? a file pattern (on the name, or the whole path), else the text anywhere.
 * @param {string} text
 * @returns {(s: string) => boolean}
 */
export function fileMatcher(text) {
  const t = text.trim().toLowerCase();
  if (!t) return () => true;
  if (!WILDCARD.test(t)) return s => s.toLowerCase().includes(t);
  const re = new RegExp(`^${[...t].map(ch => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
  return s => { const l = s.toLowerCase(); return re.test(l) || re.test(nameOf(l)); };
}

/**
 * The paths and web addresses printed in the terminals, newest first: the text, its terminal and its line.
 * @param {FileSource[]} sources
 */
function* printed(sources) {
  for (const { tab, lines, entry } of sources) {
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      const at = { tab, entry, lines, index, line };
      for (const w of findWebLinks(line)) yield { ...at, text: w.text, web: true, dirs: /** @type {string[]} */ ([]) };
      const paths = findLinks(line);
      // Whole paths on the line: a name on it may be in one (cd /d/notes; cat >> todo.txt).
      const dirs = paths.map(p => p.text).filter(t => WHOLE_PATH.test(t));
      for (const p of paths) yield { ...at, text: p.text, web: false, dirs };
      BARE_NAME.lastIndex = 0;
      for (let m; (m = BARE_NAME.exec(line));) {
        if (!paths.some(p => m && m.index >= p.start && m.index < p.end)) yield { ...at, text: m[1], web: false, dirs };
      }
    }
  }
}

/** A lookup still unanswered after WAIT_MS: its place goes to the next one, its answer still counts when it comes. */
const SLOW = Symbol('slow');
/** @typedef {{ path: string, folder: boolean } | null} Real */

/**
 * Where a printed path leads, as the host answers (null: nowhere).
 * @param {Tab} tab
 * @param {string} text
 * @returns {Promise<Real>}
 */
const leadsTo = (tab, text) => resolvePath(tab, text)
  .then(reply => (reply?.path ? { path: reply.path, folder: !!reply.folder } : null))
  .catch(() => null);

/** @param {() => void} redraw */
function redrawSoon(redraw) {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(redraw, asking.size ? REDRAW_MS : 0);
}

/** Runs waiting lookups, a few at a time. */
function next() {
  while (running < AT_ONCE && waiting.length) {
    const job = /** @type {() => Promise<void>} */ (waiting.shift());
    running++;
    job().finally(() => { running--; next(); });
  }
}

/**
 * Looks a printed path up (once): where the terminal works, else in a whole path printed on the same line, else one
 * folder up. The list is drawn again shortly after each answer.
 * @param {{ tab: Tab, text: string, dirs: string[] }} c
 * @param {string} key
 * @param {() => void} redraw
 */
function lookUp(c, key, redraw) {
  if (asking.has(key)) return;
  asking.add(key);
  if (looked.size > MOST_REMEMBERED) looked.clear();
  const home = c.tab.cwd ?? wsById(c.tab.wsId)?.cwd ?? null;
  const others = WHOLE_PATH.test(c.text) ? [] : [...c.dirs.map(d => joinPath(d, c.text)), ...(home ? [joinPath(parentOf(home), c.text)] : [])];
  waiting.push(async () => {
    /** @type {Real} */
    let real = null;
    /** @type {Promise<Real>[]} */
    const slow = [];
    for (const text of [c.text, ...others]) {
      const answer = leadsTo(c.tab, text);
      const first = await Promise.race([answer, new Promise(resolve => setTimeout(() => resolve(SLOW), WAIT_MS))]);
      if (first === SLOW) slow.push(answer);
      else if (first) { real = /** @type {Real} */ (first); break; }
    }
    const done = (/** @type {Real} */ found) => { looked.set(key, found); asking.delete(key); redrawSoon(redraw); };
    if (real || !slow.length) done(real);
    else Promise.all(slow).then(found => done(found.find(Boolean) ?? null));
  });
  next();
}

/**
 * The files, folders and web addresses printed in the terminals that match the search text, newest first. Paths not
 * looked up yet are asked for, and `redraw` runs once they're known.
 * @param {FileSource[]} sources
 * @param {string} text
 * @param {() => void} redraw
 * @returns {FileResult[]}
 */
export function fileMatches(sources, text, redraw) {
  const match = fileMatcher(text);
  /** @type {Map<string, FileResult>} */
  const found = new Map();
  let lookups = 0;
  const add = (/** @type {string} */ path, /** @type {string} */ what, /** @type {{ tab: Tab, entry?: any, lines: string[], index: number, line: string, text: string }} */ c) => {
    const key = what === FILE_WHAT.web ? path : path.toLowerCase();
    const known = found.get(key);
    if (known) known.count++;
    else found.set(key, { kind: 'files', what, path, text: c.text, tab: c.tab, entry: c.entry, line: c.line, index: c.index, lines: c.lines, count: 1 });
  };
  for (const c of printed(sources)) {
    if (c.web) {
      if (match(c.text)) add(c.text, FILE_WHAT.web, c);
      continue;
    }
    const key = `${c.tab.id}\n${c.text}`;
    if (!looked.has(key)) {
      if (match(c.text) && lookups++ < MOST_LOOKUPS) lookUp(c, key, redraw);
      continue;
    }
    const real = looked.get(key);
    if (real && (match(c.text) || match(real.path))) add(real.path, real.folder ? FILE_WHAT.folder : FILE_WHAT.file, c);
  }
  return [...found.values()];
}

/** @param {string} what */
const iconOf = what => (what === FILE_WHAT.web ? ICONS.link : what === FILE_WHAT.folder ? ICONS.folder : ICONS.note);
/** The text to mark in a path: the search's, unless it's a pattern. @param {string} text */
const marked = text => (WILDCARD.test(text) ? '' : text.trim());
/** Where it was printed: the terminal, or the closed one. @param {FileResult} r */
const whereOf = r => (r.entry ? `${r.entry.customName ?? r.entry.name} (closed)` : tabTitle(r.tab));
/** What opening it is called. @param {FileResult} r */
const openLabel = r => (r.what === FILE_WHAT.web ? 'Open in browser' : r.what === FILE_WHAT.folder ? 'Open the folder' : 'Open the file');

/**
 * A result's row: its icon, the whole path (or address), and where it was printed.
 * @param {FileResult} r
 * @param {string} text
 */
export const fileRowHtml = (r, text) => `<span class="cmd-icon">${iconOf(r.what)}</span>
    <div class="res-main"><div class="res-line1"><span class="res-title mono">${highlight(r.path, marked(text))}</span></div>
      <div class="res-line2">${escapeHtml(whereOf(r))}${r.count > 1 ? ` · printed ${r.count} times` : ''}</div></div>`;

/**
 * A result's preview: what it is, where it was printed and the line it was in.
 * @param {FileResult} r
 */
export const filePreviewHtml = r => `
    <div class="pv-head"><div class="pv-title mono">${escapeHtml(r.path)}</div>
      <div class="pv-meta">${r.what === FILE_WHAT.web ? 'Web address' : r.what === FILE_WHAT.folder ? 'Folder' : 'File'}<span class="dot-sep">·</span>printed in ${escapeHtml(whereOf(r))}</div></div>
    <pre class="pv-term">${r.lines.slice(Math.max(0, r.index - 6), r.index + 7).map((l, i) => `<span class="pv-line${Math.max(0, r.index - 6) + i === r.index ? ' hit' : ''}">${Math.max(0, r.index - 6) + i === r.index ? highlight(l, r.text) : escapeHtml(l) || ' '}</span>`).join('')}</pre>
    <div class="pv-actions"><button class="btn primary" data-act="go">${r.entry ? 'Reopen the terminal there' : 'Go to it in the terminal'} <kbd>Enter</kbd></button>
      <button class="btn" data-act="openfile">${openLabel(r)}</button>
      <button class="btn" data-act="copy">Copy</button></div>`;

/**
 * Opens a result: a web address in the browser, a folder in the file manager, a file as Ctrl+click on it does.
 * @param {FileResult} r
 */
export function openFile(r) {
  if (r.what === FILE_WHAT.web) send(PAGE.openUrl, { url: r.path });
  else if (r.what === FILE_WHAT.folder) send(PAGE.openPath, { path: r.path });
  else openChange(r.entry ? focusedTab() ?? r.tab : r.tab, r.path);
}
