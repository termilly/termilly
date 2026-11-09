// @ts-check
// What the To do tab draws (todo.js does the rest): the tree of lists, a list, a task's sheet and the sheets it leads to.

/** @typedef {{ at: number, text: string, done: boolean }} PhoneStep */
/**
 * A task as the PC sends it (js/phonetodo.js).
 * @typedef {{ id: string, text: string, status: string, tags: string[], details: string, notes: string, steps: PhoneStep[],
 *   agent: { id: string, title: string } | null, working?: boolean, now?: string | null, review: { summary: string, by: string } | null,
 *   issue: { url: string, number: number } | null }} PhoneTask
 */
/**
 * A terminal's or workspace's list.
 * @typedef {{ kind: string, id: string, name: string, tasks: PhoneTask[], implement: boolean, github: boolean, lead: string,
 *   note: { text: string, pinned?: boolean } | null, ws?: PhoneList, plan: ImplementPick | null, agents: { kind: string, name: string }[],
 *   reviewers: string[] }} PhoneList plan: what Implement starts with on this list; agents: who can do the work; reviewers: who can
 *   review (none unless the PC has more than one agent)
 */
/** What Implement's sheet has picked: who does the work, who reviews it, and how it runs (HOW). */
/** @typedef {{ by: string, reviewers: string[], run: string }} ImplementPick */
/** @typedef {{ name: string, color: string }} PhoneTag */
/** What the views need to know: the tags' colours, and what this phone may do. */
/** @typedef {{ tags: PhoneTag[], typing: boolean, opening: boolean }} Allowed */

/** A task's statuses, as the PC names them (js/todolist.js TASK_STATUS). */
export const STATUS = Object.freeze({ open: 'open', progress: 'progress', review: 'review', done: 'done' });
const STATUS_NAME = Object.freeze({ [STATUS.open]: 'Open', [STATUS.progress]: 'In progress', [STATUS.review]: 'Review', [STATUS.done]: 'Done' });
/** What To do's buttons do (data-td). */
export const TD = Object.freeze({
  open: 'open', back: 'back', add: 'add', addSave: 'addSave', task: 'task', check: 'check', status: 'status', tick: 'tick', terminal: 'terminal',
  implement: 'implement', issue: 'issue', tags: 'tags', tag: 'tag', edit: 'edit', save: 'save', move: 'move', moveTo: 'moveTo',
  remove: 'remove', removeYes: 'removeYes', close: 'close', toTask: 'toTask', note: 'note', noteSave: 'noteSave', noteRemove: 'noteRemove',
  noteTasks: 'noteTasks', showAll: 'showAll', showDone: 'showDone', label: 'label', create: 'create', pickTag: 'pickTag',
  implementHow: 'implementHow', implementBy: 'implementBy', implementReviewer: 'implementReviewer', implementStart: 'implementStart', pickStatus: 'pickStatus',
});
/** Implement's two ways, as the PC's Implement menu has them. */
export const HOW = Object.freeze({ terminal: 'terminal', silent: 'silent' });
/** What each is called, in the order they're offered. */
const HOW_NAMES = Object.freeze([[HOW.terminal, 'In a new terminal'], [HOW.silent, 'Silent']]);
/** The fields that are read by name (data-field). */
export const FIELD = Object.freeze({ add: 'add', find: 'find', text: 'text', details: 'details', note: 'note', pin: 'pin', title: 'title', body: 'body', newTag: 'newTag' });

const TICK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg>';
const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3l8 5-8 5z"/></svg>';
const LIST_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6l2 2 3-3M3 12l2 2 3-3M3 18l2 2 3-3M12 6h9M12 12h9M12 18h9"/></svg>';

