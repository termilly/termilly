// @ts-check
// A pane's header: shell badge, tab name (double-click to rename), tag chips, what's going on in the terminal (an
// environment, notes, recording, results, changed files, its Claude session, broadcast), and its buttons. The tag
// picker, the menu and renaming are modules of their own.

import { state, emit, on, tabTitle, activityOf, EVENTS } from './store.js';
import { tabBadgeHtml, tagChipHtml, escapeHtml, ICONS, activityHtml } from './ui.js';
import { closeTab, setHeaderBuilder } from './panes.js';
import { isCandidate, isReceiving, toggleReceiver } from './broadcast.js';
import { usageOf, usageChipHtml, usageTitle, openUsage } from './claudeusage.js';
import { editNote, notesFor, noteTitle, firstLine, NOTE_KIND } from './notes.js';
import { environmentOf, ENV_CLASS, ENV_COLOR } from './environments.js';
import { isLogging, openLogMenu, logFile } from './logging.js';
import { isAgentWorking, stopAgent } from './agentline.js';
import { openResults, resultCount, hasUnreadResults } from './results.js';
import { accessMarkText } from './together.js';
import { isRecording, toggleRecording, recordingFile } from './replay.js';
import { beginRename, PANE_NAME } from './rename.js';
import { openTagPicker } from './tagpicker.js';
import { openTabMenu, TAG_BUTTON } from './tabmenu.js';
import { find } from './dom.js';

const CHEVRON_DOWN = '<svg class="chev" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg>';

/** The header's parts that change with the terminal (HEADER_HTML has them). */
const PINNED_NOTE = '.pane-note';
const CAST_CHIP = '.cast-chip';
const LOG_CHIP = '.log-chip';
const BROADCAST_TOGGLE = '.bc-toggle';
const STOP_BUTTON = '.agent-stop-btn';
const USAGE_BUTTON = '.claude-usage';
const RESULTS_BUTTON = '.results-btn';
const CHANGES_BUTTON = '.changes-btn';
const NOTE_BUTTON = '.note-btn';

/** The results button's class while something new in them hasn't been looked at. */
const UNREAD_CLASS = 'unread';
/** The pane's class while it receives a broadcast (its stripe). */
const RECEIVING_CLASS = 'broadcast';

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
      <button class="pane-btn claude-usage" hidden></button>
      <button class="pane-btn results-btn" title="What commands here produced: pull requests, running apps, pushes" hidden></button>
      <button class="pane-btn changes-btn" title="Files Claude changed in this terminal" hidden></button>
      <button class="pane-btn menu-btn" title="Terminal menu">${ICONS.more}</button>
      <button class="pane-btn note-btn" hidden>${ICONS.note}</button>
      <button class="pane-btn tag-btn" title="Tags">${ICONS.tag}</button>
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
 * Opens a note of the terminal's: its own, its SSH host's or its workspace's.
 * @param {Tab} tab
 * @param {string} [kind]
 */
