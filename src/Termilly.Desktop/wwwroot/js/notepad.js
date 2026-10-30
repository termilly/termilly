// @ts-check
// The Notepad (the title bar's button, or Ctrl+Shift+M): pages for writing things down, in a panel docked on the
// right that stays as workspaces change. Pages are kept with the workspaces (encrypted with them) until closed; Save
// writes one to a text file and Open brings one in (Features/Notepad.cs). Copy to note adds the selection, or the
// whole page, to a workspace's or a terminal's note; a terminal's right-click menu copies text here.

import { PAGE, HOST } from './protocol.js';
import { send, onHost, platform, PLATFORM } from './host.js';
import { state, persist, newId, tabTitle, wsById } from './store.js';
import { restoreFocus, stripBar } from './panes.js';
import { scheduleFit } from './terminals.js';
import { escapeHtml, cssColor, tabBadgeHtml, ICONS } from './ui.js';
import { byId, find, targetOf, dockRight, onMiddleClick, WORKSPACE_ID, DOCK_GRIP } from './dom.js';
import { showMenu, SEPARATOR } from './popups.js';
import { confirmDialog } from './dialogs.js';
import { showToast, TOAST } from './toasts.js';
import { appendNote, NOTE_KIND } from './notes.js';
import { padLinks } from './notepadlinks.js';
import { COPY_LABEL as COPY, PASTE_LABEL, MENU_KEYS } from './termclipboard.js';

/** @typedef {import('./store.js').NotepadPage} NotepadPage */

/** What the Notepad's buttons do (data-np). */
const NOTEPAD_ACTION = Object.freeze({
  newPage: 'new', open: 'open', save: 'save', saveAs: 'saveAs', move: 'move', links: 'links', wrap: 'wrap', close: 'close',
});
/** The name a new page gets, numbered. */
const PAGE_NAME = 'Note';
/** The panel's narrowest width; its widest is half the terminals' area (app.css max-width). */
const MIN_WIDTH_PX = 280;
const LF = '\n';
const CRLF = '\r\n';
/** The menu entry that copies text here, on a terminal's right-click menu. */
const COPY_LABEL = 'Copy to Notepad';
const NEW_PAGE_LABEL = 'New page';
/** Its keys while it has the focus; the toggle is Termilly's own shortcut too (main.js). */
export const NOTEPAD_KEY = Object.freeze({ toggle: 'KeyM', save: 'KeyS', open: 'KeyO' });
/**
 * The header's tools, 16px at a 1px line on the pixel grid: a page with a +, an open folder, a disk (save), a disk
 * with a pen (save as), text going into a note, a chain (links on or off) and a line that wraps (word wrap).
 */
const TOOL_ICONS = Object.freeze({
  newPage: '<svg viewBox="0 0 16 16"><path d="M9.5 1.5h-6v13h9v-10z"/><path d="M9.5 1.5v3h3M7.5 7v5M5 9.5h5"/></svg>',
  open: '<svg viewBox="0 0 16 16"><path d="M1.5 13.5v-10h4l1.5 1.5h6.5v2"/><path d="M1.5 13.5l2-6h11.5l-2 6z"/></svg>',
  save: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h9l2 2v9h-11z"/><path d="M5.5 2.5v3h5v-3M4.5 13.5v-4h7v4"/></svg>',
  saveAs: '<svg viewBox="0 0 16 16"><path d="M7.5 13.5h-5v-11h9l2 2v3"/><path d="M5.5 2.5v3h5v-3M4.5 13.5v-4h3"/><path d="M9.5 14.5v-2l4-4 2 2-4 4z"/></svg>',
  move: '<svg viewBox="0 0 16 16"><rect x="7.5" y="2.5" width="7" height="11" rx="1"/><path d="M9.5 5.5h3M9.5 8.5h3M9.5 11.5h3M1.5 8.5h4M3.5 6.5l2 2-2 2"/></svg>',
  links: '<svg viewBox="0 0 16 16"><path d="M6.5 5.5h-2a3 3 0 0 0 0 6h2M9.5 5.5h2a3 3 0 0 1 0 6h-2M5.5 8.5h5"/></svg>',
  wrap: '<svg viewBox="0 0 16 16"><path d="M1.5 3.5h13M1.5 7.5h10a2 2 0 0 1 0 4h-3M1.5 11.5h4"/><path d="M10 9.5l-2 2 2 2"/></svg>',
});
/** What its requests to the host start with. */
const REQUEST = 'np';

