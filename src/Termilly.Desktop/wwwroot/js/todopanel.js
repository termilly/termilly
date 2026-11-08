// @ts-check
// To do (the title bar's button, or Ctrl+Shift+K): one list at a time, in a panel docked on an edge or in a window of its
// own. A list opens where it was asked for (a terminal's or workspace's mark, their menus), the title bar's button opens
// the one in front, and the name in the panel's header picks another. It stays on its list as terminals change.
// A list's note stays a note, in a text box above its tasks; its right-click menu turns lines of it into tasks. Tasks
// took over from notes, so only a list with a note shows it and its button: emptied, both go, and a new list has neither.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, persist, newId, wsById, tabsOf, tabTitle, EVENTS } from './store.js';
import { focusTab } from './panes.js';
import { AGENT_COMMAND, agentInstalled, agentWorking, folderOfList as folderOf, isOnGitHub, checkRepo, implementTask, keepIssue } from './todoactions.js';
import { implementSilently, stopRun } from './todorun.js';
import { answerAsk, allowWaiting, ASK } from './todoask.js';
import { openTagManager } from './todotags.js';
import { listItems, dotHtml } from './todomenu.js';
import { tagCompletion } from './todotagcomplete.js';
import { escapeHtml, cssColor, tabBadgeHtml, countText, ICONS } from './ui.js';
import { byId, find, targetOf, WORKSPACE_ID, DOCK_GRIP, PANEL_HEAD, TOOL_COUNT } from './dom.js';
import { showMenu, openPopover, closePopover, isOpen, closeAll, SEPARATOR } from './popups.js';
import { showToast, TOAST } from './toasts.js';
import { setNote } from './notes.js';
import { choiceDialog, CHOICE } from './dialogs.js';
import { KEY_ID } from './keymap.js';
import { copyOut, textBoxMenu } from './textmenu.js';
import { COPY_LABEL } from './termclipboard.js';
import { dockPanel, NOTEPAD_DOCK } from './dockpanel.js';
import { TAG_LIST, swatchesHtml } from './tagpicker.js';
import {
  parseTask, takeTags, tasksFromLines, splitNote, tagOfHeading, openCount, tagsIn, withTags, retag, moveBefore, labelsForTags, issueBody, treeRows, found,
  detailLines, subProgress, statusOf, taskMatches, inPlace, TASK_STATUS, STATUS_NAME,
} from './todolist.js';
import {
  LIST_KIND, listOf, noteTarget, sameList, listInFront, openInFront, terminalList, workspaceList, addTasks, updateTask,
  removeTask, moveTask, reorderTasks, todoTags, tagColor, setTagColor, nextTagColor, moveHostTasks, setStatus, findTask,
} from './todo.js';

/** @typedef {import('./todo.js').ListRef} ListRef */

const NAME = 'To do';
/**
 * Each status's mark, on its selector: a ring, half filled while it's worked on, with a dot when it waits for review, ticked
 * when done. Drawn for 16px at a 1px stroke.
 * @type {Readonly<Record<string, string>>}
 */
const STATUS_ICON = Object.freeze({
  [TASK_STATUS.open]: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/></svg>',
  [TASK_STATUS.progress]: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>',
  [TASK_STATUS.review]: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/></svg>',
  [TASK_STATUS.done]: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="none"/><path class="td-tick" d="M5.25 8.25l1.75 1.75 3.75-4"/></svg>',
});
/** In progress's mark while an agent is at work on the task (agentWorking): a faint ring with an arc going round it. */
const WORKING_ICON = '<svg class="td-spinner" viewBox="0 0 16 16"><circle class="td-spin-track" cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/></svg>';
/** A tag picker's colour field. */
const COLOR_INPUT = 'color';
/** A workspace's own list, in the picker. */
/** What the code finds in the panel. */
const TASK = '.td-task';
const TASK_TEXT = '.td-text';
/** What in a task's row does something of its own, so a double click there doesn't open the editor. */
const ROW_CONTROL = 'button, input, .td-acts';
/** A task found in another list, while searching every list. */
const ELSEWHERE = '[data-elsewhere]';
const EDIT_ROW = '.td-edit';
const EDIT_TEXT = '.td-edit-text';
/** A deletion's toast button that brings the tasks back. */
const UNDO = 'Undo';
const ISSUE_TITLE = '.td-issue-title';
const ISSUE_BODY = '.td-issue-body';
const WINDOW_KEY = 'todo';
/** What its controls do (data-td). */
const ACTION = Object.freeze({
  pick: 'pick', note: 'note', pin: 'pin', detach: 'detach', close: 'close', fold: 'fold', tag: 'tag', more: 'more', save: 'save',
  cancel: 'cancel', label: 'label', create: 'create', backToList: 'backToList', pickTags: 'pickTags', dropTag: 'dropTag', manageTags: 'manageTags',
  dropAddTag: 'dropAddTag',
  implement: 'implement', issue: 'issue', openIssue: 'openIssue', status: 'status', agentTerminal: 'agentTerminal', accept: 'accept', reopen: 'reopen',
  edit: 'edit', remove: 'remove', expand: 'expand', stopRun: 'stopRun', scope: 'scope', clearSearch: 'clearSearch', searchToggle: 'searchToggle',
  allow: 'allow', allowAll: 'allowAll', deny: 'deny', filter: 'filter', foldActive: 'foldActive', clearActive: 'clearActive', clearDone: 'clearDone', settings: 'settings',
});
/** How long after the last key a note is saved. */
const NOTE_SAVE_MS = 400;
/** The most a note's box grows to before it scrolls (rows). */
const NOTE_MAX_ROWS = 12;
const NOTE_LINE_PX = 20;
const NOTE_PADDING_PX = 12;
/** Where a task's tags show while it's edited. */
const EDIT_TAGS = '.td-edit-tags';

const panel = document.createElement('aside');
panel.className = 'notepad-panel todo-panel';
panel.hidden = true;
panel.innerHTML = `
  <div class="${DOCK_GRIP}" title="Drag to resize"></div>
  <div class="files-head">
    <span class="title-icon td-icon"></span>
    <span class="files-title">${NAME}</span>
    <button class="td-pick" data-td="${ACTION.pick}" title="Pick a list"><span class="td-pick-icon"></span><span class="td-pick-name"></span><span class="td-pick-sub"></span>${ICONS.chevronDown}</button>
    <span class="files-tools">
      <button class="pane-btn td-note-btn" data-td="${ACTION.note}" title="Show or hide this list’s note" hidden>${ICONS.note}</button>
      <button class="pane-btn" data-td="${ACTION.manageTags}" title="Manage tags">${ICONS.tag}</button>
      <button class="pane-btn" data-td="${ACTION.settings}" title="To do settings" aria-haspopup="menu">${ICONS.settings}</button>
      <span class="np-sep"></span>
      <button class="pane-btn" data-td="${ACTION.detach}" title="Detach to a window">${ICONS.detach}</button>
      <button class="pane-btn" data-td="${ACTION.close}" title="Close (Ctrl+Shift+K)">${ICONS.close}</button>
    </span>
  </div>
  <div class="td-view">
    <div class="td-note" hidden>
      <textarea class="td-note-text" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" placeholder="A note for this list"></textarea>
      <button class="pane-btn td-pin" data-td="${ACTION.pin}" title="Pin the first line to the terminal’s header">${ICONS.pin}</button>
    </div>
    <div class="td-addbar">
      <input class="field td-add" spellcheck="false" autocomplete="off" title="A word typed as #tag or :tag: tags the task">
      <button type="button" class="pane-btn td-search-btn" data-td="${ACTION.searchToggle}" title="Search tasks (Ctrl+F)" aria-label="Search tasks" aria-expanded="false">${ICONS.search}</button>
      <button type="button" class="pane-btn td-search-btn td-filter-btn" data-td="${ACTION.filter}" title="Filter by tag" aria-label="Filter by tag" aria-haspopup="listbox">${ICONS.filter}<span class="td-filter-count" hidden></span></button>
    </div>
    <div class="td-add-tags" hidden></div>
    <div class="td-search" hidden>
      <input class="td-search-text" spellcheck="false" autocomplete="off" placeholder="Search tasks" aria-label="Search tasks">
      <button type="button" class="td-search-clear" data-td="${ACTION.clearSearch}" title="Clear the search" aria-label="Clear the search" hidden>${ICONS.close}</button>
      <button type="button" class="td-scope" data-td="${ACTION.scope}" title="Search every list, not only this one">All lists</button>
    </div>
    <div class="td-list"></div>
  </div>
  <form class="td-issue" hidden></form>`;
byId(WORKSPACE_ID).append(panel);

const button = byId('todo-button');
const countEl = find(button, TOOL_COUNT);
find(panel, '.td-icon').innerHTML = /** @type {Element} */ (button.firstElementChild).outerHTML;
const head = find(panel, PANEL_HEAD);
const pickIcon = find(panel, '.td-pick-icon');
const pickName = find(panel, '.td-pick-name');
const pickSub = find(panel, '.td-pick-sub');
const view = find(panel, '.td-view');
const noteButton = find(panel, '.td-note-btn');
const noteBox = find(panel, '.td-note');
const noteArea = /** @type {HTMLTextAreaElement} */ (find(panel, '.td-note-text'));
const pinButton = find(panel, '.td-pin');
const addField = /** @type {HTMLInputElement} */ (find(panel, '.td-add'));
const addTagsEl = find(panel, '.td-add-tags');
const filterButton = find(panel, '.td-filter-btn');
const filterCount = find(panel, '.td-filter-count');
const listEl = find(panel, '.td-list');
const issueForm = /** @type {HTMLFormElement} */ (find(panel, '.td-issue'));
const searchField = /** @type {HTMLInputElement} */ (find(panel, '.td-search-text'));
const searchClear = find(panel, '.td-search-clear');
const scopeButton = find(panel, '.td-scope');
const searchBox = find(panel, '.td-search');
const searchButton = find(panel, '.td-search-btn');

