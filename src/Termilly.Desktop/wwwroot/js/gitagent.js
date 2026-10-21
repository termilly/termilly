// @ts-check
// The Git window's Agent changes (js/gitwindow.js): the files Claude changed in a terminal (tab.changes, from
// Changes.cs), as a tree of folders on the left, and the selected file's change on the right. The right side is the
// change preview itself (js/preview.js), borrowed while this view is on, so it keeps its All edits / Last edit,
// Diff / File and Wrap. It works outside a repository too: then it's all the window shows.

import { send } from './host.js';
import { PAGE } from './protocol.js';
import { isRemote, isSsh } from './store.js';
import { escapeHtml, ICONS } from './ui.js';
import { showChange, showMessage, setPreviewHost } from './preview.js';
import { changeWhat } from './changes.js';
import { buildTree, flatten, folderKeys, folderKeysIn, fileOrder, samePath } from './changetree.js';

/** @typedef {import('./changetree.js').Folder} Folder */
/** @typedef {import('./changetree.js').TreeFile} TreeFile */
/**
 * A row of the Agent changes list: a folder (which opens and closes) or a file, at a depth.
 * @typedef {{ kind: 'agent-folder', folder: Folder, depth: number }
 *   | { kind: 'agent-file', file: TreeFile, depth: number }} AgentItem
 */

/** The list's row kinds (the window's ListItem.kind). */
export const AGENT_ITEM = Object.freeze({ folder: 'agent-folder', file: 'agent-file' });

const CHEVRON = '<svg viewBox="0 0 12 12"><path d="M4.5 3L7.5 6 4.5 9"/></svg>';
/** More files than this and only the top folders start open. */
const OPEN_ALL_UP_TO = 200;
/** A row's indent per level of the tree, and its first, in pixels. */
const INDENT_PX = 14;
const FIRST_INDENT_PX = 8;
/** What the right side says with no file to show. */
const NONE_YET = 'Claude hasn’t changed any files in this terminal yet. When it does, they’re listed here.';
/** What it says for a terminal on a server: Claude's edits there aren't copied to this PC. */
export const REMOTE_TEXT = 'Not available for remote terminals: Claude’s changes are only kept for terminals on this PC.';

/** The terminal whose changes are shown, the file selected, and the folders closed by hand. */
export const agent = {
  /** @type {Tab | null} */
  tab: null,
  /** @type {string | null} */
  selected: null,
  /** @type {Set<string>} */
  collapsed: new Set(),
};

/**
 * A terminal whose shell runs on a server: its files aren't on this PC, so nothing is kept of Claude's edits there.
 * @param {Tab | null | undefined} tab
 */
export const remoteAgent = tab => !!tab && (isRemote(tab) || isSsh(tab));

/** @returns {import('./changes.js').ChangedFile[]} */
const files = () => (remoteAgent(agent.tab) ? [] : agent.tab?.changes ?? []);

export const agentCount = () => files().length;

/**
 * Starts the view on a terminal's changes: nothing selected, every folder open (a big list only its top ones).
 * @param {Tab | null} tab
 */
export function startAgent(tab) {
  agent.tab = tab;
  agent.selected = null;
  agent.collapsed = files().length > OPEN_ALL_UP_TO ? folderKeysIn(buildTree(files()), { belowTop: true }) : new Set();
}

/**
 * The list's rows: the tree, with the folders closed by hand.
 * @returns {AgentItem[]}
 */
export function agentItems() {
  return flatten(buildTree(files()), '', agent.collapsed).map(r => (r.folder
    ? { kind: AGENT_ITEM.folder, folder: r.folder, depth: r.depth }
    : { kind: AGENT_ITEM.file, file: /** @type {TreeFile} */ (r.file), depth: r.depth }));
}

/** What the list says when it has no rows. */
export const agentEmptyText = () => (remoteAgent(agent.tab) ? REMOTE_TEXT : NONE_YET);

/** @param {{ added?: number, removed?: number }} n */
const counts = n => (n.added || n.removed ? `<span class="pv-plus">+${n.added}</span> <span class="pv-minus">−${n.removed}</span>` : '');

/**
 * A row's HTML, or null when it isn't one of this view's.
 * @param {{ kind: string }} item
 * @param {number} i
 */
export function agentRowHtml(item, i) {
  const it = /** @type {AgentItem} */ (item);
  if (it.kind !== AGENT_ITEM.folder && it.kind !== AGENT_ITEM.file) return null;
  const indent = `style="padding-left:${FIRST_INDENT_PX + it.depth * INDENT_PX}px"`;
  if (it.kind === AGENT_ITEM.folder) {
    const f = it.folder;
    const open = !agent.collapsed.has(f.key);
    return `<div class="cw-row cw-folder${open ? ' open' : ''}" role="treeitem" aria-expanded="${open}" data-i="${i}" ${indent}>`
      + `<span class="cw-chev">${CHEVRON}</span><span class="cw-icon">${ICONS.folder}</span>`
      + `<span class="cw-name">${escapeHtml(f.name)}</span><span class="cw-count">${f.count}</span><span class="cw-what">${counts(f)}</span></div>`;
  }
  const f = it.file;
  const selected = samePath(f.path, agent.selected);
  return `<div class="cw-row cw-file${selected ? ' selected' : ''}" role="treeitem" aria-selected="${selected}" data-i="${i}" title="${escapeHtml(f.path)}" ${indent}>`
    + `<span class="cw-chev"></span><span class="cw-name">${escapeHtml(f.name)}</span><span class="cw-what">${changeWhat(f)}</span></div>`;
}

/**
 * Opens or closes a folder (by default the other way from now).
 * @param {Folder} folder
 * @param {boolean} [open]
 */
export function toggleFolder(folder, open = agent.collapsed.has(folder.key)) {
  if (open) agent.collapsed.delete(folder.key); else agent.collapsed.add(folder.key);
}

// ---- The right side: the change preview, borrowed ----

/**
 * Puts the preview in the window's right column (container), or with null gives it back to where Settings says.
 * @param {HTMLElement | null} container
 */
export function hostPreview(container) {
  setPreviewHost(container, container ? { order: () => fileOrder(files()) } : {});
}

/**
 * Shows a file's change on the right, its folders opened in the tree. line: a line to scroll to (a search's hit),
 * shown in the whole file so an unchanged line shows too.
 * @param {string} path
 * @param {{ line?: number | null, focus?: boolean }} [options]
 */
export function showAgentFile(path, { line = null, focus = false } = {}) {
  if (!agent.tab) return;
  agent.selected = path;
  const file = files().find(f => samePath(f.path, path));
  if (file) for (const key of folderKeys(file)) agent.collapsed.delete(key);
  showChange(agent.tab, path, { line, focus, wholeFile: !!line });
}

/** The first file in the tree's order, or a message when there's none (or the terminal is on a server). */
export function showFirstAgentFile() {
  const first = fileOrder(files())[0];
  if (first) showAgentFile(first);
  else if (agent.tab) {
    agent.selected = null;
    showMessage(agent.tab, agentEmptyText(), { focus: false });
  }
}

/** After the list changed: the file shown is still there, or the first one takes its place. */
export function keepAgentFile() {
  if (!agent.selected || !files().some(f => samePath(f.path, agent.selected))) showFirstAgentFile();
}

/**
 * Takes a file off the terminal's list (Delete in the tree).
 * @param {string} path
 */
export function forgetAgentFile(path) {
  if (agent.tab) send(PAGE.changesClear, { id: agent.tab.id, path });
}
