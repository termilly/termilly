// @ts-check
// Termilly on a phone (Phone/PhoneServer.cs, docs/phone.md), design A with D's answer sheet: pairing with the code
// Settings shows; then the home screen, live over a WebSocket (PhoneLive): what's waiting for you first, as cards with
// their answers, then each workspace's terminals; a sheet to answer an agent (Approve, Approve and don't ask again,
// Reject, or a reply); a terminal live (terminal.js); and this phone's alerts (Web Push). A bar at the bottom goes
// between the terminals, the PC's notifications and this phone's settings (tabs.js).

import { terminalView, activityHtml, TEXT_SIZE } from './terminal.js';
import { TAB, SETTING, TEXT_SIZES, navHtml, notesHtml, settingsHtml, themesHtml } from './tabs.js';
import { SCROLLING } from './gestures.js';
import { applyLook, chooseLook, chosenLook, looks } from './theme.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));


/** What the PC says about this phone. */
/** @typedef {{ paired: boolean, locked?: boolean, pushKey?: string, alerts?: boolean }} Me */
/** What a terminal waits for (js/phone.js). */
/** @typedef {{ kind: string, tool: string | null, target: string | null, text: string, at: number, always?: boolean }} Waiting */
/** A terminal as the PC describes it (js/phone.js). */
/** @typedef {{ id: string, ws: string, title: string, icon: string, badge: string, agent: string | null, activity: string | null, percent: number | null, hint: string | null, line: string | null, waiting: Waiting | null, production: boolean, cols: number | null, rows: number | null }} Terminal */
/** @typedef {import('./theme.js').Themed & { typing?: boolean, snippets?: import('./snippets.js').PhoneSnippet[], notes?: import('./tabs.js').Note[], workspaces: { id: string, name: string, color: string }[], terminals: Terminal[] }} Snapshot */

/** The PC's API for the app (PhoneServer, PhoneAppApi). */
const API = Object.freeze({ me: '/api/me', pair: '/api/pair', forget: '/api/forget', push: '/api/push', pushOff: '/api/push/off', pushTest: '/api/push/test', live: '/api/live' });
/** The PC's answer to a phone that isn't paired. */
const FORBIDDEN = 403;
/** What the app's buttons do (data-do). */
const DO = Object.freeze({ retry: 'retry', on: 'on', off: 'off', test: 'test', open: 'open', term: 'term', close: 'close', answer: 'answer', reply: 'reply', send: 'send' });
/** The answers to an agent (Features/Phone.cs checks them). */
const CHOICE = Object.freeze({ approve: 'approve', always: 'always', reject: 'reject', reply: 'reply' });
/** What a terminal waits for (js/phone.js). */
const WAITING = Object.freeze({ permission: 'permission', question: 'question', attention: 'attention', error: 'error' });
/** Messages from the PC on the live connection (PhoneLive.Kinds). */
const LIVE = Object.freeze({ state: 'state', answered: 'answered', screen: 'screen', output: 'output' });
/** What the app asks of the live connection: an answer to an agent (Features/Phone.cs). */
const OP = Object.freeze({ answer: 'answer', input: 'input' });
/** The live connection is open (WebSocket.OPEN). */
const OPEN = 1;
/** The live connection tries again after this long, doubling up to the most. */
const RETRY_MS = 1000;
const RETRY_MAX_MS = 15000;
/** How long a note at the bottom stays. */
const TOAST_MS = 2600;
/** Ages on the cards: seconds in a minute and an hour, milliseconds in a second. */
const TIME = Object.freeze({ ms: 1000, minute: 60, hour: 3600 });
/** How often the ages on the cards move on while the app is open. */
const AGE_EVERY_MS = 30000;
/** The workspace colour when the PC sends none. */
const DEFAULT_COLOR = '#8b7bff';

const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
/** Opened from the Home Screen, where iPhone keeps the app's own storage (and its alerts). */
const standalone = matchMedia('(display-mode: standalone)').matches || /** @type {any} */ (navigator).standalone === true;
/** Alerts need a service worker; a browser without one gets none. */
const hasWorker = 'serviceWorker' in navigator;

/** @type {Me | null} */
let me = null;
/** @type {Snapshot} */
let snap = { workspaces: [], terminals: [] };
/** @type {WebSocket | null} */
let live = null;
let connected = false;
let retry = RETRY_MS;
/** The terminal the answer sheet is open on, and whether its reply box shows. */
/** @type {string | null} */
let sheetFor = null;
let replying = false;
/** The tab shown (the bottom bar), and whether Settings shows its themes page. */
let tab = TAB.terminals;
let themesPage = false;
/** The tabs' titles, at the top. */
const TITLE = Object.freeze({ [TAB.terminals]: 'Termilly', [TAB.notes]: 'Notifications', [TAB.settings]: 'Settings' });

