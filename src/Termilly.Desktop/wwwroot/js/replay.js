// @ts-check
// Recording and replaying terminals: "Record" in a terminal's menu writes an asciicast v2 file (Recording.cs on the
// host; asciinema plays it too), with a mark for each command; "Open a recording…" plays one back here in a
// read-only terminal with play and pause, speed, a timeline with the command marks, and long idle gaps skipped. And
// "Rewind": the last few minutes of a running terminal's output, kept in memory, played back the same way, to see
// how the screen looked a moment ago.

import { send, onHost } from './host.js';
import { PAGE, HOST } from './protocol.js';
import { state, on, emit, tabTitle, EVENTS } from './store.js';
import { modal } from './dialogs.js';
import { escapeHtml, ICONS, formatWhen } from './ui.js';
import { consoleDefaults } from './consolecolors.js';
import { AGENT_STATE } from './constants.js';
import { find, targetOf } from './dom.js';
import { SECOND_MS, MINUTE_MS, MINUTE_S } from './util.js';
import { TERM_FONT_VAR } from './themes.js';

/** A terminal's size when it has none to give (no view yet, or a recording that doesn't say). */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** What warnings about recordings start with in the console. */
const LOG_PREFIX = 'recording';
/** A command's mark on the timeline: at most this many characters, and this when the command has no text. */
const MAX_MARK_CHARS = 200;
const MARK_FALLBACK = 'command';
/** What the menu item and the player call a replay of the recent output. */
const REWIND_LABEL = 'Rewind';
/** Gaps longer than this, in seconds, are idle; skipping idle gaps plays each in this many seconds. */
const IDLE_GAP_S = 2;
const IDLE_PLAYS_S = 0.5;
/** The player's terminal: its scrollback, in lines, and its background (the terminal's own black). */
const PLAYER_SCROLLBACK = 2000;
const PLAYER_BACKGROUND = '#0a0a0a';
/** The steps of the timeline's slider. */
const SEEK_STEPS = 1000;
/** The player's parts. */
const SCREEN = '.rp-screen';
const SEEK = '.rp-seek';
/** The player's buttons (their data-rp). */
const ACTION = Object.freeze({ text: 'text', reveal: 'reveal', close: 'close', play: 'play', idle: 'idle' });

/**
 * An asciicast event: seconds from the start, its kind ('o' output, 'r' resize, 'm' mark) and its data.
 * @typedef {[number, string, string]} CastEvent
 */

/**
 * A recording to play: the asciicast header's size and title, and its events.
 * @typedef {{ header: { width?: number, height?: number, title?: string }, events: CastEvent[] }} Cast
 */

/**
 * The player's state: the read-only terminal, the events with their play times, and where playing has got to.
 * @typedef {{ term: any, events: CastEvent[], path: string | null, rewind: boolean, speed: number, playing: boolean,
 *   skipIdle: boolean, at: number, index: number, last: number, frame: number, times: number[], duration: number }} Player
 */

/**
 * A file in the recordings folder, as the host lists it.
 * @typedef {{ name: string, path: string, size: number, at: number }} RecordingFile
 */

/**
 * A rec:data message, whichever of its shapes (Host_recData) it has.
 * @typedef {{ path: string | null, name?: string, text?: string, error?: string }} RecData
 */

// ---- Recording ----

/**
 * A terminal's recording (tab.recording): the file (null while it isn't recording), and whether an agent terminal
 * started one by itself already.
 * @typedef {{ path: string | null, asked: boolean }} Recording
 */
/**
 * A terminal's recent output (tab.rewind): [time, text] chunks, and how many characters they hold.
 * @typedef {{ events: Array<[number, string]>, bytes: number }} RewindBuffer
 */

/** A terminal's recording, kept here: the file it writes (null while it isn't recording), and whether an agent
 * terminal started one by itself already.
 * @param {Tab} tab
 */
const recordingOf = tab => (tab.recording ??= { path: null, asked: false });

/**
 * The file a terminal records to, or null.
 * @param {Tab} tab
 */
export const recordingFile = tab => tab.recording?.path ?? null;

/** @param {Tab} tab */
export const isRecording = tab => !!recordingFile(tab);

/** @param {Tab} tab */
export function toggleRecording(tab) {
  if (isRecording(tab)) return send(PAGE.recStop, { id: tab.id });
  const term = tab.view?.term;
  send(PAGE.recStart, { id: tab.id, cols: term?.cols ?? DEFAULT_COLS, rows: term?.rows ?? DEFAULT_ROWS, title: tabTitle(tab), seed: screenNow(term) });
}

