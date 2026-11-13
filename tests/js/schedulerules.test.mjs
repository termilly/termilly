// Tests for schedulerules.js: when a schedule runs next, how that reads, and what's kept of its runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextRun, minutesOf, describeWhen, describeAt, describeTook, statusOf, summaryOf, shouldTell, sortRuns, newSchedule, RUN, WHEN, UNIT, NOTIFY,
} from '../../src/Termilly.Desktop/wwwroot/js/schedulerules.js';

/** Thursday 5 November 2026. @param {number} hour @param {number} [minute] @param {number} [day] */
const at = (hour, minute = 0, day = 5) => new Date(2026, 10, day, hour, minute).getTime();
const time = (text, days = []) => ({ kind: WHEN.time, at: text, days, every: 1, unit: UNIT.hours, from: '', to: '' });
const every = (count, unit, extra = {}) => ({ kind: WHEN.every, at: '', days: [], every: count, unit, from: '', to: '', ...extra });

test('a time reads as minutes into the day, and nothing else does', () => {
  assert.equal(minutesOf('20:00'), 1200);
  assert.equal(minutesOf('2:30'), 150);
  for (const bad of ['24:00', '12:60', 'noon', '', null]) assert.equal(minutesOf(bad), null, String(bad));
});

test('a time later today runs today, one gone by runs tomorrow', () => {
  assert.equal(nextRun(time('20:00'), at(9)), at(20));
  assert.equal(nextRun(time('20:00'), at(21)), at(20, 0, 6));
});

test('the moment it ran is past: it does not run twice', () => {
  assert.equal(nextRun(time('20:00'), at(20)), at(20, 0, 6));
});

test('chosen days are kept to', () => {
  // Monday only, from a Thursday.
  assert.equal(nextRun(time('9:00', [1]), at(12)), at(9, 0, 9));
  // Friday and Saturday, on a Friday evening.
  assert.equal(nextRun(time('9:00', [5, 6]), at(20, 0, 6)), at(9, 0, 7));
});

test('every N minutes lands on the clock', () => {
  assert.equal(nextRun(every(15, UNIT.minutes), at(10, 7)), at(10, 15));
  assert.equal(nextRun(every(15, UNIT.minutes), at(10, 45)), at(11, 0));
});

test('every N hours keeps within its hours, and starts again the next day', () => {
  const hours = every(2, UNIT.hours, { from: '9:00', to: '18:00' });
  assert.equal(nextRun(hours, at(8)), at(9));
  assert.equal(nextRun(hours, at(14, 1)), at(15));
  assert.equal(nextRun(hours, at(17, 30)), at(9, 0, 6));
});

test('hours over midnight run on both sides of it', () => {
  const night = every(1, UNIT.hours, { from: '22:00', to: '2:00' });
  assert.equal(nextRun(night, at(23, 30)), at(0, 0, 6));
  assert.equal(nextRun(night, at(1, 30)), at(2));
  assert.equal(nextRun(night, at(3)), at(22));
});

test('hours that start and end at the same time are the whole day', () => {
  const allDay = every(1, UNIT.hours, { from: '0:00', to: '0:00' });
  assert.equal(nextRun(allDay, at(9, 30)), at(10));
  assert.equal(nextRun(allDay, at(23, 30)), at(0, 0, 6));
  const fromNine = every(1, UNIT.hours, { from: '9:00', to: '9:00' });
  assert.equal(nextRun(fromNine, at(3, 10)), at(4));
  assert.equal(nextRun(fromNine, at(8, 30)), at(9));
});

test('at start has no next time, and a time that makes no sense never comes', () => {
  assert.equal(nextRun({ ...time('20:00'), kind: WHEN.start }, at(9)), null);
  assert.equal(nextRun(time('nonsense'), at(9)), null);
});

