// @ts-check
// The output viewer: a command's output in a panel built for reading it: filter (text or /regex/) with lines of
// context, quick filters for error, warning and info lines, follow (stick to the bottom while it runs) and pause,
// wrap, line numbers, and JSON lines shown pretty and foldable. The output comes from the terminal's own buffer,
// between the command's OSC 133 marks, so nothing extra is captured; a running command (docker logs -f) is
// followed live. Long output is drawn a screenful at a time, as the change preview does.

import { on, tabTitle, EVENTS } from './store.js';
import { escapeHtml, ICONS } from './ui.js';
import { scheduleFit } from './terminals.js';
import { dropdown } from './popups.js';
import { debounce, SECOND_MS } from './util.js';
import { sendToAgent } from './together.js';
import { byId, find, field, targetOf, WORKSPACE_ID } from './dom.js';
import { continuesOnNextRow } from './buffer.js';

/** @typedef {import('./commands.js').CommandRun} CommandRun */
/**
 * What's open: the terminal, the command run, and the view's options.
 * @typedef {{ tab: Tab, run: CommandRun, live: boolean, follow: boolean, wrap: boolean, json: boolean,
 *   levels: Set<string> }} ViewerView
 */
/**
 * A line to show: its number, text and level, whether the filter matched it, and whether lines were left out before.
 * @typedef {{ n: number, text: string, level: string, match: boolean, gap: boolean }} ViewerRow
 */

/** The viewer's buttons and toggles, by their data-vw. */
const ACTION = Object.freeze({
  agent: 'agent', copy: 'copy', save: 'save', close: 'close', follow: 'follow', wrap: 'wrap', json: 'json',
});
/** A line's level, as levelOf finds it and the quick filters pick it (data-level). */
const LEVEL = Object.freeze({ error: 'error', warn: 'warn', info: 'info' });
/** The viewer's class while lines wrap. */
const WRAP_CLASS = 'wrap';
/** The filter field, the context menu and the command's name in the header. */
const FILTER = '.vw-filter';
const CONTEXT = '.vw-context';
const COMMAND_NAME = '.vw-name';

/** A row's height in pixels while long output is drawn a screenful at a time. */
const LINE_HEIGHT_PX = 18;
/** More lines than this (without wrap, JSON or gaps) are drawn a screenful at a time. */
const VIRTUAL_AFTER = 2000;
/** How many lines are drawn above and below the screenful. */
const OVERSCAN_LINES = 50;
/** The panel's height to draw for before it has one. */
const FALLBACK_HEIGHT_PX = 600;
/** How near the bottom, in pixels, still counts as at the bottom. */
const BOTTOM_SLACK_PX = 4;
/** How many of a JSON object's keys its folded summary shows. */
const SUMMARY_KEYS = 4;
/** The output looks like JSON lines when more than JSON_SNIFF_MIN of its first JSON_SNIFF_LINES start with '{'. */
const JSON_SNIFF_LINES = 50;
const JSON_SNIFF_MIN = 10;
/** How long after opening the filter takes focus. */
const FOCUS_DELAY_MS = 50;
/** How long after a command ends its end mark is there to read up to. */
const END_DELAY_MS = 50;
/** How long a saved file's object URL is kept for the download to start. */
const REVOKE_DELAY_MS = SECOND_MS;
/** Every place the filter's text shows, in any case. */
const EVERY_MATCH_ANY_CASE = 'gi';

const workspaceEl = byId(WORKSPACE_ID);
const panel = document.createElement('aside');
panel.className = 'viewer-panel';
panel.hidden = true;
panel.innerHTML = `
  <div class="pane viewer">
    <div class="pane-header vw-head">
      <span class="pane-title"><span class="vw-icon">${ICONS.terminal}</span><span class="pane-name vw-name"></span><span class="vw-live" hidden>live</span></span>
      <span class="vw-count"></span>
      <span class="pane-actions">
        <button class="pane-btn vw-btn vw-send" data-vw="agent" title="Paste what's shown into an agent's prompt">Send to agent</button>
        <button class="pane-btn vw-btn" data-vw="copy" title="Copy what's shown">${ICONS.copy}</button>
        <button class="pane-btn vw-btn" data-vw="save" title="Save to a file">${ICONS.folder}</button>
        <button class="pane-btn vw-btn" data-vw="close" title="Close (Esc)">${ICONS.close}</button>
      </span>
    </div>
    <div class="vw-bar">
      <input class="field vw-filter" placeholder="Filter: text, or /regex/" spellcheck="false">
      <select class="field vw-context" title="Lines of context around each match">
        <option value="0">No context</option><option value="2">±2 lines</option><option value="5">±5 lines</option>
      </select>
      <span class="vw-levels">
        <button data-level="error">Errors</button><button data-level="warn">Warnings</button><button data-level="info">Info</button>
      </span>
      <span class="vw-toggles">
        <button data-vw="follow" title="Stick to the bottom as new output comes">Follow</button>
        <button data-vw="wrap">Wrap</button>
        <button data-vw="json" title="Show JSON lines pretty, folded">JSON</button>
      </span>
    </div>
    <div class="vw-scroll"><div class="vw-spacer"><div class="vw-rows"></div></div><div class="vw-empty" hidden></div></div>
  </div>`;