/**
 * What's on screen as the recording starts (as plain text, and where the cursor is), so a replay starts from
 * the same screen rather than an empty one.
 * @param {any} term
 */
function screenNow(term) {
  if (!term) return '';
  const b = term.buffer.active;
  /** @type {string[]} */
  const rows = [];
  for (let y = b.viewportY; y < b.viewportY + term.rows; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return `\x1b[H\x1b[2J${rows.join('\r\n')}\x1b[${b.cursorY + 1};${b.cursorX + 1}H`;
}

onHost(HOST.recStatus, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  recordingOf(tab).path = m.path ?? null;
  if (/** @type {{ error?: string }} */ (m).error) console.warn(LOG_PREFIX, /** @type {{ error?: string }} */ (m).error);
  emit(EVENTS.tab, tab);
});

// Each command is a mark on the recording's timeline.
on(EVENTS.commandStarted, tab => {
  if (isRecording(tab)) send(PAGE.recMark, { id: tab.id, label: (tab.running?.command ?? '').trim().slice(0, MAX_MARK_CHARS) || MARK_FALLBACK });
});
// Agent terminals can record by themselves while the agent works (Settings › Terminal › Record agents).
on(EVENTS.agent, tab => {
  if (state.settings.recording.agents && tab?.agent?.state === AGENT_STATE.working && !isRecording(tab) && !tab.recording?.asked) {
    recordingOf(tab).asked = true;
    toggleRecording(tab);
  }
});

// ---- Rewind: recent output kept in memory ----

const REWIND_MS = 3 * MINUTE_MS;
const REWIND_BYTES = 4 << 20;

onHost(HOST.output, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  const buf = (tab.rewind ??= { events: [], bytes: 0 });
  const now = Date.now();
  buf.events.push([now, m.data]);
  buf.bytes += m.data.length;
  while (buf.events.length && (now - buf.events[0][0] > REWIND_MS || buf.bytes > REWIND_BYTES)) buf.bytes -= /** @type {[number, string]} */ (buf.events.shift())[1].length;
});

/**
 * A terminal's recent output as a recording, for the player.
 * @param {Tab} tab
 */
export function openRewind(tab) {
  const events = /** @type {[number, string][]} */ (tab.rewind?.events ?? []);
  if (!events.length) return;
  const start = events[0][0];
  const term = tab.view?.term;
  play({
    header: { width: term?.cols ?? DEFAULT_COLS, height: term?.rows ?? DEFAULT_ROWS, title: `${tabTitle(tab)} · the last ${Math.ceil((Date.now() - start) / MINUTE_MS)} min` },
    events: events.map(([t, data]) => /** @type {CastEvent} */ ([(t - start) / SECOND_MS, 'o', data])),
  }, { name: REWIND_LABEL, rewind: true });
}

// ---- Reading .cast files ----

/**
 * An asciicast v2 file: its header, and its events [seconds, kind, data]. Bad lines are skipped.
 * @param {string} text
 * @returns {Cast}
 */
export function parseCast(text) {
  const lines = String(text).split('\n').filter(l => l.trim());
  /** @type {Cast['header']} */
  let header = {};
  try { header = JSON.parse(lines[0]); } catch { /* no header */ }
  /** @type {CastEvent[]} */
  const events = [];
  for (const line of lines.slice(1)) {
    try {
      const e = JSON.parse(line);
      if (Array.isArray(e) && typeof e[0] === 'number') events.push(/** @type {CastEvent} */ (e));
    } catch { /* a line cut off at the end */ }
  }
  return { header, events };
}

/**
 * Times to play at: gaps over 2 s shrink to 0.5 s when idle gaps are skipped, so a recording of a long build
 * doesn't sit still for minutes.
 * @param {CastEvent[]} events
 * @param {boolean} skipIdle
 */
export function playTimes(events, skipIdle) {
  /** @type {number[]} */
  const times = [];
  let shift = 0;
  let previous = 0;
  for (const [t] of events) {
    if (skipIdle && t - previous > IDLE_GAP_S) shift += t - previous - IDLE_PLAYS_S;
    times.push(t - shift);
    previous = t;
  }
  return times;
}

// ---- The player ----