test('when reads as a person would say it', () => {
  assert.equal(describeWhen(time('20:00')), 'Every day at 20:00');
  assert.equal(describeWhen(time('2:30', [1, 2, 3, 4, 5])), 'Weekdays at 2:30');
  assert.equal(describeWhen(time('9:00', [1])), 'Mondays at 9:00');
  assert.equal(describeWhen(time('9:00', [3])), 'Wednesdays at 9:00');
  assert.equal(describeWhen(time('9:00', [0, 1])), 'Mon, Sun at 9:00');
  assert.equal(describeWhen(every(1, UNIT.hours)), 'Every hour');
  assert.equal(describeWhen(every(2, UNIT.hours, { from: '9:00', to: '18:00' })), 'Every 2 hours, 9:00 to 18:00');
  assert.equal(describeWhen(every(1, UNIT.hours, { from: '0:00', to: '00:00' })), 'Every hour');
  assert.equal(describeWhen({ ...time(''), kind: WHEN.start }), 'When Termilly starts');
});

test('the next run reads by how far away it is', () => {
  const now = at(9);
  assert.equal(describeAt(at(20), now), 'today 20:00');
  assert.equal(describeAt(at(2, 30, 6), now), 'tomorrow 2:30');
  assert.equal(describeAt(at(20, 0, 7), now), 'Sat 20:00');
  assert.equal(describeAt(at(20, 0, 12), now), '12 Nov 20:00');
  assert.equal(describeAt(null, now), 'at the next start');
});

test('how long it took', () => {
  assert.equal(describeTook(48_000), '48 s');
  assert.equal(describeTook(72_000), '1 min 12 s');
  assert.equal(describeTook(120_000), '2 min');
  assert.equal(describeTook(7_500_000), '2 h 5 min');
});

test('how a run ended', () => {
  assert.equal(statusOf({ code: 0 }), RUN.worked);
  assert.equal(statusOf({ code: 1 }), RUN.failed);
  assert.equal(statusOf({ code: null, stopped: true }), RUN.stopped);
  assert.equal(statusOf({ code: null, error: 'gone' }), RUN.failed);
  assert.equal(statusOf({ code: null }), RUN.failed);
});

test('a summary is the last line with something on it, cut short', () => {
  assert.equal(summaryOf('first\r\n\r\n  last one  \r\n\r\n'), 'last one');
  assert.equal(summaryOf(''), '');
  assert.equal(summaryOf('x'.repeat(300)).length, 180);
});

test('it tells as it was asked to', () => {
  assert.ok(shouldTell(NOTIFY.always, RUN.worked));
  assert.ok(shouldTell(NOTIFY.failed, RUN.failed));
  assert.ok(shouldTell(NOTIFY.failed, RUN.missed));
  assert.ok(!shouldTell(NOTIFY.failed, RUN.worked));
  assert.ok(!shouldTell(NOTIFY.failed, RUN.sent));
  assert.ok(!shouldTell(NOTIFY.never, RUN.failed));
});

test('old runs go, and those of a schedule that is gone, but never one still running', () => {
  const schedule = { ...newSchedule('s'), keepDays: 2 };
  const runs = [
    { id: 'a', scheduleId: 's', at: at(9), status: RUN.worked },
    { id: 'b', scheduleId: 's', at: at(9, 0, 1), status: RUN.worked },
    { id: 'c', scheduleId: 'gone', at: at(9), status: RUN.worked },
    { id: 'd', scheduleId: 'gone', at: at(9), status: RUN.running },
  ];
  const { keep, gone } = sortRuns(runs, [schedule], at(10));
  assert.deepEqual(keep.map(r => r.id), ['a', 'd']);
  assert.deepEqual(gone.map(r => r.id), ['b', 'c']);
});

test('a schedule that runs every minute keeps its newest runs only', () => {
  const runs = Array.from({ length: 205 }, (_, i) => ({ id: `r${i}`, scheduleId: 's', at: at(9), status: RUN.worked }));
  const { keep, gone } = sortRuns(runs, [newSchedule('s')], at(10));
  assert.equal(keep.length, 200);
  assert.equal(gone.length, 5);
  assert.equal(keep[0].id, 'r0');
});
