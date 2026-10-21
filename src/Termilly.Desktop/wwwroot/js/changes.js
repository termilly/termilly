// @ts-check
// The ways into the change preview (js/preview.js), each one switchable in Settings › Change preview:
//   - Ctrl+click on a file path in a terminal (Claude's Update(…) and Write(…) lines, or any path),
//   - the "N changed" list on a terminal's header, which you clear yourself, and whose "Show all" opens them all in
//     the Git window's Agent changes (as Ctrl+Shift+D and the palette do).
// The host tells each terminal which files Claude changed there (changes:list, from Changes.cs).

import { PAGE, HOST } from './protocol.js';
import { send, onHost, request } from './host.js';
import { state, on, emit, wsById, isRemote, EVENTS } from './store.js';
import { focusedTab } from './panes.js';
import { openPopover, closePopover, isOpen } from './popups.js';
import { ICONS, escapeHtml, ltrPath } from './ui.js';
import { showChange, showMessage, KIND_BADGE } from './preview.js';
import { PATH_PATTERNS } from './hints.js';
import { find, targetOf } from './dom.js';
import { MINUTE_MS, HOUR_MS } from './util.js';

/**
 * A file Claude changed, as the host lists it (Changes.cs): its path, how to show it (relative to Claude's folder,
 * unless it's outside it), what kind of change and when.
 * @typedef {{ path: string, display: string, outside?: boolean, kind?: string | null, added?: number,
 *   removed?: number, at: string }} ChangedFile
 */
/**
 * A link found in a line of text, by character offset.
 * @typedef {{ start: number, end: number, text: string }} FoundLink
 */

const settings = () => state.settings;
const enabled = () => settings().changes.enabled;

onHost(HOST.changesList, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  tab.changes = m.files ?? [];
  emit(EVENTS.changes, tab);
});

// ---- Opening ----

/**
 * Opens the change of a path printed in a terminal (resolved by the host: relative to where Claude or the shell works).
 * @param {Tab} tab
 * @param {string} text
 */
export function openChange(tab, text) {
  request(PAGE.changesResolve, { id: tab.id, text, cwd: tab.cwd ?? null, wsCwd: wsById(tab.wsId)?.cwd ?? null, remote: isRemote(tab) }).then(reply => {
    if (reply.path) showChange(tab, reply.path, { line: reply.line ?? null });
    else showMessage(tab, reply.error ?? 'File not found.');
  });
}

/** How a change from under a minute ago is dated. */
const NOW_LABEL = 'now';

/** @param {string} iso */
const ago = iso => {
  const ms = Math.max(0, Date.now() - Date.parse(iso));
  if (ms < MINUTE_MS) return NOW_LABEL;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  return `${Math.floor(ms / HOUR_MS)}h`;
};

// ---- The changed-files list on a terminal's header ----

const list = document.createElement('section');
list.className = 'popover inbox changes-pop';
list.setAttribute('aria-label', 'Files Claude changed');
list.hidden = true;
list.innerHTML = `
  <div class="inbox-head"><span class="section-head">Changed files</span><button class="btn small" data-git title="All of them, with search, in the Git window">Open in Git window</button><button class="btn small" data-clear>Clear</button></div>
  <div class="inbox-list" role="listbox"></div>
  <div class="inbox-foot">Click a file to see the change · Delete removes it from the list</div>`;
const rowsEl = find(list, '.inbox-list');
/** @type {Tab | null} */
let listTab = null;

/** The list shows the newest files; more than this and its last row opens them all in the Git window's Agent changes. */
const LIST_LIMIT = 10;
/** A file's row in the list, and the attribute of its last row, which opens them all. */
const ROW = '.change-row';
const ALL_ATTR = 'data-all';

/**
 * A file's change in a list: its kind as a badge, or the lines it added and removed (none when unknown).
 * @param {{ kind?: string | null, added?: number, removed?: number }} f
 */
export const changeWhat = f => (KIND_BADGE[/** @type {string} */ (f.kind)]
  ? `<span class="pv-badge" data-kind="${f.kind}">${KIND_BADGE[/** @type {string} */ (f.kind)]}</span>`
  : f.added || f.removed ? `<span class="pv-plus">+${f.added}</span> <span class="pv-minus">−${f.removed}</span>` : '');

