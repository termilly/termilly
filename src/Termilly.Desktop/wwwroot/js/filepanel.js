// @ts-check
// The Files side panel (terminal menu › Files, or Ctrl+Shift+L): the files of the terminal in focus, as a tree from
// This PC (the drives) or its server's root down, open at the folder its shell is in and following it. For an SSH
// terminal they're on its server (the host reads them over ssh and sftp with the terminal's own connection settings);
// for one on this machine they're here. A + opens a folder with something in it (as does a double click); a click
// selects (Ctrl and Shift add to it, as in Explorer), a double click opens a file here in the preview, and
// right-clicking offers the rest, for all that's selected: "Copy to" another terminal's folder (copyto.js),
// downloads, deleting. Files dropped on the panel go into the folder they're dropped on. What's done is said in a
// note at the bottom of the window (filejobs.js).

import { PAGE, HOST } from './protocol.js';
import { send, sendWithFiles, onHost, platform, droppedPaths, PLATFORM } from './host.js';
import { state, on, persist, tabTitle, wsById, isSsh, isRemote, profileOf, EVENTS } from './store.js';
import { focusedTab, newTab } from './panes.js';
import { scheduleFit, typePaths } from './terminals.js';
import { escapeHtml, ICONS } from './ui.js';
import { modal, confirmDialog, CONFIRM_DIALOG } from './dialogs.js';
import { byId, field, targetOf, dockRight, titleIconHtml, WORKSPACE_ID, PATH_DRAG, DOCK_GRIP } from './dom.js';
import { showMenu, SEPARATOR } from './popups.js';
import { showChange } from './preview.js';
import { pathActions } from './actions.js';
import { FILE_OP, FOLDER_PATH, PROFILE_SOURCE } from './constants.js';
import { parentOf, isInside, DRIVE_ICON, DRIVES_NAME, folderName, sizeText, hasFiles, shellFolderOf, folderOf, placeOf, sameMachine, isWsl, wslPath, wslDistroOf, shellPathOf } from './filepaths.js';
import { rootOf, childPath, signHtml, indentRows, readFolders, pathDown } from './foldertree.js';
import { planCopy, planInto } from './copyto.js';
import { JOB_KIND, FILE_MANAGER, BIN, newRequestId, startJob, expectJob } from './filejobs.js';

/** @typedef {import('./foldertree.js').FileEntry} FileEntry */
/** @typedef {import('./foldertree.js').TreeNode} TreeNode */
/**
 * What the panel shows for a terminal: whether that's on a server, the folders read, which are open or being read,
 * the folder its shell is in (marked), a folder it moved to while another terminal was shown, why nothing shows, and
 * what the search box holds.
 * @typedef {{ tab: Tab, server: boolean, nodes: Map<string, TreeNode>, open: Set<string>, loading: Set<string>,
 *   cwd: string | null, moved: string | null, error: string | null, query: string, search: Search | null }} FilesView
 */
/**
 * A search of a folder and every folder in it (FileSearch.cs): what it found by the folder it's in (and the folders
 * down to those), how many, and whether it's done, stopped at the most it finds, or failed.
 * @typedef {{ id: string, dir: string, nodes: Map<string, FileEntry[]>, count: number, done: boolean, stopped: boolean,
 *   error: string | null }} Search
 */
/** A row drawn: its path, what it is (none for the tree's root), how deep it is, and the folder it's in. */
/** @typedef {{ path: string, entry: FileEntry | null, depth: number, dir: string | null }} Row */
/** A tree brought back after a restart: the shell's first folder report only marks its folder, keeping the scroll. */
/** @type {Set<FilesView>} */
const restored = new Set();

/** What the panel's buttons do (data-files). */
const FILES_ACTION = Object.freeze({
  close: 'close', refresh: 'refresh', mkdir: 'mkdir', fold: 'fold', get: 'get', rename: 'rename', delete: 'delete',
});
/**
 * Collapse all (a box with −) and open to the shell's folder (a box with +), each in front of another box: 1px lines
 * on whole pixels, so they stay crisp at 16px.
 */
const COLLAPSE_ICON = '<svg class="files-fold-icon" viewBox="0 0 16 16"><path d="M2.5 10.5v-8h8"/><rect x="4.5" y="4.5" width="8" height="8" rx="1"/><path d="M6 8.5h5"/></svg>';
const EXPAND_ICON = '<svg class="files-fold-icon" viewBox="0 0 16 16"><path d="M2.5 10.5v-8h8"/><rect x="4.5" y="4.5" width="8" height="8" rx="1"/><path d="M6 8.5h5M8.5 6v5"/></svg>';
const REFRESH_ICON = '<svg class="files-fold-icon" viewBox="0 0 16 16"><path d="M12.5 8.5a4.5 4.5 0 1 1-1.5-3.4"/><path d="M11.5 1.5v3.5H8"/></svg>';
/** The search box. */
const SEARCH = '[data-files-search]';
/** How long typing pauses before the search starts. */
const TYPING_MS = 300;
/** The panel's narrowest width; its widest is half the terminals' area (app.css max-width). */
const MIN_WIDTH_PX = 260;
/** The tree's list, and the class of the folder row files dragged over go into. */
const LIST = '.files-list';
const DROP_HERE = 'drop-here';
/** Drag-and-drop's effect for what leaves the panel and what's dropped on it. */
const COPY_EFFECT = 'copy';

const panel = document.createElement('aside');
panel.className = 'files-panel';
panel.hidden = true;
panel.tabIndex = -1; // focusable, for its keys (Ctrl+A, Delete, Escape, arrows)
byId(WORKSPACE_ID).append(panel);
const filesButton = byId('files-button');

/** @type {FilesView | null} */
let view = null;
/** Each terminal's tree while the panel stays open, to come back to as it was; closing the panel forgets them. */
/** @type {Map<string, FilesView>} */
const views = new Map();
/** The rows drawn, in order; the paths selected, and the one Shift+click selects from. */
/** @type {Row[]} */
let rows = [];
/** @type {Set<string>} */
let selected = new Set();
/** @type {string | null} */
let anchor = null;
let searchTimer = 0;
/** @type {Row[]} the files and folders being dragged out of the panel (or last dragged) */
let dragged = [];

