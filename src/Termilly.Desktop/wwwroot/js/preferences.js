// @ts-check
// Changing settings: a group at a time ('terminal', 'changes'…, store.js GROUPS), applied to the page at once and
// saved by the host a moment later, which checks the group and stores it (Settings/AppSettings.cs). Any module may
// change a setting from here; the Settings page (settings.js) is only one of them.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state } from './store.js';
import { debounce } from './util.js';
import { TERMINAL_SETTINGS } from './constants.js';

/** The terminals' text size: the host's default and the sizes it accepts (C#: TerminalSettings). */
export const { defaultFontSize: DEFAULT_FONT_SIZE, minFontSize: MIN_FONT_SIZE, maxFontSize: MAX_FONT_SIZE } = TERMINAL_SETTINGS;
/** How long changes gather before they're saved. */
const SAVE_DELAY = 300;

/** The groups changed since the last save. */
/** @type {Set<string>} */
const unsaved = new Set();

/** The settings by group name, for changing a group the caller names. */
const groups = () => /** @type {Record<string, Record<string, any>>} */ (/** @type {unknown} */ (state.settings));

const saveUnsaved = debounce(() => {
  for (const group of unsaved) send(PAGE.settingsSave, { group, values: groups()[group] });
  unsaved.clear();
}, SAVE_DELAY);

/** What applies the settings to the page (settings.js's applySettings, which registers itself). */
let apply = () => {};

/** @param {() => void} fn */
export const onApply = fn => { apply = fn; };

/**
 * Saves a group a moment from now, with whatever else changes meanwhile.
 * @param {string} group
 */
export function saveSoon(group) {
  unsaved.add(group);
  saveUnsaved();
}

/**
 * Changes settings in one group, applies them and saves that group.
 * @param {string} group
 * @param {Record<string, any>} patch
 */
export function updateSettings(group, patch) {
  groups()[group] = { ...groups()[group], ...patch };
  const { terminal } = state.settings;
  terminal.fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(terminal.fontSize)));
  saveSoon(group);
  apply();
}

/**
 * Changes one setting by its path ('changes.source'), as the Settings controls name them.
 * @param {string} path
 * @param {any} value
 */
export function setSetting(path, value) {
  const [group, key] = path.split('.');
  updateSettings(group, { [key]: value });
}
