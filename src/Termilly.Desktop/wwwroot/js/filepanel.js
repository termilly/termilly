// @ts-check
// The Files side panel (terminal menu › Files, or Ctrl+Shift+L): the folders of the terminal in focus, following
// the folder its shell is in. For an SSH terminal they're on its server (the host runs sftp with the terminal's own
// connection settings, Sftp.cs); for one on this machine they're here (LocalFiles.cs). A click selects (Ctrl and
// Shift add to it, as in Explorer), a double click opens a folder, or a file here in the preview, and right-clicking
// offers the rest, for all that's selected: "Copy to" another terminal's folder (copyto.js), downloads (to
// Downloads, or a folder picked), deleting. Files dropped on the panel are uploaded to the folder shown (copied,
// here). Transfers queue at the bottom.

import { PAGE, HOST } from './protocol.js';
import { send, sendWithFiles, onHost, request, platform, droppedPaths, PLATFORM } from './host.js';
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
import { joinPath, parentOf, DRIVE_ICON, sizeText, hasFiles, shellFolderOf, folderOf, folderName, sameMachine } from './filepaths.js';
import { planCopy } from './copyto.js';

/** A file or folder, as the host lists it (Sftp.cs, LocalFiles.cs); a drive has its label. */
/**
 * @typedef {{ name: string, isDirectory: boolean, size: number, permissions: string, modified: string, label?: string | null }}
 *   FileEntry
 */
/** What the panel shows: its terminal, whether that's on a server, the folder and what's in it. */
/**
 * @typedef {{ tab: Tab, server: boolean, path: string, entries: FileEntry[], loading: boolean, error: string | null,
 *   follow: boolean }} FilesView
 */
/**
 * A transfer or file operation in the queue; a finished download keeps where it went, a copy what to say when it's
 * done and the folder it went to (listed again if the panel shows it).
 */
/**
 * @typedef {{ kind: string, name: string | null, state: string, refresh: boolean, requestId: string | null,
 *   message?: string | null, local?: string | null, done?: string, where?: { tab: Tab, dir: string } }} FileJob
 */
/** files:done, whichever of its shapes it has. */
/**
 * @typedef {{ requestId: string | null, ok: boolean, file?: string, local?: string | null, message?: string }}
 *   FilesDone
 */

/** A job's state in the queue. */
const JOB_STATE = Object.freeze({ running: 'running', done: 'done', failed: 'failed' });
/** What a job in the queue is (its icon). */
const JOB_KIND = Object.freeze({ put: 'put', get: 'get', rename: 'rename', delete: 'delete', mkdir: 'mkdir', open: 'open', copy: 'copy' });
/** What the panel's buttons do (data-files). */
const FILES_ACTION = Object.freeze({
  close: 'close', up: 'up', refresh: 'refresh', mkdir: 'mkdir', follow: 'follow', get: 'get', rename: 'rename', delete: 'delete',
});
/** The most jobs the queue keeps, and how many of the latest it shows. */
const MAX_QUEUE = 50;
const QUEUE_SHOWN = 6;
/** The panel's narrowest width; its widest is half the terminals' area (app.css max-width). */
const MIN_WIDTH_PX = 260;
/** Where this machine's deleted files go. */
const BIN = platform === PLATFORM.windows ? 'the Recycle Bin' : 'the trash';
const FILE_MANAGER = platform === PLATFORM.windows ? 'Explorer' : 'the file manager';
/** Drag-and-drop's effect for what leaves the panel and what's dropped on it. */
const COPY_EFFECT = 'copy';

const panel = document.createElement('aside');
panel.className = 'files-panel';
panel.hidden = true;
panel.tabIndex = -1; // focusable, for its keys (Ctrl+A, Delete, Escape)
byId(WORKSPACE_ID).append(panel);

