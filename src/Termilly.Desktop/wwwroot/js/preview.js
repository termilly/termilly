// @ts-check
// The change preview: the whole of a file Claude changed (or any file Ctrl+clicked in a terminal), as a diff or the
// whole file, coloured for its language. One view, in one of three places (Settings › Change preview): a pane in
// the workspace's layout next to the terminal, a panel over the right edge, or a window you can move. The host
// keeps the copies and works out the diff (Changes.cs, LineDiff.cs); this only draws it, a screenful at a time, so
// big files stay quick.

import { PAGE, HOST } from './protocol.js';
import { send, request, onHost, platform, PLATFORM } from './host.js';
import { state, on, emit, wsById, findPreview, EVENTS, GROUPS } from './store.js';
import { focusTab, restoreFocus, setPreviewRenderer, insertPreview, removePreview } from './panes.js';
import { scheduleFit } from './terminals.js';
import { ICONS, ltrPath, escapeHtml } from './ui.js';
import { buildDiffRows, diffRowHtml, DIFF_ROW, DIFF_SCROLL, DIFF_LINE, DIFF_TARGET } from './diffrows.js';
import { debounce } from './util.js';
import { fileSize, imagesHtml, measureImages } from './pictures.js';
import { updateSettings } from './preferences.js';
import { SETTING_VALUES, CHANGE_SOURCE, CHANGE_KIND } from './constants.js';
import { byId, find, targetOf, WORKSPACE_ID, dragPointer, dragFloating, onMiddleClick } from './dom.js';

/**
 * A file's change as the host sends it for the preview (Changes.cs): the diff, and what's shown around it: the path
 * to show, a note or error, how many lines were added and removed, how many edits, where the "before" came from,
 * and a binary file's sizes.
 * @typedef {import('./diffrows.js').DiffData & { display?: string | null, note?: string | null,
 *   error?: string | null, added?: number, removed?: number, edits?: number, source?: string | null,
 *   eolOnly?: boolean, beforeSize?: number, afterSize?: number }} ChangeData
 */
/**
 * A file in a terminal's changed files (tab.changes): its path, the path to show, its kind and when it changed.
 * @typedef {{ path: string, display?: string, kind?: string, at: string }} ChangedFile
 */
/**
 * What's shown: the terminal, the file and a line to scroll to, diff or file mode, which edits to compare (and
 * whether that was picked by hand), the folds opened, the host's answer, a message instead of a file, and which
 * newer change is offered.
 * @typedef {{ tab: Tab, path: string | null, line?: number | null, mode: string, compare: string,
 *   compareChosen?: boolean, expanded: Set<string>, data: ChangeData | null, loading?: boolean,
 *   offeredAt?: string | null, offer?: ChangedFile | null, seenAt?: string, message?: string,
 *   error?: string | null, scroll?: number, stale?: boolean, gone?: boolean }} PreviewView
 */
// A view is also a tab: each file open keeps its own (scroll, mode, folds, its answer); stale: it changed while its
// tab wasn't shown, so it's read again when it is; gone: deleted outside Termilly.

/** The choices of the settings used here (C#'s SettingValues). */
const { changeView, changeCompare, changeNewFile, changeFollow, changeLayout, changePlacement } = SETTING_VALUES;

/**
 * Where the preview is: Settings' places for it (a split beside the terminal, a side panel, a floating window), or
 * the Git window's right column (its Agent changes).
 */
const PLACEMENT = Object.freeze({
  split: changePlacement.split, panel: changePlacement.panel, float: changePlacement.float, window: 'window',
});
/** The head's controls (data-pv): the mode and compare choices, and the buttons. */
const CONTROL = Object.freeze({
  mode: 'mode', compare: 'compare', prev: 'prev', next: 'next', reveal: 'reveal', close: 'close', newer: 'newer',
  wrap: 'wrap', git: 'git',
});
/** The preview's classes (app.css) while it's in the Git window, and while its long lines wrap. */
const IN_WINDOW = 'in-window';
const WRAP = 'wrap';
/** The side panel's narrowest, and the room it always leaves the workspace beside it, in pixels. */
const PANEL_MIN_PX = 320;
const PANEL_ROOM_PX = 120;
/** The scroller's height (in pixels) while it has none yet, as when it's hidden. */
const FALLBACK_HEIGHT_PX = 600;
/** Rows drawn beyond each edge of the view, so scrolling doesn't show blanks. */
const OVERSCAN_ROWS = 50;
/** Lines kept above the line scrolled to, so it isn't right at the top. */
const LINES_ABOVE_TARGET = 3;

const settings = () => state.settings;

// ---- The element, and the three places it can be ----

