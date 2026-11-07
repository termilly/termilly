// @ts-check
// The Notepad (the title bar's button, or Ctrl+Shift+M): pages for writing things down, in a panel docked on the
// right that stays as workspaces change. Pages are kept with the workspaces (encrypted with them) until closed; Save
// writes one to a text file and Open brings one in (Features/Notepad.cs). A terminal's right-click menu copies text
// here.

import { PAGE, HOST } from './protocol.js';
import { send, onHost, platform, PLATFORM } from './host.js';
import { state, persist, newId } from './store.js';
import { stripBar } from './panes.js';
import { escapeHtml, ICONS } from './ui.js';
import { byId, find, targetOf, onMiddleClick, WORKSPACE_ID, DOCK_GRIP, PANEL_HEAD } from './dom.js';
import { showMenu, SEPARATOR } from './popups.js';
import { confirmDialog } from './dialogs.js';
import { showToast, TOAST } from './toasts.js';
import { padLinks } from './notepadlinks.js';
import { KEY_ID } from './keymap.js';
import { copyOut as copyFrom, textBoxMenu } from './textmenu.js';
import { dockPanel, NOTEPAD_DOCK } from './dockpanel.js';
import { padView, NP_FONT } from './notepadview.js';

/** @typedef {import('./store.js').NotepadPage} NotepadPage */

/** What the Notepad's buttons do (data-np). */
const NOTEPAD_ACTION = Object.freeze({
  newPage: 'new', open: 'open', save: 'save', saveAs: 'saveAs',
  links: 'links', wrap: 'wrap', numbers: 'numbers', highlight: 'highlight', detach: 'detach', close: 'close',
});
/** A page's view switches (its toolbar), and what each is while the page has never set it. */
const VIEW_DEFAULTS = Object.freeze({ links: true, wrap: true, numbers: false, highlight: false });
/** @typedef {keyof typeof VIEW_DEFAULTS} ViewSwitch */
/** The name a new page gets, numbered. */
const PAGE_NAME = 'Note';
const LF = '\n';
const CRLF = '\r\n';
/** The menu entry that copies text here, on a terminal's right-click menu. */
const COPY_LABEL = 'Copy to Notepad';
const NEW_PAGE_LABEL = 'New page';
/** Its keys while it has the focus; the toggle is Termilly's own shortcut too (main.js). */
export const NOTEPAD_KEY = Object.freeze({ save: 'KeyS', open: 'KeyO' });
/**
 * The header's tools, 16px at a 1px line on the pixel grid: a page with a +, an open folder, a disk (save), a disk
 * with a pen (save as), a chain (links on or off), a line that wraps (word wrap), numbered
 * lines (line numbers) and a marked line between two others (the caret's line).
 */
