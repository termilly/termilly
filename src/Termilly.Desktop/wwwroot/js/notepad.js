// @ts-check
// The Notepad (the title bar's button, or Ctrl+Shift+M): pages for writing things down, in a panel docked on the
// right that stays as workspaces change. Pages are kept with the workspaces (encrypted with them) until closed; Save
// writes one to a text file and Open brings one in (Features/Notepad.cs). Copy to note adds the selection, or the
// whole page, to a workspace's or a terminal's note; a terminal's right-click menu copies text here.

import { PAGE, HOST } from './protocol.js';
import { send, onHost, platform, PLATFORM } from './host.js';
import { state, persist, newId, tabTitle, wsById } from './store.js';
import { restoreFocus, stripBar, wireDragOut, systemDrag, dockDrop } from './panes.js';
import { scheduleFit } from './terminals.js';
import { escapeHtml, cssColor, tabBadgeHtml, countText, ICONS } from './ui.js';
import { byId, find, targetOf, dockRight, isAcross, edgeAt, onMiddleClick, DOCK_AWAY, DOCK_SIDE, WORKSPACE_ID, DOCK_GRIP } from './dom.js';
import { showMenu, SEPARATOR } from './popups.js';
import { confirmDialog } from './dialogs.js';
import { showToast, TOAST } from './toasts.js';
import { appendNote, NOTE_KIND } from './notes.js';
import { padLinks } from './notepadlinks.js';
import { isShortcut, KEY_ID } from './keymap.js';
import { COPY_LABEL as COPY, PASTE_LABEL, MENU_KEYS } from './termclipboard.js';
import { detach, closeWindow, focusWindow, isDetached } from './windows.js';
import { padView, NP_FONT } from './notepadview.js';

/** @typedef {import('./store.js').NotepadPage} NotepadPage */

/** What the Notepad's buttons do (data-np). */
const NOTEPAD_ACTION = Object.freeze({
  newPage: 'new', open: 'open', save: 'save', saveAs: 'saveAs', workspaceNote: 'workspaceNote', terminalNote: 'terminalNote',
  links: 'links', wrap: 'wrap', numbers: 'numbers', highlight: 'highlight', detach: 'detach', close: 'close',
});
/** A page's view switches (its toolbar), and what each is while the page has never set it. */
const VIEW_DEFAULTS = Object.freeze({ links: true, wrap: true, numbers: false, highlight: false });
/** @typedef {keyof typeof VIEW_DEFAULTS} ViewSwitch */
/** The name a new page gets, numbered. */
const PAGE_NAME = 'Note';
/** The panel's narrowest width, and its width until it's dragged; its widest is half the terminals' area (app.css). */
const MIN_WIDTH_PX = 280;
const DEFAULT_WIDTH_PX = 360;
/** On the top or bottom edge: its lowest height, and its height until it's dragged (app.css). */
const MIN_HEIGHT_PX = 180;
const DEFAULT_HEIGHT_PX = 260;
/** How near an edge of the terminals' area a drag docks it there. */
const EDGE_BAND_PX = 120;
const LF = '\n';
const CRLF = '\r\n';
/** The menu entry that copies text here, on a terminal's right-click menu. */
const COPY_LABEL = 'Copy to Notepad';
const COPY_TO_NOTE = 'Copy to note';
const NEW_PAGE_LABEL = 'New page';
/** Its keys while it has the focus; the toggle is Termilly's own shortcut too (main.js). */
export const NOTEPAD_KEY = Object.freeze({ save: 'KeyS', open: 'KeyO' });
/**
 * The header's tools, 16px at a 1px line on the pixel grid: a page with a +, an open folder, a disk (save), a disk
 * with a pen (save as), text going into a note, a chain (links on or off), a line that wraps (word wrap), numbered
 * lines (line numbers) and a marked line between two others (the caret's line).
 */