const el = document.createElement('div');
el.className = 'pane preview-pane';
el.tabIndex = -1;
el.innerHTML = `
  <div class="pane-header pv-head">
    <span class="pane-title"><span class="pv-icon">${ICONS.diff}</span><span class="pane-name pv-name"></span><span class="pv-badge" hidden></span></span>
    <span class="pv-path"></span>
    <span class="pv-stats"></span>
    <span class="pane-actions">
      <span class="seg pv-seg" data-pv="mode"><button data-value="diff">Diff</button><button data-value="file">File</button></span>
      <span class="seg pv-seg" data-pv="compare"><button data-value="session" title="Everything Claude changed in this file">All edits</button><button data-value="last" title="Only Claude's last edit">Last edit</button></span>
      <span class="seg pv-seg"><button data-pv="${CONTROL.wrap}" title="Wrap long lines">Wrap</button></span>
      <button class="pane-btn pv-btn" data-pv="${CONTROL.git}" title="Open in the Git window">${ICONS.git}</button>
      <button class="pane-btn pv-btn" data-pv="prev" title="Previous changed file (P)">${ICONS.chevronLeft}</button>
      <button class="pane-btn pv-btn" data-pv="next" title="Next changed file (N)">${ICONS.chevronRight}</button>
      <button class="pane-btn pv-btn" data-pv="reveal" title="Show in ${platform === PLATFORM.windows ? 'Explorer' : 'the file manager'}">${ICONS.folder}</button>
      <button class="pane-btn pv-btn" data-pv="close" title="Close (Esc)">${ICONS.close}</button>
    </span>
  </div>
  <div class="pv-tabs" role="tablist" hidden></div>
  <div class="pv-note" hidden></div>
  <div class="pv-newer" hidden><span></span><button class="btn small" data-pv="newer">Show it</button></div>
  <div class="pv-scroll"><div class="pv-pictures" hidden></div><div class="pv-spacer"><div class="pv-rows"></div></div><div class="pv-message" hidden></div></div>`;

const nameEl = find(el, '.pv-name');
const pathEl = find(el, '.pv-path');
const badgeEl = find(el, '.pv-badge');
const statsEl = find(el, '.pv-stats');
const noteEl = find(el, '.pv-note');
const newerEl = find(el, '.pv-newer');
const scroller = find(el, DIFF_SCROLL);
const spacer = find(el, '.pv-spacer');
const tabsEl = find(el, '.pv-tabs');
const picturesEl = find(el, '.pv-pictures');
const rowsEl = find(el, '.pv-rows');
const messageEl = find(el, '.pv-message');

const workspaceEl = byId(WORKSPACE_ID);
const panel = document.createElement('aside');
panel.className = 'preview-panel';
panel.hidden = true;
panel.innerHTML = '<div class="pv-grip" title="Drag to resize"></div>';
const floating = document.createElement('div');
floating.className = 'preview-float';
floating.hidden = true;
workspaceEl.append(panel, floating);

setPreviewRenderer(() => el);

/**
 * What's shown: the terminal it's about, the file, the host's answer ({ before, after, ops, kind, note, ... }), the
 * mode (diff or file), which edits to compare, and folds opened by hand.
 * @type {PreviewView | null}
 */
let view = null;
/**
 * The files open in tabs, in their order; view is one of them (or a message, which isn't a tab).
 * @type {PreviewView[]}
 */
let views = [];
/** @type {string | null} */
let placement = null; // where the element is now: 'split' (with the workspace id), 'panel', 'float' or 'window'
/** @type {string | null} */
let splitWs = null;

/**
 * The Git window's Agent changes (js/gitagent.js) borrow the preview: while it's open, the preview lives in its right
 * column, whatever Settings says, and moves through the files in the window's order.
 * @type {{ container: HTMLElement, order: (() => string[]) | null } | null}
 */
let windowHost = null; // { container, order: () => paths }

export const isPreviewOpen = () => !!view;

/** Long lines wrap, or not: Settings › Change preview › Wrap long lines, which the Git window's diffs follow too. */
export const toggleWrap = () => updateSettings(GROUPS.changes, { wrap: !settings().changes.wrap });
export const previewTab = () => view?.tab ?? null;

/** Puts the preview in the Git window (container), or, with null, closes it there when the window closes.
 * @param {HTMLElement | null} container
 * @param {{ order?: (() => string[]) | null }} [options]
 */
export function setPreviewHost(container, { order = null } = {}) {
  if (!container) {
    if (!windowHost) return;
    if (placement === PLACEMENT.window) {
      view = null;
      views = [];
      watchTabs();
      unmount();
    }
    windowHost = null;
    return;
  }
  windowHost = { container, order };
}