workspaceEl.append(panel);
// The app's own menu, not Windows' list.
dropdown(/** @type {HTMLSelectElement} */ (panel.querySelector(CONTEXT)));

/** @param {string} sel */
const $ = sel => find(panel, sel);
const scroller = $('.vw-scroll');
const spacer = $('.vw-spacer');
const rowsEl = $('.vw-rows');

/**
 * What's open: the terminal, the command run (its markers), and the view's options.
 * @type {ViewerView | null}
 */
let view = null;
/** @type {string[]} */
let lines = [];
/** @type {ViewerRow[]} */
let shown = [];
let lastRange = '';

export const isViewerOpen = () => !panel.hidden;

// ---- Reading the output ----

/**
 * The run's output lines, from its output marker to its end (or the cursor, while it runs).
 * @param {Tab} tab
 * @param {CommandRun} run
 */
function readLines(tab, run) {
  const buffer = tab.view?.term?.buffer.active;
  if (!buffer || !run?.outputMarker || run.outputMarker.isDisposed) return [];
  const start = run.outputMarker.line + (run.outputOffset ?? 0);
  const end = run.endMarker && !run.endMarker.isDisposed ? run.endMarker.line : buffer.baseY + buffer.cursorY + 1;
  /** @type {string[]} */
  const rows = [];
  let joinNext = false;
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(false);
    if (joinNext && rows.length) rows[rows.length - 1] += text;
    else rows.push(text);
    joinNext = continuesOnNextRow(buffer, y, /** @type {TabView} */ (tab.view).term.cols);
  }
  const out = rows.map(r => r.trimEnd());
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/** A log line's level, from the usual words and formats (ERROR, [warn], level=info, "level":"error").
 * @param {string} text
 */
export function levelOf(text) {
  if (/\b(error|err|fatal|critical|crit|exception|panic|failed|failure)\b|"level"\s*:\s*"(error|fatal)"|level=(error|fatal)/i.test(text)) return LEVEL.error;
  if (/\b(warn|warning|deprecated)\b|"level"\s*:\s*"warn/i.test(text)) return LEVEL.warn;
  if (/\b(info|notice|debug|trace)\b|"level"\s*:\s*"(info|debug)"/i.test(text)) return LEVEL.info;
  return '';
}

/** A filter as a test: /regex/flags, or plain text (case doesn't matter). Null when it's empty or broken.
 * @param {string} query
 * @returns {((text: string) => boolean) | null}
 */
function matcher(query) {
  const q = query.trim();
  if (!q) return null;
  const re = /^\/(.+)\/([gimsuy]*)$/.exec(q);
  if (re) {
    try {
      const r = new RegExp(re[1], re[2].replace('g', '') || 'i');
      return t => r.test(t);
    } catch {
      return () => false;
    }
  }
  const lower = q.toLowerCase();
  return t => t.toLowerCase().includes(lower);
}

/** The lines to show: [{ n, text, level, match, gap }] after the filter, levels and context. */
function filtered() {
  const test = matcher(field(panel, FILTER).value);
  const levels = /** @type {ViewerView} */ (view).levels;
  const context = Number(/** @type {HTMLSelectElement} */ ($(CONTEXT)).value);
  const keep = new Uint8Array(lines.length); // 1 match, 2 context
  const levelAt = lines.map(levelOf);
  let any = false;
  for (let i = 0; i < lines.length; i++) {
    const okLevel = !levels.size || levels.has(levelAt[i]);
    const okText = !test || test(lines[i]);
    if (okLevel && okText) {
      keep[i] = 1;
      any = true;
      if (test || levels.size) for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) if (!keep[j]) keep[j] = 2;
    }
  }
  /** @type {ViewerRow[]} */
  const out = [];
  let previous = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    out.push({ n: i + 1, text: lines[i], level: levelAt[i], match: keep[i] === 1 && (!!test || levels.size > 0), gap: previous >= 0 && i > previous + 1 });
    previous = i;
  }
  return any || (!test && !levels.size) ? out : [];
}

