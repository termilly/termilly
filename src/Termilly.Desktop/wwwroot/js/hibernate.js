// @ts-check
// Hibernating idle agents: with more Claude Code or Codex sessions open than Settings allow (Terminal › Live agents),
// the ones idle longest, out of sight, are ended with /exit, keeping their session id. Opening the terminal
// again resumes the same conversation (claude --resume <id>, codex resume <id>), so many agents can stay open without
// all of them holding memory.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, on, emit, activityChanged, resumeAgentCommand, EVENTS } from './store.js';
import { typeAtPrompt, prepareStart } from './terminals.js';
import { beforeEnter } from './enterwait.js';
import { AGENT_KIND, AGENT_STATE } from './constants.js';
import { SECOND_MS, MINUTE_MS } from './util.js';

/** How long an agent has to be idle before it may be hibernated, unless a test changes it. */
const DEFAULT_IDLE_MS = 5 * MINUTE_MS;
/** How long after the Esc that clears Claude Code's prompt /exit is typed. */
const EXIT_DELAY_MS = 150;
/** What ends Claude Code's and Codex's session. */
const EXIT_COMMAND = '/exit';
/** How often the agents are checked against the limit, besides when workspaces or agents change. */
const CHECK_EVERY_MS = 30 * SECOND_MS;

/** How long an agent has to be idle before it may be hibernated. */
export let IDLE_FOR = DEFAULT_IDLE_MS;
/** For tests: a shorter wait. */
/** @param {number} ms */
export const setIdleFor = ms => { IDLE_FOR = ms; };

const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;

/**
 * A Claude Code session that's running and could be hibernated (its id known).
 * @param {Tab} tab
 */
const live = tab => tab.agent && tab.agent.session && SESSION_ID.test(tab.agent.session) && !tab.hibernated && !tab.exited;
// These two are only asked about live terminals (see live), which have an agent.
/**
 * A session that never had a turn has no saved conversation to resume, so it isn't hibernated.
 * @param {Tab} tab
 */
const resumable = tab => /** @type {AgentInfo} */ (tab.agent).hadTurn;
/** @param {Tab} tab */
const idle = tab =>
  (/** @type {AgentInfo} */ (tab.agent).state === AGENT_STATE.idle
    || /** @type {AgentInfo} */ (tab.agent).state === AGENT_STATE.done)
  && Date.now() - (/** @type {AgentInfo} */ (tab.agent).at ?? 0) >= IDLE_FOR;

/** Ends agents beyond the limit, idle longest first, never one in the workspace on screen. */
export function enforceLimit() {
  const limit = state.settings.agents.limit ?? 0;
  if (!limit) return;
  const running = [...state.tabs.values()].filter(live);
  let excess = running.length - limit;
  if (excess <= 0) return;
  const candidates = running
    // One in a window of its own is in sight, whatever workspace is shown.
    .filter(t => t.wsId !== state.activeId && !t.detached && idle(t) && resumable(t))
    .sort((a, b) => (/** @type {AgentInfo} */ (a.agent).at ?? 0) - (/** @type {AgentInfo} */ (b.agent).at ?? 0));
  for (const tab of candidates) {
    if (excess-- <= 0) break;
    hibernate(tab);
  }
}

/**
 * Marks a terminal's agent session as hibernated (ended, to resume when the terminal is opened).
 * @param {Tab} tab
 * @param {string} session
 * @param {number} [at]
 * @param {string | null} [folder] the folder the session belongs to
 * @param {string} [kind] which agent: one of AGENT_KIND
| null} [folder] the folder the session belongs to
 */
export function markHibernated(tab, session, at = Date.now(), folder = null, kind = AGENT_KIND.claude) {
  tab.hibernated = { session, at, folder, kind };
}

/** @param {Tab} tab A live terminal (see live): its agent has a session id. */
function hibernate(tab) {
  const agent = /** @type {AgentInfo} */ (tab.agent);
  markHibernated(tab, /** @type {string} */ (agent.session), Date.now(), agent.folder, agent.kind);
  // Esc clears anything half-typed at Claude Code's prompt; /exit ends the session (SessionEnd clears tab.agent). Its
  // Enter goes after it, as the API types a prompt: Codex takes text and Enter written together for a paste, and the
  // Enter only makes a new line there.
  send(PAGE.input, { id: tab.id, data: '\x1b' });
  setTimeout(async () => {
    send(PAGE.input, { id: tab.id, data: EXIT_COMMAND });
    await beforeEnter(tab);
    send(PAGE.input, { id: tab.id, data: '\r' });
  }, EXIT_DELAY_MS);
  activityChanged(tab, true);
  emit(EVENTS.tab, tab);
}

/**
 * A terminal set aside (panes.js setAsideTab): its agent ends now if it's between turns, keeping its session, or once
 * it is (one at work finishes first, one asking waits for its answer). One that never had a turn has nothing to resume,
 * so it keeps running.
 * @param {Tab} tab
 */
export function restAside(tab) {
  const now = tab.agent?.state;
  if (tab.setAside && live(tab) && resumable(tab) && (now === AGENT_STATE.idle || now === AGENT_STATE.done)) hibernate(tab);
}

/**
 * The terminal was opened: a hibernated agent resumes where it was.
 * @param {Tab} tab
 */
export function wake(tab) {
  if (!tab.hibernated) return;
  const { session, kind } = tab.hibernated;
  tab.hibernated = null;
  typeAtPrompt(tab, resumeAgentCommand(session, kind)); // after a restart its shell may still be starting
  // Known as the terminal's session until the agent says so itself (Codex does only after a prompt): set aside or
  // restarted before then, it isn't lost.
  prepareStart(tab, { resumeSession: session, resumeKind: kind });
  activityChanged(tab, true);
}

on(EVENTS.workspaces, enforceLimit);
on(EVENTS.agent, enforceLimit);
on(EVENTS.agent, tab => { if (tab?.setAside) restAside(tab); });
setInterval(enforceLimit, CHECK_EVERY_MS);
