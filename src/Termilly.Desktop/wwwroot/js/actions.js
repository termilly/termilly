// @ts-check
// Settings › Actions: web pages and programs started from Termilly (Actions.cs runs them). Each one is on the palette,
// can have a shortcut, and can be on a terminal's right-click menu. The page only names the action and says what it
// knows (the selection, the folder, a port); the host fills in the rest and starts it.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, tabTitle, emit, EVENTS } from './store.js';
import { ACTION_PLACEHOLDER } from './constants.js';
import { keysHtml, ICONS } from './ui.js';
import { SEPARATOR, showMenu, closeAll } from './popups.js';
import { byId } from './dom.js';
import { noticeDialog } from './dialogs.js';
import { focusedTab } from './panes.js';
import { portsOf } from './gitstatus.js';
import { sendToAgent } from './together.js';
import { setMenuExtras } from './termclipboard.js';
import { linkUnderMouse } from './termlinks.js';
import { copyToNotepadItem, copyToNoteItem } from './notepad.js';

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
  /^Ctrl\+Shift\+([TWRFOELHGBNJAIDCVM`1-9]|Up|Down|Left|Right|Insert)$/,
  /^Ctrl\+Alt\+([1-9]|J)$/,
  /^Alt\+Shift\+[=-]$/,
  /^Ctrl\+([=\-0,CV]|Tab|Insert|PageUp|PageDown)$/,
];

/** The placeholders a selection fills, so an action using one is on the right-click menu only with a selection. */
/** @type {readonly string[]} */
const FROM_SELECTION = [ACTION_PLACEHOLDER.selection, ACTION_PLACEHOLDER.file, ACTION_PLACEHOLDER.line, ACTION_PLACEHOLDER.url, ACTION_PLACEHOLDER.image];
/** A path {image} takes (Actions.cs checks the file is there). */
const IMAGE_PATH = /\.(?:png|jpe?g|gif|bmp|webp|tiff?)$/i;
const PLACEHOLDER = /\{(\w+)\}/g;
/** A web address, alone in the selection. */
const URL_ONLY = /^https?:\/\/[^\s"'<>`]+$/;
/** A path alone in the selection (C:\..., \\server\..., /..., ~/..., ./...), maybe with :line or (line). */
const PATH_ONLY = /^(?:[A-Za-z]:[\\/]|\\\\|~?\/|\.{1,2}[\\/])[^\s"'<>|*?]+$|^[\w.-]+[\\/][^\s"'<>|*?]+$/;
/** A path that doesn't depend on the folder: C:\..., \\server\... or /... */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
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
  return { selection, folder: tab?.cwd ?? null, port: tab ? portsOf(tab)[0] ?? null : null, image: /** @type {string | null} */ (null) };
}

/**
 * Runs an action for a terminal (the focused one when none is given).
 * @param {ActionSetting} action
 * @param {Tab | null} [tab]
 * @param {ReturnType<typeof contextOf>} [context] what it runs with, when not the terminal's now (a right-clicked link)
 */
export function runAction(action, tab = focusedTab(), context = contextOf(tab)) {
  send(PAGE.actionRun, { id: action.id, ...context });
}

onHost(HOST.actionFailed, m => {
  noticeDialog({ title: m.name, body: m.message });
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
 * @param {{ selection: string | null, folder: string | null, port: number | null, image?: string | null }} context
 */
function canRun(action, context) {
  const text = context.selection?.trim() ?? '';
  const looksLikePath = PATH_ONLY.test(text);
  return placeholdersOf(action).every(p => {
    if (p === ACTION_PLACEHOLDER.selection) return !!text;
    if (p === ACTION_PLACEHOLDER.url) return URL_ONLY.test(text);
    if (p === ACTION_PLACEHOLDER.image) return !!context.image || (looksLikePath && IMAGE_PATH.test(text));
    if (p === ACTION_PLACEHOLDER.file || p === ACTION_PLACEHOLDER.line) return looksLikePath;
    if (p === ACTION_PLACEHOLDER.port) return context.port != null;
    return !!context.folder;
  });
}

/**
 * The actions a file or folder on this machine offers (the Files panel's menu): run with its path as the selection,
 * and a folder as the folder too.
 * @param {Tab} tab
 * @param {string} path
 * @param {string} folder the folder it's in, or the folder itself
 * @param {string | null} [image] an image file for {image} (a Smart Clip image)
 * @returns {import('./popups.js').MenuItem[]}
 */
export function pathActions(tab, path, folder, image = null) {
  const context = { selection: path, folder, port: portsOf(tab)[0] ?? null, image };
  return enabledActions().filter(a => a.menu && canRun(a, context))
    .map(a => ({ label: a.name, hint: a.shortcut ? a.shortcut : undefined, action: () => runAction(a, tab, context) }));
}

/**
 * The selection as a link or a path to open; null when it's neither. A relative path is found from the terminal's
 * folder, so it needs one.
 * @param {string | null} selection
 * @param {string | null} folder
 */
function openableOf(selection, folder) {
  const text = selection?.trim() ?? '';
  if (URL_ONLY.test(text)) return { label: 'Open link', icon: ICONS.link, action: () => send(PAGE.openUrl, { url: text }) };
  if (!PATH_ONLY.test(text)) return null;
  const path = text.replace(PATH_LINE, '');
  const full = ABSOLUTE_PATH.test(path) ? path : folder && `${folder}/${path}`;
  return full ? { label: 'Show in the file manager', icon: ICONS.folder, action: () => send(PAGE.openPath, { path: full }) } : null;
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
  // Right-clicking a link (a web address or a path) without a selection offers what a selection of it would.
  const context = { ...contextOf(tab) };
  context.selection ||= linkUnderMouse();
  const openable = openableOf(context.selection, context.folder);
  const actions = enabledActions().filter(a => a.menu && canRun(a, context))
    // Without a selection, only actions that don't need one.
    .filter(a => context.selection || !placeholdersOf(a).some(p => FROM_SELECTION.includes(p)));
  /** @type {import('./popups.js').MenuItem[]} */
  const items = [
    ...(openable ? [openable] : []),
    ...actions.map(a => ({ label: a.name, icon: ICONS.play, hint: a.shortcut ? a.shortcut : undefined, action: () => runAction(a, tab, context) })),
    ...(context.selection?.trim() ? [{
      label: 'Ask an agent about this', icon: ICONS.ask,
      action: () => sendToAgent(/** @type {string} */ (context.selection).slice(0, MAX_AGENT_TEXT), { title: tabTitle(tab) }, tab.view?.header, tab),
    }, copyToNotepadItem(/** @type {string} */ (context.selection)), copyToNoteItem(/** @type {string} */ (context.selection))] : []),
  ];
  return items.length ? [SEPARATOR, ...items] : [];
}

setMenuExtras(menuExtras);

// ---- The title bar's Actions button ----

/** Settings' Actions page (settings/page.js). */
const ACTIONS_PAGE = 'actions';

/**
 * Why an action can't run for this terminal now, for its greyed-out entry.
 * @param {ActionSetting} action
 */
const whyNot = action => (placeholdersOf(action).some(p => FROM_SELECTION.includes(p))
  ? 'Select it in the terminal first' : 'Not here: it needs a folder or a port this terminal doesn’t have');

/**
 * Every action switched on, for the terminal in focus (one that can't run there is greyed out), then Edit actions.
 * @param {HTMLElement} button
 */
function actionsMenu(button) {
  if (button.classList.contains('open')) return closeAll();
  const tab = focusedTab();
  const context = contextOf(tab);
  /** @type {import('./popups.js').MenuEntry[]} */
  const items = enabledActions().map(a => {
    const can = canRun(a, context);
    return { label: a.name, hint: a.shortcut ? a.shortcut : undefined, disabled: !can, title: can ? undefined : whyNot(a), action: () => runAction(a, tab, context) };
  });
  if (!items.length) items.push({ label: 'No actions yet', disabled: true });
  items.push(SEPARATOR, { label: 'Edit actions', action: () => emit(EVENTS.openSettings, ACTIONS_PAGE) });
  showMenu(items, button);
}

byId('actions-button').addEventListener('click', e => actionsMenu(/** @type {HTMLElement} */ (e.currentTarget)));
