import test from 'node:test';
import assert from 'node:assert/strict';
import { todoTab } from '../../src/Termilly.Desktop/wwwroot/phone/todo.js';
import { markHtml } from '../../src/Termilly.Desktop/wwwroot/phone/todoviews.js';

/** A phone with one workspace, open on its list as a tap would. @param {string | null} text */
function phone(text) {
  const workspace = { id: 'w', name: 'Work', color: '#fff', note: text === null ? null : { text, pinned: false }, todo: { tasks: [] } };
  const snap = { workspaces: [workspace], terminals: [], typing: true };
  const tab = todoTab(/** @type {any} */ ({ snap: () => snap, send: () => {}, toast: () => {}, show: () => {}, redraw: () => {}, badge: () => '', openTerminal: () => {}, from: () => null, back: () => false }));
  const home = /** @type {any} */ ({ scrollTo: () => {} });
  const tap = (/** @type {string} */ td) => tab.click(/** @type {any} */ ({ closest: () => ({ dataset: { td, kind: 'workspace', id: 'w' } }) }));
  globalThis.document = /** @type {any} */ ({ getElementById: () => home });
  tap('open');
  return { tab, workspace, tap };
}

test('a list with a note keeps its Note button', () => {
  assert.match(phone('staging is read-only').tab.noteButton(), /Note/);
});

test('a list without a note has no Note button', () => {
  assert.equal(phone(null).tab.noteButton(), '');
});

test('the note page leaves when the note is cleared, and the button stays gone', () => {
  const { tab, workspace, tap } = phone('staging is read-only');
  tap('note');
  assert.equal(tab.title(), 'Note');
  assert.equal(tab.noteButton(), '');
  workspace.note = null;
  assert.equal(tab.title(), 'Work');
  assert.equal(tab.noteButton(), '');
  assert.match(tab.backHtml(), /To do/);
});

/** A workspace's list as the phone gets it. @param {object[]} tasks @param {string | null} note */
const listWith = (tasks, note = null) => /** @type {any} */ ({ kind: 'workspace', id: 'w', tasks, note: note === null ? null : { text: note } });

test('a mark counts the tasks left and says whose list it opens', () => {
  const mark = markHtml(listWith([{ status: 'open' }, { status: 'done' }]));
  assert.match(mark, /data-kind="workspace" data-id="w"/);
  assert.match(mark, /To do, 1 left/);
});

test('a list with every task done keeps its mark, without a number', () => {
  const mark = markHtml(listWith([{ status: 'done' }]));
  assert.match(mark, /aria-label="To do"/);
  assert.match(mark, /<\/svg><\/button>$/);
});

test('a list with only a note has a mark, and an empty one has none', () => {
  assert.match(markHtml(listWith([], 'staging is read-only')), /td-mark/);
  assert.equal(markHtml(listWith([])), '');
  assert.equal(markHtml(undefined), '');
});
