// @ts-check
// The notification center, docked on the right of the terminals (the title bar's button, Ctrl+Shift+A), as design A
// (By workspace): a filter (All, Unread, Errors), then a group per workspace, newest first, each folding away and
// clearing on its own (js/inboxgroups.js). The rows are the notes of js/inbox.js (js/inboxrows.js) and the agents'
// questions (js/questioncards.js). A permission is answered here (Allow, Deny), a question gets a reply, an agent's
// question its answer; a click on a row goes to its terminal, and the panel stays. One column at any width, so a
// resize never redraws it.

import { state, persist, on, emit, EVENTS } from './store.js';
import { allNotes, watchNotes, clear, button } from './inbox.js';
import { answerAgent, ANSWER } from './agentanswer.js';
import { answerQuestion } from './questions.js';
import { noteEntry, scheduleEntry } from './inboxrows.js';
import { questionEntry, replyOf, toggleOpened, answerKey, noteKey, CARD_ACTION } from './questioncards.js';
import { groupsOf, groupOf, groupHtml, filtersHtml, shownFilter, passes, FILTER } from './inboxgroups.js';
import { ICONS } from './ui.js';
import { send } from './host.js';
import { PAGE } from './protocol.js';
import { restoreFocus } from './panes.js';
import { arriveAt } from './arrived.js';
import { previewWaiting } from './inboxpreview.js';
import { scheduleFit } from './terminals.js';
import { isShortcut, KEY_ID } from './keymap.js';
import { byId, targetOf, dockRight, fillDockedPanel, titleIconHtml, WORKSPACE_ID } from './dom.js';
import { SECOND_MS } from './util.js';

const ACTION = Object.freeze({ clearAll: 'clearAll', close: 'close' });
/** A row, its main button, a text box in it, and the list of groups. */
const ITEM = '.inbox-item';
const ROW = '.inbox-row';
const BOX = '[data-draft]';
const DETAIL = '.inbox-detail';
const FEED = '.inbox-feed';
/** How often the open panel is redrawn, so the ages move on. */
const REDRAW_MS = 30 * SECOND_MS;
/** Its narrowest width (app.css has its width until it's dragged). */
const MIN_WIDTH_PX = 280;
/** What the list says when nothing is there: nothing at all, or nothing the filter lets through. */
const EMPTY = Object.freeze({ all: 'No notifications.', unread: 'Nothing unread.', errors: 'No errors.' });
/** Where design B kept its picked source in the saved state. */
const OLD_SOURCE_KEY = 'source';
const KEYS_TEXT = 'Ctrl+Shift+A';
/** The card parts a button opens or closes. @type {Set<string>} */
const TOGGLES = new Set([CARD_ACTION.more, CARD_ACTION.note, CARD_ACTION.details]);

/** What was typed in a box (by its draft key), kept across redraws. @type {Map<string, string>} */
const drafts = new Map();
/** Why an answer couldn't go, by note or question. @type {Map<string, string>} */
const failures = new Map();
/** Notes and questions whose answer is going now. @type {Set<string>} */
const answering = new Set();
/** Whether an input method is putting a word together in a box (a redraw then would lose it). */
let composing = false;

/** @type {import('./inboxrows.js').RowContext} */
const ctx = { draft: key => drafts.get(key) ?? '', failure: key => failures.get(key), busy: key => answering.has(key) };

const panel = document.createElement('aside');
panel.id = 'inbox';
panel.className = 'inbox-panel';
panel.setAttribute('aria-label', 'Notification center');
panel.hidden = true;
panel.tabIndex = -1;
byId(WORKSPACE_ID).append(panel);

/** Every entry, newest first. */
function entries() {
  const { notes, scheduleNotes, questions } = allNotes();
  return [...notes.map(n => noteEntry(n, ctx)), ...scheduleNotes.map(scheduleEntry), ...questions.map(q => questionEntry(q, ctx))]
    .sort((a, b) => b.at - a.at);
}

/** What has the focus in the panel (a row, a button, a box and its caret), to give it back after a redraw. */
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
  // What had the keys went (its group cleared): the first row has them, or the panel, so they stay in it.
  if (!el || /** @type {HTMLButtonElement} */ (el).disabled) return /** @type {HTMLElement} */ (panel.querySelector(ITEM) ?? panel).focus();
  el.focus();
  if (el instanceof HTMLInputElement && was.start !== null) el.setSelectionRange(was.start, was.end);
}

