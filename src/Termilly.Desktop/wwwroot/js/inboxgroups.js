// @ts-check
// The notification center's groups (design A, By workspace): one per workspace with something to say, in the
// sidebar's order, then the agents with no terminal and Schedules. Each folds away and clears on its own; the filter
// above them (All, Unread, Errors) narrows every group at once (js/inboxpanel.js draws them).

import { state } from './store.js';
import { escapeHtml, cssColor, ICONS } from './ui.js';
import { byId, titleIconHtml, SCHEDULES_BUTTON_ID } from './dom.js';

/**
 * A row: when, its markup, what clearing it clears, where it's from, how its dot looks, whether it's still news
 * (Unread), and whether it's a question still waiting (Clear leaves those: only their own × puts one away).
 * @typedef {{ at: number, html: string, key: string, tabId: string | null, schedule: boolean, dot: string,
 *   unread: boolean, waiting: boolean }} Entry
 */

/** The dots: waiting for the user, an error, finished or answered, a schedule's run, an update. */
export const DOT = Object.freeze({ ask: 'ask', error: 'err', done: 'done', schedule: 'sched', info: 'info' });
/** The filters above the groups. */
export const FILTER = Object.freeze({ all: 'all', unread: 'unread', errors: 'errors' });
const FILTERS = [[FILTER.all, 'All'], [FILTER.unread, 'Unread'], [FILTER.errors, 'Errors']];
/** The groups that aren't a workspace, and how a workspace's is named (a prefix and its id). */
const GROUP = Object.freeze({ workspace: 'ws:', agents: 'agents', schedules: 'schedules' });
const NAME = Object.freeze({ agents: 'Agents', schedules: 'Schedules' });

/**
 * A group: its id, what shows before its name, its name, and its rows.
 * @typedef {{ id: string, lead: string, name: string, rows: Entry[] }} Group
 */

/**
 * Whether an entry passes a filter.
 * @param {Entry} e
 * @param {string} filter
 */
export const passes = (e, filter) => filter === FILTER.unread ? e.unread : filter === FILTER.errors ? e.dot === DOT.error : true;

/** The filter to use: the one picked, if it's still one. */
export function shownFilter() {
  const picked = state.inbox.filter ?? '';
  return /** @type {string[]} */ (Object.values(FILTER)).includes(picked) ? picked : FILTER.all;
}

/**
 * The group an entry is in: its terminal's workspace, Schedules, or the agents with no terminal.
 * @param {Entry} e
 */
export function groupOf(e) {
  if (e.schedule) return GROUP.schedules;
  const wsId = e.tabId ? state.tabs.get(e.tabId)?.wsId : null;
  return wsId ? GROUP.workspace + wsId : GROUP.agents;
}

/**
 * The groups with rows, in order: the workspaces as the sidebar has them, the agents with no terminal, Schedules.
 * @param {Entry[]} entries newest first, already filtered
 * @returns {Group[]}
 */
export function groupsOf(entries) {
  /** @param {string} id */
  const rowsOf = id => entries.filter(e => groupOf(e) === id);
  const workspaces = state.workspaces.map(w => ({
    id: GROUP.workspace + w.id, lead: `<span class="ws-dot" style="background:${cssColor(w.color)}"></span>`, name: w.name,
    rows: rowsOf(GROUP.workspace + w.id),
  }));
  const agents = { id: GROUP.agents, lead: '', name: NAME.agents, rows: rowsOf(GROUP.agents) };
  const schedules = { id: GROUP.schedules, lead: titleIconHtml(byId(SCHEDULES_BUTTON_ID)), name: NAME.schedules, rows: rowsOf(GROUP.schedules) };
  return [...workspaces, agents, schedules].filter(g => g.rows.length);
}

/** @param {string} shown */
export const filtersHtml = shown => `<div class="seg inbox-filters" role="group" aria-label="Filter">${FILTERS.map(([id, label]) =>
  `<button class="${id === shown ? 'on' : ''}" data-filter="${id}" data-f="filter:${id}"${id === shown ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${label}</button>`).join('')}</div>`;

/**
 * A group's head (a click folds it; its Clear clears what it shows) and, unless folded, its rows.
 * @param {Group} g
 * @param {boolean} folded
 */
export function groupHtml(g, folded) {
  const id = escapeHtml(g.id);
  const clears = g.rows.some(e => !e.waiting);
  return `<section class="inbox-group${folded ? ' folded' : ''}" data-group="${id}">
    <div class="inbox-group-head">
      <button class="inbox-group-fold" data-fold="${id}" data-f="fold:${id}" aria-expanded="${!folded}">${folded ? ICONS.chevronRight : ICONS.chevronDown}${g.lead}<span class="name">${escapeHtml(g.name)}</span><span class="inbox-group-count">${g.rows.length}</span></button>
      ${clears ? `<button class="inbox-group-clear" data-clear-group="${id}" data-f="clear:${id}">Clear</button>` : ''}
    </div>
    ${folded ? '' : g.rows.map(r => r.html).join('')}
  </section>`;
}
