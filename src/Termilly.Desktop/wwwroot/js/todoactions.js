// @ts-check
// What To do does beyond its lists, for the panel (js/todopanel.js) and a phone (js/phonetodo.js) alike: the folder a list
// is in, whether that folder's repository is on GitHub, Implement, and keeping the issue made from a task.
// Implement on an SSH host: Claude Code runs there, in the folder the terminal's shell is in. Termilly's MCP server isn't on
// the host, so it can't finish the task itself: when its turn ends (its hooks, through Termilly's integration on the host),
// the task goes to Review with its last reply.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, emit, lastFolderOf, wsById, isSsh, profileOf, defaultProfile, activityOf, ACTIVITY, EVENTS } from './store.js';
import { newTab } from './panes.js';
import { commandLine } from './quoting.js';
import { resumeCommand } from './resume.js';
import { AGENT_COMMAND } from './agentcli.js';
import { AGENT_STATE, PROFILE_ICON } from './constants.js';
import { alertReview } from './notify.js';
import { LIST_KIND, findTask, setStatus, updateTask } from './todo.js';
import { implementPrompt, remotePrompt, linkSub, statusOf, tickSub, TASK_STATUS } from './todolist.js';

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
 * Where Implement runs a list's tasks.
 * @typedef {{ folder: string, profile: SessionProfile, server: string | null }} ImplementPlace server: the SSH host's name, or
 *   null for this computer
 */

/**
 * Where Implement runs a list's tasks: here, in the list's folder, when Claude Code is installed here; for a terminal on an SSH
 * host, on that host, in the folder its shell is in. Null when it can't run: no folder known (on a host, Termilly's integration
 * there reports it), or no Claude Code here.
 * @param {ListRef} ref
 * @returns {ImplementPlace | null}
 */
export function implementPlace(ref) {
  const tab = ref.kind === LIST_KIND.terminal ? state.tabs.get(ref.id) : null;
  if (tab && isSsh(tab)) {
    const folder = lastFolderOf(tab);
    const profile = profileOf(tab);
    return folder && profile ? { folder, profile, server: profile.name } : null;
  }
  const folder = folderOfList(ref);
  const id = tab?.profile ?? defaultProfile();
  const profile = state.profiles.find(p => p.id === id);
  return folder && profile && agentInstalled() ? { folder, profile, server: null } : null;
}

/**
 * Why Implement can't run a list's tasks, for its button's tooltip; '' when it can.
 * @param {ListRef} ref
 */
export function cantImplement(ref) {
  if (implementPlace(ref)) return '';
  const tab = ref.kind === LIST_KIND.terminal ? state.tabs.get(ref.id) : null;
  return tab && isSsh(tab) ? `Implement needs the folder this terminal is in on ${profileOf(tab)?.name ?? 'the server'}: set Termilly up there` : 'Implement needs a folder on this computer';
}

/** Whether a list's To do shows Implement: Claude Code is installed here, or the list's terminal is on an SSH host. @param {ListRef} ref */
export function offersImplement(ref) {
  const tab = ref.kind === LIST_KIND.terminal ? state.tabs.get(ref.id) : null;
  return agentInstalled() || (!!tab && isSsh(tab));
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
  const place = implementPlace(ref);
  if (!place) return null;
  const tab = ref.kind === LIST_KIND.terminal ? state.tabs.get(ref.id) : null;
  const wsId = tab?.wsId ?? ref.id;
  const name = (sub?.text ?? task.text).slice(0, MAX_AGENT_NAME).trimEnd();
  const { folder, profile } = place;
  /** @type {Tab} */
  let agent;
  if (place.server) {
    // Typed at the host's first prompt: to the folder, then Claude Code, only once it's there.
    const start = commandLine([AGENT_COMMAND, remotePrompt(task, sub)], PROFILE_ICON.ssh);
    const there = resumeCommand(folder, null);
    agent = newTab({ wsId, profile: profile.id, name, command: there ? `${there} && ${start}` : start });
    onServer.set(agent.id, { taskId: task.id, line: sub?.at, server: place.server });
  } else {
    // Windows PowerShell 5.1 breaks a program's argument at double quotes inside it: the prompt has none.
    const prompt = implementPrompt(task, sub).replaceAll('"', "'");
    agent = newTab({ wsId, profile: profile.id, cwd: folder, name, command: commandLine([AGENT_COMMAND, prompt], profile.shellIcon ?? profile.icon) });
  }
  setStatus(ref, task.id, TASK_STATUS.progress, { terminal: agent.id });
  return agent;
}

/**
 * Implement's terminals on SSH hosts: by terminal, its task, the step's line when it's on one, and the host.
 * @type {Map<string, { taskId: string, line?: number, server: string }>}
 */
const onServer = new Map();

// Claude Code on a host ended its turn: its task, still In progress there, waits in Review with what it said last.
on(EVENTS.agent, /** @param {Tab} tab */ tab => {
  const run = onServer.get(tab.id);
  if (!run || tab.agent?.state !== AGENT_STATE.done) return;
  onServer.delete(tab.id);
  const found = findTask(run.taskId);
  if (!found || found.task.terminal !== tab.id || statusOf(found.task) !== TASK_STATUS.progress) return;
  const summary = (tab.agent.message ?? '').trim();
  if (run.line !== undefined) updateTask(found.ref, found.task.id, { details: tickSub(found.task.details ?? '', run.line, true) });
  setStatus(found.ref, found.task.id, TASK_STATUS.review, { review: { summary, by: `${tab.agentType ?? AGENT_COMMAND} on ${run.server}` } });
  alertReview(found.task, summary.split(/\r?\n/)[0] ?? '', tab);
});

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
