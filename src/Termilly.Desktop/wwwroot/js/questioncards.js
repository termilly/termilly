// @ts-check
// An agent's question as a card in the notification center (js/questions.js): its title, the details a click
// away, and what the kind asks for. Options: the choices, four of them and the rest under More, the recommended one
// marked. Approve: Deny and Approve. Ask: the suggestions over a text field. Options and Approve take a note too. An
// update has at most one button. Once answered, the card says what was sent.

import { state } from './store.js';
import { escapeHtml } from './ui.js';
import { QUESTION_STATUS } from './questions.js';
import { titleLineHtml, clearHtml, dotHtml, failHtml } from './inboxrows.js';
import { DOT } from './inboxgroups.js';
import { QUESTION_KIND, QUESTION_LIMIT } from './constants.js';

/** Card buttons' looks beyond a plain button: a link-like one, a suggestion. */
const CLASS = Object.freeze({ link: 'q-link', chip: 'q-chip' });
/** What the buttons that open part of a card say. */
const LABEL = Object.freeze({ details: 'Details', hideDetails: 'Hide details', note: 'Add a note' });
/** What a card's buttons do (data-q). */
export const CARD_ACTION = Object.freeze({
  pick: 'pick', approve: 'approve', deny: 'deny', send: 'send', more: 'more', note: 'note', details: 'details', link: 'link',
});
/** The parts of a card the user opened: its other choices, its note box, its details. */
const OPENED = Object.freeze({ more: 'more', note: 'note', details: 'details' });
/** Which parts of which cards are open (`${id}:${part}`), kept across redraws. @type {Set<string>} */
const opened = new Set();
/** The draft keys of a card's text field and note box. */
export const answerKey = /** @param {string} id */ id => `${id}:answer`;
export const noteKey = /** @param {string} id */ id => `${id}:note`;

/**
 * Opens or closes a part of a card.
 * @param {string} id
 * @param {string} part one of CARD_ACTION more, note or details
 */
export function toggleOpened(id, part) {
  const key = `${id}:${part}`;
  if (!opened.delete(key)) opened.add(key);
}
/** @param {string} id @param {string} part */
const isOpen = (id, part) => opened.has(`${id}:${part}`);

/**
 * A card's button.
 * @param {string} id @param {string} action @param {string} label @param {string} [extra] classes @param {string} [value]
 */
const buttonHtml = (id, action, label, extra = '', value = '') =>
  `<button class="btn small${extra ? ` ${extra}` : ''}" data-q="${action}" data-question="${escapeHtml(id)}"${value ? ` data-value="${escapeHtml(value)}"` : ''} data-f="${escapeHtml(id)}:${action}:${escapeHtml(value)}">${label}</button>`;

/** @param {import('./questions.js').Question} q */
function choicesHtml(q) {
  const all = isOpen(q.id, OPENED.more);
  const shown = all ? q.choices : q.choices.slice(0, QUESTION_LIMIT.shownChoices);
  const rest = q.choices.length - shown.length;
  return `<div class="q-choices">${shown.map(c => buttonHtml(q.id, CARD_ACTION.pick, `${escapeHtml(c.label)}${c.recommended ? '<span class="q-recommended">Recommended</span>' : ''}`, c.recommended ? 'q-choice primary' : 'q-choice', c.label)).join('')}
    ${rest ? buttonHtml(q.id, CARD_ACTION.more, `More (${rest})`, 'q-more') : ''}</div>`;
}

/**
 * A text box of the card (its answer or its note), with what was typed in it.
 * @param {string} key @param {string} placeholder @param {import('./inboxrows.js').RowContext} ctx
 */
const boxHtml = (key, placeholder, ctx) =>
  `<input class="field q-box" placeholder="${placeholder}" spellcheck="false" autocomplete="off" maxlength="${QUESTION_LIMIT.maxAnswer}" data-draft="${escapeHtml(key)}" data-f="${escapeHtml(key)}" value="${escapeHtml(ctx.draft(key))}">`;

/**
 * What the card asks for, by its kind.
 * @param {import('./questions.js').Question} q
 * @param {import('./inboxrows.js').RowContext} ctx
 */