// ---- Drawing ----

/** A JSON line shown pretty and folded: its first keys on the summary, the whole object when opened.
 * @param {string} text
 */
function jsonHtml(text) {
  const t = text.trim();
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return null;
  let value;
  try { value = JSON.parse(t); } catch { return null; }
  const pretty = JSON.stringify(value, null, 2);
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).slice(0, SUMMARY_KEYS).map(([k, v]) => `<span class="vw-k">${escapeHtml(k)}</span>=<span class="vw-v">${escapeHtml(typeof v === 'object' ? (Array.isArray(v) ? `[${v.length}]` : '{…}') : String(v)).slice(0, 60)}</span>`).join(' ')
    : `[${value.length}]`;
  return `<details class="vw-json"><summary>${keys}</summary><pre>${colourJson(escapeHtml(pretty))}</pre></details>`;
}

/** @param {string} html */
const colourJson = html => html
  .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="vw-k">$1</span>$2')
  .replace(/: (&quot;.*?&quot;)/g, ': <span class="vw-s">$1</span>')
  .replace(/: (-?\d[\d.eE+-]*|true|false|null)/g, ': <span class="vw-n">$1</span>');

/** @param {string} html */
function highlightMatch(html) {
  const q = field(panel, FILTER).value.trim();
  if (!q || /^\/.+\/[gimsuy]*$/.test(q)) return html;
  const safe = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(safe, EVERY_MATCH_ANY_CASE), m => `<mark>${m}</mark>`);
}

/** @param {ViewerRow} r */
function rowHtml(r) {
  const body = (/** @type {ViewerView} */ (view).json && jsonHtml(r.text)) || highlightMatch(escapeHtml(r.text) || ' ');
  return `${r.gap ? '<div class="vw-gap">⋯</div>' : ''}<div class="vw-row ${r.level}${r.match ? ' hit' : ''}"><span class="vw-no">${r.n}</span><span class="vw-text">${body}</span></div>`;
}

/** Everything wraps or folds (rows of different heights) only when it's short; long output is drawn in screenfuls. */
const virtual = () => !/** @type {ViewerView} */ (view).wrap && !/** @type {ViewerView} */ (view).json
  && shown.length > VIRTUAL_AFTER && !shown.some(r => r.gap);

function render({ keepScroll = true } = {}) {
  if (!view) return;
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - BOTTOM_SLACK_PX;
  shown = filtered();
  $('.vw-count').textContent = shown.length === lines.length ? `${lines.length.toLocaleString()} lines` : `${shown.filter(r => r.match).length.toLocaleString()} of ${lines.length.toLocaleString()} lines`;
  const empty = $('.vw-empty');
  empty.hidden = shown.length > 0;
  empty.textContent = lines.length ? 'No lines match.' : 'No output yet.';
  find(panel, '.viewer').classList.toggle(WRAP_CLASS, view.wrap);
  lastRange = '';
  if (virtual()) {
    spacer.style.height = `${shown.length * LINE_HEIGHT_PX}px`;
    drawVisible();
  } else {
    spacer.style.height = '';
    rowsEl.style.transform = '';
    rowsEl.innerHTML = shown.map(rowHtml).join('');
  }
  if (view.follow && (atBottom || !keepScroll)) scroller.scrollTop = scroller.scrollHeight;
}

function drawVisible() {
  if (!view || !virtual()) return;
  const top = scroller.scrollTop;
  const height = scroller.clientHeight || FALLBACK_HEIGHT_PX;
  const first = Math.max(0, Math.floor(top / LINE_HEIGHT_PX) - OVERSCAN_LINES);
  const last = Math.min(shown.length, Math.ceil((top + height) / LINE_HEIGHT_PX) + OVERSCAN_LINES);
  const range = `${first}:${last}`;
  if (range === lastRange) return;
  lastRange = range;
  rowsEl.style.transform = `translateY(${first * LINE_HEIGHT_PX}px)`;
  rowsEl.innerHTML = shown.slice(first, last).map(rowHtml).join('');
}

let frame = 0;
scroller.addEventListener('scroll', () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(drawVisible);
  // Scrolling up pauses following; back at the bottom resumes it.
  if (view && view.live) {
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - BOTTOM_SLACK_PX;
    if (view.follow !== atBottom) { view.follow = atBottom; syncToggles(); }
  }
});

