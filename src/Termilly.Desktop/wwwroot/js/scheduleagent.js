// @ts-check
// Schedules and agents: what the MCP tools list_schedules, add_schedule, run_schedule and set_schedule can do. Any agent
// may list them; the host lets the others through only with Settings › Terminal › Let scripts and agents type on, as
// they make something run. A schedule an agent adds runs out of sight, and an agent prompt in it only reads files: the
// user can allow more in the Schedules window.

import { state, newId, lastFolderOf, installedAgents } from './store.js';
import { addApiMethods } from './api.js';
import { schedules, scheduleById, runsOf, saveSchedule, runNow, setScheduleOn } from './schedules.js';
import { newSchedule, describeWhen, describeAt, WHAT, WHEN, UNIT, DAY_NAMES, minutesOf } from './schedulerules.js';
import { AGENT_KIND } from './constants.js';
import { reviewersOf } from './schedulereview.js';
import { allSnippets } from './snippets.js';

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
 * When a new schedule runs: when Termilly starts, every so often, or at a time of day.
 * @param {any} args
 * @returns {ScheduleWhen}
 */
function whenOf(args) {
  const base = newSchedule('').when;
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
 * What a new schedule runs: a command, one of the user's snippets, or an agent's prompt (which only reads files).
 * @param {any} args
 */
function whatOf(args) {
  const what = args.what === WHAT.snippet || args.what === WHAT.agent ? args.what : WHAT.command;
  if (what === WHAT.snippet) {
    if (!allSnippets().some(sn => sn.name === String(args.snippet ?? ''))) throw new Error(`There's no snippet "${args.snippet}". list_snippets shows them.`);
    return { what, snippet: String(args.snippet) };
  }
  if (what === WHAT.agent) {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) throw new Error('An agent schedule needs its prompt.');
    return { what, prompt, agent: agentOf(args.agent), allowChanges: false, allowAll: false };
  }
  const command = String(args.command ?? '').trim();
  if (!command) throw new Error('A command schedule needs its command.');
  return { what, command };
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

addApiMethods({
  schedules: () => ({ schedules: schedules().map(describeSchedule) }),
  schedule_add: args => addSchedule(args),
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
