// @ts-check
// Commands the shell marks (OSC 133 shell integration): where each prompt is, what was run, how it ended. Gives
// prompt marks on the scrollbar and in the gutter (green or red with the exit code), jumping between prompts,
// copying a command's output, and the command history the palette searches.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { wsById, tabTitle, emit, EVENTS } from './store.js';
import { commandFinished, scanOutput, scanFrom } from './triggers.js';
import { SECOND_MS, MINUTE_MS } from './util.js';

const MAX_PROMPTS = 500;
/** Finished commands a terminal keeps for the output viewer. */
const MAX_LOG = 30;
/** The classes of a finished command's mark in the margin (app.css): it succeeded, or it failed. */
const MARK = Object.freeze({ ok: 'ok', fail: 'fail' });
/** Under this, a duration in seconds keeps one decimal (4.2 s). */
export const TENTHS_BELOW_MS = 10 * SECOND_MS;

/**
 * Where the typed input started: an xterm marker on its row, and its column.
 * @typedef {{ marker: any, x: number }} InputStart
 */

/**
 * A command the shell marked (tab.running while it runs, then tab.lastCommand): what was run, when and where, the
 * xterm markers of its prompt and output and, once it has ended, its exit code, how long it took and where its output
 * ends.
 * @typedef {{ command: string, startedAt: number, cwd: string | null, promptMarker: any, outputMarker: any,
 *   outputOffset: number, exitCode?: number | null, durationMs?: number, endMarker?: any }} CommandRun
 */

/**
 * A terminal's tab.commands: its prompts (xterm markers), the latest, the input start, the reported command line and
 * the last finished commands.
 * @typedef {{ prompts: any[], promptMarker: any, input: InputStart | null, reported: string | null,
 *   log: CommandRun[] }} CommandsState
 */

/**
 * What the shell's marks have told this module about a terminal, kept here: its prompts (for jumping), the latest
 * one, where the typed input started, the command line the shell reported (bash's PS0), and the last commands.
 * @param {Tab} tab
 * @returns {CommandsState}
 */
const commandsOf = tab => (tab.commands ??= { prompts: [], promptMarker: null, input: null, reported: null, log: [] });

/**
 * The shell reported the command line it's about to run (OSC 633;E): it beats reading what was typed.
 * @param {Tab} tab
 * @param {string} commandLine
 */
export function commandReported(tab, commandLine) {
  commandsOf(tab).reported = commandLine;
}

/**
 * The terminal's last finished commands, oldest first.
 * @param {Tab} tab
 */
export const commandLog = tab => tab.commands?.log ?? [];

/**
 * A prompt started (A): remember where, for jumping.
 * @param {Tab} tab
 */
export function promptStarted(tab) {
  const { term } = /** @type {TabView} */ (tab.view);
  const marker = term.registerMarker(0);
  if (!marker) return;
  const commands = commandsOf(tab);
  commands.prompts = commands.prompts.filter(m => !m.isDisposed);
  commands.prompts.push(marker);
  if (commands.prompts.length > MAX_PROMPTS) commands.prompts.shift().dispose();
  commands.promptMarker = marker;
}

/**
 * The user's input starts after the prompt (B).
 * @param {Tab} tab
 */
export function inputStarted(tab) {
  const { term } = /** @type {TabView} */ (tab.view);
  commandsOf(tab).input = { marker: term.registerMarker(0), x: term.buffer.active.cursorX };
}

/**
 * The command started running (C): read what was typed, from the input start to the cursor.
 * @param {Tab} tab
 */
export function commandStarted(tab) {
  const { term } = /** @type {TabView} */ (tab.view);
  const buffer = term.buffer.active;
  const commands = commandsOf(tab);
  const { input } = commands;
  tab.running = {
    command: commands.reported ?? (input?.marker && !input.marker.isDisposed ? typedSince(buffer, input) : ''),
    startedAt: Date.now(),
    cwd: tab.cwd ?? null,
    promptMarker: commands.promptMarker,
    // Output starts on the next line when the shell marked the start at the end of the typed line (PowerShell).
    outputMarker: term.registerMarker(0),
    outputOffset: buffer.cursorX > 0 ? 1 : 0,
  };
  commands.reported = null;
  emit(EVENTS.commandStarted, tab); // a session log marks it (logging.js)
  // What was typed isn't output: triggers start looking after the command line.
  scanFrom(tab, buffer.baseY + buffer.cursorY + (buffer.cursorX > 0 ? 1 : 0));
}

/**
 * The text typed after the prompt, rows the terminal wrapped joined back up.
 * @param {any} buffer xterm's active buffer
 * @param {InputStart} input
 */