const TOOL_ICONS = Object.freeze({
  newPage: '<svg viewBox="0 0 16 16"><path d="M9.5 1.5h-6v13h9v-10z"/><path d="M9.5 1.5v3h3M7.5 7v5M5 9.5h5"/></svg>',
  open: '<svg viewBox="0 0 16 16"><path d="M1.5 13.5v-10h4l1.5 1.5h6.5v2"/><path d="M1.5 13.5l2-6h11.5l-2 6z"/></svg>',
  save: ICONS.save,
  saveAs: '<svg viewBox="0 0 16 16"><path d="M7.5 13.5h-5v-11h9l2 2v3"/><path d="M5.5 2.5v3h5v-3M4.5 13.5v-4h3"/><path d="M9.5 14.5v-2l4-4 2 2-4 4z"/></svg>',
  move: '<svg viewBox="0 0 16 16"><rect x="7.5" y="2.5" width="7" height="11" rx="1"/><path d="M9.5 5.5h3M9.5 8.5h3M9.5 11.5h3M1.5 8.5h4M3.5 6.5l2 2-2 2"/></svg>',
  links: ICONS.link,
  wrap: '<svg viewBox="0 0 16 16"><path d="M1.5 3.5h13M1.5 7.5h10a2 2 0 0 1 0 4h-3M1.5 11.5h4"/><path d="M10 9.5l-2 2 2 2"/></svg>',
  numbers: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h1v4M2 6.5h2M1.5 9.5h2v1.5h-2v1.5h2M6.5 4.5h8M6.5 8.5h8M6.5 12.5h8"/></svg>',
  highlight: '<svg viewBox="0 0 16 16"><path d="M1.5 2.5h13M1.5 13.5h13"/><rect x="1.5" y="6.5" width="13" height="3"/></svg>',
});
/**
 * The page's right-click menu, 16px at a 1px line: scissors (cut) and a clipboard with a T (paste as plain text); paste
 * is ICONS.paste.
 */
const MENU_ICONS = Object.freeze({
  cut: '<svg viewBox="0 0 16 16"><circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M5.7 9.8L11 1.5M10.3 9.8L5 1.5"/></svg>',
  pastePlain: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="11" rx="1"/><path d="M6.5 2.5h3v2h-3zM5.5 7.5h4M7.5 7.5v5"/></svg>',
});
/** Its window when it's in one of its own (js/windows.js), and that window's title. */
const WINDOW_KEY = 'notepad';
const NAME = 'Notepad';
/** Its button that moves it into a window of its own (in that window, the window's Return takes it back). */
const DETACH_BUTTON = Object.freeze({ icon: ICONS.detach, title: 'Detach to a window' });
/** What its requests to the host start with. */
const REQUEST = 'np';

const panel = document.createElement('aside');
panel.className = 'notepad-panel';
panel.hidden = true;
panel.innerHTML = `
  <div class="${DOCK_GRIP}" title="Drag to resize"></div>
  <div class="files-head">
    <span class="title-icon np-icon"></span>
    <span class="files-title">Notepad</span>
    <span class="files-tools">
      <button class="pane-btn" data-np="${NOTEPAD_ACTION.newPage}" title="New page">${TOOL_ICONS.newPage}</button>
      <span class="np-sep"></span>
      <button class="pane-btn" data-np="${NOTEPAD_ACTION.detach}" title="${DETACH_BUTTON.title}">${DETACH_BUTTON.icon}</button>
      <button class="pane-btn" data-np="${NOTEPAD_ACTION.close}" title="Close (Ctrl+Shift+M)">${ICONS.close}</button>
    </span>
  </div>
  <div class="pv-tabs np-tabs" role="tablist"></div>
  <div class="np-toolbar files-tools">
    <button class="pane-btn" data-np="${NOTEPAD_ACTION.open}" title="Open a text file (Ctrl+O)">${TOOL_ICONS.open}</button>
    <button class="pane-btn" data-np="${NOTEPAD_ACTION.save}" title="Save (Ctrl+S)">${TOOL_ICONS.save}</button>
    <button class="pane-btn" data-np="${NOTEPAD_ACTION.saveAs}" title="Save as (Ctrl+Shift+S)">${TOOL_ICONS.saveAs}</button>
    <span class="np-sep"></span>
    <button class="pane-btn" data-np="${NOTEPAD_ACTION.workspaceNote}" title="Copy the selection, or the whole page, to a workspace's note">${ICONS.workspaces}</button>
    <button class="pane-btn" data-np="${NOTEPAD_ACTION.terminalNote}" title="Copy the selection, or the whole page, to a terminal's note">${ICONS.terminal}</button>
    <span class="np-sep"></span>
    <button class="pane-btn np-toggle" data-np="${NOTEPAD_ACTION.links}" title="Links: paths and web addresses, Ctrl+click to open (off: plain text)">${TOOL_ICONS.links}</button>
    <button class="pane-btn np-toggle" data-np="${NOTEPAD_ACTION.wrap}" title="Word wrap">${TOOL_ICONS.wrap}</button>
    <button class="pane-btn np-toggle" data-np="${NOTEPAD_ACTION.numbers}" title="Line numbers">${TOOL_ICONS.numbers}</button>
    <button class="pane-btn np-toggle" data-np="${NOTEPAD_ACTION.highlight}" title="Highlight the caret's line">${TOOL_ICONS.highlight}</button>
  </div>
  <div class="np-editor"><textarea class="np-text" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"></textarea>
    <div class="np-empty" hidden><p>No pages</p><span class="np-empty-actions">
      <button class="btn primary" data-np="${NOTEPAD_ACTION.newPage}">New page</button>
      <button class="btn" data-np="${NOTEPAD_ACTION.open}">Open a file</button></span></div></div>
  <div class="np-status" hidden></div>`;
