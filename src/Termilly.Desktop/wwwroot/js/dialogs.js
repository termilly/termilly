// @ts-check
// Modal dialogs: new workspace, and a small confirm. Built in the page (no browser dialogs, which would
// block the WebView).

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { newId, emit, EVENTS } from './store.js';
import { closeAll, anyOpen, dropdown } from './popups.js';
import { escapeHtml, badgeHtml } from './ui.js';
import { SETTING_VALUES } from './constants.js';
import { find, field as fieldIn, targetOf, showError } from './dom.js';

/**
 * Asks the host for a folder (native picker). Resolves to the path, or null when cancelled.
 * @param {string} [initial]
 * @returns {Promise<string | null>}
 */
export function pickFolder(initial) {
  return request(PAGE.dialogPickFolder, { initial }).then(m => m.path ?? null);
}

/**
 * Shows a modal; `build` fills it and returns { submit }, what Enter and the OK button ([data-ok]) do, and `ok` when
 * the button does something Enter mustn't. The Cancel button ([data-cancel]) closes it, as Escape does. Resolves with
 * what close() was given (null when cancelled). A modal that isn't `dismissable` ignores Escape and backdrop clicks
 * (it must be answered).
 * @template T
 * @param {string} className
 * @param {string} html
 * @param {(dialog: HTMLElement, close: (result: T | null) => void) => { submit: () => unknown, ok?: () => unknown }} build
 * @param {{ dismissable?: boolean }} [options]
 * @returns {Promise<T | null>}
 */
