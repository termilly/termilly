// Termilly computers (#99): two apps on one machine, paired through the real flow (the other computer's code, its
// address), the way a laptop pairs with a desktop. A's pane shows B's terminal and types into it; B's size is kept,
// readable, in A's pane; closing the pane there leaves nothing watching. Run with: npm run e2e (on Linux, under Xvfb).
// Covers: js/remotepc.js js/phone.js js/settings/phone.js src/Termilly.App/Features/RemotePcs.cs src/Termilly.App/Features/RemoteWatches.cs src/Termilly.App/Features/PcWire.cs src/Termilly.App/RemotePcs.cs src/Termilly.App/Phone/** src/Termilly.App/Features/Phone.cs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { startApp } from './harness.mjs';
import { until } from './gitsteps.mjs';

/** The computer that has the terminal (B), and the one that shows it (A). */
let there, here;
let failed = false;
/** What B's terminal is asked to print, typed in A's pane. */
const MARK = 'typed-from-the-other-computer';
/** B's terminal size, unlike any pane's here. */
const THEIR_SIZE = Object.freeze({ cols: 97, rows: 23 });

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

before(async () => {
  // B listens on loopback only (its phone server uses the network's address otherwise): the test stays off the network.
  there = await startApp({ name: 'remote-there', env: { TERMILLY_PHONE_BIND: '127.0.0.1' } });
  here = await startApp({ name: 'remote-here' });
  await there.waitFor('.xterm');
  await here.waitFor('.xterm');
});

after(async () => {
  await here?.stop({ failed });
  await there?.stop({ failed });
});

/** @param {string} name @param {() => Promise<void>} body */
const step = (name, body) => test(name, async () => {
  try { await body(); } catch (e) { failed = true; throw e; }
});

/** B turns on its phone server (remote access, typing allowed) and gives the code Pair a computer shows. */
async function codeThere(port) {
  return there.eval(async (t, port) => {
    const { updateSettings } = await t.import('preferences.js');
    const { GROUPS } = await t.import('store.js');
    const { send, onHost } = await t.import('host.js');
    const { PAGE, HOST } = await t.import('protocol.js');
    updateSettings(GROUPS.phone, { enabled: true, port, allowTyping: true });
    await new Promise(r => setTimeout(r, 1500)); // the server starts
    return new Promise(resolve => { onHost(HOST.phonePairing, m => resolve(m.code)); send(PAGE.phonePair, {}); });
  }, port);
}

step('A pairs with B by its address and code, and lists its terminals', async () => {
  const port = await freePort();
  const code = await codeThere(port);
  assert.match(String(code), /\S/, 'B offers a code');
  const answer = await here.eval(async (t, address, code) => {
    const { request } = await t.import('host.js');
    const { PAGE } = await t.import('protocol.js');
    return request(PAGE.pcAdd, { address, code });
  }, `127.0.0.1:${port}`, code);
  assert.equal(answer?.error ?? null, null, `paired (${JSON.stringify(answer)})`);
  await until(() => here.eval(t => !!t.$('[data-pc-terminal]')), "B's terminal listed under Termilly computers");
});

step("A's pane shows B's terminal, and what's typed there runs there", async () => {
  await here.click('[data-pc-terminal]');
  await until(() => here.eval(async t => {
    const { state } = await t.import('store.js');
    return [...state.tabs.values()].some(tab => tab.virtual?.kind === 'pc' && tab.view?.term);
  }), "B's terminal open in a pane here");
  await here.eval(async (t, mark) => {
    const { state } = await t.import('store.js');
    const tab = [...state.tabs.values()].find(tab => tab.virtual?.kind === 'pc');
    for (const key of `echo ${mark}\r`) tab.view.term.input(key, true);
  }, MARK);
  const screenOf = app => app.eval(async (t, remote) => {
    const { state } = await t.import('store.js');
    const tab = [...state.tabs.values()].find(tab => (remote ? tab.virtual?.kind === 'pc' : !tab.virtual) && tab.view?.term);
    const buffer = tab.view.term.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\n');
  }, app === here);
  await until(async () => (await screenOf(there)).includes(MARK), 'B ran it in its own terminal');
  await until(async () => (await screenOf(here)).split(MARK).length > 2, "A shows B's command and its output");
});

/** An app's terminal size: the remote one in A, B's own in B. @param {any} app @param {boolean} remote */
const sizeOf = (app, remote) => app.eval(async (t, remote) => {
  const { state } = await t.import('store.js');
  const term = [...state.tabs.values()].find(tab => (remote ? tab.virtual?.kind === 'pc' : !tab.virtual) && tab.view?.term).view.term;
  return { cols: term.cols, rows: term.rows };
}, remote);

/** Who B says has its terminal open. */
const viewersThere = () => there.eval(async t => {
  const { state } = await t.import('store.js');
  return [...state.tabs.values()].find(tab => !tab.virtual && tab.view?.term).viewers ?? [];
});

step("B's size is kept in A's pane, readable, and A's pane can be scrolled to all of it", async () => {
  // B's terminal at a size of its own, unlike A's pane: Keep remote size draws it in A at B's size.
  await there.eval(async (t, size) => {
    const { state } = await t.import('store.js');
    [...state.tabs.values()].find(tab => !tab.virtual && tab.view?.term).view.term.resize(size.cols, size.rows);
  }, THEIR_SIZE);
  await until(async () => {
    const shown = await sizeOf(here, true);
    return shown.cols === THEIR_SIZE.cols && shown.rows === THEIR_SIZE.rows;
  }, "A's pane at B's size");
  const own = await here.eval(async t => {
    const { state } = await t.import('store.js');
    return [...state.tabs.values()].find(tab => !tab.virtual && tab.view?.term).view.term.cols;
  });
  assert.notEqual((await sizeOf(here, true)).cols, own, "not A's own size");
  const font = await here.eval(async t => {
    const { state } = await t.import('store.js');
    return [...state.tabs.values()].find(tab => tab.virtual?.kind === 'pc').view.term.options.fontSize;
  });
  assert.ok(font >= 9, `a readable font, not ${font}px`);
  assert.equal(await here.eval(t => t.reachable('.pane-body .xterm')), true);
});

step("closing the pane here ends its watch there, and leaves B's terminal running", async () => {
  await until(async () => (await viewersThere()).length > 0, 'B knows A has it open');
  await here.eval(async t => {
    const { state } = await t.import('store.js');
    const { closeTab } = await t.import('panes.js');
    closeTab([...state.tabs.values()].find(tab => tab.virtual?.kind === 'pc'));
  });
  await until(() => here.eval(async t => {
    const { state } = await t.import('store.js');
    return ![...state.tabs.values()].some(tab => tab.virtual?.kind === 'pc');
  }), 'the pane closed here');
  await until(async () => (await viewersThere()).length === 0, 'B knows nobody has it open now');
  assert.equal(await there.eval(async t => {
    const { state } = await t.import('store.js');
    return [...state.tabs.values()].filter(tab => tab.view?.term && !tab.exited).length;
  }), 1, "B's terminal still runs");
});
