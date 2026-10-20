// @ts-check
// What an agent is up to, in one dim line under its terminal's row in the sidebar ("Editing src/api/routes.ts",
// "Running npm", "Done: added refresh-token rotation"), and a ■ that stops it from anywhere. The line comes from the
// hooks Termilly already gets: the tool, its file or a few words about it, and the reply that ended the turn.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, tabsOf, wsById, tabTitle, GROUPS } from './store.js';
import { confirmDialog } from './dialogs.js';
import { updateSettings } from './preferences.js';
import { AGENT_STATE, HOOK_EVENT, SETTING_VALUES } from './constants.js';

/**
 * The parts of an agent event (Host_agent) the activity line reads.
 * @typedef {{ state?: string, event?: string | null, tool?: string | null, message?: string | null,
 *   reason?: string | null, target?: string | null }} AgentEvent
 */

/** The choices of the settings used here (C#'s SettingValues). */
const { agentLine } = SETTING_VALUES;

/** How long a path in the activity line may be, in characters, before its start is cut. */
const MAX_PATH_CHARS = 48;

/** The label of the button that confirms stopping an agent. */
const STOP_LABEL = 'Stop';

/**
 * A path cut from the start, so the file name stays: …/api/routes.ts.
 * @param {string | null | undefined} path
 * @param {number} [max]
 */
export function shortPath(path, max = MAX_PATH_CHARS) {
  const p = String(path ?? '');
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  let out = /** @type {string} */ (parts.pop());
  while (parts.length && out.length + parts[parts.length - 1].length + 1 <= max - 2) out = `${parts.pop()}/${out}`;
  return `…/${out}`;
}

/** @param {string | null | undefined} text */
const firstLine = text => String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';

/**
 * The verb for a tool: "Editing", "Running"… and what follows it.
 * @type {Record<string, (t: string | null | undefined) => string>}
 */
const TOOLS = {
  Edit: t => `Editing ${shortPath(t)}`,
  MultiEdit: t => `Editing ${shortPath(t)}`,
  Write: t => `Writing ${shortPath(t)}`,
  NotebookEdit: t => `Editing ${shortPath(t)}`,
  Read: t => `Reading ${shortPath(t)}`,
  NotebookRead: t => `Reading ${shortPath(t)}`,
  Bash: t => (t ? `Running ${t}` : 'Running a command'),
  PowerShell: t => (t ? `Running ${t}` : 'Running a command'),
  Grep: t => (t ? `Searching “${t}”` : 'Searching'),
  Glob: t => (t ? `Finding ${t}` : 'Finding files'),
  WebFetch: () => 'Reading a web page',
  WebSearch: () => 'Searching the web',
  Agent: t => (t ? `Starting a subagent: ${t}` : 'Starting a subagent'),
  Task: t => (t ? `Starting a subagent: ${t}` : 'Starting a subagent'),
  TodoWrite: () => 'Updating its to-do list',
  AskUserQuestion: () => 'Asking you a question',
};

/**
 * The activity line for an agent event (onHost(HOST.agent) in main.js): what it's doing while it works, what it's
 * waiting for when it needs you, the first line of its reply when it stops. Null keeps the line as it was.
 * @param {AgentEvent} m
 */
export function activityLine(m) {
  if (m.state === AGENT_STATE.needsInput) return firstLine(m.message) || (m.tool ? `Allow ${m.tool}?` : 'Needs you');
  if (m.state === AGENT_STATE.error) return `Stopped: ${firstLine(m.reason ?? m.message) || 'an error'}`;
  if (m.state === AGENT_STATE.done) return firstLine(m.message) ? `Done: ${firstLine(m.message)}` : 'Done';
  if (m.event === HOOK_EVENT.userPromptSubmit) return 'Thinking…';
  if (m.event === HOOK_EVENT.preToolUse && m.tool) return (TOOLS[m.tool] ?? (() => `Using ${/** @type {string} */ (m.tool).replace(/^mcp__([^_]+)__/, '$1: ')}`))(m.target);
  if (m.event === HOOK_EVENT.preCompact) return 'Compacting the conversation';
  return null;
}

/**
 * Whether the sidebar shows a terminal's activity line (Settings › Terminal › Agent activity line).
 * @param {Tab} tab
 */
export function showsLine(tab) {
  const mode = state.settings.agents.line ?? agentLine.default;
  if (mode === agentLine.off || !tab.agent?.line) return false;
  return mode === agentLine.on || tab.wsId === state.activeId;
}

/** @param {Tab} tab */
export const isAgentWorking = tab =>
  /** @type {(string | undefined)[]} */ ([AGENT_STATE.working, AGENT_STATE.needsInput]).includes(tab.agent?.state);

/**
 * Sends Esc, Claude Code's (and Codex's) interrupt, without focusing the terminal. Asks the first time.
 * @param {Tab} tab
 */
export async function stopAgent(tab) {
  if (!(await confirmStop(`Stop ${tabTitle(tab)}?`))) return;
  send(PAGE.input, { id: tab.id, data: '\x1b' });
}

/**
 * Stops every agent working in a workspace.
 * @param {Workspace} [ws]
 */
export async function stopAllAgents(ws = /** @type {Workspace} */ (wsById(state.activeId))) {
  const working = tabsOf(ws).filter(isAgentWorking);
  if (!working.length || !(await confirmStop(`Stop ${working.length} agent${working.length === 1 ? '' : 's'} in ${ws.name}?`))) return;
  for (const tab of working) send(PAGE.input, { id: tab.id, data: '\x1b' });
}

/** @param {string} title */
async function confirmStop(title) {
  if (state.settings.uiState.stopAgentConfirmed) return true;
  const ok = await confirmDialog({ title, body: 'This presses Esc in the terminal, which interrupts Claude Code or Codex where it is. Termilly won’t ask again.', confirm: STOP_LABEL });
  if (ok) updateSettings(GROUPS.uiState, { stopAgentConfirmed: true });
  return ok;
}