/** A count of items, for titles. @param {number} n */
const itemsText = n => (n === 1 ? '1 item' : `${n} items`);
/** The rows selected (not the tree's root), in the tree's order. */
const selectedRows = () => rows.filter(r => r.entry && selected.has(r.path));
/** A row as "Copy to" and the deleting take it. @param {Row} r */
const itemOf = r => ({ name: /** @type {FileEntry} */ (r.entry).name, isDirectory: /** @type {FileEntry} */ (r.entry).isDirectory, path: r.path });

/**
 * The folder something new goes into: the folder selected, or the one the file selected is in; else the shell's.
 * None when that's the drives.
 */
function targetDir() {
  if (!view) return null;
  const only = selected.size === 1 ? rows.find(r => selected.has(r.path)) : null;
  const dir = only ? (only.entry && !only.entry.isDirectory ? only.dir : only.path) : view.cwd ?? rootOf(view.tab);
  return dir === FOLDER_PATH.drives ? null : dir;
}

// ---- Reading folders ----

/**
 * Reads the folders not read yet (all at once: one ssh call on a server); an answer that comes after the panel
 * moved to another terminal still fills that terminal's tree.
 * @param {FilesView} v
 * @param {string[]} paths
 */
async function load(v, paths) {
  const wanted = paths.filter(path => !v.nodes.has(path) && !v.loading.has(path));
  if (!wanted.length) return;
  for (const path of wanted) v.loading.add(path);
  render();
  const error = await readFolders(v.tab, v.nodes, wanted, true);
  for (const path of wanted) v.loading.delete(path);
  v.error = error;
  if (v === view) render();
}

/**
 * Opens the tree down to a folder (the shell's) and marks it; the folders opened by hand stay open.
 * @param {FilesView} v
 * @param {string} path
 */
async function reveal(v, path) {
  const { there, error } = await pathDown(v.tab, v.nodes, path, true);
  v.error = error;
  for (const p of there) v.open.add(p);
  v.cwd = there[there.length - 1];
  v.moved = null;
  if (v !== view) return;
  render();
  // At the top, so what's in it shows below.
  panel.querySelector('.files-item.cwd')?.scrollIntoView({ block: 'start' });
}

/**
 * Reads folders again (after something changed in them), those open at once.
 * @param {Array<string | null | undefined>} dirs
 */
function reload(dirs) {
  const v = view;
  if (!v) return;
  const again = [...new Set(dirs.filter(d => d != null))].filter(d => v.nodes.delete(/** @type {string} */ (d)));
  load(v, /** @type {string[]} */ (again.filter(d => v.open.has(/** @type {string} */ (d)))));
}

/** Everything open, read again. */
function refresh() {
  if (!view) return;
  view.nodes.clear();
  load(view, [...view.open]);
}

/** Collapses every folder (the top level stays), or, when they are, opens the tree to the shell's folder again. */
function fold() {
  if (!view) return;
  if (view.open.size > 1) {
    view.open = new Set([rootOf(view.tab)]);
    render();
    panel.querySelector(LIST)?.scrollTo({ top: 0 });
  } else reveal(view, view.cwd ?? shellFolderOf(view.tab));
}

/**
 * Opens a folder (read if it wasn't) or closes it.
 * @param {string} path
 */
function toggle(path) {
  if (!view) return;
  if (view.open.delete(path)) return render();
  view.open.add(path);
  render();
  load(view, [path]);
}

/**
 * A terminal's tree, as the panel left it, or a new one opening at its shell's folder.
 * @param {Tab} tab
 */
function viewOf(tab) {
  const kept = views.get(tab.id);
  if (kept) return kept;
  /** @type {FilesView} */
  const v = { tab, server: isSsh(tab), nodes: new Map(), open: new Set(), loading: new Set(), cwd: null, moved: shellFolderOf(tab), error: null, query: '', search: null };
  views.set(tab.id, v);
  return v;
}

/**
 * Shows a terminal's tree, going to its shell's folder if it moved (or the tree is new).
 * @param {Tab} tab
 */
function show(tab) {
  view = viewOf(tab);
  selected = new Set();
  anchor = null;
  render();
  if (view.moved) reveal(view, view.moved);
}

/** @param {Tab | null | undefined} [tab] */
export function toggleFiles(tab = focusedTab()) {
  if (!panel.hidden && (!tab || view?.tab === tab || without === tab)) {
    panel.hidden = true;
    view = null;
    without = null;
    views.clear(); // opened again, it starts where each terminal's shell is
    keep();
    return;
  }
  if (!tab || !hasFiles(tab)) return;
  panel.hidden = false;
  show(tab);
}

/** The terminal the open panel shows without files (it has none to show), else null. */
/** @type {Tab | null} */
let without = null;

/**
 * The open panel shows another terminal: its tree, or why it has none (a container, a serial port, a terminal of
 * another computer that doesn't share its files). With no terminal left, it closes.
 * @param {Tab | null | undefined} tab
 */
function follow(tab) {
  if (panel.hidden) return;
  if (!tab) {
    toggleFiles(null);
    return;
  }
  if (hasFiles(tab)) {
    without = null;
    show(tab);
    return;
  }
  view = null;
  without = tab;
  panel.innerHTML = `
    <div class="${DOCK_GRIP}" title="Drag to resize"></div>
    <div class="files-head">
      ${titleIconHtml(filesButton)}
      <span class="files-title">Files · ${escapeHtml(tabTitle(tab))}</span>
      <span class="files-tools"><button class="pane-btn" data-files="${FILES_ACTION.close}" title="Close">${ICONS.close}</button></span>
    </div>
    <div class="files-none">${escapeHtml(whyNoFiles(tab))}</div>`;
}

/** Why a terminal's files can't be shown here. @param {Tab} tab */
function whyNoFiles(tab) {
  const source = profileOf(tab)?.source;
  if (tab.virtual) return 'Its files show here while that computer allows typing (its Settings › Remote › Allow typing).';
  if (source === PROFILE_SOURCE.serial) return 'A serial port has no files to show.';
  if (source === PROFILE_SOURCE.docker || source === PROFILE_SOURCE.kubernetes) return 'A container’s files can’t be shown here.';
  return 'This terminal’s files can’t be shown here.';
}

