// @ts-check
// The Notes tab: the PC's notes on its workspaces and terminals (js/notes.js), each workspace with its terminals under
// it. A tap opens the note to read; with Settings › Remote › Allow typing on the PC, to edit, pin or remove as well.
// Saving goes through the manage op (js/phonemanage.js sets it as the PC's own editor does).

/** @typedef {{ text: string, pinned?: boolean } | null} PhoneNote */
/** @typedef {{ kind: string, id: string }} Editing */

/** What a note is on (js/notes.js NOTE_KIND), and what the tab's buttons do (data-memo). */
const KIND = Object.freeze({ workspace: 'workspace', terminal: 'terminal' });
const MEMO = Object.freeze({ open: 'open', save: 'save', remove: 'remove', back: 'back' });
const OP = 'manage';
const ACTION = 'note';
/** The editor's text box, and the mark that the editor is on screen (app.js leaves it alone while it is). */
const AREA = '[data-memo-text]';
export const MEMO_EDITOR = '[data-memo-editor]';

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** The first line with something in it, without markdown's heading and list marks (as js/notes.js firstLine). @param {string} text */
const firstLine = text => text.split(/\r?\n/).map(l => l.replace(/^\s*(#+|[-*]|\d+\.)\s+/, '').trim()).find(Boolean) ?? '';

/**
 * @param {{ snap: () => any, send: (m: object) => void, badge: (t: any) => string, redraw: () => void, toast: (text: string) => void }} app
 */
export function memosTab(app) {
  /** @type {Editing | null} */
  let editing = null;

  /** @param {Editing} e */
  const target = e => (e.kind === KIND.workspace ? app.snap().workspaces : app.snap().terminals).find((/** @type {any} */ x) => x.id === e.id) ?? null;

  /** @param {string} kind @param {any} x @param {string} lead what goes before the name: a colour dot or a badge */
  const rowHtml = (kind, x, lead) => `<button class="row memo${kind === KIND.terminal ? ' memo-term' : ''}" data-memo="${MEMO.open}" data-kind="${kind}" data-id="${esc(x.id)}">
    ${lead}<span class="r-text"><span class="r-name">${esc(x.name ?? x.title)}${x.note?.pinned ? ' <span class="memo-pin">pinned</span>' : ''}</span>
    <span class="r-line${x.note?.text ? '' : ' muted'}">${esc(x.note?.text ? firstLine(x.note.text) : 'No note')}</span></span></button>`;

  function listHtml() {
    const snap = app.snap();
    if (!snap.workspaces.length) return '<p class="muted center">No workspaces on your PC.</p>';
    return snap.workspaces.map((/** @type {any} */ w) => `<div class="list memo-ws">
      ${rowHtml(KIND.workspace, w, `<span class="dot" style="background:${esc(w.color)}"></span>`)}
      ${snap.terminals.filter((/** @type {any} */ t) => t.ws === w.id).map((/** @type {any} */ t) => rowHtml(KIND.terminal, t, app.badge(t))).join('')}</div>`).join('');
  }

  /** @param {Editing} e */
  function editorHtml(e) {
    const x = target(e);
    if (!x) return listHtml();
    const typing = !!app.snap().typing;
    const what = e.kind === KIND.workspace ? `Workspace · ${x.name}` : `Terminal · ${x.title}`;
    return `<div class="memo-editor" data-memo-editor>
      <div class="memo-head"><button class="link" data-memo="${MEMO.back}">‹ Notes</button><span class="muted">${esc(what)}</span></div>
      <textarea class="memo-text" data-memo-text rows="14" spellcheck="false" autocapitalize="sentences" placeholder="e.g. staging DB is read-only until Friday"${typing ? '' : ' readonly'}>${esc(x.note?.text ?? '')}</textarea>
      ${typing ? `<label class="memo-pinbox"><input type="checkbox" data-memo-pin${x.note?.pinned ? ' checked' : ''}> Pin the first line to ${e.kind === KIND.terminal ? 'the terminal’s header' : 'its terminals’ headers'}</label>
      <div class="memo-actions">${x.note?.text ? `<button class="button ghost" data-memo="${MEMO.remove}">Remove</button>` : ''}<span class="grow"></span><button class="button" data-memo="${MEMO.save}">Save</button></div>`
        : '<p class="muted">To edit notes from this phone, turn on Allow typing in Termilly’s Settings › Remote on the PC.</p>'}</div>`;
  }

  /**
   * Saves the note (empty removes it) on the PC, then goes back to the list.
   * @param {Editing} e
   * @param {string} text
   */
  function save(e, text) {
    const pinned = !!(/** @type {HTMLInputElement | null} */ (document.querySelector('[data-memo-pin]')))?.checked;
    app.send({ op: OP, action: ACTION, kind: e.kind, id: e.id, text: text.trim(), pinned });
    app.toast(text.trim() ? 'Note saved on the PC.' : 'Note removed.');
    editing = null;
    app.redraw();
  }

  return {
    html: () => (editing ? editorHtml(editing) : listHtml()),
    /** Whether the editor is open (its text is kept while the PC's news redraws the page). */
    editing: () => !!editing,
    /**
     * A tap in the tab; false when it wasn't one of its own.
     * @param {HTMLElement} el
     */
    click(el) {
      const button = /** @type {HTMLElement | null} */ (el.closest('[data-memo]'));
      if (!button) return false;
      const act = button.dataset.memo;
      if (act === MEMO.open) editing = { kind: button.dataset.kind ?? KIND.terminal, id: button.dataset.id ?? '' };
      else if (act === MEMO.back) editing = null;
      else if (editing && (act === MEMO.save || act === MEMO.remove)) {
        save(editing, act === MEMO.save ? /** @type {HTMLTextAreaElement} */ (document.querySelector(AREA)).value : '');
        return true;
      }
      app.redraw();
      document.getElementById('home')?.scrollTo(0, 0); // the page under the header scrolls, not the document
      return true;
    },
  };
}
