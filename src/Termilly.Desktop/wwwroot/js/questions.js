// @ts-check
// What agents ask the user in the notification center (the MCP server's notify_user, Shared/Questions.cs): pick an
// option, approve or deny, answer in words, or read an update. The agent's call waits here until the user answers, in
// the sidebar (js/questioncards.js) or on a phone (js/phone.js), puts it away, or the agent stops waiting. An update
// needs no answer: its call returns once it's shown. A waiting question alerts like an agent that needs the user.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, emit, wsById, tabTitle, getSetting, EVENTS } from './store.js';
import { addApiMethods } from './api.js';
import { arriveAt } from './arrived.js';
import { windowInFront } from './windowshown.js';
import { AGENT_STATE, QUESTION_KIND } from './constants.js';
import { answerOf, text } from './questionreply.js';

/**
 * A choice of an options question.
 * @typedef {{ label: string, recommended: boolean }} Choice
 */
/**
 * A question or update as the sidebar and the phones show it. `said` is what the user answered, in words.
 * @typedef {{ id: string, tabId: string | null, ui: string, title: string, details: string, choices: Choice[],
 *   suggestions: string[], button: { label: string, url: string } | null, at: number, status: string, said: string }} Question
 */

/** Where a question is: waiting for the user, answered, or an update that was shown. */
export const QUESTION_STATUS = Object.freeze({ waiting: 'waiting', answered: 'answered', delivered: 'delivered' });
/** How many answered questions and updates are kept (waiting ones always are). */
const MAX_DONE = 40;
/** What a question's id starts with here (questionKey). */
const QUESTION_PREFIX = 'q:';
/** The desktop notification setting a question follows, as an agent that needs the user does. */
const NOTIFY_SETTING = 'notifications.needsInput';

/** @type {Question[]} */
let questions = [];
/** The agents' calls waiting for an answer, by question. @type {Map<string, (reply: object) => void>} */
const waiting = new Map();
/**
 * Questions cancelled before they arrived: the agent gave up while its call was still on its way. Kept only until that
 * call comes, and a few at most.
 * @type {string[]}
 */
let cancelledEarly = [];
const MAX_CANCELLED_EARLY = 20;
/** Who redraws when the questions change (js/inbox.js). @type {Set<() => void>} */
const watchers = new Set();

/** @param {() => void} fn */
export const watchQuestions = fn => watchers.add(fn);
/** Every question and update, newest first. */
export const allQuestions = () => questions;
/** @param {string} id */
export const questionById = id => questions.find(q => q.id === id) ?? null;
/** The questions that still wait for the user. */
export const waitingQuestions = () => questions.filter(q => q.status === QUESTION_STATUS.waiting);

function changed() {
  for (const fn of watchers) fn();
  emit(EVENTS.inbox);
}

/**
 * A question's id here: the asker's own, in a space of its own, so it can't be taken for a note's key or a schedule
 * run's id (the notification center clears them all by key).
 * @param {unknown} id
 */
const questionKey = id => `${QUESTION_PREFIX}${String(id ?? '')}`;

/**
 * A question as the host checked it (Features/AgentQuestions.cs), from the terminal that asked.
 * @param {Record<string, any>} args
 * @returns {Question}
 */
function questionOf(args) {
  const from = typeof args.from === 'string' && state.tabs.has(args.from) ? args.from : null;
  return {
    id: questionKey(args.id), tabId: from, ui: String(args.ui), title: text(args.title), details: text(args.details),
    choices: Array.isArray(args.choices) ? args.choices.map(c => ({ label: text(c?.label), recommended: c?.recommended === true })) : [],
    suggestions: Array.isArray(args.suggestions) ? args.suggestions.map(text) : [],
    button: args.button ? { label: text(args.button.label), url: text(args.button.url) } : null,
    at: Date.now(), status: QUESTION_STATUS.waiting, said: '',
  };
}

/** @param {Question} q */
function sourceName(q) {
  const tab = q.tabId ? state.tabs.get(q.tabId) : null;
  if (!tab) return 'An agent';
  const ws = wsById(tab.wsId);
  return `${tabTitle(tab)}${ws ? ` · ${ws.name}` : ''}`;
}

/**
 * Tells the user a question waits: on the phones (Features/Phone.cs decides if they're away), and on the desktop
 * unless the notification center is in front of them.
 * @param {Question} q
 */
