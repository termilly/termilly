// @ts-check
// Session logs: a terminal's output written to a plain file (SessionLog.cs on the host). Started from the terminal
// menu ("Log to file"), or always for terminals with a tag or profile listed in Settings › Terminal › Session logs.
// While a terminal logs, its header shows a ● REC chip.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, emit, wsById, tabTitle, GROUPS, EVENTS } from './store.js';
import { showMenu } from './popups.js';
import { updateSettings } from './preferences.js';
import { SECOND_MS } from './util.js';
import { TENTHS_BELOW_MS } from './commands.js';
import { DEFAULT_WORKSPACE_NAME } from './workspaces.js';


/**
 * A log:status message, whichever of its shapes (Host_logStatus) it has.
 * @typedef {{ id: string, path: string | null, raw?: boolean, error?: string }} LogStatus
 */

/**
 * A terminal's session log (tab.log): the file (null while it isn't logging), whether it's raw, a marker on the next
 * row a plain log sends, and whether a terminal that always logs was started already.
 * @typedef {{ path: string | null, raw: boolean, marker: any, asked: boolean }} SessionLog
 */

/**
 * A terminal's session log, kept here: the file it writes (null while it isn't logging), whether it's raw, a marker on
 * the next row a plain log sends, and whether a terminal that always logs was started already.
 * @param {Tab} tab
 */
const logOf = tab => (tab.log ??= { path: null, raw: false, marker: null, asked: false });

/**
 * The file a terminal logs to, or null.
 * @param {Tab} tab
 */
export const logFile = tab => tab.log?.path ?? null;

/** @param {Tab} tab */
export const isLogging = tab => !!logFile(tab);

/**
 * Whether a terminal writes a plain log, which Termilly writes line by line (a raw one is the host's alone).
 * @param {Tab} tab
 */
const plainLog = tab => isLogging(tab) && !tab.log?.raw;

/** @param {Tab} tab */
export function startLog(tab) {
  send(PAGE.logStart, { id: tab.id, workspace: wsById(tab.wsId)?.name ?? DEFAULT_WORKSPACE_NAME, name: tabTitle(tab) });
}

/** @param {Tab} tab */
export function stopLog(tab) {
  send(PAGE.logStop, { id: tab.id });
}

/** @param {Tab} tab */
export const toggleLog = tab => (isLogging(tab) ? stopLog(tab) : startLog(tab));

/**
 * Whether Settings say this terminal always logs (its tag or its profile is listed).
 * @param {Tab} tab
 */
export function logsAlways(tab) {
  const tags = state.settings.logging.tags ?? [];
  return tab.tags.some(t => tags.includes(t)) || (state.settings.logging.profiles ?? []).includes(tab.profile);
}

/**
 * "Always log <profile>" in the terminal menu: adds or removes the profile.
 * @param {Tab} tab
 */
export function toggleProfileLogging(tab) {
  const profiles = new Set(state.settings.logging.profiles ?? []);
  if (profiles.has(tab.profile)) profiles.delete(tab.profile); else profiles.add(tab.profile);
  updateSettings(GROUPS.logging, { profiles: [...profiles] });
  if (profiles.has(tab.profile) && !isLogging(tab)) startLog(tab);
}

/**
 * The REC chip's menu.
 * @param {Tab} tab
 * @param {import('./popups.js').Anchor} anchor
 */
export function openLogMenu(tab, anchor) {
  showMenu([
    { label: 'Show the log file', action: () => send(PAGE.logReveal, { id: tab.id }) },
    { label: 'Stop logging', action: () => stopLog(tab) },
  ], anchor);
}

onHost(HOST.logStatus, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  logOf(tab).path = m.path ?? null;
  logOf(tab).raw = !!(/** @type {LogStatus} */ (m).raw);
  if (/** @type {LogStatus} */ (m).error) console.warn('session log', /** @type {LogStatus} */ (m).error);
  // A plain log starts at the line being written now; what's already on screen isn't in it.
  const buffer = tab.view?.term?.buffer.normal;
  if (isLogging(tab) && buffer) setRow(tab, buffer.baseY + buffer.cursorY);
  emit(EVENTS.tab, tab);
});

