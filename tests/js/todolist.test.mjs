import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTask, tasksFromLines, tasksFromNote, tagOfHeading, selectedLines, withoutLines, openCount, tagsIn, allTags, withTags, moveBefore,
  labelsForTags, retag, splitNote, hoverLines, treeRows, detailLines, tickSub, tickByNumber, linkSub, subProgress, implementPrompt, statusOf, TASK_STATUS, HOVER_TASKS,
} from '../../src/Termilly.Desktop/wwwroot/js/todolist.js';

const task = (id, more = {}) => ({ id, text: id, created: 0, ...more });

test('a typed line keeps its text and gives up its tags', () => {
  assert.deepEqual(parseTask('Rotate the key #deploy before Friday #Bug'), { text: 'Rotate the key before Friday', tags: ['deploy', 'bug'] });
  assert.deepEqual(parseTask('#bug'), { text: '', tags: ['bug'] });
  assert.deepEqual(parseTask('Issue #41 is not a #42x tag'.replace('#42x', 'done')), { text: 'Issue is not a done tag', tags: ['41'] });
});

test('a hash inside a word or a URL is not a tag', () => {
  assert.deepEqual(parseTask('Read https://x.dev/a#b and C#'), { text: 'Read https://x.dev/a#b and C#', tags: [] });
});

test('a pasted list is a task a line, without marks and boxes', () => {
  assert.deepEqual(tasksFromLines('- one\n* [ ] two\n3. three\n- [x] four\n\n[X] five\nsix'), [
    { text: 'one', tags: [], done: false },
    { text: 'two', tags: [], done: false },
    { text: 'three', tags: [], done: false },
    { text: 'four', tags: [], done: true },
    { text: 'five', tags: [], done: true },
    { text: 'six', tags: [], done: false },
  ]);
});

test('a note: list lines are tasks, a heading tags what is under it', () => {
  assert.deepEqual(tasksFromNote('## Deploy now\n- one\n- [x] two #bug\n\n# Other\n- three'), [
    { text: 'one', tags: ['deploy-now'], done: false },
    { text: 'two', tags: ['deploy-now', 'bug'], done: true },
    { text: 'three', tags: ['other'], done: false },
  ]);
});

test('a note: a paragraph is one task, the rest its details', () => {
  assert.deepEqual(tasksFromNote('First line\nsecond line\nthird\n\nNext one'), [
    { text: 'First line', tags: [], done: false, details: 'second line\nthird' },
    { text: 'Next one', tags: [], done: false },
  ]);
});

test('a heading on its own gives no task', () => {
  assert.deepEqual(tasksFromNote('## Only a heading\n\n'), []);
});

test('a heading is a clean tag', () => {
  assert.equal(tagOfHeading(' Deploy: the API! '), 'deploy-the-api');
});

test('a selection takes whole lines', () => {
  const text = 'one\ntwo\nthree';
  assert.deepEqual(selectedLines(text, 5, 6), { from: 4, to: 7 });
  assert.deepEqual(selectedLines(text, 1, 5), { from: 0, to: 7 });
  assert.deepEqual(selectedLines(text, 4, 8), { from: 4, to: 7 });
  assert.deepEqual(selectedLines(text, 8, 13), { from: 8, to: 13 });
});

test('no selection takes all the text', () => {
  assert.deepEqual(selectedLines('one\ntwo', 2, 2), { from: 0, to: 7 });
});

test('taking lines out leaves no gap', () => {
  assert.equal(withoutLines('one\n\ntwo\n\nthree', 5, 8), 'one\n\nthree');
  assert.equal(withoutLines('one', 0, 3), '');
});

test('a note gives up its selected lines as tasks, or all of them', () => {
  const note = '- one\n- two\n\nkeep';
  assert.equal(splitNote(note, 0, 5).rest, '- two\n\nkeep');
  assert.deepEqual(splitNote(note, 0, 5).tasks.map(x => x.text), ['one']);
  assert.equal(splitNote('- one', 2, 2).rest, '');
});