const panel = document.createElement('aside');
panel.className = 'notepad-panel';
panel.hidden = true;
panel.innerHTML = `
  <div class="${DOCK_GRIP}" title="Drag to resize"></div>
  <div class="files-head">
    <span class="files-title">Notepad</span>
    <span class="files-tools">
      <button class="pane-btn" data-np="${NOTEPAD_ACTION.newPage}" title="New page">${TOOL_ICONS.newPage}</button>
      <button class="pane-btn" data-np="${NOTEPAD_ACTION.open}" title="Open a text file (Ctrl+O)">${TOOL_ICONS.open}</button>
      <button class="pane-btn" data-np="${NOTEPAD_ACTION.save}" title="Save (Ctrl+S)">${TOOL_ICONS.save}</button>
      <button class="pane-btn" data-np="${NOTEPAD_ACTION.saveAs}" title="Save as (Ctrl+Shift+S)">${TOOL_ICONS.saveAs}</button>
      <button class="pane-btn" data-np="${NOTEPAD_ACTION.move}" title="Copy the selection, or the whole page, to a workspace's or a terminal's note">${TOOL_ICONS.move}</button>
      <button class="pane-btn np-toggle" data-np="${NOTEPAD_ACTION.links}" title="Links: paths and web addresses, Ctrl+click to open (off: plain text)">${TOOL_ICONS.links}</button>
      <button class="pane-btn np-toggle" data-np="${NOTEPAD_ACTION.wrap}" title="Word wrap">${TOOL_ICONS.wrap}</button>
      <button class="pane-btn" data-np="${NOTEPAD_ACTION.close}" title="Close (Ctrl+Shift+M)">${ICONS.close}</button>
    </span>
  </div>
  <div class="pv-tabs np-tabs" role="tablist"></div>
  <div class="np-editor"><textarea class="np-text" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"></textarea></div>`;
