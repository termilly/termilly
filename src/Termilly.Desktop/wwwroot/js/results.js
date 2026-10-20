// @ts-check
// What an agent (or any command) produced in a terminal, in a small Results list on its header: pull requests and
// issues it opened, apps it's running, commits and pushes, and its changed files. Found in the lines commands print
// (resultdetect.js), never at the prompt; nothing is fetched or opened by itself.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, on, emit, tabTitle, isInView, activityChanged, isSsh, EVENTS } from './store.js';
import { showMenu, SEPARATOR } from './popups.js';
import { escapeHtml, formatWhen } from './ui.js';
import { detectResults, RESULT_KIND } from './resultdetect.js';
import { modal } from './dialogs.js';
import { focusTab, switchWorkspace } from './panes.js';
import { targetOf } from './dom.js';
import { lineFrom } from './buffer.js';

/**
 * A result as a terminal keeps it: what was found, when, whether its app still runs (and on a server, over SSH),
 * and the command that printed it.
 * @typedef {import('./resultdetect.js').DetectedResult & { at: number, active: boolean, remote: boolean,
 *   command: string | null }} Result
 */
/**
 * A terminal's results (tab.results): the list, the unread flag, the xterm marker and the detector's push state.
 * @typedef {{ items: Result[], unread: boolean, marker: any, pushState: import('./resultdetect.js').PushState }}
 *   TabResults
 */

/** Most results a terminal keeps (newest first). */
const MAX_RESULTS = 50;
/** The lengths of the output lines read for results: shorter ones can't hold one, longer ones aren't a command's. */
const MIN_LINE_CHARS = 4;
const MAX_LINE_CHARS = 2000;
/** The hint on an app on this PC: still serving, or not any more. */
const RUNNING_LABEL = 'running';
const STOPPED_LABEL = 'stopped';

/**
 * A terminal's results, kept here: the list (newest first), whether it has some not seen yet, a marker on the next
 * row to read, and what the detector carries between lines (a push's lines come one by one).
 * @param {Tab} tab
 * @returns {TabResults}
 */
const resultsOf = tab => (tab.results ??= { items: [], unread: false, marker: null, pushState: {} });
/** @param {Tab} tab */
const itemsOf = tab => resultsOf(tab).items;

/**
 * Adds a result, or brings an existing one (same URL or title) back to the top.
 * @param {Tab} tab
 * @param {import('./resultdetect.js').DetectedResult} result
 */
function add(tab, result) {
  const list = itemsOf(tab);
  const key = result.url ?? `${result.kind}:${result.title}`;
  const i = list.findIndex(r => (r.url ?? `${r.kind}:${r.title}`) === key);
  if (i >= 0) list.splice(i, 1);
  const ssh = isSsh(tab);
  list.unshift({ ...result, at: Date.now(), active: result.kind === RESULT_KIND.app, remote: result.kind === RESULT_KIND.app && ssh, command: tab.running?.command ?? null });
  list.length = Math.min(list.length, MAX_RESULTS);
  if (!isInView(tab)) resultsOf(tab).unread = true;
  // A pull request or issue an agent opened out of sight: a desktop notification, as other news is.
  if ((result.kind === 'pr' || result.kind === 'issue') && i < 0 && !isInView(tab)) {
    send(PAGE.notify, { id: tab.id, title: `${tab.agent ? 'Claude' : 'A command'} opened ${result.title.split(' · ')[0]}`, body: `${tabTitle(tab)} · ${result.url}` });
  }
  emit(EVENTS.results, tab);
  activityChanged(tab, true);
}

// ---- Reading the output ----

/**
 * Where the scan has got to: a marker on the next row to read (as logging.js keeps its place).
 * @param {Tab} tab
 * @param {number} row
 */
function setRow(tab, row) {
  const term = tab.view?.term;
  if (!term) return;
  tab.results?.marker?.dispose();
  const buffer = term.buffer.normal;
  resultsOf(tab).marker = term.registerMarker(Math.min(0, row - (buffer.baseY + buffer.cursorY)));
}

/** Reads the lines finished since the last call, while a command runs (or always, in a shell without marks).
 * @param {Tab} tab
 * @param {boolean} [all]
 */
function scan(tab, all = false) {
  const term = tab.view?.term;
  if (!term) return;
  const buffer = term.buffer.normal;
  const end = buffer.baseY + buffer.cursorY + (all ? 1 : 0);
  if (tab.shellMarks && !tab.running) return setRow(tab, end);
  const { marker, pushState } = resultsOf(tab);
  let y = !marker ? end : marker.isDisposed ? 0 : marker.line;
  for (; y < end; y++) {
    const text = lineFrom(buffer, y, end);
    if (text !== null && text.length > MIN_LINE_CHARS && text.length < MAX_LINE_CHARS) for (const r of detectResults(text, pushState)) add(tab, r);
  }
  setRow(tab, end);
}