const layer = document.createElement('div');
layer.className = 'modal-layer replay-layer';
layer.hidden = true;
layer.innerHTML = `
  <div class="replay" role="dialog" aria-label="Replay">
    <div class="pane-header rp-head">
      <span class="pane-title"><span class="rp-icon">${ICONS.history}</span><span class="pane-name rp-name"></span><span class="rp-sub"></span></span>
      <span class="pane-actions">
        <button class="pane-btn rp-btn" data-rp="${ACTION.text}" title="Copy the screen as text">${ICONS.copy}</button>
        <button class="pane-btn rp-btn" data-rp="${ACTION.reveal}" title="Show the file">${ICONS.folder}</button>
        <button class="pane-btn rp-btn" data-rp="${ACTION.close}" title="Close (Esc)">${ICONS.close}</button>
      </span>
    </div>
    <div class="rp-screen"></div>
    <div class="rp-bar">
      <button class="btn small rp-play" data-rp="${ACTION.play}"></button>
      <span class="rp-time"></span>
      <div class="rp-track"><input type="range" class="rp-seek" min="0" max="${SEEK_STEPS}" value="0"><div class="rp-marks"></div></div>
      <span class="seg rp-speed"><button data-speed="1">1×</button><button data-speed="2">2×</button><button data-speed="5">5×</button></span>
      <label class="rp-idle"><input type="checkbox" data-rp="${ACTION.idle}" checked> Skip idle</label>
    </div>
  </div>`;
document.body.append(layer);
/**
 * The player's element a selector finds (the markup above always has it).
 * @param {string} sel
 */
const $ = sel => /** @type {HTMLElement} */ (layer.querySelector(sel));

/** @type {Player | null} */
let player = null;

/** @param {number} s */
const clock = s => `${Math.floor(s / MINUTE_S)}:${String(Math.floor(s % MINUTE_S)).padStart(2, '0')}`;

/**
 * @param {Cast} cast
 * @param {{ name?: string, path?: string | null, rewind?: boolean }} [options]
 */
function play(cast, { name, path = null, rewind = false } = {}) {
  closePlayer();
  const { header, events } = cast;
  const term = new Terminal({ cols: header.width || DEFAULT_COLS, rows: header.height || DEFAULT_ROWS, disableStdin: true, cursorBlink: false,
    scrollback: PLAYER_SCROLLBACK,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue(TERM_FONT_VAR) || 'Consolas, monospace',
    fontSize: state.settings.terminal.fontSize, theme: { background: PLAYER_BACKGROUND, black: PLAYER_BACKGROUND }, allowProposedApi: true });
  layer.hidden = false;
  term.open($(SCREEN));
  // Its play times and duration come next, from retime().
  player = /** @type {Player} */ ({
    term, events, path, rewind, speed: 1, playing: true, skipIdle: true, at: 0, index: 0, last: performance.now(), frame: 0,
  });
  $('.rp-name').textContent = header.title || name || 'Recording';
  $('.rp-sub').textContent = rewind ? 'rewind' : name ?? '';
  $(`[data-rp="${ACTION.reveal}"]`).hidden = !path;
  retime();
  tick();
}

/** Recomputes play times (after Skip idle changes) and the marks on the timeline. */
function retime() {
  const p = /** @type {Player} */ (player);
  p.times = playTimes(p.events, p.skipIdle);
  p.duration = p.times.length ? p.times[p.times.length - 1] : 0;
  $('.rp-marks').innerHTML = p.events.map((e, i) => (e[1] === 'm'
    ? `<i style="left:${p.duration ? (p.times[i] / p.duration) * 100 : 0}%" title="${escapeHtml(String(e[2]))}"></i>` : '')).join('');
  syncBar();
}

function syncBar() {
  const p = /** @type {Player} */ (player);
  $('.rp-play').textContent = p.playing ? 'Pause' : p.at >= p.duration ? 'Replay' : 'Play';
  $('.rp-time').textContent = `${clock(p.at)} / ${clock(p.duration)}`;
  // A number, which the range input takes as its value's text.
  /** @type {{ value: number }} */ (/** @type {unknown} */ ($(SEEK))).value = p.duration ? Math.round((p.at / p.duration) * SEEK_STEPS) : 0;
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (layer.querySelectorAll('[data-speed]'))) b.classList.toggle('on', Number(b.dataset.speed) === p.speed);
}

/** Writes the events up to the current time. */
function advance() {
  const p = /** @type {Player} */ (player);
  let chunk = '';
  while (p.index < p.events.length && p.times[p.index] <= p.at) {
    const [, kind, data] = p.events[p.index];
    if (kind === 'o') chunk += data;
    else if (kind === 'r' && /^\d+x\d+$/.test(data)) { if (chunk) { p.term.write(consoleDefaults(chunk)); chunk = ''; } const [c, r] = data.split('x').map(Number); p.term.resize(c, r); }
    p.index++;
  }
  if (chunk) p.term.write(consoleDefaults(chunk));
}

