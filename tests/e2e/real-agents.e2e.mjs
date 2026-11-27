// The real agents (#100), short and cheap: Claude Code on its cheapest model, with prompts that ask for a few words. What
// fakes can't show: its reply drawn whole, after a resize too, the same in Full, Compact and Minimal, the prompt box
// keeping its text across them, and a background task it starts shown and stopped. Runs only with E2E_REAL_AGENTS=1, on
// a machine where Claude Code is logged in (the harness copies the login into the test's home): before each release.
// Run with: E2E_REAL_AGENTS=1 npm run e2e -- tests/e2e/real-agents.e2e.mjs (on Linux, under Xvfb).
// Covers: js/compact*.js js/backgroundtasks.js js/terminals.js src/Termilly.App/Features/Agents.cs src/Termilly.App/Features/BackgroundTasks.cs src/Termilly.App/AgentHooks*.cs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startApp } from './harness.mjs';
import { until } from './process.mjs';

const REAL = process.env.E2E_REAL_AGENTS === '1';
/** A reply long enough to wrap and redraw, short enough to cost next to nothing. */
const REPLY = ['alpha', 'beta', 'gamma'];
/** How long the real agent may take to start and to answer. */
const AGENT_MS = 90_000;
const DRAFT = 'kept draft for later';
/** The background task's command: a length no other process here sleeps for, so it can be found. */
const TASK = 'sleep 457';

let app;
let failed = false;

before(async () => {
  if (!REAL) return;
  app = await startApp({ name: 'real-agents', realAgents: true });
  await app.waitFor('.xterm');
  await app.eval(async t => {
    const { state } = await t.import('store.js');
    const { typeAtPrompt } = await t.import('terminals.js');
    // The cheapest model; sleep may run without asking, so a background task needs no permission card.
    typeAtPrompt([...state.tabs.values()].find(tab => tab.view?.term), 'claude --model haiku --allowedTools "Bash(sleep:*)"');
  });
  await until(() => app.eval(async t => {
    const { state, runningAgent } = await t.import('store.js');
    return [...state.tabs.values()].some(tab => runningAgent(tab) === 'claude' && tab.agent?.session);
  }), { timeoutMs: AGENT_MS, description: 'Claude Code started and reported its session' });
});

after(async () => { await app?.stop({ failed }); });

/** @param {string} name @param {() => Promise<void>} body */
const step = (name, body) => test(name, { skip: !REAL && 'real agents run only with E2E_REAL_AGENTS=1' }, async () => {
  try { await body(); } catch (e) {
    failed = true;
    await app?.screenshot(name.replace(/\W+/g, '-')).catch(() => null);
    throw e;
  }
});

/** The agent terminal's text: every line, or (shown) only the lines on screen now. @param {{ shown?: boolean }} [which] */
const screen = ({ shown = false } = {}) => app.eval(async (t, shown) => {
  const { state, runningAgent } = await t.import('store.js');
  const term = [...state.tabs.values()].find(tab => runningAgent(tab) === 'claude').view.term;
  const buffer = term.buffer.active;
  const [from, count] = shown ? [buffer.viewportY, term.rows] : [0, buffer.length];
  return Array.from({ length: count }, (_, i) => buffer.getLine(from + i)?.translateToString(true) ?? '');
}, shown);

/** The agent terminal's width, in columns. */
const agentCols = () => app.eval(async t => {
  const { state, runningAgent } = await t.import('store.js');
  return [...state.tabs.values()].find(tab => runningAgent(tab) === 'claude').view.term.cols;
});

/** Types a prompt into the agent, key by key, and sends it. @param {string} text */
const ask = text => app.eval(async (t, text) => {
  const { state, runningAgent } = await t.import('store.js');
  const term = [...state.tabs.values()].find(tab => runningAgent(tab) === 'claude').view.term;
  for (const key of text) term.input(key, true);
  await new Promise(r => setTimeout(r, 300));
  term.input('\r', true);
}, text);

/** @param {string} label */
async function pickView(label) {
  await app.click('.view-btn');
  await app.eval(async (t, label) => {
    const row = t.$$('.menu-row').find(r => r.textContent?.trim().startsWith(label));
    if (!row) throw new Error(`No ${label} in the view menu`);
    t.click(`.menu-row:nth-child(${[...row.parentElement.children].indexOf(row) + 1})`);
  }, label);
}