/** The list it shows. */
/** @type {ListRef | null} */
let current = null;
/** The tag chips picked, for the list shown. */
/** @type {string[]} */
let picked = [];
/** Whether the caret is in the note's box (it stays until the caret leaves, even emptied), and whether it's hidden though the list has a note. */
let writingNote = false;
let hidingNote = false;
/** The task being edited, in its row, and its tags so far. */
/** @type {string | null} */
let editing = null;
/** @type {string[]} */
let editTags = [];
/** The task (or its sub-item, by line) an issue is being made from, and what the host said about its repository. */
/** @type {{ taskId: string, line?: number, title: string, body: string, requestId: string, repo?: string, labels: string[], ticked: string[], error?: string, busy?: boolean, folder: string | null } | null} */
let issue = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let noteTimer = null;
/** What's searched for, whether the search drops down under its icon (it does while there's a search: putting it away empties
 * it), and the tasks done while the list was shown: they stay where they were until it's shown again. */
let query = '';
let searching = false;
/** @type {Set<string>} */
let settled = new Set();

/** The tasks opened out in their rows (all their details, steps and what the agent said), by id. */
/** @type {Set<string>} */
const expanded = new Set();

const shown = () => listOf(current);

// ---- Drawing ----

/**
 * What gives a tag's chip its colour.
 * @param {string} tag
 */
const chipStyle = tag => `style="--td-hue:${cssColor(tagColor(tag))}"`;

/** @param {string} tag @param {boolean} [on] */
const chip = (tag, on = false) => `<button type="button" class="td-chip${on ? ' on' : ''}" ${chipStyle(tag)} data-td="${ACTION.tag}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;

/**
 * A task's status selector: its mark, which opens the statuses to pick from. It spins while an agent is at work on it.
 * @param {TodoTask} task
 */
function statusButtonHtml(task) {
  const status = statusOf(task);
  const working = agentWorking(task);
  const name = working ? `${STATUS_NAME[status]}: ${AGENT_COMMAND} is working on it` : STATUS_NAME[status];
  return `<button type="button" class="td-status st-${status}${working ? ' working' : ''}" data-td="${ACTION.status}" title="${name}. Click to change" aria-label="Status: ${name}">${working ? WORKING_ICON : STATUS_ICON[status]}</button>`;
}

/**
 * Starts or stops the spinners of the tasks shown, when an agent starts or stops working (in a terminal, its hooks say
 * so without a change to the task): only the marks that changed are drawn again, so a hover or a field typed in stays.
 */
function showWorking() {
  if (panel.hidden) return;
  for (const row of listEl.querySelectorAll(TASK)) {
    const mark = row.querySelector(`[data-td="${ACTION.status}"]`);
    const task = findTask(/** @type {HTMLElement} */ (row).dataset.task ?? '')?.task;
    if (!mark || !task || mark.classList.contains('working') === agentWorking(task)) continue;
    mark.outerHTML = statusButtonHtml(task);
  }
}

/**
 * The line under a task's text: its status while it's worked on or waits, who works on it, its steps, tags and issue.
 * @param {TodoTask} task
 */
function metaHtml(task) {
  const [doneSubs, subs] = subProgress(task.details);
  const status = statusOf(task);
  const parts = [
    status === TASK_STATUS.progress || status === TASK_STATUS.review ? `<span class="td-st-name st-${status}">${STATUS_NAME[status]}</span>` : '',
    agentHtml(task),
    subs ? `<span class="td-progress" title="Steps done">${doneSubs}/${subs}</span>` : '',
    ...(task.tags ?? []).map(t => chip(t, picked.includes(t))),
    issueChip(task.issue),
  ].filter(Boolean);
  return parts.length ? `<div class="td-meta">${parts.join('')}</div>` : '';
}

/**
 * A task's row: its status, its text with the line under it, the buttons that show on hover, and Review's choices.
 * @param {TodoTask} task
 * @param {string} [elsewhere] the list it's in, when searching every list finds it in another
 */
function rowHtml(task, elsewhere) {
  if (task.id === editing) return editorHtml(task);
  const there = elsewhere ? ` data-elsewhere title="In ${escapeHtml(elsewhere)}. Click to open it there"` : ' draggable="true"';
  return `<div class="td-task st-${statusOf(task)}${task.done ? ' done' : ''}" data-task="${escapeHtml(task.id)}" tabindex="0"${there}>
    ${statusButtonHtml(task)}
    <div class="td-body"><div class="td-text">${escapeHtml(task.text)}</div>${elsewhere ? '' : aboutHtml(task)}${elsewhere ? `<div class="td-meta"><span class="td-where">${escapeHtml(elsewhere)}</span></div>` : metaHtml(task)}</div>
    ${elsewhere ? '' : actsHtml(task.issue, false)}
    ${elsewhere ? '' : reviewHtml(task)}
    ${elsewhere ? '' : askHtml(task)}
  </div>`;
}

/**
 * Who's working on a task: an agent in a terminal, leading to it, or one out of sight, with Stop.
 * @param {TodoTask} task
 */
function agentHtml(task) {
  if (task.run && statusOf(task) === TASK_STATUS.progress) {
    return `<span class="td-agent td-hidden-run">${AGENT_COMMAND}, silently<button type="button" class="td-stop" data-td="${ACTION.stopRun}" title="Stop it: the task goes back to Open">Stop</button></span>`;
  }
  const tab = task.terminal ? state.tabs.get(task.terminal) : null;
  return tab ? `<button type="button" class="td-agent" data-td="${ACTION.agentTerminal}" data-tab="${escapeHtml(tab.id)}" title="Go to its terminal">${AGENT_COMMAND} in ${escapeHtml(tabTitle(tab))}</button>` : '';
}

/**
 * What its run out of sight asks for, waiting on the user: Deny, Allow all (this and the rest of the run), or Allow.
 * @param {TodoTask} task
 */
function askHtml(task) {
  if (!task.ask || statusOf(task) !== TASK_STATUS.progress) return '';
  return `<div class="td-ask">
    <div class="td-ask-text">${AGENT_COMMAND} ${escapeHtml(task.ask.verb)} <code>${escapeHtml(task.ask.what)}</code></div>
    <span class="td-edit-actions"><button type="button" class="btn small" data-td="${ACTION.deny}" title="It goes on without it">Deny</button><button type="button" class="btn small" data-td="${ACTION.allowAll}" title="This, and anything else it asks for until it finishes">Allow all</button><button type="button" class="btn small primary" data-td="${ACTION.allow}">Allow</button></span>
  </div>`;
}

/** The two ways on from Review (what the agent said is in the task's details, aboutHtml). @param {TodoTask} task */
function reviewHtml(task) {
  if (statusOf(task) !== TASK_STATUS.review) return '';
  return `<div class="td-review"><span class="td-edit-actions"><button type="button" class="btn small" data-td="${ACTION.reopen}">Back to open</button><button type="button" class="btn small primary" data-td="${ACTION.accept}">Accept</button></span></div>`;
}

/**
 * Under a task's text, when it has a description or the agent said something: the first line of it (cut short to fit),
 * and the button that opens it out to all of its description, its steps, and what the agent said (its implementation's
 * result).
 * @param {TodoTask} task
 */
function aboutHtml(task) {
  const lines = detailLines(task.details);
  const notes = lines.filter(line => !line.sub).map(line => line.text).join('\n').trim();
  const steps = lines.filter(line => line.sub);
  const said = task.review ? `<b>${escapeHtml(task.review.by)}:</b> ${escapeHtml(task.review.summary.trim())}` : '';
  const first = notes.split('\n')[0] || steps[0]?.text || '';
  const firstHtml = first ? escapeHtml(first) : said.split('\n')[0];
  if (!firstHtml) return '';
  const open = expanded.has(task.id);
  const toggle = `<button type="button" class="td-expand" data-td="${ACTION.expand}" aria-expanded="${open}" title="${open ? 'Show less' : 'Show all of it'}">${open ? ICONS.chevronDown : ICONS.chevronRight}</button>`;
  if (!open) return `<div class="td-about">${toggle}<span class="td-about-line">${firstHtml}</span></div>`;
  return `<div class="td-about open">${toggle}<div class="td-about-all">
    ${notes ? `<div class="td-details">${escapeHtml(notes)}</div>` : ''}
    ${steps.map(stepHtml).join('')}
    ${said ? `<div class="td-result">${said}</div>` : ''}
  </div></div>`;
}

/** @param {{ url: string, number: number } | undefined} issue */
const issueChip = issue => (issue ? `<button type="button" class="td-gh" data-td="${ACTION.openIssue}" data-url="${escapeHtml(issue.url)}" title="Open issue #${issue.number} on GitHub">#${issue.number}</button>` : '');

/** The tick of a step done, and the ring of one to do, in a task opened out. */
const STEP_MARK = Object.freeze({
  done: '<svg viewBox="0 0 16 16"><path d="M4 8.5l2.5 2.5 5.5-6"/></svg>',
  open: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5"/></svg>',
});

/**
 * A step in a task opened out: done or not (ticked by an agent, or in Edit), its text, and Implement and Create GitHub issue for it.
 * @param {import('./todolist.js').DetailLine} line
 */
function stepHtml(line) {
  return `<div class="td-step${line.done ? ' done' : ''}" data-sub="${line.at}">
    <span class="td-step-mark">${line.done ? STEP_MARK.done : STEP_MARK.open}</span>
    <span class="td-step-text">${escapeHtml(line.text)}${issueChip(line.issue)}</span>${actsHtml(line.issue, true)}
  </div>`;
}