/** Keeps how the panel is (open, its terminal, the folders open, the scroll) for a restart. */
function keep() {
  const list = /** @type {HTMLElement | null} */ (panel.querySelector(LIST));
  state.files = {
    ...state.files, open: !panel.hidden, tabId: view?.tab.id ?? null, folders: view ? [...view.open] : [],
    scroll: list?.scrollTop ?? 0,
  };
  persist();
}

/**
 * The panel as Termilly left it: open on the same terminal's tree (or the one in focus), its folders open again and
 * read, scrolled where it was.
 */
export async function initFiles() {
  const saved = state.files;
  if (saved.width) panel.style.width = `${saved.width}px`;
  const tab = (saved.tabId && state.tabs.get(saved.tabId)) || focusedTab();
  if (!saved.open || !tab || !hasFiles(tab)) return;
  const v = viewOf(tab);
  if (saved.tabId === tab.id && saved.folders?.length) {
    v.open = new Set(saved.folders);
    v.moved = null;
    restored.add(v);
  }
  panel.hidden = false;
  view = v;
  render();
  if (!restored.has(v)) return reveal(v, shellFolderOf(tab));
  await load(v, [...v.open]);
  // Folders deleted or moved since aren't open any more (their parent no longer lists them, so they never showed).
  for (const path of [...v.open]) if (v.nodes.get(path)?.error) v.open.delete(path);
  render();
  const list = /** @type {HTMLElement | null} */ (panel.querySelector(LIST));
  if (list) list.scrollTop = saved.scroll ?? 0;
}

// The title bar's File Explorer button.
filesButton.addEventListener('click', () => toggleFiles());

// ---- Drawing ----

/**
 * Whether a folder shows open: in the tree, opened; searching, holding something found.
 * @param {FilesView} v
 * @param {string} path
 */
const isOpen = (v, path) => (v.search ? v.search.nodes.has(path) : v.open.has(path));

/**
 * A row: its sign, icon and name, a file's size, and the buttons its hover shows.
 * @param {Row} r
 * @param {number} i
 */
function rowHtml(r, i) {
  const v = /** @type {FilesView} */ (view);
  const e = r.entry;
  const cls = `files-item${!e || e.isDirectory ? ' dir' : ''}${selected.has(r.path) ? ' selected' : ''}${r.path === v.cwd ? ' cwd' : ''}`;
  if (!e) {
    const name = v.server ? `${placeOf(v.tab)} (/)` : r.path === FOLDER_PATH.drives ? DRIVES_NAME : '/';
    return `<div class="${cls}" data-i="${i}" data-depth="0">${signHtml(true, isOpen(v, r.path))}<span class="files-name">${ICONS.monitor} ${escapeHtml(name)}</span></div>`;
  }
  const node = v.nodes.get(r.path);
  const has = e.isDirectory && (r.dir === FOLDER_PATH.drives || !!v.nodes.get(/** @type {string} */ (r.dir))?.folders.find(f => f.name === e.name)?.hasFolders || !!node?.entries?.length || !!v.search?.nodes.has(r.path));
  const drive = e.label != null;
  const name = drive ? `${DRIVE_ICON}${escapeHtml(`${e.label} (${e.name.replace(/\\$/, '')})`)}` : `${e.isDirectory ? '📁' : '📄'} ${escapeHtml(e.name)}`;
  const title = drive ? e.modified : [e.permissions, e.modified].filter(Boolean).join(' · ');
  return `
  <div class="${cls}" data-i="${i}" data-depth="${r.depth}" draggable="true" title="${escapeHtml(title)}">
    ${signHtml(has, isOpen(v, r.path))}
    <span class="files-name">${name}</span>
    <span class="files-size">${e.isDirectory ? '' : sizeText(e.size)}</span>
    ${drive ? '' : `<span class="files-actions">
      ${v.server ? `<button class="pane-btn" data-files="${FILES_ACTION.get}" title="Download to Downloads">↓</button>` : ''}
      <button class="pane-btn" data-files="${FILES_ACTION.rename}" title="Rename">${ICONS.rename}</button>
      <button class="pane-btn" data-files="${FILES_ACTION.delete}" title="Delete">${ICONS.trash}</button>
    </span>`}
  </div>`;
}

/**
 * A row that isn't a file: loading, or why a folder can't be read.
 * @param {number} depth
 * @param {string} html
 */
const noteRow = (depth, html) => `<div class="files-item files-note" data-depth="${depth}">${html}</div>`;

/**
 * Adds an entry's row (to `rows` and `html`); returns its path.
 * @param {string[]} html
 * @param {string} dir
 * @param {FileEntry} e
 * @param {number} depth
 */
function addRow(html, dir, e, depth) {
  const row = { path: childPath(dir, e.name), entry: e, depth, dir };
  rows.push(row);
  html.push(rowHtml(row, rows.length - 1));
  return row.path;
}

/**
 * The search's rows: its line (running, what it found, or why it failed), then what it found, under the folders down
 * to it, all open.
 * @param {FilesView} v
 * @param {Search} found
 * @param {string[]} html
 */
function foundHtml(v, found, html) {
  // The folder's name says where; its whole path shows on pointing at it.
  const where = found.dir === FOLDER_PATH.drives ? folderName(found.dir) : nameIn(found.dir);
  const line = found.error ? `<span class="files-error">${escapeHtml(found.error)}</span>`
    : !found.done ? `<span class="files-searching"></span>Searching ${escapeHtml(where)} · ${found.count.toLocaleString()} found`
    : found.stopped ? `Stopped at ${found.count.toLocaleString()} found in ${escapeHtml(where)}: a longer name finds fewer`
    : found.count ? `${found.count.toLocaleString()} found in ${escapeHtml(where)}` : `Nothing by that name in ${escapeHtml(where)}`;
  html.unshift(`<div class="files-status" title="${escapeHtml(folderName(found.dir))}">${line}</div>`);
  /**
   * @param {string} path
   * @param {number} depth
   */
  const walk = (path, depth) => {
    const entries = [...found.nodes.get(path) ?? []].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
    for (const e of entries) {
      const at = addRow(html, path, e, depth);
      if (e.isDirectory) walk(at, depth + 1);
    }
  };
  walk(rows[0].path, 1);
}

