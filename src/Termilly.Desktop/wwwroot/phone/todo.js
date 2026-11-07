// @ts-check
// The To do tab: the PC's lists on its workspaces and terminals, as a tree, with what waits for review on top. A list opens to
// its note and tasks, and a task to a sheet. With Settings › Remote › Allow typing on the PC they can be changed as well;
// that goes through the manage op (js/phonetodo.js). The note is the one js/notes.js keeps.

import {
  STATUS, TD, FIELD, esc, openTasks, listHtml, listHeadHtml, homeHtml, findHtml, taskSheetHtml, addSheetHtml, editSheetHtml, moveSheetHtml,
  tagsSheetHtml, removeSheetHtml, issueSheetHtml, noteHtml, markHtml, reviewNotesHtml,
} from './todoviews.js';

/** @typedef {import('./todoviews.js').PhoneList} PhoneList */
/** @typedef {import('./todoviews.js').PhoneTask} PhoneTask */

const OP = 'manage';
/** What's asked of the PC (js/phonetodo.js TODO_ACTION, and js/phonemanage.js for the note). */
const ACTION = Object.freeze({
  add: 'taskAdd', status: 'taskStatus', tick: 'taskTick', edit: 'taskEdit', move: 'taskMove', remove: 'taskDelete',
  implement: 'taskImplement', noteTasks: 'noteTasks', issueInfo: 'issueInfo', issueCreate: 'issueCreate', note: 'note',
});
const OWN_ACTIONS = new Set(Object.values(ACTION));
/** What a list can be on. */
const KIND = Object.freeze({ workspace: 'workspace', terminal: 'terminal' });
/** The sheets over a list. */
const SHEET = Object.freeze({ add: 'add', task: 'task', edit: 'edit', move: 'move', tags: 'tags', remove: 'remove', issue: 'issue' });
/** The sheets with fields in them: what comes from the PC doesn't draw them again. */
const FORMS = new Set([SHEET.add, SHEET.edit, SHEET.issue]);
const TODO_BODY = '[data-todo-body]';
const THE_SHEET = 'todo-sheet';
const TICKED = 'st-done';
const SHEET_BOX = '.sheet';
const HOME = 'home';

/** @param {string} lead @param {any} x @param {string} kind @param {PhoneList} [ws] @returns {PhoneList} */
const listFrom = (lead, x, kind, ws) => ({
  kind, id: x.id, name: x.name ?? x.title, tasks: x.todo?.tasks ?? [], implement: !!x.todo?.implement, github: !!x.todo?.github, note: x.note ?? null, lead, ws,
});

/**
 * @param {{ snap: () => any, send: (m: object) => void, badge: (t: any) => string, redraw: () => void, toast: (text: string) => void,
 *   openTerminal: (id: string) => void, show: () => void }} app
 */
