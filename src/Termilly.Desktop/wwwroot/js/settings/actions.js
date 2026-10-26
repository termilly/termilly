// @ts-check
// Settings › Actions: the web pages and programs Termilly can start (js/actions.js runs them), and editing them:
// a name, what to open, a program's arguments, the keys that run it and whether it's on the right-click menu.

import { state, GROUPS } from '../store.js';
import { escapeHtml, ICONS } from '../ui.js';
import { updateSettings } from '../preferences.js';
import { send, onHost } from '../host.js';
import { PAGE, HOST } from '../protocol.js';
import { confirmDialog, noticeDialog } from '../dialogs.js';
import { targetOf } from '../dom.js';
import { chordOf, chordProblem, chordHtml } from '../actions.js';
import { group } from './controls.js';
import { SECTION, redraw } from './page.js';

/** Ready-made actions to add. */
const PRESETS = [
  { name: 'Search GitHub code', target: 'https://github.com/search?type=code&q={selection}', menu: true },
  { name: 'Search Stack Overflow', target: 'https://stackoverflow.com/search?q={selection}', menu: true },
  { name: 'Translate', target: 'https://translate.google.com/?sl=auto&tl=en&text={selection}', menu: true },
];
/** What a program action is, until the user types one. */
const NEW_ACTION = { name: 'New action', target: 'https://', menu: false };
const WEB_TARGET = /^\s*(https?:\/\/|\{repo\})/i;
const CLEAR_KEYS = ['Backspace', 'Delete'];
const CANCEL_KEY = 'Escape';

const actions = () => state.settings.commands.actions ?? [];

/**
 * A new action has only some of the fields; the host fills in the rest.
 * @param {Partial<ActionSetting>[]} list
 */
function saveActions(list) {
  updateSettings(GROUPS.commands, { actions: list });
}

/**
 * Changes one action.
 * @param {string | undefined} id
 * @param {Partial<ActionSetting>} patch
 */
const patchAction = (id, patch) => saveActions(actions().map(a => (a.id === id ? { ...a, ...patch } : a)));

/** @param {ActionSetting} a */
const actionRow = a => `
      <div class="act-row" data-act="${escapeHtml(a.id)}">
        <div class="act-line">
          <button class="switch" role="switch" data-act-enabled aria-checked="${a.enabled !== false}" aria-label="On" title="On"><span></span></button>
          <input class="field" data-act-field="name" value="${escapeHtml(a.name)}" aria-label="Name" spellcheck="false">
          <button class="btn small act-keys" data-act-keys title="The keys that run it while Termilly has focus. Backspace removes them.">${a.shortcut ? chordHtml(a.shortcut) : 'Add keys'}</button>
          <label class="act-menu" title="On a terminal’s right-click menu, when what it needs is there"><button class="switch" role="switch" data-act-menu aria-checked="${!!a.menu}"><span></span></button>Right-click menu</label>
          <button class="btn small" data-act-delete title="Remove">${ICONS.trash}</button>
        </div>
        <div class="act-line">
          <input class="field mono" data-act-field="target" value="${escapeHtml(a.target)}" aria-label="Web address or program" placeholder="https:// or a program" spellcheck="false">
          <input class="field mono" data-act-field="arguments" value="${escapeHtml(a.arguments ?? '')}" aria-label="Arguments" placeholder="Arguments" spellcheck="false"${WEB_TARGET.test(a.target) ? ' hidden' : ''}>
        </div>
      </div>`;

const placeholderHelp = `
    <p class="set-desc">A web address (<code>https://</code>) opens in your browser; anything else is a program, found on your PATH, with its arguments.
      Both can use <code>{selection}</code> (the selected text), <code>{folder}</code> (the terminal’s folder), <code>{file}</code> and <code>{line}</code>
      (a file path you select in the terminal, like <code>src/app.ts:42</code>, found from the terminal’s folder), <code>{repo}</code> and <code>{branch}</code> (the folder’s repository on the web) and <code>{port}</code> (a port a
      program in the terminal listens on). Each action is in the command palette; the ones on the right-click menu show when what they need is there.</p>`;

onHost(HOST.actionDefaults, m => {
  saveActions(m.actions);
  redraw();
});