function syncToggles() {
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('[data-level]'))) {
    b.classList.toggle('on', /** @type {ViewerView} */ (view).levels.has(/** @type {string} */ (b.dataset.level)));
  }
  for (const name of /** @type {const} */ ([ACTION.follow, ACTION.wrap, ACTION.json])) {
    find(panel, `[data-vw="${name}"]`).classList.toggle('on', !!(/** @type {ViewerView} */ (view)[name]));
  }
  find(panel, '[data-vw="follow"]').hidden = !(/** @type {ViewerView} */ (view).live);
  $('.vw-live').hidden = !(/** @type {ViewerView} */ (view).live);
}

// ---- Opening, following, closing ----

/**
 * Opens a command's output: `run` is one of the terminal's commands (tab.running while it runs, tab.lastCommand,
 * or one from commandLog(tab)); without it, the running command or else the last one.
 * @param {Tab | null} tab
 * @param {CommandRun} [run]
 */
export function openViewer(tab, run = tab?.running ?? tab?.lastCommand ?? undefined) {
  if (!tab || !run) return false;
  view = { tab, run, live: run === tab.running, follow: run === tab.running, wrap: false, json: false, levels: new Set() };
  lines = readLines(tab, run);
  view.json = lines.slice(0, JSON_SNIFF_LINES).filter(l => l.trim().startsWith('{')).length > JSON_SNIFF_MIN; // looks like JSON lines
  $(COMMAND_NAME).textContent = run.command?.trim() || 'Command output';
  $(COMMAND_NAME).title = `${run.command ?? ''}\n${tabTitle(tab)}`;
  field(panel, FILTER).value = '';
  panel.hidden = false;
  syncToggles();
  render({ keepScroll: false });
  if (!view.live) scroller.scrollTop = 0;
  scheduleFit();
  setTimeout(() => $(FILTER).focus(), FOCUS_DELAY_MS);
  return true;
}

export function closeViewer() {
  if (panel.hidden) return;
  panel.hidden = true;
  view = null;
  lines = [];
  rowsEl.innerHTML = '';
  scheduleFit();
}

// A running command's new output arrives as the terminal parses it.
/** How long a running command's output settles before the view shows it. */
const FOLLOW_DELAY = 150;
const followLater = debounce(/** @param {Tab} tab */ tab => {
  lines = readLines(tab, /** @type {ViewerView} */ (view).run);
  render();
}, FOLLOW_DELAY);
on(EVENTS.terminalOpened, tab => tab.view.term.onWriteParsed(() => {
  if (view?.live && view.tab === tab) followLater(tab);
}));
// When it ends, the view keeps what it printed, up to its end mark.
on(EVENTS.commandEnding, ({ tab }) => {
  if (!view?.live || view.tab !== tab) return;
  setTimeout(() => {
    if (!view || view.tab !== tab) return;
    view.run = tab.lastCommand ?? view.run;
    view.live = false;
    lines = readLines(tab, view.run);
    syncToggles();
    render();
  }, END_DELAY_MS);
});

panel.addEventListener('input', e => { if (targetOf(e).matches(FILTER)) render({ keepScroll: false }); });
panel.addEventListener('change', e => { if (targetOf(e).matches(CONTEXT)) render({ keepScroll: false }); });
panel.addEventListener('click', e => {
  const level = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-level]'));
  if (level) {
    const levels = /** @type {ViewerView} */ (view).levels;
    const name = /** @type {string} */ (level.dataset.level);
    levels.has(name) ? levels.delete(name) : levels.add(name);
    syncToggles();
    return render({ keepScroll: false });
  }
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-vw]'))?.dataset.vw;
  if (!action || !view) return;
  if (action === ACTION.close) closeViewer();
  if (action === ACTION.follow || action === ACTION.wrap || action === ACTION.json) {
    view[action] = !view[action];
    syncToggles();
    render({ keepScroll: action !== ACTION.follow });
  }
  if (action === ACTION.agent) sendToAgent(shown.map(r => r.text).join('\n'), { command: view.run.command, exitCode: view.run.exitCode, title: tabTitle(view.tab) }, targetOf(e).closest('[data-vw]'), view.tab);
  if (action === ACTION.copy) navigator.clipboard.writeText(shown.map(r => r.text).join('\r\n')).catch(() => {});
  if (action === ACTION.save) {
    const blob = new Blob([shown.map(r => r.text).join('\r\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(view.run.command ?? 'output').trim().split(/\s+/).slice(0, 3).join('-').replace(/[^\w.-]+/g, '_') || 'output'}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), REVOKE_DELAY_MS);
  }
});
panel.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); }
});

/** For the palette and API: what the viewer shows now. */
export const viewerState = () => (view ? { lines: lines.length, shown: shown.length, live: view.live, command: view.run.command } : null);