/** Drafts, errors and folds of entries that are gone go with them. @param {ReturnType<typeof entries>} all */
function forgetGone(all) {
  const kept = new Set(all.map(e => e.key));
  for (const key of failures.keys()) if (!kept.has(key)) failures.delete(key);
  for (const key of drafts.keys()) if (![...kept].some(k => key === k || key === answerKey(k) || key === noteKey(k))) drafts.delete(key);
  // A group that emptied isn't folded any more: its next notification shows.
  const live = new Set(groupsOf(all).map(g => g.id));
  const folded = state.inbox.folded ?? [];
  if (folded.every(g => live.has(g))) return;
  state.inbox.folded = folded.filter(g => live.has(g));
  persist();
}

function draw() {
  if (panel.hidden || composing) return;
  const all = entries();
  forgetGone(all);
  const was = focusNow();
  const scroll = /** @type {HTMLElement | null} */ (panel.querySelector(FEED))?.scrollTop ?? 0;
  const filter = shownFilter();
  const folded = new Set(state.inbox.folded ?? []);
  const groups = groupsOf(all.filter(e => passes(e, filter)));
  const empty = all.length ? EMPTY[/** @type {keyof typeof EMPTY} */ (filter)] : EMPTY.all;
  fillDockedPanel(panel, `
    <div class="files-head">
      ${titleIconHtml(button)}
      <span class="files-title">Notifications <span class="files-ws">${all.length}</span></span>
      <span class="files-tools">
        <button class="pane-btn" data-inbox="${ACTION.clearAll}" data-f="${ACTION.clearAll}" title="Clear all"${all.some(e => !e.waiting) ? '' : ' disabled'}>${ICONS.trash}</button>
        <button class="pane-btn" data-inbox="${ACTION.close}" data-f="${ACTION.close}" title="Close (${KEYS_TEXT})">${ICONS.close}</button>
      </span>
    </div>
    <div class="inbox-feed">
      ${filtersHtml(filter)}
      ${groups.map(g => groupHtml(g, folded.has(g.id))).join('') || `<div class="inbox-empty">${empty}</div>`}
    </div>`);
  /** @type {HTMLElement} */ (panel.querySelector(FEED)).scrollTop = scroll;
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
  // Design B's picked source, saved before design A: nothing reads it now.
  Reflect.deleteProperty(state.inbox, OLD_SOURCE_KEY);
  if (state.inbox.width) panel.style.width = `${state.inbox.width}px`;
  if (state.inbox.open) setOpen(true);
}

/** @param {string} filter */
function pickFilter(filter) {
  state.inbox.filter = filter;
  persist();
  draw();
}

/** @param {string} group */
function fold(group) {
  const folded = new Set(state.inbox.folded ?? []);
  if (!folded.delete(group)) folded.add(group);
  state.inbox.folded = [...folded];
  persist();
  draw();
}

/**
 * A group's Clear: what it shows, but not the questions still waiting (as Clear all leaves them).
 * @param {string} group
 */
function clearGroup(group) {
  const shown = groupsOf(entries().filter(e => passes(e, shownFilter()))).find(g => g.id === group);
  if (shown) clear(shown.rows.filter(e => !e.waiting).map(e => e.key));
}

/**
 * Sends an answer, one at a time per entry (a second click or Enter while one goes would send it twice); why it
 * couldn't go shows under it.
 * @param {string} key
 * @param {() => unknown} go
 * @param {string[]} sentDrafts the boxes it empties once it went
 */
async function sendAnswer(key, go, sentDrafts) {
  if (answering.has(key)) return;
  failures.delete(key);
  answering.add(key);
  draw();
  try {
    await go();
    for (const d of sentDrafts) drafts.delete(d);
  } catch (e) {
    failures.set(key, /** @type {Error} */ (e).message);
  } finally {
    answering.delete(key);
  }
  draw();
}

/**
 * Types an answer into a note's terminal.
 * @param {HTMLElement} row
 * @param {string} choice
 */
function answer(row, choice) {
  const key = /** @type {string} */ (row.dataset.key);
  void sendAnswer(key, () => answerAgent({ pane: row.dataset.pane, choice, text: drafts.get(key) }), [key]);
}

/**
 * A card's button: an answer to the agent's question, or a part of the card opened or closed.
 * @param {HTMLElement} el
 */
function cardAction(el) {
  const id = /** @type {string} */ (el.dataset.question);
  const action = /** @type {string} */ (el.dataset.q);
  if (TOGGLES.has(action)) {
    toggleOpened(id, action);
    return draw();
  }
  if (action === CARD_ACTION.link) return send(PAGE.openUrl, { url: el.dataset.value ?? '' });
  const reply = replyOf(action, el.dataset.value ?? '', ctx, id);
  if (reply) void sendAnswer(id, () => answerQuestion(id, reply), [answerKey(id), noteKey(id)]);
}

