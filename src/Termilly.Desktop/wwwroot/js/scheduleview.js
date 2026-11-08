// @ts-check
// What the Schedules window (js/scheduleswindow.js) shows: a row of its list, the form, and a schedule's runs.

import { escapeHtml } from './ui.js';
import {
  WHAT, WHERE, WHEN, UNIT, NOTIFY, MISSED, AFTER, BUSY, CLOSED, RUN, RUN_LABEL, DAY_NAMES, describeWhen, describeAt, describeTook,
} from './schedulerules.js';

/** How many of a schedule's last runs its row shows. */
const LAST_RUNS = 8;
/** The days in the form's order, Monday first (Date's numbers). */
const WEEK = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

/** What the form's segments are called (their data-seg), with each one's choices. */
const SEGMENTS = Object.freeze({
  what: [[WHAT.command, 'Command'], [WHAT.snippet, 'Snippet'], [WHAT.agent, 'Agent prompt']],
  where: [[WHERE.hidden, 'Out of sight'], [WHERE.server, 'On a server'], [WHERE.fresh, 'New terminal'], [WHERE.terminal, 'A terminal you have']],
  whenKind: [[WHEN.time, 'At a time'], [WHEN.every, 'Every'], [WHEN.start, 'When Termilly starts']],
  after: [[AFTER.close, 'Close it'], [AFTER.closeIfWorked, 'Close it if it worked'], [AFTER.leave, 'Leave it open']],
  busy: [[BUSY.wait, 'Wait for the prompt'], [BUSY.skip, 'Skip'], [BUSY.fresh, 'New terminal']],
  closed: [[CLOSED.open, 'Open it again'], [CLOSED.skip, 'Skip']],
  missed: [[MISSED.run, 'Run at the next start'], [MISSED.skip, 'Skip it']],
  notify: [[NOTIFY.always, 'Always'], [NOTIFY.failed, 'If it failed'], [NOTIFY.never, 'Never']],
});
/** The form's fields that belong to `when`: their name has this in front. */
export const WHEN_FIELD = 'when.';
export const WHEN_KIND_SEGMENT = 'whenKind';

/**
 * What the form picks from.
 * @typedef {{ shells: SessionProfile[], servers: SessionProfile[], workspaces: { id: string, name: string }[], snippets: string[] }} Choices
 */

/**
 * @param {string} name
 * @param {string} value
 */
function segmentHtml(name, value) {
  const choices = /** @type {Record<string, string[][]>} */ (SEGMENTS)[name];
  return `<span class="seg">${choices.map(([id, label]) =>
    `<button type="button" data-seg="${name}" data-value="${id}"${id === value ? ' class="on"' : ''}>${label}</button>`).join('')}</span>`;
}

/**
 * @param {string} name
 * @param {(readonly [string, string])[]} options
 * @param {string | null} value
 */
