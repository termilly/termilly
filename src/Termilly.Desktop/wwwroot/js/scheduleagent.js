// @ts-check
// Schedules and agents: what the MCP tools list_schedules, add_schedule, edit_schedule, delete_schedule, run_schedule and
// set_schedule can do. Any agent
// may list them; the host lets the others through only with Settings › Terminal › Let scripts and agents type on, as
// they make something run. A schedule an agent adds runs out of sight, and an agent prompt in it only reads files: the
// user can allow more in the Schedules window.

import { state, newId, lastFolderOf, installedAgents } from './store.js';
import { addApiMethods } from './api.js';
import { schedules, scheduleById, runsOf, saveSchedule, removeSchedule, runNow, setScheduleOn } from './schedules.js';
import { newSchedule, describeWhen, describeAt, reachesProduction, WHAT, WHERE, WHEN, UNIT, DAY_NAMES, minutesOf } from './schedulerules.js';
import { AGENT_KIND } from './constants.js';
import { reviewersOf } from './schedulereview.js';
import { allSnippets, missingValues, filled } from './snippets.js';

/**
 * The agent an agent prompt names, among those installed: Claude Code when it names none (or the first installed without it).
 * @param {unknown} asked
 */
function agentOf(asked) {
  const installed = installedAgents();
  const kind = String(asked ?? '').trim().toLowerCase();
  if (!kind) return installed.includes(AGENT_KIND.claude) ? AGENT_KIND.claude : installed[0] ?? AGENT_KIND.claude;
  if (!installed.includes(kind)) throw new Error(`There's no agent "${kind}" here. Installed: ${installed.join(', ') || 'none'}.`);
  return kind;
}

/** A schedule's id, as the UI makes them. */
const ID_PREFIX = 's';
/** How much of a day's name is read: Mon of Monday. */
const DAY_LETTERS = 3;

/**
 * A schedule for an agent: what it runs, when, its next run and how its last one ended.
 * @param {Schedule} s
 */
function describeSchedule(s) {
  const last = runsOf(s.id).sort((a, b) => b.at - a.at)[0];
  return {
    id: s.id, name: s.name, on: s.on, what: s.what,
    runs: s.what === WHAT.agent ? s.prompt : s.what === WHAT.snippet ? s.snippet : s.command,
    ...(s.what === WHAT.agent ? { agent: s.agent ?? AGENT_KIND.claude, reviewers: reviewersOf(s) } : {}),
    ...(s.what === WHAT.snippet ? { vars: s.values ?? {} } : {}),
    when: describeWhen(s.when), next: s.on ? describeAt(s.nextAt, Date.now()) : null,
    last: last ? { status: last.status, at: new Date(last.at).toISOString(), summary: last.summary } : null,
  };
}

/** @param {any} args */
function scheduleFor(args) {
  const schedule = scheduleById(String(args.schedule ?? ''));
  if (!schedule) throw new Error(`There's no schedule ${args.schedule}. list_schedules shows them.`);
  return schedule;
}

/**
 * Day names ("Mon,Wed,Fri") as Date's day numbers; none for every day.
 * @param {unknown} days
 */
function dayNumbers(days) {
  const names = String(days ?? '').split(',').map(d => d.trim().slice(0, DAY_LETTERS).toLowerCase()).filter(Boolean);
  return names.map(name => {
    const n = DAY_NAMES.findIndex(d => d.toLowerCase() === name);
    if (n < 0) throw new Error(`"${name}" isn't a day: use Mon, Tue, Wed, Thu, Fri, Sat, Sun.`);
    return n;
  });
}

/**
 * When a schedule runs: when Termilly starts, every so often, or at a time of day. What it doesn't say comes from base.
 * @param {any} args
 * @param {ScheduleWhen} [base]
 * @returns {ScheduleWhen}
 */