/**
 * A task's buttons: Implement when Claude Code is installed, Edit, Create GitHub issue when the folder's repository is on
 * GitHub and there's no issue yet, and Delete. A step has Implement and Create GitHub issue only.
 * @param {{ url: string, number: number } | undefined} issue
 * @param {boolean} isStep
 */
function actsHtml(issue, isStep) {
  const folder = folderOfList();
  const canIssue = !issue && !!folder && isOnGitHub(folder);
  return `<span class="td-acts">
    ${agentInstalled() ? `<button type="button" class="pane-btn" data-td="${ACTION.implement}" ${folder ? '' : 'disabled'} title="${folder ? 'Implement: Claude Code works on it, in a new terminal or silently' : 'Implement needs a folder on this computer'}">${ICONS.play}</button>` : ''}
    ${isStep ? '' : `<button type="button" class="pane-btn" data-td="${ACTION.edit}" title="Edit">${ICONS.rename}</button>`}
    ${canIssue ? `<button type="button" class="pane-btn" data-td="${ACTION.issue}" title="Create GitHub issue">${ICONS.git}</button>` : ''}
    ${isStep ? '' : `<button type="button" class="pane-btn" data-td="${ACTION.remove}" title="Delete">${ICONS.trash}</button>`}
  </span>`;
}

/** @param {TodoTask} task */
function editorHtml(task) {
  return `<div class="td-edit" data-task="${escapeHtml(task.id)}">
    <input class="field td-edit-text" value="${escapeHtml(task.text)}" spellcheck="false" autocomplete="off" aria-label="Task">
    <textarea class="field td-edit-details" rows="3" spellcheck="false" placeholder="Details. A line starting [ ] is a step, [x] a step done" aria-label="Details">${escapeHtml(task.details ?? '')}</textarea>
    <div class="td-edit-tags">${editTagsHtml()}</div>
    <span class="td-edit-actions"><button type="button" class="btn small" data-td="${ACTION.cancel}">Cancel</button><button type="button" class="btn small primary" data-td="${ACTION.save}">Save</button></span>
  </div>`;
}

/** The tags of the task being edited, each with its × and the button that adds more. */
function editTagsHtml() {
  const tags = editTags.map(tag => `<span class="td-chip" ${chipStyle(tag)} data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}<button type="button" class="td-chip-drop" data-td="${ACTION.dropTag}" data-tag="${escapeHtml(tag)}" title="Remove" aria-label="Remove ${escapeHtml(tag)}">${ICONS.close}</button></span>`);
  return `${tags.join('')}<button type="button" class="td-add-tag" data-td="${ACTION.pickTags}">${ICONS.plus}Tag</button>`;
}

/** Every list there is with the tasks the search finds in it, those with none left out. */
function allListsFound() {
  return state.workspaces.flatMap(ws => [workspaceList(ws), ...tabsOf(ws).filter(t => !t.virtual).map(terminalList)])
    .flatMap(ref => listOf(ref) ?? [])
    .map(list => ({ ...list, tasks: list.tasks.filter(task => taskMatches(task, query)) }))
    .filter(list => list.tasks.length);
}

/**
 * What a search finds in the other lists, under each list's name, when it's searching every list.
 * @param {TodoList} list the one shown
 */
function elsewhereHtml(list) {
  if (!query || !state.todo.searchAll) return '';
  const others = allListsFound().filter(other => !sameList(other.ref, list.ref));
  return others.map(other => `<div class="td-group">${escapeHtml(other.name)}<span class="td-fold-count">${other.tasks.length}</span></div>${other.tasks.map(t => rowHtml(t, other.name)).join('')}`).join('');
}

/**
 * A list's tasks in their own order, whatever their status. Done ones are in Done at the end, folded, except those done
 * while it's shown. A search shows what it finds, done or not, and in the other lists too when it's searching every list.
 * @param {TodoList} list
 */
function listHtml(list) {
  const tasks = withTags(list.tasks, picked);
  if (query) {
    const hits = tasks.filter(task => taskMatches(task, query));
    const here = hits.length ? hits.map(t => rowHtml(t)).join('') : `<p class="td-empty">Nothing found${state.todo.searchAll ? '' : ' in this list'}.</p>`;
    return `${here}${elsewhereHtml(list)}`;
  }
  const { main, done } = inPlace(tasks, settled);
  const empty = !list.tasks.length ? `<p class="td-empty">${list.note ? 'No tasks. Right-click the note to turn its lines into tasks.' : 'Nothing here yet.'}</p>` : '';
  const showActive = !state.todo.hideActive;
  // Active counts those not done; one done while the list is shown stays in it, ticked, until it's shown again.
  const active = main.length ? foldHtml('Active', main.filter(task => !task.done).length, showActive, ACTION.foldActive, ACTION.clearActive, 'Clear active tasks') : '';
  const fold = done.length ? foldHtml(STATUS_NAME[TASK_STATUS.done], done.length, !!state.todo.showDone, ACTION.fold, ACTION.clearDone, 'Clear done tasks') : '';
  return `${empty}${active}${showActive ? main.map(t => rowHtml(t)).join('') : ''}${fold}${state.todo.showDone ? done.map(t => rowHtml(t)).join('') : ''}`;
}

/**
 * A group's header (Active, Done): its fold, how many it has, and its clear button at the end on hover.
 * @param {string} name @param {number} count @param {boolean} open @param {string} fold @param {string} clear @param {string} clearLabel
 */
function foldHtml(name, count, open, fold, clear, clearLabel) {
  return `<div class="td-fold-row">
    <button class="td-fold" data-td="${fold}" aria-expanded="${open}">${open ? ICONS.chevronDown : ICONS.chevronRight}${name}<span class="td-fold-count">${count}</span></button>
    <button type="button" class="pane-btn td-fold-clear" data-td="${clear}" title="${clearLabel}" aria-label="${clearLabel}"${count ? '' : ' disabled'}>${ICONS.trash}</button>
  </div>`;
}

/** @typedef {import('./todo.js').TodoList} TodoList */

/** The note's box as tall as its text, up to a limit. */
function fitNote() {
  noteArea.style.height = 'auto';
  noteArea.style.height = `${Math.min(noteArea.scrollHeight, NOTE_MAX_ROWS * NOTE_LINE_PX + NOTE_PADDING_PX)}px`;
}

/** @param {TodoList} list */
function renderNote(list) {
  noteButton.hidden = !list.note;
  noteBox.hidden = hidingNote || (!list.note && !writingNote);
  pinButton.setAttribute('aria-pressed', String(list.pinned));
  // The text being typed stays as it is: a save comes back here.
  if (noteArea.ownerDocument.activeElement !== noteArea) noteArea.value = list.note;
  if (!noteBox.hidden) fitNote();
}

/**
 * What the picker's button says: the list, with its icon, and the workspace a terminal or host is in.
 * @param {TodoList} list
 */
function showPick(list) {
  const tab = list.ref.kind === LIST_KIND.terminal ? state.tabs.get(list.ref.id) : null;
  const ws = list.ref.kind === LIST_KIND.workspace ? wsById(list.ref.id) : null;
  pickName.textContent = list.name;
  pickSub.textContent = tab ? wsById(tab.wsId)?.name ?? '' : '';
  pickIcon.innerHTML = ws ? dotHtml(ws.color) : tab ? tabBadgeHtml(tab) : '';
}

/** @param {string} color */

/** Draws the list shown; the first list in front when what it was on has gone. */
function render() {
  if (!shown()) {
    current = listInFront();
    picked = [];
  }
  const list = shown();
  const folder = folderOfList();
  if (folder) checkRepo(folder);
  view.hidden = !!issue;
  issueForm.hidden = !issue;
  if (!list) {
    pickName.textContent = '';
    pickSub.textContent = '';
    pickIcon.innerHTML = '';
    listEl.innerHTML = '';
    noteButton.hidden = true;
    return;
  }
  showPick(list);
  addField.placeholder = `Add a task to ${list.name}`;
  renderNote(list);
  const tags = tagsIn(list.tasks);
  picked = picked.filter(t => tags.some(([tag]) => tag === t));
  showFilter();
  listEl.innerHTML = listHtml(list);
  showSearch();
  find(panel, `[data-td="${ACTION.pick}"]`).title = `Pick a list. This one has ${openCount(list.tasks)} open`;
  if (issue) renderIssue(list);
}

/** The search as it is: dropped down or not, its clear button while there's something in it, and whether it's searching every list. */
function showSearch() {
  if (searchField.value !== query && searchField.ownerDocument.activeElement !== searchField) searchField.value = query;
  searchBox.hidden = !searching;
  searchButton.classList.toggle('open', searching);
  searchButton.setAttribute('aria-expanded', String(searching));
  searchClear.hidden = !query;
  scopeButton.setAttribute('aria-pressed', String(!!state.todo.searchAll));
}

/** @param {string} text */
function search(text) {
  query = text.trim();
  render();
}

/** The search drops down under its icon, with the caret in it. */
function openSearch() {
  searching = true;
  showSearch();
  searchField.focus();
  searchField.select();
}

/**
 * The search goes back into its icon, emptied, so no list is ever narrowed by a search out of sight.
 * @param {boolean} [refocus] the caret goes to the icon
 */
function closeSearch(refocus) {
  searching = false;
  searchField.value = '';
  if (refocus) searchButton.focus();
  // Nothing was searched for: the list is as it was, and isn't drawn again under a click on it.
  if (query) search('');
  else showSearch();
}

// ---- Filtering by tag ----

/** A tag, or Show every task, in the filter's list. */
const FILTER_ROW = '.tp-row';
/** The filter's list of tags while it's open. */
/** @type {HTMLElement | null} */
let filterPopover = null;

