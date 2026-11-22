// @ts-check
// Agents' questions on the Notifications tab (the PC's js/questions.js, answered through Phone/PhoneQuestions.cs): an
// options question's choices, four and the rest under More; Approve or Deny; an answer in words with its suggestions;
// a note for the first two; and an update with its one button. A tapped alert for one opens this tab.

/**
 * @typedef {{ label: string, recommended: boolean }} PhoneChoice
 * @typedef {{ id: string, ui: string, title: string, details: string, choices: PhoneChoice[], suggestions: string[],
 *   button: { label: string, url: string } | null, at: number, status: string, said: string, source: string }} PhoneQuestion
 * @typedef {{ questions: () => PhoneQuestion[], send: (m: object) => boolean, toast: (text: string) => void,
 *   redraw: () => void, age: (at: number) => string }} QuestionsApp
 */

import { esc } from './todoviews.js';

/** What's asked of the PC (Phone/PhoneQuestions.cs Op). */
const OP = 'question';
/** The question kinds (Shared/Questions.cs QuestionKinds). */
const KIND = Object.freeze({ options: 'options', approve: 'approve', ask: 'ask', info: 'info' });
const WAITING = 'waiting';
/** The choices a card shows before its More (QuestionLimits.ShownChoices). */
const SHOWN_CHOICES = 4;
/** The ends of a card's draft keys (`${id}:answer`, `${id}:note`). */
const ANSWER_SUFFIX = ':answer';
const NOTE_SUFFIX = ':note';
/** Buttons' looks beyond a plain button (phone.css, questions.css). */
const CLASS = Object.freeze({ link: 'link', more: 'link q-more', chip: 'q-chip' });
/** What the buttons that open part of a card say. */
const LABEL = Object.freeze({ details: 'Details', hideDetails: 'Hide details', note: 'Add a note' });
/** What the cards' taps do (data-qa). */
const QA = Object.freeze({ pick: 'pick', approve: 'approve', deny: 'deny', send: 'send', more: 'more', note: 'note', details: 'details', skip: 'skip' });

