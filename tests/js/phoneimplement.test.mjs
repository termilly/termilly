import test from 'node:test';
import assert from 'node:assert/strict';
import { todoTab } from '../../src/Termilly.Desktop/wwwroot/phone/todo.js';

/** A phone with one task on a list that can Implement; what it asks the PC is kept. */
function phone() {
  const task = { id: 't1', text: 'Fix the login', status: 'open', tags: [], details: '', notes: '', steps: [] };
  const workspace = { id: 'w', name: 'Work', color: '#fff', note: null, todo: { tasks: [task], implement: true } };
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

test('Silent asks the PC for a silent run, a new terminal for none', () => {
  const { sent, tap } = phone();
  tap({ td: 'implement', task: 't1' });
  tap({ td: 'implementHow', how: 'silent' });
  tap({ td: 'implementHow', how: 'terminal' });
  assert.deepEqual(sent.map(m => [m.action, m.task, !!m.silent]), [['taskImplement', 't1', true], ['taskImplement', 't1', false]]);
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
