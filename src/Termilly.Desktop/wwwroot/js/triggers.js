// @ts-check
// Triggers and alerts, for work that isn't an agent: regular expressions run over each new output line
// (highlight it, keep it in the captured-lines panel, notify, or ask for attention), set for every terminal, a tag
// or a shell; and one-off alerts on a terminal: when its command finishes, when it goes quiet, or when it prints.

import { state, on, emit, wsById, tabTitle, agentChanged, EVENTS } from './store.js';
import { openPopover, closePopover } from './popups.js';
import { escapeHtml, countText } from './ui.js';
import { AGENT_STATE, AGENT_SOURCE, SETTING_VALUES } from './constants.js';
import { byId, targetOf } from './dom.js';
import { lineFrom } from './buffer.js';

/**
 * A line a trigger captured: the terminal, the line, its xterm marker, when, and the trigger's name.
 * @typedef {{ tab: Tab, text: string, marker: any, at: number, trigger: string }} Capture
 */

const MAX_CAPTURES = 300;
const NOTIFY_EVERY = 10000;
const QUIET_AFTER = 30000;
/** Most rows one look reads (a burst of output is matched from its end). */
const MAX_SCAN_ROWS = 200;
/** Output this soon after "when it prints" was set is the menu's own echo, not news. */
const OUTPUT_GRACE_MS = 500;
/** How much of a trigger's colour a highlighted line's background takes (0: none, 1: all of it). */
const HIGHLIGHT_STRENGTH = 0.28;
/** How much of the matching line an alert's message quotes, in characters. */
const ALERT_TEXT_CHARS = 140;
/** Where a #rrggbb colour's red, green and blue start, and the base they're written in. */
const RGB_AT = [1, 3, 5];
const HEX = 16;
/** Rows above a captured line when the terminal scrolls to it. */
const ROWS_ABOVE = 3;

/** The choices of the settings used here (C#'s SettingValues). */
const { triggerAction, triggerScope } = SETTING_VALUES;

// ---- Settings: the triggers ----

/**
 * Compiled triggers, rebuilt when Settings change: { trigger, regex }. A bad pattern is skipped.
 * @type {{ trigger: TriggerSetting, regex: RegExp }[]}
 */
let compiled = [];

export function compileTriggers() {
  compiled = (state.settings.commands.triggers ?? []).filter(t => t.enabled !== false && t.pattern).flatMap(trigger => {
    try {
      return [{ trigger, regex: new RegExp(trigger.pattern, trigger.caseSensitive ? '' : 'i') }];
    } catch {
      return []; // Settings shows the pattern as invalid
    }
  });
}

/**
 * Whether a trigger's scope covers a terminal: every terminal, one tag, or one shell profile.
 * @param {TriggerSetting} trigger
 * @param {Tab} tab
 */
function inScope(trigger, tab) {
  const scope = trigger.scope ?? triggerScope.default;
  if (scope === triggerScope.all) return true;
  if (scope.startsWith(triggerScope.tagPrefix)) return tab.tags.includes(scope.slice(triggerScope.tagPrefix.length));
  if (scope.startsWith(triggerScope.profilePrefix)) return tab.profile === scope.slice(triggerScope.profilePrefix.length);
  return false;
}

// ---- Scanning output ----

/**
 * Where a terminal's trigger scan is (tab.scan): its next row, a cleared screen, each trigger's last alert.
 * @typedef {{ line: number, cleared: boolean, alertedAt: Record<string, number> }} TriggerScan
 */

/**
 * Where a terminal's scan has got to, kept here: the next row to look at, whether the screen was cleared since the
 * last look, and when each trigger last raised an alert there (a burst of matches is one alert).
 * @param {Tab} tab
 */
const scanOf = tab => (tab.scan ??= { line: 0, cleared: false, alertedAt: {} });

/**
 * The output so far isn't news: the scan goes on from this row (after a command line, a restored screen).
 * @param {Tab} tab
 * @param {number} row
 */
export function scanFrom(tab, row) {
  scanOf(tab).line = row;
}

/**
 * The screen was cleared (CSI 2J or 3J): the scan starts again at its top, once the output is parsed.
 * @param {Tab} tab
 */
export function screenCleared(tab) {
  scanOf(tab).cleared = true;
}

/**
 * Looks at the lines a terminal completed since the last look (called after xterm parses output). Only whole
 * lines are matched, rows the terminal wrapped joined back up; the line being typed or printed isn't yet.
 * @param {Tab} tab
 */
