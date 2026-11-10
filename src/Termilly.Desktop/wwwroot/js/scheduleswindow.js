// @ts-check
// The Schedules window: every schedule on the left with its next run and last runs, and on the right the selected one's
// form or its runs. It opens from the title bar's clock, the palette, Ctrl+Shift+Y and a run's notification, and is always in a
// window of its own where the system has them, as the Snippets window is.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, on, emit, persist, newId, EVENTS } from './store.js';
import { restoreFocus, newTab } from './panes.js';
import { closeAll, dropdown } from './popups.js';
import { modal, pickFolder, CONFIRM_DIALOG } from './dialogs.js';
import { escapeHtml, COPIED } from './ui.js';
import { fuzzyMatch } from './fuzzy.js';
import { allSnippets, NAME_WORDS } from './snippets.js';
import { byId, find, targetOf, TOOL_COUNT } from './dom.js';
import { detach, closeWindow, focusWindow, isDetached, windowName } from './windows.js';
import { readReport, shownText } from './schedulereport.js';
import { withPaths, openReportLink, LINK_CLASS } from './schedulelinks.js';
import {
  schedules, scheduleById, runsOf, saveSchedule, removeSchedule, setScheduleOn, runNow, stopRun, runningNow,
} from './schedules.js';
import { formHtml, rowHtml, runsHtml, reportHtml, WHEN_FIELD, WHEN_KIND_SEGMENT, ALL_DAY_FIELD, REVIEWER_FIELD } from './scheduleview.js';
import { ROUNDS } from './todoplan.js';
import { AGENT_KIND } from './constants.js';
import { newSchedule, minutesOf, nextRun, describeAt, isAllDay, WHAT, WHERE, WHEN, RUN } from './schedulerules.js';

const NAME = 'Schedules';
const WINDOW_KEY = 'schedules';
/** The window's buttons (their data-sch). */
const ACTION = Object.freeze({
  add: 'add', close: 'close', save: 'save', remove: 'delete', run: 'run', stop: 'stop', copy: 'copy', terminal: 'terminal', onOff: 'onOff', file: 'file', browse: 'browse',
});
/** The two views of a schedule. */
const VIEW = Object.freeze({ form: 'form', runs: 'runs' });
/** How much of the main window it takes the first time. */
const FIRST_SHARE = 0.8;
const PROD_TAG = 'prod';
const KEY_SAVE = 'KeyS';
/** Boxes that show or hide more of the form. */
const REDRAWS = new Set(['allowChanges', 'allowAll', 'toNotepad', 'toFile', 'agent']);
/** Fields that hold numbers. */
const NUMBERS = new Set(['limitMinutes', 'keepDays', 'every', 'rounds']);
/** The biggest "every", so a day still has a run in it. */
const MAX_EVERY = Object.freeze({ minutes: 1440, hours: 24 });
/** A run's output, under its row. */
const OUTPUT = '.sch-output';
const CLOSE = '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';

const layer = document.createElement('div');
layer.className = 'modal-layer settings-layer snippets-layer';
layer.hidden = true;
layer.innerHTML = `
  <div class="settings snippets-win schedules-win" role="dialog" aria-modal="true" aria-labelledby="sch-title">
    <div class="set-head">
      <span class="title-icon sch-icon"></span>
      <h2 id="sch-title">${NAME}</h2>
      <span class="cw-sub sch-count"></span>
      <span class="spacer"></span>
      <button class="btn small" data-sch="${ACTION.add}">New schedule</button>
      <button class="set-close" data-sch="${ACTION.close}" title="Close (Esc)">${CLOSE}</button>
    </div>
    <div class="cw-main">
      <div class="cw-side sw-side">
        <div class="cw-filter"><input class="field" data-sch-search placeholder="Search schedules" spellcheck="false" autocomplete="off"></div>
        <div class="sw-list sch-list" tabindex="0" role="listbox" aria-label="${NAME}"></div>
      </div>
      <div class="sch-main">
        <div class="sch-tabs" hidden>
          <span class="seg"><button type="button" data-view="${VIEW.form}">Schedule</button><button type="button" data-view="${VIEW.runs}">Runs</button></span>
          <span class="spacer"></span>
          <label class="note-pin sch-on"><input type="checkbox" data-sch-on> On</label>
        </div>
        <div class="sw-edit sch-edit"></div>
      </div>
    </div>
  </div>`;
