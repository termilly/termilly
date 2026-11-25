// @ts-check
// An agent's background tasks (Features/BackgroundTasks.cs): the commands it started in the background, a Codex
// review, a test run, a server. Its spinner stays while any runs and its "done" waits for them (store.js). They show
// as rows under its terminal in the sidebar, and as a chip in its bar that lists them with their output and Stop;
// Settings › Terminal turns either off.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, activityChanged, runningTasks, tasksEnded, on, EVENTS } from './store.js';
import { escapeHtml } from './ui.js';
import { clock } from './subagents.js';
import { openPopover, isOpen } from './popups.js';
import { showChange } from './preview.js';
import { TASK_STATE } from './constants.js';

/** The marks a task's row starts with: a spinner while it runs, then how it ended. @type {Record<string, string>} */
const ICON = { [TASK_STATE.running]: '<span class="sub-spin"></span>', [TASK_STATE.done]: '✓', [TASK_STATE.failed]: '✗' };
/** The Stop on a running task's row, and the terminal it belongs to (a delegated click, see below). */
const STOP_ATTR = 'data-task-stop';
const STOP_TAB_ATTR = 'data-task-tab';
const OUTPUT_ATTR = 'data-task-output';

const sidebarShown = () => state.settings.agents.tasksInSidebar !== false;
const barShown = () => state.settings.agents.tasksInBar !== false;

/**
 * A task's name: why the agent started it, else what it runs.
 * @param {TaskView} task
 */
const nameOf = task => task.description || task.command || 'Background task';

/**
 * How long it has run, or ran.
 * @param {TaskView} task
 */
const ranFor = task => clock((task.endedAt ?? Date.now()) - task.startedAt);

/**
 * What a task's hover says: its command and its output's last line.
 * @param {TaskView} task
 */
const hoverOf = task => [task.command, task.lastLine, task.state === TASK_STATE.failed ? `Exited with code ${task.exitCode}` : '']
  .filter(Boolean).join('\n');

/**
 * Its Stop, while it runs.
 * @param {Tab} tab
 * @param {TaskView} task
 */
const stopHtml = (tab, task) => (task.state === TASK_STATE.running
  ? `<span class="task-stop" ${STOP_ATTR}="${escapeHtml(task.id)}" ${STOP_TAB_ATTR}="${escapeHtml(tab.id)}" title="Stop" role="button"></span>` : '');

/**
 * How long it has run: ticking while it runs (subagents.js ticks every .sub-time[data-since]).
 * @param {TaskView} task
 */
const timeHtml = task => `<span class="sub-time" data-since="${task.state === TASK_STATE.running ? task.startedAt : ''}">${ranFor(task)}</span>`;

/**
 * The rows under a terminal in the sidebar, as subagents have.
 * @param {Tab} tab
 */
export function taskRowsHtml(tab) {
  const tasks = tab.shellTasks ?? [];
  if (!tasks.length || !sidebarShown()) return '';
  /** @param {TaskView} task */
  const row = task => `<div class="sub-row task-row ${escapeHtml(task.state)}" data-tab="${escapeHtml(tab.id)}" title="${escapeHtml(hoverOf(task))}">
      <span class="sub-icon">${ICON[task.state] ?? ''}</span><span class="sub-name"><b>${escapeHtml(nameOf(task))}</b></span>
      ${timeHtml(task)}${stopHtml(tab, task)}</div>`;
  return `<div class="sub-rows task-rows">${tasks.map(row).join('')}</div>`;
}

/**
 * The chip in a terminal's bar while its tasks run (header.js): their count, and a click lists them.
 * @param {Tab} tab
 * @param {HTMLElement} chip
 */
export function showTaskChip(tab, chip) {
  const running = barShown() ? runningTasks(tab) : 0;
  chip.hidden = !running;
  if (running) chip.innerHTML = `<span class="sub-spin"></span>${running} task${running === 1 ? '' : 's'}`;
}

/** The list open from a chip, and its terminal: it follows the tasks while open. */
let open = /** @type {{ el: HTMLElement, tab: Tab } | null} */ (null);

/**
 * The chip's list: each task with its command, its output's last line, Show output and Stop.
 * @param {Tab} tab
 * @param {HTMLElement} anchor
 */
export function openTaskList(tab, anchor) {
  const el = document.createElement('div');
  el.className = 'popover tasks-pop';
  open = { el, tab };
  renderList();
  openPopover(el, anchor, { dynamic: true, onClose: () => { open = null; } });
}

function renderList() {
  if (!open) return;
  const { el, tab } = open;
  const tasks = tab.shellTasks ?? [];
  const running = tasks.filter(t => t.state === TASK_STATE.running);
  const ended = tasks.filter(t => t.state !== TASK_STATE.running);
  /** @param {TaskView} task */
  const item = task => `<div class="task-item ${escapeHtml(task.state)}">
      <span class="sub-icon">${ICON[task.state] ?? ''}</span>
      <div class="task-text"><div class="task-head"><span class="task-name">${escapeHtml(nameOf(task))}</span>${timeHtml(task)}</div>
        ${task.command ? `<div class="task-cmd">${escapeHtml(task.command)}</div>` : ''}
        ${task.lastLine ? `<div class="task-last">${escapeHtml(task.lastLine)}</div>` : ''}</div>
      ${task.outputFile ? `<button class="btn small task-out" ${OUTPUT_ATTR}="${escapeHtml(task.id)}">Show output</button>` : ''}${stopHtml(tab, task)}</div>`;
  el.innerHTML = `<div class="tasks-head">Background tasks<span class="tasks-count">${running.length || ''}</span></div>
    ${running.map(item).join('') || '<div class="tasks-none">None running</div>'}
    ${ended.length ? `<div class="tasks-ended">Finished</div>${ended.map(item).join('')}` : ''}`;
}

/**
 * Stops a running task: its process ends, and its output file then says so.
 * @param {string} tabId
 * @param {string} taskId
 */
const stopTask = (tabId, taskId) => send(PAGE.agentTaskStop, { id: tabId, task: taskId });

// Stop and Show output, in the sidebar's rows and the chip's list: before the row's own click (which focuses the terminal).
document.addEventListener('click', e => {
  const target = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest?.(`[${STOP_ATTR}], [${OUTPUT_ATTR}]`));
  if (!target) return;
  e.stopPropagation();
  e.preventDefault();
  const stop = target.getAttribute(STOP_ATTR);
  if (stop) {
    stopTask(/** @type {string} */ (target.getAttribute(STOP_TAB_ATTR)), stop);
    return;
  }
  const task = open?.tab.shellTasks?.find(t => t.id === target.getAttribute(OUTPUT_ATTR));
  if (open && task?.outputFile) showChange(open.tab, task.outputFile, { wholeFile: true });
}, true);

// The host's list for a terminal, whenever it changes: the last one to end lets a held "done" through. An empty
// list isn't that: its agent or shell went away, and what it had left running ended unseen.
onHost(HOST.agentTasks, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  tab.shellTasks = /** @type {TaskView[]} */ (m.tasks ?? []);
  activityChanged(tab, true);
  if (tab.shellTasks.length && !runningTasks(tab)) tasksEnded(tab);
  if (open?.tab === tab && isOpen(open.el)) renderList();
});

on(EVENTS.tabClosed, tab => { if (tab) tab.shellTasks = []; });