/** @param {Tab} tab */
function mount(tab) {
  if (windowHost) {
    if (placement === PLACEMENT.window) return;
    unmount();
    windowHost.container.append(el);
    el.classList.add(IN_WINDOW);
    placement = PLACEMENT.window;
    return;
  }
  let wanted = settings().changes.placement;
  const ws = wsById(tab.wsId);
  if (wanted === PLACEMENT.split && !ws) wanted = PLACEMENT.panel; // the scratch terminal
  if (placement === wanted && (wanted !== PLACEMENT.split || splitWs === ws?.id)) return;
  unmount();
  if (wanted === PLACEMENT.split) {
    // A split always has its workspace: without one, wanted became 'panel' above.
    if (!findPreview(/** @type {Workspace} */ (ws).root) && !insertPreview(/** @type {Workspace} */ (ws), tab.id)) {
      wanted = PLACEMENT.panel;
    } else splitWs = /** @type {Workspace} */ (ws).id;
  }
  if (wanted === PLACEMENT.panel) panel.append(el);
  if (wanted === PLACEMENT.float) floating.append(el);
  panel.hidden = wanted !== PLACEMENT.panel;
  floating.hidden = wanted !== PLACEMENT.float;
  el.classList.toggle('in-split', wanted === PLACEMENT.split);
  placement = wanted;
  scheduleFit();
}

function unmount() {
  if (placement === PLACEMENT.split && splitWs) {
    const ws = wsById(splitWs);
    if (ws) removePreview(ws);
  }
  panel.hidden = floating.hidden = true;
  el.remove();
  el.classList.remove(IN_WINDOW);
  placement = null;
  splitWs = null;
  scheduleFit();
}

/** Closes the preview, with all its tabs. */
export function closePreview() {
  if (!view) return;
  const tab = view.tab;
  view = null;
  views = [];
  watchTabs();
  unmount();
  if (state.tabs.has(tab.id)) focusTab(tab); else restoreFocus();
}

/**
 * Closes one tab: the one beside it is shown (the next, else the one before); the last one closes the preview.
 * @param {PreviewView} closing
 */
function closeTab(closing) {
  const at = views.indexOf(closing);
  if (at < 0) return;
  if (views.length === 1) return closePreview();
  views.splice(at, 1);
  watchTabs();
  if (view !== closing) return renderTabs();
  const next = views[Math.min(at, views.length - 1)];
  view = next;
  mount(next.tab);
  render();
  restoreScroll();
  if (next.stale) load(next, { keepScroll: true });
}

// ---- Tabs: one per file open, each watched for changes made outside Termilly ----

/** A tab's name: the file's, with its folder when another tab has the same name. @param {PreviewView} v */
function tabName(v) {
  const parts = /** @type {string} */ (v.path).split(/[\\/]/);
  const name = /** @type {string} */ (parts.pop());
  const twin = views.some(o => o !== v && o.path?.split(/[\\/]/).pop()?.toLowerCase() === name.toLowerCase());
  return twin && parts.length ? `${parts.pop()}/${name}` : name;
}

/** What the tab strip last drew. */
let tabsHtml = '';

/** The tab strip: shown with two tabs or more, and never in the Git window (which has its own list). */
function renderTabs() {
  tabsEl.hidden = views.length < 2 || placement === PLACEMENT.window;
  if (tabsEl.hidden) return;
  // Drawn again only when something changed: a redraw between a button's press and release would lose its click.
  const html = views.map((v, i) => `
    <span class="pv-tab${v === view ? ' on' : ''}${v.gone ? ' gone' : ''}" role="tab" aria-selected="${v === view}" data-tab="${i}"
      title="${escapeHtml(`${v.path}${v.gone ? ' (deleted)' : ''}`)}"><span class="pv-tab-name">${escapeHtml(tabName(v))}</span><button class="pv-tab-close" data-tab-close="${i}" title="Close" aria-label="Close">${ICONS.close}</button></span>`).join('');
  if (html === tabsHtml) return;
  tabsHtml = html;
  tabsEl.innerHTML = html;
  tabsEl.querySelector('.pv-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

tabsEl.addEventListener('click', e => {
  const close = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tab-close]'));
  if (close) return closeTab(views[Number(close.dataset.tabClose)]);
  const tab = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tab]'));
  const v = tab && views[Number(tab.dataset.tab)];
  if (v && v !== view && v.path) selectTab(v, { tab: v.tab, line: null, focus: true, wholeFile: false });
});
// A middle click closes a tab, as in a browser.
onMiddleClick(tabsEl, e => {
  const tab = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tab]'));
  if (tab) closeTab(views[Number(tab.dataset.tab)]);
});

/** The paths last asked to be watched, so the host is only told when they change. */
let watched = '';
/** Tells the host which files are open, to hear when one changes outside Termilly (PreviewWatch.cs). */
function watchTabs() {
  const paths = views.map(v => /** @type {string} */ (v.path));
  const key = paths.join('\n');
  if (key === watched) return;
  watched = key;
  send(PAGE.previewWatch, { paths });
}

