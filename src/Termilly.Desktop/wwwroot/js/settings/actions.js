// @ts-check
// Settings › Actions: the web pages and programs Termilly can start (js/actions.js runs them), and editing them:
// a name, what to open, a program's arguments, the keys that run it and whether it's on the right-click menu. Edits
// and new actions wait for their row's Save button; closing Settings with some waiting asks whether to save them.
// Deleting is at once.

import { state, GROUPS } from '../store.js';
import { escapeHtml, ICONS } from '../ui.js';
import { updateSettings } from '../preferences.js';
import { send, onHost } from '../host.js';
import { PAGE, HOST } from '../protocol.js';
import { confirmDialog, noticeDialog, saveDialog, SAVE_ANSWER } from '../dialogs.js';
import { targetOf } from '../dom.js';
import { chordProblem, chordHtml } from '../actions.js';
import { captureKeys as waitForKeys } from './keys.js';
import { group } from './controls.js';
import { SECTION, redraw, body, addCloseCheck } from './page.js';

/** What a new action is, until the user types one. */
const NEW_ACTION = { name: 'New action', target: 'https://', menu: false };
const WEB_TARGET = /^\s*(https?:\/\/|\{repo\})/i;
/** The variables an action's address or arguments can use (Actions.cs fills them in). */
const VARIABLES = '{selection} {url} {image} {file} {line} {folder} {repo} {branch} {port}';

/** The actions as saved. */
const saved = () => state.settings.commands.actions ?? [];
/** Changes not saved yet, by action id: only the fields that differ from what's saved. */
/** @type {Map<string, Partial<ActionSetting>>} */
const drafts = new Map();
/** Actions added and not saved yet, in the order they were added. */
/** @type {Map<string, ActionSetting>} */
const added = new Map();

/** The actions as shown: the saved ones with their changes, then the new ones. */
const shown = () => [...saved().map(a => ({ ...a, ...drafts.get(a.id) })), ...added.values()];
/** @param {string} id */
const unsaved = id => added.has(id) || drafts.has(id);

/**
 * Whether a field's value is the same as saved, reading a missing value as the field's default.
 * @param {string} key
 * @param {unknown} a
 * @param {unknown} b
 */
function same(key, a, b) {
  if (key === 'enabled') return (a !== false) === (b !== false);
  if (key === 'menu') return !!a === !!b;
  return (a || '') === (b || '');
}

/**
 * A new action has only some of the fields; the host fills in the rest.
 * @param {Partial<ActionSetting>[]} list
 */
function saveActions(list) {
  updateSettings(GROUPS.commands, { actions: list });
}

/**
 * Changes an action, waiting for Save; its row's Save button shows while it differs from what's saved.
 * @param {string} id
 * @param {Partial<ActionSetting>} patch
 */
function edit(id, patch) {
  const fresh = added.get(id);
  if (fresh) added.set(id, { ...fresh, ...patch });
  else {
    const base = /** @type {Record<string, unknown>} */ (saved().find(a => a.id === id) ?? {});
    const next = /** @type {Record<string, unknown>} */ ({ ...drafts.get(id), ...patch });
    for (const key of Object.keys(next)) if (same(key, next[key], base[key])) delete next[key];
    if (Object.keys(next).length) drafts.set(id, next);
    else drafts.delete(id);
  }
  const row = body.querySelector(`[data-act="${CSS.escape(id)}"]`);
  row?.classList.toggle('unsaved', unsaved(id));
  const save = /** @type {HTMLElement | null} */ (row?.querySelector('[data-act-save]') ?? null);
  if (save) save.hidden = !unsaved(id);
}

/** @param {string} id */
function saveRow(id) {
  const fresh = added.get(id);
  if (fresh) saveActions([...saved(), fresh]);
  else saveActions(saved().map(a => (a.id === id ? { ...a, ...drafts.get(id) } : a)));
  added.delete(id);
  drafts.delete(id);
}

/** Saves every change and new action at once. */
function saveAll() {
  saveActions([...saved().map(a => ({ ...a, ...drafts.get(a.id) })), ...added.values()]);
  drafts.clear();
  added.clear();
}

/** @param {ActionSetting} a */
const actionRow = a => `
      <div class="act-row${unsaved(a.id) ? ' unsaved' : ''}" data-act="${escapeHtml(a.id)}">
        <div class="act-line">
          <button class="switch" role="switch" data-act-enabled aria-checked="${a.enabled !== false}" aria-label="On" title="On"><span></span></button>
          <input class="field" data-act-field="name" value="${escapeHtml(a.name)}" aria-label="Name" spellcheck="false">
          <button class="btn small act-keys" data-act-keys title="The keys that run it while Termilly has focus. Backspace, or Ctrl+click, removes them.">${a.shortcut ? chordHtml(a.shortcut) : 'Add keys'}</button>
          <label class="act-menu" title="On a terminal’s right-click menu, when what it needs is there"><button class="switch" role="switch" data-act-menu aria-checked="${!!a.menu}"><span></span></button>Context menu</label>
          <button class="btn small act-save" data-act-save title="Save this action"${unsaved(a.id) ? '' : ' hidden'}>${ICONS.save}</button>
          <button class="btn small" data-act-delete title="Remove">${ICONS.trash}</button>
        </div>
        <div class="act-line">
          <input class="field mono" data-act-field="target" value="${escapeHtml(a.target)}" aria-label="Web address or program" placeholder="https:// or a program" spellcheck="false">
          <input class="field mono" data-act-field="arguments" value="${escapeHtml(a.arguments ?? '')}" aria-label="Arguments" placeholder="Arguments" spellcheck="false"${WEB_TARGET.test(a.target) ? ' hidden' : ''}>
        </div>
      </div>`;