document.body.append(layer);
const box = find(layer, '.schedules-win');
const head = /** @type {HTMLElement} */ (box.firstElementChild);
const searchEl = /** @type {HTMLInputElement} */ (find(box, '[data-sch-search]'));
const listEl = find(box, '.sch-list');
const tabsEl = find(box, '.sch-tabs');
const onBox = /** @type {HTMLInputElement} */ (find(box, '[data-sch-on]'));
const editEl = find(box, '.sch-edit');
const openButton = byId('schedules-button');
const runningCount = find(openButton, TOOL_COUNT);

/** What the form shows: the selected schedule's copy. */
/** @type {Schedule | null} */
let editing = null;
let isNew = false;
/** @type {string} */
let view = VIEW.form;
/** @type {string | null} */
let openRunId = null;
/** Whether "every" runs all day long; unticked, the form asks for From and To. */
let allDay = true;

const isOpen = () => !layer.hidden || isDetached(WINDOW_KEY);
const saved = () => (editing ? scheduleById(editing.id) : null);
const isDirty = () => !!editing && (isNew || JSON.stringify({ ...editing, nextAt: 0 }) !== JSON.stringify({ ...saved(), nextAt: 0 }));

/** Shells that can run out of sight or in a terminal, servers, and the rest of what the form picks from. */
function choices() {
  const shells = state.profiles.filter(p => (p.source === 'local' || p.source === 'wsl') && !p.startCommand);
  const servers = state.profiles.filter(p => p.source === 'ssh');
  const named = [undefined, ...state.workspaces].flatMap(ws => allSnippets(ws)).map(s => s.name);
  return { shells, servers, workspaces: state.workspaces.filter(w => !w.tmux), snippets: [...new Set(named)] };
}

/**
 * What stops the form being saved; nothing when it can be.
 * @param {Schedule} s
 */
function problemOf(s) {
  const { when } = s;
  if (s.what === WHAT.command && !s.command.trim()) return 'It needs a command.';
  if (s.what === WHAT.snippet && !s.snippet) return 'It needs a snippet.';
  if (s.what === WHAT.agent && !s.prompt.trim()) return 'It needs a prompt.';
  const rounds = s.rounds ?? ROUNDS.usual;
  if (s.what === WHAT.agent && s.reviewers?.length && !(Number.isInteger(rounds) && rounds >= ROUNDS.min && rounds <= ROUNDS.max)) return `Review rounds go from ${ROUNDS.min} to ${ROUNDS.max}.`;
  if (s.where === WHERE.server && !s.profile) return 'It needs a server.';
  if (s.where === WHERE.terminal && !s.terminal.trim()) return 'It needs a terminal’s name or a #tag.';
  if (when.kind === WHEN.time && minutesOf(when.at) === null) return 'The time should look like 20:00.';
  if (when.kind === WHEN.every) {
    const most = /** @type {Record<string, number>} */ (MAX_EVERY)[when.unit];
    if (!(when.every >= 1 && when.every <= most)) return `Every should be from 1 to ${most} ${when.unit}.`;
    if (!allDay && !(when.from && when.to)) return 'Fill in From and To, or tick All day.';
    if ([when.from, when.to].some(t => t && minutesOf(t) === null)) return 'From and To should look like 9:00.';
    if (!allDay && minutesOf(when.from) === minutesOf(when.to)) return 'From and To are the same. Tick All day to run all day.';
  }
  if (s.toNotepad && !s.notepadPage.trim()) return 'It needs the Notepad page’s name.';
  if (s.toFile && !s.file.trim()) return 'It needs a file name.';
  if (!(s.limitMinutes >= 1)) return 'Stop it after should be at least a minute.';
  return s.keepDays >= 1 ? '' : 'Keep reports should be at least a day.';
}

/** What the form says about its next run. */
function nextText() {
  const s = /** @type {Schedule} */ (editing);
  if (s.when.kind === WHEN.start) return 'It runs each time Termilly starts.';
  const now = Date.now();
  const at = nextRun(s.when, now);
  return at ? `Next run: ${describeAt(at, now)}. It runs while Termilly is open or in the tray.` : '';
}

/** The list as last drawn. */
let listHtml = '';
/** The runs view as last drawn, with its output. */
let runsShown = '';

