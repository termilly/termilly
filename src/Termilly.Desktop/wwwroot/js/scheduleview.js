// @ts-check
// What the Schedules window (js/scheduleswindow.js) shows: a row of its list, the form, and a schedule's runs.

import { escapeHtml } from './ui.js';
import { installedAgents } from './store.js';
import { agentKind } from './agentkinds.js';
import { AGENT_KIND } from './constants.js';
import { reportTextHtml } from './schedulelinks.js';
import { reviewersFor, namesOf, fitPlan } from './todoplan.js';
import { planRowsHtml } from './planrows.js';
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
/** The box for "every" all day long; unticked, From and To show. It's the form's, not the schedule's: all day is no hours. */
export const ALL_DAY_FIELD = 'allDay';

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

/**
 * What a run may do, as its boxes say. Nobody is asked: what it may not do is refused, and the run goes on.
 * @param {Schedule} s
 */
function permissionsText(s) {
  if (s.agent === AGENT_KIND.codex) {
    if (!s.allowChanges) return 'Read only: it can read files and run commands that only look, in Codex’s read-only sandbox. It can’t change anything.';
    if (s.allowAll) return 'Silent. No sandbox and no permission checks. It can run any command and change any file. Use only for prompts and folders you trust.';
    return 'Silent. It edits files and runs commands in Codex’s sandbox, inside this folder only. Anything else is refused and it carries on.';
  }
  if (!s.allowChanges) return 'Read only: it can read files in its folder and fetch pages, but can’t change files or run commands. Your Claude Code settings aren’t used.';
  if (s.allowAll) return 'Silent. No permission checks. It can run any command, change any file and use any tool. Use only for prompts and folders you trust.';
  return 'Silent. It edits files. Safe commands run, risky ones are refused and it carries on. Your Claude Code settings still apply.';
}

/**
 * The plan a schedule's agent prompt runs with: who runs it, who reviews it and for how many rounds at most, among the agents
 * installed.
 * @param {Schedule} s
 */
export const planOf = s => fitPlan({ by: s.agent ?? AGENT_KIND.claude, reviewers: s.reviewers ?? [], rounds: s.rounds }, installedAgents());

/**
 * What a schedule's review does, under its rounds.
 * @param {Schedule} s
 * @returns {(plan: import('./todoplan.js').ImplementPlan) => string}
 */
const reviewHint = s => plan => {
  const many = plan.reviewers.length > 1;
  const by = agentKind(plan.by).name;
  const back = s.allowChanges ? `goes back to ${by} to fix` : `goes back to ${by}, which corrects its answer`;
  const again = plan.rounds > 1 ? `, and ${many ? 'they look' : 'it looks'} again, ${plan.rounds} rounds at most` : '';
  return `What ${namesOf(plan.reviewers)} ${many ? 'find' : 'finds'} ${back}${again}. The report has their verdict. Each agent’s run gets the time below.`;
};

/**
 * Who runs the prompt and which agents review what it did, for how many rounds at most, picked as To do's Implement card has
 * them (js/planrows.js). Reviewers run only out of sight.
 * @param {Schedule} s
 */
function planHtml(s) {
  const plan = planOf(s);
  const agents = installedAgents();
  const hidden = s.where === WHERE.hidden;
  const note = !hidden && reviewersFor(plan.by, agents).length ? '<p class="dialog-sub">Other agents can review what it did when it runs out of sight.</p>' : '';
  return `<div class="sch-plan">${planRowsHtml(plan, { agents, reviewers: agents, hint: reviewHint(s) }, { review: hidden })}</div>${note}`;
}

/** @param {Schedule} s */
const agentHtml = s => `<textarea class="field snippet-command sch-prompt" name="prompt" rows="5" spellcheck="false" placeholder="Summarize what changed in this repository today">${escapeHtml(s.prompt)}</textarea>
  ${planHtml(s)}
  <label class="note-pin"><input type="checkbox" name="allowChanges"${s.allowChanges ? ' checked' : ''}> Let it change files</label>
  ${s.allowChanges ? `<label class="note-pin"><input type="checkbox" name="allowAll"${s.allowAll ? ' checked' : ''}> Allow everything</label>` : ''}
  <p class="dialog-sub${s.allowChanges ? ' sch-warn' : ''}">${permissionsText(s)}</p>
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
  const folder = fieldHtml('Folder', `<span class="field-row">${inputHtml('cwd', s.cwd, 'The home folder')}<button type="button" class="btn" data-sch="browse">Browse</button></span>`);
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

/**
 * @param {Schedule} s
 * @param {boolean} allDay whether "every" runs all day, or between From and To
 */
function hoursHtml(s, allDay) {
  const box = `<label class="note-pin"><input type="checkbox" name="${ALL_DAY_FIELD}"${allDay ? ' checked' : ''}> All day</label>`;
  return allDay ? box : `${box}<div class="sch-row">${fieldHtml('From', inputHtml('when.from', s.when.from, '9:00'))}${fieldHtml('To', inputHtml('when.to', s.when.to, '18:00'))}</div>`;
}

/**
 * @param {Schedule} s
 * @param {boolean} allDay
 */
function whenHtml(s, allDay) {
  const { when } = s;
  const units = [[UNIT.minutes, 'minutes'], [UNIT.hours, 'hours']].map(([id, label]) => /** @type {const} */ ([id, label]));
  const missed = fieldHtml('If it was missed', `${segmentHtml('missed', s.missed)}<p class="dialog-sub">Termilly wasn’t running at its time. Several missed runs run once.</p>`);
  const body = when.kind === WHEN.time ? `${fieldHtml('Time', inputHtml('when.at', when.at, '20:00'))}${daysHtml(s)}${missed}`
    : when.kind === WHEN.every ? `<div class="sch-row">${fieldHtml('Every', inputHtml('when.every', when.every, '1', 'number'))}${fieldHtml('Unit', selectHtml('when.unit', units, when.unit))}</div>
        ${hoursHtml(s, allDay)}${daysHtml(s)}${missed}`
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
 * @param {{ isNew: boolean, dirty: boolean, allDay: boolean }} now
 */
export function formHtml(s, choices, problem, next, { isNew, dirty, allDay }) {
  return `<label class="dialog-field">Name<input class="field" name="name" value="${escapeHtml(s.name)}" placeholder="Back up the database" spellcheck="false"></label>
    ${whatHtml(s, choices)}
    <h3 class="sch-head">Where</h3>${segmentHtml('where', s.where)}${placeHtml(s, choices)}
    ${whenHtml(s, allDay)}
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
    ${run.summary && run.status !== RUN.worked ? `<p class="sch-why">${reportTextHtml(run.summary)}</p>` : ''}
    ${run.file ? `<p class="dialog-sub sch-saved">Saved to <button class="link" data-sch="file" title="Show it in its folder">${escapeHtml(run.file)}</button></p>` : ''}
    ${run.fileError ? `<p class="sch-why">Couldn’t save it to a file: ${escapeHtml(run.fileError)}</p>` : ''}
    ${text === null ? `<p class="set-desc">${empty}</p>` : `<pre class="sch-output">${reportTextHtml(text)}</pre>`}
  </div>`;
}
