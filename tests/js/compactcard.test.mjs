// Tests for the question an agent waits on, read off its screen (src/Termilly.Desktop/wwwroot/js/compactcard.js), with
// screens as Claude Code 2.1 and Codex 0.167 draw them: the question, what it's about, and its numbered choices.
// Run with: node --test tests/js/compactcard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough of a page for the modules to load (ui.js loads host.js).
globalThis.window = /** @type {any} */ ({ addEventListener() {}, external: { receiveMessage() {}, sendMessage() {} } });
globalThis.document = /** @type {any} */ ({ documentElement: { dataset: {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
globalThis.localStorage = /** @type {any} */ ({ getItem: () => null, setItem() {} });
globalThis.addEventListener = () => {};
const { readMenu, menuKey } = await import('../../src/Termilly.Desktop/wwwroot/js/compactcard.js');

test('a Claude Code permission prompt: its question, the command, and its three choices', () => {
  const menu = readMenu([
    '> Run the shell command: git init',
    '',
    '● PowerShell(git init)',
    '  ⎿  Waiting…',
    '',
    '─────────────────────────────────────────────────────',
    ' PowerShell command',
    ' Initialize a git repository',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' git init',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' This command requires approval',
    '',
    ' Do you want to proceed?',
    ' > 1. Yes',
    '   2. Yes, and don’t ask again for: git init *',
    '   3. No',
    '',
    ' Esc to cancel · Tab to amend',
  ]);
  assert.ok(menu?.whole);
  assert.deepEqual({ ...menu, whole: undefined }, {
    whole: undefined,
    title: 'Do you want to proceed?',
    context: ['PowerShell command', 'Initialize a git repository', 'git init', 'This command requires approval'],
    choices: [
      { key: '1', label: 'Yes', detail: '', picked: true },
      { key: '2', label: 'Yes, and don’t ask again for: git init *', detail: '', picked: false },
      { key: '3', label: 'No', detail: '', picked: false },
    ],
  });
});

test('a Codex approval: the conversation above its gap is left out, and a wrapped choice keeps its words', () => {
  const menu = readMenu([
    '• Ran git init',
    '  └ C:/Users/x/repo',
    ' ',
    ' ',
    '  Would you like to run the following command?',
    ' ',
    '  Environment: local',
    ' ',
    '  Reason: May I allow git init to create the',
    '  repository metadata in this directory?',
    '› 1. Yes, proceed (y)',
    '  2. Yes, and don\'t ask again for commands that start',
    '     with `git init` (p)',
    '  3. No, and tell Codex what to do differently (esc)',
    '  Press enter to confirm or esc to cancel',
  ]);
  assert.equal(menu?.title, 'Would you like to run the following command?');
  assert.deepEqual(menu?.context, ['Environment: local', 'Reason: May I allow git init to create the', 'repository metadata in this directory?']);
  assert.deepEqual(menu?.choices.map(c => [c.key, c.label, c.detail]), [
    ['1', 'Yes, proceed (y)', ''],
    ['2', 'Yes, and don\'t ask again for commands that start', 'with `git init` (p)'],
    ['3', 'No, and tell Codex what to do differently (esc)', ''],
  ]);
});

test('a Claude Code question: a scrolled list with a gap, descriptions under the choices, and a choice under a rule', () => {
  const menu = readMenu([
    '> Use the AskUserQuestion tool to ask me whether I prefer tabs or spaces',
    '────────────────────────────────────────────────────────────',
    ' [ ] Indentation',
    '',
    'Do you prefer tabs or spaces for indentation?',
    '',
    '> 1. Tabs',
    '     Indent with tab characters.',
    '↓ 2. Spaces',
    '     Indent with space characters.',
    '────────────────────────────────────────────────────────────',
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ]);
  assert.equal(menu?.title, 'Do you prefer tabs or spaces for indentation?');
  assert.deepEqual(menu?.context, ['[ ] Indentation']);
  assert.deepEqual(menu?.choices, [
    { key: '1', label: 'Tabs', detail: 'Indent with tab characters.', picked: true },
    { key: '2', label: 'Spaces', detail: 'Indent with space characters.', picked: false },
    { key: '4', label: 'Chat about this', detail: '', picked: false },
  ]);
});

test('a question right under a command, which is drawn in a box: the question still stands apart', () => {
  const menu = readMenu([
    '────────────────────────────────────────────',
    ' Bash command',
    ' Append Done. to hello.txt and show result',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' │ cd "C:/repo" && printf x >> hello.txt |',
    ' │ cat hello.txt',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' Do you want to proceed?',
    ' > 1. Yes',
    '   4. No',
  ]);
  assert.equal(menu?.title, 'Do you want to proceed?');
  assert.deepEqual(menu?.context, ['Bash command', 'Append Done. to hello.txt and show result', 'cd "C:/repo" && printf x >> hello.txt |', 'cat hello.txt']);
});

test('no menu: a numbered list in the conversation is not one unless it starts at 1 and has a second choice', () => {
  assert.equal(readMenu(['Steps:', '  3. Build', '  4. Test']), null);
  // A list in the agent's words: numbered from 1, but with no pointer on a choice.
  assert.equal(readMenu(['Next steps:', '  1. Build', '  2. Test']), null);
  assert.equal(readMenu(['Only:', '> 1. One thing']), null);
  assert.equal(readMenu(['> ', '  ctx 5%']), null);
});

test('a menu keeps its key while the pointer moves, and another question gets another key', () => {
  const at = pointer => readMenu(['──────────', 'Do you want to proceed?', `${pointer === 1 ? '>' : ' '} 1. Yes`, `${pointer === 2 ? '>' : ' '} 2. No`]);
  const other = readMenu(['──────────', 'Do you want to make this edit?', '> 1. Yes', '  2. No']);
  assert.equal(menuKey(at(1)), menuKey(at(2)));
  assert.notEqual(menuKey(at(1)), menuKey(other));
});

test('a menu is known by all its prompt says, not only the lines the card shows; one whose start is off the screen has no key', () => {
  const prompt = command => ['────────────────────', 'Bash command', command, ...Array.from({ length: 13 }, (_, i) => `# line ${i}`), '', 'Do you want to proceed?', '> 1. Yes', '  2. No'];
  assert.notEqual(menuKey(readMenu(prompt('rm -rf a'))), menuKey(readMenu(prompt('rm -rf b'))));
  assert.equal(menuKey(readMenu(prompt('rm -rf a').slice(1))), '');
});

test('blank lines inside a command do not end the prompt where a rule starts it', () => {
  const prompt = command => ['─'.repeat(20), 'Bash command', command, '', '', 'echo done', '', 'Do you want to proceed?', '> 1. Yes', '  2. No'];
  assert.notEqual(menuKey(readMenu(prompt('rm -rf a'))), menuKey(readMenu(prompt('rm -rf b'))));
});