/** @type {FilesView | null} */
let view = null;
/** @type {FileJob[]} */
const queue = [];
let requests = 0; // ids for the queue's file operations, whose answers come as files:done
/** The requests that are downloads to a folder the host asks for: their queued files are downloads, not uploads. */
const downloadsTo = new Set();
/** How many listings were asked for: only the latest one's answer is shown. */
let listings = 0;
/** Terminal id: the folder the panel last showed for it, to go back to when that terminal is focused again. */
/** @type {Map<string, string>} */
const shownFolders = new Map();
/** The rows selected (their indexes in the listing), and the one Shift+click selects from. */
/** @type {Set<number>} */
let selected = new Set();
let anchor = -1;

/** Whether the panel shows the drives rather than a folder. */
const atDrives = () => view?.path === FOLDER_PATH.drives;
/** A path as a shell takes it: quoted when it has a space. */
const shellPath = /** @param {string} path */ path => (/[\s'"&()]/.test(path) ? `"${path}"` : path);
/** A count of items, for titles. @param {number} n */
const itemsText = n => (n === 1 ? '1 item' : `${n} items`);

onHost(HOST.filesDone, (/** @type {FilesDone} */ m) => {
  const item = queue.find(q => q.requestId === m.requestId && (!m.file || q.name === m.file) && q.state === JOB_STATE.running);
  if (item) {
    item.state = m.ok ? JOB_STATE.done : JOB_STATE.failed;
    item.local = m.ok ? m.local ?? null : null;
    item.message = m.ok ? (m.local ? `saved to ${m.local}` : item.done ?? '') : m.message;
  }
  render();
  // A copy lists the folder again when the panel shows it, from whichever terminal on that machine.
  const shown = item?.where ? !!view && sameMachine(view.tab, item.where.tab) && view.path === item.where.dir : item?.refresh;
  if (m.ok && shown) list(view?.path);
});

// The files picked for "Upload" (Linux: its file dialog gives paths, the page's doesn't), or the ones "Download to"
// downloads once its folder was picked, before they go.
onHost(HOST.filesQueued, m => {
  const kind = downloadsTo.delete(/** @type {string} */ (m.requestId)) ? JOB_KIND.get : JOB_KIND.put;
  for (const name of m.files ?? []) addJob({ kind, name, state: JOB_STATE.running, refresh: kind === JOB_KIND.put, requestId: m.requestId });
  render();
});

/** @param {string | null | undefined} path */
export async function list(path) {
  if (!view) return;
  const current = view;
  const asked = ++listings;
  view.loading = true;
  view.error = null;
  render();
  const m = await request(PAGE.filesList, { id: view.tab.id, path });
  // An answer that comes after the panel moved on (another terminal, another folder: a server is slow) is dropped,
  // or it would show, and be remembered, in the wrong place.
  if (view !== current || asked !== listings) return;
  view.loading = false;
  if (m.error || m.ok === false) view.error = m.message ?? m.error;
  else {
    // Another folder, or the same one listed again: the rows may not be the ones selected any more.
    selected = new Set();
    anchor = -1;
    view.path = m.path;
    shownFolders.set(view.tab.id, m.path);
    view.entries = m.entries ?? [];
  }
  render();
}

/**
 * The view of a terminal's files, starting in the folder its shell is in.
 * @param {Tab} tab
 * @returns {FilesView}
 */
function viewOf(tab) {
  const path = shownFolders.get(tab.id) ?? shellFolderOf(tab);
  return { tab, server: isSsh(tab), path, entries: [], loading: false, error: null, follow: view?.follow ?? true };
}

/** @param {Tab | null | undefined} [tab] */
export function toggleFiles(tab = focusedTab()) {
  if (!panel.hidden && (!tab || view?.tab === tab)) {
    panel.hidden = true;
    view = null;
    return;
  }
  if (!tab || !hasFiles(tab)) return;
  view = viewOf(tab);
  panel.hidden = false;
  list(view.path);
}

/** @type {Record<string, string>} */
const JOB_ICONS = {
  [JOB_KIND.put]: '↑', [JOB_KIND.get]: '↓', [JOB_KIND.rename]: '✎', [JOB_KIND.delete]: '✕', [JOB_KIND.mkdir]: '+', [JOB_KIND.open]: '↗',
  [JOB_KIND.copy]: '→',
};

/**
 * A file or folder's row, with the buttons its hover shows.
 * @param {FileEntry} e
 * @param {number} i
 * @param {boolean} server
 */
const entryRow = (e, i, server) => (e.label != null ? driveRow(e, i) : `
  <div class="files-item${e.isDirectory ? ' dir' : ''}${selected.has(i) ? ' selected' : ''}" data-i="${i}" draggable="true" title="${escapeHtml([e.permissions, e.modified].filter(Boolean).join(' · '))}">
    <span class="files-name">${e.isDirectory ? '📁' : '📄'} ${escapeHtml(e.name)}</span>
    <span class="files-size">${e.isDirectory ? '' : sizeText(e.size)}</span>
    <span class="files-actions">
      ${server ? `<button class="pane-btn" data-files="${FILES_ACTION.get}" title="Download to Downloads">↓</button>` : ''}
      <button class="pane-btn" data-files="${FILES_ACTION.rename}" title="Rename">${ICONS.rename}</button>
      <button class="pane-btn" data-files="${FILES_ACTION.delete}" title="Delete">${ICONS.trash}</button>
    </span>
  </div>`);

/**
 * A drive's row: its label and letter ("Local Disk (C:)"), and its free space.
 * @param {FileEntry} e
 * @param {number} i
 */
const driveRow = (e, i) => `
  <div class="files-item dir${selected.has(i) ? ' selected' : ''}" data-i="${i}" draggable="true" title="${escapeHtml(e.modified)}">
    <span class="files-name">${DRIVE_ICON}${escapeHtml(`${e.label} (${e.name.replace(/\\$/, '')})`)}</span>
    <span class="files-size">${escapeHtml(e.modified.replace(/ of .*$/, ''))}</span>
  </div>`;

/** @param {FilesView} v */
function listHtml({ loading, error, entries, server }) {
  if (loading) return '<div class="inbox-empty">Loading…</div>';
  if (error) return `<div class="inbox-empty files-error">${escapeHtml(error)}</div>`;
  if (!entries.length) return `<div class="inbox-empty">Empty folder. Drop files here to ${server ? 'upload them' : 'copy them in'}.</div>`;
  return entries.map((e, i) => entryRow(e, i, server)).join('');
}

/** The queue's latest jobs; a finished download's row shows the file in the file manager when clicked. */
const queueHtml = () => (queue.length ? `<div class="files-queue">${queue.slice(-QUEUE_SHOWN).reverse().map(q => `
  <div class="files-job ${q.state}"${q.local ? ` data-reveal="${escapeHtml(q.local)}" title="Show in ${FILE_MANAGER}"` : ''}><span>${JOB_ICONS[q.kind] ?? ''} ${escapeHtml(q.name)}</span><span>${escapeHtml(q.state === JOB_STATE.failed ? q.message ?? JOB_STATE.failed : q.state === JOB_STATE.done ? q.message || JOB_STATE.done : '…')}</span></div>`).join('')}</div>` : '');

function render() {
  if (!view) return;
  const { tab, path, follow, server } = view;
  panel.innerHTML = `
    <div class="files-grip" title="Drag to resize"></div>
    <div class="files-head">
      <span class="files-title">Files · ${escapeHtml(profileOf(tab)?.name ?? '')}</span>
      <button class="pane-btn" data-files="${FILES_ACTION.close}" title="Close">${ICONS.close}</button>
    </div>
    <div class="files-bar">
      <button class="btn small" data-files="${FILES_ACTION.up}" title="Up a folder">↑</button>
      <button class="btn small" data-files="${FILES_ACTION.refresh}" title="Refresh">⟳</button>
      <button class="btn small" data-files="${FILES_ACTION.mkdir}" title="New folder">${ICONS.plus}</button>
      ${server ? '<label class="btn small files-upload" title="Upload files">Upload<input type="file" multiple hidden data-files-pick></label>' : ''}
      <label class="paste-never files-follow" title="Show the folder the terminal is in"><input type="checkbox" data-files="${FILES_ACTION.follow}"${follow ? ' checked' : ''}> Follow</label>
    </div>
    <div class="files-path" title="${escapeHtml(path)}">${escapeHtml(folderName(path))}</div>
    <div class="files-list">${listHtml(view)}</div>
    ${queueHtml()}`;
}

/** @param {FileJob} job */
function addJob(job) {
  queue.push(job);
  if (queue.length > MAX_QUEUE) queue.shift();
}

/**
 * Runs a file operation, shown in the queue until it's done; refresh lists the folder again afterwards.
 * @param {string} kind
 * @param {string} name
 * @param {{ op: string, path: string | null, to?: string }} fields
 * @param {boolean} [refresh]
 */
function operation(kind, name, fields, refresh = false) {
  const requestId = `files${++requests}`;
  addJob({ kind, name, state: JOB_STATE.running, refresh, requestId });
  send(PAGE.filesOp, { id: /** @type {FilesView} */ (view).tab.id, requestId, ...fields });
  render();
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

// ---- What files and folders can do ----

/** A file or folder's path; a drive's is its root. @param {FileEntry} item */
const pathOf = item => (atDrives() ? item.name : joinPath(/** @type {FilesView} */ (view).path, item.name));

/** The files and folders selected, in the listing's order. */
const selectedItems = () => (view ? view.entries.filter((_, i) => selected.has(i)) : []);

async function makeFolder() {
  if (atDrives()) return;
  const name = await askName('New folder');
  if (name && view) operation(JOB_KIND.mkdir, name, { op: FILE_OP.makeDirectory, path: joinPath(view.path, name) }, true);
}

/** @param {FileEntry} item */
async function rename(item) {
  const to = await askName(`Rename ${item.name}`, item.name);
  if (to && to !== item.name && view) operation(JOB_KIND.rename, `${item.name} → ${to}`, { op: FILE_OP.rename, path: pathOf(item), to: joinPath(view.path, to) }, true);
}

/**
 * Deletes files and folders, once asked: here to the Recycle Bin, on a server for good (only empty folders).
 * @param {FileEntry[]} items
 */
async function remove(items) {
  if (!view || !items.length || atDrives()) return;
  const folders = items.some(i => i.isDirectory);
  const body = !view.server ? `${items.length === 1 ? 'It goes' : 'They go'} to ${BIN}.`
    : `${folders ? 'Only empty folders can be deleted. ' : ''}It’s deleted on the server; there’s no undo.`;
  const title = items.length === 1 ? `Delete ${items[0].name}?` : `Delete ${itemsText(items.length)}?`;
  if (!await confirmDialog({ title, body, confirm: 'Delete' }) || !view) return;
  for (const item of items) {
    operation(JOB_KIND.delete, item.name, { op: item.isDirectory ? FILE_OP.removeDirectory : FILE_OP.remove, path: pathOf(item) }, true);
  }
}

/** Downloads files and folders from the server to Downloads. @param {FileEntry[]} items */
const download = items => items.forEach(item => operation(JOB_KIND.get, item.name, { op: FILE_OP.get, path: pathOf(item) }));

/** Downloads files and folders from the server to a folder the host asks for. @param {FileEntry[]} items */
function downloadTo(items) {
  if (!view || !items.length) return;
  const requestId = `files${++requests}`;
  downloadsTo.add(requestId);
  send(PAGE.filesGetTo, { id: view.tab.id, requestId, paths: items.map(pathOf) });
}

/**
 * "Copy to": asks for the terminal's folder (and about what's already there), then copies, each item a job.
 * @param {FileEntry[]} items
 */
async function copyTo(items) {
  if (!view || !items.length || atDrives()) return;
  const { tab, path } = view;
  const plan = await planCopy(tab, path, items);
  if (!plan) return;
  const requestId = `files${++requests}`;
  const where = { tab: plan.to, dir: plan.dir };
  const done = `copied to ${folderOf(plan.to, plan.dir)}`;
  for (const { name } of plan.items) addJob({ kind: JOB_KIND.copy, name, state: JOB_STATE.running, refresh: false, requestId, done, where });
  send(PAGE.filesCopyTo, { id: tab.id, requestId, to: plan.to.id, dir: plan.dir, items: plan.items });
  render();
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
 * Opens what was double-clicked: a folder (or drive) in the panel, a file here in the preview.
 * @param {FileEntry} item
 */
function openItem(item) {
  if (!view) return;
  if (item.isDirectory) list(pathOf(item));
  else if (!view.server) showChange(view.tab, pathOf(item));
}

/** The row an event is on, and its index. @param {Event} e */
const rowOf = e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-i]'));
  return { row, i: row ? Number(row.dataset.i) : -1 };
};

panel.addEventListener('click', e => {
  if (!view) return;
  const reveal = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-reveal]'))?.dataset.reveal;
  if (reveal) return send(PAGE.openPath, { path: reveal });
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-files]'))?.dataset.files;
  const { i } = rowOf(e);
  const item = view.entries[i];
  if (action === FILES_ACTION.close) return toggleFiles(view.tab);
  if (action === FILES_ACTION.refresh) return list(view.path);
  if (action === FILES_ACTION.up) return list(parentOf(view.path));
  if (action === FILES_ACTION.follow) { view.follow = /** @type {HTMLInputElement} */ (e.target).checked; return; }
  if (action === FILES_ACTION.mkdir) return makeFolder();
  if (!item) return action ? undefined : selectRows(new Set(), -1);
  // A row's own button acts on the selection when the row is in it, else on that row alone.
  const items = selected.has(i) ? selectedItems() : [item];
  if (action === FILES_ACTION.get) return download(items);
  if (action === FILES_ACTION.rename) return rename(item);
  if (action === FILES_ACTION.delete) return remove(items);
  if (!action) clickRow(i, e);
});