byId(WORKSPACE_ID).append(panel);
const tabsEl = find(panel, '.np-tabs');
const area = /** @type {HTMLTextAreaElement} */ (find(panel, '.np-text'));
// < and > scroll the tabs when they don't fit, as a tab group's do.
const tabBar = stripBar(tabsEl);
tabBar.classList.add('np-tabbar');
const editor = find(panel, '.np-editor');
editor.before(tabBar);
/** Links (Ctrl+click) or plain text, and word wrap: both on unless turned off. */
const linksOn = () => state.notepad.links !== false;
const wrapOn = () => state.notepad.wrap !== false;
const links = padLinks(area, () => linksOn() && !panel.hidden);
const button = byId('notepad-button');

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
      title="${escapeHtml(p.path ? `${p.path}${unsaved(p) ? ' (not saved)' : ''}` : p.name)}"><span class="pv-tab-name">${escapeHtml(p.name)}</span><button class="pv-tab-close" data-page-close="${p.id}" title="Close" aria-label="Close">${ICONS.close}</button></span>`).join('');
}

/** Draws the tabs and shows the page picked in the text box. */
function render() {
  renderTabs();
  const page = activePage();
  area.value = page?.text ?? '';
  area.disabled = !page;
  applyView();
  tabsEl.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Links or plain text, and word wrap, as they're set: the buttons pressed or not, the page drawn again. */
function applyView() {
  editor.classList.toggle('with-links', linksOn());
  area.wrap = wrapOn() ? 'soft' : 'off';
  editor.classList.toggle('nowrap', !wrapOn());
  find(panel, `[data-np="${NOTEPAD_ACTION.links}"]`).setAttribute('aria-pressed', String(linksOn()));
  find(panel, `[data-np="${NOTEPAD_ACTION.wrap}"]`).setAttribute('aria-pressed', String(wrapOn()));
  links.refresh();
}

/**
 * Turns links or word wrap on or off.
 * @param {'links' | 'wrap'} what
 */
function toggleView(what) {
  state.notepad[what] = !(state.notepad[what] !== false);
  persist();
  applyView();
  area.focus();
}

/** @param {boolean} open */
function setOpen(open) {
  panel.hidden = !open;
  button.classList.toggle('open', open);
  if (state.notepad.open !== open) {
    state.notepad.open = open;
    persist();
  }
}

/**
 * Opens the Notepad on a page (a new one when there's none), with the caret in it unless `quiet`.
 * @param {{ quiet?: boolean }} [options]
 */
function show({ quiet = false } = {}) {
  if (!pages().length) newPage();
  if (!activePage()) state.notepad.activeId = pages()[0].id;
  setOpen(true);
  render();
  if (!quiet) area.focus();
}

/** The Notepad on or off (the title bar's button, Ctrl+Shift+M). */
export function toggleNotepad() {
  if (!panel.hidden) {
    setOpen(false);
    restoreFocus();
  } else show();
}

/** Shows the Notepad as it was left (main.js, once the saved state is in). */
export function initNotepad() {
  if (state.notepad.width) panel.style.width = `${state.notepad.width}px`;
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
  pages().splice(at, 1);
  if (state.notepad.activeId === id) state.notepad.activeId = pages()[Math.min(at, pages().length - 1)]?.id ?? null;
  // The last one gives way to an empty page: the Notepad stays open.
  if (!pages().length) newPage();
  persist();
  render();
  area.focus();
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

/** The selection in the page, else the whole page: what Copy to note takes. */
function chosenText() {
  const { selectionStart: from, selectionEnd: to, value } = area;
  return from !== to ? value.slice(from, to) : value;
}

/**
 * Adds the selection (or the page) to the end of a note; the page keeps it.
 * @param {string} kind 'workspace' or 'terminal'
 * @param {Workspace | Tab} target
 * @param {string} name what the note is on, for the message
 */
function copyToNote(kind, target, name) {
  const text = chosenText();
  if (!activePage() || !text.trim()) return showToast({ text: 'Nothing to copy: the page is empty', state: TOAST.failed });
  appendNote(kind, target, text);
  showToast({ text: `Copied to the note on ${name}`, state: TOAST.done });
}

/** A workspace's note or a terminal's, each workspace with its colour and each terminal with its badge. */
function noteChoices() {
  const terminals = [...state.tabs.values()].filter(t => t.wsId && wsById(t.wsId) && !t.virtual);
  return [
    {
      label: 'Workspace note', submenu: () => state.workspaces.map(w => ({ label: w.name, icon: `<span class="ws-dot" style="background:${cssColor(w.color)}"></span>`, action: () => copyToNote(NOTE_KIND.workspace, w, w.name) })),
    },
    {
      label: 'Terminal note', disabled: !terminals.length,
      submenu: () => terminals.map(t => ({ label: tabTitle(t), icon: tabBadgeHtml(t), hint: escapeHtml(wsById(t.wsId)?.name ?? ''), action: () => copyToNote(NOTE_KIND.terminal, t, tabTitle(t)) })),
    },
  ];
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
  document.execCommand('insertText', false, text);
}

/** @param {(text: string) => string} [clean] */
const paste = (clean = t => t) => navigator.clipboard.readText().then(text => { if (text) insert(clean(text)); }).catch(() => {});

/** @param {MouseEvent} e */
function pageMenu(e) {
  e.preventDefault();
  const selected = area.selectionStart !== area.selectionEnd;
  const selection = area.value.slice(area.selectionStart, area.selectionEnd);
  showMenu([
    { label: 'Cut', hint: 'Ctrl+X', disabled: !selected, action: () => { navigator.clipboard.writeText(selection).catch(() => {}); insert(''); } },
    { label: COPY, hint: MENU_KEYS.copy, disabled: !selected, action: () => navigator.clipboard.writeText(selection).catch(() => {}) },
    { label: PASTE_LABEL, hint: MENU_KEYS.paste, action: () => paste() },
    { label: 'Paste as plain text', title: 'Without the colour codes, control characters and trailing spaces a terminal adds', action: () => paste(plainText) },
    SEPARATOR,
    { label: 'Copy to note', disabled: !area.value.trim(), title: selected ? undefined : 'With nothing selected, the whole page', submenu: noteChoices },
  ], { x: e.clientX, y: e.clientY });
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
 * @returns {import('./popups.js').MenuItem}
 */
export function copyToNotepadItem(text) {
  if (!pages().length) return { label: COPY_LABEL, action: () => copyHere(null, text) };
  return {
    label: COPY_LABEL,
    submenu: () => [...pages().map(p => ({ label: p.name, action: () => copyHere(p.id, text) })), SEPARATOR, { label: NEW_PAGE_LABEL, action: () => copyHere(null, text) }],
  };
}

// ---- Wiring ----

area.addEventListener('contextmenu', pageMenu);

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
    case NOTEPAD_ACTION.move: showMenu(noteChoices(), /** @type {HTMLElement} */ (action)); break;
    case NOTEPAD_ACTION.links: toggleView(NOTEPAD_ACTION.links); break;
    case NOTEPAD_ACTION.wrap: toggleView(NOTEPAD_ACTION.wrap); break;
    case NOTEPAD_ACTION.close: toggleNotepad(); break;
    default: break;
  }
});

onMiddleClick(tabsEl, e => {
  const tab = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-page]'));
  if (tab) closePage(/** @type {string} */ (tab.dataset.page));
});

// Its own keys while it has the focus (Termilly's shortcuts leave text boxes alone): save, open, back to the terminal.
panel.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey && !e.altKey;
  if (ctrl && e.code === NOTEPAD_KEY.save) save(e.shiftKey);
  else if (ctrl && !e.shiftKey && e.code === NOTEPAD_KEY.open) openFile();
  else if (ctrl && e.shiftKey && e.code === NOTEPAD_KEY.toggle) toggleNotepad();
  else if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey) restoreFocus();
  else return;
  e.preventDefault();
  e.stopPropagation();
});

button.addEventListener('click', () => toggleNotepad());

// ---- Docked on the right: the terminals and the Files panel end where it starts ----

dockRight(panel, {
  dockVar: '--notepad-dock', minWidth: MIN_WIDTH_PX, resized: scheduleFit,
  dragged: width => { state.notepad.width = width; persist(); },
});
