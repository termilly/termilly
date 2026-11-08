import test from 'node:test';
import assert from 'node:assert/strict';
import { todoTab } from '../../src/Termilly.Desktop/wwwroot/phone/todo.js';

/** A phone with one task on a list that can Implement; what it asks the PC is kept. */
function phone() {
  const task = { id: 't1', text: 'Fix the login', status: 'open', tags: [], details: '' };
  const workspace = { id: 'w', name: 'Work', color: '#fff', note: null, todo: { tasks: [task], implement: true } };
  const snap = { workspaces: [workspace], terminals: [], typing: true, opening: true };
  /** @type {any[]} */
  const sent = [];
  const tab = todoTab(/** @type {any} */ ({ snap: () => snap, send: (/** @type {any} */ m) => sent.push(m), toast: () => {}, show: () => {}, redraw: () => {}, badge: () => '', openTerminal: () => {} }));
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
