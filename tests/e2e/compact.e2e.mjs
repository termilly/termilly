import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until, clickText } from './gitsteps.mjs';

const question = 'Would you like to run the following command?';
const choices = ['› 1. Yes, proceed (y)', "  2. Yes, and don't ask again for commands that start", '     with `git init` (p)', '  3. No, and tell Codex what to do differently (esc)'];
const approval = ['', '', `  ${question}`, '', '  Environment: local', '', '  Reason: May I allow git init to create the', '  repository metadata in this directory?', ...choices, '  Press enter to confirm or esc to cancel'];

async function events(app) {
  try { return (await readFile(path.join(app.dataDir, 'keys.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Each scenario owns a fresh process: no consumed prompt or keyed choice can leak into the next assertion.
/**
 * Codex waits on the question, as its PermissionRequest hook reports it (the fake has no hooks): the view shows the
 * card, not the live terminal it shows for a menu while an agent starts.
 */
async function waitOnQuestion(app) {
  await app.eval(async t => {
    const { state, agentChanged } = await t.import('store.js');
    const { AGENT_STATE, AGENT_KIND, AGENT_SOURCE, HOOK_EVENT } = await t.import('constants.js');
    const tab = [...state.tabs.values()].find(tab => tab.view?.term && tab.compactView);
    tab.agent = { state: AGENT_STATE.needsInput, source: AGENT_SOURCE.hooks, kind: AGENT_KIND.codex, event: HOOK_EVENT.permissionRequest, tool: 'Bash', target: 'git init' };
    agentChanged(tab);
  });
  await until(() => app.eval(t => !t.$('.compact-view').classList.contains('drawer')), 'the card without the drawer');
}

async function scenario(name, lines, body, { waiting = false, ready = '.cv-choice[data-choice="3"]', prompt = {} } = {}) {
  const repo = await makeRepo();
  let app, failed = true;
  try {
    app = await startApp({ folder: repo.folder, name, agents: { codex: { stdout: '', prompt: { lines, ...prompt } } } });
    // Launch the bare command so shell integration recognizes the agent.
    await app.waitFor('.xterm');
    await app.eval(async t => {
      const { state } = await t.import('store.js');
      const { typeAtPrompt } = await t.import('terminals.js');
      const tab = [...state.tabs.values()].find(tab => tab.view?.term);
      typeAtPrompt(tab, 'codex');
    });

    await until(() => app.eval(async t => {
      const { state, runningAgent } = await t.import('store.js');
      return [...state.tabs.values()].some(tab => runningAgent(tab) === 'codex');
    }), 'shell recognizes Codex');
    await app.waitFor('.view-btn');
    await app.click('.view-btn');
    await clickText(app, '.menu-row', 'Compact');
    if (waiting) await waitOnQuestion(app);
    await app.waitFor(ready);
    assert.equal(await app.eval(t => t.$('.cv-input').value), '');
    await body(app);
    failed = false;
  } finally { await app?.stop({ failed }); await repo.dispose(); }
}

async function received(app, digit) {
  await until(async () => (await events(app)).some(e => e.event === 'exit' && e.reason === 'pick'), 'fake received pick');
  const log = await events(app);
  assert.deepEqual(log.filter(e => e.event === 'key').map(e => e.sequence), [digit]);
  assert.equal(log.find(e => e.event === 'exit').pick, digit);
  assert.equal(log.find(e => e.event === 'ready').raw, true);
}

test('Codex question, context, choices, shim arguments and arrow/Enter stdin', () => scenario('compact-arrows', approval, async app => {
  assert.equal(await app.text('.cv-question'), question);
  assert.deepEqual(await app.eval(t => t.$$('.cv-context > div').map(e => e.textContent)), ['Environment: local', 'Reason: May I allow git init to create the', 'repository metadata in this directory?']);
  assert.deepEqual(await app.eval(t => t.$$('.cv-choice').map(e => e.dataset.choice)), ['1', '2', '3']);
  assert.match(await app.text('.cv-choice[data-choice="2"]'), /with `git init` \(p\)/);
  const call = (await app.agentCalls()).find(c => c.agent === 'codex');
  assert.ok(call, 'fake Codex was invoked');
  const config = call.args.find(arg => arg.startsWith('mcp_servers.termilly={'));
  assert.ok(config, 'shim supplies the Termilly MCP server');
  assert.match(config, /default_tools_approval_mode='approve'/);
  for (const [key, choice] of [['ArrowUp', '3'], ['ArrowDown', '1'], ['ArrowDown', '2'], ['ArrowUp', '1'], ['ArrowDown', '2']]) {
    await app.key('.cv-input', key);
    await app.waitFor(`.cv-choice.keyed[data-choice="${choice}"]`);
  }
  assert.deepEqual((await events(app)).filter(e => e.event === 'key'), [], 'arrows stay in the card');
  await app.key('.cv-input', 'Enter');
  await received(app, '2');
}));

test('a digit immediately reaches Codex stdin', () => scenario('compact-digit', approval, async app => {
  await app.key('.cv-input', '3');
  await received(app, '3');
}));

test('a Codex question above two blank lines is retained', () => scenario('compact-gap', ['', '', '  Allow the termilly MCP server to run tool "list_tasks"?', '', '', ...choices], async app => {
  assert.equal(await app.text('.cv-question'), 'Allow the termilly MCP server to run tool "list_tasks"?');
  assert.equal(await app.eval(t => t.$$('.cv-choice').length), 3);
}));

test('a prompt with no question falls back to Codex asks', () => scenario('compact-fallback', ['', '', ...choices], async app => {
  assert.equal(await app.text('.cv-question'), 'Codex asks');
}));


// Codex's update offer as it starts (what a resume shows first), as Codex 0.170 draws it: its screen cleared, one blank row
// above it, its cursor parked under it.
const update = ['', '  Update available · 0.167.2 → 0.170.0', '  Release notes: https://github.com/openai/codex/releases/latest', '',
  '› 1. Update now (runs `npm install -g @openai/codex`)', '  2. Skip', '  3. Skip until next version', '', '  enter continue · esc skip'];

/** A resumed session: the feed has its lines before Codex shows its prompt. */
const resumed = app => app.eval(async t => {
  const { state, agentChanged } = await t.import('store.js');
  const tab = [...state.tabs.values()].find(tab => tab.view?.term && tab.compactView);
  tab.compact.lines = [{ key: 'p1', kind: 'prompt', text: 'an earlier prompt' }];
  agentChanged(tab);
});

test("Codex's update offer is a card, also under a session the view already shows, never the live terminal", () => scenario('compact-update', update, async app => {
  const drawer = () => app.eval(t => t.$('.compact-view').classList.contains('drawer'));
  assert.equal(await drawer(), false, 'with the feed empty');
  await resumed(app);
  await app.waitFor('.cv-prompt');
  await app.waitFor('.cv-choice[data-choice="2"]');
  assert.equal(await drawer(), false, 'under the session');
  await app.click('.cv-choice[data-choice="2"]');
  await received(app, '2');
}));

test('Codex starting with no menu (an update it runs) says so under a resumed session, with the terminal a click away', () => scenario('compact-updating', ['', 'Updating Codex via `npm install -g @openai/codex`...'], async app => {
  await resumed(app);
  await app.waitFor('.cv-prompt');
  await app.waitFor('.cv-prompt ~ .cv-empty .cv-open-terminal');
  await app.click('.cv-empty .cv-open-terminal');
  await app.waitFor('.compact-view', { gone: true });
}, { ready: '.cv-empty .cv-open-terminal' }));

test('Send from the prompt box never shows the terminal under it while Codex takes the prompt', () => scenario('compact-send', ['', '  >_ OpenAI Codex', ''], async app => {
  // Counts each time the drawer opens (the terminal's rows showing under the view).
  await app.eval(t => {
    const view = t.$('.compact-view');
    globalThis.drawerOpened = 0;
    new globalThis.MutationObserver(() => { if (view.classList.contains('drawer')) globalThis.drawerOpened++; }).observe(view, { attributes: true, attributeFilter: ['class'] });
    const input = t.$('.cv-input');
    input.value = 'say hello';
    input.dispatchEvent(new globalThis.Event('input'));
  });
  await app.click('.cv-send');
  await until(async () => (await events(app)).some(e => e.event === 'prompt' && e.text === 'say hello'), 'Codex took the prompt');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(await app.eval(() => globalThis.drawerOpened), 0);
}, { ready: '.cv-input:not([readonly])', prompt: { input: '› ', picks: [], echoMs: 30, takeMs: 300 } }));

const tall =['', '', `  ${question}`, '', ...Array.from({ length: 70 }, (_, i) => `  $ step ${i}`), ...choices, '  Press enter to confirm or esc to cancel'];

/** Whether choice 3's button shows inside the feed. */
const choiceInSight = app => app.eval(t => {
  const feed = t.$('.cv-feed').getBoundingClientRect(), button = t.$('.cv-choice[data-choice="3"]').getBoundingClientRect();
  return button.top >= feed.top - 1 && button.bottom <= feed.bottom + 1;
});

test('a prompt taller than the screen keeps its choices, and Preview shows all of it and picks', () => scenario('compact-tall', tall, async app => {
  const rows = await app.eval(async t => {
    const { state } = await t.import('store.js');
    return [...state.tabs.values()].find(tab => tab.view?.term).view.term.rows;
  });
  assert.ok(rows < tall.length, 'the prompt is taller than the terminal');
  await app.click('.cv-preview-btn');
  await app.waitFor('.cv-preview .cv-preview-text');
  const text = await app.text('.cv-preview-text');
  assert.ok(text.startsWith(question), text.slice(0, 80));
  assert.ok(text.includes('$ step 0') && text.trimEnd().endsWith('$ step 69'));
  await app.click('.cv-preview .cv-choice[data-choice="3"]');
  await app.waitFor('.cv-preview', { gone: true });
  await received(app, '3');
}, { waiting: true }));

test('a menu cut off at the top while Codex starts offers the terminal, with no choices or preview', () => scenario('compact-tall-start', tall, async app => {
  assert.equal(await app.eval(t => t.$$('.cv-choice, .cv-preview-btn').length), 0);
}, { waiting: false, ready: '.cv-empty .cv-open-terminal' }));

test('the card stays in sight while the prompt box grows and the feed scrolls', () => scenario('compact-grow', tall, async app => {
  assert.ok(await choiceInSight(app), 'at first');
  await app.eval(t => {
    const input = t.$('.cv-input');
    input.value = 'one\ntwo\nthree\nfour\nfive\nsix';
    input.dispatchEvent(new Event('input'));
  });
  assert.ok(await app.eval(t => t.$('.cv-input').offsetHeight) > 60, 'the prompt box grew');
  assert.ok(await choiceInSight(app), 'with the prompt box grown');
  await app.eval(t => { t.$('.cv-feed').scrollTop = 0; });
  assert.ok(await choiceInSight(app), 'with the feed scrolled up');
}, { waiting: true }));

/** The prompt box's height now. */
const boxHeight = app => app.eval(t => t.$('.cv-input').offsetHeight);

/** Puts a line in the prompt box long enough to wrap in a narrow pane, as typing it would; its height then. */
async function fillBox(app) {
  await app.eval(t => {
    const input = t.$('.cv-input');
    input.value = 'word '.repeat(30).trim();
    input.dispatchEvent(new Event('input'));
  });
  return boxHeight(app);
}

/** Narrows the terminals' area (or gives it back with ''), refitting them as a panel opening beside them does. */
const narrowTerminals = (app, right) => app.eval(async (t, r) => {
  t.$('.ws-layer.active').style.right = r;
  (await t.import('terminals.js')).scheduleFit();
}, right);

/** Picks a view from the terminal's view button, as the user does. */
async function pickView(app, label) {
  await app.click('.view-btn');
  await clickText(app, '.menu-row', label);
}

test('the prompt box takes its height again when its pane gets narrower or wider, without a key', () => scenario('compact-box-resize', approval, async app => {
  const wide = await fillBox(app);
  await narrowTerminals(app, '60%');
  await until(async () => (await boxHeight(app)) > wide, 'taller once narrower');
  await narrowTerminals(app, '');
  await until(async () => (await boxHeight(app)) === wide, 'back to its height once wider');
}, { waiting: true }));

test('a prompt box hidden while its pane got narrower fits its text when its view shows again', () => scenario('compact-box-hidden', approval, async app => {
  const wide = await fillBox(app);
  await pickView(app, 'Full');
  await app.waitFor('.compact-view', { gone: true });
  await narrowTerminals(app, '60%');
  // Back in the minimal view (the compact one's twin): the box there is the same one.
  await pickView(app, 'Minimal');
  await app.waitFor('.cv-input');
  await until(async () => (await boxHeight(app)) > wide, 'taller once shown in the narrower pane');
}, { waiting: true }));

/**
 * Right-clicks an element and returns the menu that opens, as each row's text and whether it can be picked, then closes
 * it. Read at once: a menu opened by a made-up right-click over the terminal doesn't stay open for a later look.
 */
const rightClickMenu = (app, selector) => app.eval(async (t, s) => {
  t.contextmenu(s);
  const rows = t.$$('.menu-row').map(row => ({ text: row.textContent.trim(), enabled: !row.disabled }));
  (await t.import('popups.js')).closeAll();
  return rows;
}, selector);

/** Selects a view element's text as a drag would; returns what got selected. */
const selectAllOf = (app, selector) => app.eval((t, s) => {
  const el = t.$(s);
  el.ownerDocument.getSelection().selectAllChildren(el);
  return el.ownerDocument.getSelection().toString();
}, selector);

/** Selects text in the terminal itself (xterm's own selection); returns what got selected. */
const selectInTerminal = (app, text) => app.eval(async (t, wanted) => {
  const { state } = await t.import('store.js');
  const term = [...state.tabs.values()].find(tab => tab.view?.term).view.term;
  const buffer = term.buffer.active;
  for (let y = 0; y < buffer.length; y++) {
    const x = buffer.getLine(y)?.translateToString(true).indexOf(wanted) ?? -1;
    if (x >= 0) { term.select(x, y, wanted.length); break; }
  }
  return term.getSelection();
}, text);

test('a right-click on selected text in the Compact and Minimal views shows the terminal\'s full menu for it', () => scenario('compact-menu', approval, async app => {
  assert.equal(await selectAllOf(app, '.cv-question'), question);
  const compact = await rightClickMenu(app, '.cv-question');
  assert.ok(compact.find(row => row.text.startsWith('Copy'))?.enabled, 'Copy can be picked');
  assert.ok(compact.some(row => row.text === 'Ask an agent about this'), 'the selection\'s entries are there');

  await pickView(app, 'Minimal');
  await app.waitFor('.cv-question');
  assert.equal(await selectAllOf(app, '.cv-question'), question);
  assert.deepEqual(await rightClickMenu(app, '.cv-question'), compact);

  // The terminal's own menu for the same selected text is the same menu.
  await pickView(app, 'Full');
  await app.waitFor('.compact-view', { gone: true });
  assert.equal(await selectInTerminal(app, question), question);
  assert.deepEqual(await rightClickMenu(app, '.ws-layer.active .pane .xterm'), compact);
}, { waiting: true }));