test('counts open tasks, for no list too', () => {
  assert.equal(openCount([task('a'), task('b', { done: true })]), 1);
  assert.equal(openCount(undefined), 0);
});

test('tags come from open tasks, with how many', () => {
  assert.deepEqual(tagsIn([task('a', { tags: ['x', 'y'] }), task('b', { tags: ['x'] }), task('c', { tags: ['z'], done: true })]), [['x', 2], ['y', 1]]);
});

test('all tags come from every list, done tasks too, most used first', () => {
  assert.deepEqual(allTags([[task('a', { tags: ['z', 'y'] }), task('b', { tags: ['y'], done: true })], undefined, [task('c', { tags: ['x'] })]]),
    [['y', 2], ['x', 1], ['z', 1]]);
});

test('kept tags stay with no task on them', () => {
  assert.deepEqual(allTags([[task('a', { tags: ['x'] })]], ['x', 'old']), [['x', 1], ['old', 0]]);
});

test('a tag is renamed, merged or taken off', () => {
  assert.deepEqual(retag(['a', 'b'], 'a', 'c'), ['c', 'b']);
  assert.deepEqual(retag(['a', 'b'], 'a', 'b'), ['b']);
  assert.deepEqual(retag(['a', 'b'], 'a', null), ['b']);
});

test('picked tags show any of them', () => {
  const tasks = [task('a', { tags: ['x'] }), task('b', { tags: ['y'] }), task('c')];
  assert.deepEqual(withTags(tasks, ['x', 'y']).map(t => t.id), ['a', 'b']);
  assert.equal(withTags(tasks, []).length, 3);
});

test('a task moves to where another is', () => {
  const tasks = [task('a'), task('b'), task('c')];
  moveBefore(tasks, 'c', 'a');
  assert.deepEqual(tasks.map(t => t.id), ['c', 'a', 'b']);
  moveBefore(tasks, 'c', 'b');
  assert.deepEqual(tasks.map(t => t.id), ['a', 'c', 'b']);
  moveBefore(tasks, 'nobody', 'a');
  assert.deepEqual(tasks.map(t => t.id), ['a', 'c', 'b']);
});

const list = (name, tasks = [], note = '') => ({ ref: { kind: 'x', id: name }, name, tasks: tasks.map(t => task(t, { text: t })), note });
const groups = [
  { list: list('acme', ['Move invoices']), color: 'blue', terms: [
    { list: list('api', ['Rotate webhook secret']), badge: 'b' },
    { list: list('logs'), badge: 'b' },
  ] },
  { list: list('web'), color: 'green', terms: [{ list: list('dev', ['Fix login']), badge: 'b' }] },
  { list: list('idle'), color: 'red', terms: [{ list: list('shell'), badge: 'b' }] },
];
const tree = (options = {}) => treeRows(groups, { isOpen: g => g.list.name === 'acme', isCurrent: l => l.name === 'acme', ...options }).map(r => `${'-'.repeat(r.depth)}${r.list.name}`);

test('the tree nests terminals under workspaces, folded ones closed', () => {
  assert.deepEqual(tree(), ['acme', '-api', '-logs', 'web', 'idle']);
});

test('a workspace counts its own tasks and its terminals', () => {
  const rows = treeRows(groups, { isOpen: () => false, isCurrent: () => false });
  assert.equal(rows[0].count, 2);
  assert.equal(rows[1].count, 1);
});

test('only with tasks hides what has nothing in it', () => {
  assert.deepEqual(tree({ only: true }), ['acme', '-api', 'web']);
});

test('only with tasks never hides the list shown', () => {
  assert.ok(tree({ only: true, isCurrent: l => l.name === 'idle' }).includes('idle'));
});

test('typing finds a terminal and opens its folded workspace', () => {
  assert.deepEqual(tree({ query: 'DEV' }), ['web', '-dev']);
});

test('typing finds the text of an open task', () => {
  assert.deepEqual(tree({ query: 'webhook' }), ['acme', '-api']);
});