export function todoTab(app) {
  /** The list open, by its kind and id. */
  /** @type {{ kind: string, id: string } | null} */
  let open = null;
  let onNote = false;
  /** @type {{ mode: string, task: string, issue?: any } | null} */
  let sheet = null;
  let query = '';
  let showAll = false;
  let showDone = false;
  /** A terminal Implement opened, shown once it's listed. */
  let starting = '';

  /** @param {object} m */
  const ask = m => app.send({ op: OP, ...m });
  const allowed = () => ({ tags: app.snap().tags ?? [], typing: !!app.snap().typing, opening: !!app.snap().opening });
  /** @param {any} w */
  const wsList = w => listFrom(`<span class="dot" style="background:${esc(w.color)}"></span>`, w, KIND.workspace);

  /** The workspaces, each with its terminals. */
  function groups() {
    const { workspaces, terminals } = app.snap();
    return workspaces.map((/** @type {any} */ w) => {
      const ws = wsList(w);
      return { ws, terms: terminals.filter((/** @type {any} */ t) => t.ws === w.id).map((/** @type {any} */ t) => listFrom(app.badge(t), t, KIND.terminal, ws)) };
    });
  }
  /** @returns {PhoneList[]} */
  const lists = () => groups().flatMap((/** @type {{ ws: PhoneList, terms: PhoneList[] }} */ g) => [g.ws, ...g.terms]);
  const current = () => (open ? lists().find(l => l.kind === open?.kind && l.id === open?.id) ?? null : null);

  /** @param {string} id */
  function findTask(id) {
    for (const list of lists()) {
      const task = list.tasks.find(t => t.id === id);
      if (task) return { list, task };
    }
    return null;
  }

  const reviewing = () => lists().flatMap(list => list.tasks.filter(t => t.status === STATUS.review).map(task => ({ task, list })));

  /** @param {string} kind @param {string} id */
  const listOf = (kind, id) => lists().find(l => l.kind === kind && l.id === id);

  /** @param {PhoneList} list */
  const hasSomething = list => !!list.note?.text || openTasks(list).length > 0;
  /** @param {PhoneList} list */
  const matches = list => [list.name, ...openTasks(list).map(t => t.text)].some(text => text.toLowerCase().includes(query));

  /** The tree as it shows: what's found, or what has something in it. */
  function shownGroups() {
    const keep = query ? matches : showAll ? () => true : hasSomething;
    return groups().map((/** @type {{ ws: PhoneList, terms: PhoneList[] }} */ g) => ({ ws: g.ws, terms: g.terms.filter(keep) }))
      .filter((/** @type {{ ws: PhoneList, terms: PhoneList[] }} */ g) => keep(g.ws) || g.terms.length);
  }

  function homeBody() {
    const waiting = reviewing();
    const shown = shownGroups();
    const hidden = lists().length > shown.reduce((/** @type {number} */ n, /** @type {{ terms: PhoneList[] }} */ g) => n + 1 + g.terms.length, 0);
    return homeHtml({
      groups: shown, review: waiting.map(w => w.task), where: t => waiting.find(w => w.task === t)?.list.name ?? '',
      typing: allowed().typing, searching: !!query, showAll, hidden,
    });
  }

  /** @param {HTMLElement} el @param {string} name */
  const field = (el, name) => /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (el.querySelector(`[data-field="${name}"]`));

  /** Whether the note's page shows: it leaves with the note, which then has no way back. */
  const onNotePage = () => onNote && !!current()?.note?.text;

  /** Which page shows; the same one keeps its fields while the PC's news comes in. */
  function pageOf() {
    const list = current();
    if (open && !list) open = null;
    onNote = onNotePage();
    return list ? `${onNote ? 'note' : 'list'}:${list.kind}:${list.id}:${allowed().typing}` : HOME;
  }

  /**
   * Draws the tab in its place. Only what's under the fields changes, so a keyboard stays up and what's typed stays.
   * @param {HTMLElement} home
   */
  function fill(home) {
    const page = pageOf();
    const list = current();
    if (home.dataset.todoPage !== page || !home.querySelector(TODO_BODY)) {
      home.dataset.todoPage = page;
      const top = list ? (onNote ? noteHtml(list, allowed().typing) : listHeadHtml(list, allowed().typing)) : findHtml();
      home.innerHTML = `${top}<div data-todo-body></div>`;
      if (!list) /** @type {HTMLInputElement} */ (field(home, FIELD.find)).value = query;
    }
    if (onNote && list) return;
    const body = /** @type {HTMLElement} */ (home.querySelector(TODO_BODY));
    body.innerHTML = list ? listHtml(list, allowed(), showDone) : homeBody();
  }

  /** Whether what the sheet is about is gone. */
  const sheetGone = () => !!sheet && !(sheet.mode === SHEET.add ? current() : findTask(sheet.task));

  /** The sheet's insides. */
  function sheetBody() {
    const newOn = sheet?.mode === SHEET.add ? current() : null;
    if (newOn) return addSheetHtml(newOn);
    const found = sheet ? findTask(sheet.task) : null;
    if (!sheet || !found) return '';
    const { task, list } = found;
    switch (sheet.mode) {
      case SHEET.edit: return editSheetHtml(task);
      case SHEET.move: return moveSheetHtml(task, /** @type {PhoneList} */ (lists().find(l => l.id === list.id && l.kind === list.kind)), lists());
      case SHEET.tags: return tagsSheetHtml(task, allowed());
      case SHEET.remove: return removeSheetHtml(task);
      case SHEET.issue: return issueSheetHtml(sheet.issue ?? {});
      default: return taskSheetHtml(task, list, allowed());
    }
  }

  /** Draws the sheet, unless it's a form being filled in; it stays where it was scrolled to. */
  function drawSheet(force = false) {
    const layer = document.getElementById(THE_SHEET);
    if (!layer) return;
    if (sheetGone()) sheet = null;
    if (!sheet) {
      layer.innerHTML = '';
      return;
    }
    const was = layer.querySelector(SHEET_BOX);
    if (was && FORMS.has(sheet.mode) && !force) return;
    const top = was?.scrollTop ?? 0;
    // A new task isn't dropped by a tap beside it: that tap may only be meant to put the keyboard away.
    layer.innerHTML = sheet.mode === SHEET.add
      ? `<div class="dim"></div><div class="sheet td-sheet td-top">${sheetBody()}</div>`
      : `<div class="dim" data-td="${TD.close}"></div><div class="sheet td-sheet"><div class="grabber" data-td="${TD.close}"></div>${sheetBody()}</div>`;
    /** @type {HTMLElement} */ (layer.querySelector(SHEET_BOX)).scrollTop = top;
  }

  /** @param {string} mode */
  function toSheet(mode) {
    if (!sheet) return;
    sheet = { ...sheet, mode };
    drawSheet(true);
  }

  /** @param {string} id */
  function openSheet(id) {
    sheet = { mode: SHEET.task, task: id };
    drawSheet(true);
  }

  /** @param {string} id @param {number | undefined} [at] the step */
  function implement(id, at) {
    ask({ action: ACTION.implement, task: id, ...(at === undefined ? {} : { at }) });
  }

  function beginIssue() {
    if (!sheet) return;
    sheet = { ...sheet, mode: SHEET.issue, issue: {} };
    drawSheet(true);
    ask({ action: ACTION.issueInfo, task: sheet.task });
  }

  /** @param {HTMLElement} layer */
  function createIssue(layer) {
    if (!sheet?.issue?.repo) return;
    const title = field(layer, FIELD.title)?.value.trim() ?? '';
    const body = field(layer, FIELD.body)?.value ?? '';
    if (!title) return;
    const { repo, ticked } = sheet.issue;
    sheet = { ...sheet, issue: { ...sheet.issue, title, body, busy: true, error: undefined } };
    drawSheet(true);
    ask({ action: ACTION.issueCreate, task: sheet.task, repo, title, body, labels: ticked ?? [] });
  }

  /** @param {string} label */
  function toggleLabel(label) {
    const issue = sheet?.issue;
    const layer = document.getElementById(THE_SHEET);
    if (!sheet || !issue || !layer) return;
    const ticked = issue.ticked ?? [];
    sheet = { ...sheet, issue: {
      ...issue, title: field(layer, FIELD.title)?.value, body: field(layer, FIELD.body)?.value,
      ticked: ticked.includes(label) ? ticked.filter((/** @type {string} */ l) => l !== label) : [...ticked, label],
    } };
    drawSheet(true);
  }

  /** @param {HTMLElement} layer */
  function beginAdd(layer) {
    sheet = { mode: SHEET.add, task: '' };
    drawSheet(true);
    field(layer, FIELD.add)?.focus();
  }

  /** @param {HTMLElement} layer */
  function addTask(layer) {
    const box = field(layer, FIELD.add);
    const list = current();
    if (!box?.value.trim() || !list) return;
    ask({ action: ACTION.add, kind: list.kind, id: list.id, text: box.value, details: field(layer, FIELD.details)?.value ?? '' });
    sheet = null;
    drawSheet();
  }

  /** The note's actions. @param {string} act @param {HTMLElement} home */
  function noteAction(act, home) {
    const list = current();
    const area = /** @type {HTMLTextAreaElement | null} */ (field(home, FIELD.note));
    if (!list || !area) return;
    const pinned = !!(/** @type {HTMLInputElement | null} */ (field(home, FIELD.pin)))?.checked;
    if (act === TD.noteTasks) {
      ask({ action: ACTION.noteTasks, kind: list.kind, id: list.id, text: area.value, from: area.selectionStart, to: area.selectionEnd, pinned });
      return;
    }
    const text = act === TD.noteSave ? area.value.trim() : '';
    ask({ action: ACTION.note, kind: list.kind, id: list.id, text, pinned });
    app.toast(text ? 'Note saved on the PC.' : 'Note removed.');
    onNote = false;
    app.redraw();
  }

  /**
   * What a task's sheet does to its task.
   * @param {string | undefined} act
   * @param {HTMLElement} el
   * @param {HTMLElement} layer
   * @returns {boolean} whether it was one of these
   */
  function sheetAction(act, el, layer) {
    const task = sheet ? findTask(sheet.task)?.task : null;
    if (!sheet || !task) return false;
    switch (act) {
      case TD.tags: toSheet(SHEET.tags); return true;
      case TD.tag: {
        const tag = el.dataset.tag ?? '';
        ask({ action: ACTION.edit, task: task.id, tags: task.tags.includes(tag) ? task.tags.filter(t => t !== tag) : [...task.tags, tag] });
        return true;
      }
      case TD.edit: toSheet(SHEET.edit); return true;
      case TD.save: {
        ask({ action: ACTION.edit, task: task.id, text: field(layer, FIELD.text)?.value ?? '', details: field(layer, FIELD.details)?.value ?? '' });
        sheet = { ...sheet, mode: SHEET.task };
        return true;
      }
      case TD.move: toSheet(SHEET.move); return true;
      case TD.moveTo: {
        ask({ action: ACTION.move, task: task.id, toKind: el.dataset.kind, toId: el.dataset.id });
        sheet = null;
        return true;
      }
      case TD.remove: toSheet(SHEET.remove); return true;
      case TD.removeYes: {
        ask({ action: ACTION.remove, task: task.id });
        sheet = null;
        return true;
      }
      case TD.toTask: toSheet(SHEET.task); return true;
      case TD.issue: beginIssue(); return true;
      case TD.label: toggleLabel(el.dataset.label ?? ''); return true;
      case TD.create: createIssue(layer); return true;
      default: return false;
    }
  }

  /**
   * A box shows the tap at once; what the PC says next draws it for good.
   * @param {HTMLElement} box
   */
  const showTap = box => box.classList.toggle(TICKED);

  /** @param {HTMLElement} box */
  function pressBox(box) {
    const id = box.dataset.task ?? '';
    const task = findTask(id)?.task;
    if (!task) return;
    showTap(box);
    ask({ action: ACTION.status, task: id, status: task.status === STATUS.done ? STATUS.open : STATUS.done });
  }

  /** @param {HTMLElement} box */
  function pressStep(box) {
    showTap(box);
    ask({ action: ACTION.tick, task: box.dataset.task, at: Number(box.dataset.at), done: !!box.dataset.done });
  }

  /**
   * Shows a task in its list, from any tab: a tapped alert or notification, or the row itself.
   * @param {string} id
   * @returns {boolean} whether there is one
   */
  function openTask(id) {
    const found = findTask(id);
    if (!found) return false;
    open = { kind: found.list.kind, id: found.list.id };
    onNote = false;
    app.show();
    openSheet(id);
    return true;
  }

  /**
   * What the tab itself does.
   * @param {string | undefined} act
   * @param {HTMLElement} el
   * @param {HTMLElement} home
   * @param {HTMLElement} layer
   */
  function pageAction(act, el, home, layer) {
    const id = el.dataset.task ?? '';
    switch (act) {
      case TD.open:
        open = { kind: el.dataset.kind ?? KIND.terminal, id: el.dataset.id ?? '' };
        onNote = false;
        app.show();
        break;
      case TD.back:
        if (onNote) onNote = false;
        else open = null;
        break;
      case TD.add: return beginAdd(layer);
      case TD.addSave: return addTask(layer);
      case TD.task: return void openTask(id);
      case TD.check: return pressBox(el);
      case TD.status: return void ask({ action: ACTION.status, task: id, status: el.dataset.status });
      case TD.tick: return pressStep(el);
      case TD.terminal: return app.openTerminal(el.dataset.id ?? '');
      case TD.implement: return implement(id, el.dataset.at === undefined ? undefined : Number(el.dataset.at));
      case TD.close: sheet = null; return drawSheet();
      case TD.note: onNote = true; break;
      case TD.noteSave:
      case TD.noteRemove:
      case TD.noteTasks: return noteAction(act, home);
      case TD.showAll: showAll = !showAll; break;
      case TD.showDone: showDone = !showDone; break;
      default: return;
    }
    app.redraw();
    home.scrollTo(0, 0);
  }

  return {
    fill,
    drawSheet,
    /** The page's title, and what's in the header beside it. */
    title: () => {
      const list = current();
      return list ? (onNotePage() ? 'Note' : list.name) : '';
    },
    backHtml: () => (current() ? `<button class="back-row" data-td="${TD.back}">‹ ${onNotePage() ? esc(current()?.name) : 'To do'}</button>` : ''),
    /** Only a list with a note has one: tasks took over from notes, so a new note can't be started here. */
    noteButton: () => (current()?.note?.text && !onNotePage() ? `<button class="link" data-td="${TD.note}">Note</button>` : ''),
    /** How many tasks wait for review, for the tab's number. */
    reviewCount: () => reviewing().length,
    reviewNotes: () => reviewNotesHtml(reviewing()),
    /** @param {string} id */
    mark: id => markHtml(listOf(KIND.terminal, id)),
    /** @param {string} id */
    workspaceMark: id => markHtml(listOf(KIND.workspace, id)),
    openTask,
    /**
     * A tap; false when it wasn't To do's.
     * @param {HTMLElement} target
     */
    click(target) {
      const el = /** @type {HTMLElement | null} */ (target.closest('[data-td]'));
      const layer = document.getElementById(THE_SHEET);
      const home = document.getElementById(HOME);
      if (!el || !layer || !home) return false;
      const act = el.dataset.td;
      if (sheetAction(act, el, layer)) drawSheet();
      else pageAction(act, el, home, layer);
      return true;
    },
    /** @param {Event} e */
    typed(e) {
      const box = /** @type {HTMLInputElement} */ (e.target);
      if (box.dataset.field !== FIELD.find) return;
      query = box.value.trim().toLowerCase();
      app.redraw();
    },
    /** @param {KeyboardEvent} e */
    key(e) {
      const box = /** @type {HTMLInputElement} */ (e.target);
      const layer = document.getElementById(THE_SHEET);
      if (e.key !== 'Enter' || box.dataset.field !== FIELD.add || !layer) return;
      e.preventDefault();
      addTask(layer);
    },
    /**
     * The PC's answer to something asked.
     * @param {{ ok: boolean, op?: string, action?: string, id?: string, error?: string, count?: number, number?: number } & Record<string, any>} m
     * @returns {boolean} whether it was To do's
     */
    answered(m) {
      if (m.op !== OP || !OWN_ACTIONS.has(m.action ?? '')) return false;
      if (!m.ok && sheet?.mode === SHEET.issue) {
        sheet = { ...sheet, issue: { ...sheet.issue, busy: false, error: m.error } };
        drawSheet(true);
      } else if (!m.ok) app.toast(m.error ?? 'That didn’t go through.');
      else if (m.action === ACTION.implement) {
        starting = m.id ?? '';
        sheet = null;
        drawSheet();
      } else if (m.action === ACTION.noteTasks) {
        app.toast(`${m.count} ${m.count === 1 ? 'task' : 'tasks'} added.`);
        onNote = false;
        app.redraw();
      } else if (m.action === ACTION.issueInfo && sheet?.mode === SHEET.issue) {
        sheet = { ...sheet, issue: { repo: m.repo, labels: m.labels, ticked: m.ticked, title: m.title, body: m.body } };
        drawSheet(true);
      } else if (m.action === ACTION.issueCreate) {
        app.toast(`Issue #${m.number} created.`);
        toSheet(SHEET.task);
      }
      return true;
    },
    /** The PC's news came in: a terminal Implement opened is shown once it's there. */
    changed() {
      if (!starting || !app.snap().terminals.some((/** @type {any} */ t) => t.id === starting)) return;
      const id = starting;
      starting = '';
      app.openTerminal(id);
    },
  };
}
