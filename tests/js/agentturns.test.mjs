// Tests for agentturns.js: what a wait on an agent's turn waits out, played through the reports an agent makes and the
// text typed into it, in the orders they can come in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startsTurn, recordReport, noteTyping, planWait, isOver, replyOf, waitDone } from '../../src/Termilly.Desktop/wwwroot/js/agentturns.js';

/** A terminal with an agent waiting for a prompt, and the place typing is noted. */
const terminal = () => ({ tab: { agent: { state: 'idle' } }, typed: {} });

/**
 * An agent's report, as main.js takes it: counted first, then the agent's state follows it (exited: gone).
 * @param {any} tab
 * @param {string} event
 * @param {string} state
 * @param {string} [message]
 */
function report(tab, event, state, message) {
  recordReport(tab, { event, source: 'hooks', state, message });
  tab.agent = state === 'exited' ? null : { state, message };
}

const prompt = tab => report(tab, 'UserPromptSubmit', 'working');
const stop = (tab, answer) => report(tab, 'Stop', 'done', answer);

test('a prompt taken starts a turn; other events and the poll staying at work don\'t', () => {
  assert.equal(startsTurn({ event: 'UserPromptSubmit', source: 'hooks', state: 'working' }, 'idle'), true);
  assert.equal(startsTurn({ event: 'PreToolUse', source: 'hooks', state: 'working' }, 'working'), false);
  assert.equal(startsTurn({ source: 'poll', state: 'working' }, 'done'), true);
  assert.equal(startsTurn({ source: 'poll', state: 'working' }, 'working'), false);
});

test('send then wait: the wait waits for the turn to start and end', () => {
  const { tab, typed } = terminal();
  stop(tab, 'old answer'); // a turn before, still showing done
  noteTyping(tab, typed);
  const plan = planWait(tab, typed, null);
  assert.equal(isOver(tab, plan), false); // the previous turn's done is not this one
  prompt(tab);
  assert.equal(isOver(tab, plan), false);
  stop(tab, 'new answer');
  assert.equal(isOver(tab, plan), true);
  assert.equal(replyOf(tab, plan), 'new answer');
});

test('a quick turn over before the wait began is not missed, even after the agent exited', () => {
  const { tab, typed } = terminal();
  noteTyping(tab, typed);
  prompt(tab);
  stop(tab, 'quick');
  report(tab, 'SessionEnd', 'exited');
  const plan = planWait(tab, typed, null);
  assert.equal(isOver(tab, plan), true);
  assert.equal(replyOf(tab, plan), 'quick');
});

test('an answer typed to a permission prompt waits for the agent to go on, not the prompt still showing', () => {
  const { tab, typed } = terminal();
  prompt(tab);
  report(tab, 'PermissionRequest', 'needs-input');
  noteTyping(tab, typed); // "yes"
  const plan = planWait(tab, typed, null);
  assert.equal(isOver(tab, plan), false);
  report(tab, 'PostToolUse', 'working');
  assert.equal(isOver(tab, plan), false);
  stop(tab, 'did it');
  assert.equal(isOver(tab, plan), true);
  assert.equal(replyOf(tab, plan), 'did it');
});

test('typing noted after a delay (a production question) waits for the turn it started, not one that ended meanwhile', () => {
  const { tab, typed } = terminal();
  prompt(tab); // the user's own turn, going on while the question was open
  stop(tab, 'the user\'s answer');
  noteTyping(tab, typed); // approved now, so noted now: the user's turn is before it
  const plan = planWait(tab, typed, null);
  assert.equal(isOver(tab, plan), false);
  prompt(tab);
  stop(tab, 'ours');
  assert.equal(replyOf(tab, plan), 'ours');
});

test('typing refused is never noted, so a wait goes by the agent alone', () => {
  const { tab, typed } = terminal();
  const plan = planWait(tab, typed, null); // nothing typed: the next turn
  assert.equal(isOver(tab, plan), false);
  prompt(tab);
  stop(tab, 'x');
  assert.equal(isOver(tab, plan), true);
});

test('overlapping sends each get their own turn back, and a turn asked for by number wins', () => {
  const { tab, typed } = terminal();
  const first = noteTyping(tab, typed);
  prompt(tab);
  const second = noteTyping(tab, typed); // typed while the first turn works: it belongs to that turn
  assert.equal(first, 0);
  assert.equal(second, 0);
  stop(tab, 'one');
  const third = noteTyping(tab, typed);
  assert.equal(third, 1);
  const plan = planWait(tab, typed, first);
  assert.equal(isOver(tab, plan), true); // turn 1, after turn 0, is over
  assert.equal(isOver(tab, planWait(tab, typed, third)), false);
});

test('a permission answer waited on by the turn its send gave back is held to reports after the typing too', () => {
  const { tab, typed } = terminal();
  prompt(tab);
  report(tab, 'PermissionRequest', 'needs-input');
  const turn = noteTyping(tab, typed); // "yes", and send gives this turn back
  const plan = planWait(tab, typed, turn);
  assert.equal(isOver(tab, plan), false); // not the prompt that was just answered
  report(tab, 'PostToolUse', 'working');
  stop(tab, 'done after yes');
  assert.equal(isOver(tab, plan), true);
});

test('an older wait ending doesn\'t clear a newer send\'s typing', () => {
  const { tab, typed } = terminal();
  noteTyping(tab, typed);
  const first = planWait(tab, typed, null);
  prompt(tab);
  stop(tab, 'one');
  noteTyping(tab, typed); // the second send types before the first wait ends
  assert.equal(isOver(tab, first), true);
  waitDone(typed, first);
  const second = planWait(tab, typed, null);
  assert.equal(second.baseline, 1); // still the second send's turn
  assert.equal(isOver(tab, second), false);
  prompt(tab);
  stop(tab, 'two');
  assert.equal(replyOf(tab, second), 'two');
  waitDone(typed, second);
  assert.equal(typed.typedAt, null); // used up: a wait without new typing is for a later turn
});

test('with nothing typed, a turn going on is waited out, and one asking the user says so at once', () => {
  const { tab, typed } = terminal();
  prompt(tab);
  report(tab, 'PermissionRequest', 'needs-input');
  assert.equal(isOver(tab, planWait(tab, typed, null)), true);
});