/** The filter's icon as it is: marked, with how many tags are picked, while it narrows the list. */
function showFilter() {
  filterButton.classList.toggle('on', picked.length > 0);
  filterCount.hidden = !picked.length;
  filterCount.textContent = String(picked.length);
  filterButton.title = picked.length ? `Showing tasks tagged ${picked.join(', ')}. Click to change` : 'Filter by tag';
  if (filterPopover && isOpen(filterPopover)) drawFilter(filterPopover);
}

/**
 * The filter's list: the tags of this list's open tasks, ticked when picked, with how many tasks have each; and the way
 * back to every task while some are picked.
 * @param {HTMLElement} popover
 */
function drawFilter(popover) {
  const body = find(popover, TAG_LIST);
  const tags = tagsIn(shown()?.tasks ?? []);
  const rows = tags.map(([tag, count]) => `<button type="button" class="tp-row" data-tag="${escapeHtml(tag)}" role="option" aria-selected="${picked.includes(tag)}">
      <span class="check${picked.includes(tag) ? ' on' : ''}"><svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg></span>
      <span class="td-chip" ${chipStyle(tag)}>${escapeHtml(tag)}</span><span class="tp-count">${count}</span>
    </button>`);
  const clear = picked.length ? `<div class="tp-sep"></div><button type="button" class="tp-row" data-clear><span class="menu-icon">${ICONS.close}</span>Show every task</button>` : '';
  body.innerHTML = rows.join('') + clear || '<div class="tp-empty">No open task in this list has a tag</div>';
}

/**
 * Picks a tag to show only the tasks that have it, or drops it; no tag at all shows every task again.
 * @param {string | undefined} tag
 */
function filterBy(tag) {
  if (tag === undefined) picked = [];
  else picked = picked.includes(tag) ? picked.filter(t => t !== tag) : [...picked, tag];
  render();
}

/**
 * The filter's tags, under its icon (clicked again, it closes). Arrow keys move, Enter or Space ticks.
 * @param {HTMLElement} at
 */
function openFilter(at) {
  if (filterPopover && isOpen(filterPopover)) return void closePopover(filterPopover);
  const popover = at.ownerDocument.createElement('div');
  popover.className = 'popover tag-picker td-filter';
  popover.hidden = true;
  popover.innerHTML = '<div class="tp-list" role="listbox" aria-label="Filter by tag"></div>';
  const body = find(popover, TAG_LIST);
  body.addEventListener('click', e => {
    const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tag], [data-clear]'));
    if (!row) return;
    const tag = row.dataset.tag;
    filterBy(tag);
    const again = tag === undefined ? null : body.querySelector(`[data-tag="${CSS.escape(tag)}"]`);
    /** @type {HTMLElement | null} */ (again ?? body.querySelector(FILTER_ROW))?.focus();
  });
  body.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = /** @type {HTMLElement[]} */ ([...body.querySelectorAll(FILTER_ROW)]);
    const now = rows.indexOf(/** @type {HTMLElement} */ (targetOf(e)));
    const next = now < 0 ? 0 : (now + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
    rows[next]?.focus();
  });
  filterPopover = popover;
  drawFilter(popover);
  openPopover(popover, at, { dynamic: true, refocus: () => filterButton.focus(), onClose: () => { filterPopover = null; } });
  /** @type {HTMLElement | null} */ (body.querySelector(FILTER_ROW))?.focus();
}

/** The title bar button's count: open tasks where you're working, while the panel is closed. */
function showCount() {
  const count = openInFront();
  countEl.hidden = !panel.hidden || !count;
  countEl.textContent = countText(count);
  button.title = `To do (Ctrl+Shift+K)${count ? `: ${count} open` : ''}`;
}

// ---- Opening and closing ----

/** @param {{ quiet?: boolean, here?: boolean }} [options] */
function show({ quiet = false, here = false } = {}) {
  settled = new Set();
  const reopens = dock.reopensWindowed(here);
  dock.setOpen(true);
  render();
  if (reopens) return dock.reopenWindow();
  if (!quiet) addField.focus();
}

/** Its handle in a window of its own on Linux: its title, dragged back into the main window (js/panes.js). */
const HANDLE = '.files-title';

const dock = dockPanel({
  panel, head, key: WINDOW_KEY, name: NAME, icon: /** @type {Element} */ (button.firstElementChild).outerHTML, handle: HANDLE,
  dockVar: '--todo-dock', inside: NOTEPAD_DOCK, stored: () => state.todo, button, showCount, show, render, focus: () => addField.focus(),
});

/**
 * Shows a list.
 * @param {ListRef} ref
 */
function openList(ref) {
  saveNoteNow();
  if (!current || !sameList(current, ref)) {
    picked = [];
    writingNote = false;
    hidingNote = false;
    editing = null;
    issue = null;
    settled = new Set();
  }
  current = ref;
  state.todo.list = ref;
  persist();
  if (panel.hidden) show();
  else {
    render();
    if (dock.isDetached()) dock.toggle();
  }
}

/** To do on or off (its button, its keys, the palette): opened, it's on the list in front. */
export function toggleTodo() {
  if (panel.hidden) {
    const front = listInFront();
    if (front) current = front;
  }
  dock.toggle();
}

/** Shows To do as it was left (main.js, once the saved state is in). */
export function initTodo() {
  moveHostTasks();
  current = state.todo.list ?? null;
  dock.restorePlace();
  showCount();
  if (state.todo.open) show({ quiet: true });
}

// ---- The note ----

function saveNoteNow() {
  if (noteTimer === null) return;
  clearTimeout(noteTimer);
  noteTimer = null;
  const list = shown();
  if (list) writeNote(list, noteArea.value);
}

/** @param {TodoList} list @param {string} text */
function writeNote(list, text) {
  setNote(list.ref.kind, noteTarget(list.ref), text.trim(), list.pinned);
}

/** Turns the selected lines of the note, or all of it, into tasks, and takes them out of the note. */
function noteToTasks() {
  const list = shown();
  if (!list) return;
  const { tasks, rest } = splitNote(noteArea.value, noteArea.selectionStart, noteArea.selectionEnd);
  if (!tasks.length) return void showToast({ text: 'No text to turn into tasks here', state: TOAST.failed });
  if (noteTimer !== null) clearTimeout(noteTimer);
  noteTimer = null;
  noteArea.value = rest;
  writeNote(list, rest);
  addTasks(list.ref, tasks);
  showToast({ text: `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} added`, state: TOAST.done });
}

/** @param {MouseEvent} e */
function noteMenu(e) {
  const selected = noteArea.selectionStart !== noteArea.selectionEnd;
  textBoxMenu(e, noteArea, NAME, [
    {
      label: selected ? 'Turn selection into tasks' : 'Turn note into tasks', icon: ICONS.todo, disabled: !noteArea.value.trim(),
      title: 'Each list line is a task; a paragraph is one task with details; a heading tags what’s under it. The lines leave the note.',
      action: noteToTasks,
    },
  ]);
}

// ---- Picking a list ----

/** The workspaces in the tree, each with its terminals. */
function treeGroups() {
  return state.workspaces.map(ws => ({
    list: /** @type {TodoList} */ (listOf(workspaceList(ws))), color: ws.color,
    terms: tabsOf(ws).filter(t => !t.virtual).map(t => ({ list: /** @type {TodoList} */ (listOf(terminalList(t))), badge: tabBadgeHtml(t) })),
  }));
}

/** Workspaces folded or opened by hand; the others start open only when they hold the list shown or are in front. */
/** @type {Map<string, boolean>} */
const foldedByHand = new Map();

/** @param {import('./todolist.js').TreeGroup} group */
function isOpenInTree(group) {
  const hand = foldedByHand.get(group.list.ref.id);
  if (hand !== undefined) return hand;
  const shownNow = current;
  const holdsShown = !!shownNow && (sameList(group.list.ref, shownNow) || group.terms.some(t => sameList(t.list.ref, shownNow)));
  return holdsShown || group.list.ref.id === state.activeId;
}

/** @param {import('./todolist.js').TreeRow} row @param {number} at */
function treeRowHtml(row, at) {
  const { ref, name, note, tasks } = row.list;
  const icon = row.depth === 0 ? dotHtml(row.color ?? '') : row.badge ?? '';
  const on = current && sameList(ref, current) ? ' on' : '';
  const empty = note || openCount(tasks) || row.depth === 0 ? '' : ' dim';
  const fold = row.foldable ? `<span class="td-fold-mark" data-fold="${escapeHtml(ref.id)}">${row.open ? ICONS.chevronDown : ICONS.chevronRight}</span>` : row.depth === 0 ? '<span class="td-fold-mark"></span>' : '';
  return `<button class="td-tree-row depth${row.depth}${on}${empty}" data-row="${at}" role="option" aria-selected="${!!on}">${fold}${icon}<span class="td-tree-name">${escapeHtml(name)}</span>${row.count ? `<span class="tp-count">${row.count}</span>` : ''}</button>`;
}

/**
 * The picker while it's open: its search box and list, the rows shown and the one Enter opens.
 * @typedef {{ input: HTMLInputElement, body: HTMLElement, rows: import('./todolist.js').TreeRow[], active: number }} TreeView
 */

/** @param {TreeView} tree */
function markTree(tree) {
  for (const [i, row] of [...tree.body.children].entries()) row.classList.toggle('active', i === tree.active);
  tree.body.children[tree.active]?.scrollIntoView({ block: 'nearest' });
}

/** @param {TreeView} tree */
function drawTree(tree) {
  tree.rows = treeRows(treeGroups(), {
    query: tree.input.value, only: !!state.todo.onlyWithTasks, isOpen: isOpenInTree, isCurrent: list => !!current && sameList(list.ref, current),
  });
  // Typing, Enter opens the first list that was itself found, not one only shown as the way to it.
  const query = tree.input.value.trim().toLowerCase();
  tree.active = tree.rows.findIndex(r => (query ? found(r.list, query) : !!current && sameList(r.list.ref, current)));
  tree.body.innerHTML = tree.rows.map(treeRowHtml).join('') || '<div class="tp-empty">Nothing found</div>';
  markTree(tree);
}

