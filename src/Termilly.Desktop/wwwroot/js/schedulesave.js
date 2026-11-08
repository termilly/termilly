// @ts-check
// A run's report kept where the schedule says, besides its own record: added to the top of a Notepad page, and to a file. The
// app writes the file (Features/Schedules.cs); a name with no folder goes in Documents\Termilly.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, emit, EVENTS } from './store.js';
import { addToPage } from './notepad.js';
import { reportHeading, fileFor, RUN } from './schedulerules.js';

/** Runs that have something to keep. A missed or skipped run never ran. */
/** @type {Set<string>} */
const RAN = new Set([RUN.worked, RUN.failed, RUN.stopped, RUN.sent]);

/**
 * Keeps a run's report where its schedule asks.
 * @param {Schedule} schedule
 * @param {ScheduleRunRecord} run
 * @param {string} text the output as text, or an agent's reply
 */
export function saveReport(schedule, run, text) {
  if (!RAN.has(run.status) || (!schedule.toNotepad && !schedule.toFile)) return;
  const report = `${reportHeading(run.name, run.at, run.status)}\n\n${text.trim() || run.summary || '(no output)'}\n`;
  if (schedule.toNotepad && schedule.notepadPage.trim()) addToPage(schedule.notepadPage.trim(), report);
  if (schedule.toFile && schedule.file.trim()) send(PAGE.scheduleSaveFile, { runId: run.id, path: fileFor(schedule.file.trim(), run.at, run.name), text: report });
}

// Where the file went, or why it didn't: the run's report says so.
onHost(HOST.scheduleFileSaved, m => {
  const run = state.schedules.runs.find(r => r.id === m.runId);
  if (!run) return;
  run.file = m.error ? null : m.path ?? null;
  run.fileError = m.error ?? null;
  emit(EVENTS.schedules);
});