on(EVENTS.terminalOpened, tab => tab.view.term.onWriteParsed(() => scan(tab)));
on(EVENTS.commandStarted, tab => {
  const buffer = tab.view.term.buffer.normal;
  setRow(tab, buffer.baseY + buffer.cursorY + (tab.running?.outputOffset ? 1 : 0));
  resultsOf(tab).pushState = {};
});
// When the command ends, its apps stop running: their entries grey out.
on(EVENTS.commandEnding, ({ tab }) => {
  scan(tab, true);
  let changed = false;
  for (const r of itemsOf(tab)) if (r.kind === RESULT_KIND.app && r.active) { r.active = false; changed = true; }
  if (changed) { emit(EVENTS.results, tab); activityChanged(tab, true); }
});
on(EVENTS.seen, tab => { if (hasUnreadResults(tab)) { tab.results.unread = false; activityChanged(tab, true); } });

// ---- Showing them ----

/** @type {Record<string, string>} */
const KIND_LABEL = { pr: 'Pull requests', issue: 'Issues', app: 'Running apps', push: 'Pushes', commit: 'Commits' };
const KIND_ORDER = [RESULT_KIND.app, RESULT_KIND.pr, RESULT_KIND.issue, RESULT_KIND.push, RESULT_KIND.commit];

/**
 * How many results a terminal has (for its header button).
 * @param {Tab} tab
 */
export const resultCount = tab => tab.results?.items.length ?? 0;

/**
 * Whether a terminal has results it found out of sight, not looked at yet (a dot on its header and row).
 * @param {Tab | null | undefined} tab
 */
export const hasUnreadResults = tab => !!tab?.results?.unread;

/** @param {Tab} tab */
function itemsFor(tab) {
  /** @type {import('./popups.js').MenuEntry[]} */
  const items = [];
  for (const kind of KIND_ORDER) {
    const list = itemsOf(tab).filter(r => r.kind === kind);
    if (!list.length) continue;
    if (items.length) items.push(SEPARATOR);
    for (const r of list) {
      const hint = r.kind === RESULT_KIND.app
        ? (r.remote ? 'on the server' : r.active ? RUNNING_LABEL : STOPPED_LABEL)
        : formatWhen(r.at);
      items.push({
        label: r.title,
        hint: `<span class="res-hint${r.kind === RESULT_KIND.app && r.active && !r.remote ? ' on' : ''}">${escapeHtml(hint)}</span>`,
        action: () => openResult(tab, r),
      });
    }
  }
  if (tab.changes?.length) {
    if (items.length) items.push(SEPARATOR);
    items.push({ label: `${tab.changes.length} changed file${tab.changes.length === 1 ? '' : 's'}`, action: () => emit(EVENTS.openChangedFiles, { tab, anchor: /** @type {TabView} */ (tab.view).header }) });
  }
  return items;
}

/** Opens a result in the browser; a stopped app or a commit (no URL) copies its text instead.
 * @param {Tab} tab
 * @param {Result} r
 */
function openResult(tab, r) {
  if (r.url && !(r.kind === RESULT_KIND.app && r.remote)) send(PAGE.openUrl, { url: r.url });
  else navigator.clipboard.writeText(r.url ?? r.title).catch(() => {});
}

/**
 * The Results list under the header's button.
 * @param {Tab} tab
 * @param {import('./popups.js').Anchor} anchor
 */
export function openResults(tab, anchor) {
  resultsOf(tab).unread = false;
  activityChanged(tab, true);
  const items = itemsFor(tab);
  if (items.length) showMenu(items, anchor, { className: 'results-menu' });
}

/** "Go to result" in the palette: every terminal's results in one list. */
export function openAllResults() {
  const rows = [...state.tabs.values()].flatMap(tab => itemsOf(tab).map(r => ({ tab, r }))).sort((a, b) => b.r.at - a.r.at);
  modal('results-all', `
    <h3>Results</h3>
    <div class="results-all">${rows.length ? rows.map(({ tab, r }, i) => `
      <button class="res-all-row" data-i="${i}">
        <span class="res-kind ${r.kind}">${escapeHtml(KIND_LABEL[r.kind].replace(/s$/, ''))}</span>
        <span class="res-title">${escapeHtml(r.title)}</span>
        <span class="res-where">${escapeHtml(tabTitle(tab))} · ${escapeHtml(formatWhen(r.at))}</span>
      </button>`).join('') : '<p class="set-desc">Nothing yet: pull requests, issues, running apps and pushes that commands print show up here.</p>'}</div>
    <div class="dialog-actions"><button class="btn" data-cancel>Close</button></div>`, (dialog, close) => {
    dialog.addEventListener('click', e => {
      const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-i]'));
      if (!row) return;
      const { tab, r } = rows[Number(row.dataset.i)];
      close(null);
      if (tab.wsId !== state.activeId) switchWorkspace(tab.wsId);
      focusTab(tab);
      openResult(tab, r);
    });
    return { submit: () => /** @type {HTMLElement | null} */ (dialog.querySelector('[data-i]'))?.click() };
  });
}