/**
 * @param {TreeView} tree
 * @param {number} at
 */
function chooseRow(tree, at) {
  const row = tree.rows[at];
  if (!row) return;
  closeAll();
  openList(row.list.ref);
}

/** @param {TreeView} tree */
function wireTree(tree) {
  const { input, body } = tree;
  input.addEventListener('input', () => drawTree(tree));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') chooseRow(tree, tree.active < 0 ? 0 : tree.active);
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && tree.rows.length) {
      tree.active = (tree.active + (e.key === 'ArrowDown' ? 1 : tree.rows.length - 1)) % tree.rows.length;
      markTree(tree);
    } else return;
    e.preventDefault();
  });
  body.addEventListener('mousedown', e => e.preventDefault());
  body.addEventListener('click', e => {
    const fold = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-fold]'));
    if (fold) {
      const group = treeGroups().find(g => g.list.ref.id === fold.dataset.fold);
      if (group) foldedByHand.set(group.list.ref.id, !isOpenInTree(group));
      return drawTree(tree);
    }
    const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-row]'));
    if (row) chooseRow(tree, Number(row.dataset.row));
  });
}

/**
 * The picker: a search box over a tree shaped like the sidebar. Arrow keys and Enter work from the search box.
 * @param {HTMLElement} at
 */
function openTree(at) {
  const picker = at.ownerDocument.createElement('div');
  picker.className = 'popover td-tree';
  picker.hidden = true;
  picker.innerHTML = `<input class="field" placeholder="Find a list or task" spellcheck="false" aria-label="Find a list or task"><div class="tp-list" role="listbox"></div><label class="td-only"><input type="checkbox" ${state.todo.onlyWithTasks ? 'checked' : ''}> Only with tasks</label>`;
  /** @type {TreeView} */
  const tree = { input: /** @type {HTMLInputElement} */ (find(picker, 'input')), body: find(picker, TAG_LIST), rows: [], active: -1 };
  wireTree(tree);
  find(picker, '.td-only input').addEventListener('change', e => {
    state.todo.onlyWithTasks = /** @type {HTMLInputElement} */ (e.target).checked;
    persist();
    drawTree(tree);
    tree.input.focus();
  });
  drawTree(tree);
  openPopover(picker, at, { dynamic: true, refocus: () => addField.focus() });
  tree.input.focus();
}


/** @param {HTMLElement} at */
function pickList(at) {
  openTree(at);
}

// ---- A task ----

/** @param {string} id */
const taskById = id => shown()?.tasks.find(t => t.id === id) ?? null;

function saveEdit() {
  const row = listEl.querySelector(EDIT_ROW);
  const list = shown();
  if (!row || !list || !editing) return;
  const text = /** @type {HTMLInputElement} */ (find(row, EDIT_TEXT)).value.trim();
  if (!text) return;
  const details = /** @type {HTMLTextAreaElement} */ (find(row, '.td-edit-details')).value.trim();
  const id = editing;
  editing = null;
  updateTask(list.ref, id, { text, details: details || undefined, tags: editTags.length ? [...editTags] : undefined });
}

/** @param {string} id */
function beginEdit(id) {
  editing = id;
  editTags = [...(taskById(id)?.tags ?? [])];
  render();
  /** @type {HTMLInputElement | null} */ (listEl.querySelector(EDIT_TEXT))?.focus();
}

/** Draws the edited task's tags again; the rest of its form stays as typed. */
function showEditTags() {
  const tags = panel.querySelector(EDIT_TAGS);
  if (tags) tags.innerHTML = editTagsHtml();
}

/**
 * The tag picker while it's open: the colour a new tag gets, and the existing tag whose colours show.
 * @typedef {{ color: string, recolor: string | null }} TagPick
 */

/**
 * The list a task's tags are picked from: To do's tags, ticked when the task has them, each with its colour, and a new
 * one from what's typed.
 * @param {string} query
 * @param {TagPick} pick
 */
function tagRowsHtml(query, pick) {
  const known = todoTags().map(([tag, count]) => /** @type {[string, number]} */ ([tag, count]));
  for (const tag of editTags) if (!known.some(([name]) => name === tag)) known.push([tag, 0]);
  const rows = known.filter(([tag]) => tag.includes(query)).map(([tag, count]) => `
    <button class="tp-row" data-tag="${escapeHtml(tag)}" role="option" aria-selected="${editTags.includes(tag)}">
      <span class="check${editTags.includes(tag) ? ' on' : ''}"><svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg></span>
      <span class="td-chip" ${chipStyle(tag)}>${escapeHtml(tag)}</span><span class="tp-count">${count || ''}</span>
      <span class="td-tag-color" data-recolor="${escapeHtml(tag)}" style="background:${cssColor(tagColor(tag))}" title="Change the colour"></span>
    </button>${pick.recolor === tag ? swatchesHtml(tagColor(tag)) : ''}`);
  if (query && !known.some(([tag]) => tag === query)) {
    rows.push(`<button class="tp-row tp-create" data-tag="${escapeHtml(query)}" data-new><span class="menu-icon">${ICONS.plus}</span>Create<span class="td-chip" style="--td-hue:${cssColor(pick.color)}">${escapeHtml(query)}</span></button>${swatchesHtml(pick.color)}`);
  }
  return rows.join('') || '<div class="tp-empty">Type a name to create a tag</div>';
}

/**
 * Picks a colour: the existing tag's whose colours show, everywhere it's shown now, else the new tag's.
 * @param {TagPick} pick
 * @param {string} color
 */
function pickColor(pick, color) {
  if (!pick.recolor) {
    pick.color = color;
    return;
  }
  setTagColor(pick.recolor, color);
  for (const chipEl of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('.td-chip'))) {
    if (chipEl.dataset.tag === pick.recolor) chipEl.style.setProperty('--td-hue', color);
  }
}

/**
 * The list's clicks (a tag, its colour, Create, a swatch) and the colour field.
 * @param {HTMLElement} list
 * @param {TagPick} pick
 * @param {{ draw: () => void, choose: (tag: string, isNew: boolean) => void, focus: () => void }} handlers
 */
function wireTagList(list, pick, { draw, choose, focus }) {
  // The focus stays in the search field while tags are ticked; the colour field needs it.
  list.addEventListener('mousedown', e => {
    if (/** @type {HTMLInputElement} */ (e.target).type !== COLOR_INPUT) e.preventDefault();
  });
  list.addEventListener('click', e => {
    const swatch = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-color]'));
    const recolor = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-recolor]'));
    const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tag]'));
    if (swatch) pickColor(pick, /** @type {string} */ (swatch.dataset.color));
    else if (recolor) pick.recolor = pick.recolor === recolor.dataset.recolor ? null : recolor.dataset.recolor ?? null;
    else if (row) return choose(/** @type {string} */ (row.dataset.tag), 'new' in row.dataset);
    else return;
    draw();
  });
  // While the colour picker is open the chips follow it; choosing draws the swatches again.
  list.addEventListener('input', e => {
    const box = /** @type {HTMLInputElement} */ (e.target);
    if (box.type !== COLOR_INPUT) return;
    pickColor(pick, box.value);
    list.querySelector('.tp-create .td-chip')?.setAttribute('style', `--td-hue:${cssColor(box.value)}`);
  });
  list.addEventListener('change', e => {
    if (/** @type {HTMLInputElement} */ (e.target).type !== COLOR_INPUT) return;
    draw();
    focus();
  });
}

/**
 * A tag was renamed or deleted: the picked tags and the open editor follow, so it doesn't come back with a Save.
 * @param {string} tag
 * @param {string | null} to null when it's deleted
 */
function retagged(tag, to) {
  picked = retag(picked, tag, to);
  editTags = retag(editTags, tag, to);
  showEditTags();
}

/** @param {string} tag */
function toggleEditTag(tag) {
  editTags = editTags.includes(tag) ? editTags.filter(t => t !== tag) : [...editTags, tag];
  showEditTags();
}

/**
 * The picker of a task's tags, under its Tag button: tick existing tags, or type a new name and press Enter.
 * @param {HTMLElement} at
 */
function pickTags(at) {
  const doc = at.ownerDocument;
  const picker = doc.createElement('div');
  picker.className = 'popover tag-picker';
  picker.hidden = true;
  picker.innerHTML = `<input class="field" placeholder="Find or create a tag" spellcheck="false" aria-label="Tag"><div class="tp-list" role="listbox"></div>`;
  const input = /** @type {HTMLInputElement} */ (find(picker, 'input'));
  const list = find(picker, TAG_LIST);
  const query = () => tagOfHeading(input.value.replace(/^#/, ''));
  /** @type {TagPick} */
  const pick = { color: nextTagColor(), recolor: null };
  const draw = () => { list.innerHTML = tagRowsHtml(query(), pick); };
  /** @param {string} tag @param {boolean} isNew */
  const choose = (tag, isNew) => {
    if (isNew) {
      setTagColor(tag, pick.color);
      pick.color = nextTagColor();
    }
    toggleEditTag(tag);
    input.value = '';
    draw();
  };
  // Typing leaves a tag's colours: a swatch then is for the tag being typed.
  input.addEventListener('input', () => {
    pick.recolor = null;
    draw();
  });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !query()) return;
    e.preventDefault();
    choose(query(), !todoTags().some(([tag]) => tag === query()) && !editTags.includes(query()));
  });
  wireTagList(list, pick, { draw, choose, focus: () => input.focus() });
  draw();
  openPopover(picker, at, { dynamic: true, refocus: () => /** @type {HTMLElement | null} */ (panel.querySelector(EDIT_TEXT))?.focus() });
  input.focus();
}

