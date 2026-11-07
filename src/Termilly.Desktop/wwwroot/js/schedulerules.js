// @ts-check
// What schedules go by, without the page: when one runs next, how that reads, and how a run is named and kept
// (js/schedules.js runs them, js/scheduleswindow.js edits them).

/** What a schedule runs. */
export const WHAT = Object.freeze({ command: 'command', snippet: 'snippet', agent: 'agent' });
/** Where it runs: a hidden shell here or on a server, a new terminal, or one that's open. */
export const WHERE = Object.freeze({ hidden: 'hidden', server: 'server', fresh: 'new', terminal: 'terminal' });
/** How its time is set. */
export const WHEN = Object.freeze({ time: 'time', every: 'every', start: 'start' });
/** What "every" counts in. */
export const UNIT = Object.freeze({ minutes: 'minutes', hours: 'hours' });
/** When it tells the user. */
export const NOTIFY = Object.freeze({ always: 'always', failed: 'failed', never: 'never' });
/** A run missed because the PC was off or asleep, or Termilly wasn't running. */
export const MISSED = Object.freeze({ run: 'run', skip: 'skip' });
/** What happens to a new terminal once it's done. */
export const AFTER = Object.freeze({ close: 'close', closeIfWorked: 'closeIfWorked', leave: 'leave' });
/** What to do with a terminal that's busy. */
export const BUSY = Object.freeze({ wait: 'wait', skip: 'skip', fresh: 'new' });
/** What to do when the terminal isn't open. */
export const CLOSED = Object.freeze({ open: 'open', skip: 'skip' });
/** How a run stands. Sent: typed into a terminal whose shell can't say how it ended. */
export const RUN = Object.freeze({
  waiting: 'waiting', running: 'running', worked: 'worked', failed: 'failed', stopped: 'stopped', missed: 'missed', skipped: 'skipped', sent: 'sent',
});

/**
 * What a run's status says.
 * @type {Readonly<Record<string, string>>}
 */
export const RUN_LABEL = Object.freeze({
  [RUN.waiting]: 'Waiting', [RUN.running]: 'Running', [RUN.worked]: 'Worked', [RUN.failed]: 'Failed', [RUN.stopped]: 'Stopped',
  [RUN.missed]: 'Missed', [RUN.skipped]: 'Skipped', [RUN.sent]: 'Sent',
});

/** A run due longer ago than this was missed: the clock ticks well within it, unless nothing was running. */
export const GRACE_MS = 120000;
/** How many of a schedule's runs are kept, whatever their age: one every minute shouldn't fill the saved state. */
const MAX_RUNS = 200;
/** The longest a summary gets. */
const MAX_SUMMARY = 180;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;
const DAY_MS = DAY_MINUTES * MINUTE_MS;
/** How far ahead to look: a schedule on one day of the week comes round in seven. */
const DAYS_AHEAD = 8;
/** Date's days, Sunday first, as the editor shows them from Monday. */
export const DAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const WHOLE_DAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]);
const DIGITS = 2;
/** What a new schedule starts with. */
const START = Object.freeze({ limitMinutes: 10, keepDays: 30 });

/**
 * Minutes into the day of "20:00", or null for anything else.
 * @param {string | null | undefined} text
 */
export function minutesOf(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const hours = Number(m[1]), minutes = Number(m[2]);
  return hours < DAY_MINUTES / HOUR_MINUTES && minutes < HOUR_MINUTES ? hours * HOUR_MINUTES + minutes : null;
}

/** @param {ScheduleWhen} when */
const stepOf = when => Math.max(1, Math.round(when.every)) * (when.unit === UNIT.hours ? HOUR_MINUTES : 1);

/**
 * The minutes of a day it runs at. "Every" counts from the start of its hours, or midnight, so 15 minutes lands on the
 * quarter; hours that end before they start go over midnight.
 * @param {ScheduleWhen} when
 * @returns {number[]}
 */
function slotsOf(when) {
  if (when.kind === WHEN.time) {
    const at = minutesOf(when.at);
    return at === null ? [] : [at];
  }
  const from = minutesOf(when.from) ?? 0;
  const to = minutesOf(when.to) ?? DAY_MINUTES - 1;
  const end = to < from ? to + DAY_MINUTES : to;
  const slots = [];
  for (let minute = from; minute <= end; minute += stepOf(when)) slots.push(minute);
  return slots;
}

/**
 * @param {ScheduleWhen} when
 * @param {Date} day
 */
const runsOn = (when, day) => !when.days?.length || when.days.includes(day.getDay());

/**
 * When it runs next after a moment, or null when no clock runs it.
 * @param {ScheduleWhen} when
 * @param {number} after
 * @returns {number | null}
 */
export function nextRun(when, after) {
  if (when.kind === WHEN.start) return null;
  const slots = slotsOf(when);
  const today = new Date(after);
  // From yesterday: its hours may reach past midnight.
  for (let ahead = -1; ahead < DAYS_AHEAD; ahead++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ahead);
    if (!runsOn(when, day)) continue;
    for (const minute of slots) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minute).getTime();
      if (at > after) return at;
    }
  }
  return null;
}