function renderList() {
  /** @type {ChangedFile[]} */
  const files = listTab?.changes ?? [];
  find(list, '[data-clear]').hidden = !files.length;
  find(list, '[data-git]').hidden = !files.length;
  const more = files.length > LIST_LIMIT
    ? `<div class="change-row change-all" role="option" tabindex="-1" data-all>Show all ${files.length} files</div>` : '';
  rowsEl.innerHTML = files.length ? files.slice(0, LIST_LIMIT).map((f, i) => {
    const slash = Math.max(f.display.lastIndexOf('\\'), f.display.lastIndexOf('/'));
    const name = f.display.slice(slash + 1);
    const folder = slash > 0 ? f.display.slice(0, slash) : '';
    const what = changeWhat(f);
    return `
      <div class="change-row" role="option" tabindex="-1" data-i="${i}" title="${escapeHtml(f.path)}">
        <span class="change-text"><b>${escapeHtml(name)}</b>${folder ? `<span class="change-folder">${escapeHtml(ltrPath(folder))}</span>` : ''}</span>
        <span class="change-what">${what}</span>
        <span class="change-ago">${ago(f.at)}</span>
        <button class="change-remove" data-remove="${i}" title="Remove from the list" aria-label="Remove from the list">${ICONS.close}</button>
      </div>`;
  }).join('') + more : '<p class="change-empty">Claude hasn’t changed any files in this terminal yet. When it does, they’re listed here.</p>';
}

/**
 * The files Claude changed in a terminal, newest first: click one to see its change, ✕ (or Delete) to take it off
 * the list, Clear to empty it. The list stays until you clear it (Settings › Change preview › Keep the list).
 * @param {Tab | null} [tab]
 * @param {import('./popups.js').Anchor | null} [anchor]
 */
export function openChangedFiles(tab = focusedTab(), anchor) {
  if (!tab) return;
  anchor ??= tab.view?.header?.querySelector('.changes-btn:not([hidden])') ?? tab.view?.header;
  if (!anchor) return;
  if (isOpen(list) && listTab === tab) return closePopover(list);
  listTab = tab;
  renderList();
  openPopover(list, anchor, { dynamic: true, onClose: () => { listTab = null; } });
  /** @type {HTMLElement | null} */ (rowsEl.querySelector(ROW) ?? list.querySelector('[data-clear]'))?.focus();
}

/** @returns {ChangedFile[]} */
const rowFiles = () => listTab?.changes ?? [];

/** @param {number} i */
function removeFile(i) {
  const file = rowFiles()[i];
  if (file) send(PAGE.changesClear, { id: /** @type {Tab} */ (listTab).id, path: file.path });
}

list.addEventListener('click', e => {
  if (!listTab) return;
  if (targetOf(e).closest('[data-clear]')) return send(PAGE.changesClear, { id: listTab.id });
  if (targetOf(e).closest('[data-git]')) {
    const tab = listTab;
    closePopover(list);
    return emit(EVENTS.openAgentChanges, { tab });
  }
  const remove = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-remove]'));
  if (remove) return removeFile(Number(remove.dataset.remove));
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
  if (!row) return;
  const tab = listTab;
  const file = rowFiles()[Number(row.dataset.i)];
  closePopover(list);
  if (row.hasAttribute(ALL_ATTR)) emit(EVENTS.openAgentChanges, { tab });
  else if (file) showChange(tab, file.path);
});

list.addEventListener('keydown', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
  const rows = [.../** @type {NodeListOf<HTMLElement>} */ (rowsEl.querySelectorAll(ROW))];
  const at = rows.indexOf(/** @type {HTMLElement} */ (row));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  } else if (e.key === 'Enter' && row) {
    row.click();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && row && !row.hasAttribute(ALL_ATTR)) {
    removeFile(at);
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
});

// The open list follows the terminal's changes (a new file, one removed, Clear).
on(EVENTS.changes, tab => {
  if (tab !== listTab || !isOpen(list)) return;
  const focused = /** @type {HTMLElement | null | undefined} */ (document.activeElement?.closest?.(ROW))
    ?.dataset.i;
  renderList();
  const rows = /** @type {NodeListOf<HTMLElement>} */ (rowsEl.querySelectorAll(ROW));
  (rows[Math.min(Number(focused ?? 0), rows.length - 1)]
    ?? /** @type {HTMLElement | null} */ (list.querySelector('[data-clear]:not([hidden])')) ?? list)?.focus?.();
});

