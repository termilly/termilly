// @ts-check
// Search's Files view (palette.js): the files, folders and web addresses the open terminals printed, found by name or
// by a pattern like *.txt or *.html. A path counts only where it leads somewhere real: the host looks it up from where
// the terminal works, as Ctrl+click does, so the list holds real files with their whole paths. Web addresses count as
// they are. Each shows once, with the terminal that printed it last.

import { findLinks, resolvePath, openChange } from './changes.js';
import { findWebLinks } from './webaddress.js';
import { send } from './host.js';
import { PAGE } from './protocol.js';
import { tabTitle } from './store.js';
import { escapeHtml, highlight, snippet, ICONS } from './ui.js';

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
 * A file, folder or web address a terminal printed.
 * @typedef {{ kind: 'files', what: string, path: string, text: string, tab: Tab, line: string, count: number }} FileResult
 */
/** @typedef {{ tab: Tab, lines: string[] }} FileSource */

/** Where each printed path leads (by terminal and text): its real path and whether it's a folder, or null for nowhere. */
/** @type {Map<string, { path: string, folder: boolean } | null>} */
const looked = new Map();
/** @type {Set<string>} */
const asking = new Set();

/** Whether printed paths are still being looked up (the list fills in as they are). */
export const stillLooking = () => asking.size > 0;

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
  for (const { tab, lines } of sources) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      for (const w of findWebLinks(line)) yield { tab, line, text: w.text, web: true };
      const paths = findLinks(line);
      for (const p of paths) yield { tab, line, text: p.text, web: false };
      BARE_NAME.lastIndex = 0;
      for (let m; (m = BARE_NAME.exec(line));) {
        if (!paths.some(p => m && m.index >= p.start && m.index < p.end)) yield { tab, line, text: m[1], web: false };
      }
    }
  }
}

/**
 * Looks a printed path up (once), and draws the list again when it's known.
 * @param {Tab} tab
 * @param {string} text
 * @param {string} key
 * @param {() => void} redraw
 */
function lookUp(tab, text, key, redraw) {
  if (asking.has(key)) return;
  asking.add(key);
  if (looked.size > MOST_REMEMBERED) looked.clear();
  resolvePath(tab, text).then(reply => {
    looked.set(key, reply.path ? { path: reply.path, folder: !!reply.folder } : null);
  }).catch(() => looked.set(key, null)).finally(() => {
    asking.delete(key);
    if (!asking.size) redraw();
  });
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
  const add = (/** @type {string} */ path, /** @type {string} */ what, /** @type {{ tab: Tab, line: string, text: string }} */ c) => {
    const key = what === FILE_WHAT.web ? path : path.toLowerCase();
    const known = found.get(key);
    if (known) known.count++;
    else found.set(key, { kind: 'files', what, path, text: c.text, tab: c.tab, line: c.line, count: 1 });
  };
  for (const c of printed(sources)) {
    if (c.web) {
      if (match(c.text)) add(c.text, FILE_WHAT.web, c);
      continue;
    }
    const key = `${c.tab.id}\n${c.text}`;
    if (!looked.has(key)) {
      if (match(c.text) && lookups++ < MOST_LOOKUPS) lookUp(c.tab, c.text, key, redraw);
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

/**
 * A result's row: its icon, the whole path (or address), and where it was printed.
 * @param {FileResult} r
 * @param {string} text
 */
export const fileRowHtml = (r, text) => `<span class="cmd-icon">${iconOf(r.what)}</span>
    <div class="res-main"><div class="res-line1"><span class="res-title mono">${highlight(r.path, marked(text))}</span></div>
      <div class="res-line2">${escapeHtml(tabTitle(r.tab))}${r.count > 1 ? ` · printed ${r.count} times` : ''}</div></div>`;

/**
 * A result's preview: what it is, where it was printed and the line it was in.
 * @param {FileResult} r
 */
export const filePreviewHtml = r => `
    <div class="pv-head"><div class="pv-title mono">${escapeHtml(r.path)}</div>
      <div class="pv-meta">${r.what === FILE_WHAT.web ? 'Web address' : r.what === FILE_WHAT.folder ? 'Folder' : 'File'}<span class="dot-sep">·</span>printed in ${escapeHtml(tabTitle(r.tab))}</div></div>
    <pre class="pv-term"><span class="pv-line hit">${snippet(r.line, r.text) || escapeHtml(r.line)}</span></pre>
    <div class="pv-actions"><button class="btn primary" data-act="go">${r.what === FILE_WHAT.web ? 'Open in browser' : r.what === FILE_WHAT.folder ? 'Open the folder' : 'Open'} <kbd>Enter</kbd></button>
      <button class="btn" data-act="copy">Copy</button></div>`;

/**
 * Opens a result: a web address in the browser, a folder in the file manager, a file as Ctrl+click on it does.
 * @param {FileResult} r
 */
export function openFile(r) {
  if (r.what === FILE_WHAT.web) send(PAGE.openUrl, { url: r.path });
  else if (r.what === FILE_WHAT.folder) send(PAGE.openPath, { path: r.path });
  else openChange(r.tab, r.text);
}
