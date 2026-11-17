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
async function scenario(name, lines, body) {
  const repo = await makeRepo();
  let app, failed = true;
  try {
    app = await startApp({ folder: repo.folder, name, agents: { codex: { stdout: '', prompt: { lines } } } });
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
    await app.waitFor('.cv-choice[data-choice="3"]');
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


