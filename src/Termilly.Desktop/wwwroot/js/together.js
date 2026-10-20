// @ts-check
// Terminals that work together: an agent in one terminal reads another's output (the last command and its exit
// code, from the OSC 133 marks, or its last lines) and waits for something to happen there (the command finishes, a
// line matches), through `termilly read` / `termilly wait` and the MCP server; and "Send to agent…" pastes a
// command's output into an agent terminal's prompt. Each terminal says whether agents may read it (on by default
// only for local terminals, not SSH, WSL, containers, production or ones tagged sensitive) and type into it (off
// unless allowed for it). Every read and every typed text shows on the terminal for a while, and in its access log.
// The host redacts secrets and marks what's read as untrusted (TerminalOutput.cs).

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, on, emit, tabTitle, profileOf, activityChanged, EVENTS, sourceOf } from './store.js';
import { bufferLines } from './terminals.js';
import { lastOutput } from './commands.js';
import { environmentOf } from './environments.js';
import { showMenu } from './popups.js';
import { switchWorkspace, focusTab } from './panes.js';
import { confirmDialog } from './dialogs.js';
import { PROFILE_SOURCE } from './constants.js';
import { SECOND_MS } from './util.js';
import { lineFrom } from './buffer.js';

/**
 * One use of a terminal by another's agent or a script: when, by whom, and what ("read", "typed into").
 * @typedef {{ at: number, by: string, what: string }} AccessEntry
 */

/**
 * What a pasted output says it is: its command and exit code (when it's one command's), and the terminal's title.
 * @typedef {{ command?: string | null, exitCode?: number | null, title?: string }} FenceMeta
 */

/** Most lines a read returns. */
const MAX_LINES = 500;
/** Lines a read of the last lines returns when it doesn't say how many. */
const DEFAULT_LINES = 100;
/** Lines a wait returns with the line that matched. */
const MATCH_LINES = 40;
/** What a read returns: the last command and its output, or the terminal's last lines. */
const READ = Object.freeze({ lastCommand: 'last_command', lines: 'lines' });
/** What a wait waits for: the running command to finish, or an output line to match. */
const UNTIL = Object.freeze({ commandFinished: 'command_finished', outputMatches: 'output_matches' });
/** How long a wait waits by default, and at most (the host gives up at 115), in seconds. */
const DEFAULT_WAIT_S = 60;
const MAX_WAIT_S = 110;
/** How long after a command ends its output is read, so its last lines are in. */
const END_DELAY_MS = 50;
/** Where the agent menu opens with no anchor: this far left of the window's middle, and from its top. */
const MENU_OFFSET_PX = 120;

/**
 * Who a request came from, for the marker and the log: "Claude in api-server", or "a script".
 * @param {string | null | undefined} from
 */
function who(from) {
  const tab = from && state.tabs.get(from);
  if (!tab) return 'a script';
  return `${tab.agent ? 'Claude' : 'a script'} in ${tabTitle(tab)}`;
}

/**
 * Whether agents may read this terminal: its own choice, else the default for its kind.
 * @param {Tab} tab
 */
export function canRead(tab) {
  if (typeof tab.agentRead === 'boolean') return tab.agentRead;
  if (state.settings.agents.readDefault === false) return false;
  const source = sourceOf(profileOf(tab));
  return /** @type {string[]} */ ([PROFILE_SOURCE.local, PROFILE_SOURCE.custom]).includes(source) && !environmentOf(tab) && !tab.tags.includes('sensitive');
}

/**
 * Whether agents may type here: only when allowed for this terminal (and Settings allow typing at all).
 * @param {Tab} tab
 */
export const canType = tab => tab.agentType === true;

/**
 * How other terminals' agents use a terminal (tab.access): the accesses, the one shown now, its timer, the waits.
 * @typedef {{ log: AccessEntry[], mark: AccessEntry | null, timer: number, waiters: Set<() => void> }} Access
 */

/**
 * How other terminals' agents and scripts use a terminal, kept here: the accesses (newest first), the one its header
 * shows for a while, that while's timer, and the `termilly wait` calls waiting for its command to end.
 * @param {Tab} tab
 * @returns {{ log: AccessEntry[], mark: AccessEntry | null, timer: number, waiters: Set<() => void> }}
 */
const accessOf = tab => (tab.access ??= { log: [], mark: null, timer: 0, waiters: new Set() });

/** Accesses a terminal keeps in its menu's list. */
const MAX_ACCESSES = 30;
/** How long the header shows the last access. */
const MARK_MS = 15_000;

