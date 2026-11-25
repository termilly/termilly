// @ts-check
// What an agent hears for the user's answer to its question (js/questions.js), checked against what it asked: one of
// an options question's choices, Approve or Deny, or words; a note with the first two. Kept apart so it can be tested.

import { QUESTION_KIND, QUESTION_LIMIT } from './constants.js';

/**
 * What the user gives: the choice or words (answer), whether they approved, and a note.
 * @typedef {{ answer?: unknown, approved?: unknown, note?: unknown }} Reply
 */
/**
 * What a reply is checked against: the question's kind and, for options, its choices.
 * @typedef {{ ui: string, choices: { label: string }[] }} Asked
 */

/** @param {unknown} value */
export const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * What the agent hears for the user's reply, and how the card says it; throws when it isn't an answer to this one.
 * @param {Asked} q
 * @param {Reply} reply
 * @returns {{ result: object, said: string }}
 */
export function answerOf(q, reply) {
  const note = text(reply.note).slice(0, QUESTION_LIMIT.maxAnswer);
  const withNote = /** @param {object} r */ r => (note ? { ...r, note } : r);
  if (q.ui === QUESTION_KIND.approve) {
    if (typeof reply.approved !== 'boolean') throw new Error('Approve or Deny.');
    return { result: withNote({ approved: reply.approved }), said: reply.approved ? 'Approved' : 'Denied' };
  }
  if (q.ui === QUESTION_KIND.info) throw new Error('An update needs no answer.');
  const answer = text(reply.answer);
  if (!answer) throw new Error('The answer is empty.');
  if (q.ui === QUESTION_KIND.options && !q.choices.some(c => c.label === answer)) throw new Error('Pick one of the choices.');
  if (answer.length > QUESTION_LIMIT.maxAnswer) throw new Error('The answer is too long.');
  return { result: q.ui === QUESTION_KIND.ask ? { answer } : withNote({ answer }), said: answer };
}
