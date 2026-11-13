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
import { readTerminal, waitForTerminal, checkType, checkRead, noteTyped, nextCommandEnd, noteEnter, shellAnswered, terminalReady, UNTIL } from './together.js';
import { SECOND_MS } from './util.js';
import { commandLine } from './quoting.js';

/**
 * How long after the text the API's Enter goes: typed together, a TUI such as Claude Code takes a long text and its
 * Enter as one paste, and the Enter only adds a line instead of submitting (50 ms was enough when measured).
 */
const ENTER_DELAY_MS = 200;
/**
 * For an agent that needs it (agentkinds.js enterAfterQuiet: Codex), the Enter waits instead until its screen has shown
 * the text and then been still this long, and at most ENTER_MAX_MS.
 */
const ENTER_QUIET_MS = 300;
const ENTER_MAX_MS = 3000;

/**
 * Waits before the API's Enter: ENTER_DELAY_MS, or for an agent that takes a long text for a paste, until its screen
 * settles. Codex draws nothing while it takes in a long text (0.4 s for 1,100 characters, measured), and an Enter in that
 * time is lost, so its stillness only counts once its screen has shown the text.
 * @param {Tab} tab
 * @param {boolean} [typed] whether text was typed just before; with none, nothing will show it, so only ENTER_DELAY_MS
 */
