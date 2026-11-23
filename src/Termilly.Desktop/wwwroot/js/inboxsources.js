// @ts-check
// The notification center's sources (design B, Sources and feed): All, each workspace, each terminal and Schedules
// that have something to say, with their counts. The feed beside them shows the picked one's entries (js/inboxpanel.js).

import { state, wsById, tabTitle } from './store.js';
import { tabBadgeHtml, escapeHtml, cssColor } from './ui.js';
import { byId, titleIconHtml, SCHEDULES_BUTTON_ID } from './dom.js';

/**
 * A row of the feed: when, its markup, what clearing it clears, where it's from, and how its dot looks.
 * @typedef {{ at: number, html: string, key: string, tabId: string | null, schedule: boolean, dot: string }} Entry
 */

/** The sources that aren't a workspace or a terminal, and how those are named (a prefix and the id). */
export const SOURCE = Object.freeze({ all: 'all', schedules: 'schedules', workspace: 'ws:', terminal: 'tab:' });
/** What the sources are called that aren't a workspace or a terminal. */
const NAME = Object.freeze({ all: 'All', schedules: 'Schedules' });
/** The dots: waiting for the user, an error, finished or answered, a schedule's run, an update. */
export const DOT = Object.freeze({ ask: 'ask', error: 'err', done: 'done', schedule: 'sched', info: 'info' });
/** Which dot a terminal's source shows when it has several entries: the most urgent. */
const URGENCY = [DOT.ask, DOT.error, DOT.done, DOT.info];

/** @param {Entry} e */
const wsOf = e => (e.tabId ? state.tabs.get(e.tabId)?.wsId ?? null : null);

/**
 * Whether an entry belongs to a source.
 * @param {Entry} e
 * @param {string} source
 */
export function inSource(e, source) {
  if (source === SOURCE.all) return true;
  if (source === SOURCE.schedules) return e.schedule;
  if (source.startsWith(SOURCE.workspace)) return wsOf(e) === source.slice(SOURCE.workspace.length);
  return e.tabId === source.slice(SOURCE.terminal.length);
}

/**
 * The source to show: the one picked, unless it has nothing left (then All).
 * @param {Entry[]} entries
 */
export function shownSource(entries) {
  const picked = state.inbox.source ?? SOURCE.all;
  return entries.some(e => inSource(e, picked)) ? picked : SOURCE.all;
}

/**
 * What the feed's head says for a source.
 * @param {string} source
 */
export function sourceTitle(source) {
  if (source === SOURCE.schedules) return NAME.schedules;
  if (source.startsWith(SOURCE.workspace)) return wsById(source.slice(SOURCE.workspace.length))?.name ?? NAME.all;
  if (source.startsWith(SOURCE.terminal)) {
    const tab = state.tabs.get(source.slice(SOURCE.terminal.length));
    return tab ? tabTitle(tab) : 'All';
  }
  return NAME.all;
}

/**
 * One source: what it shows before its name, its name, and after it a count or a dot.
 * @param {string} id @param {string} shown @param {string} lead @param {string} name @param {string} end
 */
const sourceHtml = (id, shown, lead, name, end) => `<button class="inbox-source${id === shown ? ' on' : ''}" data-source="${escapeHtml(id)}" data-f="src:${escapeHtml(id)}"${id === shown ? ' aria-current="true"' : ''}>${lead}<span class="name">${escapeHtml(name)}</span>${end}</button>`;

/** @param {number} n */
const countHtml = n => `<span class="inbox-source-count">${n}</span>`;
/** @param {string} title */
const headHtml = title => `<div class="inbox-source-head">${title}</div>`;

/**
 * The most urgent dot among a terminal's entries.
 * @param {Entry[]} mine
 */
const dotOf = mine => URGENCY.find(d => mine.some(e => e.dot === d)) ?? '';

/**
 * The source list: All, then the workspaces and terminals with entries (in the sidebar's order), then Schedules.
 * @param {Entry[]} entries
 * @param {string} shown
 */
export function sourcesHtml(entries, shown) {
  const workspaces = state.workspaces.map(w => ({ w, n: entries.filter(e => wsOf(e) === w.id).length })).filter(x => x.n);
  const terminals = [...state.tabs.values()].map(tab => ({ tab, mine: entries.filter(e => e.tabId === tab.id) })).filter(x => x.mine.length);
  const schedules = entries.filter(e => e.schedule).length;
  const clock = byId(SCHEDULES_BUTTON_ID);
  return `<nav class="inbox-sources" aria-label="Sources">
    ${sourceHtml(SOURCE.all, shown, '', NAME.all, countHtml(entries.length))}
    ${workspaces.length ? headHtml('Workspaces') : ''}
    ${workspaces.map(({ w, n }) => sourceHtml(SOURCE.workspace + w.id, shown, `<span class="ws-dot" style="background:${cssColor(w.color)}"></span>`, w.name, countHtml(n))).join('')}
    ${terminals.length ? headHtml('Terminals') : ''}
    ${terminals.map(({ tab, mine }) => sourceHtml(SOURCE.terminal + tab.id, shown, tabBadgeHtml(tab), tabTitle(tab), `<span class="inbox-dot ${dotOf(mine)}"></span>`)).join('')}
    ${schedules ? headHtml('Other') + sourceHtml(SOURCE.schedules, shown, titleIconHtml(clock), NAME.schedules, countHtml(schedules)) : ''}
  </nav>`;
}