/** The tree's rows (into `rows`) and their markup. @param {FilesView} v */
function treeHtml(v) {
  if (v.error) {
    rows = [];
    return `<div class="inbox-empty files-error">${escapeHtml(v.error)}</div>`;
  }
  const root = rootOf(v.tab);
  rows = [{ path: root, entry: null, depth: 0, dir: null }];
  const html = [rowHtml(rows[0], 0)];
  if (v.search) {
    foundHtml(v, v.search, html);
    return html.join('');
  }
  /**
   * @param {string} path
   * @param {number} depth
   */
  const walk = (path, depth) => {
    if (!v.open.has(path)) return;
    const node = v.nodes.get(path);
    if (!node) {
      if (v.loading.has(path)) html.push(noteRow(depth, 'Loading…'));
      return;
    }
    if (node.error) html.push(noteRow(depth, `<span class="files-error">${escapeHtml(node.error)}</span>`));
    else if (!node.entries?.length && depth > 1) html.push(noteRow(depth, 'Empty'));
    for (const e of node.entries ?? []) {
      const at = addRow(html, path, e, depth);
      if (e.isDirectory) walk(at, depth + 1);
    }
  };
  walk(root, 1);
  return html.join('');
}

function render() {
  if (!view) return;
  const { tab, server } = view;
  const list = panel.querySelector(LIST);
  const scroll = list?.scrollTop ?? 0;
  const target = targetDir();
  // Folders open below the top level: the button folds them all; else it opens the tree to the shell's folder.
  const folded = view.open.size <= 1;
  const ws = wsById(tab.wsId)?.name;
  // Drawn again while typing (a folder read comes in): the search box keeps the caret.
  const typing = /** @type {HTMLInputElement | null} */ (document.activeElement?.closest(SEARCH) ?? null);
  const caret = typing?.selectionStart ?? null;
  panel.innerHTML = `
    <div class="${DOCK_GRIP}" title="Drag to resize"></div>
    <div class="files-head">
      ${titleIconHtml(filesButton)}
      <span class="files-title">Files · ${escapeHtml(tabTitle(tab))}${ws ? ` <span class="files-ws">${escapeHtml(ws)}</span>` : ''}</span>
      <span class="files-tools">
        <button class="pane-btn" data-files="${FILES_ACTION.refresh}" title="Refresh">${REFRESH_ICON}</button>
        <button class="pane-btn" data-files="${FILES_ACTION.mkdir}" title="New folder in the folder selected"${target ? '' : ' disabled'}>${ICONS.plus}</button>
        <button class="pane-btn" data-files="${FILES_ACTION.fold}" title="${folded ? 'Open the folders to the shell’s folder' : 'Collapse all folders'}">${folded ? EXPAND_ICON : COLLAPSE_ICON}</button>
        <button class="pane-btn" data-files="${FILES_ACTION.close}" title="Close">${ICONS.close}</button>
      </span>
    </div>
    <div class="files-bar">
      <input class="field files-search" type="search" placeholder="${escapeHtml(searchHint())}" title="Searches the folder selected (or the shell’s) and every folder in it. * and ? match any letters, or one" spellcheck="false" autocomplete="off" data-files-search value="${escapeHtml(view.query)}">
      ${server ? '<label class="btn small files-upload" title="Upload files into the folder selected">Upload<input type="file" multiple hidden data-files-pick></label>' : ''}
    </div>
    ${isWsl(tab) && tab.remoteCwd == null ? `<div class="files-hint">Termilly isn’t set up in ${escapeHtml(wslDistroOf(tab) ?? '')} yet, so this can’t follow the shell’s folder. The bar over the terminal sets it up.</div>` : ''}
    <div class="files-list">${treeHtml(view)}</div>`;
  const drawn = /** @type {HTMLElement} */ (panel.querySelector(LIST));
  indentRows(drawn);
  drawn.scrollTop = scroll;
  keep();
  if (typing) {
    const box = /** @type {HTMLInputElement} */ (panel.querySelector(SEARCH));
    box.focus();
    box.setSelectionRange(caret, caret);
  }
}

/**
 * Draws the tree again (the search box stays as it is): from the top for a new search, else where it was scrolled.
 * @param {boolean} [top]
 */
function drawTree(top = false) {
  if (!view) return;
  const list = /** @type {HTMLElement} */ (panel.querySelector(LIST));
  const scroll = top ? 0 : list.scrollTop;
  list.innerHTML = treeHtml(view);
  indentRows(list);
  list.scrollTop = scroll;
}

// ---- Searching ----

/**
 * Searches what the box holds in the folder selected (or the one the file selected is in), else the shell's, and
 * every folder in it; an empty box stops the search and shows the tree again.
 */
function search() {
  if (!view) return;
  const text = view.query.trim();
  if (!text) {
    if (view.search) send(PAGE.filesSearch, { id: view.tab.id, text: '' });
    view.search = null;
    drawTree(true);
    return;
  }
  const dir = searchDir();
  view.search = { id: newRequestId(), dir, nodes: new Map(), count: 0, done: false, stopped: false, error: null };
  send(PAGE.filesSearch, { id: view.tab.id, searchId: view.search.id, dir, text });
  drawTree(true);
}

/**
 * Where a search looks: the folder selected (the drives: every drive), or the one the file selected is in; else the
 * one searched already (refining the text keeps it); else the shell's.
 */
function searchDir() {
  const v = /** @type {FilesView} */ (view);
  return (selected.size === 1 ? targetDir() ?? FOLDER_PATH.drives : null) ?? v.search?.dir ?? targetDir() ?? rootOf(v.tab);
}

/** What the search box says when it's empty: where it will look. */
const searchHint = () => {
  const dir = searchDir();
  return `Search ${dir === FOLDER_PATH.drives || dir === '/' ? folderName(dir) : nameIn(dir)}`;
};

/** The name a folder has in the one it's in: a drive's root ("D:\") as it is, else its last name. @param {string} path */
const nameIn = path => (parentOf(path) === FOLDER_PATH.drives ? path : path.split(/[\\/]/).filter(Boolean).pop() ?? path);

/**
 * Takes in a file or folder found: in the folder it's in, and that folder in its own, up to the tree's root.
 * @param {FilesView} v
 * @param {Search} found
 * @param {string} dir
 * @param {FileEntry} entry
 */
