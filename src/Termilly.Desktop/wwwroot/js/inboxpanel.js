// @ts-check
// The notification center, docked on the right of the terminals (the title bar's button, Ctrl+Shift+A): the notes of
// js/inbox.js in groups by what they ask of the user (Needs you, Errors, Finished, Schedules). A permission is answered
// here (Allow, Deny) and a question gets a reply; a click on a note goes to its terminal, and the panel stays.

import { state, persist, emit, wsById, tabTitle, EVENTS } from './store.js';
import { allNotes, watchNotes, isLive, clear, button } from './inbox.js';
import { answerAgent, awaitsPermission, isWaiting, ANSWER } from './agentanswer.js';
import { tabBadgeHtml, escapeHtml, activityHtml, ICONS } from './ui.js';
import { restoreFocus } from './panes.js';
import { arriveAt } from './arrived.js';
import { scheduleFit } from './terminals.js';
import { isShortcut, KEY_ID } from './keymap.js';
import { AGENT_STATE } from './constants.js';
import { byId, targetOf, dockRight, titleIconHtml, WORKSPACE_ID, DOCK_GRIP } from './dom.js';
import { SECOND_MS, DAY_S, MINUTE_S, HOUR_S } from './util.js';

/** The groups, top to bottom: what needs the user first. */
const LANE = Object.freeze({ needsYou: 'needs-you', errors: 'errors', finished: 'finished', schedules: 'schedules' });
const LANES = [[LANE.needsYou, 'Needs you'], [LANE.errors, 'Errors'], [LANE.finished, 'Finished'], [LANE.schedules, 'Schedules']];
const ACTION = Object.freeze({ clearAll: 'clearAll', close: 'close' });
/** An entry in the list, and an entry's reply box. */
const ITEM = '.inbox-item';
const ROW = '.inbox-row';
const CLEAR_LABEL = 'Clear';
const REPLY = '.inbox-reply';
const LIST = '.inbox-lanes';
/** How long an entry's age reads "now", in seconds. */
const NOW_BELOW_S = 45;
const NOW_LABEL = 'now';
/** How often the open panel is redrawn, so the ages move on. */
const REDRAW_MS = 30 * SECOND_MS;
/** Its narrowest width (app.css has its width until it's dragged). */
const MIN_WIDTH_PX = 280;
const KEYS_TEXT = 'Ctrl+Shift+A';

/**
 * A row in a group: its group, when, its markup, and what clearing it clears.
 * @typedef {{ lane: string, at: number, html: string, key: string }} Entry
 */

/** What was typed in a reply box, by note (kept across redraws). @type {Map<string, string>} */
const drafts = new Map();
/** Why an answer couldn't be typed, by note. @type {Map<string, string>} */
const failures = new Map();

const panel = document.createElement('aside');
panel.id = 'inbox';
panel.className = 'inbox-panel';
panel.setAttribute('aria-label', 'Notification center');
panel.hidden = true;
panel.tabIndex = -1;
byId(WORKSPACE_ID).append(panel);

/**
 * "now", "4m", "2h", "3d": how long it has been waiting.
 * @param {number | null | undefined} at
 */
function age(at) {
  const s = Math.max(0, (Date.now() - (at ?? Date.now())) / SECOND_MS);
  if (s < NOW_BELOW_S) return NOW_LABEL;
  if (s < HOUR_S) return `${Math.round(s / MINUTE_S)}m`;
  if (s < DAY_S) return `${Math.round(s / HOUR_S)}h`;
  return `${Math.round(s / DAY_S)}d`;
}

/** @param {string} state */
const laneOf = state => (state === AGENT_STATE.error ? LANE.errors : state === AGENT_STATE.done ? LANE.finished : LANE.needsYou);

/**
 * Its answer, for a note whose terminal still waits on it: Allow and Deny for a permission, else a reply box.
 * @param {import('./inbox.js').Note} n
 * @param {Tab} tab
 */
function answerHtml(n, tab) {
  if (!isLive(n) || !isWaiting(tab) || tab.agent?.state === AGENT_STATE.error) return '';
  const key = escapeHtml(n.key);
  const fail = failures.get(n.key);
  const body = awaitsPermission(tab)
    ? `<button class="btn small primary" data-answer="${ANSWER.approve}" data-f="${key}:a">Allow</button><button class="btn small" data-answer="${ANSWER.reject}" data-f="${key}:r">Deny</button>`
    : `<input class="field inbox-reply" placeholder="Reply" spellcheck="false" autocomplete="off" data-f="${key}:t" value="${escapeHtml(drafts.get(n.key) ?? '')}"><button class="btn small" data-answer="${ANSWER.reply}" data-f="${key}:s">Send</button>`;
  return `<div class="inbox-answer">${body}</div>${fail ? `<div class="inbox-fail">${escapeHtml(fail)}</div>` : ''}`;
}

/** @param {string} key @param {string} label */
const clearHtml = (key, label = CLEAR_LABEL) => `<button class="pane-btn inbox-clear" data-clear="${escapeHtml(key)}" title="${label}" aria-label="${label}">${ICONS.close}</button>`;