export function scanOutput(tab) {
  const term = tab.view?.term;
  if (!term) return;
  noteActivity(tab);
  if (!compiled.length) return;
  const buffer = term.buffer.normal;
  const end = buffer.baseY + buffer.cursorY; // the cursor's line isn't finished
  const scan = scanOf(tab);
  if (scan.cleared) {
    scan.cleared = false;
    scan.line = buffer.baseY;
  }
  // Where the shell marks its commands, only a running command's output counts: not the prompt, nor what's
  // being typed at it (a long command wraps into finished rows).
  if (tab.shellMarks && !tab.running) {
    scan.line = Math.max(scan.line, end);
    return;
  }
  let y = Math.max(scan.line, end - MAX_SCAN_ROWS, 0);
  if (y >= end) return;
  for (; y < end; y++) {
    const text = lineFrom(buffer, y, end);
    if (!text?.trim()) continue;
    for (const { trigger, regex } of compiled) {
      if (inScope(trigger, tab) && regex.test(text)) fire(tab, trigger, text, y);
    }
  }
  scan.line = end;
}

/**
 * @param {Tab} tab
 * @param {TriggerSetting} trigger
 * @param {string} text
 * @param {number} y
 */
function fire(tab, trigger, text, y) {
  const { term } = /** @type {TabView} */ (tab.view);
  const action = trigger.action ?? triggerAction.default;
  const marker = term.registerMarker(y - (term.buffer.normal.baseY + term.buffer.normal.cursorY));
  if (action === triggerAction.highlight || action === triggerAction.capture) {
    const color = trigger.color ?? '#f2cc60';
    const decoration = marker && term.registerDecoration({
      marker, x: 0, width: term.cols, backgroundColor: blend(color, term.options.theme?.background ?? '#000000', HIGHLIGHT_STRENGTH), layer: 'bottom',
      overviewRulerOptions: { color, position: 'center' },
    });
    decoration?.onRender((/** @type {HTMLElement} */ el) => { el.title = trigger.name || trigger.pattern; });
  }
  if (action === triggerAction.capture) capture(tab, trigger, text, marker);
  if (action === triggerAction.notify || action === triggerAction.attention) {
    const now = Date.now();
    const { alertedAt } = scanOf(tab);
    if (now - (alertedAt[trigger.id] ?? 0) < NOTIFY_EVERY) return; // a burst of matches is one alert
    alertedAt[trigger.id] = now;
    raiseAlert(tab, `${trigger.name || trigger.pattern}: ${text.trim().slice(0, ALERT_TEXT_CHARS)}`);
  }
}

/**
 * A colour mixed into the background (decorations take no transparency).
 * @param {string} color
 * @param {string} background
 * @param {number} amount
 */
function blend(color, background, amount) {
  /** @param {string} hex */
  const rgb = hex => RGB_AT.map(i => parseInt(hex.slice(i, i + 2), HEX));
  const [a, b] = [rgb(color), rgb(background)];
  return `#${a.map((c, i) => Math.round(b[i] + (c - b[i]) * amount).toString(HEX).padStart(2, '0')).join('')}`;
}

// ---- Captured lines ----

/**
 * Lines captured by triggers, newest last: { tab, text, marker, at, trigger }.
 * @type {Capture[]}
 */
const captures = [];

/**
 * @param {Tab} tab
 * @param {TriggerSetting} trigger
 * @param {string} text
 * @param {any} marker
 */
function capture(tab, trigger, text, marker) {
  captures.push({ tab, text: text.trim(), marker, at: Date.now(), trigger: trigger.name || trigger.pattern });
  if (captures.length > MAX_CAPTURES) captures.shift();
  updateCaptureCount();
}

const panel = byId('captures');
/** The list keeps the captures it shows (_items), for its clicks. */
const list = /** @type {HTMLElement & { _items?: Capture[] }} */ (byId('captures-list'));
const buttons = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-open-captures]'));

function liveCaptures() {
  return captures.filter(c => state.tabs.has(c.tab.id));
}

function updateCaptureCount() {
  const n = liveCaptures().length;
  for (const b of buttons) {
    b.hidden = n === 0;
    const count = b.querySelector('.cap-count');
    if (count) count.textContent = countText(n);
  }
  if (!panel.hidden) renderCaptures();
}

function renderCaptures() {
  const items = liveCaptures().reverse();
  list.innerHTML = items.length ? items.map((c, i) => `
    <button class="cap-item" data-capture="${i}">
      <span class="cap-text">${escapeHtml(c.text)}</span>
      <span class="cap-meta">${escapeHtml(tabTitle(c.tab))} · ${escapeHtml(wsById(c.tab.wsId)?.name ?? '')} · ${escapeHtml(c.trigger)} · ${new Date(c.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
    </button>`).join('') : '<div class="inbox-empty">Nothing captured yet. Add a trigger with “Keep in the list” in Settings › Terminal.</div>';
  list._items = items;
}