/**
 * Notes an access on the terminal: a marker on its header for a while, and a line in its log.
 * @param {Tab} tab
 * @param {string | null | undefined} from
 * @param {string} what
 */
function note(tab, from, what) {
  const entry = { at: Date.now(), by: who(from), what };
  const access = accessOf(tab);
  access.log.unshift(entry);
  access.log.length = Math.min(access.log.length, MAX_ACCESSES);
  access.mark = entry;
  activityChanged(tab, true);
  clearTimeout(access.timer);
  access.timer = setTimeout(() => { access.mark = null; activityChanged(tab, true); }, MARK_MS);
}

/**
 * @param {Tab} tab
 * @param {string | null | undefined} from
 */
function checkRead(tab, from) {
  if (from && from === tab.id) return; // a terminal reading itself
  if (!canRead(tab)) throw new Error(`${tabTitle(tab)} (the terminal) doesn't let scripts or agents read it. Turn it on in its menu: Scripts and agents › Can read this terminal.`);
}

/**
 * The typing check for the API's send and snippets (the global switch is checked by the host).
 * @param {Tab} tab
 * @param {string | null | undefined} from
 */
export function checkType(tab, from) {
  if (from && from === tab.id) return; // an agent typing into its own terminal
  if (!canType(tab)) throw new Error(`${tabTitle(tab)} (the terminal) doesn't let scripts or agents type into it. Turn it on in its menu: Scripts and agents › Can type here.`);
  note(tab, from, 'typed into');
}

/**
 * What a read returns: the terminal, its last command (with exit code) or last lines, and whether one is running.
 * @param {Tab} tab
 * @param {string} what
 * @param {number} [count]
 */
function snapshot(tab, what, count) {
  const base = { pane: tab.id, title: tabTitle(tab), running: tab.running?.command ?? null };
  if (what !== READ.lines && tab.lastCommand) {
    const text = lastOutput(tab) ?? '';
    const lines = text ? text.split('\r\n') : [];
    return { ...base, command: tab.lastCommand.command ?? null, exitCode: tab.lastCommand.exitCode ?? null, lines: lines.slice(-MAX_LINES), truncated: lines.length > MAX_LINES };
  }
  const n = Math.min(MAX_LINES, Math.max(1, Number(count) || DEFAULT_LINES));
  return { ...base, lines: bufferLines(tab).slice(-n) };
}

/**
 * @param {Tab} tab
 * @param {{ what?: string, count?: number, from?: string | null }} [options]
 */
export function readTerminal(tab, { what = READ.lastCommand, count, from } = {}) {
  checkRead(tab, from);
  note(tab, from, 'read');
  return snapshot(tab, what, count);
}

/**
 * Waits for the running command to finish, or for a new output line to match `pattern`, then reads like
 * readTerminal; { timedOut: true } after `timeout_s` (60 s by default, at most 110: the host waits 115).
 * @param {Tab} tab
 * @param {{ until?: string, pattern?: string, timeout_s?: number, from?: string | null }} [options]
 */
export function waitForTerminal(tab, { until = UNTIL.commandFinished, pattern, timeout_s: timeout = DEFAULT_WAIT_S, from } = {}) {
  checkRead(tab, from);
  note(tab, from, 'watched');
  const limit = Math.min(MAX_WAIT_S, Math.max(1, Number(timeout) || DEFAULT_WAIT_S)) * SECOND_MS;
  return new Promise((resolve, reject) => {
    let regex = null;
    if (until === UNTIL.outputMatches) {
      try { regex = new RegExp(String(pattern ?? ''), 'i'); } catch (e) { reject(new Error(`Not a regular expression: ${/** @type {Error} */ (e).message}`)); return; }
    } else if (!tab.running) {
      resolve(snapshot(tab, READ.lastCommand));
      return;
    }
    const term = /** @type {TabView} */ (tab.view).term;
    const buffer = term.buffer.normal;
    const marker = term.registerMarker(0); // only output from now on counts
    let done = false;
    /** @param {object} result */
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      listener.dispose();
      marker?.dispose();
      tab.access?.waiters.delete(onEnd);
      resolve(result);
    };
    const onEnd = () => setTimeout(() => finish(snapshot(tab, READ.lastCommand)), END_DELAY_MS);
    if (!regex) accessOf(tab).waiters.add(onEnd);
    let row = marker?.line ?? buffer.baseY + buffer.cursorY;
    const listener = term.onWriteParsed(() => {
      if (!regex) return;
      const end = buffer.baseY + buffer.cursorY;
      for (; row < end; row++) {
        const text = lineFrom(buffer, row, end);
        if (text !== null && regex.test(text)) {
          finish({ ...snapshot(tab, READ.lines, MATCH_LINES), matched: text });
          return;
        }
      }
    });
    const timer = setTimeout(() => finish({ pane: tab.id, title: tabTitle(tab), timedOut: true }), limit);
  });
}