/** Whether every reply word shows on a line of its own somewhere. @param {string[]} lines */
const repliedWhole = lines => REPLY.every(word => lines.some(line => line.trim().replace(/^\W+/, '') === word));

/** ps with each process's environment after its command: Linux's and macOS's ways of asking. */
const PS_WITH_ENV = process.platform === 'darwin' ? ['-E', '-ax', '-ww', '-o', 'pid=,command='] : ['axeww', '-o', 'pid=,args='];

/** The processes running the task's command with this app's data in their environment. */
function taskProcesses() {
  return execFileSync('ps', PS_WITH_ENV, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')
    .filter(line => line.trim().replace(/^\d+\s+/, '').startsWith(`${TASK} `) && line.includes(`TERMILLY_DATA_DIR=${app.dataDir}`))
    .map(line => line.trim().split(/\s+/)[0]);
}

step('its reply is drawn whole, and again after the pane is resized', async () => {
  await ask(`Reply with exactly three lines and nothing else: ${REPLY.join(', then ')}.`);
  await until(async () => repliedWhole(await screen({ shown: true })), { timeoutMs: AGENT_MS, description: 'the reply drawn, a word a line' });
  // A real resize: a second pane beside it takes half the width, then goes, and the agent redraws at each size.
  const wide = await agentCols();
  const split = await app.eval(async t => {
    const { state } = await t.import('store.js');
    const { splitFocused } = await t.import('panes.js');
    const before = new Set(state.tabs.keys());
    splitFocused('row');
    await new Promise(r => setTimeout(r, 500));
    return [...state.tabs.keys()].find(id => !before.has(id));
  });
  await until(async () => (await agentCols()) < wide, { description: 'the agent pane narrower' });
  await until(async () => repliedWhole(await screen({ shown: true })), { description: 'whole on screen, narrower' });
  await app.eval(async (t, id) => {
    const { state } = await t.import('store.js');
    const { closeTab } = await t.import('panes.js');
    closeTab(state.tabs.get(id));
  }, split);
  await until(async () => (await agentCols()) === wide, { description: 'the agent pane wide again' });
  await until(async () => repliedWhole(await screen({ shown: true })), { description: 'whole on screen, wide again' });
});

step('Compact and Minimal show the same reply', async () => {
  for (const [label, view] of [['Compact', true], ['Minimal', 'minimal']]) {
    await pickView(label);
    // In that view, and the words in the agent's reply, not only in the prompt that asked for them.
    await until(() => app.eval(async (t, words, view) => {
      const { state, runningAgent } = await t.import('store.js');
      const tab = [...state.tabs.values()].find(tab => runningAgent(tab) === 'claude');
      const replies = t.$$('.cv-reply').map(el => el.textContent ?? '').join('\n');
      return tab.compactView === view && words.every(w => replies.includes(w));
    }, REPLY, view), { description: `${label} shows the reply` });
  }
});

step('the prompt box keeps its text across the views, and nothing is sent', async () => {
  await pickView('Compact');
  await app.eval((t, draft) => {
    const input = /** @type {HTMLTextAreaElement} */ (t.$('.cv-input'));
    input.value = draft;
    input.dispatchEvent(new Event('input'));
  }, DRAFT);
  await pickView('Full');
  await until(async () => (await screen()).some(line => line.includes(DRAFT)), { description: "in the agent's input line" });
  await pickView('Compact');
  await until(async () => (await app.eval(t => /** @type {HTMLTextAreaElement} */ (t.$('.cv-input')).value)) === DRAFT, { description: 'back in the box' });
  await app.eval(t => {
    const input = /** @type {HTMLTextAreaElement} */ (t.$('.cv-input'));
    input.value = '';
    input.dispatchEvent(new Event('input'));
  });
  await pickView('Full');
});

step('a background task it starts shows, and Stop ends its process', async () => {
  await ask(`Use the Bash tool with run_in_background set to true to run exactly: ${TASK}. Then reply with one word: started.`);
  await until(() => app.eval(t => t.visible('.task-row.running')), { timeoutMs: AGENT_MS, description: 'its task shows, running' });
  await until(() => taskProcesses().length > 0, { description: 'its process runs' });
  await app.click('.task-row.running .task-stop');
  await until(async () => !(await app.eval(t => t.visible('.task-row.running'))), { description: 'Stop ended it' });
  await until(() => taskProcesses().length === 0, { description: 'its process ended' });
  assert.deepEqual(taskProcesses(), []);
});
