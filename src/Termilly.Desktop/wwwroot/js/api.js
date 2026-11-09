// @ts-check
// Answers Termilly's API (the termilly command and MCP server, through the host): what terminals there are and
// what they're doing, a status next to a terminal's title, opening one, and typing into one (only when Settings
// allow it; the host checks that before asking).

import { PAGE, HOST } from './protocol.js';
import { send, onHost, platform, PLATFORM } from './host.js';
import { state, emit, wsById, tabTitle, profileOf, defaultProfile, runningAgent, EVENTS } from './store.js';
import { agentKind } from './agentkinds.js';
import { newTab, focusedTab, focusTab, switchWorkspace } from './panes.js';
import { createWorkspace, ensureActiveWorkspace } from './workspaces.js';
import { confirmProduction } from './environments.js';
import { listForApi, runForApi } from './snippets.js';
import { readTerminal, waitForTerminal, checkType, noteTyped } from './together.js';
import { commandLine } from './quoting.js';

/**
 * How long after the text the API's Enter goes: typed together, a TUI such as Claude Code takes a long text and its
 * Enter as one paste, and the Enter only adds a line instead of submitting (50 ms was enough when measured).
 */
const ENTER_DELAY_MS = 200;
/**
 * For an agent that needs it (agentkinds.js enterAfterQuiet: Codex), the Enter waits instead until its screen has
 * been still this long after the text, the text all in, and at most ENTER_MAX_MS.
 */
const ENTER_QUIET_MS = 300;
const ENTER_MAX_MS = 3000;

/**
 * Waits before the API's Enter: ENTER_DELAY_MS, or for an agent that takes a long text for a paste, until its screen
 * settles.
 * @param {Tab} tab
 */
export function beforeEnter(tab) {
  const term = tab.view?.term;
  const agent = runningAgent(tab);
  if (!term || !agent || !agentKind(agent).enterAfterQuiet) return new Promise(resolve => setTimeout(resolve, ENTER_DELAY_MS));
  return new Promise(resolve => {
    let quiet = 0;
    const end = () => {
      clearTimeout(quiet);
      clearTimeout(cap);
      writes.dispose();
      resolve(undefined);
    };
    const writes = term.onWriteParsed(() => {
      clearTimeout(quiet);
      quiet = window.setTimeout(end, ENTER_QUIET_MS);
    });
    const cap = window.setTimeout(end, ENTER_MAX_MS);
    quiet = window.setTimeout(end, Math.max(ENTER_DELAY_MS, ENTER_QUIET_MS));
  });
}

/** What the API says a terminal is busy with when it runs a command whose program it doesn't know. */
const BUSY_COMMAND = 'command';

/**
 * A terminal as the API describes it; `lastCommand` only in a detailed description.
 * @typedef {{ id: string, title: string, workspace: string | null, profile: string, cwd: string | null,
 *   tags: string[], agent: string | null, busy: string | null, status: string | null, focused: boolean,
 *   lastCommand?: { command: any, exitCode: any, durationMs: any } }} PaneInfo
 */

/**
 * What a script or agent may know about a terminal.
 * @param {Tab} tab
 * @param {boolean} [detailed]
 */
function describe(tab, detailed = false) {
  const ws = wsById(tab.wsId);
  /** @type {PaneInfo} */
  const info = {
    id: tab.id,
    title: tabTitle(tab),
    workspace: ws?.name ?? null,
    profile: profileOf(tab)?.name ?? tab.profile,
    cwd: tab.cwd ?? tab.startCwd ?? ws?.cwd ?? null,
    tags: tab.tags,
    // An agent waiting at its prompt is "idle", so another agent can tell it's there (null: no agent seen).
    agent: tab.agent?.state ?? null,
    busy: tab.busy ?? (tab.running && !tab.interactive ? BUSY_COMMAND : null), // as the spinner: not while it waits on the user (ssh, a nested shell)
    status: tab.status ?? null,
    focused: tab === focusedTab(),
  };
  if (detailed && tab.lastCommand) {
    const { command, exitCode, durationMs } = tab.lastCommand;
    info.lastCommand = { command, exitCode, durationMs };
  }
  return info;
}

/**
 * A folder as Windows writes it, lower-cased, from Windows, Git Bash (/d/x) or WSL (/mnt/d/x) forms. On Linux the
 * path as it is (case matters there), without a trailing slash.
 * @param {string | null | undefined} path
 */