/**
 * @param {string} path
 * @param {object} [body]
 */
async function call(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!response.ok) throw new Error(response.status === FORBIDDEN ? 'not allowed' : `error ${response.status}`);
  return response.json();
}

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** The VAPID key as the push manager takes it. @param {string} key base64url */
const keyBytes = key => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/** @param {number} at */
function age(at) {
  const s = Math.max(0, (Date.now() - at) / TIME.ms);
  return s < TIME.minute ? 'now' : s < TIME.hour ? `${Math.floor(s / TIME.minute)}m` : `${Math.floor(s / TIME.hour)}h`;
}

/** @param {Terminal} t */
const badge = t => `<span class="badge${t.icon === 'claude' ? ' claude' : ''}" data-icon="${esc(t.icon)}">${t.icon === 'claude' ? '✻' : esc(t.badge)}</span>`;

/** @param {string} id */
const wsOf = id => snap.workspaces.find(w => w.id === id);

/** @param {string} id */
const terminal = id => snap.terminals.find(t => t.id === id);

// ---- Screens ----

/** @param {string} html */
const show = html => { app.innerHTML = html; };

/** @param {string} body */
const setupScreen = body => show(`<header class="bar"><h1>Termilly</h1></header><main class="setup">${body}</main>`);

async function start() {
  try {
    me = await call(API.me);
  } catch {
    return setupScreen(`<p>Can't reach your PC. Is Termilly running, with Settings › Phone on, and this phone on the same Wi-Fi?</p><button class="button" data-do="${DO.retry}">Try again</button>`);
  }
  if (me?.locked) return setupScreen(`<p>Termilly is locked on your PC. Unlock it there, then come back.</p><button class="button" data-do="${DO.retry}">Try again</button>`);
  if (!me?.paired && ios && !standalone) {
    return setupScreen(`<div class="step done"><span class="step-n">✓</span><div><b>Certificate trusted</b></div></div>
      <div class="step now"><span class="step-n">2</span><div><b>Add to Home Screen</b><p>Share › Add to Home Screen, then open Termilly from there.</p></div></div>`);
  }
  if (!me?.paired) {
    return setupScreen(`<div class="step done"><span class="step-n">✓</span><div><b>Certificate trusted</b></div></div>
      <div class="step now"><span class="step-n">3</span><div><b>Pair with your PC</b><p>Name this phone, then type the code from Settings › Phone › Show a code.</p>
      <form data-form="pair" class="pair-form"><input class="name" name="name" autocomplete="off" spellcheck="false" maxlength="40" placeholder="Name, like Work iPhone" required>
      <div class="pair-row"><input class="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="ABCD2345" required>
      <button class="button" type="submit">Pair</button></div></form>
      <p>A name this PC knows already means that phone again: its old pairing goes.</p><p class="error" data-error></p></div></div>`);
  }
  show('<header class="bar"><h1 data-title>Termilly</h1><span class="conn" data-conn></span></header><main id="home" class="tabbed"></main><div id="nav"></div><div id="sheet"></div><div class="toast" data-toast hidden></div>');
  connect();
  render();
  // The phone allows alerts already but the PC has none for this pairing (it's new): on again, without asking.
  if (canAlert() && !me?.alerts && Notification.permission === GRANTED) turnOn();
}

// ---- Home ----

/** @param {Terminal} t */
function cardHtml(t) {
  const w = /** @type {Waiting} */ (t.waiting);
  const ws = wsOf(t.ws);
  const what = w.kind === WAITING.permission ? `Allow ${esc(w.tool)}${w.target ? `: <code>${esc(w.target)}</code>` : '?'}` : esc(w.text);
  const actions = w.kind === WAITING.permission
    ? `<button class="btn danger" data-do="${DO.answer}" data-choice="${CHOICE.reject}" data-id="${t.id}">Reject</button><button class="btn primary" data-do="${DO.answer}" data-choice="${CHOICE.approve}" data-id="${t.id}">Approve</button>`
    : `<button class="btn" data-do="${DO.reply}" data-id="${t.id}">Reply</button><button class="btn" data-do="${DO.term}" data-id="${t.id}">Open</button>`;
  return `<div class="waiting" data-do="${DO.open}" data-id="${t.id}">
    <div class="w-head">${badge(t)}<span class="w-title">${esc(t.title)}</span><span class="w-ws">${esc(ws?.name)} · ${age(w.at)}</span></div>
    <div class="w-text">${what}</div><div class="w-actions">${actions}</div></div>`;
}