/** @param {number} n */
const twoDigits = n => String(n).padStart(DIGITS, '0');
/** @param {Date} d */
const clock = d => `${d.getHours()}:${twoDigits(d.getMinutes())}`;

/** @param {number[]} days */
function daysText(days) {
  if (!days.length || days.length === DAY_NAMES.length) return 'Every day';
  if (days.length === WEEKDAYS.length && WEEKDAYS.every(d => days.includes(d))) return 'Weekdays';
  if (days.length === 1) return `${WHOLE_DAYS[days[0]]}s`;
  return [...days].sort((a, b) => ((a || DAY_NAMES.length) - (b || DAY_NAMES.length))).map(d => DAY_NAMES[d]).join(', ');
}

/**
 * "Weekdays at 02:30", "Every 2 hours, 9:00 to 18:00", "When Termilly starts".
 * @param {ScheduleWhen} when
 */
export function describeWhen(when) {
  if (when.kind === WHEN.start) return 'When Termilly starts';
  const days = when.days ?? [];
  if (when.kind === WHEN.time) return `${daysText(days)} at ${when.at}`;
  const count = Math.max(1, Math.round(when.every));
  const each = count === 1 ? `Every ${when.unit === UNIT.hours ? 'hour' : 'minute'}` : `Every ${count} ${when.unit}`;
  const hours = when.from && when.to ? `, ${when.from} to ${when.to}` : '';
  return `${each}${hours}${days.length && days.length < DAY_NAMES.length ? `, ${daysText(days).toLowerCase()}` : ''}`;
}

/**
 * "today 20:00", "tomorrow 2:30", "Sat 20:00", "12 Nov 20:00".
 * @param {number | null | undefined} at
 * @param {number} now
 */
export function describeAt(at, now) {
  if (!at) return 'at the next start';
  const date = new Date(at);
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const days = Math.floor((at - midnight) / DAY_MS);
  if (days === 0) return `today ${clock(date)}`;
  if (days === 1) return `tomorrow ${clock(date)}`;
  if (days > 1 && days < DAY_NAMES.length) return `${DAY_NAMES[date.getDay()]} ${clock(date)}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock(date)}`;
}

/**
 * "48 s", "1 min 12 s", "2 h 5 min".
 * @param {number} ms
 */
export function describeTook(ms) {
  const seconds = Math.round(ms / SECOND_MS);
  if (seconds < HOUR_MINUTES) return `${seconds} s`;
  const minutes = Math.floor(seconds / HOUR_MINUTES);
  if (minutes < HOUR_MINUTES) return seconds % HOUR_MINUTES ? `${minutes} min ${seconds % HOUR_MINUTES} s` : `${minutes} min`;
  return minutes % HOUR_MINUTES ? `${Math.floor(minutes / HOUR_MINUTES)} h ${minutes % HOUR_MINUTES} min` : `${minutes / HOUR_MINUTES} h`;
}

/**
 * How a run ended.
 * @param {{ code?: number | null, stopped?: boolean, error?: string | null }} end
 */
export function statusOf({ code, stopped, error }) {
  if (error) return RUN.failed;
  if (stopped) return RUN.stopped;
  return code === 0 ? RUN.worked : RUN.failed;
}

/**
 * The line a run is known by: the last one with something on it, where programs say how it went.
 * @param {string} text
 */
export function summaryOf(text) {
  const line = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) ?? '';
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : line;
}

/**
 * Whether it should tell the user about a run.
 * @param {string} notify
 * @param {string} status
 */
export function shouldTell(notify, status) {
  if (notify === NOTIFY.never) return false;
  return notify === NOTIFY.always || (status !== RUN.worked && status !== RUN.sent);
}

/**
 * Runs that stay, and those whose time has passed: each schedule's within its days and count, and no others.
 * @param {ScheduleRunRecord[]} runs newest first
 * @param {Schedule[]} schedules
 * @param {number} now
 */
export function sortRuns(runs, schedules, now) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {ScheduleRunRecord[]} */
  const keep = [];
  /** @type {ScheduleRunRecord[]} */
  const gone = [];
  for (const run of runs) {
    const schedule = schedules.find(s => s.id === run.scheduleId);
    const count = (counts.get(run.scheduleId) ?? 0) + 1;
    counts.set(run.scheduleId, count);
    const fresh = !!schedule && now - run.at <= schedule.keepDays * DAY_MS && count <= MAX_RUNS;
    (fresh || run.status === RUN.running ? keep : gone).push(run);
  }
  return { keep, gone };
}

/**
 * A new schedule.
 * @param {string} id
 * @returns {Schedule}
 */
export function newSchedule(id) {
  return {
    id, name: '', on: true, what: WHAT.command, command: '', snippet: '', prompt: '', allowChanges: false, replyInNotice: true, where: WHERE.hidden, profile: null, cwd: '', wsId: null,
    terminal: '', after: AFTER.closeIfWorked, busy: BUSY.wait, closed: CLOSED.open,
    when: { kind: WHEN.time, at: '20:00', days: [], every: 1, unit: UNIT.hours, from: '', to: '' },
    missed: MISSED.run, notify: NOTIFY.failed, phone: false, nextAt: null, ...START,
  };
}