function whenOf(args, base = newSchedule('').when) {
  const days = dayNumbers(args.days);
  if (args.on_start) return { ...base, kind: WHEN.start };
  if (args.every) {
    const every = Math.max(1, Math.round(Number(args.every)));
    const unit = args.unit === UNIT.minutes ? UNIT.minutes : UNIT.hours;
    return { ...base, kind: WHEN.every, every, unit, days };
  }
  const at = String(args.at ?? '').trim();
  if (!at || minutesOf(at) === null) throw new Error('Say when it runs: at (20:00), every with unit, or on_start.');
  return { ...base, kind: WHEN.time, at, days };
}

/**
 * A snippet's values as an agent gave them (vars): text by placeholder name, the empty ones left out so their default counts.
 * @param {unknown} vars
 * @returns {Record<string, string>}
 */
function valuesOf(vars) {
  if (vars == null) return {};
  if (typeof vars !== 'object' || Array.isArray(vars)) throw new Error('vars should be an object: { "name": "value" }.');
  return filled(Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, String(value ?? '')])));
}

/**
 * What a new schedule runs: a command, one of the user's snippets, or an agent's prompt (which only reads files).
 * @param {any} args
 */
function whatOf(args) {
  const what = args.what === WHAT.snippet || args.what === WHAT.agent ? args.what : WHAT.command;
  if (args.vars != null && what !== WHAT.snippet) throw new Error('vars are for what = snippet.');
  if (what === WHAT.snippet) {
    const snippet = allSnippets().find(sn => sn.name === String(args.snippet ?? ''));
    if (!snippet) throw new Error(`There's no snippet "${args.snippet}". list_snippets shows them.`);
    const values = valuesOf(args.vars);
    const missing = missingValues(snippet.command, values);
    if (missing.length) throw new Error(`The snippet needs values for: ${missing.join(', ')}. Give them in vars.`);
    return { what, snippet: snippet.name, values };
  }
  if (what === WHAT.agent) {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) throw new Error('An agent schedule needs its prompt.');
    return { what, prompt, agent: agentOf(args.agent), values: undefined, ...READ_ONLY };
  }
  const command = String(args.command ?? '').trim();
  if (!command) throw new Error('A command schedule needs its command.');
  return { what, command, values: undefined };
}

/**
 * Adds the schedule an agent was asked to make, in its terminal's folder unless it says another.
 * @param {any} args
 */
function addSchedule(args) {
  const name = String(args.name ?? '').trim();
  if (!name) throw new Error('A schedule needs a name.');
  const tab = args.from ? state.tabs.get(args.from) : null;
  const schedule = { ...newSchedule(newId(ID_PREFIX)), name, ...whatOf(args), when: whenOf(args), cwd: String(args.cwd ?? '') || (tab ? lastFolderOf(tab) ?? '' : ''), on: args.on !== false };
  saveSchedule(schedule);
  return describeSchedule(/** @type {Schedule} */ (scheduleById(schedule.id)));
}

/** The arguments that pick a kind of when: at, every or on_start. Given, the old kind's own fields don't carry over. */
const WHEN_KIND_FIELDS = ['at', 'every', 'on_start'];
/** The arguments that say what a schedule runs, and when. */
const WHAT_FIELDS = ['what', 'command', 'snippet', 'vars', 'prompt', 'agent'];
const WHEN_FIELDS = [...WHEN_KIND_FIELDS, 'days', 'unit'];
/** What a changed prompt, agent or folder makes of what the user allowed an agent schedule: reading files only. */
const READ_ONLY = Object.freeze({ allowChanges: false, allowAll: false });

/**
 * The arguments among fields that were given.
 * @param {any} args
 * @param {string[]} fields
 * @returns {Record<string, unknown>}
 */
const given = (args, fields) => Object.fromEntries(fields.filter(k => args[k] != null).map(k => [k, args[k]]));

/**
 * A schedule's when as add_schedule's arguments, so an edit can change part of it.
 * @param {ScheduleWhen} when
 */
function whenArgsOf(when) {
  const days = when.days.map(d => DAY_NAMES[d]).join(',');
  if (when.kind === WHEN.start) return { on_start: true, days };
  if (when.kind === WHEN.every) return { every: when.every, unit: when.unit, days };
  return { at: when.at, days };
}