export function beforeEnter(tab, typed = true) {
  const term = tab.view?.term;
  const agent = runningAgent(tab);
  if (!typed || !term || !agent || !agentKind(agent).enterAfterQuiet) return new Promise(resolve => setTimeout(resolve, ENTER_DELAY_MS));
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

/** How long an ask waits by default and at most, in seconds, counted from when it came in (the host gives up at 115). */
const ASK_DEFAULT_S = 60;
const ASK_MAX_S = 100;
/** The least time an ask needs left after the user said yes on production: with less, nothing is typed. */
const ASK_MIN_LEFT_MS = 2000;
/** How long an ask to a shell waits for it to answer a line typed just before (back at its prompt). */
const ANSWER_WAIT_MS = 3000;
/** The longest an ask waits for a terminal that's still starting (just opened, or its agent loading) to be ready. */
const READY_WAIT_MS = 30_000;

/** Each terminal's typing in progress: a send, snippet or ask types once the one before it there is in. @type {WeakMap<Tab, Promise<unknown>>} */
const typing = new WeakMap();
/** Terminals an ask waits on: one at a time, or two asks would get the same command's end. @type {WeakSet<Tab>} */
const asking = new WeakSet();

/**
 * Runs `fn` once any typing before it in this terminal is done, so two never mix on one line; the next one starts as soon as
 * this one's text (and Enter) is in, not when what it started ends.
 * @template T
 * @param {Tab} tab
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
function queued(tab, fn) {
  const done = (typing.get(tab) ?? Promise.resolve()).then(fn, fn);
  typing.set(tab, done.catch(() => {}));
  return done;
}

/**
 * Types text into a terminal, then Enter when asked (after beforeEnter's wait), in its turn (queued). `before` runs first,
 * at that moment: it checks again what was checked before the wait, and its result is returned.
 * @template T
 * @param {Tab} tab
 * @param {unknown} text
 * @param {boolean} enter
 * @param {() => Promise<T> | T} before
 * @returns {Promise<T>}
 */
function typeInto(tab, text, enter, before) {
  return queued(tab, async () => {
    const result = await before();
    const data = String(text ?? '');
    send(PAGE.input, { id: tab.id, data });
    if (enter) {
      await beforeEnter(tab, data !== '');
      if (!tab.exited) send(PAGE.input, { id: tab.id, data: '\r' });
      noteEnter(tab);
    }
    return result;
  });
}

/**
 * A terminal checked for the API's typing: there, not exited, allowing it (and reading, for an ask), and on production
 * only with the user's yes. Returns it with a check to make again right before typing, as what's allowed may change while a
 * request waits for the user or for typing before it.
 * @param {string | null | undefined} pane
 * @param {unknown} text
 * @param {string | null | undefined} from
 * @param {boolean} [reading] the result shows the terminal's output, so it must allow reading too
 * @returns {Promise<{ tab: Tab, recheck: () => Tab }>}
 */
async function typable(pane, text, from, reading = false) {
  /** @param {boolean} noteIt */
  const check = noteIt => {
    const tab = tabFor(pane);
    if (tab.exited) throw new Error(`Terminal ${tab.id} has exited.`);
    if (reading) checkRead(tab, from); // before anything is typed: an ask that couldn't read its answer mustn't type
    checkType(tab, from, noteIt);
    return tab;
  };
  const tab = check(true);
  // A script or agent typing into production: the user says yes first (environments.js).
  if (!(await confirmProduction([tab], 'Let a script type', String(text ?? '')))) throw new Error(`Terminal ${tab.id} is on production, and the user said no.`);
  return { tab: check(false), recheck: () => check(false) };
}

/**
 * The API's ask: types a line and waits for what it brings, all within one deadline from when it came in, so the host never
 * gives up on a call whose text was typed. With an agent there, its reply once the turn this starts ends; with a shell, the
 * command's output once it ends.
 * @param {{ pane?: string, text?: string, timeout_s?: number, from?: string | null }} args
 */
async function ask({ pane, text, timeout_s, from }) {
  const deadline = Date.now() + Math.min(ASK_MAX_S, Math.max(1, Number(timeout_s) || ASK_DEFAULT_S)) * SECOND_MS;
  // One line: several would be several commands, and the answer could be any of them.
  if (/[\r\n]/.test(String(text ?? ''))) throw new Error('ask_terminal takes one line. For several commands, ask once for each, or join them as the shell does (&& or ;).');
  const { tab, recheck } = await typable(pane, text, from, true);
  if (asking.has(tab)) throw new Error(`An ask is already waiting on ${tabTitle(tab)} (the terminal). Try again once it's answered.`);
  asking.add(tab);
  try {
    // A terminal just opened, or whose agent is still starting, is waited for first: outside the typing queue, as nothing
    // is typed meanwhile. Then it's told whether an agent or a shell takes the line.
    if (!(await terminalReady(tab, Math.min(deadline - ASK_MIN_LEFT_MS, Date.now() + READY_WAIT_MS)))) {
      throw new Error(`${tabTitle(tab)} (the terminal) is still starting${runningAgent(tab) ? ` ${agentKind(runningAgent(tab)).name}` : ''}, so nothing was typed. Ask again in a moment.`);
    }
    /** Checked again in its turn to type: what's allowed, and the time left. */
    const ready = () => {
      recheck();
      if (deadline - Date.now() < ASK_MIN_LEFT_MS) throw new Error(`The wait was used up before ${tabTitle(tab)} (the terminal) could be typed into, so nothing was typed.`);
    };
    const result = await (runningAgent(tab) ? askAgent(tab, text, deadline, from, ready) : askShell(tab, text, deadline, ready));
    checkRead(tab, from); // still allowed to read it, now that the answer is in
    return result;
  } finally {
    asking.delete(tab);
  }
}

/**
 * An ask to the agent in a terminal: its reply once the turn this line starts ends.
 * @param {Tab} tab
 * @param {unknown} text
 * @param {number} deadline
 * @param {string | null | undefined} from
 * @param {() => void} ready
 */
async function askAgent(tab, text, deadline, from, ready) {
  const turn = await typeInto(tab, text, true, () => {
    ready();
    return noteTyped(tab);
  });
  return waitForTerminal(tab, { until: UNTIL.agentDone, after_turn: turn, timeout_s: Math.max(1, Math.floor((deadline - Date.now()) / SECOND_MS)), from });
}

/**
 * An ask to a shell: the command's output once it ends. In its turn it waits for the shell to answer a line typed before it
 * (back at its prompt), so that line's command can't pass for this one; it types only into an idle shell, as with a command
 * running the line would go to that command; and its end is listened for from the moment the line goes in.
 * @param {Tab} tab
 * @param {unknown} text
 * @param {number} deadline
 * @param {() => void} ready
 */
async function askShell(tab, text, deadline, ready) {
  // Wrapped, so the typing queue moves on once Enter is in rather than when the command ends.
  const busy = () => {
    if (tab.running) throw new Error(`${tabTitle(tab)} (the terminal) is still running ${tab.running.command ?? 'a command'}: ask_terminal waits for a new one. Use send_to_terminal to type into the running one, or wait_for_terminal.`);
  };
  const listening = await typeInto(tab, text, true, async () => {
    busy();
    // Briefly: this holds up any typing behind it, which may be meant to stop what that line started.
    const answered = await shellAnswered(tab, Math.min(deadline - ASK_MIN_LEFT_MS, Date.now() + ANSWER_WAIT_MS));
    ready();
    busy();
    if (!answered) throw new Error(`${tabTitle(tab)} (the terminal) hasn't answered the line typed into it before, so its command couldn't be told from this one. Ask again once it's back at its prompt.`);
    noteTyped(tab);
    return { end: nextCommandEnd(tab, deadline) };
  });
  return listening.end;
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
  open: ({ profile, cwd, name, workspace, command, argv, reuse, from }) => {
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
    // Opened by a terminal's agent or script: that terminal may read it and type into it (together.js isOpener).
    if (from && state.tabs.has(from)) tab.openedBy = from;
    return { id: tab.id };
  },
  snippets: () => listForApi(),
  read: ({ pane, what, count, from }) => readTerminal(tabFor(pane), { what, count, from }),
  wait: ({ pane, until, pattern, timeout_s, after_turn, from }) => waitForTerminal(tabFor(pane), { until, pattern, timeout_s, after_turn, from }),
  snippet: ({ name, pane, vars, from }) => {
    const tab = tabFor(pane);
    checkType(tab, from);
    // In its turn, as sends and asks are; checked again then. It asks about production itself (snippets.js).
    return queued(tab, () => {
      checkType(tab, from, false);
      return runForApi({ name, tab, vars: vars ?? {}, beforeSend: noteTyped });
    });
  },
  send: async ({ pane, text, enter, from }) => {
    const { tab, recheck } = await typable(pane, text, from);
    // Noted as it goes in, after any question and any typing before it: a wait after it waits out the turn it starts.
    const turn = await typeInto(tab, text, !!enter, () => {
      recheck();
      return noteTyped(tab);
    });
    // For an agent there: a wait for its answer waits for a turn after this one (together.js waitForTurn).
    return { id: tab.id, turn };
  },
  ask,
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