// A file open in a tab changed, was deleted or came back: the tab shown reads it again where it is; another one
// does when it's shown.
onHost(HOST.previewFileChanged, m => {
  for (const v of views.filter(o => samePath(o.path, m.path))) {
    v.gone = !m.exists;
    v.stale = true;
    if (v === view) load(v, { keepScroll: true });
  }
  renderTabs();
});

// A workspace that lost its last terminal can't hold the pane any more.
on(EVENTS.previewDropped, ws => {
  if (!view || placement !== PLACEMENT.split || splitWs !== ws.id) return;
  placement = null;
  splitWs = null;
  closePreview();
});

// ---- Asking the host ----

/**
 * @param {Tab} tab
 * @param {string} path
 * @param {string} compare
 */
const fetchChange = (tab, path, compare) => request(PAGE.changesGet, { id: tab.id, path, compare });

// ---- Showing a file ----

/**
 * Opens the preview on a file's change in a terminal. line: a line to scroll to (a clicked path:line). Asking for
 * the file already shown, in the same terminal, just brings it forward. wholeFile: shown as the file rather than a
 * diff (the Git window's search, so a line that didn't change shows too).
 * A file already open in a tab is brought forward in it (scrolled to the line, read again if it changed); another
 * opens in a new tab, or, with replace (N and P, following Claude, the Git window), in the tab shown.
 * @param {Tab} tab
 * @param {string} path
 * @param {{ line?: number | null, focus?: boolean, wholeFile?: boolean, replace?: boolean }} [options]
 */
export async function showChange(tab, path, { line = null, focus = true, wholeFile = false, replace = false } = {}) {
  const open = views.find(v => samePath(v.path, path));
  if (open) return selectTab(open, { tab, line, focus, wholeFile });
  const s = settings();
  /** @type {PreviewView} */
  const opened = {
    tab, path, line,
    mode: wholeFile || s.changes.view === changeView.file ? changeView.file : changeView.diff,
    compare: compareFor(tab, path),
    compareChosen: false,
    expanded: new Set(),
    data: null,
    loading: true,
    // Files Claude changed before this opened aren't offered; only those it changes from now on.
    offeredAt: tab.changes?.[0]?.at ?? null,
    offer: null,
  };
  saveScroll();
  addTab(opened, replace || !!windowHost);
  view = opened;
  mount(tab);
  render();
  if (focus) el.focus({ preventScroll: true });
  emit(EVENTS.previewShown, { tab, path });
  await load(opened);
}

/**
 * Puts a new file's view among the tabs: in place of the one shown (replace), else after it.
 * @param {PreviewView} opened
 * @param {boolean} replace
 */
function addTab(opened, replace) {
  const at = view ? views.indexOf(view) : -1;
  if (replace && at >= 0) views[at] = opened;
  else views.splice(at >= 0 ? at + 1 : views.length, 0, opened);
  watchTabs();
}

/**
 * Shows a tab that's open: where it was scrolled, unless a line is asked for; read again when its file changed
 * since, or the terminal asking is another one (whose copies of Claude's edits it compares).
 * @param {PreviewView} open
 * @param {{ tab: Tab, line: number | null, focus: boolean, wholeFile: boolean }} options
 */
async function selectTab(open, { tab, line, focus, wholeFile }) {
  saveScroll();
  const reread = open.stale || open.tab !== tab;
  open.tab = tab;
  if (line != null) open.line = line;
  if (wholeFile) open.mode = changeView.file;
  view = open;
  mount(tab);
  render({ scrollToChange: line != null });
  if (line == null) restoreScroll();
  if (focus) el.focus({ preventScroll: true });
  emit(EVENTS.previewShown, { tab, path: open.path });
  if (reread) await load(open, { keepScroll: line == null });
}

/** Keeps where the tab shown is scrolled, for when it's shown again. */
function saveScroll() {
  if (view) view.scroll = scroller.scrollTop;
}

function restoreScroll() {
  scroller.scrollTop = view?.scroll ?? 0;
  lastRange = '';
  drawVisible();
}

/**
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** @param {string | null | undefined} iso */
const time = iso => Date.parse(/** @type {string} */ (iso)) || 0; // a missing time parses as NaN: 0

/**
 * Which edits to compare: all of Claude's edits to the file, or the last one (Settings › Change preview › Compare).
 * The callers pass the terminal and file, which the setting doesn't depend on.
 * @type {(tab?: Tab, path?: string | null) => string}
 */
const compareFor = () => (settings().changes.compare === changeCompare.lastEdit ? changeCompare.lastEdit : changeCompare.session);

/**
 * A file Claude created (or deleted) is shown as the file itself, coloured, rather than as every line added (or
 * removed), unless Settings › Change preview › New files open as says "A diff".
 * @param {ChangeData | null} data
 */
