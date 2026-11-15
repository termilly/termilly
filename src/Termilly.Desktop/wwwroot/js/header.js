// @ts-check
// A pane's header: shell badge, tab name (double-click to rename), tag chips, what's going on in the terminal (an
// environment, notes, recording, results, broadcast), Stop while an agent works, and its buttons. Its agent's session,
// the files it changed and the git branch are in its status bar (statusbar.js). The tag picker, the menu and renaming
// are modules of their own.

import { state, on, activityOf, EVENTS, wsById } from './store.js';
import { tabBadgeHtml, tagChipHtml, escapeHtml, ICONS, activityHtml } from './ui.js';
import { closeTab, setAsideTab, setHeaderBuilder, SET_ASIDE_LABEL } from './panes.js';
import { isCandidate, isReceiving, toggleReceiver } from './broadcast.js';
import { notesFor, noteTitle, firstLine, editHostNote, NOTE_KIND } from './notes.js';
import { openTodo, markedList, tabHover, terminalList, workspaceList } from './todo.js';
import { environmentOf, ENV_CLASS, ENV_COLOR } from './environments.js';
import { isLogging, openLogMenu, logFile } from './logging.js';
import { isAgentWorking, stopAgent } from './agentline.js';
import { accessMarkText } from './together.js';
import { isRecording, toggleRecording, recordingFile } from './replay.js';
import { beginRename, shownName, PANE_NAME } from './rename.js';
import { openTagPicker } from './tagpicker.js';
import { openTabMenu, TAG_BUTTON } from './tabmenu.js';
import { find, setHtmlIfChanged } from './dom.js';
import { openPrompts, hasPrompts, PROMPTS_TITLE } from './myprompts.js';
import { updateSwitch, openViewMenu, VIEW_BUTTON } from './compact.js';

/** The header's parts that change with the terminal (HEADER_HTML has them). */
const PINNED_NOTE = '.pane-note';
const CAST_CHIP = '.cast-chip';
const LOG_CHIP = '.log-chip';
const BROADCAST_TOGGLE = '.bc-toggle';
const STOP_BUTTON = '.agent-stop-btn';
const NOTE_BUTTON = '.note-btn';
const PROMPTS_BUTTON = '.prompts-btn';

/** The pane's class while it receives a broadcast (its stripe). */
const RECEIVING_CLASS = 'broadcast';

/** The pane's Set aside button: a line low down, as a window's minimize, on the 10px grid its buttons are drawn at (a 1px
 * line on a whole pixel, so it stays sharp). */
const ASIDE_ICON = '<svg viewBox="0 0 10 10"><path d="M1 7.5h8" style="stroke-width:1"/></svg>';

const HEADER_HTML = `
    <span class="pane-title"><span class="env-chip" hidden></span><span class="badge-slot"></span><span class="pane-name"></span><span class="activity-slot"></span><span class="pane-status" hidden></span></span>
    <span class="pane-tags"></span>
    <button class="pane-note" hidden></button>
    <span class="access-mark" hidden></span>
    <button class="rec-chip cast-chip" title="Recording (asciicast). Click to stop." hidden><span class="rec-dot"></span>REC</button>
    <button class="rec-chip log-chip" title="Logging to a file" hidden><span class="rec-dot"></span>LOG</button>
    <button class="bc-toggle" hidden></button>
    <span class="pane-actions">
      <button class="pane-btn agent-stop-btn" title="Stop the agent (Esc)" hidden>${ICONS.stop}<span>Stop</span></button>
      <button class="pane-btn menu-btn" title="Terminal menu">${ICONS.more}</button>
      <button class="pane-btn view-btn" aria-haspopup="menu" hidden></button>
      <button class="pane-btn prompts-btn" title="${PROMPTS_TITLE}" hidden>${ICONS.prompts}</button>
      <button class="pane-btn note-btn" hidden>${ICONS.todo}</button>
      <button class="pane-btn tag-btn" title="Tags">${ICONS.tag}</button>
      <button class="pane-btn aside-btn" title="${SET_ASIDE_LABEL}">${ASIDE_ICON}</button>
      <button class="pane-btn close-btn" title="Close terminal (Ctrl+Shift+W)">${ICONS.close}</button>
    </span>`;

