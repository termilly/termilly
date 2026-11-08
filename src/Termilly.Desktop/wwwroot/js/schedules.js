// @ts-check
// Schedules: commands and snippets that run on time. The page keeps them with the rest of its state and watches the clock
// (Features/Schedules.cs ticks it, as a window hidden in the tray has its own timers held back), so they run while Termilly is
// open or in the tray. Quit, nothing runs: what was missed runs once at the next start, or is skipped, as each schedule says.
// A run goes out of sight in a hidden shell, here or on a server, or in a terminal (js/scheduleterminal.js). Every run is
// recorded; what it printed is kept encrypted by the app. js/scheduleswindow.js is the window.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, emit, on, persist, newId, EVENTS } from './store.js';
import { allSnippets, fill } from './snippets.js';
import { windowInFront } from './windowshown.js';
import { lastOutput } from './commands.js';
import { agentCommand, readResult, noticeOf } from './agentcli.js';
import { saveReport } from './schedulesave.js';
import { addScheduleNote } from './inbox.js';
import { plainText } from './schedulereport.js';
import { runInNewTerminal, runInTerminal, stopInTerminal, finishTerminal, terminalsFor, TERMINAL_TURN } from './scheduleterminal.js';
import {
  nextRun, newSchedule, statusOf, summaryOf, shouldTell, sortRuns, RUN, RUN_LABEL, WHAT, WHERE, WHEN, MISSED, GRACE_MS,
} from './schedulerules.js';

const MINUTE_S = 60;
const SECOND_MS = 1000;
/** What a phone alert says happened (Features/Phone.cs AlertFor). */
const PHONE_STATE = 'schedule';
/** What the schedule's terminal said when the run didn't end by itself. */
const CLOSED_WHILE_RUNNING = 'Termilly closed while it ran.';
/** How long after it starts Termilly first looks for what's due: restored terminals need their shells first. */
const FIRST_LOOK_MS = 3000;

/**
 * A run going on: its record, its schedule, and its terminal if it has one.
 * @typedef {ActiveScheduleRun} ActiveRun
 */

/** @type {Map<string, ActiveRun>} */
const active = new Map();

export const schedules = () => state.schedules.list;
export const runs = () => state.schedules.runs;
/** @param {string} id */
export const scheduleById = id => schedules().find(s => s.id === id) ?? null;
/** @param {string} scheduleId */
export const runsOf = scheduleId => runs().filter(r => r.scheduleId === scheduleId);
/** @param {string} id */
const isGoing = id => [...active.values()].some(a => a.schedule.id === id);
/**
 * Whether a schedule's prompt runs in a terminal now: nobody is asked there, so what Claude Code would ask for it refuses
 * by itself (agentcli.js).
 * @param {Tab} tab
 */
export const nobodyAsksIn = tab => [...active.values()].some(a => a.tab === tab && a.schedule.what === WHAT.agent);
/** The runs going on now, for the sidebar. */
export const runningNow = () => [...active.values()].filter(a => a.run.status === RUN.running || a.run.status === RUN.waiting);

/** What changed is shown, and saved with the rest. */
function changed() {
  persist();
  emit(EVENTS.schedules);
}

/**
 * Keeps a schedule, new or changed. When it runs next comes from what it says now.
 * @param {Schedule} schedule
 */
export function saveSchedule(schedule) {
  const next = { ...schedule, nextAt: nextRun(schedule.when, Date.now()) };
  const at = schedules().findIndex(s => s.id === schedule.id);
  if (at < 0) schedules().push(next);
  else schedules()[at] = next;
  changed();
}

/** @param {string} id */
export function removeSchedule(id) {
  state.schedules.list = schedules().filter(s => s.id !== id);
  tidyRuns();
  changed();
}

/**
 * @param {string} id
 * @param {boolean} on
 */
export function setScheduleOn(id, on) {
  const schedule = scheduleById(id);
  if (!schedule) return;
  schedule.on = on;
  schedule.nextAt = nextRun(schedule.when, Date.now());
  changed();
}

/** Runs past their time go, and what was kept of them. */
function tidyRuns() {
  const { keep, gone } = sortRuns(runs(), schedules(), Date.now());
  state.schedules.runs = keep;
  if (gone.length) send(PAGE.scheduleForget, { runIds: gone.map(r => r.id) });
}

/**
 * The command a schedule runs now: a snippet as it is at the moment, its placeholders at their defaults.
 * @param {Schedule} schedule
 * @returns {string | null} null when the snippet is gone
 */
function commandOf(schedule) {
  if (schedule.what === WHAT.command) return schedule.command;
  if (schedule.what === WHAT.agent) return agentCommand(schedule.prompt, { shell: shellOf(schedule), changes: schedule.allowChanges, json: isOutOfSight(schedule) });
  const found = [undefined, ...state.workspaces].flatMap(ws => allSnippets(ws)).find(s => s.name === schedule.snippet);
  return found ? fill(found.command, {}) : null;
}

/** @param {Schedule} schedule */
const isOutOfSight = schedule => schedule.where === WHERE.hidden || schedule.where === WHERE.server;

