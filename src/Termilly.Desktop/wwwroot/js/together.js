// @ts-check
// Terminals that work together: an agent in one terminal reads another's output (the last command and its exit
// code, from the OSC 133 marks, or its last lines) and waits for something to happen there (the command finishes, a
// line matches), through `termilly read` / `termilly wait` and the MCP server; and "Send to agent…" pastes a
// command's output into an agent terminal's prompt. Each terminal says whether agents may read it (on by default
// only for local terminals, not SSH, WSL, containers, production or ones tagged sensitive) and type into it (off
// unless allowed for it). A terminal an agent opened itself is that agent's to read and type into, unless the user
// said otherwise on it: it could have run the same in its own shell. Every read and every typed text shows on the
// terminal for a while, and in its access log.
// The host redacts secrets and marks what's read as untrusted (TerminalOutput.cs).

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, on, emit, tabTitle, profileOf, activityChanged, EVENTS, sourceOf, runsClaude, runningAgent } from './store.js';
import { bufferLines } from './terminals.js';
import { lastOutput } from './commands.js';
import { environmentOf } from './environments.js';
import { showMenu } from './popups.js';
import { switchWorkspace, focusTab } from './panes.js';
import { noticeDialog } from './dialogs.js';
import { PROFILE_SOURCE, AGENT_STATE } from './constants.js';
import { agentKind, agentOfProgram } from './agentkinds.js';
import { noteTyping, planWait, isOver, replyOf, waitDone } from './agentturns.js';
import { showToast, TOAST } from './toasts.js';
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
export const UNTIL = Object.freeze({ commandFinished: 'command_finished', outputMatches: 'output_matches', agentDone: 'agent_done' });
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
  return `${tab.agent ? agentKind(tab.agent.kind).short : 'a script'} in ${tabTitle(tab)}`;
}

/**
 * Whether a terminal is one agents may be let into without the user saying so: on this computer, not production, not tagged
 * sensitive. Not SSH, WSL or a container.
 * @param {Tab} tab
 */
function isPlain(tab) {
  const source = sourceOf(profileOf(tab));
  return /** @type {string[]} */ ([PROFILE_SOURCE.local, PROFILE_SOURCE.custom]).includes(source) && !environmentOf(tab) && !tab.tags.includes('sensitive');
}

/**
 * Whether agents may read this terminal: its own choice, else the default for its kind.
 * @param {Tab} tab
 */
export function canRead(tab) {
  if (typeof tab.agentRead === 'boolean') return tab.agentRead;
  if (state.settings.agents.readDefault === false) return false;
  return isPlain(tab);
}

/**
 * Whether the terminal that asks opened this one (the API's open, tab.openedBy) and is still there: then it may read it and
 * type into it without the user turning that on. Only a plain terminal (isPlain): one on a server or on production still asks.
 * @param {Tab} tab
 * @param {string | null | undefined} from
 */
const isOpener = (tab, from) => !!from && tab.openedBy === from && state.tabs.has(from) && isPlain(tab);

/**
 * Whether agents may type here: only when allowed for this terminal (and Settings allow typing at all).
 * @param {Tab} tab
 */
export const canType = tab => tab.agentType === true;

/**
 * How other terminals' agents use a terminal (tab.access): the accesses, the one shown now, its timer, the waits.
 * @typedef {{ log: AccessEntry[], mark: AccessEntry | null, timer: number, waiters: Set<() => void> } & import('./agentturns.js').Typed} Access
 */

/**
 * How other terminals' agents and scripts use a terminal, kept here: the accesses (newest first), the one its header
 * shows for a while, that while's timer, and the `termilly wait` calls waiting for its command to end.
 * @param {Tab} tab
 * @returns {Access}
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
 * The read check for the API's read, wait and ask.
 * @param {Tab} tab
 * @param {string | null | undefined} from
 */