/** @param {TodoTask} task */
function issueItems(task) {
  if (!task.issue) {
    const folder = folderOfList();
    return folder && isOnGitHub(folder) ? [{ label: 'Create GitHub issue', icon: ICONS.git, action: () => beginIssue(task) }] : [];
  }
  const { url, number } = task.issue;
  return [
    { label: `Open issue #${number} on GitHub`, icon: ICONS.link, action: () => send(PAGE.openUrl, { url }) },
    { label: 'Copy the link', icon: ICONS.copy, action: () => copyOut(url, NAME) },
    { label: 'Unlink the issue', icon: ICONS.close, title: 'The issue itself stays on GitHub', action: () => updateTask(/** @type {ListRef} */ (current), task.id, { issue: undefined }) },
  ];
}

/**
 * Where a task can move: the other lists of the workspace, and the other workspaces.
 * @param {TodoTask} task
 */
function moveItems(task) {
  const from = /** @type {ListRef} */ (current);
  return listItems(to => moveTask(from, task.id, to), from);
}

/**
 * @param {TodoTask} task
 * @param {import('./popups.js').Anchor} at
 */
function taskMenu(task, at) {
  showMenu([
    { label: 'Edit', icon: ICONS.rename, action: () => beginEdit(task.id) },
    { label: 'Move to', icon: ICONS.move, submenu: () => moveItems(task) },
    { label: COPY_LABEL, icon: ICONS.copy, action: () => copyOut(task.details ? `${task.text}\n${task.details}` : task.text, NAME) },
    SEPARATOR,
    ...issueItems(task),
    SEPARATOR,
    { label: 'Delete', icon: ICONS.trash, action: () => deleteTask(task) },
    SEPARATOR,
    ...clearItems(),
  ], at);
}

// ---- A GitHub issue from a task ----

/** The folder of the list shown. */
const folderOfList = () => folderOf(/** @type {ListRef} */ (current));

/**
 * Starts the form that makes an issue from a task or one of its sub-items.
 * @param {TodoTask} task
 * @param {import('./todolist.js').DetailLine} [sub]
 */
function beginIssue(task, sub) {
  const folder = folderOfList();
  issue = {
    taskId: task.id, line: sub?.at, title: sub?.text ?? task.text, body: sub ? `Part of: ${task.text}` : issueBody(task),
    requestId: newId('i'), labels: [], ticked: [], folder, error: folder ? undefined : 'This list has no folder on this computer, so there’s no repository to use.',
  };
  render();
  if (folder) send(PAGE.todoIssueInfo, { requestId: issue.requestId, folder });
}

/**
 * The statuses to pick from for a task, the one it has marked.
 * @param {TodoTask} task
 * @param {HTMLElement} at
 */
function statusMenu(task, at) {
  showMenu(Object.values(TASK_STATUS).map(status => ({
    label: STATUS_NAME[status], icon: STATUS_ICON[status], hint: status === statusOf(task) ? '✓' : '',
    action: () => changeStatus(task, status),
  })), at);
}

/**
 * Review's Accept: the task goes to Done at once, saying so, with Undo back to Review.
 * @param {TodoTask} task
 */
function acceptTask(task) {
  const ref = current;
  if (!ref) return;
  setStatus(ref, task.id, TASK_STATUS.done, { review: task.review });
  showToast({
    text: `“${task.text}” moved to Done`, state: TOAST.done,
    action: { label: UNDO, run: () => void (listOf(ref) && setStatus(ref, task.id, TASK_STATUS.review, { review: task.review, terminal: task.terminal })) },
  });
}

/**
 * A status picked. A task done here stays where it is until the list is shown again, and one taken off In progress while it
 * runs out of sight has its run stopped.
 * @param {TodoTask} task
 * @param {string} status
 */
function changeStatus(task, status) {
  if (!current) return;
  if (status === TASK_STATUS.done) settled.add(task.id);
  if (status !== TASK_STATUS.progress && task.run) stopRun(task);
  setStatus(current, task.id, status, { review: task.review, terminal: task.terminal, run: task.run });
}

/**
 * Implement's two ways: in a new terminal, where you can watch and answer it, or Silent, as a schedule's agent runs.
 * @param {HTMLElement} at
 * @param {TodoTask} task
 * @param {import('./todolist.js').DetailLine} [step]
 */
function implementMenu(at, task, step) {
  const ref = current;
  if (!ref) return;
  const asks = state.todo.allowAll ? 'gets whatever else it asks for (To do settings)' : 'asks in the task’s row for anything else';
  showMenu([
    { label: 'In a new terminal', icon: ICONS.terminal, title: 'Claude Code starts in a new terminal in this list’s folder, where you can watch it and answer it', action: () => implementTask(ref, task, step) },
    {
      label: 'Silent', icon: ICONS.play, title: `Nobody is watching: Claude Code works in a hidden shell, changes files without asking and ${asks}. The task goes to Review with its reply`,
      action: () => {
        if (!implementSilently(ref, task, step)) showToast({ text: 'Claude Code can’t start silently here: this list needs a folder on this computer', state: TOAST.failed });
      },
    },
  ], at);
}

/**
 * To do's settings, under its header's button: each is ticked while it's on.
 * @param {HTMLElement} at
 */
function settingsMenu(at) {
  showMenu([
    {
      label: 'Always notify', checked: !!state.todo.alwaysNotify,
      title: 'When a task waits for review, needs you or its Silent run fails: a desktop notification, and the phones, even while you’re at the PC',
      action: () => {
        state.todo.alwaysNotify = !state.todo.alwaysNotify;
        persist();
      },
    },
    {
      label: 'Allow all in Silent runs', checked: !!state.todo.allowAll,
      title: 'Claude Code working silently gets whatever it asks for, without waiting for Allow',
      action: () => {
        state.todo.allowAll = !state.todo.allowAll;
        persist();
        if (state.todo.allowAll) allowWaiting();
      },
    },
  ], at);
}

/**
 * Deletes a task, with Undo. One running out of sight is stopped first.
 * @param {TodoTask} task
 */
function deleteTask(task) {
  const ref = current;
  const list = shown();
  if (!ref || !list) return;
  const at = list.tasks.findIndex(t => t.id === task.id);
  if (task.run) stopRun(task);
  removeTask(ref, task.id);
  // One that was running comes back Open: its run is gone.
  const back = task.run ? { ...task, run: undefined, status: undefined } : task;
  showToast({
    text: `Deleted “${task.text}”`, state: TOAST.done,
    action: { label: UNDO, run: () => void (listOf(ref) && reorderTasks(ref, tasks => void tasks.splice(Math.max(0, at), 0, back))) },
  });
}

/**
 * This list's tasks as they're shown: only those with the picked tags, and only what the search finds.
 * @param {TodoList} list
 */
const visibleTasks = list => withTags(list.tasks, picked).filter(task => !query || taskMatches(task, query));

/**
 * This list's active tasks (open, in progress, in review) or its done ones, of those shown.
 * @param {boolean} done
 */
function clearable(done) {
  const list = shown();
  return list ? visibleTasks(list).filter(task => !!task.done === done) : [];
}

/**
 * Clear active tasks and Clear done tasks, for the list's right-click menus: greyed out when there's none.
 * @returns {import('./popups.js').MenuItem[]}
 */
function clearItems() {
  const narrowed = picked.length > 0 || !!query;
  /** @param {boolean} done @param {string} label */
  const item = (done, label) => {
    const count = clearable(done).length;
    return {
      label, icon: ICONS.trash, hint: count ? String(count) : '', disabled: !count,
      title: `Deletes this list’s ${done ? 'done' : 'open, in progress and in review'} tasks${narrowed ? ' that are shown' : ''}, with Undo`,
      action: () => void clearTasks(done),
    };
  };
  return [item(false, 'Clear active tasks'), item(true, 'Clear done tasks')];
}

/**
 * Which active tasks to clear: when some are in progress, the user says whether to keep those (the rest go) or clear them
 * all. Null when cancelled.
 * @param {TodoTask[]} tasks
 * @returns {Promise<TodoTask[] | null>}
 */
async function activeToClear(tasks) {
  const busy = tasks.filter(task => statusOf(task) === TASK_STATUS.progress);
  if (!busy.length) return tasks;
  const others = tasks.length - busy.length;
  const one = busy.length === 1;
  const working = busy.some(task => task.run || agentWorking(task));
  const answer = await choiceDialog({
    title: one ? 'A task is in progress' : `${busy.length} tasks are in progress`,
    body: `${one ? `“${busy[0].text}” is` : 'They are'} in progress${working ? `, and ${AGENT_COMMAND} is working on ${one ? 'it' : 'some'}` : ''}. `
      + (others ? `Keep ${one ? 'it' : 'them'} and clear the other ${others === 1 ? 'task' : `${others} tasks`}, or clear all ${tasks.length}?` : `Clear ${one ? 'it' : 'them'} too?`)
      + (busy.some(task => task.run) ? ' A silent run is stopped.' : ''),
    keep: others ? `Keep ${one ? 'it' : 'them'}` : undefined,
    danger: others ? 'Clear all' : 'Clear',
  });
  if (answer === CHOICE.keep) return tasks.filter(task => !busy.includes(task));
  return answer === CHOICE.danger ? tasks : null;
}

/**
 * Deletes this list's active tasks, or its done ones (those shown), with Undo. Those running out of sight are stopped first.
 * Clearing active ones asks first when some are in progress.
 * @param {boolean} done
 */