function typedSince(buffer, { marker, x }) {
  const end = buffer.baseY + buffer.cursorY;
  let text = '';
  for (let y = marker.line; y <= end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const part = line.translateToString(true, y === marker.line ? x : 0);
    text += y > marker.line && !line.isWrapped ? `\n${part}` : part;
  }
  return text.trim();
}

/**
 * The command ended (D) with its exit code: mark it, keep it for "copy output", and record it in history.
 * @param {Tab} tab
 * @param {number | null} exitCode
 */
export function commandEnded(tab, exitCode) {
  const run = tab.running;
  if (!run) return;
  scanOutput(tab); // the output's last lines, before it stops counting as the command's
  emit(EVENTS.commandEnding, { tab, exitCode, durationMs: Date.now() - run.startedAt });
  tab.running = null;
  const { term } = /** @type {TabView} */ (tab.view);
  const durationMs = Date.now() - run.startedAt;
  const ok = !exitCode;
  const end = term.registerMarker(0);
  tab.lastCommand = { ...run, exitCode, durationMs, endMarker: end };
  // The last commands, for the output viewer (viewer.js) and "Open output…".
  const { log } = commandsOf(tab);
  log.push(tab.lastCommand);
  if (log.length > MAX_LOG) log.shift();

  const anchor = run.promptMarker && !run.promptMarker.isDisposed ? run.promptMarker : run.outputMarker;
  const decoration = anchor && term.registerDecoration({
    marker: anchor,
    overviewRulerOptions: { color: ok ? '#7ee787' : '#ff7b72', position: 'left' },
  });
  decoration?.onRender((/** @type {HTMLElement} */ el) => {
    el.classList.add('cmd-mark', ok ? MARK.ok : MARK.fail);
    el.title = `${run.command || 'Command'}\nexit ${exitCode ?? '?'} · ${formatDuration(durationMs)}`;
  });

  commandFinished(tab, run.command, exitCode);

  if (run.command && !tab.noHistory) {
    send(PAGE.historyCommand, {
      entry: {
        command: run.command, exitCode, durationMs, at: run.startedAt, cwd: run.cwd,
        terminal: tabTitle(tab), workspace: wsById(tab.wsId)?.name ?? null,
      },
    });
  }
}

/** @param {number} ms */
export function formatDuration(ms) {
  if (ms < SECOND_MS) return `${ms} ms`;
  if (ms < MINUTE_MS) return `${(ms / SECOND_MS).toFixed(ms < TENTHS_BELOW_MS ? 1 : 0)} s`;
  const m = Math.floor(ms / MINUTE_MS);
  return `${m} min ${Math.round((ms % MINUTE_MS) / SECOND_MS)} s`;
}

/**
 * Scrolls to the previous (-1) or next (+1) prompt from the top of the view. Returns false when there's none.
 * @param {Tab | null} tab
 * @param {number} direction
 */
export function jumpToPrompt(tab, direction) {
  const term = tab?.view?.term;
  if (!term) return false;
  const top = term.buffer.active.viewportY;
  // It has a terminal, so there is a tab.
  const lines = /** @type {any[]} */ (/** @type {Tab} */ (tab).commands?.prompts ?? [])
    .filter(m => !m.isDisposed).map(m => m.line);
  const target = direction < 0
    ? Math.max(...lines.filter(l => l < top), -1)
    : Math.min(...lines.filter(l => l > top), Infinity);
  if (target < 0 || target === Infinity) {
    if (direction > 0) term.scrollToBottom();
    return false;
  }
  term.scrollToLine(target);
  return true;
}

/**
 * The last finished command's output as text (without its prompt and command line), or null.
 * @param {Tab | null} tab
 */
export function lastOutput(tab) {
  const last = tab?.lastCommand;
  const buffer = tab?.view?.term?.buffer.active;
  if (!last || !buffer || last.outputMarker.isDisposed || last.endMarker?.isDisposed) return null;
  const rows = [];
  for (let y = last.outputMarker.line + last.outputOffset; y < last.endMarker.line; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(false);
    if (line.isWrapped && rows.length) rows[rows.length - 1] += text;
    else rows.push(text);
  }
  const lines = rows.map(r => r.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\r\n');
}

/**
 * Copies the last command's output to the clipboard; returns how many lines, or null when there's none.
 * @param {Tab | null} tab
 */
export async function copyLastOutput(tab) {
  const text = lastOutput(tab);
  if (text === null) return null;
  await navigator.clipboard.writeText(text);
  return text ? text.split('\r\n').length : 0;
}