export function modal(className, html, build, { dismissable = true } = {}) {
  closeAll();
  const layer = document.createElement('div');
  layer.className = 'modal-layer';
  layer.innerHTML = `<div class="dialog ${className}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(layer);
  const dialog = /** @type {HTMLElement} */ (layer.firstElementChild);

  return new Promise(resolve => {
    /** @param {T | null} result */
    const close = result => {
      layer.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
      emit(EVENTS.dialogClosed);
    };
    const { submit, ok = submit } = build(dialog, close);
    dialog.querySelector('[data-cancel]')?.addEventListener('click', () => close(null));
    dialog.querySelector('[data-ok]')?.addEventListener('click', () => ok());
    // Selects open the app's own menu (popups.js), which handles its keys while it's open.
    for (const select of /** @type {NodeListOf<HTMLSelectElement>} */ (dialog.querySelectorAll(SELECT_FIELD))) dropdown(select);
    /** @param {KeyboardEvent} e */
    const onKey = e => {
      if (anyOpen()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (dismissable) close(null);
      } else if (e.key === 'Enter' && (e.ctrlKey || !targetOf(e).closest('textarea, [data-no-enter]'))) {
        // Enter submits, except in a text area, where it's a new line and Ctrl+Enter submits.
        e.preventDefault();
        e.stopPropagation();
        submit();
      } else {
        e.stopPropagation(); // typing in a dialog must not trigger app shortcuts
      }
    };
    document.addEventListener('keydown', onKey, true);
    layer.addEventListener('mousedown', e => {
      if (dismissable && e.target === layer) close(null);
    });
    /** @type {HTMLElement | null} */ (dialog.querySelector('[autofocus]'))?.focus();
  });
}

/**
 * Asks to confirm something (a delete, closing a workspace). Resolves true to go ahead.
 * @param {{ title: string, body: string, confirm?: string }} question
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, body, confirm = OK_LABEL }) {
  return modal(CONFIRM_DIALOG, `
    <h3>${escapeHtml(title)}</h3>
    <p class="dialog-sub">${escapeHtml(body)}</p>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn danger" data-ok autofocus>${escapeHtml(confirm)}</button>
    </div>`, (dialog, close) => {
    return { submit: () => close(true) };
  }).then(result => result === true);
}

/** The class of the small confirm dialog. */
export const CONFIRM_DIALOG = 'confirm';
/** The class of a dialog that's a form (New workspace, a worktree, a sync code). */
export const FORM_DIALOG = 'new-workspace';
/** The confirm button's label when the question names none. */
const OK_LABEL = 'OK';
/** The selects a dialog shows as the app's own dropdowns. */
const SELECT_FIELD = 'select.field';
/** Where a dialog says what's wrong with what was entered. */
export const DIALOG_ERROR = '.dialog-error';
/** What the id of a profile made in the editor starts with. */
const CUSTOM_ID_PREFIX = 'custom';
/** The profile editor's fields, by their name attribute. */
const FIELD = Object.freeze({ name: 'name', command: 'command', cwd: 'cwd', env: 'env', tags: 'tags' });

/** The badges a profile of the user's own can have (the first when it names none). */
const PROFILE_ICONS = SETTING_VALUES.profileIcon.all;

/**
 * "NAME=value" lines to an object (blank lines and lines without "=" are skipped).
 * @param {string} text
 */
const parseVariables = text => Object.fromEntries(text.split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#') && line.indexOf('=') > 0)
  .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));

/** What the profile editor resolves with when the profile is to be deleted. */
export const PROFILE_DELETED = 'delete';

/** The badge a profile gets when it names none (or one the editor doesn't offer). */
const DEFAULT_ICON = PROFILE_ICONS[0];
/** The longest profile name. */
const MAX_PROFILE_NAME = 40;

/**
 * The editor's markup for a profile; `editing` adds Delete and says Save.
 * @param {CustomProfile} p
 * @param {boolean} editing
 */
function profileEditorHtml(p, editing) {
  const variables = Object.entries(p.environment ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
  return `
    <h3>${editing ? 'Edit profile' : 'New profile'}</h3>
    <p class="dialog-sub">Any command that runs in a terminal: a shell with arguments, ssh, docker exec, kubectl exec…</p>
    <label class="dialog-field">Name
      <input class="field" name="${FIELD.name}" value="${escapeHtml(p.name)}" maxlength="${MAX_PROFILE_NAME}" spellcheck="false" placeholder="e.g. API server" autofocus>
    </label>
    <label class="dialog-field">Command line
      <input class="field mono" name="${FIELD.command}" value="${escapeHtml(p.commandLine)}" spellcheck="false" placeholder="e.g. pwsh.exe -NoLogo -NoExit -Command npm run dev">
    </label>
    <label class="dialog-field">Start folder
      <span class="field-row">
        <input class="field" name="${FIELD.cwd}" value="${escapeHtml(p.workingDirectory ?? '')}" spellcheck="false" placeholder="The workspace’s folder">
        <button class="btn" data-browse data-no-enter>Browse</button>
      </span>
    </label>
    <label class="dialog-field">Environment variables
      <textarea class="field mono" name="${FIELD.env}" rows="3" spellcheck="false" placeholder="NODE_ENV=development&#10;AWS_PROFILE=staging">${escapeHtml(variables)}</textarea>
    </label>
    <label class="dialog-field">Tags
      <input class="field" name="${FIELD.tags}" value="${escapeHtml((p.tags ?? []).join(', '))}" spellcheck="false" placeholder="e.g. prod, ops">
    </label>
    <div class="dialog-field">Badge
      <span class="seg" data-icon-choice>${PROFILE_ICONS.map(icon =>
        `<button data-value="${icon}" data-no-enter class="${icon === p.icon ? 'on' : ''}">${badgeHtml({ icon })}</button>`).join('')}</span>
    </div>
    <p class="dialog-note">Saved in settings.json without encryption. Keep passwords and tokens out of the variables;
      ssh keys, kubeconfig and cloud logins already work through the commands themselves.</p>
    <p class="dialog-error" hidden></p>
    <div class="dialog-actions">
      ${editing ? '<button class="btn danger-outline" data-delete data-no-enter>Delete</button><span class="spacer"></span>' : ''}
      <button class="btn" data-cancel data-no-enter>Cancel</button>
      <button class="btn primary" data-ok>${editing ? 'Save' : 'Add profile'}</button>
    </div>`;
}

/**
 * Adds or edits one of the user's own profiles. Resolves with the profile to save, PROFILE_DELETED, or null (cancelled).
 * Stored in settings.json, unencrypted, so the dialog says to keep secrets out of the variables.
 * @param {CustomProfile | null} [profile]
 * @returns {Promise<CustomProfile | typeof PROFILE_DELETED | null>}
 */
export function openProfileEditor(profile = null) {
  /** @type {CustomProfile} */
  const p = profile ?? { id: newId(CUSTOM_ID_PREFIX), name: '', commandLine: '', workingDirectory: '', environment: {}, tags: [], icon: DEFAULT_ICON };
  return modal('profile-editor', profileEditorHtml(p, !!profile), (dialog, close) => {
    const field = (/** @type {string} */ name) => fieldIn(dialog, `[name=${name}]`);
    const error = find(dialog, DIALOG_ERROR);
    let icon = PROFILE_ICONS.includes(p.icon) ? p.icon : DEFAULT_ICON;

    find(dialog, '[data-icon-choice]').addEventListener('click', e => {
      const choice = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-value]'));
      if (!choice) return;
      icon = choice.dataset.value ?? DEFAULT_ICON;
      for (const b of dialog.querySelectorAll('[data-icon-choice] [data-value]')) b.classList.toggle('on', b === choice);
    });
    find(dialog, '[data-browse]').addEventListener('click', async () => {
      const path = await pickFolder(field(FIELD.cwd).value);
      if (path) field(FIELD.cwd).value = path;
    });

    const submit = () => {
      const name = field(FIELD.name).value.trim();
      const commandLine = field(FIELD.command).value.trim();
      if (!name || !commandLine) {
        showError(error, !name ? 'Give the profile a name.' : 'Enter the command to run.');
        (!name ? field(FIELD.name) : field(FIELD.command)).focus();
        return;
      }
      close({
        id: p.id,
        name,
        commandLine,
        workingDirectory: field(FIELD.cwd).value.trim() || null,
        environment: parseVariables(field(FIELD.env).value),
        tags: field(FIELD.tags).value.split(',').map(t => t.trim()).filter(Boolean),
        icon,
      });
    };
    dialog.querySelector('[data-delete]')?.addEventListener('click', () => close(PROFILE_DELETED));
    return { submit };
  });
}