// A command ending wakes whoever waits on it.
on(EVENTS.commandEnding, ({ tab }) => { for (const fn of tab.access?.waiters ?? []) fn(); });

// ---- Send to agent ----

/**
 * Terminals with an agent in them (Claude Code or Codex seen there), other than `except`.
 * @param {Tab | null} except
 */
const agentTerminals = except => [...state.tabs.values()].filter(t => t !== except && (t.agent || t.agentSeen || t.claude?.usage));

/**
 * The text pasted: what it is, then the output in a fenced block.
 * @param {string} text
 * @param {FenceMeta} [meta]
 */
export function fenced(text, { command, exitCode, title } = {}) {
  const head = command
    ? `Output of \`${command.trim()}\` in ${title}${exitCode != null ? ` (exit ${exitCode})` : ''}:`
    : `Output from ${title}:`;
  const body = String(text).replace(/```/g, "'''");
  return `${head}\n\`\`\`\n${body}\n\`\`\`\n`;
}

/**
 * Pastes text into an agent terminal's prompt, as a paste (bracketed), without pressing Enter: the user adds
 * their question. Asks which agent when there's more than one.
 * @param {string} text
 * @param {FenceMeta} meta
 * @param {import('./popups.js').Anchor | null | undefined} anchor
 * @param {Tab | null} [source]
 */
export function sendToAgent(text, meta, anchor, source = null) {
  const agents = agentTerminals(source);
  /** @param {Tab} tab */
  const deliver = tab => {
    const paste = fenced(text, meta);
    send(PAGE.input, { id: tab.id, data: `\x1b[200~${paste}\x1b[201~` });
    if (tab.wsId !== state.activeId) switchWorkspace(tab.wsId);
    focusTab(tab);
  };
  if (!agents.length) {
    confirmDialog({ title: 'No agent terminal', body: 'Start Claude Code (or another agent) in a terminal first; its output goes to that terminal’s prompt.' });
    return;
  }
  if (agents.length === 1) return deliver(agents[0]);
  showMenu(agents.map(t => ({ label: `${tabTitle(t)}${t.agent ? ` · ${t.agent.state}` : ''}`, action: () => deliver(t) })), anchor ?? { x: innerWidth / 2 - MENU_OFFSET_PX, y: MENU_OFFSET_PX });
}

/**
 * "Send last output to agent" from a terminal's menu.
 * @param {Tab} tab
 * @param {import('./popups.js').Anchor} [anchor]
 */
export function sendLastOutput(tab, anchor) {
  const run = tab.lastCommand;
  if (!run) return;
  sendToAgent(lastOutput(tab) ?? '', { command: run.command, exitCode: run.exitCode, title: tabTitle(tab) }, anchor, tab);
}

/**
 * The terminal menu's part: permissions, the access log, Send to agent.
 * @param {Tab} tab
 * @returns {import('./popups.js').MenuEntry[]}
 */
export function togetherMenuItems(tab) {
  return [
    ...(tab.lastCommand ? [{ label: 'Send the last output to an agent', action: () => sendLastOutput(tab, tab.view?.header) }] : []),
    {
      label: 'Scripts and agents', submenu: () => [
        { label: 'Can read this terminal', checked: canRead(tab), action: () => { tab.agentRead = !canRead(tab); emit(EVENTS.tab, tab); } },
        { label: 'Can type here', checked: canType(tab), action: () => { tab.agentType = !canType(tab); emit(EVENTS.tab, tab); } },
        ...(tab.access?.log.length ? /** @type {import('./popups.js').MenuEntry[]} */ (['separator', .../** @type {AccessEntry[]} */ (tab.access.log).slice(0, 12).map(e => ({
          label: `${new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${e.what} by ${e.by}`, action: () => {},
        }))]) : []),
      ],
    },
  ];
}

/**
 * The header marker while someone reads or types: "read by Claude in api-server".
 * @param {Tab} tab
 */
export function accessMarkText(tab) {
  const mark = tab.access?.mark;
  return mark ? `${mark.what} by ${mark.by}` : '';
}
