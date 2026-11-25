// @ts-check
// An answer to an agent that waits, typed into its terminal as if from the keyboard: Approve, Approve and don't ask
// again, Reject, or a reply in the user's own words. The terminal is checked to still be waiting before anything is
// typed. Used by the phones (js/phone.js) and the notification center (js/inboxpanel.js).

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state } from './store.js';
import { AGENT_STATE, CLAUDE_TOOL } from './constants.js';
import { agentInput } from './terminals.js';
import { beforeEnter } from './api.js';

/** Claude Code's permission prompt: Enter takes "Yes", 2 "Yes, and don't ask again", Esc "No, and tell Claude". */
const KEYS = Object.freeze({ approve: '\r', reject: '\x1b' });
/**
 * A permission prompt's "Yes, and don't ask again" choice (or "Yes, allow all edits"), as Claude Code draws it: its
 * number. Not every prompt has one (a command it won't remember, like rm, has only Yes and No), and where it has, it's
 * not always 2, so it's read off the screen.
 */
const ALWAYS = /^\W*(\d)\.\s*Yes, (?:and don.t ask again|allow all)/i;
/** How far above the screen's bottom the prompt's choices are looked for (lines). */
const PROMPT_LINES = 40;
/** The answers. */
export const ANSWER = Object.freeze({ approve: 'approve', always: 'always', reject: 'reject', reply: 'reply' });
/** After Esc, Claude Code takes a moment to show its prompt for what to do instead; then the text, then Enter. */
const AFTER_ESC_MS = 400;
/** The states in which an agent waits for the user. */
/** @type {Set<string>} */
const WAITING_STATES = new Set([AGENT_STATE.needsInput, AGENT_STATE.attention, AGENT_STATE.error]);

/**
 * Waiting on a permission prompt (not a question, which needs typing).
 * @param {Tab} tab
 */
export const awaitsPermission = tab => tab.agent?.state === AGENT_STATE.needsInput && !!tab.agent.tool && tab.agent.tool !== CLAUDE_TOOL.askUserQuestion;

/**
 * Whether its agent waits for the user: a permission, a question, its attention, or after an error.
 * @param {Tab} tab
 */
export const isWaiting = tab => !!tab.agent && WAITING_STATES.has(tab.agent.state);

/**
 * The key that picks the prompt's "don't ask again" choice, read off the terminal's screen; null when it has none.
 * @param {Tab} tab
 */
export function alwaysKey(tab) {
  const term = tab.view?.term;
  if (!term) return null;
  const buffer = term.buffer.active;
  for (let y = buffer.length - 1; y >= Math.max(0, buffer.length - PROMPT_LINES); y--) {
    const found = ALWAYS.exec(buffer.getLine(y)?.translateToString(true) ?? '');
    if (found) return found[1];
  }
  return null;
}

/** @param {number} ms */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Types an answer into a terminal that still waits for one. Throws, with a message for the user, when it can't.
 * @param {{ pane?: string, choice?: string, text?: string }} args
 */
export async function answerAgent({ pane, choice, text }) {
  const tab = state.tabs.get(pane ?? '');
  if (!tab || tab.exited) throw new Error('That terminal is gone.');
  if (choice === ANSWER.reply) {
    if (!text?.trim()) throw new Error('The reply is empty.');
    if (!isWaiting(tab)) throw new Error('That terminal isn’t waiting for you any more.');
    // A permission prompt first gets "No, tell Claude what to do instead" (Esc); then the words, then Enter.
    if (awaitsPermission(tab)) {
      send(PAGE.input, { id: tab.id, data: KEYS.reject });
      await pause(AFTER_ESC_MS);
    }
    send(PAGE.input, { id: tab.id, data: text });
    await beforeEnter(tab); // Codex loses an Enter that comes while it still takes in a long text
    send(PAGE.input, { id: tab.id, data: '\r' });
    agentInput(tab, '\r');
    return { answered: choice };
  }
  if (!awaitsPermission(tab)) throw new Error('That terminal isn’t waiting for a yes or no any more.');
  const key = choice === ANSWER.always ? alwaysKey(tab) : /** @type {Record<string, string>} */ (KEYS)[choice ?? ''];
  if (!key) throw new Error(choice === ANSWER.always ? 'This prompt has no "don\'t ask again". Nothing was typed.' : 'Not an answer.');
  send(PAGE.input, { id: tab.id, data: key });
  agentInput(tab, key); // answered, as from the keyboard here: no longer waiting
  return { answered: choice };
}
