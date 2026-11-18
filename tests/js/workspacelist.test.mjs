// Tests for the rows other computers add to Minimal's workspace list (src/Termilly.Desktop/wwwroot/js/workspacelist.js):
// each paired computer, its workspaces and their terminals, as the sidebar's Remote tree has them.
// Run with: node --test tests/js/workspacelist.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough of a page for the modules to load (ui.js loads host.js, popups.js the document).
globalThis.window = /** @type {any} */ ({ addEventListener() {}, external: { receiveMessage() {}, sendMessage() {} } });
globalThis.document = /** @type {any} */ ({ documentElement: { dataset: {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
globalThis.localStorage = /** @type {any} */ ({ getItem: () => null, setItem() {} });
globalThis.addEventListener = () => {};
const { computerRows, stateWord } = await import('../../src/Termilly.Desktop/wwwroot/js/workspacelist.js');
const { SEPARATOR } = await import('../../src/Termilly.Desktop/wwwroot/js/popups.js');
const { AGENT_STATE } = await import('../../src/Termilly.Desktop/wwwroot/js/constants.js');

const laptop = { id: 'pc1', name: 'Laptop', address: '192.168.0.5', online: true, error: null, state: null };
const away = { id: 'pc2', name: 'Office', address: '10.0.0.9', online: false, error: 'Not reachable', state: null };
const there = {
  workspaces: [{ id: 'w1', name: 'Site', color: '#3b82f6' }, { id: 'w2', name: 'Empty', color: '#22c55e' }],
  terminals: [
    { id: 't1', ws: 'w1', title: 'claude', activity: 'needs' },
    { id: 't2', ws: 'w1', title: 'build', activity: 'spin' },
    { id: 't3', ws: 'w1', title: 'shell', activity: null },
  ],
};

/** The actions the rows use, recording what they were asked; `now` is the computers as they are at the moment. */
function actions(now = [laptop, away]) {
  const asked = [];
  return {
    asked,
    now,
    computer: id => now.find(pc => pc.id === id),
    stateOf: () => there,
    icon: '<svg></svg>',
    open: (pc, pane) => asked.push(['open', pc.id, pane]),
    inFront: (_, pane) => pane === 't3',
    newWorkspace: pc => ({ label: `New workspace on ${pc.name}` }),
    newTerminal: (_, wsId) => ({ label: `New terminal in ${wsId}` }),
  };
}

test('a reachable computer opens its workspaces, then New workspace there', () => {
  const [row] = computerRows([laptop], actions());
  assert.equal(row.label, 'Laptop');
  assert.ok(!row.disabled);
  assert.deepEqual(row.submenu().map(r => (r === SEPARATOR ? '-' : r.label)), ['Site', 'Empty', '-', 'New workspace on Laptop']);
});

test('one that cannot be reached is greyed and says so', () => {
  const [row] = computerRows([away], actions());
  assert.equal(row.disabled, true);
  assert.equal(row.hint, 'offline');
  assert.equal(row.title, 'Not reachable');
  assert.equal(row.submenu, undefined);
});

test('a workspace lists its terminals with what their agents do, the one shown here ticked, and opens them here', () => {
  const a = actions();
  const site = computerRows([laptop], a)[0].submenu()[0];
  const rows = site.submenu();
  assert.deepEqual(rows.map(r => (r === SEPARATOR ? '-' : [r.label, r.hint ?? '', !!r.checked])),
    [['Open all terminals', '', false], '-', ['claude', 'needs you', false], ['build', 'working', false], ['shell', '', true], '-', ['New terminal in w1', '', false]]);
  rows[3].action();
  assert.deepEqual(a.asked, [['open', 'pc1', 't2']]);
});

test('Open all terminals opens every terminal the workspace has there when it is picked', () => {
  const a = actions();
  const openAll = computerRows([laptop], a)[0].submenu()[0].submenu()[0];
  const saved = there.terminals;
  there.terminals = [...saved.filter(t => t.id !== 't2'), { id: 't4', ws: 'w1', title: 'new one', activity: null }, { id: 't5', ws: 'w2', title: 'elsewhere' }];
  openAll.action();
  there.terminals = saved;
  assert.deepEqual(a.asked, [['open', 'pc1', 't1'], ['open', 'pc1', 't3'], ['open', 'pc1', 't4']]);
  // Not while the computer can't be reached.
  a.asked.length = 0;
  a.now[0] = { ...laptop, online: false };
  openAll.action();
  assert.deepEqual(a.asked, []);
});

test('an empty workspace offers only New terminal, and no computers add no rows', () => {
  const empty = computerRows([laptop], actions())[0].submenu()[1];
  assert.deepEqual(empty.submenu().map(r => r.label), ['New terminal in w2']);
  assert.deepEqual(computerRows([], actions()), []);
});

test('a computer that goes away while the menu is open shows as offline, and its terminals no longer open', () => {
  const a = actions([laptop]);
  const [row] = computerRows([laptop], a);
  const site = row.submenu()[0];
  const claude = site.submenu()[2];
  a.now[0] = { ...laptop, online: false, error: 'Not reachable' };
  assert.deepEqual(row.submenu().map(r => [r.label, r.hint, r.disabled]), [['Laptop', 'offline', true]]);
  assert.deepEqual(site.submenu().map(r => r.hint), ['offline']);
  claude.action();
  a.now.length = 0;
  assert.deepEqual(row.submenu().map(r => r.label), ['Laptop'], 'forgotten, it still says which one');
  assert.deepEqual(a.asked, []);
});

test('a terminal closed there since the menu opened is not opened', () => {
  const a = actions();
  const rows = computerRows([laptop], a)[0].submenu()[0].submenu();
  const saved = there.terminals;
  there.terminals = saved.filter(t => t.id !== 't1');
  rows[2].action();
  there.terminals = saved;
  assert.deepEqual(a.asked, []);
});

test('the words for what agents do are the same as this PC\'s rows use', () => {
  assert.equal(stateWord(AGENT_STATE.needsInput), 'needs you');
  assert.equal(stateWord(AGENT_STATE.working), 'working');
  assert.equal(stateWord(''), '');
});