function addFound(v, found, dir, entry) {
  /**
   * @param {string} folder
   * @param {FileEntry} e
   */
  const put = (folder, e) => {
    const list = found.nodes.get(folder) ?? [];
    if (!list.some(x => x.name === e.name)) list.push(e);
    found.nodes.set(folder, list);
  };
  put(dir, entry);
  const root = rootOf(v.tab);
  for (let d = dir; d !== root;) {
    const up = parentOf(d);
    if (up === d) break;
    // A folder the tree has read keeps what it knows of it (a drive's label).
    const known = v.nodes.get(up)?.entries?.find(x => childPath(up, x.name) === d);
    put(up, known ?? { name: nameIn(d), isDirectory: true, size: 0, modified: '', permissions: '' });
    d = up;
  }
}

onHost(HOST.filesFound, m => {
  const v = [...views.values()].find(x => x.search?.id === m.searchId);
  const found = v?.search;
  if (!v || !found) return;
  for (const f of /** @type {{ dir: string, entry: FileEntry }[]} */ (m.found)) addFound(v, found, f.dir, f.entry);
  found.count += m.found.length;
  if (m.done) Object.assign(found, { done: true, stopped: !!m.stopped, error: m.error ?? null });
  if (v === view) drawTree();
});

// ---- What files and folders can do ----

/**
 * Runs a file operation on each of `items` as one job (its note says how it went); `after` once all are done.
 * @param {string} kind
 * @param {{ name: string, fields: { op: string, path: string | null, to?: string } }[]} items
 * @param {{ where?: string | null, after?: () => void }} [options]
 */
function operate(kind, items, { where = null, after } = {}) {
  if (!view || !items.length) return;
  const requestId = newRequestId();
  startJob(requestId, items.map(i => i.name), { kind, here: !view.server, where, after });
  for (const { fields } of items) send(PAGE.filesOp, { id: view.tab.id, requestId, ...fields });
}

/**
 * Asks for a name in the app's own dialog.
 * @param {string} title
 * @param {string} [value]
 */
function askName(title, value = '') {
  return modal(CONFIRM_DIALOG, `
    <h3>${escapeHtml(title)}</h3>
    <input class="field" data-name value="${escapeHtml(value)}" autofocus spellcheck="false">
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>OK</button></div>`, (dialog, /** @type {(name: string | null) => void} */ close) => {
    const submit = () => close(field(dialog, '[data-name]').value.trim() || null);
    return { submit };
  });
}

/** @param {string | null} [dir] the folder it goes in */
async function makeFolder(dir = targetDir()) {
  if (!dir) return;
  const name = await askName('New folder');
  if (!name || !view) return;
  view.open.add(dir);
  operate(JOB_KIND.mkdir, [{ name, fields: { op: FILE_OP.makeDirectory, path: childPath(dir, name) } }], { after: () => reload([dir]) });
}

/** @param {Row} r */
async function rename(r) {
  const e = /** @type {FileEntry} */ (r.entry);
  const to = await askName(`Rename ${e.name}`, e.name);
  if (!to || to === e.name || !r.dir) return;
  operate(JOB_KIND.rename, [{ name: `${e.name} → ${to}`, fields: { op: FILE_OP.rename, path: r.path, to: childPath(r.dir, to) } }], { after: () => reload([r.dir]) });
}

/**
 * Deletes files and folders, once asked: here to the Recycle Bin, on a server for good (only empty folders).
 * @param {Row[]} items
 */
async function remove(items) {
  const v = view;
  if (!v || !items.length || items.some(r => r.dir === FOLDER_PATH.drives)) return;
  const entries = items.map(r => /** @type {FileEntry} */ (r.entry));
  const body = !v.server ? `${items.length === 1 ? 'It goes' : 'They go'} to ${BIN}.`
    : `${entries.some(e => e.isDirectory) ? 'Only empty folders can be deleted. ' : ''}It’s deleted on the server; there’s no undo.`;
  const title = items.length === 1 ? `Delete ${entries[0].name}?` : `Delete ${itemsText(items.length)}?`;
  if (!await confirmDialog({ title, body, confirm: 'Delete' }) || view !== v) return;
  selected = new Set();
  operate(JOB_KIND.delete, items.map(r => ({
    name: /** @type {FileEntry} */ (r.entry).name,
    fields: { op: /** @type {FileEntry} */ (r.entry).isDirectory ? FILE_OP.removeDirectory : FILE_OP.remove, path: r.path },
  })), { after: () => reload(items.map(r => r.dir)) });
}

/** Downloads files and folders from the server to Downloads. @param {Row[]} items */
const download = items => operate(JOB_KIND.get, items.map(r => ({ name: /** @type {FileEntry} */ (r.entry).name, fields: { op: FILE_OP.get, path: r.path } })));

/** Downloads files and folders from the server to a folder the host asks for. @param {Row[]} items */
function downloadTo(items) {
  if (!view || !items.length) return;
  const requestId = newRequestId();
  expectJob(requestId, { kind: JOB_KIND.get });
  send(PAGE.filesGetTo, { id: view.tab.id, requestId, paths: items.map(r => r.path) });
}

/**
 * "Copy to": asks for the terminal's folder (and about what's already there), then copies, as one job. Given a
 * terminal, they go into its shell's folder, without asking where.
 * @param {Row[]} items
 * @param {Tab | null} [target]
 */
async function copyTo(items, target = null) {
  const v = view;
  if (!v || !items.length || items.some(r => r.dir === FOLDER_PATH.drives)) return;
  const plan = target ? await planInto(v.tab, items.map(itemOf), target, shellFolderOf(target)) : await planCopy(v.tab, items.map(itemOf));
  if (!plan) return;
  const requestId = newRequestId();
  // The folder it went to is read again where it's shown, on that machine, and the one it's in (its +).
  const after = () => { if (view && sameMachine(view.tab, plan.to)) reload([plan.dir, parentOf(plan.dir)]); };
  startJob(requestId, plan.items.map(i => i.name), { kind: JOB_KIND.copy, where: folderOf(plan.to, plan.dir), after });
  send(PAGE.filesCopyTo, { id: v.tab.id, requestId, to: plan.to.id, dir: plan.dir, items: plan.items });
}