export function checkRead(tab, from) {
  if (from && from === tab.id) return; // a terminal reading itself
  if (tab.agentRead === undefined && isOpener(tab, from)) return; // it opened this terminal
  if (!canRead(tab)) throw new Error(`${tabTitle(tab)} (the terminal) doesn't let scripts or agents read it. Turn it on in its menu: Scripts and agents › Can read this terminal.`);
}

/**
 * The typing check for the API's send, ask and snippets (the global switch is checked by the host). Noted on the terminal
 * unless `noteIt` is false (a check made again before typing, after the user was asked).
 * @param {Tab} tab
 * @param {string | null | undefined} from
 * @param {boolean} [noteIt]
 */
export function checkType(tab, from, noteIt = true) {
  if (from && from === tab.id) return; // an agent typing into its own terminal
  // Codex asking the user to review its hooks takes single keys ("t" trusts them all): nothing is typed into that but by the user.
  if (hooksWaitForReview(tab)) throw new Error(`${reviewWords(tab)} Nothing can be typed there until then.`);
  if (!canType(tab) && !(tab.agentType === undefined && isOpener(tab, from))) throw new Error(`${tabTitle(tab)} (the terminal) doesn't let scripts or agents type into it. Turn it on in its menu: Scripts and agents › Can type here.`);
  if (noteIt) note(tab, from, 'typed into');
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
 * Waits for the running command to finish, for a new output line to match `pattern`, or for the agent running there
 * to end its turn, then reads like readTerminal; { timedOut: true } after `timeout_s` (60 s by default, at most 110:
 * the host waits 115).
 * @param {Tab} tab
 * @param {{ until?: string, pattern?: string, timeout_s?: number, after_turn?: number | null, from?: string | null }} [options]
 */
export function waitForTerminal(tab, { until = UNTIL.commandFinished, pattern, timeout_s: timeout = DEFAULT_WAIT_S, after_turn: afterTurn, from } = {}) {
  checkRead(tab, from);
  note(tab, from, 'watched');
  const limit = Math.min(MAX_WAIT_S, Math.max(1, Number(timeout) || DEFAULT_WAIT_S)) * SECOND_MS;
  if (until === UNTIL.agentDone) return waitForTurn(tab, limit, afterTurn);
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

/** What an ask that timed out says, with the terminal's last lines: told from what the terminal shows at that moment. */
const STILL_RUNNING = 'The command was still running when the wait ended; it was left running.';
const NOT_STARTED = 'No command started after the line was typed: it may have gone to a program waiting for input.';
const NO_MARKS = 'This terminal hasn’t reported where its commands start and end (no shell integration there), so whether the command is done can’t be told.';

/**
 * The end of the next command in a terminal, set up before that command is typed (the API's ask), so a quick one can't end
 * before anything listens. Resolves like readTerminal's last command; at `deadline` (ms since the epoch) with the last
 * lines, timedOut and why it couldn't tell. Call it only when no command runs there.
 * @param {Tab} tab
 * @param {number} deadline
 * @returns {Promise<object>}
 */
export function nextCommandEnd(tab, deadline) {
  return new Promise(resolve => {
    let done = false;
    /** @param {object} result */
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      accessOf(tab).waiters.delete(onEnd);
      resolve(result);
    };
    const onEnd = () => setTimeout(() => finish(snapshot(tab, READ.lastCommand)), END_DELAY_MS);
    // A shell that has never reported a command (no OSC 133 marks) won't report this one's end either.
    const why = () => (tab.running ? STILL_RUNNING : tab.lastCommand ? NOT_STARTED : NO_MARKS);
    const timer = setTimeout(() => finish({ ...snapshot(tab, READ.lines, MATCH_LINES), timedOut: true, why: why() }), Math.max(0, deadline - Date.now()));
    accessOf(tab).waiters.add(onEnd);
  });
}

/** When a script or agent last pressed Enter in a terminal, and when its shell last came back to its prompt. @type {WeakMap<Tab, number>} */
const enteredAt = new WeakMap();
/** @type {WeakMap<Tab, number>} */
const promptAt = new WeakMap();
/** Waits for a prompt to come back. @type {Set<() => void>} */
const promptWaiters = new Set();
on(EVENTS.prompt, tab => {
  promptAt.set(tab, Date.now());
  for (const fn of [...promptWaiters]) fn();
});

/**
 * Notes that the API pressed Enter in a terminal: an ask after it waits for the shell to answer that line (shellAnswered).
 * @param {Tab} tab
 */
export const noteEnter = tab => { enteredAt.set(tab, Date.now()); };

/**
 * Whether the shell has come back to its prompt since the API last pressed Enter there, waiting for it until `until` (ms
 * since the epoch). True right away when it has, when nothing was typed, or when the shell doesn't report its prompts (no
 * OSC 133 marks): then nothing can be told apart anyway.
 * @param {Tab} tab
 * @param {number} until
 * @returns {Promise<boolean>}
 */
export function shellAnswered(tab, until) {
  const answered = () => tab.exited || (promptAt.get(tab) ?? 0) >= (enteredAt.get(tab) ?? 0);
  if (!tab.lastCommand && !promptAt.has(tab) || answered()) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      promptWaiters.delete(check);
      resolve(answered());
    };
    const check = () => { if (answered()) finish(); };
    const timer = setTimeout(finish, Math.max(0, until - Date.now()));
    promptWaiters.add(check);
  });
}

