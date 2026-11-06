import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTask, tasksFromLines, tasksFromNote, tagOfHeading, selectedLines, withoutLines, openCount, tagsIn, allTags, withTags, moveBefore,
  labelsForTags, hoverLines, HOVER_TASKS,
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