/** @param {import('./inbox.js').Note} n @returns {Entry} */
function noteEntry(n) {
  const tab = /** @type {Tab} */ (state.tabs.get(n.tabId));
  const ws = wsById(tab.wsId);
  const html = `<div class="inbox-row" data-key="${escapeHtml(n.key)}" data-pane="${tab.id}"><button class="inbox-item${isLive(n) ? ' unread' : ''}" data-tab="${tab.id}" data-f="${escapeHtml(n.key)}:i">
      ${activityHtml(n.activity, 'inbox-state')}
      <span class="inbox-text">
        <span class="inbox-title">${tabBadgeHtml(tab)}<span class="name">${escapeHtml(tabTitle(tab))}</span>
          <span class="inbox-ws"><span class="ws-dot" style="background:${ws?.color ?? 'var(--muted)'}"></span>${escapeHtml(ws?.name ?? '')}</span>
          ${tab.tags.slice(0, 2).map(t => `<span class="inbox-tag">${escapeHtml(t)}</span>`).join('')}
          <span class="inbox-age">${age(n.at)}</span></span>
        <span class="inbox-detail">${escapeHtml(n.detail)}</span>
      </span>
    </button>${clearHtml(n.key)}${answerHtml(n, tab)}</div>`;
  return { lane: laneOf(n.state), at: n.at, html, key: n.key };
}

/** @param {import('./inbox.js').ScheduleNote} n @returns {Entry} */
const scheduleEntry = n => ({
  lane: n.failed ? LANE.errors : LANE.schedules, at: n.at, key: n.id,
  html: `<div class="inbox-row"><button class="inbox-item unread" data-run="${escapeHtml(n.id)}" data-f="${escapeHtml(n.id)}:i">
    <span class="inbox-text">
      <span class="inbox-title"><span class="name">${escapeHtml(n.title)}</span><span class="inbox-age">${age(n.at)}</span></span>
      <span class="inbox-detail">${escapeHtml(n.detail)}</span>
    </span>
  </button>${clearHtml(n.id)}</div>`,
});

/** Every entry, newest first. */
function entries() {
  const { notes, scheduleNotes } = allNotes();
  return [...notes.map(noteEntry), ...scheduleNotes.map(scheduleEntry)].sort((a, b) => b.at - a.at);
}

const folded = () => new Set(state.inbox.folded ?? []);

/**
 * A group: its head (fold, name, count, Clear) and, unless folded, its entries. Nothing when it has none.
 * @param {string} lane @param {string} title @param {Entry[]} rows @param {Set<string>} closed
 */
function laneHtml(lane, title, rows, closed) {
  if (!rows.length) return '';
  const open = !closed.has(lane);
  return `<section class="inbox-lane" data-lane="${lane}">
    <div class="inbox-lane-head"><button class="inbox-fold" data-fold="${lane}" aria-expanded="${open}">${open ? ICONS.chevronDown : ICONS.chevronRight}<span class="inbox-lane-name">${title}</span><span class="inbox-lane-count">${rows.length}</span></button>
      <button class="btn small inbox-lane-clear" data-clear-lane="${lane}">${CLEAR_LABEL}</button></div>
    ${open ? rows.map(r => r.html).join('') : ''}</section>`;
}

/** What has the focus in the list (an entry, a button, a reply box and its caret), to give it back after a redraw. */
function focusNow() {
  const el = /** @type {HTMLElement | null} */ (document.activeElement);
  if (!el || !panel.contains(el) || !el.dataset.f) return null;
  const input = el instanceof HTMLInputElement ? el : null;
  return { f: el.dataset.f, start: input?.selectionStart ?? null, end: input?.selectionEnd ?? null };
}

/** @param {ReturnType<typeof focusNow>} was */
function giveFocusBack(was) {
  if (!was) return;
  const el = /** @type {HTMLElement | null} */ ([...panel.querySelectorAll('[data-f]')].find(x => /** @type {HTMLElement} */ (x).dataset.f === was.f) ?? null);
  el?.focus();
  if (el instanceof HTMLInputElement && was.start !== null) el.setSelectionRange(was.start, was.end);
}

function draw() {
  if (panel.hidden) return;
  const all = entries();
  // Drafts and errors of notes that are gone go with them.
  for (const kept of [drafts, failures]) for (const key of kept.keys()) if (!all.some(e => e.key === key)) kept.delete(key);
  const was = focusNow();
  const scroll = /** @type {HTMLElement | null} */ (panel.querySelector(LIST))?.scrollTop ?? 0;
  const closed = folded();
  const lanes = LANES.map(([lane, title]) => laneHtml(lane, title, all.filter(e => e.lane === lane), closed)).join('');
  panel.innerHTML = `
    <div class="${DOCK_GRIP}" title="Drag to resize"></div>
    <div class="files-head">
      ${titleIconHtml(button)}
      <span class="files-title">Notification center <span class="files-ws">${all.length}</span></span>
      <span class="files-tools">
        <button class="pane-btn" data-inbox="${ACTION.clearAll}" title="Clear all"${all.length ? '' : ' disabled'}>${ICONS.trash}</button>
        <button class="pane-btn" data-inbox="${ACTION.close}" title="Close (${KEYS_TEXT})">${ICONS.close}</button>
      </span>
    </div>
    <div class="inbox-lanes">${lanes || '<div class="inbox-empty">No notifications.</div>'}</div>`;
  /** @type {HTMLElement} */ (panel.querySelector(LIST)).scrollTop = scroll;
  giveFocusBack(was);
}