on(EVENTS.openChangedFiles, ({ tab, anchor }) => openChangedFiles(tab, anchor));

// ---- Ctrl+click links in terminals ----

/** Shorter links are left alone: they're more likely a word than a path. */
const MIN_LINK_CHARS = 3;

/** Claude's tool lines first (only the path in them links), then its result lines, then any path. */
const LINK_PATTERNS = [
  { re: /\b(?:Update|Write|Edit|MultiEdit|NotebookEdit|Create|Read)\(([^)\n]+)\)/g, group: 1 },
  { re: /\b(?:Updated|Created|Wrote \d+ lines? to)\s+([^\s,]+)/g, group: 1 },
  // A relative path with a folder and an extension (src/a.ts, ..\b\c.cs:12), with an optional :line:column; before
  // the general path patterns, so it keeps its line number.
  { re: /(?<![\w/\\.:-])((?:\.{1,2}[\\/])?(?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?)/g, group: 1 },
  ...PATH_PATTERNS,
];

/**
 * The links in one logical line of text: { start, end, text } by character offset, without overlaps.
 * @param {string} text
 */
export function findLinks(text) {
  /** @type {FoundLink[]} */
  const found = [];
  for (const { re, group } of LINK_PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) {
      let link = group ? m[group] : m[0];
      if (!link) continue;
      const start = m.index + (group ? m[0].indexOf(link) : 0);
      link = link.replace(/[.,;!?)\]}'"]+$/, '');
      const end = start + link.length;
      if (link.length < MIN_LINK_CHARS || found.some(f => start < f.end && end > f.start)) continue;
      found.push({ start, end, text: link });
    }
  }
  return found;
}

let ctrlHeld = false;
/** @type {{ decorations: { underline: boolean, pointerCursor: boolean } } | null} */
let hovered = null; // the link under the mouse, so holding Ctrl can underline it

/** @param {boolean} held */
function setCtrl(held) {
  if (held === ctrlHeld) return;
  ctrlHeld = held;
  if (hovered) hovered.decorations = { underline: held, pointerCursor: held };
}
window.addEventListener('keydown', e => setCtrl(e.ctrlKey), true);
window.addEventListener('keyup', e => setCtrl(e.ctrlKey), true);
window.addEventListener('blur', () => setCtrl(false));

on(EVENTS.terminalOpened, tab => {
  const term = tab.view.term;
  // The list survives a page reload in the host, so a terminal asks for it when it opens.
  send(PAGE.changesList, { id: tab.id });
  term.registerLinkProvider({
    /**
     * xterm asks for the links on a row (1-based).
     * @param {number} y
     * @param {(links: object[] | undefined) => void} callback
     */
    provideLinks(y, callback) {
      if (!enabled() || !settings().changes.links) return callback(undefined);
      const buffer = term.buffer.active;
      const cols = term.cols;
      // A path can wrap across rows: read the whole logical line and map offsets back to cells.
      let first = y - 1;
      while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
      let last = y - 1;
      while (buffer.getLine(last + 1)?.isWrapped) last++;
      let text = '';
      for (let row = first; row <= last; row++) {
        const line = buffer.getLine(row);
        text += line ? line.translateToString(row !== last).padEnd(row !== last ? cols : 0) : '';
      }
      /** @param {number} offset */
      const at = offset => ({ x: (offset % cols) + 1, y: first + Math.floor(offset / cols) + 1 });
      const links = findLinks(text)
        .map(({ start, end, text: linkText }) => ({ range: { start: at(start), end: at(end - 1) }, text: linkText }))
        .filter(l => l.range.start.y <= y && l.range.end.y >= y)
        .map(({ range, text: linkText }) => {
          const link = {
            range,
            text: linkText,
            decorations: { underline: ctrlHeld, pointerCursor: ctrlHeld },
            /** @param {MouseEvent} e */
            activate(e) {
              if (e.ctrlKey && enabled() && settings().changes.links) openChange(tab, linkText);
            },
            hover() {
              hovered = link;
              link.decorations = { underline: ctrlHeld, pointerCursor: ctrlHeld };
              tab.view.body.title = 'Ctrl+click to preview the change';
            },
            leave() {
              if (hovered === link) hovered = null;
              tab.view.body.title = '';
            },
          };
          return link;
        });
      callback(links.length ? links : undefined);
    },
  });
});