setHeaderBuilder(tab => buildHeader(tab));

/** @param {Tab} tab */
export function buildHeader(tab) {
  const header = document.createElement('div');
  header.className = 'pane-header';
  header.innerHTML = HEADER_HTML;
  wireHeader(tab, header);
  // Assigned before updateHeader so it can find the elements through the tab.
  /** @type {TabView} */ (tab.view).header = header;
  updateHeader(tab);
  return header;
}

/**
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function wireHeader(tab, header) {
  /**
   * @param {string} selector
   * @param {(e: MouseEvent) => unknown} fn
   */
  const click = (selector, fn) => find(header, selector).addEventListener('click', fn);
  find(header, PANE_NAME).addEventListener('dblclick', () => beginRename(tab));
  // The same menu as a right-click on the header.
  click('.menu-btn', e => openTabMenu(tab, /** @type {HTMLElement} */ (e.currentTarget)));
  click(TAG_BUTTON, e => openTagPicker(tab, /** @type {HTMLElement} */ (e.currentTarget)));
  click('.aside-btn', () => setAsideTab(tab));
  click('.close-btn', () => closeTab(tab));
  click(BROADCAST_TOGGLE, () => toggleReceiver(tab));
  click(LOG_CHIP, e => openLogMenu(tab, /** @type {HTMLElement} */ (e.currentTarget)));
  click(CAST_CHIP, () => toggleRecording(tab));
  click(STOP_BUTTON, () => stopAgent(tab));
  click(NOTE_BUTTON, () => openTodo(markedList(tab) ?? terminalList(tab)));
  click(VIEW_BUTTON, e => openViewMenu(tab, /** @type {HTMLElement} */ (e.currentTarget)));
  click(PROMPTS_BUTTON, e => openPrompts(tab, /** @type {HTMLElement} */ (e.currentTarget)));
  click(PINNED_NOTE, e => openPinned(tab, /** @type {string} */ (/** @type {HTMLElement} */ (e.currentTarget).dataset.kind)));
  header.addEventListener('contextmenu', e => {
    e.preventDefault();
    openTabMenu(tab, { x: e.clientX, y: e.clientY });
  });
}

/** @param {Tab} tab */
export function updateHeader(tab) {
  const header = tab.view?.header;
  if (!header) return;
  find(header, '.badge-slot').innerHTML = tabBadgeHtml(tab);
  showEnvironment(tab, header);
  const name = /** @type {HTMLElement | null} */ (header.querySelector(PANE_NAME));
  if (name) name.textContent = shownName(tab);
  find(header, '.pane-tags').innerHTML = tab.tags.map(t => tagChipHtml(t)).join('');
  find(header, STOP_BUTTON).hidden = !isAgentWorking(tab);
  find(header, PROMPTS_BUTTON).hidden = !hasPrompts(tab);
  updateSwitch(tab);
  showChips(tab, header);
  showNotes(tab, header);
  showStatus(tab, header);
  header.classList.toggle('no-history', !!tab.noHistory);
  showBroadcast(tab, header);
  showActivity(tab, header);
}

/**
 * Production (or staging): a coloured frame, a tinted header and a chip (environments.js).
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function showEnvironment(tab, header) {
  const env = environmentOf(tab);
  const chip = find(header, '.env-chip');
  chip.hidden = !env;
  if (env) {
    chip.textContent = env.label;
    chip.title = `This terminal is on ${env.id === 'prod' ? 'production' : env.label.toLowerCase()}`;
  }
  const pane = /** @type {TabView} */ (tab.view).el;
  if (!pane) return;
  pane.classList.toggle(ENV_CLASS, !!env);
  pane.classList.toggle('env-tint', !!env && !!state.settings.safety.prodTint);
  if (env) pane.style.setProperty(ENV_COLOR, env.color); else pane.style.removeProperty(ENV_COLOR);
}

