// @ts-check
// The notification center: every terminal whose agent is waiting for the user, failed, or finished out of sight, most
// urgent first, with one key (Ctrl+Shift+J) to go to the next one.

import { HOST, PAGE } from './protocol.js';
import { onHost, send } from './host.js';
import { state, on, wsById, tabTitle, isUnread, EVENTS } from './store.js';
import { openPopover, closePopover, isOpen } from './popups.js';
import { tabBadgeHtml, escapeHtml, activityHtml, countText } from './ui.js';
import { activityOf } from './store.js';
import { focusTab, focusedTab } from './panes.js';
import { AGENT_STATE, CLAUDE_TOOL } from './constants.js';
import { byId, find, targetOf } from './dom.js';
import { SECOND_MS, DAY_S, MINUTE_S, HOUR_S } from './util.js';

/** The inbox's filters (their data-filter). */
const FILTER = Object.freeze({ all: 'all', unread: 'unread', errors: 'errors' });
/** An entry in the list. */
const ITEM = '.inbox-item';
/** How long an entry's age reads "now", in seconds. */
const NOW_BELOW_S = 45;
const NOW_LABEL = 'now';
/** How often the open panel is redrawn, so the ages move on. */
const REDRAW_MS = 30 * SECOND_MS;

/**
 * A terminal in the inbox, and how urgent it is (rank(): lower first).
 * @typedef {{ tab: Tab, rank: number | null }} InboxEntry
 */

/** The count the taskbar button shows (0: none). */
let badge = 0;

/**
 * Keeps the taskbar button's count in step with the inbox.
 * @param {number} count
 */
export function updateBadge(count) {
  if (count === badge) return;
  badge = count;
  send(PAGE.badge, { count });
}

const panel = byId('inbox');
const list = byId('inbox-list');
const filtersEl = byId('inbox-filters');
const button = byId('inbox-button');
const count = find(button, '.tool-count');
const totalEl = byId('inbox-total');

const FILTERS = [[FILTER.all, 'All'], [FILTER.unread, 'Unread'], [FILTER.errors, 'Errors']];
/** @type {string} */
let filter = FILTER.all;

/**
 * How urgent an agent's state is (lower first); null when it isn't inbox material.
 * @param {Tab} tab
 */
function rank(tab) {
  const a = tab.agent;
  if (!a) return null;
  if (a.state === AGENT_STATE.needsInput || a.state === AGENT_STATE.attention) return 0;
  if (a.state === AGENT_STATE.error) return 1;
  if (a.state === AGENT_STATE.done && a.unread) return 2;
  return null;
}

/**
 * Inbox entries, most urgent first and, within that, waiting longest first.
 * @returns {InboxEntry[]}
 */
export function inboxEntries() {
  // The filter leaves only entries with a rank, and those are terminals with an agent.
  return [...state.tabs.values()]
    .map(tab => ({ tab, rank: rank(tab) }))
    .filter(e => e.rank !== null)
    .sort((x, y) => /** @type {number} */ (x.rank) - /** @type {number} */ (y.rank)
      || (/** @type {AgentInfo} */ (x.tab.agent).at ?? 0) - (/** @type {AgentInfo} */ (y.tab.agent).at ?? 0));
}

/** @param {InboxEntry} e */
const matches = e => filter === FILTER.all || (filter === FILTER.unread ? isUnread(e.tab) || e.rank === 0 : /** @type {AgentInfo} */ (e.tab.agent).state === AGENT_STATE.error);

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

/**
 * What the entry says: the question, the error, or the agent's last words.
 * @param {Tab} tab
 */
export function entryDetail(tab) {
  const a = /** @type {AgentInfo} */ (tab.agent);
  if (a.state === AGENT_STATE.needsInput && a.tool && a.tool !== CLAUDE_TOOL.askUserQuestion) return `Allow ${a.tool}?`;
  if (a.state === AGENT_STATE.error) return a.reason || a.message || 'Stopped with an error';
  return a.message || (a.state === AGENT_STATE.done ? 'Finished' : 'Waiting for you');
}

function render() {
  const all = inboxEntries();
  count.textContent = countText(all.length);
  count.hidden = !all.length;
  updateBadge(all.length);
  button.classList.toggle('has-items', all.length > 0);
  const total = `${all.length} notification${all.length === 1 ? '' : 's'}`;
  button.title = `Notification center: ${total} (Ctrl+Shift+A)`;
  totalEl.textContent = total;
  if (panel.hidden) return;

  filtersEl.innerHTML = FILTERS.map(([id, label]) =>
    `<button class="seg-btn${id === filter ? ' on' : ''}" data-filter="${id}">${label}</button>`).join('');
  const shown = all.filter(matches);
  list.innerHTML = shown.length ? shown.map(({ tab }) => {
    const ws = wsById(tab.wsId);
    return `<button class="inbox-item${isUnread(tab) ? ' unread' : ''}" data-tab="${tab.id}">
      ${activityHtml(activityOf(tab), 'inbox-state')}
      <span class="inbox-text">
        <span class="inbox-title">${tabBadgeHtml(tab)}<span class="name">${escapeHtml(tabTitle(tab))}</span>
          <span class="inbox-ws"><span class="ws-dot" style="background:${ws?.color ?? 'var(--muted)'}"></span>${escapeHtml(ws?.name ?? '')}</span>
          ${tab.tags.slice(0, 2).map(t => `<span class="inbox-tag">${escapeHtml(t)}</span>`).join('')}
          <span class="inbox-age">${age(/** @type {AgentInfo} */ (tab.agent).at)}</span></span>
        <span class="inbox-detail">${escapeHtml(entryDetail(tab))}</span>
      </span>
    </button>`;
  }).join('') : `<div class="inbox-empty">${all.length ? 'Nothing in this view.' : 'No notifications.'}</div>`;
}

export function toggleInbox() {
  if (closePopover(panel)) return;
  openPopover(panel, button);
  render();
  /** @type {HTMLElement | null} */ (list.querySelector(ITEM))?.focus();
}

/**
 * Goes to the next terminal that needs the user, after the one focused now, wrapping round. Returns false when
 * nothing does.
 */
export function jumpToNext() {
  const entries = inboxEntries();
  if (!entries.length) return false;
  const current = entries.findIndex(e => e.tab === focusedTab());
  focusTab(entries[(current + 1) % entries.length].tab);
  return true;
}

button.addEventListener('click', toggleInbox);
filtersEl.addEventListener('click', e => {
  const b = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-filter]'));
  if (!b) return;
  filter = /** @type {string} */ (b.dataset.filter);
  render();
});
list.addEventListener('click', e => {
  const item = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tab]'));
  if (!item) return;
  closePopover(panel);
  focusTab(/** @type {Tab} */ (state.tabs.get(/** @type {string} */ (item.dataset.tab))));
});
panel.addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = /** @type {HTMLElement[]} */ ([...list.querySelectorAll(ITEM)]);
  const step = e.key === 'ArrowDown' ? 1 : -1;
  items[(items.indexOf(/** @type {HTMLElement} */ (document.activeElement)) + step + items.length) % items.length]?.focus();
});

// The global shortcut (Settings › Terminal) brought the window forward; pick the terminal.
onHost(HOST.agentsNext, () => jumpToNext());

on(EVENTS.tab, render);
on(EVENTS.workspaces, render);
// Ages move on while the panel is open.
setInterval(() => { if (isOpen(panel)) render(); }, REDRAW_MS);