/** @type {import('./page.js').Section} */
const ACTIONS = {
  id: SECTION.actions,
  label: 'Actions', icon: ICONS.launch,
  html: () => group('Your actions', `${placeholderHelp}${actions().map(actionRow).join('')}
    <div class="trigger-presets">
      <button class="btn small" data-action="addAction">${ICONS.plus}<span>Add action</span></button>
      ${PRESETS.map((p, i) => `<button class="btn small" data-action="addAction" data-preset="${i}">${p.name}</button>`).join('')}
      <button class="btn small" data-action="resetActions">Restore Termilly’s actions</button>
    </div>`),
  actions: {
    addAction: el => {
      const preset = PRESETS[Number(el?.dataset.preset)] ?? NEW_ACTION;
      saveActions([...actions(), { id: `act${Date.now().toString(36)}`, enabled: true, ...preset }]);
      redraw();
    },
    resetActions: async () => {
      if (!await confirmDialog({ title: 'Restore Termilly’s actions?', body: 'Your own actions and changes are replaced by the ones Termilly starts with.', confirm: 'Restore' })) return;
      send(PAGE.actionDefaults); // the host has them, and answers below
    },
  },
  click: actionClick,
  change: actionChange,
  input: e => {
    const field = targetOf(e);
    if (!field.matches('[data-act-field="target"]')) return;
    const args = /** @type {HTMLElement | null} */ (field.closest('[data-act]')?.querySelector('[data-act-field="arguments"]'));
    if (args) args.hidden = WEB_TARGET.test(/** @type {HTMLInputElement} */ (field).value);
  },
};

/**
 * An action's switch, keys, menu or delete button; true when it was one.
 * @param {MouseEvent} e
 */
function actionClick(e) {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-act]'));
  if (!row) return false;
  const id = row.dataset.act;
  const action = actions().find(a => a.id === id);
  if (!action) return false;
  if (targetOf(e).closest('[data-act-delete]')) saveActions(actions().filter(a => a.id !== id));
  else if (targetOf(e).closest('[data-act-enabled]')) patchAction(id, { enabled: action.enabled === false });
  else if (targetOf(e).closest('[data-act-menu]')) patchAction(id, { menu: !action.menu });
  else if (targetOf(e).closest('[data-act-keys]')) {
    captureKeys(/** @type {HTMLButtonElement} */ (targetOf(e).closest('[data-act-keys]')), action);
    return true;
  } else return false;
  redraw();
  return true;
}

/**
 * Its name, target or arguments changed; true when it was one.
 * @param {Event} e
 */
function actionChange(e) {
  const field = /** @type {HTMLInputElement | null} */ (targetOf(e).closest('[data-act-field]'));
  if (!field) return false;
  const id = /** @type {HTMLElement} */ (field.closest('[data-act]')).dataset.act;
  patchAction(id, { [/** @type {string} */ (field.dataset.actField)]: field.value });
  return true;
}

/**
 * Waits for the keys that will run the action: Esc or leaving the button keeps the old ones, Backspace or Delete
 * removes them. Taken before anything else sees them, so Termilly's own shortcuts don't run meanwhile.
 * @param {HTMLButtonElement} button
 * @param {ActionSetting} action
 */
function captureKeys(button, action) {
  button.textContent = 'Press the keys';
  button.classList.add('capturing');
  const stop = () => {
    window.removeEventListener('keydown', onKey, true);
    button.removeEventListener('blur', cancel);
  };
  const cancel = () => { stop(); redraw(); };
  /** @param {KeyboardEvent} e */
  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === CANCEL_KEY) return cancel();
    if (CLEAR_KEYS.includes(e.key) && !e.ctrlKey && !e.altKey) {
      stop();
      patchAction(action.id, { shortcut: null });
      return redraw();
    }
    const chord = chordOf(e);
    if (!chord) return; // a modifier on its own: wait for the key
    const problem = chordProblem(chord, action.id);
    stop();
    if (problem) {
      noticeDialog({ title: 'Choose other keys', body: problem }).then(redraw);
      return;
    }
    patchAction(action.id, { shortcut: chord });
    redraw();
  }
  window.addEventListener('keydown', onKey, true);
  button.addEventListener('blur', cancel);
}

export default ACTIONS;