byId(WORKSPACE_ID).append(panel);
const tabsEl = find(panel, '.np-tabs');
/** Its header: its title bar in a window of its own, and what drags it out into one. */
const head = find(panel, '.files-head');
const area = /** @type {HTMLTextAreaElement} */ (find(panel, '.np-text'));
/** What the Notepad shows with no pages: New page and Open a file. */
const emptyEl = find(panel, '.np-empty');
// < and > scroll the tabs when they don't fit, as a tab group's do.
const tabBar = stripBar(tabsEl);
tabBar.classList.add('np-tabbar');
const editor = find(panel, '.np-editor');
/** The page's own toolbar, under the tabs: its file, copying to a note, and how it shows. */
const toolbar = find(panel, '.np-toolbar');
toolbar.before(tabBar);
/**
 * One of the page's view switches (links, word wrap, line numbers, the caret's line): as the page set it, else as the
 * Notepad had it before pages had their own (links and wrap), else its default.
 * @param {ViewSwitch} what
 */
const viewOn = what => activePage()?.[what] ?? state.notepad[what] ?? VIEW_DEFAULTS[what];
const linksOn = () => viewOn(NOTEPAD_ACTION.links);
const wrapOn = () => viewOn(NOTEPAD_ACTION.wrap);
const links = padLinks(area, () => linksOn() && !panel.hidden);
const view = padView(area, find(panel, '.np-status'), {
  size: () => state.notepad.fontSize ?? NP_FONT.default,
  setSize: px => { state.notepad.fontSize = px; persist(); },
  numbers: () => viewOn(NOTEPAD_ACTION.numbers),
  highlight: () => viewOn(NOTEPAD_ACTION.highlight),
});
const button = byId('notepad-button');
// Its title bar starts with the toolbar button's icon, as a window's does.
find(panel, '.np-icon').innerHTML = /** @type {Element} */ (button.firstElementChild).outerHTML;
const countEl = find(button, '.np-count');

/** Saves waiting for the host: the page and the text sent, by request. */
/** @type {Map<string, { id: string, text: string }>} */
const saving = new Map();

const pages = () => state.notepad.pages;
const activePage = () => pages().find(p => p.id === state.notepad.activeId) ?? null;
/** @param {string} path */
const fileName = path => path.split(/[\\/]/).pop() || path;
/** Whether a page opened from or saved to a file differs from it. @param {NotepadPage} p */
const unsaved = p => !!p.path && p.text !== p.saved;

/** A new page, numbered after the others, shown. */
function newPage(text = '') {
  const used = new Set(pages().map(p => p.name));
  let n = 1;
  while (used.has(`${PAGE_NAME} ${n}`)) n++;
  /** @type {NotepadPage} */
  const page = { id: newId('n'), name: `${PAGE_NAME} ${n}`, text };
  pages().push(page);
  state.notepad.activeId = page.id;
  return page;
}

// ---- Drawing ----

function renderTabs() {
  tabsEl.innerHTML = pages().map(p => `
    <span class="pv-tab${p.id === state.notepad.activeId ? ' on' : ''}${unsaved(p) ? ' changed' : ''}" role="tab" aria-selected="${p.id === state.notepad.activeId}" data-page="${p.id}"
      title="${escapeHtml(p.path ? `${p.path}${unsaved(p) ? ' (not saved)' : ''}` : p.name)}"><span class="pv-tab-name">${escapeHtml(p.name)}${unsaved(p) ? '*' : ''}</span><button class="pv-tab-close" data-page-close="${p.id}" title="Close" aria-label="Close">${ICONS.close}</button></span>`).join('');
}