export function folderKey(path) {
  if (platform === PLATFORM.linux) return String(path ?? '').trim().replace(/(.)\/+$/, '$1');
  let p = String(path ?? '').trim().replace(/\//g, '\\');
  const drive = /^\\(?:mnt\\)?([a-z])(\\|$)/i.exec(p);
  if (drive) p = `${drive[1]}:\\${p.slice(drive[0].length)}`;
  return p.replace(/\\+$/, '').toLowerCase();
}

/**
 * A running terminal in `folder`: the focused one, else one in this workspace, else any.
 * @param {string} folder
 */
function terminalIn(folder) {
  const key = folderKey(folder);
  const matches = [...state.tabs.values()].filter(t => !t.exited && folderKey(describe(t).cwd) === key);
  return matches.find(t => t === focusedTab()) ?? matches.find(t => t.wsId === state.activeId) ?? matches[0] ?? null;
}

/** @param {string | null | undefined} id */
function tabFor(id) {
  const tab = id && state.tabs.get(id);
  if (!tab) throw new Error(id ? `There's no terminal ${id}. "termilly list" shows them.` : 'Say which terminal (--pane, or run it inside one).');
  return tab;
}

/** @param {string | null | undefined} wanted */
function profileFor(wanted) {
  if (!wanted) return defaultProfile();
  const key = String(wanted).toLowerCase();
  const profile = state.profiles.find(p => p.id.toLowerCase() === key || p.name.toLowerCase() === key);
  if (!profile) throw new Error(`No shell called "${wanted}". Shells: ${state.profiles.map(p => p.name).join(', ')}.`);
  return profile.id;
}

/**
 * The API's methods by name; their arguments are the request's JSON, as the termilly command or an agent sent it.
 * @type {Record<string, (args: any) => unknown>}
 */
const METHODS = {
  list: () => [...state.tabs.values()].map(t => describe(t)),
  state: ({ pane }) => describe(tabFor(pane), true),
  status: ({ pane, text }) => {
    const tab = tabFor(pane);
    tab.status = String(text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60) || null;
    emit(EVENTS.tab, tab);
    return { id: tab.id, status: tab.status };
  },
  open: ({ profile, cwd, name, workspace, command, argv, reuse }) => {
    // The termilly command sends the words after "--" one by one: quoted here for the shell that will read them.
    const profileId = profileFor(profile);
    if (Array.isArray(argv) && argv.length) {
      const p = state.profiles.find(x => x.id === profileId);
      command = commandLine(argv, p?.shellIcon ?? p?.icon);
    }
    // "Open in Termilly" (reuse): a terminal already in that folder comes to the front instead of a second one.
    const existing = reuse && cwd && !command ? terminalIn(cwd) : null;
    if (existing) {
      if (existing.wsId !== state.activeId) switchWorkspace(existing.wsId);
      focusTab(existing);
      return { id: existing.id, reused: true };
    }
    const ws = workspace
      ? state.workspaces.find(w => w.name.toLowerCase() === String(workspace).toLowerCase()) ?? createWorkspace({ name: workspace, startWith: 'empty' })
      : ensureActiveWorkspace();
    const tab = newTab({ wsId: ws.id, profile: profileId, name: name ? String(name).slice(0, 60) : null, cwd: cwd ?? null, command: command ?? null });
    return { id: tab.id };
  },
  snippets: () => listForApi(),
  read: ({ pane, what, count, from }) => readTerminal(tabFor(pane), { what, count, from }),
  wait: ({ pane, until, pattern, timeout_s, after_turn, from }) => waitForTerminal(tabFor(pane), { until, pattern, timeout_s, after_turn, from }),
  snippet: ({ name, pane, vars, from }) => {
    const tab = tabFor(pane);
    checkType(tab, from);
    return runForApi({ name, tab, vars: vars ?? {}, beforeSend: noteTyped });
  },
  send: async ({ pane, text, enter, from }) => {
    const tab = tabFor(pane);
    if (tab.exited) throw new Error(`Terminal ${tab.id} has exited.`);
    checkType(tab, from);
    // A script or agent typing into production: the user says yes first (environments.js).
    if (!(await confirmProduction([tab], 'Let a script type', String(text ?? '')))) throw new Error(`Terminal ${tab.id} is on production, and the user said no.`);
    const turn = noteTyped(tab); // as it goes in, after any question: a wait after it waits out the turn it starts
    send(PAGE.input, { id: tab.id, data: String(text ?? '') });
    if (enter) {
      await beforeEnter(tab);
      if (!tab.exited) send(PAGE.input, { id: tab.id, data: '\r' });
    }
    // For an agent there: a wait for its answer waits for a turn after this one (together.js waitForTurn).
    return { id: tab.id, turn };
  },
};

/**
 * Adds a feature's methods (To do's, js/todoagent.js), which can't be listed here without importing a higher layer.
 * @param {Record<string, (args: any) => unknown>} methods
 */
export const addApiMethods = methods => { Object.assign(METHODS, methods); };

/**
 * Runs an API method (the host has checked what's allowed; plugins.js checks for plugins). Throws with the reason.
 * @param {string} name
 * @param {Record<string, any>} args
 */
export function callApi(name, args) {
  const method = Object.hasOwn(METHODS, name) ? METHODS[name] : null;
  if (!method) throw new Error(`Unknown method ${name}.`);
  return method(args);
}

onHost(HOST.api, async m => {
  try {
    send(PAGE.apiResult, { requestId: m.requestId, result: await callApi(/** @type {string} */ (m.method), m.args ?? {}) });
  } catch (e) {
    send(PAGE.apiResult, { requestId: m.requestId, error: /** @type {Error} */ (e).message });
  }
});
