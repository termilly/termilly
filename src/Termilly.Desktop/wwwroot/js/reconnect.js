// @ts-check
// SSH terminals that survive network drops and sleep: when ssh ends because the connection died (exit code 255, or
// "Connection reset", "Broken pipe", "timed out"… in its last lines), a bar says so and reconnects with backoff
// (3 s, 6 s, 12 s… up to 30 s), at once when the network comes back or the PC wakes. The same profile starts again
// (same host, jump hosts and keys), in the same terminal with its output kept; then it goes back to the remote
// folder it was in (OSC 7 from the remote shell) and runs the profile's attach command (tmux attach, screen -r).
// A process that died with the connection can't come back: that's what tmux or screen on the server is for.

import { state, profileOf, tabTitle, lastFolderOf, GROUPS, isSsh } from './store.js';
import { bufferLines, startShell, clearActivity, prepareStart } from './terminals.js';
import { modal } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { updateSettings } from './preferences.js';
import { resumeCommand, attachFor } from './resume.js';
import { find, field, targetOf } from './dom.js';
import { SECOND_MS, MINUTE_MS } from './util.js';

/** The waits before each attempt to reconnect, in seconds (the last one repeats). */
const DELAYS = [3, 6, 12, 24, 30];
/** ssh's exit code when the connection itself failed. */
const SSH_CONNECTION_FAILED = 255;
/** How many of the terminal's last lines are looked at for ssh's connection messages. */
const LAST_LINES = 6;
/** Connected this long, the next drop starts the backoff over (milliseconds). */
const STABLE_MS = MINUTE_MS;
/** How often the bar's countdown updates, in milliseconds. */
const BAR_TICK_MS = 500;
/** How often the page checks whether the PC slept, and how long a gap between checks means it did (milliseconds). */
const WAKE_CHECK_MS = 5000;
const WAKE_GAP_MS = 30_000;
/** How long after waking the network gets before reconnecting, in milliseconds. */
const WAKE_SETTLE_MS = 3000;
/** The bar over a terminal waiting to reconnect: its class and its selector. */
const BAR_CLASS = 'reconnect-bar';
const BAR = `.${BAR_CLASS}`;
/** What the bar's buttons do (data-rc). */
const BAR_ACTION = Object.freeze({ now: 'now', stop: 'stop' });

/** Lines ssh prints when the connection itself failed (not the remote command). */
const DROPPED = /(connection (reset|closed|timed out|refused)|broken pipe|timed out|network is unreachable|no route to host|client_loop: send disconnect|connection to [^ ]+ closed by remote host|could not resolve hostname|kex_exchange_identification)/i;

/**
 * Whether an ssh exit looks like a dropped connection: code 255, or one of ssh's connection messages last.
 * @param {number} code
 * @param {string[]} lastLines
 */
export function looksLikeDrop(code, lastLines) {
  if (code === SSH_CONNECTION_FAILED) return true;
  if (code === 0) return false;
  return lastLines.some(l => DROPPED.test(l));
}

/**
 * An SSH terminal waiting to reconnect (tab.reconnect): the attempts so far, the timers, when the next one is, the
 * folder to go back to, and whether it ever got to a prompt.
 * @typedef {{ attempt: number, timer: number, until: number, cwd: string | null, never: boolean, tick?: number,
 *   reset?: number }} Reconnecting
 */

/**
 * Called when a terminal's process ends (main.js). True when it was an SSH connection that dropped: the
 * terminal then waits to reconnect instead of showing "press any key".
 * @param {Tab} tab
 * @param {number} code
 */
