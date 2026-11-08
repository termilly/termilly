// @ts-check
// A schedule's run in a terminal (js/schedules.js has the rest): a new one that goes when it's done, or one that's open, found by
// name or #tag, which it waits for. Nothing here takes the keyboard from the user: they may be typing when it's time.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, wsById, tabTitle } from './store.js';
import { newTab, closeTab, focusTab, focusedTab } from './panes.js';
import { AFTER, BUSY, CLOSED, RUN, WHERE } from './schedulerules.js';

/** What came of asking for a terminal. */
export const TERMINAL_TURN = Object.freeze({ sent: 'sent', waiting: 'waiting', skipped: 'skipped' });
/** The start of a name that's a tag instead. */
const TAG_MARK = '#';
const CTRL_C = '\x03';
/** How long a shell has to show it reports its commands; one that doesn't can't say how a run ended. */
const MARKS_WITHIN_MS = 20000;

/**
 * Opens a terminal where the schedule says, leaving the keyboard where it is.
 * @param {Schedule} schedule
 * @param {string} command
 * @param {(tab: Tab) => void} noMarks told when its shell can't say how the run ended
 * @returns {Tab}
 */
export function runInNewTerminal(schedule, command, noMarks) {
  const ws = wsById(schedule.wsId ?? '') ?? wsById(state.activeId);
  if (!ws) throw new Error('Its workspace is gone.');
  const shell = schedule.profile ?? undefined;
  if (shell && !state.profiles.some(p => p.id === shell)) throw new Error('Its shell or server isn’t on this PC any more.');
  const wasFocused = focusedTab();
  const tab = newTab({ profile: shell, wsId: ws.id, cwd: schedule.cwd || null, name: schedule.name, command });
  if (wasFocused) focusTab(wasFocused);
  watchMarks(tab, noMarks);
  return tab;
}

/** @param {Schedule} schedule */
export function terminalsFor(schedule) {
  const wanted = schedule.terminal.trim();
  const open = [...state.tabs.values()].filter(t => !t.exited && !t.virtual && t.wsId);
  if (wanted.startsWith(TAG_MARK)) return open.filter(t => t.tags.includes(wanted.slice(TAG_MARK.length)));
  return open.filter(t => tabTitle(t).toLowerCase() === wanted.toLowerCase());
}

/**
 * Types the command into the schedule's terminal, if it's free, and says what came of it.
 * @param {ActiveScheduleRun} going
 * @param {(tab: Tab) => void} noMarks
 * @returns {string}
 */
export function runInTerminal(going, noMarks) {
  const { schedule, command } = going;
  const found = terminalsFor(schedule);
  if (!found.length) {
    if (schedule.closed === CLOSED.skip) return TERMINAL_TURN.skipped;
    going.tab = runInNewTerminal(schedule, command, noMarks);
    return TERMINAL_TURN.sent;
  }
  const tab = found.find(t => !t.running) ?? null;
  if (!tab) {
    if (schedule.busy === BUSY.skip) return TERMINAL_TURN.skipped;
    if (schedule.busy === BUSY.wait) return TERMINAL_TURN.waiting;
    going.tab = runInNewTerminal(schedule, command, noMarks);
    return TERMINAL_TURN.sent;
  }
  going.tab = tab;
  send(PAGE.input, { id: tab.id, data: `${command.replace(/\r?\n/g, '\r')}\r` });
  watchMarks(tab, noMarks);
  return TERMINAL_TURN.sent;
}

/**
 * A shell that doesn't report its commands (cmd without its marks, a custom shell) can't say how a run ended.
 * @param {Tab} tab
 * @param {(tab: Tab) => void} noMarks
 */
function watchMarks(tab, noMarks) {
  setTimeout(() => {
    if (!tab.shellMarks) noMarks(tab);
  }, MARKS_WITHIN_MS);
}

/**
 * Stops what the run started; a terminal the schedule opened then goes as it said.
 * @param {ActiveScheduleRun} going
 */
export function stopInTerminal({ tab }) {
  if (tab) send(PAGE.input, { id: tab.id, data: CTRL_C });
}

/**
 * A terminal the schedule opened goes as it said. One it found stays: it's the user's.
 * @param {Tab} tab
 * @param {Schedule} schedule
 * @param {ScheduleRunRecord} run
 */
export function finishTerminal(tab, schedule, run) {
  if (schedule.where !== WHERE.fresh || schedule.after === AFTER.leave) return;
  if (schedule.after === AFTER.close || run.status === RUN.worked) closeTab(tab);
}