/** @param {HTMLElement} row */
function preview(row) {
  const tab = state.tabs.get(row.dataset.pane ?? '');
  if (tab) previewWaiting(tab, row.querySelector(DETAIL)?.textContent ?? '');
}

/** @param {HTMLElement} el */
function onAction(el) {
  const row = /** @type {HTMLElement | null} */ (el.closest(ROW));
  if (el.dataset.q) cardAction(el);
  else if (el.dataset.answer && row) answer(row, el.dataset.answer);
  else if (el.dataset.preview !== undefined && row) preview(row);
  else if (el.dataset.clear) clear(el.dataset.clear);
  else if (el.dataset.filter) pickFilter(el.dataset.filter);
  else if (el.dataset.fold) fold(el.dataset.fold);
  else if (el.dataset.clearGroup) clearGroup(el.dataset.clearGroup);
  else if (el.dataset.inbox === ACTION.clearAll) clear(null);
  else if (el.dataset.inbox === ACTION.close) toggleInbox();
  else if (el.dataset.run) emit(EVENTS.openSchedules, { runId: el.dataset.run });
  else if (el.dataset.tab) {
    const tab = state.tabs.get(el.dataset.tab);
    if (tab) arriveAt(tab);
  }
}

panel.addEventListener('click', e => {
  const el = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-q], [data-answer], [data-preview], [data-clear], [data-filter], [data-fold], [data-clear-group], [data-inbox], [data-run], [data-tab]'));
  if (el) onAction(el);
});
panel.addEventListener('compositionstart', () => { composing = true; });
panel.addEventListener('compositionend', () => {
  composing = false;
  draw();
});
panel.addEventListener('input', e => {
  const box = targetOf(e);
  if (box instanceof HTMLInputElement && box.dataset.draft) drafts.set(box.dataset.draft, box.value);
});

/**
 * Up and Down go from row to row.
 * @param {KeyboardEvent} e
 */
function moveFocus(e) {
  const items = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll(ITEM)]);
  const step = e.key === 'ArrowDown' ? 1 : -1;
  items[(items.indexOf(/** @type {HTMLElement} */ (document.activeElement)) + step + items.length) % items.length]?.focus();
}

/**
 * Enter in a box sends it: a note's reply, or a card's answer (its note box sends with its recommended or only button
 * only when the card has one to send).
 * @param {HTMLElement} box
 */
function enterIn(box) {
  const row = /** @type {HTMLElement} */ (box.closest(ROW));
  if (!row.dataset.question) return answer(row, ANSWER.reply);
  const sendButton = /** @type {HTMLElement | null} */ (row.querySelector(`[data-q="${CARD_ACTION.send}"]`));
  if (sendButton && box.dataset.draft === answerKey(row.dataset.question)) cardAction(sendButton);
}

panel.addEventListener('keydown', e => {
  const plain = !e.ctrlKey && !e.shiftKey && !e.altKey;
  const inBox = targetOf(e).matches(BOX);
  if (e.key === 'Escape' && plain) restoreFocus();
  else if (e.isComposing) return; // an input method's own Enter picks its word
  else if (e.key === 'Enter' && plain && inBox) enterIn(targetOf(e));
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !inBox) moveFocus(e);
  else if (isShortcut(e, KEY_ID.inbox)) toggleInbox();
  else return;
  e.preventDefault();
  e.stopPropagation();
});

button.addEventListener('click', () => toggleInbox());
watchNotes(draw);
// A question's desktop notification was clicked (js/questions.js): the panel opens on All with its group unfolded,
// where it is.
on(EVENTS.openInbox, ({ question } = {}) => {
  state.inbox.filter = FILTER.all;
  const asked = question ? entries().find(e => e.key === question) : null;
  if (asked) state.inbox.folded = (state.inbox.folded ?? []).filter(g => g !== groupOf(asked));
  setOpen(true);
});
dockRight(panel, {
  dockVar: '--inbox-dock', minWidth: MIN_WIDTH_PX,
  resized: scheduleFit,
  dragged: width => { state.inbox.width = width; persist(); },
});
// Ages move on while the panel is open (not while something is typed: a redraw keeps it, but there's no need).
setInterval(() => { if (!panel.hidden && !document.activeElement?.matches(BOX)) draw(); }, REDRAW_MS);