async function clearTasks(done) {
  const ref = current;
  if (!ref || !shown()) return;
  const chosen = done ? clearable(done) : await activeToClear(clearable(done));
  // The list as it is now: it can change while the question is up.
  const list = listOf(ref);
  if (!chosen || !list) return;
  const gone = new Set(chosen.map(task => task.id));
  if (!gone.size) return;
  // Each with where it was, to put it back there; one that was running comes back Open: its run is gone.
  const kept = list.tasks.flatMap((task, at) => (gone.has(task.id) ? [{ at, task: task.run ? { ...task, run: undefined, status: undefined } : task }] : []));
  for (const task of list.tasks) if (gone.has(task.id) && task.run) stopRun(task);
  reorderTasks(ref, tasks => void tasks.splice(0, tasks.length, ...tasks.filter(task => !gone.has(task.id))));
  showToast({
    text: `Cleared ${gone.size} ${done ? 'done' : 'active'} ${gone.size === 1 ? 'task' : 'tasks'}`, state: TOAST.done,
    action: {
      label: UNDO,
      run: () => void (listOf(ref) && reorderTasks(ref, tasks => {
        for (const { at, task } of kept) if (!tasks.some(t => t.id === task.id)) tasks.splice(Math.min(at, tasks.length), 0, task);
      })),
    },
  });
}

/** @param {TodoList} list */
function renderIssue(list) {
  const task = list.tasks.find(t => t.id === issue?.taskId);
  if (!task || !issue) {
    issue = null;
    return void render();
  }
  const ready = !!issue.repo && !issue.busy;
  issueForm.innerHTML = `
    <h3>Create a GitHub issue</h3>
    <p class="td-issue-repo">${issue.repo ? escapeHtml(issue.repo) : issue.error ? '' : 'Finding the repository'}</p>
    ${issue.error ? `<p class="td-issue-error">${escapeHtml(issue.error)}</p>` : ''}
    <input class="field td-issue-title" value="${escapeHtml(issue.title)}" spellcheck="false" autocomplete="off" aria-label="Title">
    <textarea class="field td-issue-body" rows="8" spellcheck="false" placeholder="Body" aria-label="Body">${escapeHtml(issue.body)}</textarea>
    ${issue.labels.length ? `<div class="td-labels">${issue.labels.map(l => `<button type="button" class="td-label${issue?.ticked.includes(l) ? ' on' : ''}" data-td="${ACTION.label}" data-label="${escapeHtml(l)}" aria-pressed="${issue?.ticked.includes(l)}">${escapeHtml(l)}</button>`).join('')}</div>` : ''}
    <span class="td-edit-actions"><button type="button" class="btn small" data-td="${ACTION.backToList}">Cancel</button><button type="button" class="btn small primary" data-td="${ACTION.create}" ${ready ? '' : 'disabled'}>${issue.busy ? 'Creating' : 'Create issue'}</button></span>`;
}

function createIssue() {
  if (!issue?.repo || issue.busy || !issue.folder) return;
  const title = /** @type {HTMLInputElement} */ (find(issueForm, ISSUE_TITLE)).value.trim();
  if (!title) return;
  const body = /** @type {HTMLTextAreaElement} */ (find(issueForm, ISSUE_BODY)).value;
  issue = { ...issue, busy: true, error: undefined };
  send(PAGE.todoIssueCreate, { requestId: issue.requestId, folder: issue.folder, title, body, labels: issue.ticked });
  redrawIssue();
}

/** Draws the form again, keeping what was typed: the fields start from the task's text. */
function redrawIssue() {
  const title = /** @type {HTMLInputElement | null} */ (issueForm.querySelector(ISSUE_TITLE))?.value;
  const body = /** @type {HTMLTextAreaElement | null} */ (issueForm.querySelector(ISSUE_BODY))?.value;
  render();
  const newTitle = /** @type {HTMLInputElement | null} */ (issueForm.querySelector(ISSUE_TITLE));
  const newBody = /** @type {HTMLTextAreaElement | null} */ (issueForm.querySelector(ISSUE_BODY));
  if (newTitle && title !== undefined) newTitle.value = title;
  if (newBody && body !== undefined) newBody.value = body;
}

/** @param {string} label */
function toggleLabel(label) {
  if (!issue) return;
  issue = { ...issue, ticked: issue.ticked.includes(label) ? issue.ticked.filter(l => l !== label) : [...issue.ticked, label] };
  redrawIssue();
}

onHost(HOST.todoIssueInfo, m => {
  if (m.requestId !== issue?.requestId) return;
  const task = taskById(issue.taskId);
  issue = { ...issue, repo: m.repo ?? undefined, labels: m.labels ?? [], ticked: labelsForTags(m.labels ?? [], task?.tags ?? []), error: m.error ?? undefined };
  redrawIssue();
});

onHost(HOST.todoIssueCreated, m => {
  if (m.requestId !== issue?.requestId) return;
  if (m.error || !m.url || !m.number) {
    issue = { ...issue, busy: false, error: m.error ?? 'GitHub didn’t say where the issue is.' };
    return redrawIssue();
  }
  const { taskId, line, repo } = issue;
  issue = null;
  const made = taskById(taskId);
  if (made) keepIssue(/** @type {ListRef} */ (current), made, line, { repo: repo ?? '', number: m.number, url: m.url });
  showToast({ text: `Issue #${m.number} created in ${repo}`, state: TOAST.done });
});

// ---- Wiring ----

/**
 * The task a control is on: its row's.
 * @param {HTMLElement} control
 */
function taskOfControl(control) {
  const row = /** @type {HTMLElement | null} */ (control.closest('[data-task]'));
  return row ? taskById(/** @type {string} */ (row.dataset.task)) : null;
}

/**
 * The step a control is on, in a task opened out.
 * @param {HTMLElement} control
 * @param {TodoTask} task
 */
function stepOf(control, task) {
  const step = /** @type {HTMLElement | null} */ (control.closest('[data-sub]'));
  return step ? detailLines(task.details).find(line => line.at === Number(step.dataset.sub)) : undefined;
}

/**
 * What a control on a task does: in its row, or on one of its steps.
 * @type {Readonly<Record<string, (control: HTMLElement, task: TodoTask) => void>>}
 */
const ON_TASK = Object.freeze({
  [ACTION.edit]: (_control, task) => beginEdit(task.id),
  [ACTION.remove]: (_control, task) => deleteTask(task),
  [ACTION.implement]: (control, task) => implementMenu(control, task, stepOf(control, task)),
  [ACTION.issue]: (control, task) => beginIssue(task, stepOf(control, task)),
  [ACTION.status]: (control, task) => statusMenu(task, control),
  [ACTION.accept]: (_control, task) => acceptTask(task),
  [ACTION.reopen]: (_control, task) => changeStatus(task, TASK_STATUS.open),
  [ACTION.stopRun]: (_control, task) => stopRun(task),
  [ACTION.allow]: (_control, task) => answerAsk(task, ASK.allow),
  [ACTION.allowAll]: (_control, task) => answerAsk(task, ASK.all),
  [ACTION.deny]: (_control, task) => answerAsk(task, ASK.deny),
  [ACTION.more]: (control, task) => taskMenu(task, control),
  [ACTION.expand]: (_control, task) => toggleExpanded(task),
});

/**
 * Opens a task out in its row, or folds it to its first line.
 * @param {TodoTask} task
 */
function toggleExpanded(task) {
  if (!expanded.delete(task.id)) expanded.add(task.id);
  render();
  /** @type {HTMLElement | null} */ (listEl.querySelector(`[data-task="${CSS.escape(task.id)}"]`))?.focus();
}

/** Shows or hides the note's box. */
function toggleNote() {
  hidingNote = !noteBox.hidden;
  render();
  if (!hidingNote) noteArea.focus();
}

/** @param {HTMLElement} control */
function goToAgent(control) {
  const tab = state.tabs.get(/** @type {string} */ (control.dataset.tab));
  if (tab) focusTab(tab);
}

/** @param {HTMLElement} control */
function act(control) {
  const onTask = ON_TASK[control.dataset.td ?? ''];
  if (!onTask) return panelAct(control);
  const task = taskOfControl(control);
  if (task) onTask(control, task);
  return undefined;
}

/**
 * The search: every list, or this one; or emptied.
 * @param {HTMLElement} control
 */
function searchAct(control) {
  if (control.dataset.td === ACTION.searchToggle) return searching ? closeSearch() : openSearch();
  if (control.dataset.td === ACTION.scope) {
    state.todo.searchAll = !state.todo.searchAll;
    persist();
  } else searchField.value = '';
  search(searchField.value);
  searchField.focus();
}

/**
 * What the panel's own controls do: its header, the note, Done, tags, the editor and the issue form.
 * @param {HTMLElement} control
 */
function panelAct(control) {
  switch (control.dataset.td) {
    case ACTION.pick: return pickList(control);
    case ACTION.note: return toggleNote();
    case ACTION.pin: {
      const list = shown();
      if (list) setNote(list.ref.kind, noteTarget(list.ref), noteArea.value.trim(), !list.pinned);
      return render();
    }
    case ACTION.settings: return settingsMenu(control);
    case ACTION.detach: return void dock.detach();
    case ACTION.close: return dock.hide();
    case ACTION.fold:
      state.todo.showDone = !state.todo.showDone;
      persist();
      return render();
    case ACTION.foldActive:
      state.todo.hideActive = !state.todo.hideActive;
      persist();
      return render();
    case ACTION.clearDone: return void clearTasks(true);
    case ACTION.clearActive: return void clearTasks(false);
    case ACTION.scope:
    case ACTION.searchToggle:
    case ACTION.clearSearch: return searchAct(control);
    case ACTION.agentTerminal: return goToAgent(control);
    case ACTION.openIssue: return send(PAGE.openUrl, { url: control.dataset.url });
    case ACTION.filter: return openFilter(control);
    case ACTION.tag: return filterBy(/** @type {string} */ (control.dataset.tag));
    case ACTION.save: return saveEdit();
    case ACTION.cancel:
      editing = null;
      return render();
    case ACTION.pickTags: return pickTags(control);
    case ACTION.manageTags: return openTagManager(control, retagged);
    case ACTION.dropTag: return toggleEditTag(/** @type {string} */ (control.dataset.tag));
    case ACTION.dropAddTag: return dropAddTag(/** @type {string} */ (control.dataset.tag));
    default: return issueAct(control);
  }
}