// A double click opens a row (as in Explorer). The rows aren't drawn again by the click before it, or the double
// click would lose the row it started on.
panel.addEventListener('dblclick', e => {
  const item = view?.entries[rowOf(e).i];
  if (item && !targetOf(e).closest('[data-files]') && !e.ctrlKey && !e.shiftKey) openItem(item);
});

// ---- Selecting: a click, Ctrl+click to add or take away, Shift+click for a range, Ctrl+A for all ----

/**
 * Selects rows (without drawing the panel again, so a double click keeps its row).
 * @param {Set<number>} rows
 * @param {number} from the row Shift+click selects from
 */
function selectRows(rows, from) {
  selected = rows;
  anchor = from;
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('.files-item[data-i]'))) {
    row.classList.toggle('selected', selected.has(Number(row.dataset.i)));
  }
}

/**
 * @param {number} i
 * @param {MouseEvent} e
 */
function clickRow(i, e) {
  panel.focus({ preventScroll: true });
  if (e.shiftKey && anchor >= 0) {
    const [from, to] = [Math.min(anchor, i), Math.max(anchor, i)];
    const range = new Set(Array.from({ length: to - from + 1 }, (_, k) => from + k));
    selectRows(e.ctrlKey ? new Set([...selected, ...range]) : range, anchor);
  } else if (e.ctrlKey || e.metaKey) {
    const rows = new Set(selected);
    if (!rows.delete(i)) rows.add(i);
    selectRows(rows, i);
  } else selectRows(new Set([i]), i);
}