/** @param {boolean} open */
function setOpen(open) {
  panel.hidden = !open;
  button.classList.toggle('open', open);
  if (state.inbox.open !== open) {
    state.inbox.open = open;
    persist();
  }
  draw();
}

/** Opens or closes the notification center; opened, the newest entry has the keys. */
export function toggleInbox() {
  setOpen(panel.hidden === true);
  if (panel.hidden) return restoreFocus();
  /** @type {HTMLElement | null} */ (panel.querySelector(ITEM))?.focus();
}

/** The panel as it was left when Termilly closed: open or not, and its width (main.js, once the saved state is in). */
export function initInbox() {
  if (state.inbox.width) panel.style.width = `${state.inbox.width}px`;
  if (state.inbox.open) setOpen(true);
}

/** @param {string} lane */
function toggleFold(lane) {
  const closed = folded();
  if (!closed.delete(lane)) closed.add(lane);
  state.inbox.folded = [...closed];
  persist();
  draw();
}

/**
 * Types an answer into a note's terminal; why it couldn't shows under it.
 * @param {HTMLElement} row
 * @param {string} choice
 */
async function answer(row, choice) {
  const key = /** @type {string} */ (row.dataset.key);
  const text = /** @type {HTMLInputElement | null} */ (row.querySelector(REPLY))?.value;
  failures.delete(key);
  try {
    await answerAgent({ pane: row.dataset.pane, choice, text });
    drafts.delete(key);
  } catch (e) {
    failures.set(key, /** @type {Error} */ (e).message);
  }
  draw();
}

/** @param {HTMLElement} el */
function onAction(el) {
  const row = /** @type {HTMLElement | null} */ (el.closest(ROW));
  if (el.dataset.answer && row) answer(row, el.dataset.answer);
  else if (el.dataset.clear) clear(el.dataset.clear);
  else if (el.dataset.clearLane) clear(entries().filter(e => e.lane === el.dataset.clearLane).map(e => e.key));
  else if (el.dataset.fold) toggleFold(el.dataset.fold);
  else if (el.dataset.inbox === ACTION.clearAll) clear(null);
  else if (el.dataset.inbox === ACTION.close) toggleInbox();
  else if (el.dataset.run) emit(EVENTS.openSchedules, { runId: el.dataset.run });
  else if (el.dataset.tab) {
    const tab = state.tabs.get(el.dataset.tab);
    if (tab) arriveAt(tab);
  }
}

panel.addEventListener('click', e => {
  const el = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-answer], [data-clear], [data-clear-lane], [data-fold], [data-inbox], [data-run], [data-tab]'));
  if (el) onAction(el);
});
panel.addEventListener('input', e => {
  const box = targetOf(e);
  const key = /** @type {HTMLElement | null} */ (box.closest(ROW))?.dataset.key;
  if (key && box instanceof HTMLInputElement) drafts.set(key, box.value);
});

/**
 * Up and Down go from entry to entry.
 * @param {KeyboardEvent} e
 */
function moveFocus(e) {
  const items = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll(ITEM)]);
  const step = e.key === 'ArrowDown' ? 1 : -1;
  items[(items.indexOf(/** @type {HTMLElement} */ (document.activeElement)) + step + items.length) % items.length]?.focus();
}

panel.addEventListener('keydown', e => {
  const plain = !e.ctrlKey && !e.shiftKey && !e.altKey;
  const inReply = targetOf(e).matches(REPLY);
  if (e.key === 'Escape' && plain) restoreFocus();
  else if (e.key === 'Enter' && plain && inReply) answer(/** @type {HTMLElement} */ (targetOf(e).closest(ROW)), ANSWER.reply);
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !inReply) moveFocus(e);
  else if (isShortcut(e, KEY_ID.inbox)) toggleInbox();
  else return;
  e.preventDefault();
  e.stopPropagation();
});

button.addEventListener('click', () => toggleInbox());
watchNotes(draw);
dockRight(panel, {
  dockVar: '--inbox-dock', minWidth: MIN_WIDTH_PX, resized: scheduleFit,
  dragged: width => { state.inbox.width = width; persist(); },
});
// Ages move on while the panel is open (not while a reply is typed: a redraw keeps it, but there's no need).
setInterval(() => { if (!panel.hidden && !document.activeElement?.matches(REPLY)) draw(); }, REDRAW_MS);