const asWholeFile = data => settings().changes.newFile !== changeNewFile.diff && (data?.kind === CHANGE_KIND.created || data?.kind === CHANGE_KIND.deleted);

/**
 * Nothing to compare the file with (no copy from before, and no git): it's shown as it is, rather than as a diff
 * with every line folded away as unchanged.
 * @param {ChangeData | null} data
 */
const nothingToCompare = data => !!data?.note && data.kind === CHANGE_KIND.modified && data.after != null && data.before === data.after;

/**
 * Shown as the file itself rather than a diff.
 * @param {ChangeData | null} data
 */
const showsWhole = data => asWholeFile(data) || nothingToCompare(data);

/**
 * Opens the preview with only a message (no file): there's nothing to show yet.
 * @param {Tab} tab
 * @param {string} text
 * @param {{ focus?: boolean }} [options]
 */
export function showMessage(tab, text, { focus = true } = {}) {
  view = { tab, path: null, mode: changeView.diff, compare: changeCompare.session, expanded: new Set(), data: null, message: text };
  mount(tab);
  render();
  if (focus) el.focus({ preventScroll: true });
}

/**
 * Reads a tab's file (the one shown, by default) and draws it if it's still shown. keepScroll: read again in place
 * (it changed), rather than opened (scrolled to the first change).
 * @param {PreviewView | null} [current]
 * @param {{ keepScroll?: boolean }} [options]
 */
async function load(current = view, { keepScroll = false } = {}) {
  if (!current?.path) return;
  const reply = await fetchChange(current.tab, current.path, current.compare);
  current.loading = false;
  current.stale = false;
  current.data = reply.view ?? null;
  current.error = reply.error ?? reply.view?.error ?? null;
  current.gone = current.data?.kind === CHANGE_KIND.missing;
  if (view !== current) return renderTabs(); // another tab is shown now
  if (!keepScroll) return render({ scrollToChange: true });
  saveScroll();
  render();
  restoreScroll();
}

// While Claude keeps editing the open file, the preview follows. When it changes another file, the preview offers it
// with a button, or switches to it (Settings › Change preview › When Claude changes another file).
/** How long after Claude changes the file shown it's read again (its edits come in bursts). */
const RELOAD_DELAY = 300;
const loadLater = debounce(() => view && load(), RELOAD_DELAY);
on(EVENTS.changes, tab => {
  // Claude changed a file open in a tab that isn't shown: it's read again when it is.
  for (const v of views) {
    const changed = v !== view && v.tab === tab && /** @type {ChangedFile[]} */ (tab.changes ?? []).find(f => samePath(f.path, v.path));
    if (changed && changed.at !== v.seenAt) {
      v.seenAt = changed.at;
      v.stale = true;
    }
  }
  if (!view?.path || view.tab !== tab) return;
  const files = /** @type {ChangedFile[]} */ (tab.changes ?? []);
  const newest = files[0]; // the host lists the most recent first
  // The Git window lists new files itself, so there's nothing to offer there.
  if (newest && placement !== PLACEMENT.window && !samePath(newest.path, view.path) && time(newest.at) > time(view.offeredAt)) {
    view.offeredAt = newest.at;
    if (settings().changes.follow === changeFollow.follow) {
      showChange(tab, newest.path, { focus: false, replace: true }); // the terminal keeps the keyboard
      return;
    }
    view.offer = newest;
    renderOffer();
  }
  const shown = files.find(f => samePath(f.path, /** @type {PreviewView} */ (view).path));
  if (!shown || shown.at === view.seenAt) return;
  view.seenAt = shown.at;
  if (!view.compareChosen) view.compare = compareFor(tab, view.path);
  loadLater();
});

function renderOffer() {
  const offer = view?.offer;
  newerEl.hidden = !offer;
  /** @type {Element} */ (newerEl.firstElementChild).textContent = offer ? `Claude ${offer.kind === CHANGE_KIND.created ? 'created' : 'changed'} ${offer.display}` : '';
}

on(EVENTS.settings, () => {
  if (!view) return;
  if (!settings().changes.enabled) return closePreview();
  mount(view.tab); // the placement may have changed
  render();
});

// ---- Rows ----

/**
 * The rows to draw (js/diffrows.js), with this view's opened folds.
 * @param {ChangeData | null} data
 * @param {string} mode
 */
const buildRows = (data, mode) => buildDiffRows(/** @type {ChangeData} */ (data), {
  mode, expanded: /** @type {PreviewView} */ (view).expanded, whole: showsWhole(data),
});
const rowHtml = diffRowHtml;

// ---- Drawing ----

/** A row's height before one is measured. */
const DEFAULT_LINE_HEIGHT = 18;