panel.addEventListener('keydown', e => {
  if (!view || targetOf(e).closest('input')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'a') selectRows(new Set(view.entries.map((_, i) => i)), 0);
  else if (e.key === 'Escape' && selected.size) selectRows(new Set(), -1);
  else if (e.key === 'Delete' && selected.size) remove(selectedItems());
  else if (e.key === 'Enter' && selected.size === 1) openItem(selectedItems()[0]);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

// ---- The right-click menu ----

/**
 * What a file or folder's menu offers: opening it, getting it here (on a server), copying it to another terminal's
 * folder, its path, the actions that take a file (here), and renaming or deleting it.
 * @param {FilesView} v
 * @param {FileEntry} item
 * @returns {import('./popups.js').MenuEntry[]}
 */
function itemMenu(v, item) {
  const path = pathOf(item);
  const open = item.isDirectory ? [{ label: 'Open', icon: ICONS.folder, action: () => list(path) }]
    : v.server ? [] : [
      { label: 'Preview', action: () => showChange(v.tab, path) },
      { label: 'Open in its app', action: () => operation(JOB_KIND.open, item.name, { op: FILE_OP.open, path }) },
    ];
  const here = v.server ? [] : [
    ...(item.isDirectory ? [{ label: 'Open a terminal here', icon: ICONS.terminal, action: () => newTab({ profile: v.tab.profile, wsId: v.tab.wsId, cwd: path }) }] : []),
    { label: `Show in ${FILE_MANAGER}`, action: () => send(PAGE.openPath, { path }) },
  ];
  const actions = v.server ? [] : pathActions(v.tab, path, item.isDirectory ? path : v.path);
  return [
    ...open, ...here, ...transferItems(v, [item]), SEPARATOR,
    { label: 'Copy path', icon: ICONS.copy, action: () => copyText(path) },
    { label: 'Insert path in the terminal', action: () => insertPaths([path]) },
    .../** @type {import('./popups.js').MenuEntry[]} */ (actions.length ? [SEPARATOR, ...actions] : []),
    // A drive can't be renamed or deleted from here.
    .../** @type {import('./popups.js').MenuEntry[]} */ (atDrives() ? [] : [
      SEPARATOR,
      { label: 'Rename', icon: ICONS.rename, action: () => rename(item) },
      { label: 'Delete', icon: ICONS.trash, danger: true, action: () => remove([item]) },
    ]),
  ];
}

/**
 * Getting files and folders elsewhere: to another terminal's folder, and from a server to this machine.
 * @param {FilesView} v
 * @param {FileEntry[]} items
 * @returns {import('./popups.js').MenuEntry[]}
 */
const transferItems = (v, items) => (atDrives() ? [] : [
  ...(v.server ? [
    { label: 'Download to Downloads', action: () => download(items) },
    { label: 'Download to', action: () => downloadTo(items) },
  ] : []),
  { label: 'Copy to', icon: ICONS.copy, action: () => copyTo(items) },
]);

/**
 * The menu of several files and folders selected.
 * @param {FilesView} v
 * @param {FileEntry[]} items
 * @returns {import('./popups.js').MenuEntry[]}
 */
function selectionMenu(v, items) {
  const paths = items.map(pathOf);
  return [
    ...transferItems(v, items), SEPARATOR,
    { label: 'Copy paths', icon: ICONS.copy, action: () => copyText(paths.join('\n')) },
    { label: 'Insert paths in the terminal', action: () => insertPaths(paths) },
    .../** @type {import('./popups.js').MenuEntry[]} */ (atDrives() ? [] : [
      SEPARATOR,
      { label: `Delete ${itemsText(items.length)}`, icon: ICONS.trash, danger: true, action: () => remove(items) },
    ]),
  ];
}

/**
 * The menu of the folder shown (right-clicking between its files).
 * @param {FilesView} v
 * @returns {import('./popups.js').MenuEntry[]}
 */
const folderMenu = v => {
  const refresh = { label: 'Refresh', action: () => list(v.path) };
  return atDrives() ? [refresh] : folderItems(v, refresh);
};

/**
 * The menu of a folder (not the drives).
 * @param {FilesView} v
 * @param {import('./popups.js').MenuItem} refresh
 * @returns {import('./popups.js').MenuEntry[]}
 */
const folderItems = (v, refresh) => [
  { label: 'New folder', icon: ICONS.plus, action: makeFolder },
  refresh,
  ...(v.server ? [] : [{ label: `Show in ${FILE_MANAGER}`, action: () => send(PAGE.openPath, { path: v.path }) }]),
  SEPARATOR,
  { label: 'Copy path', icon: ICONS.copy, action: () => copyText(v.path) },
  { label: 'Insert path in the terminal', action: () => insertPaths([v.path]) },
];

panel.addEventListener('contextmenu', e => {
  if (!view || !targetOf(e).closest('.files-list')) return;
  e.preventDefault();
  const { i } = rowOf(e);
  const item = view.entries[i];
  // Right-clicking a row outside the selection selects that row alone, as Explorer does.
  if (item && !selected.has(i)) selectRows(new Set([i]), i);
  const menu = !item ? folderMenu(view) : selected.size > 1 ? selectionMenu(view, selectedItems()) : itemMenu(view, item);
  showMenu(menu, { x: e.clientX, y: e.clientY });
});

// ---- Files in: uploads to a server, copies here ----

/**
 * Copies files into the folder shown (uploads them, on a server). On Windows the files go to the host with the
 * message (WebView2 gives their paths); on Linux the page sends the paths a drop carried (`paths`).
 * @param {FileList | null} files
 * @param {string[] | null} [paths]
 */
function copyIn(files, paths = null) {
  if (!view || atDrives() || !(paths ?? files)?.length) return;
  const requestId = `files${++requests}`;
  const names = paths ? paths.map(p => /** @type {string} */ (p.split(/[\\/]/).pop())) : [.../** @type {FileList} */ (files)].map(f => f.name);
  for (const name of names) addJob({ kind: JOB_KIND.put, name, state: JOB_STATE.running, refresh: true, requestId });
  if (paths) send(PAGE.filesPut, { id: view.tab.id, requestId, dir: view.path, paths });
  else if (window.chrome?.webview) sendWithFiles(PAGE.filesPut, { id: view.tab.id, requestId, dir: view.path }, /** @type {FileList} */ (files));
  render();
}

panel.addEventListener('change', e => {
  if (targetOf(e).matches('[data-files-pick]')) copyIn(/** @type {HTMLInputElement} */ (e.target).files);
});
// Linux: the Upload button opens the host's file dialog instead of the page's.
panel.addEventListener('click', e => {
  if (platform !== PLATFORM.linux || !view || !targetOf(e).closest('.files-upload')) return;
  e.preventDefault();
  send(PAGE.filesPick, { id: view.tab.id, requestId: `files${++requests}`, dir: view.path });
});
// Files and folders dragged out of the panel carry their paths, one a line: a terminal types them where they're
// dropped (terminals.js). A row in the selection drags the whole selection.
panel.addEventListener('dragstart', e => {
  const { i } = rowOf(e);
  const item = view?.entries[i];
  if (!item || !e.dataTransfer) return;
  const paths = (selected.has(i) ? selectedItems() : [item]).map(pathOf).join('\n');
  e.dataTransfer.setData(PATH_DRAG, paths);
  e.dataTransfer.setData('text/plain', paths);
  e.dataTransfer.effectAllowed = COPY_EFFECT;
});
panel.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); panel.classList.add('drop'); } });
panel.addEventListener('dragleave', () => panel.classList.remove('drop'));
panel.addEventListener('drop', e => {
  panel.classList.remove('drop');
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  if (platform === PLATFORM.linux) copyIn(null, droppedPaths(e.dataTransfer));
  else copyIn(e.dataTransfer.files);
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
 * The panel's terminal moved to another folder: the panel goes there too while it follows.
 * @param {Tab} tab
 * @param {string | null | undefined} path
 */
function followed(tab, path) {
  if (!view?.follow || panel.hidden || !path) return;
  if (view.tab === tab) list(path);
  // Another terminal moved: it's there when the panel comes back to it, as if the panel had followed it all along.
  else if (shownFolders.has(tab.id)) shownFolders.set(tab.id, path);
}

on(EVENTS.remoteCwd, tab => { if (isSsh(tab)) followed(tab, tab.remoteCwd); });
on(EVENTS.cwd, tab => { if (!isSsh(tab) && !isRemote(tab)) followed(tab, tab.cwd); });
on(EVENTS.tabClosed, tab => shownFolders.delete(tab.id));

on(EVENTS.focus, tab => {
  // The panel follows the focused terminal while it has files to show.
  if (!panel.hidden && view && tab !== view.tab && hasFiles(tab)) {
    view = viewOf(tab);
    list(view.path);
  }
});