function tick() {
  const p = player;
  if (!p) return;
  const now = performance.now();
  if (p.playing) {
    p.at = Math.min(p.duration, p.at + ((now - p.last) / SECOND_MS) * p.speed);
    advance();
    if (p.at >= p.duration) p.playing = false;
    syncBar();
  }
  p.last = now;
  p.frame = requestAnimationFrame(tick);
}

/**
 * Jumps to a time: the screen is rebuilt from the start, at once.
 * @param {number} seconds
 */
function seek(seconds) {
  const p = /** @type {Player} */ (player);
  p.at = Math.max(0, Math.min(p.duration, seconds));
  p.term.reset();
  p.index = 0;
  advance();
  syncBar();
}

export function closePlayer() {
  if (!player) return;
  cancelAnimationFrame(player.frame);
  player.term.dispose();
  player = null;
  $(SCREEN).innerHTML = '';
  layer.hidden = true;
}

layer.addEventListener('click', e => {
  if (!player) return;
  const speed = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-speed]'));
  if (speed) { player.speed = Number(speed.dataset.speed); syncBar(); return; }
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-rp]'))?.dataset.rp;
  if (action === ACTION.close || e.target === layer) closePlayer();
  if (action === ACTION.play) {
    if (player.at >= player.duration) seek(0);
    player.playing = !player.playing;
    player.last = performance.now();
    syncBar();
  }
  if (action === ACTION.reveal && player.path) send(PAGE.recReveal, { path: player.path });
  if (action === ACTION.text) {
    const b = player.term.buffer.active;
    /** @type {string[]} */
    const rows = [];
    for (let y = b.viewportY; y < b.viewportY + player.term.rows; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
    navigator.clipboard.writeText(rows.join('\r\n').trimEnd()).catch(() => {});
  }
});
layer.addEventListener('input', e => {
  if (!player) return;
  if (targetOf(e).matches(SEEK)) seek((Number(/** @type {HTMLInputElement} */ (e.target).value) / SEEK_STEPS) * player.duration);
  if (targetOf(e).matches(`[data-rp="${ACTION.idle}"]`)) {
    const fraction = player.duration ? player.at / player.duration : 0;
    player.skipIdle = /** @type {HTMLInputElement} */ (e.target).checked;
    retime();
    seek(fraction * player.duration);
  }
});
document.addEventListener('keydown', e => {
  if (layer.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePlayer(); }
  if (e.key === ' ' && !targetOf(e).closest?.('input')) { e.preventDefault(); e.stopPropagation(); $(`[data-rp="${ACTION.play}"]`).click(); }
}, true);

// ---- Opening recordings ----

/** "Open a recording": the recordings folder's files, newest first. */
export function openRecordings() {
  send(PAGE.recList);
}

onHost(HOST.recList, m => {
  /** @type {RecordingFile[]} */
  const items = m.items ?? [];
  modal('recordings', `
    <h3>Recordings</h3>
    <div class="results-all">${items.length ? items.map((r, i) => `
      <button class="res-all-row" data-i="${i}"><span class="res-title">${escapeHtml(r.name)}</span>
        <span class="res-where">${(r.size / 1024).toFixed(0)} KB · ${escapeHtml(formatWhen(r.at))}</span></button>`).join('')
      : '<p class="set-desc">No recordings yet. “Record” in a terminal’s menu starts one.</p>'}</div>
    <div class="dialog-actions"><button class="btn" data-folder>Open the folder</button><span class="spacer"></span><button class="btn" data-cancel>Close</button></div>`, (dialog, close) => {
    find(dialog, '[data-folder]').addEventListener('click', () => { send(PAGE.recReveal); close(null); });
    dialog.addEventListener('click', e => {
      const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-i]'));
      if (!row) return;
      close(null);
      send(PAGE.recLoad, { path: items[Number(row.dataset.i)].path });
    });
    return { submit: () => /** @type {HTMLElement | null} */ (dialog.querySelector('[data-i]'))?.click() };
  });
});

onHost(HOST.recData, m => {
  if (/** @type {RecData} */ (m).error) return console.warn(LOG_PREFIX, /** @type {RecData} */ (m).error);
  play(parseCast(/** @type {string} */ (/** @type {RecData} */ (m).text)), { name: /** @type {RecData} */ (m).name, path: m.path });
});

/**
 * The terminal menu's part.
 * @param {Tab} tab
 */
export const replayMenuItems = tab => [
  { label: 'Record', checked: isRecording(tab), action: () => toggleRecording(tab) },
  ...(tab.rewind?.events.length ? [{ label: REWIND_LABEL, icon: ICONS.history, action: () => openRewind(tab) }] : []),
];