/** @type {import('./diffrows.js').DiffRows} */
let rows = [];
let lineHeight = DEFAULT_LINE_HEIGHT;
let virtual = true;
let lastRange = '';
let drawnFirst = 0; // the index of the first row drawn

function measureLine() {
  rowsEl.innerHTML = '<div class="pv-row ctx"><span class="pv-no">1</span><span class="pv-code">x</span></div>';
  lineHeight = /** @type {Element} */ (rowsEl.firstElementChild).getBoundingClientRect().height || DEFAULT_LINE_HEIGHT;
}

/** What a changed file's kind shows on its badge, here and in the changes list (a modified file has none). */
/** @type {Readonly<Record<string, string>>} */
export const KIND_BADGE = Object.freeze({
  [CHANGE_KIND.created]: 'new', [CHANGE_KIND.deleted]: 'deleted', [CHANGE_KIND.binary]: 'binary', [CHANGE_KIND.large]: 'too large',
});
/** The preview's badges: a file can also be gone by the time it's opened. */
/** @type {Readonly<Record<string, string>>} */
const PREVIEW_BADGE = Object.freeze({ ...KIND_BADGE, [CHANGE_KIND.missing]: 'missing' });
/** Above this many rows lines never wrap: wrapped lines have different heights, so only short files can. */
const MAX_WRAPPED_ROWS = 3000;

/** @param {{ scrollToChange?: boolean }} [options] */
function render({ scrollToChange = false } = {}) {
  if (!view) return;
  const data = view.data;
  renderTabs();
  renderTitle(data);
  renderToggles(data);
  renderNotes(data);
  renderOffer();
  // An image shows as pictures: alone when it's binary, above its text diff for an SVG.
  const pictures = view.message ? '' : imagesHtml(/** @type {import('./pictures.js').Pictured} */ (data ?? {}));
  picturesEl.innerHTML = pictures;
  picturesEl.hidden = !pictures;
  if (pictures) measureImages(picturesEl);
  const textless = !!pictures && data?.before == null && data?.after == null;
  const message = textless ? null : view.message ?? (view.loading && !data ? 'Loading…' : messageFor(data));
  messageEl.hidden = !message;
  messageEl.textContent = message ?? '';
  spacer.hidden = !!message || textless;
  if (message || textless) return;
  renderRows(data);
  if (scrollToChange) scrollToFirst();
}

// The drawing functions run only while a view is open (render checks), so they read it as there.

/**
 * The file's name and path, its kind and how many lines were added and removed.
 * @param {ChangeData | null} data
 */
function renderTitle(data) {
  const file = /** @type {PreviewView} */ (view).path ?? '';
  nameEl.textContent = /** @type {PreviewView} */ (view).message
    ? 'Change preview'
    : /** @type {string} */ (file.split(/[\\/]/).pop());
  pathEl.textContent = /** @type {PreviewView} */ (view).message ? '' : ltrPath(data?.display ?? file);
  pathEl.title = file;
  const kind = data?.kind;
  badgeEl.hidden = !kind || kind === CHANGE_KIND.modified;
  badgeEl.textContent = PREVIEW_BADGE[/** @type {string} */ (kind)] ?? '';
  badgeEl.dataset.kind = kind ?? '';
  statsEl.innerHTML = data && (data.added || data.removed)
    ? `<span class="pv-plus">+${data.added}</span> <span class="pv-minus">−${data.removed}</span>` : '';
}

/**
 * Diff/File unless the setting says diff only; All/Last only when there's more than one edit; the buttons.
 * @param {ChangeData | null} data
 */
function renderToggles(data) {
  const modeSeg = find(el, '[data-pv="mode"]');
  modeSeg.hidden = !!(/** @type {PreviewView} */ (view).message)
    || settings().changes.view === changeView.diffOnly || showsWhole(data);
  for (const b of /** @type {HTMLCollectionOf<HTMLElement>} */ (modeSeg.children)) {
    b.classList.toggle('on', b.dataset.value === /** @type {PreviewView} */ (view).mode);
  }
  const compareSeg = find(el, '[data-pv="compare"]');
  compareSeg.hidden = !data || /** @type {number} */ (data.edits) < 2 || data.source === CHANGE_SOURCE.git;
  for (const b of /** @type {HTMLCollectionOf<HTMLElement>} */ (compareSeg.children)) {
    b.classList.toggle('on', b.dataset.value === /** @type {PreviewView} */ (view).compare);
  }
  const files = fileOrder();
  for (const name of [CONTROL.prev, CONTROL.next]) find(el, `[data-pv="${name}"]`).hidden = files.length < 2;
  find(el, '[data-pv="reveal"]').hidden = !(/** @type {PreviewView} */ (view).path);
  const wrap = find(el, `[data-pv="${CONTROL.wrap}"]`);
  wrap.classList.toggle('on', !!settings().changes.wrap);
  /** @type {HTMLElement} */ (wrap.parentElement).hidden = !(/** @type {PreviewView} */ (view).path);
  // In the Git window already, which has its own close.
  find(el, `[data-pv="${CONTROL.git}"]`).hidden = placement === PLACEMENT.window || !(/** @type {PreviewView} */ (view).path);
  find(el, `[data-pv="${CONTROL.close}"]`).hidden = placement === PLACEMENT.window;
}

