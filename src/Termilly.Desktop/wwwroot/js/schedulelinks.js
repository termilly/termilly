// @ts-check
// A schedule run's report with links (js/scheduleswindow.js): web addresses at once, then the paths that lead to a file
// or folder from the schedule's folder, found as in a terminal (js/changes.js). A click opens one, unless it ended a
// selection: the report's text is there to be selected and copied.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { wsById } from './store.js';
import { focusedTab } from './panes.js';
import { resolveIn, realPathsBy } from './changes.js';
import { showChange } from './preview.js';
import { findWebLinks } from './webaddress.js';
import { escapeHtml } from './ui.js';
import { WHERE } from './schedulerules.js';
import { linesOf } from './util.js';

/** A link in a report: where it is in the text, its text, and whether it's a web address. */
/** @typedef {{ start: number, end: number, text: string, web: boolean }} ReportLink */

/** A web page on this computer: it opens in the browser (Features/Page.cs WebPages). */
const WEB_PAGE = /\.html?$/i;
export const LINK_CLASS = 'sch-link';
/** The lines looked through for paths, from the top: a long log's every line would be a host question each. */
const MAX_PATH_LINES = 3000;

/** @param {string} text @returns {ReportLink[]} */
const webLinks = text => linesOf(text).flatMap(({ line, from }) =>
  findWebLinks(line).map(w => ({ start: from + w.start, end: from + w.end, text: w.text, web: true })));

/** @param {ReportLink} l */
const titleOf = l => (l.web ? `${l.text}\nClick to open it in your browser` : `${l.text}\nClick to open it`);

/**
 * The text as HTML, its links marked.
 * @param {string} text
 * @param {ReportLink[]} links in the text's order, none overlapping
 */
function linkedHtml(text, links) {
  let html = '';
  let at = 0;
  for (const l of links) {
    html += `${escapeHtml(text.slice(at, l.start))}<span class="${LINK_CLASS}" data-link="${escapeHtml(l.text)}"${l.web ? ' data-web' : ''} title="${escapeHtml(titleOf(l))}">${escapeHtml(text.slice(l.start, l.end))}</span>`;
    at = l.end;
  }
  return html + escapeHtml(text.slice(at));
}

/**
 * A report's text as HTML with its web addresses linked; withPaths adds the paths once they're known.
 * @param {string} text
 */
export const reportTextHtml = text => linkedHtml(text, webLinks(text));

/**
 * Where a schedule's paths are found from: its folder, or its workspace's.
 * @param {Schedule} s
 */
const placeOf = s => ({ id: '', cwd: s.cwd || null, wsCwd: s.wsId ? wsById(s.wsId)?.cwd ?? null : null, remote: false });

/**
 * The paths in a report that lead somewhere real. None for a server's run: they're on the server.
 * @param {Schedule} s
 * @param {string} text
 * @returns {Promise<ReportLink[]>}
 */
async function pathLinks(s, text) {
  if (s.where === WHERE.server) return [];
  const place = placeOf(s);
  const lines = linesOf(text).slice(0, MAX_PATH_LINES).filter(l => l.line.trim());
  const found = await Promise.all(lines.map(async ({ line, from }) =>
    (await realPathsBy(t => resolveIn(place, t), line)).map(p => ({ start: from + p.start, end: from + p.end, text: p.text, web: false }))));
  return found.flat();
}

/**
 * Adds the paths that lead somewhere to a report's element, once they're known; left as it is while text in it is
 * selected (drawing it again would lose the selection).
 * @param {HTMLElement} el
 * @param {Schedule} s
 * @param {string} text
 */
export async function withPaths(el, s, text) {
  const paths = await pathLinks(s, text);
  if (!paths.length || !el.isConnected) return;
  const selection = el.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed && el.contains(selection.anchorNode)) return;
  const web = webLinks(text);
  const links = [...web, ...paths.filter(p => !web.some(w => p.start < w.end && p.end > w.start))].sort((a, b) => a.start - b.start);
  el.innerHTML = linkedHtml(text, links);
}

/**
 * Opens a link clicked in a report: a web address in the browser; a path's file in the change preview (or the file
 * manager with no terminal for it), a folder in the file manager, a web page in the browser.
 * @param {HTMLElement} link
 * @param {Schedule} s
 */
export function openReportLink(link, s) {
  const text = link.dataset.link ?? '';
  // A drag that selected text ended on it: that's a selection, not a click.
  const selection = link.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed) return;
  if (link.hasAttribute('data-web')) {
    send(PAGE.openUrl, { url: text });
    return;
  }
  resolveIn(placeOf(s), text).then(reply => {
    if (!reply.path) return;
    const tab = focusedTab();
    if (reply.folder) send(PAGE.openPath, { path: reply.path });
    else if (WEB_PAGE.test(reply.path)) send(PAGE.openPage, { path: reply.path });
    else if (tab) showChange(tab, reply.path, { line: reply.line ?? null });
    else send(PAGE.openPath, { path: reply.path });
  });
}