function renderList() {
  const q = searchEl.value.trim();
  const all = isNew && editing ? [...schedules(), editing] : schedules();
  const shown = all.filter(s => !q || fuzzyMatch(q, `${s.name} ${s.command} ${s.snippet}`));
  const count = schedules().length;
  find(box, '.sch-count').textContent = `${count} schedule${count === 1 ? '' : 's'}`;
  const now = Date.now();
  const html = shown.length ? shown.map(s => rowHtml(s, runsOf(s.id), { selected: s.id === editing?.id, now })).join('')
    : `<p class="set-desc sw-empty">${q ? 'No schedule matches.' : 'No schedules yet. Run a command or a snippet on time, with New schedule.'}</p>`;
  // The clock ticks every few seconds: the same list drawn again would only flicker.
  if (html !== listHtml) listEl.innerHTML = listHtml = html;
}

function renderForm() {
  const s = /** @type {Schedule} */ (editing);
  const list = choices();
  // The first on offer is what the form shows, so it's what's saved.
  if (s.where === WHERE.server && !list.servers.some(p => p.id === s.profile)) s.profile = list.servers[0]?.id ?? null;
  if (s.where === WHERE.fresh && !s.wsId) s.wsId = state.activeId;
  if (s.what === WHAT.snippet && !s.snippet) s.snippet = list.snippets[0] ?? '';
  editEl.innerHTML = formHtml(s, list, problemOf(s), nextText(), { isNew, dirty: isDirty(), allDay });
  for (const select of editEl.querySelectorAll('select')) dropdown(/** @type {HTMLSelectElement} */ (select));
}

/** What can change without redrawing the fields being typed in. */
function renderState() {
  const s = /** @type {Schedule} */ (editing);
  const problem = problemOf(s);
  find(editEl, '.sch-problem').textContent = problem;
  find(editEl, '.sch-next').textContent = problem ? '' : nextText();
  /** @type {HTMLButtonElement} */ (find(editEl, `[data-sch="${ACTION.save}"]`)).disabled = !isDirty() || !!problem;
  const run = /** @type {HTMLButtonElement} */ (find(editEl, `[data-sch="${ACTION.run}"]`));
  run.disabled = isNew || isDirty();
}

/**
 * The runs, and the open one's output under it. Drawn whole once its output is read, and not again while nothing changed:
 * the clock's ticks redraw it, and an output emptied and read again flashes.
 */
async function renderRuns() {
  const id = /** @type {Schedule} */ (editing).id;
  const runs = runsOf(id);
  const open = runs.find(r => r.id === openRunId) ?? null;
  const asked = open?.id ?? null;
  let report = '';
  /** @type {string | null} */
  let reportShown = null;
  if (open) {
    const kept = await readReport(open.id);
    reportShown = kept === null ? null : await shownText(kept);
    if (openRunId !== asked || view !== VIEW.runs || editing?.id !== id) return;
    report = reportHtml(open, reportShown);
  }
  const html = runsHtml(runs, openRunId);
  const whole = html + report;
  if (whole === runsShown) return;
  runsShown = whole;
  editEl.innerHTML = html;
  if (!open) return;
  find(editEl, `[data-run="${asked}"]`).insertAdjacentHTML('afterend', report);
  const output = /** @type {HTMLElement | null} */ (editEl.querySelector(OUTPUT));
  if (output && reportShown !== null) withPaths(output, /** @type {Schedule} */ (editing), reportShown);
}

function render() {
  renderList();
  tabsEl.hidden = !editing;
  if (!editing) {
    runsShown = '';
    editEl.innerHTML = `<p class="set-desc sw-none">${schedules().length ? 'Pick a schedule on the left.' : ''}</p>`;
    return;
  }
  for (const b of tabsEl.querySelectorAll('[data-view]')) b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.view === view);
  onBox.checked = editing.on;
  /** @type {HTMLElement} */ (find(tabsEl, '.sch-on')).hidden = isNew;
  if (view === VIEW.form) {
    runsShown = '';
    renderForm();
  } else renderRuns();
}

/**
 * Selects a schedule, on a view.
 * @param {string | null} id
 * @param {{ runId?: string | null }} [options]
 */
function select(id, { runId = null } = {}) {
  const schedule = id ? scheduleById(id) : null;
  editing = schedule ? structuredClone(schedule) : null;
  allDay = !editing || isAllDay(editing.when);
  isNew = false;
  openRunId = runId;
  view = runId ? VIEW.runs : VIEW.form;
  render();
}

