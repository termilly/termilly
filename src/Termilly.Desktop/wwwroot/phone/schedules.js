// @ts-check
// The Schedules tab: the PC's schedules, each with when it runs and its last runs; a schedule's runs, Run now and its switch;
// and a run's report, read from the PC when it's opened (js/phoneschedules.js). Schedules are made and changed on the PC.

/**
 * @typedef {{ id: string, at: number, ms: number, status: string, summary: string, costUsd: number | null }} PhoneRun
 * @typedef {{ id: string, name: string, on: boolean, what: string, when: string, nextAt: number | null, runs: PhoneRun[] }} PhoneSchedule
 * @typedef {{ snap: () => { schedules?: PhoneSchedule[], typing?: boolean }, send: (m: object) => void, redraw: () => void,
 *   toast: (text: string) => void, show: () => void }} SchedulesApp
 */

const OP = 'manage';
/** What's asked of the PC (js/phoneschedules.js SCHEDULE_ACTION). */
const ACTION = Object.freeze({ run: 'scheduleRun', stop: 'scheduleStop', on: 'scheduleOn', report: 'scheduleReport' });
const OWN_ACTIONS = new Set(Object.values(ACTION));
/** What the tab's taps do (data-sc). */
const SC = Object.freeze({ open: 'open', back: 'back', run: 'run', stop: 'stop', on: 'on', report: 'report' });
/** How runs stand (js/schedulerules.js RUN), and what each says. */
const LABEL = Object.freeze({
  waiting: 'Waiting', running: 'Running', worked: 'Done', failed: 'Failed', stopped: 'Stopped', missed: 'Missed', skipped: 'Skipped', sent: 'Sent',
});
const GOING = new Set(['waiting', 'running']);
/** How many runs a schedule's row shows. */
const LAST_RUNS = 8;
const SECOND_MS = 1000;
const MINUTE_S = 60;

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** @param {number} at */
const when = at => new Date(at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** @param {number} ms */
function took(ms) {
  const s = Math.round(ms / SECOND_MS);
  return s < MINUTE_S ? `${s} s` : `${Math.floor(s / MINUTE_S)} min ${s % MINUTE_S} s`;
}

/** @param {PhoneRun[]} runs newest first */
const squaresHtml = runs => `<span class="sc-squares">${runs.slice(0, LAST_RUNS).reverse().map(r => `<i class="sc-sq ${esc(r.status)}"></i>`).join('')}</span>`;

/** @param {PhoneSchedule} s */
const nextLine = s => (!s.on ? 'Turned off' : s.nextAt ? `${s.when} · next ${when(s.nextAt)}` : s.when);

/** @param {PhoneSchedule[]} list */
function listHtml(list) {
  if (!list.length) return '<p class="muted center">No schedules on your PC. Make them in Termilly’s Schedules window.</p>';
  return `<div class="list">${list.map(s => `<button class="row sc-row${s.on ? '' : ' sc-off'}" data-sc="${SC.open}" data-id="${esc(s.id)}">
    <div class="r-text"><div class="r-name">${esc(s.name)}</div><div class="r-line">${esc(nextLine(s))}</div>${squaresHtml(s.runs)}</div>
    <span class="td-chev">›</span></button>`).join('')}</div>`;
}

/**
 * @param {PhoneSchedule} s
 * @param {boolean} typing
 */
function scheduleHtml(s, typing) {
  const going = s.runs.find(r => GOING.has(r.status));
  const controls = typing
    ? `<div class="sc-controls"><button class="ibtn fill" data-sc="${going ? SC.stop : SC.run}" data-id="${esc(going?.id ?? s.id)}">${going ? 'Stop' : 'Run now'}</button>
      <label class="sc-on"><input type="checkbox" data-sc="${SC.on}"${s.on ? ' checked' : ''}> On</label></div>`
    : '<p class="td-hint">To run schedules from this phone, turn on Allow typing in Termilly’s Settings › Remote on the PC.</p>';
  const runs = s.runs.length ? `<div class="list">${s.runs.map(r => `<button class="row" data-sc="${SC.report}" data-id="${esc(r.id)}">
    <i class="sc-sq ${esc(r.status)}"></i><div class="r-text"><div class="r-name">${esc(when(r.at))}</div>
    <div class="r-line">${esc(LABEL[/** @type {keyof typeof LABEL} */ (r.status)] ?? r.status)}${r.ms ? `, ${took(r.ms)}` : ''}${r.summary ? ` · ${esc(r.summary)}` : ''}</div></div>
    <span class="td-chev">›</span></button>`).join('')}</div>` : '<p class="muted center">No runs yet.</p>';
  return `<p class="muted sc-when">${esc(nextLine(s))}</p>${controls}<div class="section">Runs</div>${runs}`;
}

/**
 * @param {PhoneRun} run
 * @param {{ text?: string | null, cut?: boolean, loading?: boolean }} report
 */
function reportHtml(run, report) {
  const head = `<p class="muted sc-when">${esc(LABEL[/** @type {keyof typeof LABEL} */ (run.status)] ?? run.status)}${run.ms ? `, ${took(run.ms)}` : ''}${run.costUsd ? `, $${run.costUsd.toFixed(2)}` : ''}</p>`;
  const why = run.summary && run.status !== 'worked' ? `<p class="sc-why">${esc(run.summary)}</p>` : '';
  const body = report.loading ? '<p class="muted center">Getting the report from your PC.</p>'
    : report.text === null || report.text === undefined ? '<p class="muted center">No output was kept for this run.</p>'
      : `<pre class="sc-report">${esc(report.text)}</pre>${report.cut ? '<p class="td-hint">That’s the start of it. The rest is on the PC.</p>' : ''}`;
  return `${head}${why}${body}`;
}

/** @param {SchedulesApp} app */
export function schedulesTab(app) {
  /** @type {string | null} */
  let open = null;
  /** @type {string | null} */
  let openRun = null;
  /** @type {{ text?: string | null, cut?: boolean, loading?: boolean }} */
  let report = {};

  const list = () => app.snap().schedules ?? [];
  const current = () => list().find(s => s.id === open) ?? null;
  const run = () => current()?.runs.find(r => r.id === openRun) ?? null;
  /** @param {string} action @param {object} args */
  const ask = (action, args) => app.send({ op: OP, action, ...args });

  /** @param {string} runId */
  function readReport(runId) {
    openRun = runId;
    report = { loading: true };
    ask(ACTION.report, { runId });
  }

  return {
    html() {
      if (open && !current()) open = null;
      if (openRun && !run()) openRun = null;
      const s = current();
      if (!s) return listHtml(list());
      const r = run();
      return r ? reportHtml(r, report) : scheduleHtml(s, !!app.snap().typing);
    },
    title: () => (run() ? when(/** @type {PhoneRun} */ (run()).at) : current()?.name ?? ''),
    backHtml: () => (current() ? `<button class="back-row" data-sc="${SC.back}">‹ ${run() ? esc(current()?.name) : 'Schedules'}</button>` : ''),
    /** A tapped alert named this run: its report opens. @param {string} runId */
    openRun(runId) {
      const s = list().find(x => x.runs.some(r => r.id === runId));
      if (!s) return false;
      open = s.id;
      readReport(runId);
      app.show();
      return true;
    },
    /** A tap; false when it wasn't the tab's. @param {HTMLElement} target */
    click(target) {
      const el = /** @type {HTMLElement | null} */ (target.closest('[data-sc]'));
      if (!el) return false;
      const id = el.dataset.id ?? '';
      const what = el.dataset.sc;
      if (what === SC.open) open = id;
      else if (what === SC.back) {
        if (openRun) openRun = null;
        else open = null;
      } else if (what === SC.run) ask(ACTION.run, { id });
      else if (what === SC.stop) ask(ACTION.stop, { runId: id });
      else if (what === SC.on) ask(ACTION.on, { id: open, on: /** @type {HTMLInputElement} */ (el).checked });
      else if (what === SC.report) readReport(id);
      app.redraw();
      document.getElementById('home')?.scrollTo(0, 0);
      return true;
    },
    /** The PC's answer; false when it wasn't the tab's. @param {Record<string, any>} m */
    answered(m) {
      if (m.op !== OP || !OWN_ACTIONS.has(m.action ?? '')) return false;
      if (!m.ok) app.toast(m.error ?? 'That didn’t go through.');
      else if (m.action === ACTION.report && m.runId === openRun) report = { text: m.text ?? null, cut: !!m.cut };
      else if (m.action === ACTION.run) app.toast('Started on the PC.');
      app.redraw();
      return true;
    },
  };
}