function alert(q) {
  const title = `Needs you: ${sourceName(q)}`;
  send(PAGE.phoneAlert, { id: q.id, state: AGENT_STATE.needsInput, title, body: q.title, inFront: windowInFront() });
  if (getSetting(NOTIFY_SETTING) && !(windowInFront() && state.inbox.open)) send(PAGE.notify, { id: q.id, title, body: q.title });
}

/** @param {Question} q */
function withdraw(q) {
  send(PAGE.phoneWithdraw, { id: q.id });
  send(PAGE.notifyWithdraw, { id: q.id });
}

/** Done ones beyond the few kept go, oldest first. */
function trim() {
  let done = 0;
  questions = questions.filter(q => q.status === QUESTION_STATUS.waiting || ++done <= MAX_DONE);
}

/**
 * An agent asks (the API's notify): an update is shown and returns at once; a question waits for the user.
 * @param {Record<string, any>} args
 */
function ask(args) {
  const q = questionOf(args);
  // Refused as an answer, not an error: an error would close the question that has this id (PageApi.AskUserAsync).
  if (questionById(q.id)) return { unavailable: true, reason: 'A question with that id is already asked.' };
  if (cancelledEarly.includes(q.id)) {
    cancelledEarly = cancelledEarly.filter(id => id !== q.id);
    return { closed: true };
  }
  questions = [q, ...questions];
  if (q.ui === QUESTION_KIND.info) {
    q.status = QUESTION_STATUS.delivered;
    trim();
    changed();
    return { delivered: true };
  }
  const answered = new Promise(resolve => waiting.set(q.id, resolve));
  alert(q);
  changed();
  return answered;
}

/**
 * Ends a question's wait with what the agent hears, and takes it out of the list unless it was answered.
 * @param {Question} q
 * @param {object} reply
 * @param {boolean} keep
 */
function settle(q, reply, keep) {
  waiting.get(q.id)?.(reply);
  waiting.delete(q.id);
  withdraw(q);
  if (!keep) questions = questions.filter(x => x !== q);
  trim();
  changed();
}

/**
 * The user answers a question (the sidebar, a phone). Throws, with a message for them, when it can't be.
 * @param {string} id
 * @param {import('./questionreply.js').Reply} reply
 */
export function answerQuestion(id, reply) {
  const q = questionById(id);
  if (!q || q.status !== QUESTION_STATUS.waiting) throw new Error('That question isn’t waiting any more.');
  const { result, said } = answerOf(q, reply);
  q.status = QUESTION_STATUS.answered;
  q.said = said;
  settle(q, result, true);
  return { answered: q.id };
}

/**
 * Takes questions out of the list (their ×, Clear all): one still waiting tells its agent the user put it away.
 * @param {string[] | null} ids null for all of them
 */
export function clearQuestions(ids) {
  for (const q of [...questions]) {
    if (ids && !ids.includes(q.id)) continue;
    if (q.status === QUESTION_STATUS.waiting) settle(q, { skipped: true }, false);
    else questions = questions.filter(x => x !== q);
  }
  changed();
}

/**
 * The agent stopped waiting (it was interrupted, or quit): its card closes.
 * @param {string} id
 */
function cancel(id) {
  id = questionKey(id);
  const q = questionById(id);
  if (q?.status === QUESTION_STATUS.waiting) settle(q, { closed: true }, false);
  else if (!q) cancelledEarly = [id, ...cancelledEarly].slice(0, MAX_CANCELLED_EARLY);
  return { closed: !!q };
}

/** The questions for the phones (js/phone.js): what each asks and where it is. */
export const questionsForPhone = () => questions.map(q => ({ ...q, source: sourceName(q) }));

addApiMethods({ notify: ask, notify_cancel: ({ id }) => cancel(String(id ?? '')) });

// A terminal closed: its agent is gone, and its questions with it.
on(EVENTS.tabClosed, tab => {
  for (const q of questions.filter(x => x.tabId === tab.id)) {
    if (q.status === QUESTION_STATUS.waiting) settle(q, { unavailable: true, reason: 'The terminal closed.' }, false);
  }
  questions = questions.filter(q => q.tabId !== tab.id);
  changed();
});

// A question's desktop notification was clicked: its terminal, and the notification center open on it.
onHost(HOST.focusTerminal, m => {
  const q = questionById(m.id ?? '');
  if (!q) return;
  const tab = q.tabId ? state.tabs.get(q.tabId) : null;
  if (tab) arriveAt(tab);
  emit(EVENTS.openInbox, { question: q.id });
});
