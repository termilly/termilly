// @ts-check
// The New workspace dialog: a name, a colour, a folder (with the layout a project offers) and, from a tab's menu, that
// tab to move into it.

import { state, WORKSPACE_COLORS, defaultProfile } from './store.js';
import { modal, pickFolder, FORM_DIALOG } from './dialogs.js';
import { profileOptionsHtml } from './ui.js';
import { createWorkspace, nameTaken, nameTakenMessage, MAX_WORKSPACE_NAME } from './workspaces.js';
import { moveTab } from './panes.js';
import { probeFolder, offerLayout, applyLayout } from './layouts.js';
import { field, find, targetOf } from './dom.js';

/** What a new workspace starts with. */
const START = Object.freeze({ tab: 'tab', empty: 'empty' });

/**
 * What the dialog's choices hold: the colour picked and what the workspace starts with (START).
 * @typedef {{ color: string, startWith: string }} NewWorkspaceForm
 */

/**
 * The dialog's markup; "Start with" only when no tab is being moved into the workspace.
 * @param {string} color
 * @param {boolean} askStart
 */
function newWorkspaceHtml(color, askStart) {
  return `
    <h3>New workspace</h3>
    <p class="dialog-sub">Group the terminals for one project or task.</p>
    <label class="dialog-field">Name
      <input class="field" name="name" placeholder="e.g. billing-service" maxlength="${MAX_WORKSPACE_NAME}" spellcheck="false" autofocus>
    </label>
    <p class="dialog-error" data-name-error hidden></p>
    <div class="dialog-field">Colour
      <div class="swatches" role="radiogroup">${WORKSPACE_COLORS.map(c =>
        `<button class="swatch${c === color ? ' on' : ''}" data-color="${c}" style="background:${c}" role="radio" aria-checked="${c === color}" aria-label="Colour"></button>`).join('')}</div>
    </div>
    <label class="dialog-field">Start folder
      <span class="field-row">
        <input class="field" name="cwd" placeholder="Your user folder" spellcheck="false">
        <button class="btn" data-browse data-no-enter>Browse</button>
      </span>
    </label>
    ${askStart ? `
    <div class="dialog-field">Start with
      <span class="field-row">
        <span class="seg" data-start>
          <button class="on" data-value="${START.tab}" data-no-enter>A terminal</button>
          <button data-value="${START.empty}" data-no-enter>Nothing</button>
        </span>
        <select class="field" name="profile" aria-label="Shell">${profileOptionsHtml(defaultProfile())}</select>
      </span>
    </div>` : ''}
    <div class="dialog-actions">
      <button class="btn" data-cancel data-no-enter>Cancel</button>
      <button class="btn primary" data-ok>Create workspace</button>
    </div>`;
}

/**
 * The New workspace dialog. With `moveTab`, the new workspace starts with that tab instead.
 * @param {{ moveTab?: Tab }} [options]
 */
export function openNewWorkspace({ moveTab: tabToMove } = {}) {
  const color = WORKSPACE_COLORS[state.workspaces.length % WORKSPACE_COLORS.length];
  return modal(FORM_DIALOG, newWorkspaceHtml(color, !tabToMove), (dialog, close) => {
    /** @type {NewWorkspaceForm} */
    const form = { color, startWith: START.tab };
    wireChoices(dialog, form);
    const nameInput = field(dialog, '[name=name]');
    const nameError = find(dialog, '[data-name-error]');
    nameInput.addEventListener('input', () => {
      nameError.hidden = true;
      nameInput.classList.remove('invalid');
    });

    const submit = () => {
      if (nameInput.value.trim() && nameTaken(nameInput.value)) {
        nameError.textContent = nameTakenMessage(nameInput.value);
        nameError.hidden = false;
        nameInput.classList.add('invalid');
        nameInput.select();
        return;
      }
      close(create(dialog, form, tabToMove));
    };
    return { submit };
  });
}

/**
 * The colour swatches, "Start with" and the folder's Browse button.
 * @param {HTMLElement} dialog
 * @param {NewWorkspaceForm} form
 */
function wireChoices(dialog, form) {
  find(dialog, '.swatches').addEventListener('click', e => {
    const swatch = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-color]'));
    if (!swatch) return;
    form.color = /** @type {string} */ (swatch.dataset.color);
    for (const s of dialog.querySelectorAll('.swatch')) {
      s.classList.toggle('on', s === swatch);
      s.setAttribute('aria-checked', String(s === swatch));
    }
  });
  dialog.querySelector('[data-start]')?.addEventListener('click', e => {
    const option = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-value]'));
    if (!option) return;
    form.startWith = /** @type {string} */ (option.dataset.value);
    for (const o of dialog.querySelectorAll('[data-start] [data-value]')) o.classList.toggle('on', o === option);
    /** @type {HTMLSelectElement} */ (dialog.querySelector('[name=profile]')).disabled = form.startWith !== START.tab;
  });
  const cwdInput = field(dialog, '[name=cwd]');
  find(dialog, '[data-browse]').addEventListener('click', async () => {
    const path = await pickFolder(cwdInput.value);
    if (path) cwdInput.value = path;
  });
}

/**
 * Creates the workspace the dialog describes, with the moved tab or what it starts with.
 * @param {HTMLElement} dialog
 * @param {NewWorkspaceForm} form
 * @param {Tab} [tabToMove]
 */
function create(dialog, form, tabToMove) {
  const ws = createWorkspace({
    name: field(dialog, '[name=name]').value,
    color: form.color,
    cwd: field(dialog, '[name=cwd]').value,
    startWith: tabToMove ? START.empty : form.startWith,
    profile: /** @type {HTMLSelectElement | null} */ (dialog.querySelector('[name=profile]'))?.value,
  });
  if (tabToMove) moveTab(tabToMove, ws.id);
  // A project folder with its own .termilly.yml: offer its terminals instead of the one just opened.
  else if (ws.cwd) offerProjectLayout(ws);
  return ws;
}

/**
 * Only for a workspace with a folder (create() checks).
 * @param {Workspace} ws
 */
async function offerProjectLayout(ws) {
  const found = await probeFolder(ws.cwd);
  if (found && await offerLayout(found)) applyLayout({ ...found.layout, cwd: found.layout.cwd ?? /** @type {string} */ (ws.cwd) }, { into: ws, warnings: found.warnings });
}