/** @param {unknown} text */
export const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** The first line with something in it, without markdown's heading and list marks (as js/notes.js firstLine). @param {string} text */
const firstLine = text => text.split(/\r?\n/).map(l => l.replace(/^\s*(#+|[-*]|\d+\.)\s+/, '').trim()).find(Boolean) ?? '';

/** What's left to do on a list. @param {PhoneList} list */
export const openTasks = list => list.tasks.filter(t => t.status !== STATUS.done);

/** @param {string} tag @param {Allowed} ctx */
function chip(tag, ctx) {
  const color = ctx.tags.find(t => t.name === tag)?.color ?? 'var(--muted)';
  return `<span class="td-chip" style="--hue:${esc(color)}">${esc(tag)}</span>`;
}

/**
 * Each status's mark, as the PC's (js/todopanel.js STATUS_ICON): a ring, half filled while it's worked on, with a dot when it
 * waits for review, ticked when done.
 * @type {Readonly<Record<string, string>>}
 */
const STATUS_ICON = Object.freeze({
  [STATUS.open]: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/></svg>',
  [STATUS.progress]: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>',
  [STATUS.review]: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/></svg>',
  [STATUS.done]: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="none"/><path class="st-tick" d="M5.25 8.25l1.75 1.75 3.75-4"/></svg>',
});
/** In progress's mark while an agent is at work on the task: a faint ring with an arc going round it, as on the PC. */
const WORKING_ICON = '<svg class="st-spinner" viewBox="0 0 16 16" aria-hidden="true"><circle class="st-track" cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/></svg>';
/** A step's mark, as the PC's: a small ring, a tick once done. */
const STEP_MARK = Object.freeze({
  done: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5l2.5 2.5 5.5-6"/></svg>',
  open: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5"/></svg>',
});

/**
 * A task's status mark: where the phone may change tasks a tap opens the statuses to pick from (as on the PC), elsewhere it
 * only shows. It spins while an agent is at work on the task.
 * @param {string} status
 * @param {string} data its data attributes
 * @param {boolean} typing
 * @param {boolean} [working]
 */
function statusMarkHtml(status, data, typing, working = false) {
  const cls = `td-st st-${esc(status)}${working ? ' working' : ''}`;
  const mark = working ? WORKING_ICON : STATUS_ICON[status] ?? STATUS_ICON[STATUS.open];
  const name = STATUS_NAME[status] ?? '';
  return typing ? `<button class="${cls}" data-td="${TD.check}" ${data} aria-label="Status: ${name}. Tap to change">${mark}</button>` : `<span class="${cls}" aria-label="${name}">${mark}</span>`;
}

/**
 * The statuses to pick from for a task, the one it has ticked: the PC's status menu.
 * @param {PhoneTask} task
 */
export const statusSheetHtml = task => `${headHtml('Status')}<p>${esc(task.text)}</p><div class="list td-pick">${Object.values(STATUS).map(s => `<button class="row" data-td="${TD.pickStatus}" data-status="${s}"><span class="td-st st-${s}">${STATUS_ICON[s]}</span><span class="r-text">${STATUS_NAME[s]}</span><span class="td-tick">${s === task.status ? TICK : ''}</span></button>`).join('')}</div>`;

/** @param {PhoneStep[]} steps */
const progress = steps => (steps.length ? `<span class="td-sub">${steps.filter(s => s.done).length}/${steps.length}</span>` : '');

/**
 * A task's row.
 * @param {PhoneTask} task
 * @param {Allowed} ctx
 */
function taskRow(task, ctx) {
  const data = `data-task="${esc(task.id)}"`;
  const meta = `${progress(task.steps)}${task.tags.map(tag => chip(tag, ctx)).join('')}${task.issue ? `<span class="td-sub">#${esc(task.issue.number)}</span>` : ''}`;
  return `<div class="row td-row${task.status === STATUS.done ? ' td-done' : ''}" data-td="${TD.task}" ${data}>${statusMarkHtml(task.status, data, ctx.typing, !!task.working)}
    <div class="r-text"><div class="r-name">${esc(task.text)}</div>
      ${task.now ? `<div class="td-agent">${esc(task.now)}</div>` : task.agent ? `<div class="td-agent">${esc(task.agent.title)}</div>` : ''}
      ${task.review ? `<div class="td-said"><b>${esc(task.review.by)}:</b> ${esc(task.review.summary)}</div>` : ''}
      ${meta ? `<div class="td-meta">${meta}</div>` : ''}</div></div>`;
}

/**
 * @param {string} name
 * @param {PhoneTask[]} tasks
 * @param {Allowed} ctx
 */
const groupHtml = (name, tasks, ctx) => (tasks.length ? `<div class="section-row"><span class="section td-section">${esc(name)} <i>${tasks.length}</i></span></div><div class="list">${tasks.map(t => taskRow(t, ctx)).join('')}</div>` : '');

/**
 * A list's page, under its add field: its note, then its tasks by status, Done folded.
 * @param {PhoneList} list
 * @param {Allowed} ctx
 * @param {boolean} showDone
 * @param {Map<string, string>} [settled] the tasks done while the list was shown, by the status they had
 */
export function listHtml(list, ctx, showDone, settled = new Map()) {
  // A task done here stays where it was until the list is opened again, as on the PC.
  const shownAs = (/** @type {PhoneTask} */ t) => (t.status === STATUS.done ? settled.get(t.id) ?? t.status : t.status);
  const of = (/** @type {string} */ status) => list.tasks.filter(t => shownAs(t) === status);
  const done = of(STATUS.done);
  const note = list.note?.text ? `<button class="td-note" data-td="${TD.note}"><b>Note</b>${esc(firstLine(list.note.text))}</button>` : '';
  const empty = list.tasks.length ? '' : `<p class="muted center">${ctx.typing ? 'No tasks here yet.' : 'No tasks here.'}</p>`;
  const fold = done.length ? `<button class="td-fold" data-td="${TD.showDone}" aria-expanded="${showDone}"><span class="td-chev${showDone ? ' open' : ''}">›</span>Done <i>${done.length}</i></button>` : '';
  return `${note}${groupHtml(STATUS_NAME[STATUS.review], of(STATUS.review), ctx)}${groupHtml(STATUS_NAME[STATUS.progress], of(STATUS.progress), ctx)}${groupHtml(STATUS_NAME[STATUS.open], of(STATUS.open), ctx)}${empty}${fold}
    ${showDone && done.length ? `<div class="list">${done.map(t => taskRow(t, ctx)).join('')}</div>` : ''}
    ${ctx.typing ? '' : '<p class="td-hint">To change tasks from this phone, turn on Allow typing in Termilly’s Settings › Remote on the PC.</p>'}`;
}

/**
 * The top of a list's page.
 * @param {PhoneList} list
 * @param {boolean} typing
 */
export const listHeadHtml = (list, typing) => (typing ? `<button class="td-add" data-td="${TD.add}"><span class="td-plus">+</span>Add a task to ${esc(list.name)}</button>` : '');

/**
 * A list's row in the tree.
 * @param {PhoneList} list
 * @param {boolean} indented
 */
function treeRow(list, indented) {
  const open = openTasks(list);
  const line = open[0]?.text ?? (list.note?.text ? `Note: ${firstLine(list.note.text)}` : '');
  return `<button class="row td-tree${indented ? ' td-term' : ''}" data-td="${TD.open}" data-kind="${esc(list.kind)}" data-id="${esc(list.id)}">
    ${list.lead}<span class="r-text"><span class="r-name">${esc(list.name)}</span>${line ? `<span class="r-line">${esc(line)}</span>` : ''}</span>
    ${open.length ? `<span class="td-count">${open.length}</span>` : ''}<span class="td-chev">›</span></button>`;
}

/**
 * What waits for review, from any list.
 * @param {PhoneTask[]} tasks
 * @param {(task: PhoneTask) => string} where the name of its list
 * @param {boolean} typing
 */
function reviewHtml(tasks, where, typing) {
  if (!tasks.length) return '';
  const rows = tasks.map(t => `<div class="row td-row" data-td="${TD.task}" data-task="${esc(t.id)}">${statusMarkHtml(STATUS.review, '', false)}
    <div class="r-text"><div class="r-name">${esc(t.text)}</div><div class="td-said">${esc(where(t))} · ${esc(t.review?.summary ?? '')}</div></div>
    ${typing ? `<button class="td-accept" data-td="${TD.status}" data-status="${STATUS.done}" data-accept="1" data-task="${esc(t.id)}">Accept</button>` : ''}</div>`).join('');
  return `<div class="section-row"><span class="section td-section">Waiting for review <i>${tasks.length}</i></span></div><div class="list">${rows}</div>`;
}

/**
 * The To do tab, under its search box.
 * @param {{ groups: { ws: PhoneList, terms: PhoneList[] }[], review: PhoneTask[], where: (task: PhoneTask) => string, typing: boolean, searching: boolean, showAll: boolean, hidden: boolean }} tree
 */
export function homeHtml({ groups, review, where, typing, searching, showAll, hidden }) {
  const rows = groups.map(g => `<div class="list td-group">${treeRow(g.ws, false)}${g.terms.map(t => treeRow(t, true)).join('')}</div>`).join('');
  const none = groups.length ? '' : `<p class="muted center">${searching ? 'Nothing found.' : 'No tasks or notes yet.'}</p>`;
  const more = hidden || showAll ? `<button class="td-more" data-td="${TD.showAll}">${showAll ? 'Hide lists with nothing in them' : 'Show lists with nothing in them'}</button>` : '';
  return `${searching ? '' : reviewHtml(review, where, typing)}<div class="section-row"><span class="section td-section">${searching ? 'Found' : 'Lists'}</span></div>${rows}${none}${searching ? '' : more}`;
}

/** The search box on top of the tab. */
export const findHtml = () => `<input class="td-find" data-field="${FIELD.find}" type="search" placeholder="Find a list or task" enterkeyhint="search" spellcheck="false" autocomplete="off" aria-label="Find">`;

/** @param {PhoneList} list */
const whereHtml = list => `<div class="td-where">${list.lead}${esc(list.name)}${list.ws ? ` · ${esc(list.ws.name)}` : ''}</div>`;

/**
 * A task's steps, each with its box, and its play button where Implement can start.
 * @param {PhoneTask} task
 * @param {boolean} typing
 * @param {boolean} canImplement
 */
function stepsHtml(task, typing, canImplement) {
  if (!task.steps.length) return '';
  const rows = task.steps.map(s => {
    const data = `data-task="${esc(task.id)}" data-at="${s.at}" data-done="${s.done ? '' : '1'}"`;
    const play = canImplement && !s.done ? `<button class="td-play" data-td="${TD.implement}" data-task="${esc(task.id)}" data-at="${s.at}" aria-label="Implement this step">${PLAY}</button>` : '';
    const mark = s.done ? STEP_MARK.done : STEP_MARK.open;
    const box = typing ? `<button class="td-step-mark" data-td="${TD.tick}" ${data} aria-label="${s.done ? 'Not done' : 'Done'}">${mark}</button>` : `<span class="td-step-mark">${mark}</span>`;
    return `<div class="row td-step${s.done ? ' td-done' : ''}">${box}<div class="r-text">${esc(s.text)}</div>${play}</div>`;
  }).join('');
  return `<div class="section td-section">Steps</div><div class="list">${rows}</div>`;
}

/** @param {PhoneTask} task @param {boolean} typing */
function saidHtml(task, typing) {
  if (task.status !== STATUS.review) return '';
  const said = task.review ? `<div class="td-review"><b>${esc(task.review.by)}</b>${esc(task.review.summary)}</div>` : '';
  if (!typing) return said;
  return `${said}<div class="td-btns"><button class="ibtn" data-td="${TD.status}" data-status="${STATUS.open}" data-task="${esc(task.id)}">Back to open</button><button class="ibtn fill" data-td="${TD.status}" data-status="${STATUS.done}" data-accept="1" data-task="${esc(task.id)}">Accept</button></div>`;
}

/**
 * What a task's sheet can start, on the PC.
 * @param {PhoneTask} task
 * @param {boolean} canImplement
 * @param {boolean} canIssue
 */
function startsHtml(task, canImplement, canIssue) {
  const issue = canIssue && !task.issue ? `<button class="ibtn" data-td="${TD.issue}" data-task="${esc(task.id)}">GitHub issue</button>` : '';
  // Nothing to implement once it waits for review or is done.
  const implement = canImplement && task.status !== STATUS.review && task.status !== STATUS.done ? `<button class="ibtn fill" data-td="${TD.implement}" data-task="${esc(task.id)}">Implement</button>` : '';
  return issue || implement ? `<div class="td-btns">${implement}${issue}</div>` : '';
}

/**
 * A task opened from a list: what the PC shows on hover.
 * @param {PhoneTask} task
 * @param {PhoneList} list
 * @param {Allowed} ctx
 */
export function taskSheetHtml(task, list, ctx) {
  const { typing, opening } = ctx;
  const seg = Object.values(STATUS).map(s => `<button class="${s === task.status ? 'on' : ''}" ${typing ? `data-td="${TD.status}" data-status="${s}" data-task="${esc(task.id)}"` : 'disabled'}>${STATUS_NAME[s]}</button>`).join('');
  const canImplement = typing && opening && list.implement;
  return `${whereHtml(list)}<h2 class="td-title">${esc(task.text)}</h2><div class="td-seg">${seg}</div>${saidHtml(task, typing)}
    ${task.agent ? `<button class="td-agent" data-td="${TD.terminal}" data-id="${esc(task.agent.id)}">${esc(task.agent.title)}</button>` : ''}
    ${task.notes ? `<div class="section td-section">Details</div><p class="td-details">${esc(task.notes)}</p>` : ''}
    ${stepsHtml(task, typing, canImplement && task.status !== STATUS.review && task.status !== STATUS.done)}
    <div class="td-tags">${task.tags.map(tag => chip(tag, ctx)).join('')}${typing ? `<button class="td-add-tag" data-td="${TD.tags}">+ Tag</button>` : ''}</div>
    ${task.issue ? `<a class="td-issue" href="${esc(task.issue.url)}" target="_blank" rel="noopener">Issue #${esc(task.issue.number)} on GitHub</a>` : ''}
    ${startsHtml(task, canImplement, typing && list.github)}
    ${typing ? `<div class="td-links"><button class="link" data-td="${TD.edit}">Edit</button><button class="link" data-td="${TD.move}">Move to another list</button><button class="link red" data-td="${TD.remove}">Delete</button></div>` : ''}`;
}

/** A sheet's own way back. @param {string} title @param {string} [back] where it goes @param {string} [label] */
const headHtml = (title, back = TD.toTask, label = '‹ Back') => `<div class="td-sheet-head"><button class="link" data-td="${back}">${label}</button><h2>${esc(title)}</h2><span></span></div>`;

/** The box for a task's details. @param {string} details */
const detailsHtml = details => `<textarea class="td-input" data-field="${FIELD.details}" rows="6" spellcheck="false" placeholder="Details. A line starting [] is a step." aria-label="Details">${esc(details)}</textarea>`;

/**
 * A tag a new task can start with; a tap picks it (todo.js) without drawing the form again.
 * @param {string} name
 * @param {string} color
 * @param {boolean} [on]
 */
export const pickTagHtml = (name, color, on = false) => `<button class="td-chip td-pick-tag${on ? ' on' : ''}" data-td="${TD.pickTag}" data-tag="${esc(name)}" aria-pressed="${on}" style="--hue:${esc(color)}">${esc(name)}</button>`;

/**
 * A new task, at the top of the screen so the keyboard leaves it in view. Its tags are picked from To do's, or typed new.
 * @param {PhoneList} list
 * @param {Allowed} ctx
 */
export const addSheetHtml = (list, ctx) => `${headHtml('New task', TD.close, 'Cancel')}
  <input class="td-input" data-field="${FIELD.add}" placeholder="Add a task to ${esc(list.name)}" enterkeyhint="done" spellcheck="false" autocomplete="off" aria-label="Task">
  ${detailsHtml('')}
  <div class="td-tags td-new-tags">${ctx.tags.map(t => pickTagHtml(t.name, t.color)).join('')}<input class="td-tag-input" data-field="${FIELD.newTag}" placeholder="New tag" enterkeyhint="done" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="New tag"></div>
  <button class="ibtn fill" data-td="${TD.addSave}">Add</button>`;

/** @param {PhoneTask} task */
export const editSheetHtml = task => `${headHtml('Edit task')}
  <input class="td-input" data-field="${FIELD.text}" value="${esc(task.text)}" spellcheck="false" autocomplete="off" aria-label="Task">
  ${detailsHtml(task.details)}
  <button class="ibtn fill" data-td="${TD.save}">Save</button>`;

/**
 * @param {PhoneTask} task
 * @param {PhoneList} list the one it's on
 * @param {PhoneList[]} lists
 */
export const moveSheetHtml = (task, list, lists) => `${headHtml('Move to')}<div class="list td-pick">${lists.filter(l => l !== list).map(l => `<button class="row" data-td="${TD.moveTo}" data-kind="${esc(l.kind)}" data-id="${esc(l.id)}">${l.lead}<span class="r-text">${esc(l.name)}</span></button>`).join('')}</div>`;

/**
 * Picking a task's tags. Making and changing them is Manage tags, on the PC.
 * @param {PhoneTask} task
 * @param {Allowed} ctx
 */
export function tagsSheetHtml(task, ctx) {
  const rows = ctx.tags.map(t => `<button class="row" data-td="${TD.tag}" data-tag="${esc(t.name)}"><span class="td-tick">${task.tags.includes(t.name) ? TICK : ''}</span>${chip(t.name, ctx)}</button>`).join('');
  return `${headHtml('Tags')}<div class="list td-pick">${rows || '<p class="muted center">No tags yet. Make them on the PC, or give a new task one.</p>'}</div>`;
}

/**
 * A choice on Implement's sheet: a chip that's on or off.
 * @param {string} td what tapping it does
 * @param {string} data its data attribute, with the value
 * @param {string} label
 * @param {boolean} on
 */
const pickHtml = (td, data, label, on) => `<button class="td-chip td-pick-tag td-impl${on ? ' on' : ''}" data-td="${td}" ${data} aria-pressed="${on}">${esc(label)}</button>`;

/**
 * Implement's sheet, as the PC's card: who does the work, who reviews it (only where the PC has another agent to), and whether it
 * runs in a new terminal, to watch and answer it, or Silent, in a hidden shell. It opens with the list's plan, so it's Start.
 * @param {PhoneTask} task
 * @param {PhoneList} list
 * @param {ImplementPick} pick what's picked now
 */
export function implementSheetHtml(task, list, pick) {
  const name = /** @param {string} kind */ kind => list.agents.find(a => a.kind === kind)?.name ?? kind;
  const by = list.agents.length > 1
    ? `<div class="td-impl-label">By</div><div class="td-tags">${list.agents.map(a => pickHtml(TD.implementBy, `data-kind="${esc(a.kind)}"`, a.name, a.kind === pick.by)).join('')}</div>` : '';
  const can = list.reviewers.filter(kind => kind !== pick.by);
  const reviewers = can.length
    ? `<div class="td-impl-label">Reviewed by</div><div class="td-tags">${can.map(kind => pickHtml(TD.implementReviewer, `data-kind="${esc(kind)}"`, name(kind), pick.reviewers.includes(kind))).join('')}</div>` : '';
  const how = pick.run === HOW.silent ? `${name(pick.by)} works in a hidden shell. The task goes to Review with its reply.` : `${name(pick.by)} works where you can watch it and answer it.`;
  const reviewed = pick.reviewers.length ? ` ${pick.reviewers.map(name).join(' and ')} ${pick.reviewers.length > 1 ? 'review' : 'reviews'} it before it comes to you.` : '';
  return `${headHtml('Implement')}<p>${esc(task.text)}</p>${by}${reviewers}
    <div class="td-impl-label">Run</div><div class="td-tags">${HOW_NAMES.map(([run, label]) => pickHtml(TD.implementHow, `data-how="${run}"`, label, pick.run === run)).join('')}</div>
    <p class="muted td-impl-how">${esc(how + reviewed)}</p>
    <button class="ibtn fill" data-td="${TD.implementStart}">Start</button>`;
}

/** @param {PhoneTask} task */
export const removeSheetHtml = task => `${headHtml('Delete task')}<p>${esc(task.text)}</p><button class="ibtn red" data-td="${TD.removeYes}">Delete</button>`;

/**
 * The form that makes a GitHub issue.
 * @param {{ repo?: string, labels?: string[], ticked?: string[], title?: string, body?: string, error?: string, busy?: boolean }} issue
 */
export function issueSheetHtml(issue) {
  const labels = (issue.labels ?? []).map(l => `<button class="td-label${issue.ticked?.includes(l) ? ' on' : ''}" data-td="${TD.label}" data-label="${esc(l)}">${esc(l)}</button>`).join('');
  return `${headHtml('GitHub issue')}<p class="muted">${esc(issue.repo ?? (issue.error ? '' : 'Finding the repository'))}</p>
    ${issue.error ? `<p class="error">${esc(issue.error)}</p>` : ''}
    ${issue.repo ? `<input class="td-input" data-field="${FIELD.title}" value="${esc(issue.title)}" spellcheck="false" autocomplete="off" aria-label="Title">
    <textarea class="td-input" data-field="${FIELD.body}" rows="8" spellcheck="false" placeholder="Body" aria-label="Body">${esc(issue.body)}</textarea>
    ${labels ? `<div class="td-tags">${labels}</div>` : ''}
    <button class="ibtn fill" data-td="${TD.create}"${issue.busy ? ' disabled' : ''}>${issue.busy ? 'Creating' : 'Create issue'}</button>` : ''}`;
}

/**
 * A list's note: written here, pinned, removed, or turned into tasks.
 * @param {PhoneList} list
 * @param {boolean} typing
 */
export function noteHtml(list, typing) {
  const where = list.kind === 'terminal' ? 'the terminal’s header' : 'its terminals’ headers';
  return `<div class="td-note-page"><textarea class="memo-text" data-field="${FIELD.note}" rows="14" spellcheck="false" autocapitalize="sentences" placeholder="e.g. staging DB is read-only until Friday"${typing ? '' : ' readonly'}>${esc(list.note?.text ?? '')}</textarea>
    ${typing ? `<label class="memo-pinbox"><input type="checkbox" data-field="${FIELD.pin}"${list.note?.pinned ? ' checked' : ''}> Pin the first line to ${where}</label>
    <div class="td-btns"><button class="ibtn" data-td="${TD.noteRemove}">Remove</button><button class="ibtn fill" data-td="${TD.noteSave}">Save</button></div>
    <button class="ibtn" data-td="${TD.noteTasks}">Turn into tasks</button>
    <p class="td-hint">Turns the selected lines into tasks, or the whole note with nothing selected.</p>`
    : '<p class="muted">To edit notes from this phone, turn on Allow typing in Termilly’s Settings › Remote on the PC.</p>'}</div>`;
}

/**
 * A list's mark on the Terminals tab, for a note or any task, even with all of them done: how many are left. A tap opens it.
 * @param {PhoneList | undefined} list
 */
export function markHtml(list) {
  if (!list || (!list.tasks.length && !list.note?.text)) return '';
  const left = openTasks(list).length;
  return `<button class="td-mark" data-td="${TD.open}" data-kind="${esc(list.kind)}" data-id="${esc(list.id)}" aria-label="To do${left ? `, ${left} left` : ''}">${LIST_ICON}${left ? `<span>${left}</span>` : ''}</button>`;
}

/**
 * Tasks waiting for review, on the Notifications tab.
 * @param {{ task: PhoneTask, list: PhoneList }[]} waiting
 */
export function reviewNotesHtml(waiting) {
  if (!waiting.length) return '';
  return `<div class="list td-review-notes">${waiting.map(({ task, list }) => `<div class="row note" data-td="${TD.task}" data-task="${esc(task.id)}">${list.lead}
    <div class="r-text"><div class="r-name">${esc(task.text)}<span class="note-state n-attention">Review</span></div>
    <div class="r-line">${esc(task.review ? `${task.review.by}: ${task.review.summary}` : '')}</div></div></div>`).join('')}</div>`;
}