/** @param {ChangeData | null} data */
function renderNotes(data) {
  const notes = [];
  if (/** @type {PreviewView} */ (view).error) notes.push(/** @type {PreviewView} */ (view).error);
  if (data?.note) notes.push(data.note);
  if (data?.eolOnly) notes.push('Only line endings changed.');
  if (data?.source === CHANGE_SOURCE.git && !data.note) notes.push('Compared with the last commit.');
  // asWholeFile is only true with data.
  if (asWholeFile(data) && /** @type {ChangeData} */ (data).kind === CHANGE_KIND.created
    && /** @type {number} */ (/** @type {ChangeData} */ (data).edits) > 1) {
    notes.push('Claude created this file. Last edit shows what its later edits changed.');
  }
  noteEl.textContent = notes.join(' ');
  noteEl.hidden = !notes.length;
}

/**
 * The rows: all of them when they wrap, else only the ones in view (drawVisible draws more as it scrolls).
 * @param {ChangeData | null} data
 */
function renderRows(data) {
  const { changes } = settings();
  rows = buildRows(data, /** @type {PreviewView} */ (view).mode);
  if (rows.plain) {
    noteEl.textContent = [noteEl.textContent, 'Too big to colour quickly, so it’s shown plain.'].filter(Boolean).join(' ');
    noteEl.hidden = false;
  }
  virtual = !changes.wrap || rows.length > MAX_WRAPPED_ROWS;
  el.classList.toggle('sbs',
    changes.layout === changeLayout.sideBySide && /** @type {PreviewView} */ (view).mode === changeView.diff);
  el.classList.toggle(WRAP, !virtual);
  measureLine();
  lastRange = '';
  if (!virtual) {
    spacer.style.height = '';
    rowsEl.style.transform = '';
    rowsEl.innerHTML = rows.map(r => rowHtml(r)).join('');
    drawnFirst = 0;
  } else {
    spacer.style.height = `${rows.length * lineHeight}px`;
    drawVisible();
  }
}

/** @param {ChangeData | null} data */
function messageFor(data) {
  if (!data) return 'Nothing to show.';
  if (data.error) return data.error;
  if (data.kind === CHANGE_KIND.binary) return `Binary file: ${fileSize(/** @type {number} */ (data.beforeSize))} → ${fileSize(/** @type {number} */ (data.afterSize))}. Show it in ${platform === PLATFORM.windows ? 'Explorer' : 'the file manager'} to open it.`;
  if (data.kind === CHANGE_KIND.large) return data.note ?? 'Too large to preview.';
  if (!data.ops?.length) return data.after === '' || data.before === '' ? 'The file is empty.' : null;
  return null;
}

function drawVisible() {
  if (!virtual || !rows.length) return;
  const top = scroller.scrollTop;
  const height = scroller.clientHeight || FALLBACK_HEIGHT_PX;
  const first = Math.max(0, Math.floor(top / lineHeight) - OVERSCAN_ROWS);
  const last = Math.min(rows.length, Math.ceil((top + height) / lineHeight) + OVERSCAN_ROWS);
  const range = `${first}:${last}`;
  if (range === lastRange) return;
  lastRange = range;
  drawnFirst = first;
  rowsEl.style.transform = `translateY(${first * lineHeight}px)`;
  rowsEl.innerHTML = rows.slice(first, last).map(r => rowHtml(r)).join('');
}

let frame = 0;
scroller.addEventListener('scroll', () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(drawVisible);
});
new ResizeObserver(() => { lastRange = ''; drawVisible(); }).observe(scroller);

/** Scrolls to the clicked line, or the first change (file mode) / the top (diff mode). */
function scrollToFirst() {
  let index = -1;
  if (/** @type {PreviewView} */ (view).line) {
    index = rows.findIndex(r => (r.b ?? r.right?.no) === /** @type {PreviewView} */ (view).line);
  }
  if (index < 0 && /** @type {PreviewView} */ (view).mode === changeView.file) index = rows.findIndex(r => r.t !== DIFF_ROW.ctx);
  const y = index > 0 ? Math.max(0, index - LINES_ABOVE_TARGET) * lineHeight : 0;
  if (virtual) {
    scroller.scrollTop = y;
    drawVisible();
  } else {
    scroller.querySelectorAll(DIFF_LINE)[Math.max(0, index - LINES_ABOVE_TARGET)]?.scrollIntoView({ block: 'start' });
    if (index <= 0) scroller.scrollTop = 0;
  }
  if (index >= 0 && /** @type {PreviewView} */ (view).line) {
    rowsEl.children[index - drawnFirst]?.classList.add(DIFF_TARGET);
  }
}

