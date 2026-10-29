// @ts-check
// The Files side panel (terminal menu › Files, or Ctrl+Shift+L): the files of the terminal in focus, as a tree from
// This PC (the drives) or its server's root down, open at the folder its shell is in and following it. For an SSH
// terminal they're on its server (the host reads them over ssh and sftp with the terminal's own connection settings);
// for one on this machine they're here. A + opens a folder with something in it (as does a double click); a click
// selects (Ctrl and Shift add to it, as in Explorer), a double click opens a file here in the preview, and
// right-clicking offers the rest, for all that's selected: "Copy to" another terminal's folder (copyto.js),
// downloads, deleting. Files dropped on the panel go into the folder they're dropped on. What's done is said in a
// note at the bottom of the window (filejobs.js).

import { PAGE } from './protocol.js';
import { send, sendWithFiles, platform, droppedPaths, PLATFORM } from './host.js';
import { on, profileOf, isSsh, isRemote, EVENTS } from './store.js';
import { focusedTab, newTab } from './panes.js';
import { scheduleFit } from './terminals.js';
import { escapeHtml, ICONS } from './ui.js';
import { modal, confirmDialog, CONFIRM_DIALOG } from './dialogs.js';
import { byId, field, targetOf, dragPointer, WORKSPACE_ID, PATH_DRAG } from './dom.js';
import { showMenu, SEPARATOR } from './popups.js';
import { showChange } from './preview.js';
import { pathActions } from './actions.js';
import { FILE_OP, FOLDER_PATH } from './constants.js';
import { parentOf, DRIVE_ICON, DRIVES_NAME, sizeText, hasFiles, shellFolderOf, folderOf, folderName, placeOf, sameMachine } from './filepaths.js';
import { rootOf, childPath, signHtml, indentRows, readFolders, pathDown } from './foldertree.js';
import { planCopy } from './copyto.js';
import { JOB_KIND, FILE_MANAGER, BIN, newRequestId, startJob, expectJob } from './filejobs.js';

/** @typedef {import('./foldertree.js').FileEntry} FileEntry */
/** @typedef {import('./foldertree.js').TreeNode} TreeNode */
/**
 * What the panel shows for a terminal: whether that's on a server, the folders read, which are open or being read,
 * the folder its shell is in (marked), a folder it moved to while another terminal was shown, and why nothing shows.
 * @typedef {{ tab: Tab, server: boolean, nodes: Map<string, TreeNode>, open: Set<string>, loading: Set<string>,
 *   cwd: string | null, moved: string | null, error: string | null }} FilesView
 */
/** A row drawn: its path, what it is (none for the tree's root), how deep it is, and the folder it's in. */
/** @typedef {{ path: string, entry: FileEntry | null, depth: number, dir: string | null }} Row */

/** What the panel's buttons do (data-files). */
const FILES_ACTION = Object.freeze({ close: 'close', refresh: 'refresh', mkdir: 'mkdir', get: 'get', rename: 'rename', delete: 'delete' });
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

