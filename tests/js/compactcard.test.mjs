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
const { readMenu, menuKey, keyedByWhatShows, previewLines, cardHtml, PROMPT_START } = await import('../../src/Termilly.Desktop/wwwroot/js/compactcard.js');

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
  assert.deepEqual({ ...menu, whole: undefined, start: undefined, prompt: undefined }, {
    start: undefined,
    whole: undefined,
    prompt: undefined,
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
  const menu = /** @type {any} */ (at(1));
  assert.notEqual(menuKey({ ...menu, asked: 1 }), menuKey({ ...menu, asked: 2 }), 'the next question that says the same');
  assert.equal(menuKey({ ...menu, asked: 1 }), menuKey({ ...at(2), asked: 1 }));
});

test('a menu is known by all its prompt says, not only the lines the card shows; one whose start is off the screen has no key', () => {
  const prompt = command => ['────────────────────', 'Bash command', command, ...Array.from({ length: 13 }, (_, i) => `# line ${i}`), '', 'Do you want to proceed?', '> 1. Yes', '  2. No'];
  assert.notEqual(menuKey(readMenu(prompt('rm -rf a'))), menuKey(readMenu(prompt('rm -rf b'))));
  assert.equal(menuKey(readMenu(prompt('rm -rf a').slice(1))), '');
});

test('a prompt taller than the screen is read whole from the scrollback above it, with the same key as on a tall screen', () => {
  const prompt = ['> earlier', '', '────────────────────', ' Bash command', '', '   rm -rf a', ...Array.from({ length: 13 }, (_, i) => `   # line ${i}`), '', ' Do you want to proceed?', ' > 1. Yes', '   2. No'];
  const screenTop = 6;
  const deeper = readMenu(prompt, { screenTop });
  assert.equal(menuKey(deeper), menuKey(readMenu(prompt.slice(2))));
  assert.equal(deeper?.start, -1);
  assert.deepEqual(deeper?.prompt?.slice(0, 3), ['Bash command', '', '  rm -rf a']);
  assert.equal(deeper?.prompt?.at(-1), 'Do you want to proceed?');
});

test('choices only in the scrollback are not a menu on the screen', () => {
  assert.equal(readMenu(['──────────', 'Do you want to proceed?', '> 1. Yes', '  2. No', 'Done.', '> '], { screenTop: 4 }), null);
});

test('a menu whose first choices scrolled above a short screen is still read, with all its choices', () => {
  const menu = readMenu(['──────────', 'Do you want to proceed?', '> 1. Yes', '  2. No', '', 'Esc to cancel'], { screenTop: 3 });
  assert.deepEqual(menu?.choices.map(c => [c.key, c.picked]), [['1', true], ['2', false]]);
  assert.notEqual(menuKey(/** @type {any} */ (menu)), '');
});

test('a Codex command with two blank lines of its own: the prompt starts at the gap above its question', () => {
  const rows = ['• Ran ls', '', '', '  Would you like to run the following command?', '', '  $ cat <<EOF', '  one', '', '', '  two', '  EOF', '› 1. Yes', '  2. No'];
  assert.equal(readMenu(rows, { startsAt: PROMPT_START.gap })?.prompt?.[0], 'Would you like to run the following command?');
  // A prompt that asks nothing starts at its nearest gap, and the search stops at the conversation's margin.
  const plain = ['• Ran ls', 'Is this a question?', '', '', '  Allow this', '› 1. Yes', '  2. No'];
  assert.equal(readMenu(plain, { startsAt: PROMPT_START.gap })?.prompt?.[0], 'Allow this');
  // A command line after its own gap that ends in "?" isn't the question: that's the highest one.
  const asking = ['• Ran ls', '', '', '  Would you like to run the following command?', '', '  $ cat <<EOF', '', '', '  is this two?', '  EOF', '› 1. Yes', '  2. No'];
  assert.equal(readMenu(asking, { startsAt: PROMPT_START.gap })?.prompt?.[0], 'Would you like to run the following command?');
});

