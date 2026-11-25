// Tests for what an agent hears for the user's answer to its question (src/Termilly.Desktop/wwwroot/js/questionreply.js).
// Run with: node --test tests/js/questionreply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerOf } from '../../src/Termilly.Desktop/wwwroot/js/questionreply.js';

const options = { ui: 'options', choices: [{ label: 'Postgres' }, { label: 'Keep Redis' }] };

test('an options question takes one of its choices, with a note when there is one', () => {
  assert.deepEqual(answerOf(options, { answer: 'Postgres', note: '  try it on staging ' }), { result: { answer: 'Postgres', note: 'try it on staging' }, said: 'Postgres' });
  assert.deepEqual(answerOf(options, { answer: 'Keep Redis', note: '   ' }).result, { answer: 'Keep Redis' });
  assert.throws(() => answerOf(options, { answer: 'MySQL' }), /Pick one of the choices/);
});

test('approve takes a yes or no only, and says which', () => {
  const approve = { ui: 'approve', choices: [] };
  assert.deepEqual(answerOf(approve, { approved: false, note: 'not on Friday' }), { result: { approved: false, note: 'not on Friday' }, said: 'Denied' });
  assert.equal(answerOf(approve, { approved: true }).said, 'Approved');
  assert.throws(() => answerOf(approve, { approved: 'yes' }), /Approve or Deny/);
});

test('ask takes words but no note, and refuses an empty or too long answer', () => {
  const ask = { ui: 'ask', choices: [] };
  assert.deepEqual(answerOf(ask, { answer: ' Ada ', note: 'ignored' }), { result: { answer: 'Ada' }, said: 'Ada' });
  assert.throws(() => answerOf(ask, { answer: '  ' }), /empty/);
  assert.throws(() => answerOf(ask, { answer: 'x'.repeat(4001) }), /too long/);
});

test('an update is never answered', () => {
  assert.throws(() => answerOf({ ui: 'info', choices: [] }, { answer: 'ok' }), /no answer/);
});
