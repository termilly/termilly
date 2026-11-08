// @ts-check
// Schedules on a phone (phone/schedules.js): what its snapshot says about them, and what it may do through the manage op.
// Reading a report needs nothing more than seeing terminals does; Run now, Stop and turning one on or off need Settings ›
// Remote › Allow typing (Phone/PhoneManage.cs). Schedules are made and changed on the PC.

import { schedules, runsOf, scheduleById, runNow, stopRun, setScheduleOn } from './schedules.js';
import { reportText } from './schedulereport.js';
import { describeWhen, WHEN } from './schedulerules.js';

/** What a phone may ask about schedules (the message's "action"). */
export const SCHEDULE_ACTION = Object.freeze({ run: 'scheduleRun', stop: 'scheduleStop', on: 'scheduleOn', report: 'scheduleReport' });
/** How many of a schedule's runs a phone gets. */
const PHONE_RUNS = 20;
/** The most of a report a phone gets. */
const MAX_REPORT = 100000;

/** The schedules for a phone: what each says, when it runs next, and its last runs. */
export const schedulesForPhone = () => schedules().map(s => ({
  id: s.id, name: s.name, on: s.on, what: s.what, when: describeWhen(s.when), nextAt: s.on && s.when.kind !== WHEN.start ? s.nextAt : null,
  runs: runsOf(s.id).slice(0, PHONE_RUNS).map(({ id, at, ms, status, summary, costUsd }) => ({ id, at, ms, status, summary, costUsd: costUsd ?? null })),
}));

/** @param {Record<string, any>} m */
function scheduleOf(m) {
  const schedule = scheduleById(String(m.id ?? ''));
  if (!schedule) throw new Error('That schedule is gone.');
  return schedule;
}

/** @type {Record<string, (m: Record<string, any>) => object | Promise<object>>} */
export const SCHEDULE_DO = {
  [SCHEDULE_ACTION.run]: m => {
    const schedule = scheduleOf(m);
    runNow(schedule.id);
    return { id: schedule.id, runId: runsOf(schedule.id)[0]?.id ?? null };
  },
  [SCHEDULE_ACTION.stop]: m => {
    stopRun(String(m.runId ?? ''));
    return {};
  },
  [SCHEDULE_ACTION.on]: m => {
    const schedule = scheduleOf(m);
    setScheduleOn(schedule.id, !!m.on);
    return { id: schedule.id };
  },
  [SCHEDULE_ACTION.report]: async m => {
    const runId = String(m.runId ?? '');
    const text = await reportText(runId);
    return { runId, text: text === null ? null : text.slice(0, MAX_REPORT), cut: (text?.length ?? 0) > MAX_REPORT };
  },
};