test('a workspace found by name keeps its terminals', () => {
  assert.deepEqual(tree({ query: 'idle' }), ['idle', '-shell']);
});

test('nothing found gives no rows', () => {
  assert.deepEqual(tree({ query: 'nothing' }), []);
});

test('[] and [ ] and [x] in details are sub-items, with or without a list mark', () => {
  assert.deepEqual(detailLines('Some text\n[] one\n[ ] two\n- [x] three\n* [X] four').map(l => [l.sub, l.done, l.text]), [
    [false, false, 'Some text'], [true, false, 'one'], [true, false, 'two'], [true, true, 'three'], [true, true, 'four'],
  ]);
});

test('[] with nothing after it is only text', () => {
  assert.equal(detailLines('[]')[0].sub, false);
  assert.equal(detailLines('a [] b')[0].sub, false);
});

test('no details, no sub-items', () => {
  assert.deepEqual(subProgress(undefined), [0, 0]);
});

test('ticking a sub-item writes it back, and keeps its text', () => {
  assert.equal(tickSub('a\n[] one', 1, true), 'a\n[x] one');
  assert.equal(tickSub('- [x] one', 0, false), '- [ ] one');
});

test('a sub-item keeps the issue made from it, apart from its text', () => {
  const line = detailLines(linkSub('[ ] one', 0, 'https://github.com/a/b/issues/41'))[0];
  assert.equal(line.text, 'one');
  assert.deepEqual(line.issue, { url: 'https://github.com/a/b/issues/41', number: 41 });
  assert.equal(detailLines(tickSub(linkSub('[ ] one', 0, 'https://github.com/a/b/issues/41'), 0, true))[0].done, true);
});

test('progress counts sub-items', () => {
  assert.deepEqual(subProgress('text\n[x] a\n[] b\n[ ] c'), [1, 3]);
});

test('Implement asks for the task, its details and the steps left', () => {
  assert.equal(implementPrompt(task('t', { text: 'Fix  login', details: 'See the log\n[x] done step\n[] step one\n[] step two' })),
    "Work on this task from my Termilly To do list: 'Fix login'. Details: See the log Steps: 1) step one 2) step two. Tick each with the termilly MCP tool tick_task, or run: termilly tasks tick t N This is task t. When you finish, call the termilly MCP tool finish_task with a one-line summary, or run: termilly tasks done t --summary 'what you did'");
});

test('Implement on a sub-item names its task', () => {
  const task_ = task('t', { text: 'Fix login', details: '[] step one' });
  assert.equal(implementPrompt(task_, detailLines(task_.details)[0]),
    "Work on this step from my Termilly To do list: 'step one'. It is step 1 of task t, 'Fix login'. When you finish, call the termilly MCP tool finish_task with that task, step 1 and a one-line summary, or run: termilly tasks done t --step 1 --summary 'what you did'");
});

test('a step is ticked by its number among the steps', () => {
  assert.equal(tickByNumber('text\n[] one\n[] two', 2), 'text\n[] one\n[x] two');
  assert.equal(tickByNumber('text\n[] one', 5), 'text\n[] one');
});

test('a task is Open until it says otherwise, and done wins', () => {
  assert.equal(statusOf(task('a')), TASK_STATUS.open);
  assert.equal(statusOf(task('a', { status: TASK_STATUS.review })), TASK_STATUS.review);
  assert.equal(statusOf(task('a', { status: TASK_STATUS.review, done: true })), TASK_STATUS.done);
});

test('labels match tags in any case', () => {
  assert.deepEqual(labelsForTags(['Bug', 'feature', 'docs'], ['bug', 'docs']), ['Bug', 'docs']);
});

test('a hover shows the first open tasks and how many more', () => {
  const tasks = Array.from({ length: HOVER_TASKS + 2 }, (_, i) => task(`t${i}`));
  const lines = hoverLines([task('gone', { done: true }), ...tasks]);
  assert.equal(lines.length, HOVER_TASKS + 1);
  assert.equal(lines[0], '- t0');
  assert.equal(lines.at(-1), '2 more');
});