function editNoteOf(tab, kind) {
  if (kind === NOTE_KIND.host) editNote(NOTE_KIND.host, tab.profile);
  else if (kind === NOTE_KIND.workspace) {
    editNote(NOTE_KIND.workspace, /** @type {Workspace} */ (state.workspaces.find(w => w.id === tab.wsId)));
  }
  else editNote(NOTE_KIND.terminal, tab);
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
  // js/changes.js lists them (it can't be imported from here without a cycle through the preview).
  click(CHANGES_BUTTON, e =>
    emit(EVENTS.openChangedFiles, { tab, anchor: /** @type {HTMLElement} */ (e.currentTarget) }));
  click(USAGE_BUTTON, e => openUsage(tab, /** @type {HTMLElement} */ (e.currentTarget)));
  click('.close-btn', () => closeTab(tab));
  click(BROADCAST_TOGGLE, () => toggleReceiver(tab));
  click(LOG_CHIP, e => openLogMenu(tab, /** @type {HTMLElement} */ (e.currentTarget)));
  click(CAST_CHIP, () => toggleRecording(tab));
  click(STOP_BUTTON, () => stopAgent(tab));
  click(RESULTS_BUTTON, e => openResults(tab, /** @type {HTMLElement} */ (e.currentTarget)));
  click(NOTE_BUTTON, () => editNoteOf(tab, notesFor(tab)[0]?.kind));
  click(PINNED_NOTE, e => editNoteOf(tab, /** @type {HTMLElement} */ (e.currentTarget).dataset.kind));
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
  if (name) {
    name.textContent = tabTitle(tab);
    name.title = 'Double-click to rename';
  }
  find(header, '.pane-tags').innerHTML = tab.tags.map(t => tagChipHtml(t)).join('');
  find(header, STOP_BUTTON).hidden = !isAgentWorking(tab);
  showChips(tab, header);
  showNotes(tab, header);
  showStatus(tab, header);
  header.classList.toggle('no-history', !!tab.noHistory);
  showChanges(tab, header);
  showUsage(tab, header);
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
  // What commands here produced (results.js): a count, lit while something new hasn't been looked at.
  const results = find(header, RESULTS_BUTTON);
  const n = resultCount(tab);
  results.hidden = !n;
  results.classList.toggle(UNREAD_CLASS, hasUnreadResults(tab));
  results.innerHTML = `<svg viewBox="0 0 16 16"><path d="M3 3.5h10M3 8h10M3 12.5h6"/></svg><span>${n} result${n === 1 ? '' : 's'}</span>`;
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
    noteEl.title = `${noteTitle(notes)}\nClick to edit`;
  }
  // Any note at all (pinned or not): a note button beside the menu button, its lines on hover.
  const noteBtn = find(header, NOTE_BUTTON);
  noteBtn.hidden = !notes.length;
  noteBtn.title = notes.length ? `${noteTitle(notes)}\nClick to edit` : '';
}

/**
 * A status a script or agent set (termilly status, the MCP server's set_status).
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function showStatus(tab, header) {
  const status = find(header, '.pane-status');
  status.hidden = !tab.status;
  status.textContent = tab.status ?? '';
  status.title = tab.status ? 'Set by a script or agent through Termilly’s API' : '';
}

/**
 * The files Claude changed here (Settings › Change preview): shown once Claude has run in the terminal, even with
 * none yet, so it's clear the list is there.
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function showChanges(tab, header) {
  const changes = find(header, CHANGES_BUTTON);
  const count = tab.changes?.length ?? 0;
  changes.hidden = !(state.settings.changes.enabled && state.settings.changes.button && (count || tab.agentSeen));
  changes.classList.toggle('empty', !count);
  changes.innerHTML = `${ICONS.diff}<span>${count} changed</span>${CHEVRON_DOWN}`;
  changes.title = count ? `Files Claude changed in this terminal (${count})` : 'Claude hasn’t changed any files in this terminal yet';
}

/**
 * The Claude Code session here: model, context and tokens (Settings › Terminal › Claude session in the header).
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function showUsage(tab, header) {
  const usageBtn = find(header, USAGE_BUTTON);
  const usage = usageOf(tab);
  usageBtn.hidden = !usage;
  if (!usage) return;
  setHtmlIfChanged(usageBtn, usageChipHtml(tab, usage));
  usageBtn.title = usageTitle(tab, usage);
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

/**
 * Sets an element's markup only when it changes, so an animation in it (the spinner) doesn't restart.
 * @param {HTMLElement} el
 * @param {string} html
 */
function setHtmlIfChanged(el, html) {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

on(EVENTS.tab, updateHeader);
on(EVENTS.changes, updateHeader);
on(EVENTS.claudeUsage, updateHeader);
on(EVENTS.tags, () => { for (const tab of state.tabs.values()) updateHeader(tab); });
on(EVENTS.settings, () => { for (const tab of state.tabs.values()) updateHeader(tab); });