onHost(HOST.actionDefaults, m => {
  saveActions(m.actions);
  redraw();
});

// Closing Settings with changes waiting: save them, drop them, or stay.
addCloseCheck(async () => {
  if (!drafts.size && !added.size) return true;
  const count = drafts.size + added.size;
  const answer = await saveDialog({
    title: 'Save your changes to actions?',
    body: `${count === 1 ? 'One action has' : `${count} actions have`} changes that aren’t saved.`,
  });
  if (answer === SAVE_ANSWER.save) saveAll();
  else if (answer === SAVE_ANSWER.discard) {
    drafts.clear();
    added.clear();
  }
  return answer !== null;
});

/** @type {import('./page.js').Section} */
const ACTIONS = {
  id: SECTION.actions,
  label: 'Actions', icon: ICONS.action,
  // Above the list, outside what scrolls: Add on the left, Restore on the right.
  tools: () => `<button class="btn small" data-action="addAction">${ICONS.plus}<span>Add action</span></button>
    <button class="btn small" data-action="resetActions">Restore Termilly’s actions</button>`,
  html: () => `<p class="set-desc act-vars">In the address or the arguments: <span class="mono">${escapeHtml(VARIABLES)}</span>. An action with {url} shows only for a link, with {image} only for an image.</p>`
    + group('', shown().map(actionRow).join('')),
  actions: {
    addAction: () => {
      const id = `act${Date.now().toString(36)}`;
      added.set(id, /** @type {ActionSetting} */ ({ id, enabled: true, ...NEW_ACTION }));
      redraw();
      // It's added at the end, likely out of sight: bring it into view with its name ready to type over.
      const name = /** @type {HTMLInputElement | null} */ (body.querySelector(`[data-act="${id}"] [data-act-field="name"]`));
      name?.scrollIntoView({ block: 'center' });
      name?.focus();
      name?.select();
    },
    resetActions: async () => {
      if (!await confirmDialog({ title: 'Restore Termilly’s actions?', body: 'Your own actions and changes are replaced by the ones Termilly starts with.', confirm: 'Restore' })) return;
      drafts.clear();
      added.clear();
      send(PAGE.actionDefaults); // the host has them, and answers below
    },
  },
  click: actionClick,
  input: e => {
    const field = /** @type {HTMLInputElement | null} */ (targetOf(e).closest('[data-act-field]'));
    const id = field?.closest('[data-act]')?.getAttribute('data-act');
    if (!field || !id) return;
    edit(id, { [/** @type {string} */ (field.dataset.actField)]: field.value });
    if (!field.matches('[data-act-field="target"]')) return;
    const args = /** @type {HTMLElement | null} */ (field.closest('[data-act]')?.querySelector('[data-act-field="arguments"]'));
    if (args) args.hidden = WEB_TARGET.test(field.value);
  },
};

/**
 * Removes an action: a saved one at once, a new one before it's saved.
 * @param {string} id
 */
function remove(id) {
  drafts.delete(id);
  if (!added.delete(id)) saveActions(saved().filter(a => a.id !== id));
}

/**
 * An action's switch, keys (Ctrl+click removes them), menu, save or delete button; true when it was one.
 * @param {MouseEvent} e
 */
function actionClick(e) {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-act]'));
  const id = row?.dataset.act;
  const action = shown().find(a => a.id === id);
  if (!id || !action) return false;
  const on = (/** @type {string} */ selector) => !!targetOf(e).closest(selector);
  if (on('[data-act-delete]')) remove(id);
  else if (on('[data-act-save]')) saveRow(id);
  else if (on('[data-act-enabled]')) edit(id, { enabled: action.enabled === false });
  else if (on('[data-act-menu]')) edit(id, { menu: !action.menu });
  else if (on('[data-act-keys]') && e.ctrlKey) edit(id, { shortcut: null });
  else if (on('[data-act-keys]')) {
    captureKeys(/** @type {HTMLButtonElement} */ (targetOf(e).closest('[data-act-keys]')), action);
    return true;
  } else return false;
  redraw();
  return true;
}

/**
 * Waits for the keys that will run the action: Esc or leaving the button keeps the old ones, Backspace or Delete
 * removes them. Taken before anything else sees them, so Termilly's own shortcuts don't run meanwhile.
 * @param {HTMLButtonElement} button
 * @param {ActionSetting} action
 */
function captureKeys(button, action) {
  waitForKeys(button, {
    cancelled: redraw,
    cleared: () => {
      edit(action.id, { shortcut: null });
      redraw();
    },
    chosen: chord => {
      const problem = chordProblem(chord, action.id);
      if (problem) {
        noticeDialog({ title: 'Choose other keys', body: problem }).then(redraw);
        return;
      }
      edit(action.id, { shortcut: chord });
      redraw();
    },
  });
}

export default ACTIONS;