/**
 * Types files' and folders' names in a terminal, quoted for its shell: from its shell's folder when they're in it
 * (on the same machine), else their whole paths.
 * @param {Tab} tab
 * @param {string[]} paths
 */
function pasteNames(tab, paths) {
  const here = shellFolderOf(tab).replace(/[\\/]$/, '');
  const near = !!view && sameMachine(view.tab, tab) && here !== '~';
  typePaths(tab, paths.map(p => (near && p.length > here.length && isInside(p, here) ? p.slice(here.length + 1) : p)));
}

/**
 * What the files' own terminal can do with them: copy them into its shell's folder (unless they're all there
 * already), or type their names.
 * @param {Tab} tab
 * @param {Row[]} items
 * @returns {import('./popups.js').MenuEntry[]}
 */
function terminalItems(tab, items) {
  const here = shellFolderOf(tab);
  const inPlace = items.every(r => r.dir && isInside(r.dir, here) && isInside(here, r.dir));
  const many = items.length > 1;
  return [
    ...(inPlace || items.some(r => r.dir === FOLDER_PATH.drives) ? [] : [{ label: 'Copy to the terminal’s folder', icon: ICONS.copy, action: () => copyTo(items, tab) }]),
    { label: many ? 'Paste names in the terminal' : 'Paste name in the terminal', action: () => pasteNames(tab, items.map(r => r.path)) },
  ];
}

/** @param {string} text */
const copyText = text => navigator.clipboard.writeText(text);

/**
 * Opens what was double-clicked: a folder (or drive) opens or closes, a file here shows in the preview.
 * @param {Row} r
 */
function openRow(r) {
  if (!view) return;
  if (!r.entry || r.entry.isDirectory) toggle(r.path);
  else if (!view.server) showChange(view.tab, r.path);
}

/** The row an event is on, and its index. @param {Event} e */
const rowOf = e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-i]'));
  const i = row ? Number(row.dataset.i) : -1;
  return { i, r: rows[i] ?? null };
};

panel.addEventListener('click', e => {
  if (without && /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-files]'))?.dataset.files === FILES_ACTION.close) return toggleFiles(without);
  if (!view) return;
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-files]'))?.dataset.files;
  const { i, r } = rowOf(e);
  if (action === FILES_ACTION.close) return toggleFiles(view.tab);
  if (action === FILES_ACTION.refresh) return refresh();
  if (action === FILES_ACTION.fold) return fold();
  if (action === FILES_ACTION.mkdir) return makeFolder();
  // A click on the tree's empty space clears the selection; one on the search box (or a button) keeps it.
  if (!r) return action || !targetOf(e).closest(LIST) ? undefined : selectRows(new Set(), null);
  // The sign opens or closes; a double click's second click on it was a click already.
  if (targetOf(e).closest('[data-twist]')) return e.detail < 2 ? toggle(r.path) : undefined;
  // A row's own button acts on the selection when the row is in it, else on that row alone.
  const items = selected.has(r.path) ? selectedRows() : [r];
  if (action === FILES_ACTION.get) return download(items);
  if (action === FILES_ACTION.rename) return rename(r);
  if (action === FILES_ACTION.delete) return remove(items);
  if (!action) clickRow(i, e);
});

// A double click opens a row (as in Explorer). The rows aren't drawn again by the click before it, or the double
// click would lose the row it started on.
panel.addEventListener('dblclick', e => {
  const { r } = rowOf(e);
  if (r && !targetOf(e).closest('[data-files], [data-twist]') && !e.ctrlKey && !e.shiftKey) openRow(r);
});

// ---- Selecting: a click, Ctrl+click to add or take away, Shift+click for a range, Ctrl+A for all ----

/**
 * Selects rows by path (without drawing the tree again, so a double click keeps its row).
 * @param {Set<string>} paths
 * @param {string | null} from the row Shift+click selects from
 */
function selectRows(paths, from) {
  selected = paths;
  anchor = from;
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('.files-item[data-i]'))) {
    row.classList.toggle('selected', selected.has(rows[Number(row.dataset.i)]?.path));
  }
  const target = targetDir();
  /** @type {HTMLButtonElement | null} */ (panel.querySelector(`[data-files="${FILES_ACTION.mkdir}"]`))?.toggleAttribute('disabled', !target);
  /** @type {HTMLInputElement | null} */ (panel.querySelector(SEARCH))?.setAttribute('placeholder', searchHint());
}

/**
 * @param {number} i
 * @param {MouseEvent} e
 */
function clickRow(i, e) {
  panel.focus({ preventScroll: true });
  const path = rows[i].path;
  const from = anchor ? rows.findIndex(r => r.path === anchor) : -1;
  if (e.shiftKey && from >= 0) {
    const range = new Set(rows.slice(Math.min(from, i), Math.max(from, i) + 1).filter(r => r.entry).map(r => r.path));
    selectRows(e.ctrlKey ? new Set([...selected, ...range]) : range, anchor);
  } else if (e.ctrlKey || e.metaKey) {
    const paths = new Set(selected);
    if (!paths.delete(path)) paths.add(path);
    selectRows(paths, path);
  } else selectRows(new Set([path]), path);
}

/**
 * The arrows: up and down move the selection, right opens a folder, left closes it (or goes to its folder).
 * @param {string} key
 */
function arrow(key) {
  const at = anchor ? rows.findIndex(r => r.path === anchor) : -1;
  const r = rows[at];
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (key === 'ArrowDown' ? 1 : -1)))];
    if (next) selectRows(new Set([next.path]), next.path);
    panel.querySelector('.files-item.selected')?.scrollIntoView({ block: 'nearest' });
  } else if (r && key === 'ArrowRight' && (!r.entry || r.entry.isDirectory) && !view?.open.has(r.path)) toggle(r.path);
  else if (r && key === 'ArrowLeft') {
    if (view?.open.has(r.path)) toggle(r.path);
    else if (r.dir) selectRows(new Set([r.dir]), r.dir);
  }
}

