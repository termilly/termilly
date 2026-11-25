// @ts-check
// The notification center's rows (design A): a dot for what it is, the terminal it's from, how old
// it is and what it says, with its × beside it. An agent that waits for a permission or a reply gets its answer under
// its row (Allow, Deny, a reply box, Preview); agents' questions are js/questioncards.js.

import { state, tabTitle } from './store.js';
import { isLive } from './inbox.js';
import { awaitsPermission, isWaiting, ANSWER } from './agentanswer.js';
import { tabBadgeHtml, escapeHtml, ICONS } from './ui.js';
import { AGENT_STATE } from './constants.js';
import { DOT } from './inboxgroups.js';
import { SECOND_MS, DAY_S, MINUTE_S, HOUR_S } from './util.js';

/**
 * What a row needs from the panel: what was typed in a box (by its key), why an answer failed, and whether one is
 * being sent now.
 * @typedef {{ draft: (key: string) => string, failure: (key: string) => string | undefined, busy: (key: string) => boolean }} RowContext
 */

/** How long an entry's age reads "now", in seconds. */
const NOW_BELOW_S = 45;
const NOW_LABEL = 'now';
const CLEAR_LABEL = 'Clear';
/** The tooltip of an entry's Preview button. */
const PREVIEW_TIP = 'Why it needs you: all the agent asks';

/**
 * "now", "4m", "2h", "3d": how long ago.
 * @param {number | null | undefined} at
 */
export function age(at) {
  const s = Math.max(0, (Date.now() - (at ?? Date.now())) / SECOND_MS);
  if (s < NOW_BELOW_S) return NOW_LABEL;
  if (s < HOUR_S) return `${Math.round(s / MINUTE_S)}m`;
  if (s < DAY_S) return `${Math.round(s / HOUR_S)}h`;
  return `${Math.round(s / DAY_S)}d`;
}

/** @param {string} key @param {string} label */
export const clearHtml = (key, label = CLEAR_LABEL) => `<button class="pane-btn inbox-clear" data-clear="${escapeHtml(key)}" title="${label}" aria-label="${label}">${ICONS.close}</button>`;

/**
 * A row's first line: the terminal (its badge and name; its group names the workspace), or a name of its own, and
 * its age.
 * @param {Tab | null} tab
 * @param {string} name used when there's no terminal
 * @param {number} at
 */
export function titleLineHtml(tab, name, at) {
  const from = tab ? `${tabBadgeHtml(tab)}<span class="name">${escapeHtml(tabTitle(tab))}</span>` : `<span class="name">${escapeHtml(name)}</span>`;
  return `<span class="inbox-title">${from}<span class="inbox-age">${age(at)}</span></span>`;
}

/** @param {string} dot */
export const dotHtml = dot => `<span class="inbox-dot ${dot}"></span>`;

/** @param {string} key @param {string | undefined} fail */
export const failHtml = (key, fail) => (fail ? `<div class="inbox-fail" data-fail="${escapeHtml(key)}">${escapeHtml(fail)}</div>` : '');

/**
 * Its answer, for a note whose terminal still waits on it: Allow and Deny for a permission, else a reply box.
 * @param {import('./inbox.js').Note} n
 * @param {Tab} tab
 * @param {RowContext} ctx
 */
function answerHtml(n, tab, ctx) {
  if (!isLive(n) || !isWaiting(tab) || tab.agent?.state === AGENT_STATE.error) return '';
  const key = escapeHtml(n.key);
  const off = ctx.busy(n.key) ? ' disabled' : '';
  const body = awaitsPermission(tab)
    ? `<button class="btn small primary" data-answer="${ANSWER.approve}" data-f="${key}:a"${off}>Allow</button><button class="btn small" data-answer="${ANSWER.reject}" data-f="${key}:r"${off}>Deny</button>`
    : `<input class="field inbox-reply" placeholder="Reply" spellcheck="false" autocomplete="off" data-draft="${key}" data-f="${key}:t" value="${escapeHtml(ctx.draft(n.key))}"${off}><button class="btn small" data-answer="${ANSWER.reply}" data-f="${key}:s"${off}>Send</button>`;
  const preview = `<button class="btn small" data-preview data-f="${key}:p" title="${PREVIEW_TIP}">Preview</button>`;
  return `<div class="inbox-answer">${body}${preview}</div>${failHtml(n.key, ctx.failure(n.key))}`;
}

/** @param {string} state */
export const noteDot = state => (state === AGENT_STATE.error ? DOT.error : state === AGENT_STATE.done ? DOT.done : DOT.ask);

/**
 * An agent's note: what it said out of sight.
 * @param {import('./inbox.js').Note} n
 * @param {RowContext} ctx
 * @returns {import('./inboxgroups.js').Entry}
 */
export function noteEntry(n, ctx) {
  const tab = /** @type {Tab} */ (state.tabs.get(n.tabId));
  const dot = noteDot(n.state);
  const html = `<div class="inbox-row" data-key="${escapeHtml(n.key)}" data-pane="${tab.id}"><button class="inbox-item${isLive(n) ? ' unread' : ''}" data-tab="${tab.id}" data-f="${escapeHtml(n.key)}:i">
      ${dotHtml(dot)}
      <span class="inbox-text">${titleLineHtml(tab, '', n.at)}<span class="inbox-detail">${escapeHtml(n.detail)}</span></span>
    </button>${clearHtml(n.key)}${answerHtml(n, tab, ctx)}</div>`;
  return { at: n.at, html, key: n.key, tabId: tab.id, schedule: false, dot, unread: isLive(n), waiting: false };
}

/**
 * A schedule's run: a click opens its report.
 * @param {import('./inbox.js').ScheduleNote} n
 * @returns {import('./inboxgroups.js').Entry}
 */
export function scheduleEntry(n) {
  const dot = n.failed ? DOT.error : DOT.schedule;
  const html = `<div class="inbox-row"><button class="inbox-item unread" data-run="${escapeHtml(n.id)}" data-f="${escapeHtml(n.id)}:i">
    ${dotHtml(dot)}
    <span class="inbox-text">${titleLineHtml(null, n.title, n.at)}<span class="inbox-detail">${escapeHtml(n.detail)}</span></span>
  </button>${clearHtml(n.id)}</div>`;
  return { at: n.at, html, key: n.id, tabId: null, schedule: true, dot, unread: true, waiting: false };
}