/** @param {QuestionsApp} app */
export function questionsTab(app) {
  /** Which parts of which cards are open (`${id}:${part}`). @type {Set<string>} */
  const opened = new Set();
  /** What was typed, by `${id}:answer` and `${id}:note`. @type {Map<string, string>} */
  const drafts = new Map();
  /** Questions whose answer is on its way. @type {Set<string>} */
  const sending = new Set();

  /** @param {string} id @param {string} part */
  const isOpen = (id, part) => opened.has(`${id}:${part}`);

  /** @param {string} id @param {string} action @param {string} label @param {string} [cls] @param {string} [value] */
  const button = (id, action, label, cls = 'btn', value = '') =>
    `<button class="${cls}" data-qa="${action}" data-id="${esc(id)}"${value ? ` data-value="${esc(value)}"` : ''}${sending.has(id) ? ' disabled' : ''}>${label}</button>`;

  /** @param {string} key @param {string} placeholder */
  const box = (key, placeholder) => `<input class="q-input" data-qbox="${esc(key)}" placeholder="${placeholder}" value="${esc(drafts.get(key) ?? '')}" autocomplete="off">`;

  /** @param {PhoneQuestion} q */
  function choices(q) {
    const all = isOpen(q.id, QA.more);
    const shown = all ? q.choices : q.choices.slice(0, SHOWN_CHOICES);
    const rest = q.choices.length - shown.length;
    return shown.map(c => button(q.id, QA.pick, `${esc(c.label)}${c.recommended ? '<span class="q-rec">Recommended</span>' : ''}`, c.recommended ? 'ibtn fill' : 'ibtn', c.label)).join('')
      + (rest ? button(q.id, QA.more, `More (${rest})`, CLASS.more) : '');
  }

  /** @param {PhoneQuestion} q */
  function asks(q) {
    const note = isOpen(q.id, QA.note) ? box(`${q.id}${NOTE_SUFFIX}`, 'Note for the agent') : button(q.id, QA.note, LABEL.note, CLASS.link);
    if (q.ui === KIND.options) return `${choices(q)}${note}`;
    if (q.ui === KIND.approve) return `<div class="actions">${button(q.id, QA.deny, 'Deny', 'btn danger')}${button(q.id, QA.approve, 'Approve', 'btn primary')}</div>${note}`;
    if (q.ui === KIND.ask) {
      const chips = q.suggestions.map(s => button(q.id, QA.pick, esc(s), CLASS.chip, s)).join('');
      return `${chips ? `<div class="q-chips">${chips}</div>` : ''}<div class="q-send">${box(`${q.id}${ANSWER_SUFFIX}`, 'Answer')}${button(q.id, QA.send, 'Send', 'btn primary')}</div>`;
    }
    return q.button ? `<a class="btn q-link" href="${esc(q.button.url)}" target="_blank" rel="noopener noreferrer">${esc(q.button.label)}</a>` : '';
  }

  /** @param {PhoneQuestion} q */
  function card(q) {
    const waiting = q.status === WAITING;
    const details = q.details ? (isOpen(q.id, QA.details) ? `<div class="q-details">${esc(q.details)}</div>${button(q.id, QA.details, LABEL.hideDetails, CLASS.link)}` : button(q.id, QA.details, LABEL.details, CLASS.link)) : '';
    const body = waiting || q.ui === KIND.info ? asks(q) : `<div class="r-line">Sent: ${esc(q.said)}</div>`;
    return `<div class="q-card${waiting ? ' waiting' : ''}">
      <div class="q-head"><div class="r-meta">${esc(q.source)} · ${esc(app.age(q.at))}</div>${button(q.id, QA.skip, '×', 'note-clear')}</div>
      <div class="q-title">${esc(q.title)}</div>${details}${body}</div>`;
  }

  /** Sends the user's answer (or putting it away) to the PC. @param {string} id @param {object} reply */
  function answer(id, reply) {
    if (!app.send({ op: OP, id, ...reply })) return app.toast('Not connected to your PC.');
    sending.add(id);
    app.redraw();
  }

  /** @param {HTMLElement} el */
  function act(el) {
    const id = el.dataset.id ?? '';
    const action = el.dataset.qa ?? '';
    const note = drafts.get(`${id}${NOTE_SUFFIX}`) ?? '';
    if (action === QA.more || action === QA.note || action === QA.details) {
      const key = `${id}:${action}`;
      if (!opened.delete(key)) opened.add(key);
      return app.redraw();
    }
    if (action === QA.pick) return answer(id, { answer: el.dataset.value ?? '', note });
    if (action === QA.approve || action === QA.deny) return answer(id, { approved: action === QA.approve, note });
    if (action === QA.skip) return answer(id, { skip: true });
    sendWords(id);
  }

  /** An ask question's answer in words, as typed. @param {string} id */
  function sendWords(id) {
    const words = (drafts.get(`${id}${ANSWER_SUFFIX}`) ?? '').trim();
    if (words) answer(id, { answer: words });
  }

  return {
    /** The cards, waiting ones first, then answered ones and updates, newest first. */
    html() {
      const list = [...app.questions()].sort((a, b) => Number(b.status === WAITING) - Number(a.status === WAITING) || b.at - a.at);
      return list.length ? `<div class="section">Questions · ${list.filter(q => q.status === WAITING).length}</div>${list.map(card).join('')}` : '';
    },
    /** How many wait for an answer. */
    waiting: () => app.questions().filter(q => q.status === WAITING).length,
    /** Whether the user is typing in a card (a redraw then would close the keyboard). */
    typing: () => document.activeElement instanceof HTMLInputElement && !!document.activeElement.dataset.qbox,
    /** Whether an alert's id is one of the questions. @param {string} id */
    has: id => app.questions().some(q => q.id === id),
    /** @param {HTMLElement} target */
    click(target) {
      const el = /** @type {HTMLElement | null} */ (target.closest('[data-qa]'));
      if (el) act(el);
      return !!el;
    },
    /** @param {Event} e */
    typed(e) {
      const el = /** @type {HTMLInputElement} */ (e.target);
      if (el.dataset?.qbox) drafts.set(el.dataset.qbox, el.value);
    },
    /** Enter in an answer box sends it. @param {KeyboardEvent} e */
    key(e) {
      const el = /** @type {HTMLInputElement} */ (e.target);
      const key = el.dataset?.qbox ?? '';
      if (e.key !== 'Enter' || !key.endsWith(ANSWER_SUFFIX)) return;
      e.preventDefault();
      sendWords(key.slice(0, -ANSWER_SUFFIX.length));
    },
    /** The connection dropped: an answer on its way may never have arrived, so the cards can be answered again. */
    disconnected() {
      sending.clear();
    },
    /** The PC said how an answer went: a failure is said; one that went through clears its drafts. @param {any} m */
    answered(m) {
      if (m.op !== OP) return false;
      sending.delete(m.id);
      if (!m.ok) app.toast(m.error || 'That didn\'t go through.');
      else for (const suffix of [ANSWER_SUFFIX, NOTE_SUFFIX]) drafts.delete(`${m.id}${suffix}`);
      app.redraw();
      return true;
    },
  };
}
