// @ts-check
// Settings › Terminal › Triggers: the list of output patterns (js/triggers.js matches them), and editing it.

import { state, GROUPS } from '../store.js';
import { escapeHtml, ICONS } from '../ui.js';
import { updateSettings } from '../preferences.js';
import { redraw } from './page.js';
import { targetOf } from '../dom.js';

/** @type {Array<[string, string]>} */
const TRIGGER_ACTIONS = [['highlight', 'Highlight'], ['capture', 'Highlight, keep in list'], ['notify', 'Notify me'], ['attention', 'Ask for attention']];

/** What a new trigger does, unless it's from a preset. */
const DEFAULT_ACTION = 'highlight';
/** Every terminal, the scope a new trigger starts with. */
const ALL_TERMINALS = 'all';

/** Ready-made triggers to start from. */
const TRIGGER_PRESETS = [
  { name: 'Errors', pattern: String.raw`\b(error|exception|fatal|failed)\b`, action: 'capture', color: '#ff7b72' },
  { name: 'Warnings', pattern: String.raw`\bwarn(ing)?\b`, action: 'highlight', color: '#f2cc60' },
  { name: 'Build finished', pattern: String.raw`(build succeeded|compiled successfully|done in \d)`, action: 'notify', color: '#7ee787' },
];

const validPattern = (/** @type {string} */ pattern) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

/** @param {string} selected */
function triggerScopes(selected) {
  const options = [[ALL_TERMINALS, 'Every terminal'],
    ...state.tags.map(t => [`tag:${t.name}`, `Tagged ${t.name}`]),
    ...state.profiles.map(p => [`profile:${p.id}`, p.name])];
  return options.map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

const triggers = () => state.settings.commands.triggers ?? [];

/**
 * A new trigger has only some of the fields; the host fills in the rest.
 * @param {Partial<TriggerSetting>[]} list
 */
function saveTriggers(list) {
  updateSettings(GROUPS.commands, { triggers: list });
}

/** The triggers, a row each, and buttons to add one (empty or from a preset). */
export function triggerList() {
  return `${triggers().map(t => `
      <div class="trigger-row" data-trigger="${escapeHtml(t.id)}">
        <button class="switch" role="switch" data-trigger-enabled aria-checked="${t.enabled !== false}" aria-label="Enabled"><span></span></button>
        <input class="field mono${validPattern(t.pattern) ? '' : ' invalid'}" data-trigger-field="pattern" value="${escapeHtml(t.pattern)}" spellcheck="false" title="A regular expression, matched against each new output line">
        <select class="field" data-trigger-field="action">${TRIGGER_ACTIONS.map(([v, l]) => `<option value="${v}"${v === t.action ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <select class="field" data-trigger-field="scope">${triggerScopes(t.scope ?? ALL_TERMINALS)}</select>
        <button class="btn small" data-trigger-delete title="Remove">${ICONS.trash}</button>
      </div>`).join('')}
    <div class="trigger-presets">
      <button class="btn small" data-action="addTrigger">${ICONS.plus}<span>Add trigger</span></button>
      ${TRIGGER_PRESETS.map((p, i) => `<button class="btn small" data-action="addTrigger" data-preset="${i}">${p.name}</button>`).join('')}
    </div>`;
}

export const triggerActions = {
  addTrigger: (/** @type {HTMLElement} */ el) => {
    const preset = TRIGGER_PRESETS[Number(el?.dataset.preset)] ?? { pattern: '', action: DEFAULT_ACTION };
    const id = `trig${Date.now().toString(36)}`;
    saveTriggers([...triggers(), { id, enabled: true, scope: ALL_TERMINALS, ...preset, pattern: preset.pattern || 'TODO' }]);
    redraw();
  },
};

/**
 * A trigger's switch or delete button; true when it was one.
 * @param {MouseEvent} e
 */
export function triggerClick(e) {
  const triggerRow = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-trigger]'));
  if (!triggerRow) return false;
  const id = triggerRow.dataset.trigger;
  if (targetOf(e).closest('[data-trigger-delete]')) saveTriggers(triggers().filter(t => t.id !== id));
  else if (targetOf(e).closest('[data-trigger-enabled]')) saveTriggers(triggers().map(t => (t.id === id ? { ...t, enabled: t.enabled === false } : t)));
  else return false;
  redraw();
  return true;
}

/**
 * A trigger's pattern, action or scope changed; true when it was one.
 * @param {Event} e
 */
export function triggerChange(e) {
  const field = /** @type {HTMLInputElement | null} */ (targetOf(e).closest('[data-trigger-field]'));
  if (!field) return false;
  const id = /** @type {HTMLElement} */ (field.closest('[data-trigger]')).dataset.trigger;
  saveTriggers(triggers().map(t =>
    (t.id === id ? { ...t, [/** @type {string} */ (field.dataset.triggerField)]: field.value } : t)));
  return true;
}

/**
 * Marks a pattern that isn't a valid regular expression while it's typed.
 * @param {Event} e
 */
export function triggerInput(e) {
  if (targetOf(e).matches('[data-trigger-field="pattern"]')) targetOf(e).classList.toggle('invalid', !validPattern(/** @type {HTMLInputElement} */ (e.target).value));
}
