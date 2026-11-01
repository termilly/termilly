// @ts-check
// Settings › Keyboard: every shortcut, by what it's for. Termilly's own can be given other keys (a click, then the
// keys), have none (Ctrl+click, or Backspace while choosing) or go back to their default; Clear all and Reset to
// defaults do it for every one. The families of keys (1-9, the arrows, text size) and the clipboard's stay as they are.

import { state, GROUPS } from '../store.js';
import { ICONS, keysHtml, escapeHtml } from '../ui.js';
import { updateSettings } from '../preferences.js';
import { confirmDialog, noticeDialog } from '../dialogs.js';
import { targetOf } from '../dom.js';
import { group } from './controls.js';
import { SECTION, redraw } from './page.js';
import { enabledActions, chordHtml } from '../actions.js';
import { KEYMAP, FIXED, keysOf, takenBy, needsModifier, defaultKeysOf } from '../keymap.js';
import { captureKeys } from './keys.js';

/** The groups of shortcuts, in order; the fixed keys come last, as their own group. */
const GROUP_ORDER = ['Terminals', 'Workspaces', 'Agents', 'App'];

/** @returns {Record<string, string>} */
const overrides = () => ({ ...(state.settings.interface.shortcuts ?? {}) });
/** @param {Record<string, string>} shortcuts */
const save = shortcuts => updateSettings(GROUPS.interface, { shortcuts });

const defaultOf = defaultKeysOf;

/**
 * Gives a shortcut keys ('' for none); its default's are kept as no override at all.
 * @param {string} id
 * @param {string} chord
 */
function setKeys(id, chord) {
  const next = overrides();
  if (chord === defaultOf(id)) delete next[id]; else next[id] = chord;
  save(next);
  redraw();
}

/** @param {string} id @param {string} label */
function shortcutRow(id, label) {
  const keys = keysOf(id);
  const changed = keys !== defaultOf(id);
  return `<div class="key-row" data-key-id="${id}"><span>${escapeHtml(label)}</span>
    <span class="key-set">${changed ? `<button class="btn small key-reset" data-key-reset title="Back to ${escapeHtml(defaultOf(id).split('+').join(' '))}">${ICONS.history}</button>` : ''}
    <button class="btn small act-keys${changed ? ' changed' : ''}" data-key-edit title="Click, then press the keys. Backspace, or Ctrl+click, removes them.">${keys ? chordHtml(keys) : 'None'}</button></span></div>`;
}

/** @param {string} label @param {string} keys */
const fixedRow = (label, keys) => `<div class="key-row"><span>${escapeHtml(label)}</span><span class="keys">${keysHtml(keys)}</span></div>`;

/** The keys the user gave their actions (Settings › Actions). */
function actionKeys() {
  const withKeys = enabledActions().filter(a => a.shortcut);
  return withKeys.length ? group('Your actions', withKeys.map(a => `<div class="key-row"><span>${escapeHtml(a.name)}</span><span class="keys">${chordHtml(/** @type {string} */ (a.shortcut))}</span></div>`).join('')) : '';
}

/**
 * Keys chosen for a shortcut: kept unless something has them already, or they'd take a shell's keys.
 * @param {string} id
 * @param {string} chord
 */
function chosen(id, chord) {
  const problem = needsModifier(chord) || (takenBy(chord, id) ? `“${takenBy(chord, id)}” has these keys.` : '')
    || (enabledActions().find(a => a.shortcut === chord) ? `Your action “${enabledActions().find(a => a.shortcut === chord)?.name}” has these keys.` : '');
  if (problem) noticeDialog({ title: 'Choose other keys', body: problem }).then(redraw);
  else setKeys(id, chord);
}

/** @type {import('./page.js').Section} */
const KEYBOARD = {
  id: SECTION.keyboard,
  label: 'Keyboard', icon: ICONS.keyboard,
  tools: () => `<button class="btn small" data-action="keysClearAll">Clear all</button>
    <button class="btn small" data-action="keysReset">Reset to defaults</button>`,
  html: () => GROUP_ORDER.map(heading => group(heading,
    KEYMAP.filter(([, g]) => g === heading).map(([id, , label]) => shortcutRow(id, label)).join(''))).join('')
    + group('Fixed keys', FIXED.map(([label, keys]) => fixedRow(label, keys)).join(''))
    + actionKeys(),
  actions: {
    keysClearAll: async () => {
      if (!await confirmDialog({ title: 'Clear every shortcut?', body: 'Termilly’s shortcuts lose their keys (the fixed keys stay). Reset to defaults brings them back.', confirm: 'Clear all' })) return;
      save(Object.fromEntries(KEYMAP.map(([id]) => [id, ''])));
      redraw();
    },
    keysReset: async () => {
      if (!await confirmDialog({ title: 'Reset every shortcut?', body: 'Each of Termilly’s shortcuts gets its default keys back.', confirm: 'Reset' })) return;
      save({});
      redraw();
    },
  },
  click(e) {
    const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-key-id]'));
    const id = row?.dataset.keyId;
    if (!id) return false;
    if (targetOf(e).closest('[data-key-reset]')) setKeys(id, defaultOf(id));
    else if (targetOf(e).closest('[data-key-edit]') && e.ctrlKey) setKeys(id, '');
    else if (targetOf(e).closest('[data-key-edit]')) {
      captureKeys(/** @type {HTMLButtonElement} */ (targetOf(e).closest('[data-key-edit]')), {
        chosen: chord => chosen(id, chord), cleared: () => setKeys(id, ''), cancelled: redraw,
      });
    } else return false;
    return true;
  },
};

export default KEYBOARD;