/** Asks about changes not saved. False when the user stays. */
async function leave() {
  if (!isDirty()) return true;
  const stay = await modal(CONFIRM_DIALOG, `
    <h3>Leave without saving?</h3>
    <p class="dialog-sub">The changes to this schedule are lost.</p>
    <div class="dialog-actions">
      <button class="btn" data-cancel autofocus>Stay</button>
      <button class="btn danger" data-ok>Leave</button>
    </div>`, (dialog, close) => ({ submit: () => close(true), ok: () => close(true) }));
  return stay === true;
}

/** A form's field changed. @param {HTMLInputElement} field */
function fieldChanged(field) {
  const s = /** @type {Schedule} */ (editing);
  const key = field.name.startsWith(WHEN_FIELD) ? field.name.slice(WHEN_FIELD.length) : field.name;
  const value = field.type === 'checkbox' ? field.checked : NUMBERS.has(key) ? Number(field.value) : field.value;
  const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (field.name.startsWith(WHEN_FIELD) ? s.when : s));
  target[key] = value;
}

/**
 * A reviewer's box: the agent reviews what the prompt did, or not.
 * @param {string} kind
 * @param {boolean} on
 */
function reviewerChanged(kind, on) {
  const s = /** @type {Schedule} */ (editing);
  const others = (s.reviewers ?? []).filter(k => k !== kind);
  s.reviewers = on ? [...others, kind] : others;
  renderForm();
}

/**
 * All day ticked takes the hours away; unticked, From and To show, empty.
 * @param {boolean} on
 */
function allDayChanged(on) {
  const { when } = /** @type {Schedule} */ (editing);
  allDay = on;
  when.from = '';
  when.to = '';
  renderForm();
}

/**
 * A segment's choice. Most of them change what the form asks.
 * @param {HTMLElement} button
 */
function segmentChose(button) {
  const s = /** @type {Schedule} */ (editing);
  const { seg, value } = /** @type {{ seg: string, value: string }} */ (button.dataset);
  if (seg === WHEN_KIND_SEGMENT) s.when.kind = value;
  else {
    const place = s.where;
    /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (s))[seg] = value;
    // A server's profile isn't a shell's, and the other way round.
    if (s.where !== place) s.profile = null;
  }
  renderForm();
}

/** @param {HTMLElement} button */
function dayChose(button) {
  const s = /** @type {Schedule} */ (editing);
  const day = Number(button.dataset.day);
  const days = s.when.days ?? [];
  s.when.days = days.includes(day) ? days.filter(d => d !== day) : [...days, day].sort((a, b) => a - b);
  button.classList.toggle('on');
  renderState();
}

/** Whether a schedule goes to production, where nobody will be there to see what it types. */
function reachesProduction() {
  const s = /** @type {Schedule} */ (editing);
  if (s.where === WHERE.terminal) return [...state.tabs.values()].some(t => t.tags.includes(PROD_TAG) && (s.terminal === `#${PROD_TAG}` || t.name === s.terminal));
  return !!state.profiles.find(p => p.id === s.profile)?.tags?.includes(PROD_TAG);
}

const confirmProduction = () => modal('confirm prod-confirm', `
  <h3>Run this on production, on time?</h3>
  <p class="dialog-sub">It’ll run with nobody there, each time, without asking again.</p>
  <div class="dialog-actions">
    <button class="btn" data-cancel autofocus>Cancel</button>
    <button class="btn danger" data-ok>Save it</button>
  </div>`, (dialog, close) => ({ submit: () => {}, ok: () => close(true) })).then(answer => answer === true);

async function save() {
  const s = editing;
  if (!s || problemOf(s) || !isDirty()) return;
  if (reachesProduction() && !(await confirmProduction())) return;
  if (s !== editing) return;
  s.name = s.name.trim() || (s.what === WHAT.snippet ? s.snippet : (s.what === WHAT.agent ? s.prompt : s.command).trim().split(/\s+/).slice(0, NAME_WORDS).join(' '));
  saveSchedule(s);
  select(s.id);
}

async function removeShown() {
  if (!editing) return;
  if (isNew) {
    isNew = false;
    editing = null;
    render();
    return;
  }
  const yes = await modal(CONFIRM_DIALOG, `
    <h3>Delete ${escapeHtml(editing.name)}?</h3>
    <p class="dialog-sub">Its reports go with it.</p>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn danger" data-ok>Delete</button>
    </div>`, (dialog, close) => ({ submit: () => close(true), ok: () => close(true) }));
  if (yes !== true || !editing) return;
  removeSchedule(editing.id);
  select(schedules()[0]?.id ?? null);
}