panel.addEventListener('keydown', e => {
  if (!view || targetOf(e).closest('input')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'a') selectRows(new Set(rows.filter(r => r.entry).map(r => r.path)), null);
  else if (e.key === 'Escape' && selected.size) selectRows(new Set(), null);
  else if (e.key === 'Delete' && selected.size) remove(selectedRows());
  else if (e.key === 'Enter' && selected.size === 1) openRow(/** @type {Row} */ (rows.find(r => selected.has(r.path))));
  else if (e.key.startsWith('Arrow')) arrow(e.key);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

// ---- The right-click menu ----

/**
 * What a file or folder's menu offers: opening it, getting it here (on a server), copying it to another terminal's
 * folder, its path, the actions that take a file (here), and renaming or deleting it.
 * @param {FilesView} v
 * @param {Row} r
 * @returns {import('./popups.js').MenuEntry[]}
 */
function itemMenu(v, r) {
  const e = /** @type {FileEntry} */ (r.entry);
  const open = e.isDirectory ? [{ label: v.open.has(r.path) ? 'Close folder' : 'Open', icon: ICONS.folder, action: () => toggle(r.path) }]
    : v.server ? [] : [
      { label: 'Preview', action: () => showChange(v.tab, r.path) },
      { label: 'Open in its app', action: () => operate(JOB_KIND.open, [{ name: e.name, fields: { op: FILE_OP.open, path: r.path } }]) },
    ];
  const here = v.server ? [] : [
    ...(e.isDirectory ? [{ label: 'Open a terminal here', icon: ICONS.terminal, action: () => newTab({ profile: v.tab.profile, wsId: v.tab.wsId, cwd: r.path }) }] : []),
    { label: `Show in ${FILE_MANAGER}`, action: () => send(PAGE.openPath, { path: r.path }) },
  ];
  const actions = v.server ? [] : pathActions(v.tab, r.path, e.isDirectory ? r.path : /** @type {string} */ (r.dir));
  const drive = r.dir === FOLDER_PATH.drives;
  return [
    ...open, ...here, ...transferItems(v, [r]), SEPARATOR,
    { label: 'Copy path', icon: ICONS.copy, action: () => copyText(shellPathOf(v.tab, r.path)) },
    ...terminalItems(v.tab, [r]),
    .../** @type {import('./popups.js').MenuEntry[]} */ (actions.length ? [SEPARATOR, ...actions] : []),
    .../** @type {import('./popups.js').MenuEntry[]} */ (e.isDirectory ? [SEPARATOR, { label: 'New folder', icon: ICONS.plus, action: () => makeFolder(r.path) }] : []),
    // A drive can't be renamed or deleted from here.
    .../** @type {import('./popups.js').MenuEntry[]} */ (drive ? [] : [
      SEPARATOR,
      { label: 'Rename', icon: ICONS.rename, action: () => rename(r) },
      { label: 'Delete', icon: ICONS.trash, danger: true, action: () => remove([r]) },
    ]),
  ];
}

/**
 * Getting files and folders elsewhere: to another terminal's folder, and from a server to this machine.
 * @param {FilesView} v
 * @param {Row[]} items
 * @returns {import('./popups.js').MenuEntry[]}
 */
const transferItems = (v, items) => (items.some(r => r.dir === FOLDER_PATH.drives) ? [] : [
  ...(v.server ? [
    { label: 'Download to Downloads', action: () => download(items) },
    { label: 'Download to', action: () => downloadTo(items) },
  ] : []),
  { label: 'Copy to', icon: ICONS.copy, action: () => copyTo(items) },
]);

/**
 * The menu of several files and folders selected.
 * @param {FilesView} v
 * @param {Row[]} items
 * @returns {import('./popups.js').MenuEntry[]}
 */
function selectionMenu(v, items) {
  const paths = items.map(r => r.path);
  return [
    ...transferItems(v, items), SEPARATOR,
    { label: 'Copy paths', icon: ICONS.copy, action: () => copyText(paths.map(p => shellPathOf(v.tab, p)).join('\n')) },
    ...terminalItems(v.tab, items),
    .../** @type {import('./popups.js').MenuEntry[]} */ (items.some(r => r.dir === FOLDER_PATH.drives) ? [] : [
      SEPARATOR,
      { label: `Delete ${itemsText(items.length)}`, icon: ICONS.trash, danger: true, action: () => remove(items) },
    ]),
  ];
}

/**
 * The menu of the tree's root, or of the space below the rows: the shell's folder.
 * @param {FilesView} v
 * @returns {import('./popups.js').MenuEntry[]}
 */
function folderMenu(v) {
  const dir = v.cwd;
  const refreshItem = { label: 'Refresh', action: refresh };
  if (!dir || dir === FOLDER_PATH.drives) return [refreshItem];
  return [
    { label: 'New folder', icon: ICONS.plus, action: () => makeFolder(dir) },
    refreshItem,
    ...(v.server ? [] : [{ label: `Show in ${FILE_MANAGER}`, action: () => send(PAGE.openPath, { path: dir }) }]),
    SEPARATOR,
    { label: 'Copy path', icon: ICONS.copy, action: () => copyText(shellPathOf(v.tab, dir)) },
    { label: 'Insert path in the terminal', action: () => pasteNames(v.tab, [dir]) },
  ];
}

panel.addEventListener('contextmenu', e => {
  if (!view || !targetOf(e).closest(LIST)) return;
  e.preventDefault();
  const { r } = rowOf(e);
  // Right-clicking a row outside the selection selects that row alone, as Explorer does.
  if (r?.entry && !selected.has(r.path)) selectRows(new Set([r.path]), r.path);
  const menu = !r?.entry ? folderMenu(view) : selected.size > 1 ? selectionMenu(view, selectedRows()) : itemMenu(view, r);
  showMenu(menu, { x: e.clientX, y: e.clientY });
});

// ---- Files in: uploads to a server, copies here ----

/**
 * Copies files into a folder (uploads them, on a server). On Windows the files go to the host with the message
 * (WebView2 gives their paths); on Linux the page sends the paths a drop carried (`paths`).
 * @param {string | null} dir
 * @param {FileList | null} files
 * @param {string[] | null} [paths]
 */
function copyIn(dir, files, paths = null) {
  if (!view || !dir || !(paths ?? files)?.length) return;
  const requestId = newRequestId();
  const names = paths ? paths.map(p => /** @type {string} */ (p.split(/[\\/]/).pop())) : [.../** @type {FileList} */ (files)].map(f => f.name);
  view.open.add(dir);
  startJob(requestId, names, { kind: JOB_KIND.put, here: !view.server, where: folderOf(view.tab, dir), after: () => reload([dir]) });
  if (paths) send(PAGE.filesPut, { id: view.tab.id, requestId, dir, paths });
  else if (window.chrome?.webview) sendWithFiles(PAGE.filesPut, { id: view.tab.id, requestId, dir }, /** @type {FileList} */ (files));
}

panel.addEventListener('input', e => {
  if (!view || !targetOf(e).matches(SEARCH)) return;
  view.query = /** @type {HTMLInputElement} */ (e.target).value;
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(search, TYPING_MS);
});
// Escape in the search box empties it (the box's own way), and a second one goes back to the tree.
panel.addEventListener('keydown', e => {
  const box = /** @type {HTMLInputElement} */ (e.target);
  if (e.key !== 'Escape' || !targetOf(e).matches(SEARCH) || box.value) return;
  panel.focus();
});
panel.addEventListener('change', e => {
  if (targetOf(e).matches('[data-files-pick]')) copyIn(targetDir(), /** @type {HTMLInputElement} */ (e.target).files);
});
// Linux: the Upload button opens the host's file dialog instead of the page's.
panel.addEventListener('click', e => {
  const dir = targetDir();
  if (platform !== PLATFORM.linux || !view || !dir || !targetOf(e).closest('.files-upload')) return;
  e.preventDefault();
  const requestId = newRequestId();
  view.open.add(dir);
  expectJob(requestId, { kind: JOB_KIND.put, where: folderOf(view.tab, dir), after: () => reload([dir]) });
  send(PAGE.filesPick, { id: view.tab.id, requestId, dir });
});
// Files and folders dragged out of the panel carry their paths, one a line: a terminal types them where they're
// dropped (terminals.js). A row in the selection drags the whole selection.
panel.addEventListener('dragstart', e => {
  const { r } = rowOf(e);
  if (!r?.entry || !e.dataTransfer) return;
  dragged = selected.has(r.path) ? selectedRows() : [r];
  const paths = dragged.map(x => x.path).join('\n');
  e.dataTransfer.setData(PATH_DRAG, paths);
  e.dataTransfer.setData('text/plain', paths);
  e.dataTransfer.effectAllowed = COPY_EFFECT;
});
/**
 * The folder files dropped at an event go into: the folder dropped on, or the one the file dropped on is in; below
 * the rows, the shell's.
 * @param {Event} e
 */
function dropDir(e) {
  const { r } = rowOf(e);
  if (!r) return view?.cwd === FOLDER_PATH.drives ? null : view?.cwd ?? null;
  const dir = !r.entry || r.entry.isDirectory ? r.path : r.dir;
  return dir === FOLDER_PATH.drives ? null : dir;
}
// Dropped on a terminal (terminals.js): copy them into its shell's folder, or type their names there.
on(EVENTS.panelDrop, (/** @type {{ tab: Tab, x: number, y: number }} */ { tab, x, y }) => {
  if (dragged.length) showMenu(terminalItems(tab, dragged), { x, y });
});

panel.addEventListener('dragover', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  panel.classList.add('drop');
  const { r } = rowOf(e);
  for (const row of panel.querySelectorAll(`.files-item.${DROP_HERE}`)) row.classList.remove(DROP_HERE);
  // The folder row it goes into lights up.
  const dir = dropDir(e);
  const at = rows.findIndex(x => x.path === dir);
  if (r && at >= 0) panel.querySelector(`.files-item[data-i="${at}"]`)?.classList.add(DROP_HERE);
});
panel.addEventListener('dragleave', () => panel.classList.remove('drop'));
panel.addEventListener('drop', e => {
  panel.classList.remove('drop');
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  const dir = dropDir(e);
  if (platform === PLATFORM.linux) copyIn(dir, null, droppedPaths(e.dataTransfer));
  else copyIn(dir, e.dataTransfer.files);
});

// ---- Docked on the right: the terminals end where it starts; the grip on its left edge resizes it ----

dockRight(panel, {
  dockVar: '--files-dock', minWidth: MIN_WIDTH_PX, resized: scheduleFit,
  dragged: width => { state.files.width = width; persist(); },
});

// Where the tree was scrolled, for a restart (the list is drawn anew, so the panel listens).
panel.addEventListener('scroll', e => {
  if (!view || !targetOf(e).matches(LIST)) return;
  state.files.scroll = /** @type {HTMLElement} */ (e.target).scrollTop;
  persist();
}, true);

// ---- Following the terminal's folder ----

/**
 * A terminal's shell moved to another folder: the tree opens down to it. Another terminal's tree goes there when
 * the panel comes back to it.
 * @param {Tab} tab
 * @param {string | null | undefined} path
 */
function followed(tab, path) {
  if (panel.hidden || !path) return;
  const v = views.get(tab.id);
  if (!v) return;
  // Back after a restart, a shell in a folder the tree shows only marks it; one elsewhere (its old folder gone, say)
  // opens the tree down to it as usual.
  if (restored.delete(v) && v.open.has(parentOf(path) ?? '')) {
    v.cwd = path;
    if (v === view) drawTree();
    return;
  }
  if (v === view) reveal(v, path);
  else v.moved = path;
}

on(EVENTS.remoteCwd, tab => {
  if (isSsh(tab)) followed(tab, tab.remoteCwd);
  else if (isWsl(tab)) followed(tab, wslPath(tab, tab.remoteCwd)); // in its distribution, as Windows reaches it
});
on(EVENTS.cwd, tab => { if (!isSsh(tab) && !isRemote(tab)) followed(tab, tab.cwd); });
/**
 * The open panel shows the terminal in front: after another is focused, the one it showed closed (closing a terminal
 * focuses its neighbour without a focus event), or another workspace came in front. Trees of closed terminals go.
 */
function toFront() {
  for (const id of views.keys()) if (!state.tabs.has(id)) views.delete(id);
  if (panel.hidden) return;
  const shown = view?.tab ?? without;
  const front = focusedTab();
  if (front === shown && (!shown || state.tabs.has(shown.id))) return;
  follow(front && state.tabs.has(front.id) ? front : null);
}
on(EVENTS.workspaces, () => setTimeout(toFront)); // once focus has moved

// The panel follows the focused terminal: its files, or why it has none.
on(EVENTS.focus, toFront);
