// @ts-check
// The notification center's notes: what an agent said out of sight (waiting for the user, failed, finished), and what
// schedules said. An entry stays, seen or dealt with, until the user clears it (its ×, or Clear); a terminal closed
// takes its own with it. One key (Ctrl+Shift+J) goes to the next terminal that still needs the user. The sidebar that
// shows them is js/inboxpanel.js.

import { HOST, PAGE } from './protocol.js';
import { onHost, send } from './host.js';
import { state, on, emit, EVENTS } from './store.js';
import { countText } from './ui.js';
import { activityOf } from './store.js';
import { focusedTab } from './panes.js';
import { arriveAt } from './arrived.js';
import { AGENT_STATE, CLAUDE_TOOL } from './constants.js';
import { byId, find, TOOL_COUNT } from './dom.js';
import { allQuestions, clearQuestions, watchQuestions, QUESTION_STATUS } from './questions.js';

/**
 * A terminal that needs the user now, and how urgent it is (rank(): lower first).
 * @typedef {{ tab: Tab, rank: number | null }} InboxEntry
 */
/**
 * An entry in the notification center: what the agent said, as it was then (key: the terminal, the state and when).
 * @typedef {{ key: string, tabId: string, state: string, activity: import('./store.js').Activity | null, detail: string, at: number }} Note
 */
/**
 * What schedules said (js/schedules.js): a run needs no terminal, so these have none. A click opens its report.
 * @typedef {{ id: string, title: string, detail: string, failed: boolean, at: number }} ScheduleNote
 */

/** @type {Note[]} */
let notes = [];
/** @type {ScheduleNote[]} */
let scheduleNotes = [];
/** How many of them are kept. */
const MAX_SCHEDULE_NOTES = 30;
/** Notes the user cleared (their keys): a terminal that still says the same isn't taken in again. */
const cleared = new Set();
/** Who redraws when the notes change (the sidebar). @type {Set<() => void>} */
const watchers = new Set();

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

/** The title bar's button: its count, and the sidebar's toggle (js/inboxpanel.js). */
export const button = byId('inbox-button');
const count = find(button, TOOL_COUNT);

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

/** @param {Tab} tab */
const keyOf = tab => `${tab.id}:${tab.agent?.state}:${tab.agent?.at ?? 0}`;

/**
 * Whether a note is still news: its terminal still needs the user for it.
 * @param {Note} n
 */
export function isLive(n) {
  const tab = state.tabs.get(n.tabId);
  return !!tab && rank(tab) !== null && keyOf(tab) === n.key;
}

/** The notification center for the phones (js/phone.js): each note's terminal, what it said, when, and whether it's still news. */
export const notesForPhone = () => notes.map(n => ({ id: n.tabId, key: n.key, state: n.state, detail: n.detail, at: n.at, live: isLive(n) }));

/** The notes now, newest first: the terminals', the schedules' and the agents' questions (js/questions.js). */
export const allNotes = () => ({ notes, scheduleNotes, questions: allQuestions() });

/**
 * Redraws `fn` whenever the notes change.
 * @param {() => void} fn
 */
export const watchNotes = fn => watchers.add(fn);

/**
 * A schedule's run, for the notification center.
 * @param {ScheduleNote} note
 */
export function addScheduleNote(note) {
  scheduleNotes = [note, ...scheduleNotes].slice(0, MAX_SCHEDULE_NOTES);
  refresh();
  emit(EVENTS.inbox);
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

/**
 * Takes in what a terminal's agent says now, if it's inbox material: a terminal's newer note replaces its older.
 * @param {Tab} tab
 */
function take(tab) {
  const key = keyOf(tab);
  if (rank(tab) === null || cleared.has(key) || notes.some(n => n.key === key)) return;
  const a = /** @type {AgentInfo} */ (tab.agent);
  const note = { key, tabId: tab.id, state: a.state, activity: activityOf(tab), detail: entryDetail(tab), at: a.at ?? Date.now() };
  notes = [note, ...notes.filter(n => n.tabId !== tab.id)];
}

/**
 * Clears these notes, schedule notes and agents' questions (their keys and ids), or all of them (null). Clear all
 * leaves the questions that still wait for an answer: only their own × puts one away.
 * @param {string | string[] | null} keys
 */
export function clear(keys) {
  const these = keys === null ? null : new Set(Array.isArray(keys) ? keys : [keys]);
  for (const n of notes) if (!these || these.has(n.key)) cleared.add(n.key);
  notes = notes.filter(n => !cleared.has(n.key));
  scheduleNotes = these ? scheduleNotes.filter(n => !these.has(n.id)) : [];
  const asked = allQuestions().filter(q => (these ? these.has(q.id) : q.status !== QUESTION_STATUS.waiting));
  if (asked.length) clearQuestions(asked.map(q => q.id));
  refresh();
  emit(EVENTS.inbox);
}

/** Takes in what the terminals say now, and shows how many notes there are on the button and the taskbar. */
function refresh() {
  for (const tab of state.tabs.values()) take(tab);
  const size = notes.length + scheduleNotes.length + allQuestions().length;
  count.textContent = countText(size);
  count.hidden = !size;
  updateBadge(size);
  button.classList.toggle('has-items', size > 0);
  button.title = `Notification center: ${size} notification${size === 1 ? '' : 's'} (Ctrl+Shift+A)`;
  for (const fn of watchers) fn();
}

/**
 * Goes to the next terminal that needs the user, after the one focused now, wrapping round. Returns false when
 * nothing does.
 */
export function jumpToNext() {
  const entries = inboxEntries();
  if (!entries.length) return false;
  const current = entries.findIndex(e => e.tab === focusedTab());
  arriveAt(entries[(current + 1) % entries.length].tab);
  return true;
}

// The global shortcut (Settings › Terminal) brought the window forward; pick the terminal.
onHost(HOST.agentsNext, () => jumpToNext());

// Taken as the agent says it, before the user sees it and it's dealt with (markSeen).
on(EVENTS.agent, take);
on(EVENTS.tabClosed, tab => {
  notes = notes.filter(n => n.tabId !== tab.id);
  for (const key of cleared) if (key.startsWith(`${tab.id}:`)) cleared.delete(key);
  refresh();
});
on(EVENTS.tab, refresh);
watchQuestions(refresh);
on(EVENTS.workspaces, refresh);
