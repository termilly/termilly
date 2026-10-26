// @ts-check
// Settings › Actions: web pages and programs started from Termilly (Actions.cs runs them). Each one is on the palette,
// can have a shortcut, and can be on a terminal's right-click menu. The page only names the action and says what it
// knows (the selection, the folder, a port); the host fills in the rest and starts it.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, tabTitle } from './store.js';
import { ACTION_PLACEHOLDER } from './constants.js';
import { keysHtml } from './ui.js';
import { SEPARATOR } from './popups.js';
import { confirmDialog } from './dialogs.js';
import { focusedTab } from './panes.js';
import { portsOf } from './gitstatus.js';
import { sendToAgent } from './together.js';
import { setMenuExtras } from './termclipboard.js';

/** Keys as the settings keep them: modifiers in this order, then the key, joined by +. */
const CTRL = 'Ctrl';
const ALT = 'Alt';
const MODIFIERS = [CTRL, ALT, 'Shift'];
const JOIN = '+';
/** Keys named by their code rather than the character they type (which Shift and the layout change). */
const PUNCTUATION = Object.freeze({
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
});
const NAMED_KEYS = ['Space', 'Enter', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'];
const ARROW = 'Arrow';
const KEY_CODE = /^Key([A-Z])$/;
const DIGIT_CODE = /^Digit(\d)$/;
const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

/**
 * Termilly's own shortcuts (main.js runShortcut, the clipboard and selection keys), which an action can't take.
 * Ctrl+Alt+J is the "next terminal that needs me" key from any app.
 */
const RESERVED = [
  /^Ctrl\+Shift\+([TWRFOELHGBNJAIDCV`1-9]|Up|Down|Left|Right|Insert)$/,
  /^Ctrl\+Alt\+([1-9]|J)$/,
  /^Alt\+Shift\+[=-]$/,
  /^Ctrl\+([=\-0,CV]|Tab|Insert|PageUp|PageDown)$/,
];

/** The placeholders a selection fills, so an action using one is on the right-click menu only with a selection. */
/** @type {readonly string[]} */
const FROM_SELECTION = [ACTION_PLACEHOLDER.selection, ACTION_PLACEHOLDER.file, ACTION_PLACEHOLDER.line];
const PLACEHOLDER = /\{(\w+)\}/g;
/** A web address, alone in the selection. */
const URL_ONLY = /^https?:\/\/[^\s"'<>`]+$/;
/** A path alone in the selection (C:\..., \\server\..., /..., ~/..., ./...), maybe with :line or (line). */
const PATH_ONLY = /^(?:[A-Za-z]:[\\/]|\\\\|~?\/|\.{1,2}[\\/])[^\s"'<>|*?]+$|^[\w.-]+[\\/][^\s"'<>|*?]+$/;
const PATH_LINE = /(?::\d+(?::\d+)?|\(\d+(?:,\s*\d+)?\)):?$/;
/** How much of a selection goes to an agent. */
const MAX_AGENT_TEXT = 20000;

/** The actions that are switched on. */
export const enabledActions = () => (state.settings.commands.actions ?? []).filter(a => a.enabled !== false);

/**
 * The placeholders an action uses.
 * @param {ActionSetting} action
 */
export const placeholdersOf = action =>
  [...`${action.target} ${action.arguments ?? ''}`.matchAll(PLACEHOLDER)].map(m => m[1]).filter(p => ACTION_PLACEHOLDER.all.includes(p));

/**
 * A keydown as an action's keys ("Ctrl+Alt+B"), or null for a key an action can't use.
 * @param {KeyboardEvent} e
 */
export function chordOf(e) {
  const key = keyName(e.code);
  if (!key) return null;
  const held = [e.ctrlKey, e.altKey, e.shiftKey];
  return [...MODIFIERS.filter((_, i) => held[i]), key].join(JOIN);
}

/** @param {string} code */
function keyName(code) {
  const letter = KEY_CODE.exec(code) ?? DIGIT_CODE.exec(code);
  if (letter) return letter[1];
  if (FUNCTION_KEY.test(code) || NAMED_KEYS.includes(code)) return code;
  if (code.startsWith(ARROW)) return code.slice(ARROW.length);
  return PUNCTUATION[/** @type {keyof typeof PUNCTUATION} */ (code)] ?? null;
}

/**
 * Why these keys can't run an action, or '' when they can. An action's keys need Ctrl or Alt with another modifier
 * (or a function key), so they never take a key a shell or program uses.
 * @param {string} chord
 * @param {string} [except] the action being changed, whose own keys don't count as taken
 */
export function chordProblem(chord, except) {
  const parts = chord.split(JOIN);
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  const withFunctionKey = FUNCTION_KEY.test(key) && modifiers.length > 0;
  if (!withFunctionKey && (modifiers.length < 2 || !(modifiers.includes(CTRL) || modifiers.includes(ALT)))) {
    return 'Use two of Ctrl, Alt and Shift (one of them Ctrl or Alt) with a key, or a modifier with F1–F12, so shells and programs keep their keys.';
  }
  if (RESERVED.some(re => re.test(chord))) return 'Termilly already uses these keys.';
  const other = enabledActions().find(a => a.id !== except && a.shortcut === chord);
  return other ? `“${other.name}” already uses these keys.` : '';
}

/**
 * An action's keys for showing: "Ctrl Alt B" as keyboard keys.
 * @param {string} chord
 */
export const chordHtml = chord => keysHtml(chord.split(JOIN).join(' '));

/**
 * What a terminal offers its actions: the selection, its folder (a local one) and the first port a program listens on.
 * @param {Tab | null | undefined} tab
 */
function contextOf(tab) {
  const selection = tab?.view?.term.getSelection() || null;
  return { selection, folder: tab?.cwd ?? null, port: tab ? portsOf(tab)[0] ?? null : null };
}

/**
 * Runs an action for a terminal (the focused one when none is given).
 * @param {ActionSetting} action
 * @param {Tab | null} [tab]
 */
export function runAction(action, tab = focusedTab()) {
  send(PAGE.actionRun, { id: action.id, ...contextOf(tab) });
}

onHost(HOST.actionFailed, m => {
  confirmDialog({ title: m.name, body: m.message });
});

/**
 * The action whose keys these are, run; true when there was one.
 * @param {KeyboardEvent} e
 */
export function runActionShortcut(e) {
  const chord = chordOf(e);
  const action = chord && enabledActions().find(a => a.shortcut === chord);
  if (!action) return false;
  runAction(action);
  return true;
}

/** The palette's entries: one per action. */
export const actionCommands = () => enabledActions().map(a => ({
  label: a.name,
  keywords: `action open launch start ${a.target} ${a.arguments ?? ''}`,
  hint: a.shortcut ? chordHtml(a.shortcut) : '',
  run: () => setTimeout(() => runAction(a)),
}));

/**
 * Whether what an action needs is there; for the menu, so it only offers what can run. The repository and branch
 * aren't known here: an action using them is offered wherever there's a folder, and the host says when it isn't one.
 * @param {ActionSetting} action
 * @param {{ selection: string | null, folder: string | null, port: number | null }} context
 */
function canRun(action, context) {
  const looksLikePath = !!context.selection && PATH_ONLY.test(context.selection.trim());
  return placeholdersOf(action).every(p => {
    if (p === ACTION_PLACEHOLDER.selection) return !!context.selection?.trim();
    if (p === ACTION_PLACEHOLDER.file || p === ACTION_PLACEHOLDER.line) return looksLikePath;
    if (p === ACTION_PLACEHOLDER.port) return context.port != null;
    return !!context.folder;
  });
}

/**
 * The selection as a link or a path to open; null when it's neither.
 * @param {string | null} selection
 */
function openableOf(selection) {
  const text = selection?.trim() ?? '';
  if (URL_ONLY.test(text)) return { label: 'Open link', action: () => send(PAGE.openUrl, { url: text }) };
  if (PATH_ONLY.test(text)) return { label: 'Show in the file manager', action: () => send(PAGE.openPath, { path: text.replace(PATH_LINE, '') }) };
  return null;
}

/**
 * The right-click menu's part after Copy and Paste: opening a selected link or path, the actions that can run here,
 * and asking an agent about the selection.
 * @param {HTMLElement} body the terminal's element
 * @returns {import('./popups.js').MenuEntry[]}
 */
function menuExtras(body) {
  const tab = [...state.tabs.values()].find(t => t.view?.body === body) ?? null;
  if (!tab) return [];
  const context = contextOf(tab);
  const openable = openableOf(context.selection);
  const actions = enabledActions().filter(a => a.menu && canRun(a, context))
    // Without a selection, only actions that don't need one.
    .filter(a => context.selection || !placeholdersOf(a).some(p => FROM_SELECTION.includes(p)));
  /** @type {import('./popups.js').MenuItem[]} */
  const items = [
    ...(openable ? [openable] : []),
    ...actions.map(a => ({ label: a.name, hint: a.shortcut ? a.shortcut : undefined, action: () => runAction(a, tab) })),
    ...(context.selection?.trim() ? [{
      label: 'Ask an agent about this',
      action: () => sendToAgent(/** @type {string} */ (context.selection).slice(0, MAX_AGENT_TEXT), { title: tabTitle(tab) }, tab.view?.header, tab),
    }] : []),
  ];
  return items.length ? [SEPARATOR, ...items] : [];
}

setMenuExtras(menuExtras);