/** Draws the tabs and shows the page picked in the text box. */
function render() {
  renderTabs();
  const page = activePage();
  area.value = page?.text ?? '';
  area.disabled = !page;
  area.hidden = !page;
  toolbar.hidden = !page;
  tabBar.hidden = !page;
  emptyEl.hidden = !!page;
  applyView();
  if (page) {
    area.setSelectionRange(page.caret ?? 0, page.caretEnd ?? page.caret ?? 0);
    area.scrollTop = page.scroll ?? 0;
  }
  view.refresh();
  tabsEl.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * The page's view as it's set (links or plain text, word wrap, line numbers, its caret's line): the switches pressed
 * or not, the page drawn again.
 */
function applyView() {
  editor.classList.toggle('with-links', linksOn());
  area.wrap = wrapOn() ? 'soft' : 'off';
  editor.classList.toggle('nowrap', !wrapOn());
  for (const what of /** @type {ViewSwitch[]} */ (Object.keys(VIEW_DEFAULTS))) {
    find(panel, `[data-np="${what}"]`).setAttribute('aria-pressed', String(viewOn(what)));
  }
  links.refresh();
  view.refresh();
}

/**
 * Turns one of the page's view switches on or off, for that page.
 * @param {ViewSwitch} what
 */
function toggleView(what) {
  const page = activePage();
  if (!page) return;
  page[what] = !viewOn(what);
  persist();
  applyView();
  area.focus();
}

/**
 * While the Notepad is closed, its button counts the pages it keeps: those with something in them (an empty page
 * isn't counted).
 */
function showCount() {
  const kept = pages().filter(p => p.path || p.text.trim()).length;
  countEl.hidden = !panel.hidden || !kept;
  countEl.textContent = countText(kept);
  button.title = `Notepad (Ctrl+Shift+M)${countEl.hidden ? '' : `: ${kept} ${kept === 1 ? 'page' : 'pages'}`}`;
}

/** @param {boolean} open */
function setOpen(open) {
  panel.hidden = !open;
  button.classList.toggle('open', open);
  showCount();
  if (state.notepad.open !== open) {
    state.notepad.open = open;
    persist();
  }
}

/**
 * Opens the Notepad on its page (New page and Open a file when it has none), with the caret in it unless `quiet`;
 * in its own window if it was in one when it closed, unless `here` (on its way into one already).
 * @param {{ quiet?: boolean, here?: boolean }} [options]
 */
function show({ quiet = false, here = false } = {}) {
  if (!activePage()) state.notepad.activeId = pages()[0]?.id ?? null;
  // Closed while in a window of its own: it opens in it again, where it was, unless it's on its way there. Never seen
  // docked meanwhile: its window can take a second to open (Linux).
  const reopens = !here && !!state.notepad.detached && !isDetached(WINDOW_KEY);
  panel.classList.toggle(DOCK_AWAY, reopens);
  setOpen(true);
  render();
  if (reopens) {
    if (!detachNotepad()) dockHere();
    return;
  }
  if (!quiet) (activePage() ? area : find(panel, `.np-empty [data-np="${NOTEPAD_ACTION.newPage}"]`)).focus();
}

/** The Notepad on or off (the title bar's button, the palette); in a window of its own, that window to the front. */
export function toggleNotepad() {
  if (isDetached(WINDOW_KEY)) {
    focusWindow(WINDOW_KEY);
    area.focus();
  } else if (!panel.hidden) hideNotepad();
  else show();
}

/** Closes the Notepad, and its window if it's in one. */
function hideNotepad() {
  const detached = isDetached(WINDOW_KEY);
  if (detached) closeWindow(WINDOW_KEY, { quiet: true });
  setOpen(false);
  // Back in the page, hidden; still one that opens in its own window next time.
  if (detached) dockBack({ keepWindowed: true });
  restoreFocus();
}

/**
 * Into a window of its own, opened first if it's closed; its header is the window's title bar, Close closes it, and
 * moved back over its dock on the right of the main window it docks there. False when no window could be opened.
 * @param {{ x: number, y: number }} [at] where on the screen it opens (dragged out by its header), else over its place
 * @param {{ x: number, y: number }} [place] exactly where its picture was let go (its top left corner)
 */
function detachNotepad(at, place) {
  if (panel.hidden) show({ quiet: true, here: true });
  if (!isDetached(WINDOW_KEY) && !isAcross(dockSide())) dockedWidth = panel.offsetWidth;
  // Its room here is given back once it's in its window, and as that window is resized.
  return detach(WINDOW_KEY, {
    el: panel, title: NAME, onClosed: () => dockBack(), onResize: refreshDock,
    onMoved: () => {
      panel.classList.remove(DOCK_AWAY);
      keepDetached(true);
      area.focus();
    },
    at, place, remember: true,
    header: head, close: hideNotepad,
    onDragged: dockDrop(dockAt, dockTo),
    dragHandle: systemDrag ? NOTEPAD_HANDLE : undefined,
  });
}

/** Seen docked again: its window couldn't open, or went before it got there. */
function dockHere() {
  panel.classList.remove(DOCK_AWAY);
  refreshDock();
}

/** Its handle in a window of its own on Linux: its title, dragged back into the main window (js/panes.js). */
const NOTEPAD_HANDLE = '.files-title';
/** How wide it was docked when it went out into a window of its own (its width is kept only once it's dragged). */
let dockedWidth = 0;

/**
 * Where it docks on an edge of the main window (in the page's pixels): that edge of the terminals' area, as big as it
 * was docked (at most half).
 * @param {string} side
 */
function dockZone(side) {
  const area = byId(WORKSPACE_ID).getBoundingClientRect();
  if (isAcross(side)) {
    const height = Math.min(area.height / 2, Math.max(MIN_HEIGHT_PX, state.notepad.height ?? DEFAULT_HEIGHT_PX));
    return new DOMRect(area.left, side === DOCK_SIDE.top ? area.top : area.bottom - height, area.width, height);
  }
  const width = Math.min(area.width / 2, Math.max(MIN_WIDTH_PX, state.notepad.width ?? (dockedWidth || DEFAULT_WIDTH_PX)));
  return new DOMRect(side === DOCK_SIDE.left ? area.left : area.right - width, area.top, width, area.height);
}

/**
 * Where a drag at this point would dock it: over where it docks now, or near any edge. Elsewhere, nowhere: it goes out
 * into a window of its own.
 * @param {number} x
 * @param {number} y
 * @returns {import('./panes.js').DockSpot | null}
 */
function dockAt(x, y) {
  const now = dockSide();
  const zone = dockZone(now);
  const inZone = x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom;
  const side = inZone ? now : edgeAt(byId(WORKSPACE_ID).getBoundingClientRect(), x, y, EDGE_BAND_PX);
  return side ? { side, zone: dockZone(side), label: `Dock ${isAcross(side) ? 'at' : 'on'} the ${side}` } : null;
}

/**
 * Docks it on an edge, back from its window if it's in one.
 * @param {string} side
 */
function dockTo(side) {
  state.notepad.side = side;
  persist();
  placeOnSide();
  if (isDetached(WINDOW_KEY)) closeWindow(WINDOW_KEY);
  else refreshDock();
}

/** The edge it docks on. */
function dockSide() {
  const side = state.notepad.side;
  return side && /** @type {string[]} */ (Object.values(DOCK_SIDE)).includes(side) ? side : DOCK_SIDE.right;
}

/** Its panel on its edge: a height of its own on the top or bottom one. */
function placeOnSide() {
  const side = dockSide();
  panel.dataset.side = side;
  panel.style.height = isAcross(side) && state.notepad.height ? `${state.notepad.height}px` : '';
}

/** Back in its place on the right, from its window, as it was. */
/**
 * @param {{ keepWindowed?: boolean }} [options] keepWindowed: only closed, it opens in its own window again next time
 */
function dockBack({ keepWindowed = false } = {}) {
  if (!keepWindowed) keepDetached(false);
  byId(WORKSPACE_ID).append(panel);
  dockHere();
  if (!panel.hidden) render();
}

/** The Notepad on or off from its shortcut (Ctrl+Shift+M): opened with no pages, it starts one to type into at once. */
export function toggleNotepadFromKeys() {
  if (panel.hidden && !pages().length) {
    newPage();
    persist();
  }
  toggleNotepad();
}

/** Shows the Notepad as it was left (main.js, once the saved state is in). */
export function initNotepad() {
  showCount();
  if (state.notepad.width) panel.style.width = `${state.notepad.width}px`;
  placeOnSide();
  if (state.notepad.open) show({ quiet: true });
}

/**
 * Whether it's in a window of its own, kept for the next start.
 * @param {boolean} detached
 */
function keepDetached(detached) {
  if (!!state.notepad.detached === detached) return;
  state.notepad.detached = detached;
  persist();
}

// ---- Pages ----

/** @param {string} id */
function pick(id) {
  state.notepad.activeId = id;
  persist();
  render();
  area.focus();
}

/**
 * Closes a page, asking first when its text isn't in a file; closing the last one leaves an empty page.
 * @param {string} id
 */
async function closePage(id) {
  const page = pages().find(p => p.id === id);
  if (!page) return;
  if ((page.path ? unsaved(page) : page.text.trim()) && !await confirmDialog({
    title: `Close ${page.name}?`,
    body: page.path ? 'Its changes aren’t saved.' : 'Its text isn’t saved to a file.',
    confirm: 'Close page',
  })) return;
  const at = pages().indexOf(page);
  // The last one's view switches stay: the next new page starts with them.
  if (pages().length === 1) {
    for (const what of /** @type {ViewSwitch[]} */ (Object.keys(VIEW_DEFAULTS))) state.notepad[what] = viewOn(what);
  }
  pages().splice(at, 1);
  if (state.notepad.activeId === id) state.notepad.activeId = pages()[Math.min(at, pages().length - 1)]?.id ?? null;
  // The last one leaves the Notepad open with no page: New page and Open a file show instead.
  persist();
  render();
  if (activePage()) area.focus();
}

/**
 * Writes the page to its file, or asks where first (Save as, or a page never saved).
 * @param {boolean} ask
 */
function save(ask) {
  const page = activePage();
  if (!page) return;
  const requestId = newId(REQUEST);
  saving.set(requestId, { id: page.id, text: page.text });
  const crlf = page.path ? !!page.crlf : platform === PLATFORM.windows;
  send(PAGE.notepadSave, { requestId, path: page.path ?? null, name: page.name, text: crlf ? page.text.replaceAll(LF, CRLF) : page.text, ask: ask || !page.path });
}

onHost(HOST.notepadSaved, m => {
  const sent = m.requestId ? saving.get(m.requestId) : null;
  if (m.requestId) saving.delete(m.requestId);
  if (m.error) return showToast({ text: `Not saved: ${m.error}`, state: TOAST.failed });
  const page = pages().find(p => p.id === sent?.id);
  if (!page || !m.path || !sent) return;
  if (page.path !== m.path) page.crlf = platform === PLATFORM.windows;
  page.path = m.path;
  page.name = fileName(m.path);
  page.saved = sent.text;
  persist();
  renderTabs();
  showToast({ text: `Saved ${page.name}`, state: TOAST.done });
});

/** Asks the host for a text file to open in a new page. */
const openFile = () => send(PAGE.notepadOpen, { requestId: newId(REQUEST) });

onHost(HOST.notepadOpened, m => {
  if (m.error) return showToast({ text: m.error, state: TOAST.failed });
  if (!m.path || m.text == null) return;
  const open = pages().find(p => p.path === m.path);
  if (open) return pick(open.id);
  const text = m.text.replaceAll(CRLF, LF);
  const page = newPage(text);
  Object.assign(page, { name: fileName(m.path), path: m.path, saved: text, crlf: m.text.includes(CRLF) });
  persist();
  render();
  area.focus();
});

// ---- Copying text to a note ----

/**
 * Copies text from here, and tells Clipboard (it keeps it even when it keeps Termilly's own copies only).
 * @param {string} text
 */
function copyOut(text) {
  navigator.clipboard.writeText(text).catch(() => {});
  send(PAGE.clipCopied, { text, source: NAME });
}

/** The selection in the page, else the whole page: what Copy to note takes. */
function chosenText() {
  const { selectionStart: from, selectionEnd: to, value } = area;
  return from !== to ? value.slice(from, to) : value;
}

/**
 * Adds text to the end of a note: the page's selection (or the page), or what a terminal's menu gives.
 * @param {string} kind 'workspace' or 'terminal'
 * @param {Workspace | Tab} target
 * @param {string} name what the note is on, for the message
 * @param {() => string} [textOf]
 */
function copyToNote(kind, target, name, textOf = chosenText) {
  const text = textOf();
  if (!text.trim()) return showToast({ text: 'Nothing to copy: there is no text', state: TOAST.failed });
  appendNote(kind, target, text);
  showToast({ text: `Copied to the note on ${name}`, state: TOAST.done });
}

/**
 * A workspace's note or a terminal's, each workspace with its colour and each terminal with its badge.
 * @param {() => string} [textOf] The text to copy: the page's selection (or the page) by default.
 */
function noteChoices(textOf = chosenText) {
  const terminals = [...state.tabs.values()].filter(t => t.wsId && wsById(t.wsId) && !t.virtual);
  return [
    {
      label: 'Workspace note', icon: ICONS.workspaces, submenu: () => state.workspaces.map(w => ({ label: w.name, icon: `<span class="ws-dot" style="background:${cssColor(w.color)}"></span>`, action: () => copyToNote(NOTE_KIND.workspace, w, w.name, textOf) })),
    },
    {
      label: 'Terminal note', icon: ICONS.terminal, disabled: !terminals.length,
      submenu: () => terminals.map(t => ({ label: tabTitle(t), icon: tabBadgeHtml(t), hint: escapeHtml(wsById(t.wsId)?.name ?? ''), action: () => copyToNote(NOTE_KIND.terminal, t, tabTitle(t), textOf) })),
    },
  ];
}

/**
 * The toolbar's Copy to a workspace's note (0) or a terminal's (1): the workspaces or terminals to choose from.
 * @param {number} which
 * @param {HTMLElement} at
 */
function noteMenu(which, at) {
  const choice = noteChoices()[which];
  if (choice.disabled) return void showToast({ text: 'No terminals to copy to', state: TOAST.failed });
  showMenu(/** @type {() => import('./popups.js').MenuItem[]} */ (choice.submenu)(), at);
}

// ---- The page's right-click menu ----

/**
 * Text as it reads, without what a terminal adds: colour and cursor codes, other control characters, Windows line
 * ends and spaces at the ends of lines.
 * @param {string} text
 */
const plainText = text => text
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replaceAll(CRLF, LF)
  .replace(/[^\n\t\P{Cc}]/gu, '')
  .replace(/[ \t]+$/gm, '');

/**
 * Types text where the caret is (over the selection), so Ctrl+Z takes it back.
 * @param {string} text
 */
function insert(text) {
  area.focus();
  // Its own window's document when it's detached: the command acts on the focus there.
  area.ownerDocument.execCommand('insertText', false, text);
}

/** @param {(text: string) => string} [clean] */
const paste = (clean = t => t) => navigator.clipboard.readText().then(text => { if (text) insert(clean(text)); }).catch(() => {});

/** @param {MouseEvent} e */
function pageMenu(e) {
  e.preventDefault();
  const { selectionStart: start, selectionEnd: end } = area;
  const selected = start !== end;
  const selection = area.value.slice(start, end);
  showMenu([
    { label: 'Cut', icon: MENU_ICONS.cut, hint: 'Ctrl+X', disabled: !selected, action: () => { copyOut(selection); insert(''); } },
    { label: COPY, icon: ICONS.copy, hint: MENU_KEYS.copy, disabled: !selected, action: () => copyOut(selection) },
    { label: PASTE_LABEL, icon: ICONS.paste, hint: MENU_KEYS.paste, action: () => paste() },
    { label: 'Paste as plain text', icon: MENU_ICONS.pastePlain, title: 'Without the colour codes, control characters and trailing spaces a terminal adds', action: () => paste(plainText) },
    SEPARATOR,
    { label: COPY_TO_NOTE, icon: TOOL_ICONS.move, disabled: !area.value.trim(), title: selected ? undefined : 'With nothing selected, the whole page', submenu: () => noteChoices() },
  ], { x: e.clientX, y: e.clientY }, {
    // The text box keeps the focus while the menu shows, so its selection stays lit; closing, it gets it back.
    keepFocus: true,
    refocus: () => { area.focus(); area.setSelectionRange(start, end); },
  });
}

// ---- Copying text here (a terminal's right-click menu) ----

/**
 * Adds text at the end of a page (a new one when `id` is null) and shows it, leaving the focus where it is.
 * @param {string | null} id
 * @param {string} text
 */
function copyHere(id, text) {
  const page = (id && pages().find(p => p.id === id)) || newPage();
  page.text = page.text && !page.text.endsWith(LF) ? `${page.text}${LF}${text}` : `${page.text}${text}`;
  state.notepad.activeId = page.id;
  persist();
  show({ quiet: true });
  area.scrollTop = area.scrollHeight;
}

/**
 * The right-click menu's Copy to Notepad for some text: straight into a new page when there's none, else a choice of
 * the pages (or a new one).
 * @param {string} text
 * @param {string} [label] its wording (the Clipboard's says Paste: the text is already copied)
 * @returns {import('./popups.js').MenuItem}
 */
export function copyToNotepadItem(text, label = COPY_LABEL) {
  if (!pages().length) return { label, icon: ICONS.note, action: () => copyHere(null, text) };
  return {
    label, icon: ICONS.note,
    submenu: () => [...pages().map(p => ({ label: p.name, action: () => copyHere(p.id, text) })), SEPARATOR, { label: NEW_PAGE_LABEL, action: () => copyHere(null, text) }],
  };
}

/**
 * The right-click menu's Copy to note for some text (a terminal's selection): a workspace's note or a terminal's.
 * @param {string} text
 * @param {string} [label] its wording (the Clipboard's says Paste: the text is already copied)
 * @returns {import('./popups.js').MenuItem}
 */
export const copyToNoteItem = (text, label = COPY_TO_NOTE) => ({ label, icon: TOOL_ICONS.move, submenu: () => noteChoices(() => text) });

/** The Clipboard's wording for the two: a clip is already copied, it's pasted there. */
export const PASTE_TO_NOTEPAD = 'Paste to Notepad';
export const PASTE_TO_NOTE = 'Paste to note';

// ---- Wiring ----

area.addEventListener('contextmenu', pageMenu);

// Where each page was left (scrolled to, the caret), kept with it so a restart comes back there.
area.addEventListener('scroll', () => {
  const page = activePage();
  if (!page || page.scroll === area.scrollTop) return;
  page.scroll = area.scrollTop;
  persist();
});
for (const kind of ['keyup', 'mouseup', 'select']) {
  area.addEventListener(kind, () => {
    const page = activePage();
    if (!page || (page.caret === area.selectionStart && page.caretEnd === area.selectionEnd)) return;
    page.caret = area.selectionStart;
    page.caretEnd = area.selectionEnd;
    persist();
  });
}

area.addEventListener('input', () => {
  const page = activePage();
  if (!page) return;
  const was = unsaved(page);
  page.text = area.value;
  persist();
  links.edited();
  if (unsaved(page) !== was) renderTabs();
});

panel.addEventListener('click', e => {
  const target = targetOf(e);
  const closing = /** @type {HTMLElement | null} */ (target.closest('[data-page-close]'));
  if (closing) return void closePage(/** @type {string} */ (closing.dataset.pageClose));
  const tab = /** @type {HTMLElement | null} */ (target.closest('[data-page]'));
  if (tab) return pick(/** @type {string} */ (tab.dataset.page));
  const action = /** @type {HTMLElement | null} */ (target.closest('[data-np]'));
  switch (action?.dataset.np) {
    case NOTEPAD_ACTION.newPage: newPage(); persist(); render(); area.focus(); break;
    case NOTEPAD_ACTION.open: openFile(); break;
    case NOTEPAD_ACTION.save: save(false); break;
    case NOTEPAD_ACTION.saveAs: save(true); break;
    case NOTEPAD_ACTION.workspaceNote: noteMenu(0, /** @type {HTMLElement} */ (action)); break;
    case NOTEPAD_ACTION.terminalNote: noteMenu(1, /** @type {HTMLElement} */ (action)); break;
    case NOTEPAD_ACTION.links:
    case NOTEPAD_ACTION.wrap:
    case NOTEPAD_ACTION.numbers:
    case NOTEPAD_ACTION.highlight: toggleView(/** @type {ViewSwitch} */ (action?.dataset.np)); break;
    case NOTEPAD_ACTION.detach: detachNotepad(); break;
    case NOTEPAD_ACTION.close: hideNotepad(); break;
    default: break;
  }
});

onMiddleClick(tabsEl, e => {
  const tab = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-page]'));
  if (tab) closePage(/** @type {string} */ (tab.dataset.page));
});

// A tab's right-click menu: its file's path to the clipboard (a page never saved has none).
tabsEl.addEventListener('contextmenu', e => {
  const tab = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-page]'));
  const page = tab && pages().find(p => p.id === tab.dataset.page);
  if (!page) return;
  e.preventDefault();
  const path = page.path;
  showMenu([
    {
      label: 'Copy path', icon: ICONS.copy, disabled: !path, title: path ? path : 'Not saved to a file yet',
      action: () => {
        copyOut(/** @type {string} */ (path));
        showToast({ text: `Copied ${path}` });
      },
    },
  ], { x: e.clientX, y: e.clientY });
});

