// @ts-check
// Links in the compact view (js/compact.js), as in the terminal: web addresses open in the browser (Ctrl+click, or a
// plain click as Settings › Terminal says), and paths that lead to a file or folder open with Ctrl+click as a path
// printed in the terminal does (the change preview, the file manager). Which paths are real is the host's to say, so a
// line's paths are asked for once, and the view draws again when they're known.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, wsById, isRemote } from './store.js';
import { COMPACT_KIND } from './constants.js';
import { resolveIn, realPathsBy, openResolved } from './changes.js';
import { plainClick } from './weblinks.js';
import { COPY_HINT } from './termlinks.js';
import { linesOf } from './util.js';
import { LINK_CLASS, WEB_ATTR } from './compactlines.js';

/** @typedef {import('./compactlines.js').CompactLine} CompactLine */
/** @typedef {import('./compactlines.js').TextLink} TextLink */
/** @typedef {import('./compactlines.js').LineLinks} LineLinks */

/** Only the newest lines are looked through for paths: each candidate is a question to the host. */
const MAX_LINKED = 400;
/** More texts remembered than this, and they're asked again. */
const MAX_KNOWN = 3000;
/** The lines that may hold paths. */
const LINKED_KINDS = new Set(/** @type {string[]} */ ([COMPACT_KIND.prompt, COMPACT_KIND.reply, COMPACT_KIND.tool]));
/** The view's class while Ctrl is held: a link under the mouse shows it opens. */
export const CTRL_CLASS = 'cv-ctrl';

/**
 * The paths found in each text, per terminal; null while they're asked for.
 * @type {WeakMap<Tab, Map<string, TextLink[] | null>>}
 */
const found = new WeakMap();

/**
 * Where the agent's paths are found from: the folder it works in, then the terminal's.
 * @param {Tab} tab
 */
const placeOf = tab => ({ id: tab.id, cwd: tab.agent?.folder ?? tab.cwd ?? null, wsCwd: wsById(tab.wsId)?.cwd ?? null, remote: isRemote(tab) });

/** Path links are on as in the terminal (Settings › Change preview). */
const pathsOn = () => state.settings.changes.enabled && state.settings.changes.links;

/**
 * The paths in a text that lead somewhere, line by line, with their tooltips (no Ctrl+C here).
 * @param {Tab} tab
 * @param {string} text
 * @returns {Promise<TextLink[]>}
 */
async function findPaths(tab, text) {
  const place = placeOf(tab);
  const lines = linesOf(text).filter(l => l.line.trim());
  const each = await Promise.all(lines.map(async ({ line, from }) =>
    (await realPathsBy(t => resolveIn(place, t), line)).map(p => ({
      start: from + p.start, end: from + p.end, text: p.text, title: `${p.text}\n${(p.title ?? '').replace(`\n${COPY_HINT}`, '')}`,
    }))));
  return each.flat();
}

/**
 * The lines' links for drawing them: the paths known so far (the rest are asked for, and redraw is called once some
 * are found), and how web addresses open.
 * @param {Tab} tab
 * @param {CompactLine[]} lines
 * @param {() => void} redraw
 * @returns {LineLinks}
 */
export function lineLinks(tab, lines, redraw) {
  let known = found.get(tab);
  if (!known || known.size > MAX_KNOWN) found.set(tab, (known = new Map()));
  const map = known;
  const on = pathsOn();
  const newest = new Set(lines.slice(-MAX_LINKED).filter(l => LINKED_KINDS.has(l.kind)).map(l => l.text));
  return {
    plainClick: plainClick(),
    paths: line => {
      if (!on || !newest.has(line.text)) return [];
      const have = map.get(line.text);
      if (have !== undefined) return have ?? [];
      map.set(line.text, null);
      findPaths(tab, line.text).then(paths => {
        map.set(line.text, paths);
        if (paths.length) redraw();
      }, () => map.set(line.text, []));
      return [];
    },
  };
}

/**
 * Opens a link clicked in the view, as the terminal would: a web address in the browser, a path's file in the change
 * preview, a folder in the file manager, a web page in the browser. A click that ended a selection opens nothing.
 * @param {Tab} tab
 * @param {MouseEvent} e
 * @returns {boolean} whether the click was on a link
 */
export function clickLink(tab, e) {
  const link = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.(`.${LINK_CLASS}`));
  if (!link) return false;
  const selection = link.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed) return true;
  const text = link.dataset.link ?? '';
  if (link.hasAttribute(WEB_ATTR)) {
    if (e.ctrlKey || plainClick()) send(PAGE.openUrl, { url: text });
    return true;
  }
  if (!e.ctrlKey) return true;
  resolveIn(placeOf(tab), text).then(reply => openResolved(tab, reply));
  return true;
}

/**
 * Shows, while Ctrl is held over the view, that its links open.
 * @param {HTMLElement} el the view
 */
export function wireCtrl(el) {
  /** @param {KeyboardEvent | MouseEvent} e */
  const set = e => el.classList.toggle(CTRL_CLASS, e.ctrlKey);
  el.addEventListener('mousemove', set);
  el.addEventListener('keydown', set);
  el.addEventListener('keyup', set);
  el.addEventListener('mouseleave', () => el.classList.remove(CTRL_CLASS));
}