/** A path as a shell takes it: quoted when it has a space. */
const shellPath = /** @param {string} path */ path => (/[\s'"&()]/.test(path) ? `"${path}"` : path);
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
  const v = { tab, server: isSsh(tab), nodes: new Map(), open: new Set(), loading: new Set(), cwd: null, moved: shellFolderOf(tab), error: null };
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
  if (!panel.hidden && (!tab || view?.tab === tab)) {
    panel.hidden = true;
    view = null;
    views.clear(); // opened again, it starts where each terminal's shell is
    return;
  }
  if (!tab || !hasFiles(tab)) return;
  panel.hidden = false;
  show(tab);
}

// ---- Drawing ----

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
    return `<div class="${cls}" data-i="${i}" data-depth="0">${signHtml(true, v.open.has(r.path))}<span class="files-name">${ICONS.monitor} ${escapeHtml(name)}</span></div>`;
  }
  const node = v.nodes.get(r.path);
  const has = e.isDirectory && (r.dir === FOLDER_PATH.drives || !!v.nodes.get(/** @type {string} */ (r.dir))?.folders.find(f => f.name === e.name)?.hasFolders || !!node?.entries?.length);
  const drive = e.label != null;
  const name = drive ? `${DRIVE_ICON}${escapeHtml(`${e.label} (${e.name.replace(/\\$/, '')})`)}` : `${e.isDirectory ? '📁' : '📄'} ${escapeHtml(e.name)}`;
  const title = drive ? e.modified : [e.permissions, e.modified].filter(Boolean).join(' · ');
  return `
  <div class="${cls}" data-i="${i}" data-depth="${r.depth}" draggable="true" title="${escapeHtml(title)}">
    ${signHtml(has, v.open.has(r.path))}
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

/** The tree's rows (into `rows`) and their markup. @param {FilesView} v */
function treeHtml(v) {
  if (v.error) {
    rows = [];
    return `<div class="inbox-empty files-error">${escapeHtml(v.error)}</div>`;
  }
  const root = rootOf(v.tab);
  rows = [{ path: root, entry: null, depth: 0, dir: null }];
  const html = [rowHtml(rows[0], 0)];
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
      const row = { path: childPath(path, e.name), entry: e, depth, dir: path };
      rows.push(row);
      html.push(rowHtml(row, rows.length - 1));
      if (e.isDirectory) walk(row.path, depth + 1);
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
  panel.innerHTML = `
    <div class="files-grip" title="Drag to resize"></div>
    <div class="files-head">
      <span class="files-title">Files · ${escapeHtml(profileOf(tab)?.name ?? '')}</span>
      <button class="pane-btn" data-files="${FILES_ACTION.close}" title="Close">${ICONS.close}</button>
    </div>
    <div class="files-bar">
      <button class="btn small" data-files="${FILES_ACTION.refresh}" title="Refresh">⟳</button>
      <button class="btn small" data-files="${FILES_ACTION.mkdir}" title="New folder in the folder selected"${target ? '' : ' disabled'}>${ICONS.plus}</button>
      ${server ? '<label class="btn small files-upload" title="Upload files into the folder selected">Upload<input type="file" multiple hidden data-files-pick></label>' : ''}
      <span class="files-path" title="${escapeHtml(target ?? '')}">${escapeHtml(target ? folderName(target) : '')}</span>
    </div>
    <div class="files-list">${treeHtml(view)}</div>`;
  const drawn = /** @type {HTMLElement} */ (panel.querySelector(LIST));
  indentRows(drawn);
  drawn.scrollTop = scroll;
}

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
 * "Copy to": asks for the terminal's folder (and about what's already there), then copies, as one job.
 * @param {Row[]} items
 */
async function copyTo(items) {
  const v = view;
  if (!v || !items.length || items.some(r => r.dir === FOLDER_PATH.drives)) return;
  const plan = await planCopy(v.tab, items.map(itemOf));
  if (!plan) return;
  const requestId = newRequestId();
  // The folder it went to is read again where it's shown, on that machine, and the one it's in (its +).
  const after = () => { if (view && sameMachine(view.tab, plan.to)) reload([plan.dir, parentOf(plan.dir)]); };
  startJob(requestId, plan.items.map(i => i.name), { kind: JOB_KIND.copy, where: folderOf(plan.to, plan.dir), after });
  send(PAGE.filesCopyTo, { id: v.tab.id, requestId, to: plan.to.id, dir: plan.dir, items: plan.items });
}

/** @param {string[]} paths */
function insertPaths(paths) {
  const term = view?.tab.view?.term;
  if (!term) return;
  term.paste(`${paths.map(shellPath).join(' ')} `);
  term.focus();
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
  if (!view) return;
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-files]'))?.dataset.files;
  const { i, r } = rowOf(e);
  if (action === FILES_ACTION.close) return toggleFiles(view.tab);
  if (action === FILES_ACTION.refresh) return refresh();
  if (action === FILES_ACTION.mkdir) return makeFolder();
  if (!r) return action ? undefined : selectRows(new Set(), null);
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
  const path = panel.querySelector('.files-path');
  if (path) path.textContent = target ? folderName(target) : '';
  /** @type {HTMLButtonElement | null} */ (panel.querySelector(`[data-files="${FILES_ACTION.mkdir}"]`))?.toggleAttribute('disabled', !target);
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
    { label: 'Copy path', icon: ICONS.copy, action: () => copyText(r.path) },
    { label: 'Insert path in the terminal', action: () => insertPaths([r.path]) },
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
    { label: 'Copy paths', icon: ICONS.copy, action: () => copyText(paths.join('\n')) },
    { label: 'Insert paths in the terminal', action: () => insertPaths(paths) },
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
    { label: 'Copy path', icon: ICONS.copy, action: () => copyText(dir) },
    { label: 'Insert path in the terminal', action: () => insertPaths([dir]) },
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
  const paths = (selected.has(r.path) ? selectedRows() : [r]).map(x => x.path).join('\n');
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

// ---- Docked on the right: the terminals end where it starts ----

/** The space between the terminals and the panel: the app's gap between panes. */
const gapPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap')) || 0;

// Its width changes when it opens, closes (0), is dragged, or the window shrinks it to half the terminals' area.
new ResizeObserver(() => {
  const width = panel.hidden ? 0 : panel.offsetWidth + gapPx();
  byId(WORKSPACE_ID).style.setProperty('--files-dock', `${width}px`);
  scheduleFit();
}).observe(panel);

// ---- Resizing: the grip on its left edge, up to half the terminals' area (the width stays while Termilly runs) ----

panel.addEventListener('pointerdown', e => {
  if (!targetOf(e).matches('.files-grip')) return;
  e.preventDefault();
  const area = byId(WORKSPACE_ID).getBoundingClientRect();
  dragPointer(/** @type {HTMLElement} */ (e.target), e, ev => {
    panel.style.width = `${Math.round(Math.min(area.width / 2, Math.max(MIN_WIDTH_PX, area.right - ev.clientX)))}px`;
  });
});

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
  if (v === view) reveal(v, path);
  else v.moved = path;
}

on(EVENTS.remoteCwd, tab => { if (isSsh(tab)) followed(tab, tab.remoteCwd); });
on(EVENTS.cwd, tab => { if (!isSsh(tab) && !isRemote(tab)) followed(tab, tab.cwd); });
on(EVENTS.tabClosed, tab => views.delete(tab.id));

on(EVENTS.focus, tab => {
  // The panel follows the focused terminal while it has files to show.
  if (!panel.hidden && view && tab !== view.tab && hasFiles(tab)) show(tab);
});
