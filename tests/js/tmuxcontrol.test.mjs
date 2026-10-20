// Tests for the tmux control-mode parser (src/Termilly.Desktop/wwwroot/js/tmuxcontrol.js).
// Run with: node --test tests/js/tmuxcontrol.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unescapeOutput, parseLayout, panesOf, ControlParser, sendKeysCommands } from '../../src/Termilly.Desktop/wwwroot/js/tmuxcontrol.js';

test('%output data is octal-escaped', () => {
  assert.equal(unescapeOutput('hello\\015\\012\\033[32mok\\033[0m \\134 done'), 'hello\r\n\x1b[32mok\x1b[0m \\ done');
});

test('layouts become a tree of rows and columns', () => {
  const single = parseLayout('a87d,100x30,0,0,0');
  assert.deepEqual(single, { pane: 0, w: 100, h: 30, x: 0, y: 0 });

  const tree = parseLayout('c0e1,212x50,0,0{106x50,0,0,1,105x50,107,0[105x25,107,0,2,105x24,107,26,3]}');
  assert.equal(tree.dir, 'row');
  assert.deepEqual(tree.children.map(c => c.w), [106, 105]);
  assert.equal(tree.children[1].dir, 'column');
  assert.deepEqual(panesOf(tree), [1, 2, 3]);
});

test('answers go to the commands in order, notifications to the handler', () => {
  const seen = [];
  const answers = [];
  const parser = new ControlParser({ onNotification: (name, args) => seen.push([name, ...args]) });
  parser.expect((lines, error) => answers.push(['first', lines, error]));
  parser.expect((lines, error) => answers.push(['second', lines, error]));
  parser.feed('$ tmux -C new\r\n%begin 1 271 0\n%end 1 271 0\n%window-add @0\n%begin 1 278 1\n@0 a87d,100x30,0,0,0 bash\n%en');
  parser.feed('d 1 278 1\n%output %0 hi\\015\\012\n%begin 1 279 1\nno such pane\n%error 1 279 1\n%exit\n');

  assert.deepEqual(answers, [['first', ['@0 a87d,100x30,0,0,0 bash'], false], ['second', ['no such pane'], true]]);
  assert.deepEqual(seen, [['window-add', '@0'], ['output', '%0', 'hi\r\n'], ['exit']]);
});

test('typing becomes send-keys with hex bytes', () => {
  assert.deepEqual(sendKeysCommands('%1', 'ls\r'), ['send-keys -t %1 -H 6c 73 0d']);
  assert.deepEqual(sendKeysCommands('%2', 'é'), ['send-keys -t %2 -H c3 a9']);
  assert.equal(sendKeysCommands('%3', 'x'.repeat(450)).length, 3);
});
