// @ts-check
// Termilly's own shortcuts and the keys each has: its default, or what Settings › Keyboard set
// (settings.interface.shortcuts: a command's id to its keys, "" for none). Keys are kept as "Ctrl+Shift+T": the
// modifiers in the order Ctrl, Alt, Shift, then the key by its place on the keyboard. The shortcuts that are a family
// of keys (workspaces 1-9, shells 1-9, moving between panes, text size) stay as they are.

import { state } from './store.js';
import { keysHtml } from './ui.js';

/** Keys as the settings keep them: modifiers in this order, then the key, joined by +. */
const CTRL = 'Ctrl';
const ALT = 'Alt';
const MODIFIERS = [CTRL, ALT, 'Shift'];
export const JOIN = '+';
/** Keys named by their code rather than the character they type (which Shift and the layout change). */
const PUNCTUATION = Object.freeze({
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', NumpadAdd: '=', NumpadSubtract: '-',
});
const NAMED_KEYS = ['Space', 'Enter', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'];
const ARROW = 'Arrow';
const KEY_CODE = /^Key([A-Z])$/;
const DIGIT_CODE = /^Digit(\d)$/;
export const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

/**
 * The shortcuts that can be changed: [id, group, what it does, its default keys].
 * @type {ReadonlyArray<readonly [string, string, string, string]>}
 */
export const KEYMAP = Object.freeze([
  ['newTerminal', 'Terminals', 'New terminal', 'Ctrl+Shift+T'],
  ['closeTerminal', 'Terminals', 'Close terminal', 'Ctrl+Shift+W'],
  ['renameTerminal', 'Terminals', 'Rename terminal', 'Ctrl+Shift+R'],
  ['splitRight', 'Terminals', 'Split right', 'Alt+Shift+='],
  ['splitDown', 'Terminals', 'Split down', 'Alt+Shift+-'],
  ['broadcastWorkspace', 'Terminals', 'Broadcast input to the workspace (on / off)', 'Ctrl+Shift+I'],
  ['newWorkspace', 'Workspaces', 'New workspace', 'Ctrl+Shift+N'],
  ['toggleSidebar', 'Workspaces', 'Show or hide the sidebar', 'Ctrl+Shift+B'],
  ['nextNeedingMe', 'Agents', 'Next terminal that needs you', 'Ctrl+Shift+J'],
  ['inbox', 'Agents', 'Open the notification center', 'Ctrl+Shift+A'],
  ['agentChanges', 'Agents', 'Show the last file Claude changed here (turn on in Change preview)', 'Ctrl+Shift+D'],
  ['search', 'App', 'Search terminals, history and output', 'Ctrl+Shift+F'],
  ['commandHistory', 'App', 'Command history (failed, in:folder)', 'Ctrl+Shift+H'],
  ['previousPrompt', 'App', 'Previous prompt', 'Ctrl+Shift+Up'],
  ['nextPrompt', 'App', 'Next prompt', 'Ctrl+Shift+Down'],
  ['hints', 'App', 'Hints: open a link, copy a path or hash', 'Ctrl+Shift+E'],
  ['scratch', 'App', 'Floating scratch terminal', 'Ctrl+Shift+`'],
  ['notepad', 'App', 'Notepad', 'Ctrl+Shift+M'],
  ['todo', 'App', 'To do', 'Ctrl+Shift+K'],
  ['clips', 'App', 'Clipboard', 'Ctrl+Shift+X'],
  ['files', 'App', 'File Explorer', 'Ctrl+Shift+L'],
  ['git', 'App', 'Git: changes and history', 'Ctrl+Shift+G'],
  ['goTo', 'App', 'Go to a workspace, folder, closed terminal or SSH host', 'Ctrl+Shift+O'],
  ['settings', 'App', 'Settings', 'Ctrl+,'],
]);

/** The ids, for the code that runs them (main.js) and the panels that close with their own keys. */
export const KEY_ID = Object.freeze(Object.fromEntries(KEYMAP.map(([id]) => [id, id])));

/**
 * The fixed keys (families, the clipboard's, the text size's, the key that works from any app): [what, keys, pattern].
 * @type {ReadonlyArray<readonly [string, string, RegExp]>}
 */
export const FIXED = Object.freeze([
  ['New terminal with shell 1–9', 'Ctrl Shift 1–9', /^Ctrl\+Shift\+[1-9]$/],
  ['Switch to workspace 1–9', 'Ctrl Alt 1–9', /^Ctrl\+Alt\+[1-9]$/],
  ['Next / previous workspace', 'Ctrl Tab / Ctrl Shift Tab', /^Ctrl\+(Shift\+)?Tab$/],
  ['Next / previous tab in a group', 'Ctrl PageDown / Ctrl PageUp', /^Ctrl\+Page(Up|Down)$/],
  ['Move focus between panes', 'Alt ←↑→↓', /^Alt\+(Left|Right|Up|Down)$/],
  ['Copy / paste', 'Ctrl C / Ctrl V / Ctrl Shift C / Ctrl Shift V', /^Ctrl\+(Shift\+)?[CV]$|^(Ctrl|Shift)\+Insert$/],
  ['Bigger / smaller text, reset', 'Ctrl + / Ctrl - / Ctrl 0', /^Ctrl\+[=\-0]$/],
  ['Next terminal that needs you, from any app (turn on in Notifications)', 'Ctrl Alt J', /^Ctrl\+Alt\+J$/],
  ['Zoom text with the mouse', 'Ctrl Wheel', /^$/],
]);

/** @param {string} code */
function keyName(code) {
  const letter = KEY_CODE.exec(code) ?? DIGIT_CODE.exec(code);
  if (letter) return letter[1];
  if (FUNCTION_KEY.test(code) || NAMED_KEYS.includes(code)) return code;
  if (code.startsWith(ARROW)) return code.slice(ARROW.length);
  return PUNCTUATION[/** @type {keyof typeof PUNCTUATION} */ (code)] ?? null;
}

/**
 * A keydown as keys ("Ctrl+Alt+B"), or null for a key that can't be one.
 * @param {KeyboardEvent} e
 */
export function chordOf(e) {
  const key = keyName(e.code);
  if (!key) return null;
  const held = [e.ctrlKey, e.altKey, e.shiftKey];
  return [...MODIFIERS.filter((_, i) => held[i]), key].join(JOIN);
}

/**
 * Keys for showing: "Ctrl Alt B" as keyboard keys.
 * @param {string} chord
 */
export const chordHtml = chord => keysHtml(chord.split(JOIN).join(' '));

/** Where a KEYMAP entry has its default keys. */
const DEFAULT_AT = 3;

/**
 * A shortcut's default keys; '' for one that isn't a shortcut.
 * @param {string} id
 */
export const defaultKeysOf = id => KEYMAP.find(([key]) => key === id)?.[DEFAULT_AT] ?? '';

/** @returns {Record<string, string>} */
const overrides = () => /** @type {Record<string, string>} */ (state.settings.interface?.shortcuts ?? {});

/**
 * A shortcut's keys now: Settings' own, or its default; '' when it has none.
 * @param {string} id
 */
export function keysOf(id) {
  const set = overrides()[id];
  return set !== undefined ? set : defaultKeysOf(id);
}

/** A shortcut's keys as a hint (the palette, tooltips); '' for none. @param {string} id */
export const keyHint = id => (keysOf(id) ? chordHtml(keysOf(id)) : '');

/**
 * The shortcut these keys run, or null.
 * @param {string | null} chord
 */
export const commandOf = chord => (chord ? KEYMAP.find(([id]) => keysOf(id) === chord)?.[0] ?? null : null);

/**
 * Whether a keydown is a shortcut's keys.
 * @param {KeyboardEvent} e
 * @param {string} id
 */
export const isShortcut = (e, id) => !!keysOf(id) && chordOf(e) === keysOf(id);

/**
 * What already has these keys: a shortcut's name, or a fixed key's; '' when they're free.
 * @param {string} chord
 * @param {string} [except] the shortcut being changed
 */
export function takenBy(chord, except) {
  const fixed = FIXED.find(([, , pattern]) => pattern.test(chord));
  if (fixed) return fixed[0];
  return KEYMAP.find(([id]) => id !== except && keysOf(id) === chord)?.[2] ?? '';
}

/**
 * Why keys can't be a shortcut, or '' when they can: they need Ctrl or Alt (or a function key), so typing and the
 * shells' own keys stay as they are.
 * @param {string} chord
 */
export function needsModifier(chord) {
  const parts = chord.split(JOIN);
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (FUNCTION_KEY.test(key) || modifiers.includes(CTRL) || modifiers.includes(ALT)) return '';
  return 'Use Ctrl or Alt with a key (or a function key), so typing and the shells keep their keys.';
}

/** For actions (actions.js): Ctrl or Alt counts, with at least two modifiers unless it's a function key. */
export const ACTION_MODIFIERS = Object.freeze({ ctrl: CTRL, alt: ALT });