test('a Codex prompt whose question is above the lines read has no known start, so the scrollback is read', () => {
  const tail = ['  $ cat <<EOF', '  one', '', '', '  two', '  EOF', '› 1. Yes', '  2. No'];
  assert.equal(readMenu(tail, { startsAt: PROMPT_START.gap })?.whole, null);
  const whole = readMenu(['', '', '  Would you like to run the following command?', '', ...tail], { startsAt: PROMPT_START.gap, screenTop: 4, atTop: true });
  assert.equal(whole?.prompt?.[0], 'Would you like to run the following command?');
  // At the top of all the terminal has, a prompt that asks nothing starts at its nearest gap.
  assert.equal(readMenu(['', '', '  Allow this', '› 1. Yes', '  2. No'], { startsAt: PROMPT_START.gap, atTop: true })?.prompt?.[0], 'Allow this');
});

test('a prompt cut off at the top is known by what shows and what the agent said it is about, and gets its buttons', () => {
  const prompt = command => ['Bash command', command, ...Array.from({ length: 13 }, (_, i) => `# line ${i}`), '', 'Do you want to proceed?', '> 1. Yes', '  2. No'];
  const cut = readMenu(prompt('rm -rf a').slice(1));
  assert.ok(cut);
  const keyed = keyedByWhatShows(cut, ['Bash', 'rm -rf a']);
  assert.notEqual(menuKey(keyed), '');
  assert.notEqual(menuKey(keyed), menuKey(keyedByWhatShows(cut, ['Bash', 'rm -rf b'])));
  assert.notEqual(menuKey(keyed), menuKey(keyedByWhatShows(cut, ['Bash', 'rm -rf a', 2])), 'the next question that looks the same');
  assert.match(cardHtml(keyed, 'Claude', { open: 'o', preview: 'p' }), /data-choice="1"/);
  assert.equal(previewLines(keyed)[0], '(The start of this prompt could not be found.)');
  const whole = readMenu(['──────────', ...prompt('rm -rf a')]);
  assert.ok(whole);
  assert.equal(keyedByWhatShows(whole, ['x']), whole);
  assert.equal(previewLines(whole)[0], 'Bash command');
});

test('up the scrollback, a Codex prompt starts at its gap, not at a rule further up in the conversation', () => {
  const rows = ['──────────', 'an earlier answer', '', '', '  Would you like to run the following command?', ...Array.from({ length: 20 }, (_, i) => `  $ step ${i}`), '› 1. Yes', '  2. No'];
  const codex = readMenu(rows, { screenTop: 10, startsAt: PROMPT_START.gap });
  assert.equal(codex?.prompt?.[0], 'Would you like to run the following command?');
  assert.equal(readMenu(rows, { screenTop: 10, startsAt: PROMPT_START.rule })?.prompt?.[0], 'an earlier answer');
});

test('the preview has all the prompt says; a question without one has its title and what it is about', () => {
  const menu = readMenu(['──────────', ...Array.from({ length: 20 }, (_, i) => `  line ${i}`), '', '  Do you want to proceed?', '  > 1. Yes', '    2. No']);
  assert.equal(menu?.context.length, 12);
  assert.equal(previewLines(/** @type {any} */ (menu)).length, 22);
  assert.deepEqual(previewLines({ title: 'Ready?', context: ['# Plan', '', 'Step'], choices: [] }), ['Ready?', '', '# Plan', '', 'Step']);
  assert.match(cardHtml(/** @type {any} */ (menu), 'Claude', { open: 'o', preview: 'p' }), /class="p"[^>]*>Preview</);
});

test('blank lines inside a command do not end the prompt where a rule starts it', () => {
  const prompt = command => ['─'.repeat(20), 'Bash command', command, '', '', 'echo done', '', 'Do you want to proceed?', '> 1. Yes', '  2. No'];
  assert.notEqual(menuKey(readMenu(prompt('rm -rf a'))), menuKey(readMenu(prompt('rm -rf b'))));
});

test('a prompt with its question above a gap still says what it asks: the nearest paragraph above', () => {
  const menu = readMenu([
    '• Checking the To do list.',
    ' ',
    '  Allow the termilly MCP server to run tool "list_tasks"?',
    ' ',
    ' ',
    '› 1. Allow',
    '  2. Allow for this session',
    '  3. Cancel',
  ]);
  assert.equal(menu?.title, 'Allow the termilly MCP server to run tool "list_tasks"?');
  assert.deepEqual(menu?.choices.map(c => c.label), ['Allow', 'Allow for this session', 'Cancel']);
});