/** @param {Terminal} t */
function rowHtml(t) {
  return `<div class="row" data-do="${DO.term}" data-id="${t.id}">${badge(t)}<div class="r-text"><div class="r-name">${esc(t.title)}</div><div class="r-line">${esc(t.line ?? '')}</div></div><span class="activity-slot">${activityHtml(t)}</span></div>`;
}

/** The phone's answer when it allows alerts. */
const GRANTED = 'granted';
/** Whether this phone can take alerts at all (iOS: 16.4 or later, opened from the Home Screen). */
const canAlert = () => hasWorker && 'PushManager' in window && 'Notification' in window;

/** This phone's alerts: on (test, off), off (turn on), or why it can't have them. */
function alertsBody() {
  return `${!canAlert() ? `<p class="muted">${ios ? 'Alerts need iOS 16.4 or later, and Termilly opened from the Home Screen.' : 'This browser can\'t take alerts.'}</p>`
    : me?.alerts ? `<p>Alerts are on.</p><div class="w-actions"><button class="btn" data-do="${DO.test}">Send a test alert</button><button class="btn" data-do="${DO.off}">Turn off</button></div>`
      : `<p>Get an alert here when an agent needs you, even when the phone is locked.</p><div class="w-actions"><button class="btn primary" data-do="${DO.on}">Turn on alerts</button></div>`}
    <p class="muted" data-note></p>`;
}

const alertsHtml = () => `<div class="section">This phone</div><div class="list pad">${alertsBody()}</div>`;

/** The size the terminal's text is (pinched to, or set here). */
const textSize = () => Number(localStorage.getItem(TEXT_SIZE.key)) || TEXT_SIZE.readable;

/**
 * One step bigger or smaller.
 * @param {number} step 1 or -1
 */
function stepText(step) {
  const now = textSize();
  const next = step > 0 ? TEXT_SIZES.find(s => s > now) : [...TEXT_SIZES].reverse().find(s => s < now);
  if (next) localStorage.setItem(TEXT_SIZE.key, String(next));
  render();
}

/** What the Notifications tab needs of a terminal. */
const noteParts = {
  badge: (/** @type {string} */ id) => { const t = terminal(id); return t ? badge(t) : ''; },
  title: (/** @type {string} */ id) => terminal(id)?.title ?? 'Closed terminal',
  ws: (/** @type {string} */ id) => wsOf(terminal(id)?.ws ?? '')?.name ?? '',
  age, waiting: (/** @type {string} */ id) => !!terminal(id)?.waiting, open: DO.open, term: DO.term,
};

/** The Terminals tab: what waits for you, then each workspace's terminals. */
function terminalsHtml() {
  const waiting = snap.terminals.filter(t => t.waiting).sort((a, b) => (b.waiting?.at ?? 0) - (a.waiting?.at ?? 0));
  const groups = snap.workspaces.map(w => ({ w, list: snap.terminals.filter(t => t.ws === w.id) })).filter(g => g.list.length);
  // Alerts not on yet (a new pairing starts without): asked first.
  return (canAlert() && !me?.alerts ? alertsHtml() : '')
    + (waiting.length ? `<div class="section">Waiting for you · ${waiting.length}</div>${waiting.map(cardHtml).join('')}` : '')
    + (!snap.terminals.length ? `<p class="muted center">${connected ? 'No terminals open on your PC.' : 'Connecting to your PC.'}</p>` : '')
    + groups.map(({ w, list }) => `<div class="ws"><span class="dot" style="background:${esc(w.color || DEFAULT_COLOR)}"></span>${esc(w.name)}<span class="count">${list.length}</span></div>
      <div class="list">${list.map(rowHtml).join('')}</div>`).join('');
}

function render() {
  const home = document.getElementById('home');
  if (!home) return;
  const conn = app.querySelector('[data-conn]');
  if (conn) conn.textContent = connected ? '' : 'Reconnecting';
  const title = app.querySelector('[data-title]');
  const onThemes = tab === TAB.settings && themesPage;
  if (title) title.textContent = onThemes ? 'Themes' : /** @type {Record<string, string>} */ (TITLE)[tab];
  home.innerHTML = tab === TAB.notes ? notesHtml(snap.notes ?? [], noteParts)
    : onThemes ? themesHtml(looks(snap), chosenLook())
    : tab === TAB.settings ? settingsHtml({ alerts: alertsBody(), size: textSize(), scrolling: localStorage.getItem(SCROLLING.key) ?? SCROLLING.smooth, host: location.host, connected, look: chosenLook(), looks: looks(snap) })
    : terminalsHtml();
  /** @type {HTMLElement} */ (document.getElementById('nav')).innerHTML = navHtml(tab, snap.notes?.length ?? 0);
  renderSheet();
}