/** @param {HTMLElement} [anchor] */
export function toggleCaptures(anchor) {
  if (closePopover(panel)) return;
  openPopover(panel, anchor ?? buttons[0], { side: anchor?.closest('.side-rail') ? 'right' : 'below' });
  renderCaptures();
}

list.addEventListener('click', e => {
  const item = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-capture]'));
  if (!item) return;
  const c = list._items?.[Number(item.dataset.capture)];
  if (!c) return;
  closePopover(panel);
  emit(EVENTS.showTab, c.tab);
  if (c.marker && !c.marker.isDisposed) /** @type {TabView} */ (c.tab.view).term.scrollToLine(Math.max(0, c.marker.line - ROWS_ABOVE));
});
byId('captures-clear').addEventListener('click', () => {
  captures.length = 0;
  updateCaptureCount();
});
for (const b of buttons) b.addEventListener('click', () => toggleCaptures(b));

// ---- Alerts on one terminal ----

/**
 * Asks for attention: the terminal's amber dot and inbox entry, and a Windows notification if it's out of sight.
 * @param {Tab} tab
 * @param {string} message
 */
export function raiseAlert(tab, message) {
  tab.agent = { ...tab.agent, state: AGENT_STATE.attention, source: tab.agent?.source ?? AGENT_SOURCE.alert, message, at: Date.now() };
  agentChanged(tab); // notify.js sends the Windows notification when the terminal is out of sight
}

/**
 * A terminal's one-off alerts (tab.alerts), when one was last set, and the quiet timer.
 * @typedef {{ finish: boolean, quiet: boolean, output: boolean, setAt: number, quietTimer: number }} OneOffAlerts
 */

/**
 * The alerts a terminal is set to raise once, kept here: when its command finishes, when it's quiet, when it prints;
 * when one was last set, and the quiet timer.
 * @param {Tab} tab
 */
const alertsOf = tab => (tab.alerts ??= { finish: false, quiet: false, output: false, setAt: 0, quietTimer: 0 });

/** The one-off alerts a terminal can be set to raise: when its command finishes, when it's quiet, when it prints. */
export const ALERT = Object.freeze({ finish: 'finish', quiet: 'quiet', output: 'output' });

/**
 * Sets (or, by default, flips) one of a terminal's one-off alerts (ALERT).
 * @param {Tab} tab
 * @param {'finish' | 'quiet' | 'output'} kind
 * @param {boolean} [on]
 */
export function setAlert(tab, kind, on = !tab.alerts?.[kind]) {
  const alerts = alertsOf(tab);
  alerts[kind] = on;
  alerts.setAt = Date.now();
  if (kind === 'quiet') armQuiet(tab);
  emit(EVENTS.tab, tab);
}

/**
 * A command the shell marked has ended (commands.js): the "when it finishes" alert fires.
 * @param {Tab} tab
 * @param {string} command
 * @param {number | null} exitCode
 */
export function commandFinished(tab, command, exitCode) {
  if (!tab.alerts?.finish) return;
  tab.alerts.finish = false;
  raiseAlert(tab, `${exitCode ? `Failed (exit ${exitCode})` : 'Finished'}: ${command || 'the command'}`);
  emit(EVENTS.tab, tab);
}

/**
 * Output arrived: "when it prints" fires, and the quiet timer starts over.
 * @param {Tab} tab
 */
function noteActivity(tab) {
  if (tab.alerts?.output && Date.now() - tab.alerts.setAt > OUTPUT_GRACE_MS) {
    tab.alerts.output = false;
    raiseAlert(tab, 'New output');
    emit(EVENTS.tab, tab);
  }
  if (tab.alerts?.quiet) armQuiet(tab);
}

/** @param {Tab} tab */
function armQuiet(tab) {
  clearTimeout(tab.alerts?.quietTimer);
  if (!tab.alerts?.quiet) return;
  tab.alerts.quietTimer = setTimeout(() => {
    if (!tab.alerts?.quiet || !state.tabs.has(tab.id)) return;
    tab.alerts.quiet = false;
    raiseAlert(tab, `Quiet for ${QUIET_AFTER / 1000} seconds`);
    emit(EVENTS.tab, tab);
  }, QUIET_AFTER);
}

on(EVENTS.workspaces, updateCaptureCount);