function selectHtml(name, options, value) {
  return `<select class="field" name="${name}">${options.map(([id, label]) =>
    `<option value="${escapeHtml(id)}"${id === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
}

/**
 * @param {string} label
 * @param {string} body
 */
const fieldHtml = (label, body) => `<div class="dialog-field">${label}${body}</div>`;

/**
 * @param {string} name
 * @param {string | number} value
 * @param {string} [placeholder]
 * @param {string} [type]
 */
const inputHtml = (name, value, placeholder = '', type = 'text') =>
  `<input class="field" name="${name}" type="${type}" value="${escapeHtml(String(value))}" placeholder="${escapeHtml(placeholder)}" spellcheck="false" autocomplete="off">`;

/** @param {SessionProfile[]} profiles */
const profileOptions = profiles => profiles.map(p => /** @type {const} */ ([p.id, p.name]));

/** @param {Schedule} s */
const agentHtml = s => `<textarea class="field snippet-command sch-prompt" name="prompt" rows="5" spellcheck="false" placeholder="Summarize what changed in this repository today">${escapeHtml(s.prompt)}</textarea>
  <label class="note-pin"><input type="checkbox" name="allowChanges"${s.allowChanges ? ' checked' : ''}> Let it change files</label>
  <p class="dialog-sub${s.allowChanges ? ' sch-warn' : ''}">${s.allowChanges
    ? 'With nobody watching, it edits files without asking, and runs the commands your Claude Code settings allow. Anything else it asks for fails the run.'
    : 'Read only: it can read files in its folder and fetch pages, but can’t change files or run commands. Your Claude Code settings aren’t used.'}</p>
  <label class="note-pin"><input type="checkbox" name="replyInNotice"${s.replyInNotice ? ' checked' : ''}> Put its reply in the notification</label>`;

/**
 * @param {Schedule} s
 * @param {Choices} choices
 */
function whatHtml(s, choices) {
  if (s.what === WHAT.agent) return `<h3 class="sch-head">What it runs</h3>${segmentHtml('what', s.what)}${agentHtml(s)}`;
  const body = s.what === WHAT.command
    ? `<textarea class="field snippet-command" name="command" rows="3" spellcheck="false" placeholder="git pull && npm test">${escapeHtml(s.command)}</textarea>`
    : choices.snippets.length
      ? selectHtml(WHAT.snippet, choices.snippets.map(n => /** @type {const} */ ([n, n])), s.snippet || choices.snippets[0])
      : '<p class="dialog-sub">No snippets yet. Make one in the Snippets window.</p>';
  return `<h3 class="sch-head">What it runs</h3>${segmentHtml('what', s.what)}${body}
    ${s.what === WHAT.snippet ? '<p class="dialog-sub">Its placeholders run with their defaults.</p>' : ''}`;
}

/**
 * The part of "where" that depends on the choice.
 * @param {Schedule} s
 * @param {Choices} choices
 */
function placeHtml(s, choices) {
  const folder = fieldHtml('Folder', inputHtml('cwd', s.cwd, 'The home folder'));
  const shell = fieldHtml('Shell', selectHtml('profile', profileOptions(choices.shells), s.profile));
  if (s.where === WHERE.hidden) return `${shell}${folder}<p class="dialog-sub">A shell nobody sees runs it and closes. What it prints is kept as a report.</p>`;
  if (s.where === WHERE.server) {
    if (!choices.servers.length) return '<p class="dialog-sub">No SSH hosts yet. Add one under Remote.</p>';
    return `${fieldHtml('Server', selectHtml('profile', profileOptions(choices.servers), s.profile))}
      ${fieldHtml('Folder on the server', inputHtml('cwd', s.cwd, 'Where the connection starts'))}
      <p class="dialog-sub">It can’t stop to ask: a server that wants a password or a new host key fails the run.</p>`;
  }
  if (s.where === WHERE.fresh) {
    const places = choices.workspaces.map(w => /** @type {const} */ ([w.id, w.name]));
    return `${fieldHtml('Workspace', selectHtml('wsId', places, s.wsId))}${shell}${folder}${fieldHtml('Afterwards', segmentHtml('after', s.after))}`;
  }
  return `${fieldHtml('Terminal', inputHtml('terminal', s.terminal, 'Its name, or a #tag'))}
    ${fieldHtml('If it’s busy', segmentHtml('busy', s.busy))}${fieldHtml('If it’s closed', segmentHtml('closed', s.closed))}`;
}

/** @param {Schedule} s */
function daysHtml(s) {
  const on = s.when.days ?? [];
  return `<span class="seg sch-days">${WEEK.map(day =>
    `<button type="button" data-day="${day}"${on.includes(day) ? ' class="on"' : ''}>${DAY_NAMES[day]}</button>`).join('')}</span>
    <p class="dialog-sub">No day picked means every day.</p>`;
}

/** @param {Schedule} s */
function whenHtml(s) {
  const { when } = s;
  const units = [[UNIT.minutes, 'minutes'], [UNIT.hours, 'hours']].map(([id, label]) => /** @type {const} */ ([id, label]));
  const missed = fieldHtml('If it was missed', `${segmentHtml('missed', s.missed)}<p class="dialog-sub">Termilly wasn’t running at its time. Several missed runs run once.</p>`);
  const body = when.kind === WHEN.time ? `${fieldHtml('Time', inputHtml('when.at', when.at, '20:00'))}${daysHtml(s)}${missed}`
    : when.kind === WHEN.every ? `<div class="sch-row">${fieldHtml('Every', inputHtml('when.every', when.every, '1', 'number'))}${fieldHtml('Unit', selectHtml('when.unit', units, when.unit))}
        ${fieldHtml('From', inputHtml('when.from', when.from, '9:00'))}${fieldHtml('To', inputHtml('when.to', when.to, '18:00'))}</div>${daysHtml(s)}${missed}`
      : '';
  return `<h3 class="sch-head">When</h3>${segmentHtml(WHEN_KIND_SEGMENT, when.kind)}${body}`;
}

/**
 * Where else each report goes.
 * @param {Schedule} s
 */
const keepHtml = s => `<label class="note-pin"><input type="checkbox" name="toNotepad"${s.toNotepad ? ' checked' : ''}> Add each report to the top of a Notepad page</label>
  ${s.toNotepad ? fieldHtml('Notepad page', inputHtml('notepadPage', s.notepadPage, 'Reports')) : ''}
  <label class="note-pin"><input type="checkbox" name="toFile"${s.toFile ? ' checked' : ''}> Save each report to a file</label>
  ${s.toFile ? `${fieldHtml('File', inputHtml('file', s.file, 'reports/{name}-{date}.md'))}
    <p class="dialog-sub"><code>{date}</code>, <code>{time}</code> and <code>{name}</code> are filled in. A name without a folder goes in Documents\\Termilly. A file that’s there gets the report at its end.</p>` : ''}`;

/** @param {Schedule} s */
const afterHtml = s => `<h3 class="sch-head">After it runs</h3>
  <div class="sch-row">${fieldHtml('Stop it after (minutes)', inputHtml('limitMinutes', s.limitMinutes, '10', 'number'))}${fieldHtml('Keep reports (days)', inputHtml('keepDays', s.keepDays, '30', 'number'))}</div>
  ${fieldHtml('Notify me', segmentHtml('notify', s.notify))}
  <label class="note-pin"><input type="checkbox" name="phone"${s.phone ? ' checked' : ''}> On my phone too</label>
  ${keepHtml(s)}`;

/**
 * The form.
 * @param {Schedule} s
 * @param {Choices} choices
 * @param {string} problem what stops it being saved
 * @param {string} next when it runs next, as it stands
 * @param {{ isNew: boolean, dirty: boolean }} now
 */
export function formHtml(s, choices, problem, next, { isNew, dirty }) {
  return `<label class="dialog-field">Name<input class="field" name="name" value="${escapeHtml(s.name)}" placeholder="Back up the database" spellcheck="false"></label>
    ${whatHtml(s, choices)}
    <h3 class="sch-head">Where</h3>${segmentHtml('where', s.where)}${placeHtml(s, choices)}
    ${whenHtml(s)}
    ${afterHtml(s)}
    <div class="sch-foot">
      <p class="dialog-sub sch-next">${escapeHtml(next)}</p>
      <p class="dialog-sub sch-problem">${escapeHtml(problem)}</p>
      <div class="dialog-actions">
        <button class="btn" data-sch="delete">${isNew ? 'Discard' : 'Delete'}</button>
        <span class="spacer"></span>
        <button class="btn" data-sch="save" title="Save (Ctrl+S)"${dirty && !problem ? '' : ' disabled'}>Save</button>
        <button class="btn primary" data-sch="run"${isNew || dirty ? ' disabled title="Save the changes first"' : ''}>Run now</button>
      </div>
    </div>`;
}

/**
 * The little squares of its last runs, oldest first.
 * @param {ScheduleRunRecord[]} runs newest first
 */
const squaresHtml = runs => `<span class="sch-squares">${runs.slice(0, LAST_RUNS).reverse().map(r =>
  `<i class="sch-square ${escapeHtml(r.status)}" title="${escapeHtml(RUN_LABEL[r.status])}"></i>`).join('')}</span>`;

/**
 * A row of the list.
 * @param {Schedule} s
 * @param {ScheduleRunRecord[]} runs
 * @param {{ selected: boolean, now: number }} state
 */
export function rowHtml(s, runs, { selected, now }) {
  const next = !s.on ? 'Turned off' : s.when.kind === WHEN.start ? describeWhen(s.when) : `Next: ${describeAt(s.nextAt, now)}`;
  return `<div class="sw-row${selected ? ' selected' : ''}${s.on ? '' : ' sch-off'}" role="option" data-id="${escapeHtml(s.id)}" aria-selected="${selected}">
    <span class="sw-name">${escapeHtml(s.name || 'New schedule')}</span>
    <span class="sw-cmd">${escapeHtml(next)}</span>${squaresHtml(runs)}</div>`;
}

/** @param {number} at */
function whenItRan(at) {
  const d = new Date(at);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * A schedule's runs, newest first.
 * @param {ScheduleRunRecord[]} runs
 * @param {string | null} open the run shown
 */
export function runsHtml(runs, open) {
  if (!runs.length) return '<p class="set-desc sw-none">No runs yet.</p>';
  return `<div class="sch-runs">${runs.map(r => `<button class="sch-run${r.id === open ? ' selected' : ''}" data-run="${escapeHtml(r.id)}">
    <i class="sch-square ${escapeHtml(r.status)}"></i><span class="sch-run-when">${escapeHtml(whenItRan(r.at))}</span>
    <span class="sch-run-status">${escapeHtml(RUN_LABEL[r.status])}${r.ms ? `, ${escapeHtml(describeTook(r.ms))}` : ''}</span>
    <span class="sch-run-text">${escapeHtml(r.summary)}</span></button>`).join('')}</div>`;
}

/**
 * A run's report.
 * @param {ScheduleRunRecord} run
 * @param {string | null} text its output; null with none kept
 */
export function reportHtml(run, text) {
  const going = run.status === RUN.running || run.status === RUN.waiting;
  const empty = going ? 'It’s still running.' : 'No output was kept for this run.';
  return `<div class="sch-report">
    <div class="sch-report-head">
      <span class="sch-report-title">${escapeHtml(RUN_LABEL[run.status])}${run.code === null ? '' : `, exit code ${run.code}`}${run.costUsd ? `, $${run.costUsd.toFixed(2)}` : ''}</span>
      <span class="spacer"></span>
      ${going ? `<button class="btn small" data-sch="stop">Stop</button>` : ''}
      ${text === null ? '' : `<button class="btn small" data-sch="copy">Copy</button><button class="btn small" data-sch="terminal">Open as a terminal</button>`}
      <button class="btn small" data-sch="run">Run again</button>
    </div>
    ${run.summary && run.status !== RUN.worked ? `<p class="sch-why">${escapeHtml(run.summary)}</p>` : ''}
    ${run.file ? `<p class="dialog-sub sch-saved">Saved to <button class="link" data-sch="file" title="Show it in its folder">${escapeHtml(run.file)}</button></p>` : ''}
    ${run.fileError ? `<p class="sch-why">Couldn’t save it to a file: ${escapeHtml(run.fileError)}</p>` : ''}
    ${text === null ? `<p class="set-desc">${empty}</p>` : `<pre class="sch-output">${escapeHtml(text)}</pre>`}
  </div>`;
}