async function add() {
  if (!(await leave())) return;
  editing = newSchedule(newId('s'));
  allDay = true;
  isNew = true;
  view = VIEW.form;
  openRunId = null;
  render();
  /** @type {HTMLElement | null} */ (editEl.querySelector('[name="name"]'))?.focus();
}

/** Opens the shown report as a terminal, output and all, in the workspace in front. */
async function openAsTerminal() {
  const s = /** @type {Schedule} */ (editing);
  const report = openRunId ? await readReport(openRunId) : null;
  if (!report) return;
  const text = await shownText(report);
  const shell = s.where === WHERE.server || s.where === WHERE.hidden ? s.profile ?? undefined : undefined;
  newTab({ profile: shell, wsId: state.activeId, cwd: s.cwd || null, name: s.name, restore: { lines: text.split('\n'), closedAt: Date.now() } });
}

/**
 * Picks the run's folder on this computer: the picker gives it as it's spelled on disk. It's over this window: one owned
 * by the main window would bring that up over a window of its own.
 */
async function browseFolder() {
  const field = /** @type {HTMLInputElement} */ (find(editEl, '[name=cwd]'));
  const path = await pickFolder(field.value || undefined, isDetached(WINDOW_KEY) ? windowName(WINDOW_KEY) : undefined);
  if (!path || !editing) return;
  field.value = path;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** How long Copy says it copied. */
const COPIED_MS = 1500;

/**
 * Copies the open run's output. Through the clipboard of the window it's shown in: the main window's refuses while a
 * window of its own has the focus.
 */
async function copyOutput() {
  const button = /** @type {HTMLButtonElement} */ (find(editEl, `[data-sch="${ACTION.copy}"]`));
  const here = editEl.ownerDocument.defaultView ?? window;
  try {
    await here.navigator.clipboard.writeText(find(editEl, OUTPUT).textContent ?? '');
    button.textContent = COPIED;
  } catch {
    button.textContent = 'Couldn’t copy';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, COPIED_MS);
}

/** @param {string} action */
async function act(action) {
  if (action === ACTION.add) await add();
  else if (action === ACTION.close) closeSchedules();
  else if (action === ACTION.save) await save();
  else if (action === ACTION.remove) await removeShown();
  else if (action === ACTION.run && editing) {
    runNow(editing.id);
    openRunId = runsOf(editing.id).find(r => r.status === RUN.running || r.status === RUN.waiting)?.id ?? null;
    view = VIEW.runs;
    render();
  } else if (action === ACTION.stop && openRunId) stopRun(openRunId);
  else if (action === ACTION.copy) await copyOutput();
  else if (action === ACTION.terminal) await openAsTerminal();
  else if (action === ACTION.browse) await browseFolder();
  else if (action === ACTION.file) {
    const run = openRunId ? state.schedules.runs.find(r => r.id === openRunId) : null;
    if (run?.file) send(PAGE.openPath, { path: run.file });
  }
}

box.addEventListener('click', e => {
  const target = targetOf(e);
  const row = /** @type {HTMLElement | null} */ (target.closest('[data-id]'));
  const seg = /** @type {HTMLElement | null} */ (target.closest('[data-seg]'));
  const day = /** @type {HTMLElement | null} */ (target.closest('[data-day]'));
  const tab = /** @type {HTMLElement | null} */ (target.closest('[data-view]'));
  const run = /** @type {HTMLElement | null} */ (target.closest('[data-run]'));
  const button = /** @type {HTMLElement | null} */ (target.closest('[data-sch]'));
  const link = /** @type {HTMLElement | null} */ (target.closest(`.${LINK_CLASS}`));
  if (link && editing) openReportLink(link, editing);
  else if (button) act(/** @type {string} */ (button.dataset.sch));
  else if (seg) segmentChose(seg);
  else if (day) dayChose(day);
  else if (run) {
    openRunId = openRunId === run.dataset.run ? null : run.dataset.run ?? null;
    render();
  } else if (tab) {
    view = /** @type {string} */ (tab.dataset.view);
    render();
  } else if (row) leave().then(go => go && select(row.dataset.id ?? null));
});

for (const event of ['input', 'change']) {
  editEl.addEventListener(event, e => {
    const field = /** @type {HTMLInputElement} */ (targetOf(e));
    if (!editing || !field.name || !editEl.contains(field)) return;
    if (field.name === ALL_DAY_FIELD) {
      allDayChanged(field.checked);
      return;
    }
    if (field.name === REVIEWER_FIELD) {
      reviewerChanged(field.value, field.checked);
      return;
    }
    // An agent that reviewed it runs it now: the one that ran it reviews in its place, as To do's Implement card has it.
    if (field.name === 'agent') editing.reviewers = (editing.reviewers ?? []).map(kind => (kind === field.value ? editing?.agent ?? AGENT_KIND.claude : kind));
    fieldChanged(field);
    if (REDRAWS.has(field.name)) renderForm();
    else renderState();
  });
}

onBox.addEventListener('change', () => {
  if (!editing || isNew) return;
  setScheduleOn(editing.id, onBox.checked);
  editing.on = onBox.checked;
  editing.nextAt = saved()?.nextAt ?? null;
});

searchEl.addEventListener('input', renderList);

box.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault();
    closeSchedules();
  } else if (e.ctrlKey && !e.shiftKey && e.code === KEY_SAVE) {
    e.preventDefault();
    save();
  }
  e.stopPropagation();
});