/**
 * How long a starting agent's screen stays still, its input line showing, before it counts as ready for a prompt (Codex
 * reports nothing until one).
 */
const READY_QUIET_MS = 1000;
/** How often a wait for a terminal to be ready looks again. */
const READY_POLL_MS = 200;
/** How long after its start command was typed an agent it names counts as still starting. */
const STARTING_MS = 30_000;

/**
 * Whether a terminal is ready for a line: its start command typed (a terminal just opened gets it at its first prompt),
 * the agent that command starts running there, and that agent ready for a prompt: Claude Code once its hooks report in
 * (SessionStart), Codex once its input line shows and its screen has been still a moment, as it reports nothing until its
 * first prompt (its start has quiet stretches before it reads keys: a line typed in one is lost). A shell
 * is ready once it has shown a prompt: marked (OSC 133), or for one without marks, something on its screen that has been
 * still a moment. Typed into a shell still starting, a line can be lost or upset it (Windows PowerShell's line editor
 * crashed on one).
 * @param {Tab} tab
 * @param {number} quietSince when its screen last changed (ms since the epoch)
 */
function isReady(tab, quietSince) {
  if (tab.exited) return true; // nothing to wait for: the ask says so
  const start = tab.start;
  if (start && !start.done || start?.command) return false; // its shell, or its start command, still to come
  // The agent a start command typed a moment ago starts (the host reports its program a little after it's typed).
  const typed = start?.typed && Date.now() - start.typed.at < STARTING_MS ? start.typed.command : '';
  const starts = agentOfProgram(typed.trim().split(/\s+/)[0]);
  const agent = runningAgent(tab);
  if (starts && !agent) return false; // typed, its program not up yet
  const still = Date.now() - quietSince >= READY_QUIET_MS;
  if (!agent) return !!tab.lastCommand || promptAt.has(tab) || (still && bufferLines(tab).some(line => line.trim()));
  const kind = agentKind(agent);
  return !!tab.agent || !kind.hookAtStart && still && showsInput(tab, kind);
}

/**
 * Whether an agent's input line is up (for one that has an input mark; any other counts as showing it): the row its cursor
 * is on starts with the mark. Not any row on screen: Codex runs inline, so an earlier session's lines (› and what was
 * asked) stay on screen when it's started again there.
 * @param {Tab} tab
 * @param {import('./agentkinds.js').AgentKind} kind
 */
function showsInput(tab, kind) {
  const mark = kind.inputMark;
  if (!mark) return true;
  const buffer = tab.view?.term?.buffer.active;
  const row = buffer?.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '';
  return row.trimStart().startsWith(mark);
}