// ---- The answer sheet (design D) ----

function renderSheet() {
  const sheet = document.getElementById('sheet');
  if (!sheet) return;
  const t = sheetFor ? terminal(sheetFor) : null;
  if (!t) {
    sheet.innerHTML = '';
    return;
  }
  // Typing a reply: the sheet stays as it is while the PC's news comes in.
  if (replying && sheet.querySelector('textarea') === document.activeElement) return;
  const ws = wsOf(t.ws);
  const w = t.waiting;
  const head = `<div class="grabber" data-do="${DO.close}"></div><div class="s-head">${badge(t)}<div><h2>${esc(t.title)}</h2><div class="meta"><span class="dot" style="background:${esc(ws?.color || DEFAULT_COLOR)}"></span> ${esc(ws?.name)}${w ? ` · ${age(w.at)}` : ''}</div></div></div>`;
  let body;
  if (w?.kind === WAITING.permission) {
    body = `<div class="meta">Claude wants to use ${esc(w.tool)}</div>${w.target ? `<div class="mono">${esc(w.target)}</div>` : ''}
      ${t.production ? '<p class="warn">This terminal is tagged prod.</p>' : ''}
      <button class="ibtn fill" data-do="${DO.answer}" data-choice="${CHOICE.approve}" data-id="${t.id}">Approve</button>
      ${w.always ? `<button class="ibtn" data-do="${DO.answer}" data-choice="${CHOICE.always}" data-id="${t.id}">Approve and don't ask again</button>` : ''}
      <button class="ibtn red" data-do="${DO.answer}" data-choice="${CHOICE.reject}" data-id="${t.id}">Reject</button>`;
  } else if (w) {
    body = `<div class="meta">${w.kind === WAITING.error ? 'Stopped with an error' : 'Waiting for you'}</div><div class="said">${esc(w.text)}</div>`;
  } else {
    body = `<div class="meta">${esc(t.line || 'Nothing waiting here.')}</div>`;
  }
  const reply = w ? (replying
    ? `<textarea class="reply-box" rows="3" placeholder="Tell Claude what to do" data-reply></textarea><button class="ibtn fill" data-do="${DO.send}" data-id="${t.id}">Send</button>`
    : `<button class="ibtn" data-do="${DO.reply}" data-id="${t.id}">Reply</button>`) : '';
  sheet.innerHTML = `<div class="dim" data-do="${DO.close}"></div><div class="sheet">${head}${body}${reply}</div>`;
  if (replying) /** @type {HTMLTextAreaElement | null} */ (sheet.querySelector('textarea'))?.focus();
}

/** @param {string | null} id @param {boolean} [reply] */
function openSheet(id, reply = false) {
  sheetFor = id;
  replying = reply;
  renderSheet();
}

// ---- The live connection ----

function connect() {
  live = new WebSocket(`wss://${location.host}${API.live}`);
  live.addEventListener('open', () => {
    connected = true;
    retry = RETRY_MS;
    render();
    // Back after a drop: the terminal shown starts over with what it printed lately.
    terminalShown.rewatch();
  });
  live.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.type === LIVE.state) {
      snap = m.state?.terminals ? m.state : { workspaces: [], terminals: [] };
      restyle();
      render();
      if (terminalShown.viewing) terminalShown.update(terminal(terminalShown.viewing), !!snap.typing);
    } else if (m.type === LIVE.screen || m.type === LIVE.output) {
      terminalShown.message(m);
    } else if (m.type === LIVE.answered) {
      // Only a failure is said; an answer that went through just closes its sheet.
      if (!m.ok) toast(m.error || 'That didn\'t go through.');
      else if (m.op !== OP.input && m.pane === sheetFor) openSheet(null);
    }
  });
  live.addEventListener('close', () => {
    connected = false;
    render();
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, RETRY_MAX_MS);
  });
}

/**
 * @param {string} pane
 * @param {string} choice
 * @param {string} [text]
 */
function answer(pane, choice, text = '') {
  if (!connected || !live) return toast('Not connected to your PC.');
  live.send(JSON.stringify({ op: OP.answer, pane, choice, text }));
}

/** @param {string} text */
function toast(text) {
  const el = /** @type {HTMLElement | null} */ (app.querySelector('[data-toast]'));
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(setTimeout(() => { el.hidden = true; }, TOAST_MS));
}

// ---- Alerts ----