/** @param {boolean} open */
function keepOpen(open) {
  if (state.schedules.open === open) return;
  state.schedules.open = open;
  persist();
}

function closed() {
  keepOpen(false);
  layer.hidden = true;
  layer.style.visibility = '';
  editing = null;
  isNew = false;
  restoreFocus();
}

/** Moves it into a window of its own; false where there are none (macOS for now). */
function detachSchedules() {
  const w = Math.round(innerWidth * FIRST_SHARE), h = Math.round(innerHeight * FIRST_SHARE);
  return detach(WINDOW_KEY, {
    el: box, title: NAME, askClose: closeSchedules, close: closeSchedules, header: head, remember: true, returnable: false,
    firstPlace: { x: Math.round(screenX + (innerWidth - w) / 2), y: Math.round(screenY + (innerHeight - h) / 2), w, h },
    onClosed: () => {
      layer.append(box);
      closed();
    },
    onMoved: () => {
      layer.hidden = true;
      layer.style.visibility = '';
      searchEl.focus();
    },
  });
}

/** Opens the window; on a schedule or a run, or the first. @param {{ scheduleId?: string, runId?: string }} [options] */
export function openSchedules({ scheduleId, runId } = {}) {
  closeAll();
  const scheduleOfRun = runId ? state.schedules.runs.find(r => r.id === runId)?.scheduleId : scheduleId;
  if (!isOpen()) {
    layer.hidden = false;
    layer.style.visibility = 'hidden';
    keepOpen(true);
    if (!detachSchedules()) {
      layer.style.visibility = '';
      searchEl.focus();
    }
  } else if (isDetached(WINDOW_KEY)) focusWindow(WINDOW_KEY);
  if (scheduleOfRun) select(scheduleOfRun, { runId });
  else if (!editing) select(schedules()[0]?.id ?? null);
}

export async function closeSchedules() {
  if (!isOpen() || !(await leave())) return;
  if (isDetached(WINDOW_KEY)) {
    closeWindow(WINDOW_KEY, { quiet: true });
    layer.append(box);
  }
  closed();
}

export const toggleSchedules = () => (isDetached(WINDOW_KEY) ? focusWindow(WINDOW_KEY) : isOpen() ? closeSchedules() : openSchedules());

/** At start: open again if it was open when Termilly closed. */
export function initSchedulesWindow() {
  if (state.schedules.open) openSchedules();
}

on(EVENTS.openSchedules, options => openSchedules(options));

// A run's news, or the clock's: what's being edited stays as it is, and the rest shows it.
const newsCame = () => {
  const count = runningNow().length;
  runningCount.textContent = String(count);
  runningCount.hidden = !count;
  if (!isOpen()) return;
  renderList();
  if (editing && view === VIEW.runs) render();
};
on(EVENTS.schedules, newsCame);
on(EVENTS.scheduleClock, newsCame);

openButton.addEventListener('click', toggleSchedules);
find(box, '.sch-icon').innerHTML = /** @type {Element} */ (openButton.firstElementChild).outerHTML;
emit(EVENTS.schedules);