function askHtml(q, ctx) {
  const details = q.details ? buttonHtml(q.id, CARD_ACTION.details, isOpen(q.id, OPENED.details) ? LABEL.hideDetails : LABEL.details, CLASS.link) : '';
  const note = buttonHtml(q.id, CARD_ACTION.note, LABEL.note, CLASS.link);
  const noteBox = isOpen(q.id, OPENED.note) ? `<div class="q-line">${boxHtml(noteKey(q.id), 'Note for the agent', ctx)}</div>` : '';
  if (q.ui === QUESTION_KIND.options) return `${choicesHtml(q)}<div class="q-line">${details}${note}</div>${noteBox}`;
  if (q.ui === QUESTION_KIND.approve) {
    return `<div class="q-line">${buttonHtml(q.id, CARD_ACTION.deny, 'Deny')}${buttonHtml(q.id, CARD_ACTION.approve, 'Approve', 'primary')}${details}${note}</div>${noteBox}`;
  }
  if (q.ui === QUESTION_KIND.ask) {
    const chips = q.suggestions.map(s => buttonHtml(q.id, CARD_ACTION.pick, escapeHtml(s), CLASS.chip, s)).join('');
    return `${chips ? `<div class="q-choices">${chips}</div>` : ''}<div class="q-line">${boxHtml(answerKey(q.id), 'Answer', ctx)}${buttonHtml(q.id, CARD_ACTION.send, 'Send')}</div>${details ? `<div class="q-line">${details}</div>` : ''}`;
  }
  const link = q.button ? buttonHtml(q.id, CARD_ACTION.link, escapeHtml(q.button.label), '', q.button.url) : '';
  return link || details ? `<div class="q-line">${link}${details}</div>` : '';
}

/** @param {import('./questions.js').Question} q */
export const questionDot = q => (q.status === QUESTION_STATUS.waiting ? DOT.ask : q.status === QUESTION_STATUS.answered ? DOT.done : DOT.info);

/**
 * A question's card in the notification center.
 * @param {import('./questions.js').Question} q
 * @param {import('./inboxrows.js').RowContext} ctx
 * @returns {import('./inboxgroups.js').Entry}
 */
export function questionEntry(q, ctx) {
  const tab = q.tabId ? state.tabs.get(q.tabId) ?? null : null;
  const waiting = q.status === QUESTION_STATUS.waiting;
  const body = waiting || q.ui === QUESTION_KIND.info ? askHtml(q, ctx) : `<div class="q-said">Sent: ${escapeHtml(q.said)}</div>`;
  const details = q.details && isOpen(q.id, OPENED.details) ? `<div class="q-details">${escapeHtml(q.details)}</div>` : '';
  const html = `<div class="inbox-row q-card${waiting ? ' waiting' : ''}${ctx.busy(q.id) ? ' busy' : ''}" data-key="${escapeHtml(q.id)}" data-question="${escapeHtml(q.id)}">
    <button class="inbox-item${waiting ? ' unread' : ''}"${tab ? ` data-tab="${tab.id}"` : ''} data-f="${escapeHtml(q.id)}:i">
      ${dotHtml(questionDot(q))}
      <span class="inbox-text">${titleLineHtml(tab, 'An agent', q.at)}<span class="q-title">${escapeHtml(q.title)}</span></span>
    </button>${clearHtml(q.id, waiting ? 'Put away without answering' : 'Clear')}
    <div class="q-body">${details}${body}${failHtml(q.id, ctx.failure(q.id))}</div></div>`;
  return { at: q.at, html, key: q.id, tabId: q.tabId, schedule: false, dot: questionDot(q), unread: waiting, waiting };
}

/**
 * The user's reply a card's button gives, for js/questions.js answerQuestion; null for a button that only opens
 * something.
 * @param {string} action
 * @param {string} value the choice or suggestion picked
 * @param {import('./inboxrows.js').RowContext} ctx
 * @param {string} id
 */
export function replyOf(action, value, ctx, id) {
  const note = ctx.draft(noteKey(id));
  if (action === CARD_ACTION.pick) return { answer: value, note };
  if (action === CARD_ACTION.approve || action === CARD_ACTION.deny) return { approved: action === CARD_ACTION.approve, note };
  if (action === CARD_ACTION.send) return { answer: ctx.draft(answerKey(id)) };
  return null;
}