/**
 * Which shell reads what a run sends: a prompt has to be written for it.
 * @param {Schedule} schedule
 */
function shellOf(schedule) {
  const profile = schedule.where === WHERE.terminal ? terminalsFor(schedule)[0]?.profile : schedule.profile;
  const found = state.profiles.find(p => p.id === profile) ?? state.profiles[0];
  return found?.shellIcon ?? found?.icon;
}

/**
 * A new record, on top of the runs.
 * @param {Schedule} schedule
 * @param {string} status
 * @param {string} [summary]
 * @returns {ScheduleRunRecord}
 */
function record(schedule, status, summary = '') {
  const run = { id: newId('r'), scheduleId: schedule.id, name: schedule.name, at: Date.now(), ms: 0, status, code: null, summary };
  state.schedules.runs = [run, ...runs()];
  return run;
}

/**
 * A run that didn't happen, for the history; the user hears of it as of a failure.
 * @param {Schedule} schedule
 * @param {string} status
 * @param {string} why
 */
function notRun(schedule, status, why) {
  tell(schedule, record(schedule, status, why));
  tidyRuns();
  changed();
}

/**
 * Starts a run where its schedule says.
 * @param {Schedule} schedule
 */
function begin(schedule) {
  if (isGoing(schedule.id)) {
    notRun(schedule, RUN.skipped, 'The last run was still going.');
    return;
  }
  const command = commandOf(schedule);
  const run = record(schedule, RUN.running);
  if (command === null) {
    end(run, schedule, { error: `The snippet ${schedule.snippet} is gone.` });
    return;
  }
  const going = { run, schedule, command };
  active.set(run.id, going);
  try {
    place(going);
  } catch (e) {
    end(run, schedule, { error: e instanceof Error ? e.message : String(e) });
    return;
  }
  changed();
}

/** @param {ActiveRun} going */
function place(going) {
  const { run, schedule, command } = going;
  if (isOutOfSight(schedule)) {
    const cwd = schedule.cwd || null;
    send(PAGE.scheduleRun, { runId: run.id, profile: schedule.profile, cwd, command, limitSeconds: schedule.limitMinutes * MINUTE_S });
  } else if (schedule.where === WHERE.fresh) {
    going.tab = runInNewTerminal(schedule, command, withoutMarks);
  } else {
    turnIn(going, runInTerminal(going, withoutMarks));
  }
}

/**
 * What came of asking for a terminal that's open.
 * @param {ActiveRun} going
 * @param {string} turn
 */
function turnIn(going, turn) {
  const { run, schedule } = going;
  if (turn === TERMINAL_TURN.skipped) {
    active.delete(run.id);
    run.status = RUN.skipped;
    run.summary = 'The terminal was busy or closed.';
    tell(schedule, run);
  } else if (turn === TERMINAL_TURN.waiting) {
    run.status = RUN.waiting;
    run.summary = 'Waiting for the terminal.';
  } else {
    run.status = RUN.running;
    run.summary = '';
  }
}

/**
 * A shell that doesn't report its commands can't say how a run ended: it was sent, and that's what's known.
 * @param {Tab} tab
 */
const withoutMarks = tab => terminalRunEnded(tab, { sent: true, summary: 'Sent. This shell doesn’t say how it ended.' });

/**
 * Asks for a run now.
 * @param {string} id
 */
export function runNow(id) {
  const schedule = scheduleById(id);
  if (schedule) begin(schedule);
}

/**
 * Stops a run going on.
 * @param {string} runId
 */
export function stopRun(runId) {
  const going = active.get(runId);
  if (!going) return;
  if (going.tab !== undefined) {
    stopInTerminal(going);
    end(going.run, going.schedule, { stopped: true });
  } else if (going.run.status === RUN.waiting) {
    end(going.run, going.schedule, { stopped: true });
  } else send(PAGE.scheduleStop, { runId });
}

/**
 * Ends a run: what it came to, the user told if they asked, and its terminal dealt with.
 * @param {ScheduleRunRecord} run
 * @param {Schedule} schedule
 * @param {{ code?: number | null, stopped?: boolean, error?: string | null, sent?: boolean, summary?: string, costUsd?: number | null, notice?: string, text?: string }} how
 *   text: what it printed, or an agent's reply, to keep where the schedule says
 */
function end(run, schedule, how) {
  const going = active.get(run.id);
  active.delete(run.id);
  run.ms = Date.now() - run.at;
  run.code = how.code ?? null;
  run.costUsd = how.costUsd ?? null;
  run.status = how.sent ? RUN.sent : statusOf(how);
  run.summary = how.error ?? how.summary ?? (how.stopped ? `Stopped after ${Math.round(run.ms / SECOND_MS)} s.` : '');
  if (going?.tab) finishTerminal(going.tab, schedule, run);
  tell(schedule, run, how.notice);
  if (how.text !== undefined) saveReport(schedule, run, how.text);
  tidyRuns();
  changed();
}

/**
 * Tells the user about a run, if the schedule asks for it: a notification, the notification center, and the phones.
 * @param {Schedule} schedule
 * @param {ScheduleRunRecord} run
 * @param {string} [notice] what it says, in place of the run's summary
 */
