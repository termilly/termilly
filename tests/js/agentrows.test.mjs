// Tests for agents in the sidebar (src/Termilly.Desktop/wwwroot/js/subagents.js and store.js): finished subagents
// leave the list, a turn's end finishes the ones that missed their SubagentStop, a minimized window is out of view,
// and a turn's end stops the spinner even when Claude left its progress report open.
// Run with: node --test tests/js/agentrows.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Just enough of a page for the modules to load: the host's messages come through Photino's bridge (host.js).
/** @type {(text: string) => void} */
let deliver = () => {};
let focused = true;
globalThis.window = { addEventListener() {}, external: { receiveMessage: cb => { deliver = cb; }, sendMessage() {} } };
globalThis.document = {
  documentElement: { dataset: {} }, hasFocus: () => focused, addEventListener() {}, querySelectorAll: () => [],
};
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.addEventListener = () => {};

// Fake timers: the rows' delays run on tick(), and the modules' own intervals don't keep the test running.
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const js = '../../src/Termilly.Desktop/wwwroot/js/';
const { state, agentChanged, activityOf, isInView, ACTIVITY } = await import(`${js}store.js`);
const { subagentRowsHtml, runningSubagents, SHOW_DONE_MS, ROW_STATE } = await import(`${js}subagents.js`);
const { setWindowState } = await import(`${js}windowshown.js`);

const host = m => deliver(JSON.stringify(m));
const subagent = (id, event, fields = {}) => host({ type: 'subagent', id, event, ...fields });
const agent = (id, agentState, event) => host({ type: 'agent', id, state: agentState, source: 'hooks', event });

/** A terminal in the active workspace. */
function newTab(id) {
  const tab = { id, wsId: 'w1', title: id };
  state.activeId = 'w1';
  state.tabs.set(id, tab);
  return tab;
}
const rows = tab => [...(tab.subagents?.rows.values() ?? [])];

test('a finished subagent shows its tick for a moment, then leaves the list', () => {
  const tab = newTab('t1');
  subagent('t1', 'SubagentStart', { agentId: 'a1', agentType: 'Explore' });
  assert.equal(runningSubagents(tab), 1);
  subagent('t1', 'SubagentStop', { agentId: 'a1', agentType: 'Explore', message: 'Found it' });
  assert.equal(rows(tab)[0].state, ROW_STATE.done);
  assert.match(subagentRowsHtml(tab), /sub-row done/);
  mock.timers.tick(SHOW_DONE_MS);
  assert.equal(rows(tab).length, 0);
  assert.equal(subagentRowsHtml(tab), '');
  // No "N done" fold is left behind, and a late event from it doesn't bring it back.
  subagent('t1', 'PostToolUse', { agentId: 'a1', tool: 'Read' });
  assert.equal(rows(tab).length, 0);
});

test("the turn's end finishes a foreground subagent that missed its SubagentStop, not a background one", () => {
  const tab = newTab('t2');
  subagent('t2', 'SubagentStart', { agentId: 'fg' });
  subagent('t2', 'PreToolUse', { toolUseId: 'u1', description: 'Indexing', background: true });
  subagent('t2', 'PostToolUse', { toolUseId: 'u1', launchedId: 'bg' });
  assert.equal(runningSubagents(tab), 2);
  agent('t2', 'done', 'Stop');
  assert.equal(tab.subagents.rows.get('fg').state, ROW_STATE.done);
  assert.equal(tab.subagents.rows.get('bg').state, ROW_STATE.running);
  mock.timers.tick(SHOW_DONE_MS);
  assert.deepEqual(rows(tab).map(r => r.id), ['bg']);
  // The session ends: the background one isn't known to have finished, and goes too.
  agent('t2', 'exited', 'SessionEnd');
  assert.equal(tab.subagents.rows.get('bg').state, ROW_STATE.unknown);
  mock.timers.tick(SHOW_DONE_MS);
  assert.equal(rows(tab).length, 0);
});

test('a new prompt also finishes subagents left running from the last turn', () => {
  const tab = newTab('t3');
  subagent('t3', 'SubagentStart', { agentId: 'x' });
  agent('t3', 'working', 'UserPromptSubmit');
  assert.equal(tab.subagents.rows.get('x').state, ROW_STATE.done);
});

test("a turn's end stops the spinner even if Claude's progress report was left open", () => {
  const tab = newTab('t4');
  tab.agent = { state: 'working', source: 'hooks', at: 1 };
  tab.progress = { state: 3, percent: 0 }; // OSC 9;4;3 with no 9;4;0 after it
  assert.equal(activityOf(tab).kind, ACTIVITY.spin);
  tab.agent = { state: 'done', source: 'hooks', at: 2 };
  agentChanged(tab);
  assert.equal(tab.progress, null);
  tab.agent.state = 'idle'; // seen (markSeen)
  assert.equal(activityOf(tab), null);
});

test('a terminal in the active workspace is out of view while the window is minimized or behind another', () => {
  const tab = newTab('t5');
  assert.equal(isInView(tab), true);
  setWindowState({ minimized: true, active: false });
  assert.equal(isInView(tab), false);
  setWindowState({ minimized: false, active: false });
  assert.equal(isInView(tab), false);
  setWindowState({ minimized: false, active: true });
  assert.equal(isInView(tab), true);
  focused = false; // the page lost focus (a dialog of another app)
  assert.equal(isInView(tab), false);
  focused = true;
  assert.equal(isInView({ ...tab, wsId: 'other' }), false);
});
