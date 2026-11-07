// Tests for where Claude's replies and tool calls are in a terminal's output (src/Termilly.Desktop/wwwroot/js/agentsteps.js):
// a tool call Claude Code folded into one line, or one whose command starts like another's, must not take another
// step's line and lose the replies above it; a wrapped tool line still matches; a conversation drawn twice (after a
// resize) places each step in its newest copy.
// Run with: node --test tests/js/agentsteps.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough of a page for the modules to load (ui.js loads host.js).
globalThis.window = /** @type {any} */ ({ addEventListener() {}, external: { receiveMessage() {}, sendMessage() {} } });
globalThis.document = /** @type {any} */ ({ documentElement: { dataset: {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
globalThis.localStorage = /** @type {any} */ ({ getItem: () => null, setItem() {} });
globalThis.addEventListener = () => {};
const { shownSteps, placeSteps } = await import('../../src/Termilly.Desktop/wwwroot/js/agentsteps.js');

const reply = (text, at) => ({ kind: 'reply', text, at });
const tool = (name, text, at) => ({ kind: 'tool', tool: name, text, at });
const T = n => `2026-11-04T22:${String(n).padStart(2, '0')}:00Z`;
const prompts = [{ at: T(0) }, { at: T(10) }];

/** Each step's line, or -1. */
const lines = (steps, output) => placeSteps(steps, prompts, shownSteps(output)).map(p => p.line);

test('a folded tool call and a command starting like a later one leave the replies above them in place', () => {
  const output = [
    '> first prompt',
    '● Bash(cd D:/Development/termilly && sed -n 1,45p CHANGELOG.md)',
    '● The draft is in CHANGELOG.md on release/1.7.0, not committed yet:',
    '> second prompt',
    '  Searched for 1 pattern, read 1 file (ctrl+o to expand)',
    '● Bash(cd D:/Development/termilly && grep -n "no longer" src/x.js)',
    '● It was the matching, not the text.',
  ];
  const steps = [
    tool('Bash', 'cd D:/Development/termilly && sed -n 1,45p CHANGELOG.md', T(1)),
    reply('The draft is in `CHANGELOG.md` on `release/1.7.0`, not committed yet:\n\n```markdown\n## 1.7.0 (draft)', T(2)),
    tool('Grep', 'no longer in this terminal', T(11)), // folded: no line of its own
    tool('Read', 'D:\\Development\\termilly\\CHANGELOG.md', T(11)), // folded too: CHANGELOG.md is only on older lines
    tool('Bash', 'cd D:/Development/termilly && grep -n "no longer" src/x.js', T(12)),
    reply('It was the matching, not the text.', T(13)),
  ];
  assert.deepEqual(lines(steps, output), [1, 2, -1, -1, 5, 6]);
});

test('a tool line Claude Code wrapped in the middle of a word still matches', () => {
  const output = [
    '● Bash(cd D:/Development/termilly/.claude/worktrees/rel',
    '      ease-1.7.0 && npm test)',
    '● Done.',
  ];
  const steps = [tool('Bash', 'cd D:/Development/termilly/.claude/worktrees/release-1.7.0 && npm test', T(1)), reply('Done.', T(2))];
  assert.deepEqual(lines(steps, output), [0, 2]);
});

test('a conversation drawn twice places each step in its newest copy', () => {
  const once = ['● Bash(git status)', '● All clean, nothing to commit here.'];
  const steps = [tool('Bash', 'git status', T(1)), reply('All clean, nothing to commit here.', T(2))];
  assert.deepEqual(lines(steps, [...once, '', ...once]), [3, 4]);
});

test('a tool used on something with underscores matches its shown line', () => {
  const output = ['● Search(pattern: "read_terminal_output", path: "src")', '● Read it.'];
  const steps = [tool('Grep', 'read_terminal_output', T(1)), reply('Read it.', T(2))];
  assert.deepEqual(lines(steps, output), [0, 1]);
});