/**
 * What an edit makes of a schedule's what: a changed agent prompt or agent only reads files again, as a new one does, so an
 * agent can't change what a schedule the user allowed more does.
 * @param {Schedule} schedule
 * @param {Record<string, unknown>} changed
 */
function editedWhat(schedule, changed) {
  const { what, command, snippet, prompt } = schedule;
  // Its values stay unless the edit gives new ones, picks another snippet (they were the old one's) or runs something else.
  const keeps = (changed.what ?? what) === WHAT.snippet && (changed.snippet == null || changed.snippet === snippet);
  const vars = keeps ? schedule.values : null;
  const edited = whatOf({ what, command, snippet, prompt, vars, ...changed });
  // Its agent stays as it was unless the edit names one, even one no longer installed.
  return edited.what === WHAT.agent && !('agent' in changed) && schedule.agent ? { ...edited, agent: schedule.agent } : edited;
}

/**
 * What an edit makes of a schedule's when: a new kind (at, every or on_start: true) starts afresh, keeping only its days
 * and unit. on_start: false alone keeps a time or a repeat as it is.
 * @param {ScheduleWhen} when
 * @param {Record<string, unknown>} changed
 */
function editedWhen(when, changed) {
  const newKind = WHEN_KIND_FIELDS.some(k => k in changed && changed[k] !== false);
  const kept = newKind ? { days: whenArgsOf(when).days, unit: when.unit } : whenArgsOf(when);
  return whenOf({ ...kept, ...changed }, when);
}

/**
 * Refuses to change what a schedule runs, or where, when the user said yes to it with nobody watching: one on production,
 * or one that types into a terminal (which terminal it finds is only known when it runs, and it may be production then).
 * An agent asking now can't ask the user the same.
 * @param {Schedule} schedule
 */
function refuseUnwatched(schedule) {
  const where = schedule.where === WHERE.terminal ? 'types into a terminal' : reachesProduction(schedule, [...state.tabs.values()], state.profiles) ? 'runs on production' : null;
  if (where) throw new Error(`${schedule.name} ${where}: the user changes what it runs, or where, in the Schedules window.`);
}

/**
 * Changes what an agent was asked to of a schedule; what it leaves out stays.
 * @param {any} args
 */
function editSchedule(args) {
  const schedule = scheduleFor(args);
  const whatChanged = given(args, WHAT_FIELDS);
  const whenChanged = given(args, WHEN_FIELDS);
  /** @type {Partial<Schedule>} */
  const changes = {};
  if (args.name != null) {
    changes.name = String(args.name).trim();
    if (!changes.name) throw new Error('A schedule needs a name.');
  }
  if (Object.keys(whatChanged).length || args.cwd != null) refuseUnwatched(schedule);
  if (Object.keys(whatChanged).length) Object.assign(changes, editedWhat(schedule, whatChanged));
  if (Object.keys(whenChanged).length) changes.when = editedWhen(schedule.when, whenChanged);
  if (args.cwd != null) Object.assign(changes, { cwd: String(args.cwd), ...READ_ONLY });
  if (args.on != null) changes.on = args.on !== false;
  if (!Object.keys(changes).length) throw new Error('Say what to change: name, what it runs, when, cwd or on.');
  saveSchedule({ ...schedule, ...changes });
  return describeSchedule(/** @type {Schedule} */ (scheduleById(schedule.id)));
}

addApiMethods({
  schedules: () => ({ schedules: schedules().map(describeSchedule) }),
  schedule_add: args => addSchedule(args),
  schedule_edit: args => editSchedule(args),
  schedule_delete: args => {
    const schedule = scheduleFor(args);
    removeSchedule(schedule.id);
    return { deleted: schedule.id, name: schedule.name };
  },
  schedule_run: args => {
    const schedule = scheduleFor(args);
    runNow(schedule.id);
    return { ...describeSchedule(schedule), note: 'It runs now. list_schedules shows how it ended.' };
  },
  schedule_set: args => {
    const schedule = scheduleFor(args);
    setScheduleOn(schedule.id, args.on !== false);
    return describeSchedule(/** @type {Schedule} */ (scheduleById(schedule.id)));
  },
});