const TOOL_ICONS = Object.freeze({
  newPage: '<svg viewBox="0 0 16 16"><path d="M9.5 1.5h-6v13h9v-10z"/><path d="M9.5 1.5v3h3M7.5 7v5M5 9.5h5"/></svg>',
  open: '<svg viewBox="0 0 16 16"><path d="M1.5 13.5v-10h4l1.5 1.5h6.5v2"/><path d="M1.5 13.5l2-6h11.5l-2 6z"/></svg>',
  save: ICONS.save,
  saveAs: '<svg viewBox="0 0 16 16"><path d="M7.5 13.5h-5v-11h9l2 2v3"/><path d="M5.5 2.5v3h5v-3M4.5 13.5v-4h3"/><path d="M9.5 14.5v-2l4-4 2 2-4 4z"/></svg>',
  links: ICONS.link,
  wrap: '<svg viewBox="0 0 16 16"><path d="M1.5 3.5h13M1.5 7.5h10a2 2 0 0 1 0 4h-3M1.5 11.5h4"/><path d="M10 9.5l-2 2 2 2"/></svg>',
  numbers: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h1v4M2 6.5h2M1.5 9.5h2v1.5h-2v1.5h2M6.5 4.5h8M6.5 8.5h8M6.5 12.5h8"/></svg>',
  highlight: '<svg viewBox="0 0 16 16"><path d="M1.5 2.5h13M1.5 13.5h13"/><rect x="1.5" y="6.5" width="13" height="3"/></svg>',
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
const head = find(panel, PANEL_HEAD);
const area = /** @type {HTMLTextAreaElement} */ (find(panel, '.np-text'));
/** What the Notepad shows with no pages: New page and Open a file. */
const emptyEl = find(panel, '.np-empty');
// < and > scroll the tabs when they don't fit, as a tab group's do.
const tabBar = stripBar(tabsEl);
tabBar.classList.add('np-tabbar');
const editor = find(panel, '.np-editor');
/** The page's own toolbar, under the tabs: its file, and how it shows. */
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
 * Opens the Notepad on its page (New page and Open a file when it has none), with the caret in it unless `quiet`;
 * in its own window if it was in one when it closed, unless `here` (on its way into one already).
 * @param {{ quiet?: boolean, here?: boolean }} [options]
 */
function show({ quiet = false, here = false } = {}) {
  if (!activePage()) state.notepad.activeId = pages()[0]?.id ?? null;
  const reopens = dock.reopensWindowed(here);
  dock.setOpen(true);
  render();
  if (reopens) return dock.reopenWindow();
  if (!quiet) (activePage() ? area : find(panel, `.np-empty [data-np="${NOTEPAD_ACTION.newPage}"]`)).focus();
}

/** The Notepad on or off (the title bar's button, the palette); in a window of its own, that window to the front. */
export const toggleNotepad = () => dock.toggle();

/** Its handle in a window of its own on Linux: its title, dragged back into the main window (js/panes.js). */
const NOTEPAD_HANDLE = '.files-title';

const dock = dockPanel({
  panel, head, key: WINDOW_KEY, name: NAME, icon: /** @type {Element} */ (button.firstElementChild).outerHTML, handle: NOTEPAD_HANDLE,
  dockVar: NOTEPAD_DOCK, stored: () => state.notepad, button, show, render, focus: () => area.focus(),
});

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
  dock.restorePlace();
  if (state.notepad.open) show({ quiet: true });
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

/** @param {string} text */
const copyOut = text => copyFrom(text, NAME);

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

/** The most a page that reports are added to keeps: the oldest go off its end. */
const MAX_REPORT_PAGE = 200000;

/**
 * Adds text to the top of the page with this name (a new one when there's none), without taking the focus or moving the
 * caret of someone typing in it. Schedules' reports come here.
 * @param {string} name
 * @param {string} text
 */
export function addToPage(name, text) {
  let page = pages().find(p => p.name === name);
  if (!page) {
    const active = state.notepad.activeId;
    page = newPage();
    page.name = name;
    state.notepad.activeId = active ?? page.id;
  }
  const shown = page === activePage();
  const { selectionStart, selectionEnd, scrollTop } = area;
  const added = page.text ? `${text}${LF}` : text;
  page.text = `${added}${page.text}`.slice(0, MAX_REPORT_PAGE);
  persist();
  render();
  if (shown) {
    area.setSelectionRange(selectionStart + added.length, selectionEnd + added.length);
    area.scrollTop = scrollTop;
  }
}

/** The Clipboard's wording for it: a clip is already copied, it's pasted there. */
export const PASTE_TO_NOTEPAD = 'Paste to Notepad';

// ---- Wiring ----

area.addEventListener('contextmenu', e => textBoxMenu(e, area, NAME, []));

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
    case NOTEPAD_ACTION.links:
    case NOTEPAD_ACTION.wrap:
    case NOTEPAD_ACTION.numbers:
    case NOTEPAD_ACTION.highlight: toggleView(/** @type {ViewSwitch} */ (action?.dataset.np)); break;
    case NOTEPAD_ACTION.detach: dock.detach(); break;
    case NOTEPAD_ACTION.close: dock.hide(); break;
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
  else if (!dock.closeKeys(e, KEY_ID.notepad)) return;
  e.preventDefault();
  e.stopPropagation();
});

button.addEventListener('click', () => toggleNotepad());