function tell(schedule, run, notice) {
  if (!shouldTell(schedule.notify, run.status)) return;
  const title = `${schedule.name}: ${RUN_LABEL[run.status].toLowerCase()}`;
  const body = notice ?? run.summary;
  send(PAGE.notify, { id: run.id, title, body });
  addScheduleNote({ id: run.id, title, detail: body, failed: run.status !== RUN.worked, at: Date.now() });
  if (schedule.phone) send(PAGE.phoneAlert, { id: run.id, state: PHONE_STATE, title, body, inFront: windowInFront() });
}

/**
 * Whether a schedule is due, and whether it was missed.
 * @param {Schedule} schedule
 * @param {number} now
 */
function look(schedule, now) {
  if (!schedule.on || schedule.when.kind === WHEN.start) return;
  schedule.nextAt ??= nextRun(schedule.when, now);
  if (schedule.nextAt === null || now < schedule.nextAt) return;
  const late = now - schedule.nextAt > GRACE_MS;
  schedule.nextAt = nextRun(schedule.when, now);
  if (late && schedule.missed === MISSED.skip) notRun(schedule, RUN.missed, 'Termilly wasn’t running at its time.');
  else begin(schedule);
}

/**
 * A terminal that was busy may be free, and a run may be past its limit.
 * @param {number} now
 */
function lookAtActive(now) {
  for (const going of [...active.values()]) {
    if (going.run.status === RUN.waiting) turnIn(going, runInTerminal(going, withoutMarks));
    const over = now - going.run.at > going.schedule.limitMinutes * MINUTE_S * SECOND_MS;
    if (over && (going.tab !== undefined || going.run.status === RUN.waiting)) stopRun(going.run.id);
  }
}

function tick() {
  const now = Date.now();
  for (const schedule of [...schedules()]) look(schedule, now);
  lookAtActive(now);
  emit(EVENTS.scheduleClock);
}

onHost(HOST.scheduleTick, tick);

onHost(HOST.scheduleEnded, async m => {
  const going = active.get(m.runId);
  if (!going) return;
  const text = await plainText(m.tail ?? '');
  const agent = going.schedule.what === WHAT.agent ? readResult(text) : null;
  if (agent && !m.stopped) endAgent(going, m.exitCode ?? null, agent);
  else end(going.run, going.schedule, { code: m.exitCode, stopped: m.stopped, error: m.error, summary: summaryOf(text), text });
});

/**
 * An agent's run ended with its result. A run refused something failed, whatever it says: what it was asked isn't done.
 * @param {ActiveRun} going
 * @param {number | null} code
 * @param {NonNullable<ReturnType<typeof readResult>>} agent
 */
function endAgent({ run, schedule }, code, agent) {
  const headline = agent.reply.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  const notice = schedule.replyInNotice ? noticeOf(agent.reply) : undefined;
  const how = agent.failed ? { error: agent.why, code } : { code, summary: summaryOf(headline) };
  end(run, schedule, { ...how, costUsd: agent.costUsd, notice: agent.failed ? undefined : notice, text: agent.reply });
}

/**
 * A run in a terminal ended; a terminal closed takes its run with it.
 * @param {Tab} tab
 * @param {{ code?: number | null, summary?: string, error?: string, sent?: boolean }} how
 * @param {string} [output]
 */
export function terminalRunEnded(tab, how, output) {
  const going = [...active.values()].find(a => a.tab === tab);
  if (!going) return;
  if (output !== undefined) send(PAGE.scheduleKeep, { runId: going.run.id, output });
  end(going.run, going.schedule, output === undefined ? how : { ...how, text: output });
}

on(EVENTS.tabClosed, tab => terminalRunEnded(tab, { error: 'Its terminal was closed.' }));

// A command ended: its output is on the screen a moment later, once commands.js has marked where it ended.
on(EVENTS.commandEnding, ({ tab, exitCode }) => {
  if (![...active.values()].some(a => a.tab === tab)) return;
  setTimeout(() => {
    const output = lastOutput(tab) ?? '';
    terminalRunEnded(tab, { code: exitCode, summary: summaryOf(output) }, output);
  });
});

/** A notification's click, or the notification center's: the id is the run's. */
onHost(HOST.focusTerminal, m => {
  const run = runs().find(r => r.id === m.id);
  if (run) emit(EVENTS.openSchedules, { scheduleId: run.scheduleId, runId: run.id });
});

/** At start: what was going when Termilly closed ended there, and what runs at start runs, once. */
export function initSchedules() {
  // Saved before schedules had some of what they have now.
  state.schedules.list = schedules().map(s => ({ ...newSchedule(s.id), ...s }));
  for (const run of runs()) {
    if (run.status !== RUN.running && run.status !== RUN.waiting) continue;
    run.status = RUN.failed;
    run.summary = CLOSED_WHILE_RUNNING;
  }
  tidyRuns();
  setTimeout(() => {
    for (const schedule of [...schedules()]) if (schedule.on && schedule.when.kind === WHEN.start) begin(schedule);
    tick();
  }, FIRST_LOOK_MS);
}