/**
 * Waits until a terminal is ready for a line (isReady): one just opened, or whose agent is still starting, gets that long,
 * so a line isn't typed into a shell that hasn't started its agent yet, or an agent still drawing its screen. False when
 * it isn't by `until` (ms since the epoch).
 * @param {Tab} tab
 * @param {number} until
 * @returns {Promise<boolean>}
 */
export function terminalReady(tab, until) {
  let quietSince = Date.now();
  if (isReady(tab, quietSince)) return Promise.resolve(true);
  const writes = tab.view?.term?.onWriteParsed(() => { quietSince = Date.now(); });
  return new Promise(resolve => {
    const look = () => {
      const ready = isReady(tab, quietSince);
      if (!ready && Date.now() < until) return;
      clearInterval(timer);
      writes?.dispose();
      resolve(ready);
    };
    const timer = setInterval(look, READY_POLL_MS);
  });
}

// A command ending wakes whoever waits on it.
on(EVENTS.commandEnding, ({ tab }) => { for (const fn of tab.access?.waiters ?? []) fn(); });

/**
 * Notes where the agent's turns and reports stood as a script or agent types into its terminal, so a wait after it
 * waits out the turn that text starts or answers (agentturns.js). Call it right before the text goes in (after any
 * question to the user). Returns the turn noted, which that request gives back (a later typing may note another).
 * @param {Tab} tab
 */
export const noteTyped = tab => noteTyping(tab, accessOf(tab));

/**
 * Waits for the agent in a terminal (Claude Code, Codex) to end a turn, by its hooks: a full-screen agent redraws its
 * screen rather than adding lines, so an output pattern can't tell. Which turn: agentturns.js planWait. One that
 * already ended counts, so a quick answer that came before the wait began isn't missed, even if the agent has exited
 * since. Returns the agent's state, its answer (the hooks carry it, cut at 500 characters), the turn's number and the
 * screen's last lines.
 * @param {Tab} tab
 * @param {number} limit in ms
 * @param {number | null | undefined} afterTurn wait for a turn after this many had started (a result's turn)
 * @returns {Promise<object>}
 */
function waitForTurn(tab, limit, afterTurn) {
  const plan = planWait(tab, tab.access, afterTurn);
  const agent = runningAgent(tab);
  // An agent gone after answering is still answered; one that isn't there can't be waited on.
  if (!agent && !isOver(tab, plan)) return Promise.reject(new Error(`No coding agent runs in ${tabTitle(tab)} (the terminal).`));
  // Its program runs but its hooks haven't reported yet (Codex's first comes with its first prompt, which may have just been
  // typed): it's given a while to, then the wait goes on as for any agent.
  if (agent && !runsClaude(tab)) {
    const started = Date.now();
    return firstReport(tab, agent, Math.min(limit, FIRST_REPORT_MS)).then(() => waitForTurn(tab, Math.max(0, limit - (Date.now() - started)), afterTurn));
  }
  return new Promise(resolve => {
    /** @param {object} result */
    const finish = result => {
      clearTimeout(timer);
      turnWaiters.delete(check);
      resolve(result);
    };
    const check = () => {
      if (!isOver(tab, plan)) return;
      waitDone(tab.access, plan); // its typing used up, unless a newer send has typed since
      finish({ ...snapshot(tab, READ.lines, MATCH_LINES), agent: tab.agent?.state ?? AGENT_STATE.exited, turn: tab.agentTurns ?? 0, reply: replyOf(tab, plan) });
    };
    const timer = setTimeout(() => finish({ pane: tab.id, title: tabTitle(tab), timedOut: true, agent: tab.agent?.state ?? null, turn: tab.agentTurns ?? 0 }), limit);
    turnWaiters.add(check);
    check(); // it may be over already
  });
}