/**
 * What commands here produced, another agent's access, and the REC chips for a recording and a log.
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function showChips(tab, header) {
  // Another terminal's agent reading or typing here just now (together.js).
  const access = find(header, '.access-mark');
  access.hidden = !tab.access?.mark;
  access.textContent = accessMarkText(tab);
  const cast = find(header, CAST_CHIP);
  cast.hidden = !isRecording(tab);
  if (isRecording(tab)) cast.title = `Recording to ${recordingFile(tab)}. Click to stop.`;
  // Logging to a file (logging.js): its menu shows the file or stops.
  const rec = find(header, LOG_CHIP);
  rec.hidden = !isLogging(tab);
  if (isLogging(tab)) rec.title = `Logging to ${logFile(tab)}`;
}

/**
 * Opens the list a pinned note is on.
 * @param {Tab} tab
 * @param {string} kind
 */
function openPinned(tab, kind) {
  if (kind === NOTE_KIND.host) editHostNote(tab.profile);
  else openTodo(kind === NOTE_KIND.workspace ? workspaceList(/** @type {Workspace} */ (wsById(tab.wsId))) : terminalList(tab));
}

/**
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function showNotes(tab, header) {
  // A pinned note (the terminal's, its host's or its workspace's): its first line, all of them on hover.
  const notes = notesFor(tab);
  const pinned = notes.find(n => n.pinned);
  const noteEl = find(header, PINNED_NOTE);
  noteEl.hidden = !pinned;
  if (pinned) {
    noteEl.innerHTML = `${ICONS.note}<span>${escapeHtml(firstLine(pinned.text))}</span>`;
    noteEl.dataset.kind = pinned.kind;
    noteEl.title = `${noteTitle(notes)}\nClick to open`;
  }
  // Anything in its lists: a To do button beside the menu button, what's in them on hover.
  const noteBtn = find(header, NOTE_BUTTON);
  noteBtn.hidden = !markedList(tab);
  noteBtn.title = noteBtn.hidden ? '' : `${tabHover(tab)}\nClick to open`;
}

/**
 * A status a script or agent set (termilly status, the MCP server's set_status).
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function showStatus(tab, header) {
  find(header, '.pane-title').title = tab.openedBy ? `Opened from ${tab.openedBy}` : '';
  const status = find(header, '.pane-status');
  status.hidden = !tab.status;
  status.textContent = tab.status ?? '';
  status.title = tab.status ? 'Set by a script or agent through Termilly’s API' : '';
}

/**
 * Broadcast: terminals in scope get an in/out switch, and the ones receiving get a stripe.
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function showBroadcast(tab, header) {
  const bc = find(header, BROADCAST_TOGGLE);
  const receiving = isReceiving(tab);
  bc.hidden = !isCandidate(tab);
  bc.classList.toggle('on', receiving);
  bc.textContent = receiving ? 'Receiving' : 'Not receiving';
  bc.title = receiving ? 'Typing in the broadcast reaches this terminal. Click to leave it out.' : 'Click to include this terminal in the broadcast.';
  /** @type {TabView} */ (tab.view).el?.classList.toggle(RECEIVING_CLASS, receiving);
}

/**
 * The spinner next to the name; the pane's border follows it too (red for an error, amber when paused).
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function showActivity(tab, header) {
  const activity = activityOf(tab);
  if (/** @type {TabView} */ (tab.view).el) {
    /** @type {TabView} */ (tab.view).el.dataset.activity = activity?.kind ?? '';
  }
  const slot = /** @type {HTMLElement | null} */ (header.querySelector('.activity-slot'));
  if (slot) setHtmlIfChanged(slot, activityHtml(activity));
}

on(EVENTS.tab, updateHeader);
on(EVENTS.tags, () => { for (const tab of state.tabs.values()) updateHeader(tab); });
on(EVENTS.settings, () => { for (const tab of state.tabs.values()) updateHeader(tab); });