export function handleExit(tab, code) {
  if (!isSsh(tab) || state.settings.ssh.reconnect === false) return false;
  if (!looksLikeDrop(code, bufferLines(tab).slice(-LAST_LINES))) return false;
  tab.exited = true;
  // The folder to go back to: where its shell was, or where it was before a restart (store.js lastFolderOf).
  tab.reconnect = { attempt: tab.reconnect?.attempt ?? 0, timer: 0, until: 0, cwd: lastFolderOf(tab), never: !tab.remoteCwd && !tab.shellMarks }; // never got to a prompt
  const host = escapeAnsi(profileOf(tab)?.name ?? 'the server');
  /** @type {TabView} */ (tab.view).term.write(`\r\n\x1b[33m[${tab.reconnect.never ? `couldn't connect to ${host}` : `connection to ${host} lost`}]\x1b[0m\r\n`);
  schedule(tab);
  return true;
}

const escapeAnsi = /** @param {unknown} s */ s => String(s).replace(/[\x00-\x1f]/g, '');

/** @param {Tab} tab */
function schedule(tab) {
  const r = tab.reconnect;
  if (!r) return;
  const delay = DELAYS[Math.min(r.attempt, DELAYS.length - 1)];
  r.until = Date.now() + delay * SECOND_MS;
  clearTimeout(r.timer);
  r.timer = setTimeout(() => reconnect(tab), delay * SECOND_MS);
  showBar(tab);
}

/**
 * Starts the profile again in the same terminal, output kept, then returns to the folder and attaches.
 * @param {Tab} tab
 */
export function reconnect(tab) {
  const r = tab.reconnect;
  if (!r || !state.tabs.has(tab.id)) return;
  clearTimeout(r.timer);
  clearInterval(r.tick);
  r.attempt++;
  hideBar(tab);
  /** @type {TabView} */ (tab.view).term.write(`\x1b[90m[reconnecting, attempt ${r.attempt}…]\x1b[0m\r\n`);
  tab.exited = false;
  clearActivity(tab);
  prepareStart(tab, { command: resumeCommand(r.cwd, attachFor(tab)) });
  startShell(tab);
  // Connected for a minute: the next drop starts the backoff over.
  clearTimeout(r.reset);
  r.reset = setTimeout(() => { if (tab.reconnect === r && !tab.exited) tab.reconnect = null; }, STABLE_MS);
}

/** @param {Tab} tab */
export function stopReconnecting(tab) {
  const r = tab.reconnect;
  if (!r) return;
  clearTimeout(r.timer);
  clearInterval(r.tick);
  tab.reconnect = null;
  hideBar(tab);
  /** @type {TabView} */ (tab.view).term.write('\x1b[90m[not reconnecting - press any key to start it again]\x1b[0m\r\n');
}

/** @param {Tab} tab */
function showBar(tab) {
  const pane = tab.view?.el;
  if (!pane) return;
  let bar = /** @type {HTMLElement | null} */ (pane.querySelector(BAR));
  if (!bar) {
    bar = document.createElement('div');
    bar.className = BAR_CLASS;
    bar.innerHTML = `<span class="rc-dot"></span><span class="rc-text"></span>
      <button class="btn small" data-rc="${BAR_ACTION.now}">Reconnect now</button><button class="btn small" data-rc="${BAR_ACTION.stop}">Stop</button>`;
    bar.addEventListener('click', e => {
      const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-rc]'))?.dataset.rc;
      if (action === BAR_ACTION.now) reconnect(tab);
      if (action === BAR_ACTION.stop) stopReconnecting(tab);
    });
    pane.append(bar);
  }
  const r = /** @type {Reconnecting} */ (tab.reconnect); // the bar shows while the terminal waits to reconnect
  const text = find(bar, '.rc-text');
  const update = () => {
    const left = Math.max(0, Math.ceil((r.until - Date.now()) / SECOND_MS));
    const host = profileOf(tab)?.name ?? tabTitle(tab);
    text.textContent = `${r.never ? `Can't reach ${host} (is it on?)` : `Connection to ${host} lost`}. Trying again in ${left} s${r.attempt ? ` (attempt ${r.attempt + 1})` : ''}`;
  };
  update();
  clearInterval(r.tick);
  r.tick = setInterval(update, BAR_TICK_MS);
}

/** @param {Tab} tab */
function hideBar(tab) {
  tab.view?.el?.querySelector(BAR)?.remove();
}

/** Every terminal waiting to reconnect tries now (the network came back, the PC woke). */
function reconnectWaiting() {
  for (const tab of state.tabs.values()) if (tab.reconnect && tab.exited) reconnect(tab);
}

addEventListener('online', reconnectWaiting);
// Waking from sleep: timers stop while the PC sleeps, so a long gap between ticks means it just woke.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastTick > WAKE_GAP_MS) setTimeout(reconnectWaiting, WAKE_SETTLE_MS); // give the network a moment
  lastTick = now;
}, WAKE_CHECK_MS);

/**
 * "After reconnecting" for an SSH profile: the attach command run after each reconnect.
 * @param {Tab} tab
 */
export function editAttach(tab) {
  const profile = profileOf(tab);
  return modal('attach-edit', `
    <h3>After reconnecting to ${escapeHtml(profile?.name ?? 'this host')}</h3>
    <p class="dialog-sub">Run this once the connection is back, after returning to the folder you were in. A program that was running when the connection dropped can’t come back unless it ran in tmux or screen.</p>
    <input class="field" data-attach value="${escapeHtml(attachFor(tab))}" placeholder="tmux attach || tmux new" spellcheck="false" autofocus>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div>`, (dialog, close) => {
    const save = () => {
      const value = field(dialog, '[data-attach]').value.trim();
      const all = { ...(state.settings.ssh.attach ?? {}) };
      if (value) all[tab.profile] = value; else delete all[tab.profile];
      updateSettings(GROUPS.ssh, { attach: all });
      close(true);
    };
    return { submit: save };
  });
}