/** The waits on agents' turns, each checking its own terminal on every agent's change. @type {Set<() => void>} */
const turnWaiters = new Set();
on(EVENTS.agent, () => { for (const fn of [...turnWaiters]) fn(); });

/** How long an agent whose program runs is given to report in for the first time, before a wait on its turn gives up. */
const FIRST_REPORT_MS = 20_000;
/**
 * What Codex's screen says while hooks it hasn't seen (Termilly's, from another build of it) wait for the user's review: its
 * notice, the choice it starts with ("1. Review hooks", "enter confirm · esc skip") or the list that opens ("t trust all ·
 * enter review · esc close"). A narrow terminal breaks these over lines, so any white space may come between the words. Only
 * the screen's last lines are looked at: the same words further up are a conversation about hooks, not the question.
 */
const HOOKS_NEED_REVIEW = /hooks?\s+needs?\s+review\s+before|Review\s+hooks[\s\S]{0,80}enter\s+confirm|trust\s+all\s*·\s*enter\s+review/i;
const REVIEW_LINES = 30;
/** Terminals whose user has been told its agent's hooks wait for review. @type {WeakSet<Tab>} */
const toldOfReview = new WeakSet();

/** Whether a terminal's screen shows Codex waiting for its hooks to be reviewed. @param {Tab} tab */
const hooksWaitForReview = tab => HOOKS_NEED_REVIEW.test(bufferLines(tab, REVIEW_LINES).join('\n'));

/**
 * What an agent is told when another's hooks wait for review; the user is told too, once for the terminal: only they can
 * review them.
 * @param {Tab} tab
 */
function reviewWords(tab) {
  const where = `${agentKind(runningAgent(tab)).name} in ${tabTitle(tab)}`;
  if (!toldOfReview.has(tab)) showToast({ text: `${where} waits for you: review Termilly’s hooks there, once, so Termilly can tell when it’s done`, state: TOAST.failed });
  toldOfReview.add(tab);
  return `${where} is waiting for the user: its screen asks them to review its hooks before they can run. The user has been told; only they can answer it, in that terminal.`;
}

/**
 * Waits for an agent's first report in a terminal (its hooks reaching Termilly). When none comes, says why as far as it can be
 * told: Codex's screen saying its hooks need review (the user is told too, once: only they can review them), or else that its
 * hooks are off.
 * @param {Tab} tab
 * @param {string} agent the agent whose program runs there (AGENT_KIND)
 * @param {number} limit in ms
 * @returns {Promise<void>}
 */
function firstReport(tab, agent, limit) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!runsClaude(tab) && runningAgent(tab)) return;
      clearTimeout(timer);
      turnWaiters.delete(check);
      resolve(); // it reports now, or has exited: the wait on its turn says which
    };
    const timer = setTimeout(() => {
      turnWaiters.delete(check);
      // Gone meanwhile, or reporting after all: the wait on its turn says which.
      if (runsClaude(tab) || !runningAgent(tab)) return void resolve();
      const fallback = 'Wait for an output line instead (until = output_matches), or read its screen.';
      if (hooksWaitForReview(tab)) reject(new Error(`${reviewWords(tab)} Until then it can't tell Termilly when its turn ends. ${fallback}`));
      else reject(new Error(`${agentKind(agent).name} in ${tabTitle(tab)} hasn't reported a turn (waited ${Math.round(limit / SECOND_MS)} seconds): the text may not have reached it, or its hooks are off. Its screen says which: the text in its input or its answer means the hooks are off. ${fallback}`));
    }, limit);
    turnWaiters.add(check);
  });
}

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
    noticeDialog({ title: 'No agent terminal', body: 'Start Claude Code (or another agent) in a terminal first; its output goes to that terminal’s prompt.' });
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
        // The terminal that opened this one may read it and type here by itself, until one of the two below is set.
        ...(tab.openedBy && isOpener(tab, tab.openedBy) ? [{ label: `Opened by ${who(tab.openedBy)}: it reads and types here`, disabled: true, action: () => {} }] : []),
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
