// @ts-check
// Tells the user something came in while the notification center is closed. Normal layout: its title bar button
// flashes once, as a pane does when a notification takes the user to it (js/arrived.js). Minimal: a tab on the right
// edge of the terminals has a dot per notification, coloured by kind; one that needs the user or failed peeks out of it
// for a few seconds. A click on the tab opens the center, on the peek opens it at that notification. Only what needs
// the user or failed alerts; the rest only adds a dot.

import { state, on, emit, wsById, tabTitle, EVENTS } from './store.js';
import { allNotes, watchNotes, button } from './inbox.js';
import { noteDot } from './inboxrows.js';
import { questionDot } from './questioncards.js';
import { DOT } from './inboxgroups.js';
import { toggleInbox, watchInboxOpen, inboxShown } from './inboxpanel.js';
import { flash } from './arrived.js';
import { isMinimal } from './panebar.js';
import { byId, WORKSPACE_ID } from './dom.js';
import { escapeHtml, tabBadgeHtml, cssColor, ICONS } from './ui.js';
import { SECOND_MS } from './util.js';

/**
 * A notification as the alert shows it: its key in the center, its dot, its terminal (or a name of its own), what it
 * says and when.
 * @typedef {{ key: string, dot: string, tabId: string | null, name: string, text: string, at: number }} Item
 */

/** The kinds that alert; the others only add a dot. @type {Set<string>} */
const ALERTS = new Set([DOT.ask, DOT.error]);
/** How long a peek shows (longer while the mouse is on it). */
const PEEK_MS = 5 * SECOND_MS;
/** The most dots the tab shows; its count says the rest. */
const MAX_DOTS = 8;
const AGENT_NAME = 'An agent';
const TAB_TITLE = 'Notification center (Ctrl+Shift+A)';

const edge = document.createElement('div');
edge.className = 'inbox-edge';
edge.hidden = true;
edge.innerHTML = `<div class="inbox-peek" role="status" hidden></div><button class="inbox-edge-tab" title="${TAB_TITLE}" aria-label="${TAB_TITLE}"></button>`;
byId(WORKSPACE_ID).append(edge);
const peekEl = /** @type {HTMLElement} */ (edge.querySelector('.inbox-peek'));
const tabEl = /** @type {HTMLElement} */ (edge.querySelector('.inbox-edge-tab'));

/** Every notification, newest first. @returns {Item[]} */
function items() {
  const { notes, scheduleNotes, questions } = allNotes();
  return [
    ...notes.map(n => ({ key: n.key, dot: noteDot(n.state), tabId: n.tabId, name: '', text: n.detail, at: n.at })),
    ...scheduleNotes.map(n => ({ key: n.id, dot: n.failed ? DOT.error : DOT.schedule, tabId: null, name: n.title, text: n.detail, at: n.at })),
    ...questions.map(q => ({ key: q.id, dot: questionDot(q), tabId: q.tabId, name: AGENT_NAME, text: q.title, at: q.at })),
  ].sort((a, b) => b.at - a.at);
}

/** The keys already seen, so only new ones alert. */
let known = new Set(items().map(i => i.key));
/** The notification peeking now, and when its peek goes. */
let peeking = /** @type {Item | null} */ (null);
let peekTimer = 0;

/** Whether the tab shows: Minimal, the center closed, and something in it. */
const edgeWanted = () => isMinimal() && !inboxShown() && items().length > 0;

/** @param {Item} item */
function peekHtml(item) {
  const tab = item.tabId ? state.tabs.get(item.tabId) : null;
  const ws = tab ? wsById(tab.wsId) : null;
  const from = tab
    ? `${tabBadgeHtml(tab)}<span class="name">${escapeHtml(tabTitle(tab))}</span>${ws ? `<span class="inbox-peek-ws"><span class="ws-dot" style="background:${cssColor(ws.color)}"></span>${escapeHtml(ws.name)}</span>` : ''}`
    : `<span class="name">${escapeHtml(item.name)}</span>`;
  return `<span class="inbox-dot ${item.dot}"></span><span class="inbox-peek-text"><span class="inbox-peek-from">${from}</span><span class="inbox-peek-says">${escapeHtml(item.text)}</span></span>`;
}

/** Draws the tab's dots and count, and hides the tab (and its peek) when it isn't wanted. */
function drawEdge() {
  const all = items();
  edge.hidden = !edgeWanted();
  if (edge.hidden) return hidePeek();
  const dots = all.slice(0, MAX_DOTS).map(i => `<span class="inbox-dot ${i.dot}"></span>`).join('');
  tabEl.innerHTML = `${ICONS.chevronLeft}${dots}<span class="inbox-edge-count">${all.length}</span>`;
  if (peeking && !all.some(i => i.key === peeking?.key)) hidePeek();
}

/** @param {Item} item */
function showPeek(item) {
  peeking = item;
  peekEl.innerHTML = peekHtml(item);
  peekEl.hidden = false;
  startPeekTimer();
}

function startPeekTimer() {
  clearTimeout(peekTimer);
  peekTimer = window.setTimeout(hidePeek, PEEK_MS);
}

function hidePeek() {
  clearTimeout(peekTimer);
  peeking = null;
  peekEl.hidden = true;
}

/**
 * Something new that needs the user or failed came in while the center is closed.
 * @param {Item} item
 */
function alertOf(item) {
  if (isMinimal()) showPeek(item);
  else flash(button);
}

watchNotes(() => {
  const all = items();
  const fresh = all.filter(i => !known.has(i.key) && ALERTS.has(i.dot));
  known = new Set(all.map(i => i.key));
  drawEdge();
  if (fresh.length && !inboxShown()) alertOf(fresh[0]);
});
watchInboxOpen(drawEdge);
on(EVENTS.settings, drawEdge);

tabEl.addEventListener('click', () => toggleInbox());
peekEl.addEventListener('click', () => {
  const key = peeking?.key;
  hidePeek();
  emit(EVENTS.openInbox, { question: key });
});
// Kept while the mouse is on it, so it can be read.
peekEl.addEventListener('mouseenter', () => clearTimeout(peekTimer));
peekEl.addEventListener('mouseleave', startPeekTimer);
