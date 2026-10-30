// @ts-check
// The Notepad (the title bar's button, or Ctrl+Shift+M): pages for writing things down, in a panel docked on the
// right that stays as workspaces change. Pages are kept with the workspaces (encrypted with them) until closed; Save
// writes one to a text file and Open brings one in (Features/Notepad.cs). Move to note sends the selection, or the
// whole page, to a workspace's or a terminal's note; a terminal's right-click menu copies text here.

import { PAGE, HOST } from './protocol.js';
import { send, onHost, platform, PLATFORM } from './host.js';
import { state, persist, newId, tabTitle, wsById } from './store.js';
import { restoreFocus } from './panes.js';
import { scheduleFit } from './terminals.js';
import { escapeHtml, ICONS } from './ui.js';
import { byId, find, targetOf, dockRight, onMiddleClick, WORKSPACE_ID, DOCK_GRIP } from './dom.js';
import { showMenu, SEPARATOR } from './popups.js';
import { confirmDialog } from './dialogs.js';
import { showToast, TOAST } from './toasts.js';
import { appendNote, NOTE_KIND } from './notes.js';

/** @typedef {import('./store.js').NotepadPage} NotepadPage */

/** What the Notepad's buttons do (data-np). */
const NOTEPAD_ACTION = Object.freeze({ newPage: 'new', open: 'open', save: 'save', saveAs: 'saveAs', move: 'move', close: 'close' });
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
/** What its requests to the host start with. */
const REQUEST = 'np';

const panel = document.createElement('aside');
panel.className = 'notepad-panel';
panel.hidden = true;
panel.innerHTML = `
  <div class="${DOCK_GRIP}" title="Drag to resize"></div>
  <div class="files-head">
    <span class="files-title">Notepad</span>
    <span class="files-tools"><button class="pane-btn" data-np="${NOTEPAD_ACTION.close}" title="Close (Ctrl+Shift+M)">${ICONS.close}</button></span>
  </div>
  <div class="np-toolbar">
    <button class="btn small" data-np="${NOTEPAD_ACTION.newPage}" title="New page">New</button>
    <button class="btn small" data-np="${NOTEPAD_ACTION.open}" title="Open a text file (Ctrl+O)">Open</button>
    <button class="btn small" data-np="${NOTEPAD_ACTION.save}" title="Save (Ctrl+S)">Save</button>
    <button class="btn small" data-np="${NOTEPAD_ACTION.saveAs}" title="Save as (Ctrl+Shift+S)">Save as</button>
    <span class="spacer"></span>
    <button class="btn small" data-np="${NOTEPAD_ACTION.move}" title="Move the selection, or the whole page, to a workspace's or a terminal's note">Move to note</button>
  </div>
  <div class="pv-tabs np-tabs" role="tablist"></div>
  <textarea class="np-text" spellcheck="true" placeholder="Write anything down. A page is kept until you close it."></textarea>`;
byId(WORKSPACE_ID).append(panel);
const tabsEl = find(panel, '.np-tabs');
const area = /** @type {HTMLTextAreaElement} */ (find(panel, '.np-text'));
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
  tabsEl.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
 * Closes a page, asking first when its text isn't in a file; the last one closes the Notepad.
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
  persist();
  if (!pages().length) {
    setOpen(false);
    restoreFocus();
  } else render();
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

// ---- Moving text to a note ----

/** The selection in the page, else the whole page: what Move to note takes. */
function movable() {
  const { selectionStart: from, selectionEnd: to, value } = area;
  return from !== to ? { from, to, text: value.slice(from, to) } : { from: 0, to: value.length, text: value };
}

/**
 * Moves the selection (or the page) to a note, taking it out of the page.
 * @param {string} kind 'workspace' or 'terminal'
 * @param {Workspace | Tab} target
 * @param {string} name what the note is on, for the message
 */
function moveTo(kind, target, name) {
  const page = activePage();
  const { from, to, text } = movable();
  if (!page || !text.trim()) return showToast({ text: 'Nothing to move: the page is empty', state: TOAST.failed });
  if (!appendNote(kind, target, text)) return showToast({ text: `The note on ${name} is full`, state: TOAST.failed });
  page.text = page.text.slice(0, from) + page.text.slice(to);
  persist();
  render();
  area.setSelectionRange(from, from);
  showToast({ text: `Moved to the note on ${name}`, state: TOAST.done });
}

/** @param {HTMLElement} anchor */
function moveMenu(anchor) {
  const terminals = [...state.tabs.values()].filter(t => t.wsId && wsById(t.wsId) && !t.virtual);
  showMenu([
    {
      label: 'Workspace note', submenu: () => state.workspaces.map(w => ({ label: w.name, action: () => moveTo(NOTE_KIND.workspace, w, w.name) })),
    },
    {
      label: 'Terminal note', disabled: !terminals.length,
      submenu: () => terminals.map(t => ({ label: tabTitle(t), hint: escapeHtml(wsById(t.wsId)?.name ?? ''), action: () => moveTo(NOTE_KIND.terminal, t, tabTitle(t)) })),
    },
  ], anchor);
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

area.addEventListener('input', () => {
  const page = activePage();
  if (!page) return;
  const was = unsaved(page);
  page.text = area.value;
  persist();
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
    case NOTEPAD_ACTION.move: moveMenu(/** @type {HTMLElement} */ (action)); break;
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
