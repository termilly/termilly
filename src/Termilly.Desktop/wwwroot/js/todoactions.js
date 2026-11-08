// @ts-check
// What To do does beyond its lists, for the panel (js/todopanel.js) and a phone (js/phonetodo.js) alike: the folder a list
// is in, whether that folder's repository is on GitHub, Implement, and keeping the issue made from a task.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, emit, lastFolderOf, wsById, isSsh, defaultProfile, activityOf, ACTIVITY, EVENTS } from './store.js';
import { newTab } from './panes.js';
import { commandLine } from './quoting.js';
import { AGENT_COMMAND } from './agentcli.js';
import { AGENT_STATE } from './constants.js';
import { LIST_KIND, setStatus, updateTask } from './todo.js';
import { implementPrompt, linkSub, statusOf, TASK_STATUS } from './todolist.js';

/** @typedef {import('./todo.js').ListRef} ListRef */

export { AGENT_COMMAND };

/** The longest name Implement gives its terminal. */
const MAX_AGENT_NAME = 32;

/** Folders asked about, and whether their repository is on GitHub. */
/** @type {Map<string, boolean>} */
const onGitHub = new Map();

/** Whether Claude Code is installed here: the host offers its profile only then (SessionProfiles.cs). */
export const agentInstalled = () => state.profiles.some(p => p.startCommand === AGENT_COMMAND);

/**
 * Whether Implement's agent is at work on a task right now, so its mark spins: out of sight, unless it waits on the user's
 * Allow; in a terminal, while Claude Code works there (its hooks say so, or progress it reports), not while it waits.
 * @param {TodoTask} task
 */
export function agentWorking(task) {
  if (statusOf(task) !== TASK_STATUS.progress) return false;
  if (task.run) return !task.ask;
  const tab = task.terminal ? state.tabs.get(task.terminal) : null;
  if (!tab) return false;
  if (tab.agent) return tab.agent.state === AGENT_STATE.working;
  const kind = activityOf(tab)?.kind;
  return kind === ACTIVITY.spin || kind === ACTIVITY.percent;
}

/**
 * The folder of a list on this computer: where its terminal or workspace is. A terminal on a server has none.
 * @param {ListRef} ref
 * @returns {string | null}
 */
export function folderOfList(ref) {
  if (ref.kind === LIST_KIND.terminal) {
    const tab = state.tabs.get(ref.id);
    return tab && !isSsh(tab) ? lastFolderOf(tab) ?? wsById(tab.wsId)?.cwd ?? null : null;
  }
  return ref.kind === LIST_KIND.workspace ? wsById(ref.id)?.cwd ?? null : null;
}

/**
 * Whether an issue can be made in a folder, as far as is known.
 * @param {string} folder
 */
export const isOnGitHub = folder => !!onGitHub.get(folder);

/**
 * Asks once whether a folder's repository is on GitHub. To do's event says when it is.
 * @param {string} folder
 */
export function checkRepo(folder) {
  if (onGitHub.has(folder)) return;
  onGitHub.set(folder, false);
  send(PAGE.todoRepoCheck, { folder });
}

onHost(HOST.todoRepoChecked, m => {
  if (!m.folder || !m.onGitHub) return;
  onGitHub.set(m.folder, true);
  emit(EVENTS.todo);
});

/**
 * Starts Claude Code in a new terminal, in the list's folder, on a task or one of its sub-items.
 * @param {ListRef} ref
 * @param {TodoTask} task
 * @param {import('./todolist.js').DetailLine} [sub]
 * @returns {Tab | null} its terminal, or null when it can't start here
 */
export function implementTask(ref, task, sub) {
  const folder = folderOfList(ref);
  if (!folder || !agentInstalled()) return null;
  const tab = ref.kind === LIST_KIND.terminal ? state.tabs.get(ref.id) : null;
  const wsId = tab?.wsId ?? ref.id;
  const profile = tab?.profile ?? defaultProfile();
  const shell = state.profiles.find(p => p.id === profile);
  // Windows PowerShell 5.1 breaks a program's argument at double quotes inside it: the prompt has none.
  const prompt = implementPrompt(task, sub).replaceAll('"', "'");
  const agent = newTab({ wsId, profile, cwd: folder, name: (sub?.text ?? task.text).slice(0, MAX_AGENT_NAME).trimEnd(), command: commandLine([AGENT_COMMAND, prompt], shell?.shellIcon ?? shell?.icon) });
  setStatus(ref, task.id, TASK_STATUS.progress, { terminal: agent.id });
  return agent;
}

/**
 * Keeps the issue made from a task, or from a sub-item of it.
 * @param {ListRef} ref
 * @param {TodoTask} task
 * @param {number | undefined} line the sub-item's line
 * @param {{ repo: string, number: number, url: string }} issue
 */
export function keepIssue(ref, task, line, issue) {
  updateTask(ref, task.id, line === undefined ? { issue } : { details: linkSub(task.details ?? '', line, issue.url) });
}
