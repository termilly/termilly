// Tests for autocomplete's suggestions (src/Termilly.Desktop/wwwroot/js/suggest.js): what the grey text and the list offer.
// Run with: node --test tests/js/suggest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexRuns, addRun, bestFor, suggest, nextWord, partialWord, screenWords } from '../../src/Termilly.Desktop/wwwroot/js/suggest.js';

const now = 1_800_000_000_000;
const hour = 3_600_000;
const run = (command, { cwd = 'D:\\work\\api', exitCode = 0, ago = hour, host = null } = {}) => ({ command, cwd, exitCode, at: now - ago, host });

test('the grey text finishes what is typed, never repeats it, and needs something typed', () => {
  const index = indexRuns([run('git status'), run('git push')]);
  assert.equal(bestFor(index, 'git s', { now })?.command, 'git status');
  assert.equal(bestFor(index, 'git status', { now }), null);
  assert.equal(bestFor(index, '', { now }), null);
  assert.equal(bestFor(index, '   ', { now }), null);
});

test('a command run in this folder beats one run more often elsewhere', () => {
  const index = indexRuns([
    ...Array.from({ length: 5 }, () => run('npm run dev -- --port 3000', { cwd: 'D:\\work\\web' })),
    run('npm run dev', { cwd: 'D:\\work\\api' }),
  ]);
  assert.equal(bestFor(index, 'npm run d', { cwd: 'd:/work/api/', now })?.command, 'npm run dev');
  assert.equal(bestFor(index, 'npm run d', { cwd: 'D:\\work\\web', now })?.command, 'npm run dev -- --port 3000');
});

test('a run anywhere in the repository counts, less than this folder', () => {
  const index = indexRuns([run('make test', { cwd: 'D:\\work\\api\\src' }), run('make tidy', { cwd: 'D:\\other' })]);
  assert.equal(bestFor(index, 'make t', { cwd: 'D:\\work\\api', root: 'D:\\work\\api', now })?.command, 'make test');
});

test('a command that only ever failed drops below one that worked', () => {
  const index = indexRuns([run('git pul', { exitCode: 1, ago: 60_000 }), run('git pull', { ago: 5 * hour })]);
  const [first, second] = suggest(index, 'git pu', { now, limit: 5 });
  assert.equal(first.command, 'git pull');
  assert.equal(second.command, 'git pul');
  assert.equal(second.failed, true);
});

test('commands from other computers come after this one\'s', () => {
  const index = indexRuns([run('ssh optiplex', { host: 'laptop', ago: 60_000 }), run('ssh mac', { ago: 2 * hour })]);
  assert.deepEqual(suggest(index, 'ssh ', { now, limit: 5 }).map(s => s.command), ['ssh mac', 'ssh optiplex']);
});

test('redacted and multi-line commands are never suggested', () => {
  const index = indexRuns([run('export TOKEN=[redacted]'), run('echo a\necho b'), run('export PATH=x')]);
  assert.deepEqual(suggest(index, 'e', { now, limit: 5 }).map(s => s.command), ['export PATH=x']);
});

test('the list adds commands that have the text elsewhere, after those that start with it', () => {
  const index = indexRuns([run('docker compose up'), run('compose-lint')]);
  assert.deepEqual(suggest(index, 'compose', { now, limit: 5, anywhere: true }).map(s => s.command), ['compose-lint', 'docker compose up']);
  assert.deepEqual(suggest(index, 'compose', { now, limit: 5 }).map(s => s.command), ['compose-lint']);
});

test('a new run counts at once', () => {
  const index = indexRuns([]);
  addRun(index, run('cargo build --release'));
  assert.equal(bestFor(index, 'cargo', { now })?.command, 'cargo build --release');
});

test('Ctrl+→ takes the next word with its space, or the next part of a path', () => {
  assert.equal(nextWord('build src/Termilly.Desktop -c Debug'), 'build ');
  assert.equal(nextWord(' -c Debug'), ' -c ');
  assert.equal(nextWord('src/Termilly.Desktop'), 'src/');
  assert.equal(nextWord('Debug'), 'Debug');
});

test('the word being typed is what follows the last space', () => {
  assert.equal(partialWord('kubectl logs -f api-'), 'api-');
  assert.equal(partialWord('kubectl logs '), '');
});

test('words on the screen: newest first, unique, without quotes or brackets, starting with the word typed', () => {
  const lines = ['NAME                 READY', 'api-7d9f8c6b5-x2kqp  1/1', 'worker-5c8d7f9b4-lm3nz 1/1', '"api-7d9f8c6b5-x2kqp",'];
  assert.deepEqual(screenWords(lines, 'api', 5), ['api-7d9f8c6b5-x2kqp']);
  assert.deepEqual(screenWords(lines, '', 2), ['api-7d9f8c6b5-x2kqp', 'worker-5c8d7f9b4-lm3nz']);
  assert.deepEqual(screenWords(['ab ok', '---- ===='], '', 5), []);
});

test('a shell gets its own commands, never only another shell\'s, and older ones without a shell after its own', () => {
  const index = indexRuns([
    { command: 'dir /s', cwd: 'C:/a', exitCode: 0, at: now - 5 * hour, shell: 'cmd' },
    { command: 'Get-ChildItem -Recurse', cwd: 'C:/a', exitCode: 0, at: now - 60_000, shell: 'powershell' },
    { command: 'dir /b', cwd: 'C:/a', exitCode: 0, at: now - 60_000, shell: null },
  ]);
  const where = { cwd: 'C:/a', now };
  assert.deepEqual(suggest(index, 'dir', { ...where, shell: 'cmd', limit: 5 }).map(s => s.command), ['dir /s', 'dir /b']);
  assert.equal(bestFor(index, 'Get', { ...where, shell: 'cmd' }), null);
  assert.equal(bestFor(index, 'Get', { ...where, shell: 'powershell' })?.command, 'Get-ChildItem -Recurse');
  // A shell nobody can tell (a custom profile) gets everything.
  assert.equal(suggest(index, '', { ...where, limit: 5 }).length, 3);
});