// ---- Plain logs: the lines as the terminal shows them ----

/**
 * Where the log has got to: a marker on the next row to send, so it stays on its line as the scrollback
 * drops old rows (a plain row number would drift).
 * @param {Tab} tab
 * @param {number} row
 */
function setRow(tab, row) {
  const term = tab.view?.term;
  if (!term) return;
  tab.log?.marker?.dispose();
  const buffer = term.buffer.normal;
  // A marker can't be below the cursor; a row past it starts at the cursor's, which nothing has finished yet.
  logOf(tab).marker = term.registerMarker(Math.min(0, row - (buffer.baseY + buffer.cursorY)));
}

/**
 * The row the log has got to; 0 when its line has left the scrollback.
 * @param {Tab} tab
 */
function rowOf(tab) {
  const marker = tab.log?.marker;
  return !marker ? null : marker.isDisposed ? 0 : marker.line;
}

/**
 * Sends the lines finished since the last call (the cursor's line isn't finished yet; with `all`, it is). Wrapped
 * rows are joined into one line. Where the shell marks its commands, a prompt and what's typed at it aren't sent:
 * the command's own mark ($ git push) stands for them.
 * @param {Tab} tab
 */
function sendLines(tab, all = false) {
  if (!plainLog(tab)) return;
  const term = tab.view?.term;
  if (!term) return;
  const buffer = term.buffer.normal;
  const end = buffer.baseY + buffer.cursorY + (all ? 1 : 0);
  let y = Math.max(rowOf(tab) ?? end, 0);
  if (y >= end) return;
  if (tab.shellMarks && !tab.running) {
    setRow(tab, end);
    return;
  }
  /** @type {string[]} */
  const lines = [];
  for (; y < end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    if (line.isWrapped && lines.length) {
      lines[lines.length - 1] += line.translateToString(true);
      continue;
    }
    lines.push(line.translateToString(true));
  }
  setRow(tab, end);
  // A wrapped line can go on in the row being written: keep it until it's finished.
  if (!all && buffer.getLine(end)?.isWrapped) {
    let start = end - 1;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
    setRow(tab, start);
    lines.pop();
  }
  if (all) while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length) send(PAGE.logLines, { id: tab.id, lines });
}

/**
 * @param {Tab} tab
 * @param {string} text
 */
const mark = (tab, text) => { if (plainLog(tab)) send(PAGE.logLines, { id: tab.id, lines: [text] }); };

/** @param {number} ms */
const seconds = ms => (ms < TENTHS_BELOW_MS ? (ms / SECOND_MS).toFixed(1) : String(Math.round(ms / SECOND_MS)));

on(EVENTS.terminalOpened, tab => tab.view.term.onWriteParsed(() => sendLines(tab)));
on(EVENTS.commandStarted, tab => {
  if (!plainLog(tab)) return;
  mark(tab, `$ ${tab.running?.command?.trim() || '(command)'}`);
  // The output starts on the line after the typed command (or on it, where the shell marked the end of input).
  const buffer = tab.view.term.buffer.normal;
  setRow(tab, buffer.baseY + buffer.cursorY + (tab.running?.outputOffset ? 1 : 0));
});
on(EVENTS.commandEnding, ({ tab, exitCode, durationMs }) => {
  if (!plainLog(tab)) return;
  sendLines(tab, true);
  // The prompt that follows isn't output.
  const buffer = tab.view.term.buffer.normal;
  setRow(tab, buffer.baseY + buffer.cursorY + 1);
  mark(tab, `[exit ${exitCode ?? '?'}, ${seconds(durationMs)} s]`);
});

/**
 * Starts a terminal that always logs, once: stopping it by hand isn't undone.
 * @param {Tab} tab
 */
function autoStart(tab) {
  if (!tab?.view || tab.log?.asked || isLogging(tab) || !logsAlways(tab)) return;
  logOf(tab).asked = true;
  startLog(tab);
}

// A terminal that always logs starts as it opens; one tagged later starts when the tag is added.
on(EVENTS.terminalOpened, autoStart);
on(EVENTS.tab, autoStart);
