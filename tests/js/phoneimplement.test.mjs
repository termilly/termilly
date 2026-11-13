import test from 'node:test';
import assert from 'node:assert/strict';
import { todoTab } from '../../src/Termilly.Desktop/wwwroot/phone/todo.js';

/** A phone with one task on a list that can Implement; what it asks the PC is kept. @param {Record<string, any>} [todo] what else the PC says of the list */
function phone(todo = {}) {
  const task = { id: 't1', text: 'Fix the login', status: 'open', tags: [], details: '', notes: '', steps: [] };
  const workspace = { id: 'w', name: 'Work', color: '#fff', note: null, todo: { tasks: [task], implement: true, ...todo } };
  const snap = { workspaces: [workspace], terminals: [], typing: true, opening: true };
  /** @type {any[]} */
  const sent = [];
  const tab = todoTab(/** @type {any} */ ({ snap: () => snap, send: (/** @type {any} */ m) => sent.push(m), toast: () => {}, show: () => {}, redraw: () => {}, badge: () => '', openTerminal: () => {}, from: () => null, back: () => false }));
  const page = /** @type {any} */ ({ innerHTML: '', scrollTo: () => {}, querySelector: () => ({ scrollTop: 0 }) });
  globalThis.document = /** @type {any} */ ({ getElementById: () => page });
  const tap = (/** @type {Record<string, string>} */ dataset) => tab.click(/** @type {any} */ ({ closest: () => ({ dataset: { kind: 'workspace', id: 'w', ...dataset } }) }));
  tap({ td: 'open' });
  return { page, sent, tap };
}

test('Implement asks how first, and asks nothing of the PC yet', () => {
  const { page, sent, tap } = phone();
  tap({ td: 'implement', task: 't1' });
  assert.equal(sent.length, 0);
  assert.match(page.innerHTML, /In a new terminal/);
  assert.match(page.innerHTML, /Silent/);
});

test('picking how asks nothing yet; Start asks the PC for a silent run, or one in a new terminal', () => {
  const { sent, tap } = phone();
  tap({ td: 'implement', task: 't1' });
  tap({ td: 'implementHow', how: 'silent' });
  assert.equal(sent.length, 0);
  tap({ td: 'implementStart' });
  tap({ td: 'implement', task: 't1' });
  tap({ td: 'implementStart' });
  assert.deepEqual(sent.map(m => [m.action, m.task, !!m.silent]), [['taskImplement', 't1', true], ['taskImplement', 't1', false]]);
});

/** A phone whose PC has two agents, and a list whose plan is Claude Code reviewed by Codex, silently. */
function phoneWithAgents() {
  const made = phone({
    plan: { by: 'claude', reviewers: ['codex'], rounds: 3, run: 'silent' },
    agents: [{ kind: 'claude', name: 'Claude Code' }, { kind: 'codex', name: 'Codex' }], reviewers: ['claude', 'codex'],
  });
  made.tap({ td: 'implement', task: 't1' });
  return made;
}

test('the sheet opens with the list\'s plan, so Start runs it', () => {
  const { page, sent, tap } = phoneWithAgents();
  assert.match(page.innerHTML, /Reviewed by/);
  assert.match(page.innerHTML, /Codex reviews it before it comes to you/);
  tap({ td: 'implementStart' });
  assert.deepEqual(sent.map(m => [m.by, m.reviewers, m.silent]), [['claude', ['codex'], true]]);
});

test('another agent doing the work leaves the reviewers, and a reviewer is turned on and off', () => {
  const { page, sent, tap } = phoneWithAgents();
  tap({ td: 'implementBy', kind: 'codex' });
  assert.doesNotMatch(page.innerHTML, /before it comes to you/);
  tap({ td: 'implementReviewer', kind: 'claude' });
  assert.match(page.innerHTML, /Claude Code reviews it before it comes to you/);
  tap({ td: 'implementStart' });
  tap({ td: 'implement', task: 't1' });
  tap({ td: 'implementReviewer', kind: 'codex' });
  tap({ td: 'implementStart' });
  assert.deepEqual(sent.map(m => [m.by, m.reviewers]), [['codex', ['claude']], ['claude', []]]);
});

test('with one agent on the PC nobody is offered to review, or to pick', () => {
  const { page, tap } = phone({ agents: [{ kind: 'claude', name: 'Claude Code' }], reviewers: [] });
  tap({ td: 'implement', task: 't1' });
  assert.doesNotMatch(page.innerHTML, /Reviewed by|>By</);
  assert.match(page.innerHTML, /Claude Code works where you can watch it/);
});

test('a list opened from another tab goes back to it, one opened in To do back to To do', () => {
  const task = { id: 't1', text: 'Fix the login', status: 'open', tags: [], details: '' };
  const snap = { workspaces: [{ id: 'w', name: 'Work', color: '#fff', note: null, todo: { tasks: [task] } }], terminals: [], typing: true };
  let from = /** @type {string | null} */ ('Terminals');
  let backs = 0;
  const tab = todoTab(/** @type {any} */ ({
    snap: () => snap, send: () => {}, toast: () => {}, show: () => {}, redraw: () => {}, badge: () => '', openTerminal: () => {},
    from: () => from, back: () => { if (!from) return false; from = null; backs++; return true; },
  }));
  const page = /** @type {any} */ ({ innerHTML: '', scrollTo: () => {}, querySelector: () => ({ scrollTop: 0 }) });
  globalThis.document = /** @type {any} */ ({ getElementById: () => page });
  const tap = (/** @type {string} */ td) => tab.click(/** @type {any} */ ({ closest: () => ({ dataset: { td, kind: 'workspace', id: 'w' } }) }));
  tap('open');
  assert.match(tab.backHtml(), /Terminals/);
  tap('back');
  assert.equal(backs, 1);
  tap('open');
  assert.match(tab.backHtml(), /To do/);
  tap('back');
  assert.equal(backs, 1);
  assert.equal(tab.backHtml(), '');
});

test('a task\'s mark opens the statuses, and the one picked is asked of the PC', () => {
  const { page, sent, tap } = phone();
  tap({ td: 'check', task: 't1' });
  assert.equal(sent.length, 0);
  assert.match(page.innerHTML, /In progress/);
  tap({ td: 'pickStatus', status: 'review' });
  assert.deepEqual(sent.map(m => [m.action, m.task, m.status]), [['taskStatus', 't1', 'review']]);
});

test('Accept in a task\'s sheet closes it and says the task moved to Done', () => {
  const { page, sent, tap } = phone();
  tap({ td: 'task', task: 't1' });
  assert.notEqual(page.innerHTML, '');
  tap({ td: 'status', status: 'done', accept: '1', task: 't1' });
  assert.deepEqual(sent.map(m => [m.action, m.status]), [['taskStatus', 'done']]);
  assert.equal(page.innerHTML, '');
});