// ---- Interaction ----

/**
 * The changed files' paths in the order N and P go through: the window's tree, or newest first.
 * @returns {string[]}
 */
const fileOrder = () => (placement === PLACEMENT.window && windowHost?.order ? windowHost.order() : (view?.tab.changes ?? []).map(f => f.path));

/**
 * The Git window on this terminal's Agent changes, at the file shown (js/gitwindow.js, through an event: it imports
 * this module). The preview moves there, so it closes here.
 */
function openInGitWindow() {
  const { tab, path } = /** @type {PreviewView} */ (view);
  closePreview();
  emit(EVENTS.openAgentChanges, { tab, path });
}

/**
 * The next (1) or previous (-1) changed file. Runs only while the preview is open (its keys and buttons).
 * @param {number} step
 */
function moveFile(step) {
  const files = fileOrder();
  if (files.length < 2) return;
  const at = files.findIndex(p => samePath(p, /** @type {PreviewView} */ (view).path));
  const next = files[(at + step + files.length) % files.length];
  showChange(/** @type {PreviewView} */ (view).tab, next, { replace: true });
}

el.addEventListener('click', e => {
  if (!view) return;
  const option = /** @type {HTMLElement | null} */ (targetOf(e).closest('.pv-seg [data-value]'));
  if (option) {
    const which = /** @type {HTMLElement} */ (option.parentElement).dataset.pv;
    if (which === CONTROL.mode) {
      view.mode = /** @type {string} */ (option.dataset.value);
      view.expanded.clear();
      render({ scrollToChange: true });
    } else {
      view.compare = /** @type {string} */ (option.dataset.value);
      view.compareChosen = true; // the file keeps this choice while Claude goes on editing it
      view.loading = true;
      load();
    }
    return;
  }
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-pv]'))?.dataset.pv;
  if (action === CONTROL.close) return closePreview();
  if (action === CONTROL.newer && view.offer) return showChange(view.tab, view.offer.path);
  if (action === CONTROL.prev) return moveFile(-1);
  if (action === CONTROL.next) return moveFile(1);
  if (action === CONTROL.reveal) return send(PAGE.openPath, { path: view.path });
  // The setting itself, so the choice stays and the Git window's diffs agree (they redraw on the change).
  if (action === CONTROL.wrap) return toggleWrap();
  if (action === CONTROL.git) return openInGitWindow();
  const fold = /** @type {HTMLElement | null} */ (targetOf(e).closest('.pv-fold, .pv-delmark'));
  if (fold) {
    view.expanded.add(/** @type {string} */ (fold.dataset.key));
    const keep = scroller.scrollTop;
    render();
    scroller.scrollTop = keep;
    drawVisible();
  }
});

el.addEventListener('keydown', e => {
  if (e.ctrlKey || e.altKey || e.metaKey) return; // app shortcuts still work here
  if (e.key === 'Escape') {
    if (placement === PLACEMENT.window) return; // the window closes itself
    closePreview();
  }
  else if (e.key === 'n' || e.key === 'N') moveFile(1);
  else if (e.key === 'p' || e.key === 'P') moveFile(-1);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

// ---- Moving and resizing the panel and the window ----

find(panel, '.pv-grip').addEventListener('pointerdown', e => {
  e.preventDefault();
  const parent = workspaceEl.getBoundingClientRect();
  dragPointer(/** @type {HTMLElement} */ (e.currentTarget), e, ev => {
    panel.style.width = `${Math.min(parent.width - PANEL_ROOM_PX, Math.max(PANEL_MIN_PX, parent.right - ev.clientX))}px`;
  }, () => {
    lastRange = '';
    drawVisible();
  });
});

find(el, '.pv-head').addEventListener('pointerdown', e => {
  if (placement !== PLACEMENT.float || e.button !== 0 || targetOf(e).closest('button, .seg')) return;
  e.preventDefault();
  dragFloating(floating, e, workspaceEl.getBoundingClientRect());
});

// Terminals closing take their changes with them.
on(EVENTS.workspaces, () => {
  if (!view) return;
  // A file's tab stays with another terminal open; it closes when its own terminal was the last one.
  const anyTab = [...state.tabs.values()][0];
  if (!anyTab) return closePreview();
  for (const v of views) if (!state.tabs.has(v.tab.id)) v.tab = anyTab;
  if (!state.tabs.has(view.tab.id)) closePreview();
});

