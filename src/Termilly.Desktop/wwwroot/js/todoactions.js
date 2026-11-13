// @ts-check
// What To do does beyond its lists, for the panel (js/todopanel.js) and a phone (js/phonetodo.js) alike: the folder a list
// is in, whether that folder's repository is on GitHub, Implement, and keeping the issue made from a task.
// Implement runs with a plan (js/todoplan.js): the agent that does the work, the agents that review it (js/todoreview.js), and
// whether it's in a new terminal or silent. Each list keeps the plan it was last given to keep.
// Implement on an SSH host: the agent runs there, in the folder the terminal's shell is in. Termilly's MCP server isn't on
// the host, so it can't finish the task itself: when its turn ends (its hooks, through Termilly's integration on the host),
// the task goes to Review with its last reply. Nobody reviews there yet.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, emit, persist, lastFolderOf, wsById, isSsh, profileOf, defaultProfile, activityOf, installedAgents, runningAgent, ACTIVITY, EVENTS } from './store.js';
import { newTab } from './panes.js';
import { commandLine } from './quoting.js';
import { resumeCommand } from './resume.js';
import { AGENT_COMMAND } from './agentcli.js';
import { agentKind } from './agentkinds.js';
import { AGENT_STATE, PROFILE_ICON } from './constants.js';
import { KNOWN_AGENTS, RUN, STAGE, fitPlan } from './todoplan.js';
import { implementSilently, watchWork, workDone, oneMoreRound } from './todoreview.js';
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

export { installedAgents };

/** Whether an agent is installed here. */
export const agentInstalled = () => installedAgents().length > 0;

/** @param {ListRef} ref */
const onServer_ = ref => {
  const tab = ref.kind === LIST_KIND.terminal ? state.tabs.get(ref.id) : null;
  return !!tab && isSsh(tab);
};

/**
 * The agents Implement can use for a list: those installed here; for a terminal on an SSH host, every agent Termilly knows, as
 * what's installed there isn't known.
 * @param {ListRef} ref
 */
export const agentsFor = ref => (onServer_(ref) ? [...KNOWN_AGENTS] : installedAgents());

/**
 * The agents that can review for a list: with more than one agent installed here, all of them (the card leaves out the one
 * doing the work). None with one agent, and none on an SSH host.
 * @param {ListRef} ref
 */
export function reviewersAt(ref) {
  const installed = installedAgents();
  return onServer_(ref) || installed.length < 2 ? [] : installed;
}

/** @param {ListRef} ref */
const planKey = ref => `${ref.kind}:${ref.id}`;

/**
 * The plan Implement starts a list's tasks with: the list's own, else the one for every list (Settings), fitted to the agents
 * there are.
 * @param {ListRef} ref
 */
export function planOf(ref) {
  const plan = fitPlan(state.todo.plans?.[planKey(ref)] ?? state.todo.plan, agentsFor(ref));
  const reviewers = reviewersAt(ref);
  return { ...plan, reviewers: plan.reviewers.filter(kind => reviewers.includes(kind)) };
}

/** Whether a list has a plan of its own. @param {ListRef} ref */
export const hasOwnPlan = ref => !!state.todo.plans?.[planKey(ref)];

/**
 * Keeps a plan as a list's own, from now on.
 * @param {ListRef} ref
 * @param {import('./todoplan.js').ImplementPlan} plan
 */
export function keepPlan(ref, plan) {
  state.todo.plans = { ...state.todo.plans, [planKey(ref)]: plan };
  persist();
}

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
 * Where Implement runs a list's tasks: here, in the list's folder, when an agent is installed here; for a terminal on an SSH
 * host, on that host, in the folder its shell is in. Null when it can't run: no folder known (on a host, Termilly's integration
 * there reports it), or no agent here.
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

/** Whether a list's To do shows Implement: an agent is installed here, or the list's terminal is on an SSH host. @param {ListRef} ref */
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
 * Starts a plan's agent in a new terminal, in the list's folder, on a task or one of its sub-items.
 * @param {ListRef} ref
 * @param {TodoTask} task
 * @param {import('./todolist.js').DetailLine} [sub]
 * @param {import('./todoplan.js').ImplementPlan} [plan] the list's, when not given
 * @returns {Tab | null} its terminal, or null when it can't start here
 */
export function implementTask(ref, task, sub, plan = planOf(ref)) {
  const place = implementPlace(ref);
  if (!place) return null;
  const { program } = agentKind(plan.by);
  const tab = ref.kind === LIST_KIND.terminal ? state.tabs.get(ref.id) : null;
  const wsId = tab?.wsId ?? ref.id;
  const name = (sub?.text ?? task.text).slice(0, MAX_AGENT_NAME).trimEnd();
  const { folder, profile } = place;
  /** @type {Tab} */
  let agent;
  if (place.server) {
    // Typed at the host's first prompt: to the folder, then Claude Code, only once it's there.
    const start = commandLine([program, remotePrompt(task, sub)], PROFILE_ICON.ssh);
    const there = resumeCommand(folder, null);
    agent = newTab({ wsId, profile: profile.id, name, command: there ? `${there} && ${start}` : start });
    onServer.set(agent.id, { taskId: task.id, line: sub?.at, server: place.server });
  } else {
    // Windows PowerShell 5.1 breaks a program's argument at double quotes inside it: the prompt has none.
    const prompt = implementPrompt(task, sub).replaceAll('"', "'");
    agent = newTab({ wsId, profile: profile.id, cwd: folder, name, command: commandLine([program, prompt], profile.shellIcon ?? profile.icon) });
  }
  watchWork(task, plan, place, { line: sub?.at, terminal: agent.id });
  setStatus(ref, task.id, TASK_STATUS.progress, { terminal: agent.id, plan, stage: { what: STAGE.working, round: 0 } });
  return agent;
}

/**
 * Implement: a plan's agent starts on a task, or one of its sub-items, in a new terminal or silently.
 * @param {ListRef} ref
 * @param {TodoTask} task
 * @param {import('./todolist.js').DetailLine | undefined} sub
 * @param {import('./todoplan.js').ImplementPlan} [plan] the list's, when not given
 * @returns {{ started: boolean, tab: Tab | null }} tab: its terminal, when it has one
 */
export function implement(ref, task, sub, plan = planOf(ref)) {
  const place = implementPlace(ref);
  if (!place) return { started: false, tab: null };
  if (plan.run === RUN.silent) {
    implementSilently(ref, task, sub, plan, place);
    return { started: true, tab: null };
  }
  const tab = implementTask(ref, task, sub, plan);
  return { started: !!tab, tab };
}

/**
 * One more round for a task in Review whose reviewers didn't agree (js/todoreview.js).
 * @param {ListRef} ref
 * @param {TodoTask} task
 */
export function anotherRound(ref, task) {
  const place = implementPlace(ref);
  return !!place && oneMoreRound(ref, task, place);
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
  const by = `${agentKind(runningAgent(tab) ?? found.task.plan?.by).program} on ${run.server}`;
  if (run.line !== undefined) updateTask(found.ref, found.task.id, { details: tickSub(found.task.details ?? '', run.line, true) });
  if (workDone(found.task, summary, by)) return;
  setStatus(found.ref, found.task.id, TASK_STATUS.review, { plan: found.task.plan, review: { summary, by, kind: found.task.plan?.by } });
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