// Its own keys while it has the focus (Termilly's shortcuts leave text boxes alone): save, open, back to the terminal.
panel.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey && !e.altKey;
  if (view.sizeKey(e)) { /* the text's size: Ctrl+= - 0 */ }
  else if (ctrl && e.code === NOTEPAD_KEY.save) save(e.shiftKey);
  else if (ctrl && !e.shiftKey && e.code === NOTEPAD_KEY.open) openFile();
  else if (isShortcut(e, KEY_ID.notepad)) hideNotepad();
  // Escape goes back to the terminal, in the main window: not from a window of its own.
  else if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey && !isDetached(WINDOW_KEY)) restoreFocus();
  else return;
  e.preventDefault();
  e.stopPropagation();
});

button.addEventListener('click', () => toggleNotepad());

// Its header dragged out of the app window takes it out into a window of its own, as a terminal's (js/panes.js).
wireDragOut(head, panel, {
  name: NAME, icon: /** @type {Element} */ (button.firstElementChild).outerHTML, detach: detachNotepad,
  isDetached: () => isDetached(WINDOW_KEY), handle: NOTEPAD_HANDLE, side: dockSide, dockAt, dockTo,
});

// ---- Docked on an edge: the terminals end where it starts ----

const refreshDock = dockRight(panel, {
  dockVar: '--notepad-dock', minWidth: MIN_WIDTH_PX, minHeight: MIN_HEIGHT_PX, side: dockSide, resized: scheduleFit,
  dragged: size => {
    if (isAcross(dockSide())) state.notepad.height = size;
    else state.notepad.width = size;
    persist();
  },
});
