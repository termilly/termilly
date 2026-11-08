// @ts-check
// What the To do tab draws (todo.js does the rest): the tree of lists, a list, a task's sheet and the sheets it leads to.

/** @typedef {{ at: number, text: string, done: boolean }} PhoneStep */
/**
 * A task as the PC sends it (js/phonetodo.js).
 * @typedef {{ id: string, text: string, status: string, tags: string[], details: string, notes: string, steps: PhoneStep[],
 *   agent: { id: string, title: string } | null, working?: boolean, review: { summary: string, by: string } | null,
 *   issue: { url: string, number: number } | null }} PhoneTask
 */
/**
 * A terminal's or workspace's list.
 * @typedef {{ kind: string, id: string, name: string, tasks: PhoneTask[], implement: boolean, github: boolean, lead: string,
 *   note: { text: string, pinned?: boolean } | null, ws?: PhoneList }} PhoneList
 */
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
  implementHow: 'implementHow',
});
/** Implement's two ways, as the PC's Implement menu has them. */
export const HOW = Object.freeze({ terminal: 'terminal', silent: 'silent' });
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

/** In a task's box while an agent is at work on it: the spinner terminals have. */
const SPINNER = '<span class="activity spin"></span>';

/**
 * A task's box: it ticks the task where the phone may, and only shows it where it may not. It spins while an agent is at
 * work on the task.
 * @param {string} status
 * @param {string} action what a tap does
 * @param {string} data its data attributes
 * @param {boolean} typing
 * @param {boolean} [working]
 */
function boxHtml(status, action, data, typing, working = false) {
  const cls = `td-box st-${esc(status)}${working ? ' working' : ''}`;
  const mark = working ? SPINNER : TICK;
  return typing ? `<button class="${cls}" data-td="${action}" ${data} aria-label="Done">${mark}</button>` : `<span class="${cls}">${mark}</span>`;
}

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
  return `<div class="row td-row${task.status === STATUS.done ? ' td-done' : ''}" data-td="${TD.task}" ${data}>${boxHtml(task.status, TD.check, data, ctx.typing, !!task.working)}
    <div class="r-text"><div class="r-name">${esc(task.text)}</div>
      ${task.agent ? `<div class="td-agent">${esc(task.agent.title)}</div>` : ''}
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
 */
export function listHtml(list, ctx, showDone) {
  const of = (/** @type {string} */ status) => list.tasks.filter(t => t.status === status);
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
  const rows = tasks.map(t => `<div class="row td-row" data-td="${TD.task}" data-task="${esc(t.id)}"><span class="td-box st-${STATUS.review}">${TICK}</span>
    <div class="r-text"><div class="r-name">${esc(t.text)}</div><div class="td-said">${esc(where(t))} · ${esc(t.review?.summary ?? '')}</div></div>
    ${typing ? `<button class="td-accept" data-td="${TD.status}" data-status="${STATUS.done}" data-task="${esc(t.id)}">Accept</button>` : ''}</div>`).join('');
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
    return `<div class="row td-step${s.done ? ' td-done' : ''}">${boxHtml(s.done ? STATUS.done : STATUS.open, TD.tick, data, typing)}<div class="r-text">${esc(s.text)}</div>${play}</div>`;
  }).join('');
  return `<div class="section td-section">Steps</div><div class="list">${rows}</div>`;
}

/** @param {PhoneTask} task @param {boolean} typing */
function saidHtml(task, typing) {
  if (task.status !== STATUS.review) return '';
  const said = task.review ? `<div class="td-review"><b>${esc(task.review.by)}</b>${esc(task.review.summary)}</div>` : '';
  if (!typing) return said;
  return `${said}<div class="td-btns"><button class="ibtn" data-td="${TD.status}" data-status="${STATUS.open}" data-task="${esc(task.id)}">Back to open</button><button class="ibtn fill" data-td="${TD.status}" data-status="${STATUS.done}" data-task="${esc(task.id)}">Accept</button></div>`;
}

/**
 * What a task's sheet can start, on the PC.
 * @param {PhoneTask} task
 * @param {boolean} canImplement
 * @param {boolean} canIssue
 */
function startsHtml(task, canImplement, canIssue) {
  const issue = canIssue && !task.issue ? `<button class="ibtn" data-td="${TD.issue}" data-task="${esc(task.id)}">GitHub issue</button>` : '';
  const implement = canImplement && task.status !== STATUS.review ? `<button class="ibtn fill" data-td="${TD.implement}" data-task="${esc(task.id)}">Implement</button>` : '';
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
    ${stepsHtml(task, typing, canImplement && task.status !== STATUS.review)}
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

/** Implement's two ways: in a new terminal, to watch and answer it, or Silent, in a hidden shell. @param {PhoneTask} task */
export const implementSheetHtml = task => `${headHtml('Implement')}<p>${esc(task.text)}</p><div class="list td-pick">
  <button class="row" data-td="${TD.implementHow}" data-how="${HOW.terminal}"><span class="r-text"><span class="r-name">In a new terminal</span><span class="r-meta">Claude Code works where you can watch it and answer it.</span></span></button>
  <button class="row" data-td="${TD.implementHow}" data-how="${HOW.silent}"><span class="r-text"><span class="r-name">Silent</span><span class="r-meta">Claude Code works in a hidden shell. The task goes to Review with its reply.</span></span></button></div>`;

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