/** @param {HTMLElement} control */
function issueAct(control) {
  switch (control.dataset.td) {
    case ACTION.label: return toggleLabel(/** @type {string} */ (control.dataset.label));
    case ACTION.create: return createIssue();
    case ACTION.backToList:
      issue = null;
      return render();
    default: return undefined;
  }
}

panel.addEventListener('click', e => {
  // A task a search found in another list opens there.
  const away = /** @type {HTMLElement | null} */ (targetOf(e).closest(ELSEWHERE));
  const found = away && findTask(/** @type {string} */ (away.dataset.task));
  if (found) return openList(found.ref);
  const control = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-td]'));
  if (control) act(control);
  return undefined;
});

/** Whether a double click began on a control: its first click can redraw the row, so the second lands on what's under it. */
let startedOnControl = false;
listEl.addEventListener('mousedown', e => {
  if (e.detail === 1) startedOnControl = !!targetOf(e).closest(ROW_CONTROL);
});

listEl.addEventListener('dblclick', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(TASK));
  if (row && !row.matches(ELSEWHERE) && !startedOnControl && !targetOf(e).closest(ROW_CONTROL)) beginEdit(/** @type {string} */ (row.dataset.task));
});

listEl.addEventListener('contextmenu', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(TASK));
  const task = row && taskById(/** @type {string} */ (row.dataset.task));
  // Off a task (the list's empty space, or Done): clearing the list's active or done tasks.
  if (!task) {
    if (row || !shown() || targetOf(e).closest(EDIT_ROW)) return;
    e.preventDefault();
    return void showMenu(clearItems(), { x: e.clientX, y: e.clientY });
  }
  e.preventDefault();
  taskMenu(task, { x: e.clientX, y: e.clientY });
});

/** The task being dragged to another place in its list. */
/** @type {string | null} */
let dragged = null;
listEl.addEventListener('dragstart', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(TASK));
  dragged = row?.dataset.task ?? null;
  if (dragged && e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row?.querySelector(TASK_TEXT)?.textContent ?? '');
  }
});
listEl.addEventListener('dragover', e => {
  if (dragged && targetOf(e).closest(TASK)) e.preventDefault();
});
listEl.addEventListener('drop', e => {
  const over = /** @type {HTMLElement | null} */ (targetOf(e).closest(TASK));
  if (!dragged || !over || !current || over.matches(ELSEWHERE)) return;
  e.preventDefault();
  const id = dragged;
  dragged = null;
  reorderTasks(current, tasks => moveBefore(tasks, id, /** @type {string} */ (over.dataset.task)));
});

/** The tags typed in the add field (`:tag:`, `#tag`, or picked from the suggestions), taken out of it as chips under it. */
let addTags = /** @type {string[]} */ ([]);

// `:` starts a tag: the tags there are show under it. Wired first, so Enter picks one while they show.
tagCompletion(addField, { taken: () => [...addTags, ...parseTask(addField.value).tags], chosen: tag => addTagChips([tag]) });
/** The editors' task fields with tag suggestions; each edit draws a new one. */
const completing = new WeakSet();
listEl.addEventListener('focusin', e => {
  const field = /** @type {HTMLInputElement} */ (e.target);
  if (!field.matches(EDIT_TEXT) || completing.has(field)) return;
  completing.add(field);
  tagCompletion(field, { taken: () => editTags, chosen: tag => { if (!editTags.includes(tag)) toggleEditTag(tag); } });
});

/** The add field's tags, as chips under it. */
function renderAddTags() {
  addTagsEl.hidden = !addTags.length;
  addTagsEl.innerHTML = addTags.map(tag => `<span class="td-chip" ${chipStyle(tag)}>${escapeHtml(tag)}<button type="button" class="td-chip-drop" data-td="${ACTION.dropAddTag}" data-tag="${escapeHtml(tag)}" title="Remove" aria-label="Remove ${escapeHtml(tag)}">${ICONS.close}</button></span>`).join('');
}

/** @param {string[]} tags */
function addTagChips(tags) {
  const fresh = tags.filter(tag => !addTags.includes(tag));
  if (!fresh.length) return;
  addTags = [...addTags, ...fresh];
  renderAddTags();
}

/**
 * A chip's × under the add field: the tag goes from the new task.
 * @param {string} tag
 */
function dropAddTag(tag) {
  addTags = addTags.filter(t => t !== tag);
  renderAddTags();
  addField.focus();
}

// A tag finished in the field (`#tag ` or `:tag:`) leaves it for a chip under it.
addField.addEventListener('input', () => {
  const taken = takeTags(addField.value, addField.selectionStart ?? addField.value.length);
  if (!taken.tags.length) return;
  addField.value = taken.text;
  addField.setSelectionRange(taken.caret, taken.caret);
  addTagChips(taken.tags);
});
addField.addEventListener('keydown', e => {
  // Backspace in an empty field takes the last chip back off.
  if (e.key === 'Backspace' && !addField.value && addTags.length) {
    e.preventDefault();
    addTags = addTags.slice(0, -1);
    renderAddTags();
    return;
  }
  if (e.key !== 'Enter' || !addField.value.trim() || !current) return;
  e.preventDefault();
  const typed = parseTask(addField.value);
  if (!typed.text) return;
  const task = { text: typed.text, tags: [...addTags, ...typed.tags.filter(tag => !addTags.includes(tag))] };
  addField.value = '';
  addTags = [];
  renderAddTags();
  addTasks(current, [task]);
});

// Lines pasted are a task each; one line is left to the field, to be edited first.
addField.addEventListener('paste', e => {
  const text = e.clipboardData?.getData('text') ?? '';
  if (!text.includes('\n') || !current) return;
  e.preventDefault();
  const tasks = tasksFromLines(text);
  if (tasks.length) addTasks(current, tasks);
});

noteArea.addEventListener('input', () => {
  fitNote();
  if (noteTimer !== null) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    noteTimer = null;
    const list = shown();
    if (list) writeNote(list, noteArea.value);
  }, NOTE_SAVE_MS);
});
noteArea.addEventListener('focus', () => {
  writingNote = true;
});
noteArea.addEventListener('blur', () => {
  writingNote = false;
  saveNoteNow();
  const list = shown();
  if (list) renderNote(list);
});
noteArea.addEventListener('contextmenu', noteMenu);

listEl.addEventListener('keydown', e => {
  const row = /** @type {HTMLElement} */ (targetOf(e));
  if (!editing && row.matches(TASK) && !row.matches(ELSEWHERE)) return rowKey(e, row);
  if (!editing) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    editing = null;
    render();
  } else if (e.key === 'Enter' && (e.ctrlKey || !targetOf(e).matches('textarea'))) {
    e.preventDefault();
    saveEdit();
  }
});

issueForm.addEventListener('submit', e => e.preventDefault());

/**
 * Keys on a task: Space opens it out or folds it, Enter edits it, Delete deletes it, and the arrows go up and down.
 * @param {KeyboardEvent} e
 * @param {HTMLElement} row
 */
function rowKey(e, row) {
  const task = taskById(/** @type {string} */ (row.dataset.task));
  if (!task) return;
  if (e.key === ' ') toggleExpanded(task);
  else if (e.key === 'Enter') beginEdit(task.id);
  else if (e.key === 'Delete') deleteTask(task);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const rows = [...listEl.querySelectorAll(TASK)];
    /** @type {HTMLElement | undefined} */ (rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)])?.focus();
  } else return;
  e.preventDefault();
}

searchField.addEventListener('input', () => search(searchField.value));
searchField.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSearch(true);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    /** @type {HTMLElement | null} */ (listEl.querySelector(TASK))?.focus();
  }
});
/**
 * Left empty, the search goes back into its icon once you're elsewhere in the panel; with something in it, it stays.
 * @param {Node | null} to where the caret or the pointer went (none: a click that doesn't move the caret, as on a Mac)
 */
function leftSearch(to) {
  if (to && !query && searching && !searchBox.contains(to) && !searchButton.contains(to)) closeSearch();
}
searchBox.addEventListener('focusout', e => leftSearch(/** @type {Node | null} */ (e.relatedTarget)));
panel.addEventListener('pointerdown', e => leftSearch(/** @type {Node | null} */ (e.target)));

panel.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    e.stopPropagation();
    openSearch();
    return;
  }
  if (!dock.closeKeys(e, KEY_ID.todo)) return;
  e.preventDefault();
  e.stopPropagation();
});

button.addEventListener('click', toggleTodo);

on(EVENTS.openTodo, openList);
on(EVENTS.todo, () => {
  showCount();
  if (!panel.hidden) render();
});
// A terminal or workspace in front changed, or closed: its count, and the list shown when what it's on has gone.
on(EVENTS.profiles, () => {
  if (!panel.hidden && !editing) render();
});
for (const event of [EVENTS.focus, EVENTS.workspaces, EVENTS.tab]) {
  on(event, () => {
    showCount();
    if (!panel.hidden && !shown()) render();
    else if (!panel.hidden) showPick(/** @type {TodoList} */ (shown()));
  });
}
// Claude Code in a task's terminal started or stopped working: its mark spins or stops.
for (const event of [EVENTS.agent, EVENTS.tab]) on(event, showWorking);
// A task's desktop notification was clicked (Always notify, js/notify.js): its list opens.
onHost(HOST.focusTerminal, m => {
  const found = findTask(m.id);
  if (found) openList(found.ref);
});