/** Alerts on: the phone's permission, a push subscription with Termilly's key, and the PC told where to send. */
async function turnOn() {
  const note = /** @type {HTMLElement} */ (app.querySelector('[data-note]'));
  try {
    if (await Notification.requestPermission() !== GRANTED) {
      note.textContent = 'Alerts are blocked for Termilly in this phone\'s settings.';
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: keyBytes(/** @type {string} */ (me?.pushKey)),
    });
    await call(API.push, subscription.toJSON());
    me = await call(API.me);
    render();
  } catch (e) {
    note.textContent = `Alerts didn't turn on: ${/** @type {Error} */ (e).message}`;
  }
}

async function turnOff() {
  const registration = await navigator.serviceWorker.ready;
  await (await registration.pushManager.getSubscription())?.unsubscribe();
  await call(API.pushOff, {});
  me = await call(API.me);
  render();
}

async function test() {
  const { inSeconds } = await call(API.pushTest, {});
  toast(`Lock your phone: the alert comes in ${inSeconds} seconds.`);
}

// ---- Wiring ----

/** Unpairs this phone, when the user says so: the PC forgets it, and the app asks for a code again. */
async function unpair() {
  if (!window.confirm('Unpair this phone? You\'ll need a new code from the PC to use it again.')) return;
  await turnOff().catch(() => {});
  await call(API.forget, {});
  location.reload();
}

app.addEventListener('click', e => {
  const pick = /** @type {HTMLElement} */ (e.target).closest('[data-look]')?.getAttribute('data-look');
  if (pick) {
    chooseLook(pick);
    restyle();
    render();
    return;
  }
  const to = /** @type {HTMLElement} */ (e.target).closest('[data-tab]')?.getAttribute('data-tab');
  if (to) {
    tab = to;
    themesPage = false;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const target = /** @type {HTMLElement} */ (e.target).closest('[data-do]');
  if (!target) return;
  const id = target.getAttribute('data-id') ?? '';
  switch (target.getAttribute('data-do')) {
    case DO.retry: start(); break;
    case DO.on: turnOn(); break;
    case DO.off: turnOff(); break;
    case DO.test: test(); break;
    case DO.open: openSheet(id); break;
    case DO.term: {
      const t = terminal(id);
      if (t) terminalShown.open(t, !!snap.typing);
      break;
    }
    case DO.close: openSheet(null); break;
    case DO.reply: openSheet(id, true); break;
    case DO.answer: answer(id, /** @type {string} */ (target.getAttribute('data-choice'))); break;
    case SETTING.smaller: stepText(-1); break;
    case SETTING.bigger: stepText(1); break;
    case SETTING.unpair: unpair(); break;
    case SETTING.scrolling:
      localStorage.setItem(SCROLLING.key, target.dataset.scrolling ?? SCROLLING.smooth);
      render();
      break;
    case SETTING.themes:
    case SETTING.back:
      themesPage = target.dataset.do === SETTING.themes;
      render();
      window.scrollTo(0, 0);
      break;
    case DO.send: {
      const text = /** @type {HTMLTextAreaElement | null} */ (app.querySelector('[data-reply]'))?.value.trim() ?? '';
      if (text) answer(id, CHOICE.reply, text);
      break;
    }
    default: break;
  }
  e.stopPropagation();
});

app.addEventListener('submit', async e => {
  e.preventDefault();
  const form = /** @type {HTMLFormElement} */ (e.target);
  const code = /** @type {HTMLInputElement} */ (form.elements.namedItem('code')).value;
  const name = /** @type {HTMLInputElement} */ (form.elements.namedItem('name')).value;
  try {
    await call(API.pair, { code, name });
    await start();
  } catch {
    /** @type {HTMLElement} */ (app.querySelector('[data-error]')).textContent = `That code didn't work: ${code} is wrong or old. Show a new one on the PC.`;
  }
});

// The ages on the cards ("2m") move on while the app is open.
setInterval(() => { if (!replying) render(); }, AGE_EVERY_MS);

/** The terminal view (terminal.js): it talks over the live connection, and its Answer opens the sheet. */
/** The look as chosen, on the page and the terminal view (again whenever the PC's theme may have changed). */
function restyle() {
  terminalShown.retheme(applyLook(snap));
}

const terminalShown = terminalView({
  snippets: () => snap.snippets ?? [],
  send: message => { if (live?.readyState === OPEN) live.send(JSON.stringify(message)); },
  toast,
  answer: id => openSheet(id),
  wsName: id => wsOf(id)?.name ?? '',
});

if (hasWorker) navigator.serviceWorker.register('/sw.js');
start();
