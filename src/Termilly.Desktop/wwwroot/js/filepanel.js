// @ts-check
// The Files side panel (terminal menu › Files, or Ctrl+Shift+L): the folders of the terminal in focus, following
// the folder its shell is in. For an SSH terminal they're on its server (the host runs sftp with the terminal's own
// connection settings, Sftp.cs); for one on this machine they're here (LocalFiles.cs). Folders open with a click, a
// file here opens in the preview, and right-clicking offers the rest. Files dropped on the panel are uploaded to the
// folder shown (copied, here); downloads go to Downloads, or a folder picked. Transfers queue at the bottom.

import { PAGE, HOST } from './protocol.js';
import { send, sendWithFiles, onHost, request, platform, droppedPaths, PLATFORM } from './host.js';
import { on, profileOf, isSsh, isRemote, wsById, EVENTS } from './store.js';
import { focusedTab, newTab } from './panes.js';
import { scheduleFit } from './terminals.js';
import { escapeHtml, ICONS } from './ui.js';
import { modal, confirmDialog, CONFIRM_DIALOG } from './dialogs.js';
import { byId, field, targetOf, dragPointer, WORKSPACE_ID, PATH_DRAG } from './dom.js';
import { showMenu, SEPARATOR } from './popups.js';
import { showChange } from './preview.js';
import { pathActions } from './actions.js';
import { FILE_OP, FOLDER_PATH } from './constants.js';

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
/** A transfer or file operation in the queue; a finished download keeps where it went. */
/**
 * @typedef {{ kind: string, name: string | null, state: string, refresh: boolean, requestId: string | null,
 *   message?: string | null, local?: string | null }} FileJob
 */
/** files:done, whichever of its shapes it has. */
/**
 * @typedef {{ requestId: string | null, ok: boolean, file?: string, local?: string | null, message?: string }}
 *   FilesDone
 */

/** A job's state in the queue. */
const JOB_STATE = Object.freeze({ running: 'running', done: 'done', failed: 'failed' });
/** What a job in the queue is (its icon). */
const JOB_KIND = Object.freeze({ put: 'put', get: 'get', rename: 'rename', delete: 'delete', mkdir: 'mkdir', open: 'open' });
/** What the panel's buttons do (data-files). */
const FILES_ACTION = Object.freeze({
  close: 'close', up: 'up', refresh: 'refresh', mkdir: 'mkdir', follow: 'follow', get: 'get', rename: 'rename', delete: 'delete',
});
/** The most jobs the queue keeps, and how many of the latest it shows. */
const MAX_QUEUE = 50;
const QUEUE_SHOWN = 6;
/** Bytes in a kilobyte and in a megabyte, for sizes. */
const KB = 1024;
const MB = KB * KB;
/** The panel's narrowest width; its widest is half the terminals' area (app.css max-width). */
const MIN_WIDTH_PX = 260;
/** Where this machine's deleted files go. */
const BIN = platform === PLATFORM.windows ? 'the Recycle Bin' : 'the trash';
const FILE_MANAGER = platform === PLATFORM.windows ? 'Explorer' : 'the file manager';

const panel = document.createElement('aside');
panel.className = 'files-panel';
panel.hidden = true;
byId(WORKSPACE_ID).append(panel);

/** @type {FilesView | null} */
let view = null;
/** @type {FileJob[]} */
const queue = [];
let requests = 0; // ids for the queue's file operations, whose answers come as files:done
/** The requests that are downloads to a folder the host asks for: their queued file is a download, not an upload. */
const downloadsTo = new Set();
/** Terminal id: the folder the panel last showed for it, to go back to when that terminal is focused again. */
/** @type {Map<string, string>} */
const shownFolders = new Map();

/** A path's separator: a backslash in a Windows folder, else a slash. */
const sepOf = /** @param {string} path */ path => (/^[A-Za-z]:\\|^\\\\/.test(path) ? '\\' : '/');
/**
 * @param {string} dir
 * @param {string} name
 */
const joinPath = (dir, name) => (dir.endsWith(sepOf(dir)) ? dir + name : `${dir}${sepOf(dir)}${name}`);
/** A Windows drive's root ("C:\") or a network share's ("\\server\share"): above it are the drives. */
const DRIVE_ROOT = /^[A-Za-z]:\\?$|^\\\\[^\\]+\\[^\\]+\\?$/;
/** The folder a path is in: above a drive or share, the drives; the server's root (and the drives) stay themselves. */
const parentOf = /** @param {string} path */ path => {
  if (path === FOLDER_PATH.drives || DRIVE_ROOT.test(path)) return FOLDER_PATH.drives;
  const sep = sepOf(path);
  const up = path.replace(sep === '\\' ? /\\[^\\]+\\?$/ : /\/[^/]+\/?$/, '');
  return sep === '\\' ? (/^[A-Za-z]:$/.test(up) ? `${up}\\` : up || path) : up || '/';
};
/** A drive, drawn on whole pixels at 16px with 1px lines (half-pixel coordinates), so it stays crisp. */
const DRIVE_ICON = '<svg class="files-drive" viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="13" height="7" rx="1"/><path d="M3.5 9.5h1M11.5 9.5h1"/></svg>';
/** Whether the panel shows the drives rather than a folder. */
const atDrives = () => view?.path === FOLDER_PATH.drives;
/** A path as a shell takes it: quoted when it has a space. */
const shellPath = /** @param {string} path */ path => (/[\s'"&()]/.test(path) ? `"${path}"` : path);

/** Whether a terminal's files can be shown: its server's over SFTP, or this machine's (not WSL, a container or serial). */
export const hasFiles = /** @param {Tab} tab */ tab => isSsh(tab) || !isRemote(tab);

onHost(HOST.filesDone, (/** @type {FilesDone} */ m) => {
  const item = queue.find(q => q.requestId === m.requestId && (!m.file || q.name === m.file) && q.state === JOB_STATE.running);
  if (item) {
    item.state = m.ok ? JOB_STATE.done : JOB_STATE.failed;
    item.local = m.ok ? m.local ?? null : null;
    item.message = m.ok ? (m.local ? `saved to ${m.local}` : '') : m.message;
  }
  render();
  if (m.ok && item?.refresh) list(view?.path);
});

// The files the host picked for "Upload" (Linux: its file dialog gives paths, the page's doesn't), or the file
// "Download to" downloads once its folder was picked, before they go.
onHost(HOST.filesQueued, m => {
  const kind = downloadsTo.delete(/** @type {string} */ (m.requestId)) ? JOB_KIND.get : JOB_KIND.put;
  for (const name of m.files ?? []) addJob({ kind, name, state: JOB_STATE.running, refresh: kind === JOB_KIND.put, requestId: m.requestId });
  render();
});

/** @param {string | null | undefined} path */
export async function list(path) {
  if (!view) return;
  view.loading = true;
  view.error = null;
  render();
  const m = await request(PAGE.filesList, { id: view.tab.id, path });
  if (!view) return;
  view.loading = false;
  if (m.error || m.ok === false) view.error = m.message ?? m.error;
  else {
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
  const server = isSsh(tab);
  const path = shownFolders.get(tab.id) ?? (server ? tab.remoteCwd ?? '~' : tab.cwd ?? wsById(tab.wsId)?.cwd ?? '~');
  return { tab, server, path, entries: [], loading: false, error: null, follow: view?.follow ?? true };
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
};
const sizeText = /** @param {number} n */ n => (n < KB ? `${n} B` : n < MB ? `${(n / KB).toFixed(1)} KB` : `${(n / MB).toFixed(1)} MB`);

/**
 * A file or folder's row, with the buttons its hover shows.
 * @param {FileEntry} e
 * @param {number} i
 * @param {boolean} server
 */
const entryRow = (e, i, server) => (e.label != null ? driveRow(e, i) : `
  <div class="files-item${e.isDirectory ? ' dir' : ''}" data-i="${i}" draggable="true" title="${escapeHtml([e.permissions, e.modified].filter(Boolean).join(' · '))}">
    <span class="files-name">${e.isDirectory ? '📁' : '📄'} ${escapeHtml(e.name)}</span>
    <span class="files-size">${e.isDirectory ? '' : sizeText(e.size)}</span>
    <span class="files-actions">
      ${server && !e.isDirectory ? `<button class="pane-btn" data-files="${FILES_ACTION.get}" title="Download to Downloads">↓</button>` : ''}
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
  <div class="files-item dir" data-i="${i}" draggable="true" title="${escapeHtml(e.modified)}">
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
    <div class="files-path" title="${escapeHtml(path)}">${escapeHtml(path === FOLDER_PATH.drives ? 'This PC' : path)}</div>
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

// ---- What a file or folder can do ----

/** A file or folder's path; a drive's is its root. @param {FileEntry} item */
const pathOf = item => (atDrives() ? item.name : joinPath(/** @type {FilesView} */ (view).path, item.name));

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

/** @param {FileEntry} item */
async function remove(item) {
  if (!view) return;
  const body = !view.server ? `It goes to ${BIN}.`
    : item.isDirectory ? 'Only an empty folder can be deleted.' : 'It’s deleted on the server; there’s no undo.';
  if (await confirmDialog({ title: `Delete ${item.name}?`, body, confirm: 'Delete' }) && view) {
    operation(JOB_KIND.delete, item.name, { op: item.isDirectory ? FILE_OP.removeDirectory : FILE_OP.remove, path: pathOf(item) }, true);
  }
}

/** @param {FileEntry} item */
const download = item => operation(JOB_KIND.get, item.name, { op: FILE_OP.get, path: pathOf(item) });

/** @param {FileEntry} item */
function downloadTo(item) {
  if (!view) return;
  const requestId = `files${++requests}`;
  downloadsTo.add(requestId);
  send(PAGE.filesGetTo, { id: view.tab.id, requestId, path: pathOf(item) });
}

/** @param {string} path */
function insertPath(path) {
  const term = view?.tab.view?.term;
  if (!term) return;
  term.paste(`${shellPath(path)} `);
  term.focus();
}

/** @param {string} text */
const copyText = text => navigator.clipboard.writeText(text);

/**
 * Opens what was clicked: a folder in the panel, a file here in the preview.
 * @param {FileEntry} item
 */
function openItem(item) {
  if (!view) return;
  if (item.isDirectory) list(pathOf(item));
  else if (!view.server) showChange(view.tab, pathOf(item));
}

panel.addEventListener('click', e => {
  if (!view) return;
  const reveal = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-reveal]'))?.dataset.reveal;
  if (reveal) return send(PAGE.openPath, { path: reveal });
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-files]'))?.dataset.files;
  const item = view.entries[Number(/** @type {HTMLElement | null} */ (targetOf(e).closest('[data-i]'))?.dataset.i)];
  if (action === FILES_ACTION.close) return toggleFiles(view.tab);
  if (action === FILES_ACTION.refresh) return list(view.path);
  if (action === FILES_ACTION.up) return list(parentOf(view.path));
  if (action === FILES_ACTION.follow) { view.follow = /** @type {HTMLInputElement} */ (e.target).checked; return; }
  if (action === FILES_ACTION.mkdir) return makeFolder();
  if (!item) return;
  if (atDrives()) return list(pathOf(item)); // a drive only opens
  if (action === FILES_ACTION.get) return download(item);
  if (action === FILES_ACTION.rename) return rename(item);
  if (action === FILES_ACTION.delete) return remove(item);
  if (!action) openItem(item);
});

// ---- The right-click menu ----

/**
 * What a file or folder's menu offers: opening it, getting it here (on a server), its path, the actions that take a
 * file (here), and renaming or deleting it.
 * @param {FilesView} v
 * @param {FileEntry} item
 * @returns {import('./popups.js').MenuEntry[]}
 */
function itemMenu(v, item) {
  const path = pathOf(item);
  const open = item.isDirectory ? [{ label: 'Open', icon: ICONS.folder, action: () => list(path) }]
    : v.server ? [
      { label: 'Download to Downloads', action: () => download(item) },
      { label: 'Download to', action: () => downloadTo(item) },
    ] : [
      { label: 'Preview', action: () => showChange(v.tab, path) },
      { label: 'Open in its app', action: () => operation(JOB_KIND.open, item.name, { op: FILE_OP.open, path }) },
    ];
  const here = v.server ? [] : [
    ...(item.isDirectory ? [{ label: 'Open a terminal here', icon: ICONS.terminal, action: () => newTab({ profile: v.tab.profile, wsId: v.tab.wsId, cwd: path }) }] : []),
    { label: `Show in ${FILE_MANAGER}`, action: () => send(PAGE.openPath, { path }) },
  ];
  const actions = v.server ? [] : pathActions(v.tab, path, item.isDirectory ? path : v.path);
  return [
    ...open, ...here, SEPARATOR,
    { label: 'Copy path', icon: ICONS.copy, action: () => copyText(path) },
    { label: 'Insert path in the terminal', action: () => insertPath(path) },
    .../** @type {import('./popups.js').MenuEntry[]} */ (actions.length ? [SEPARATOR, ...actions] : []),
    // A drive can't be renamed or deleted from here.
    .../** @type {import('./popups.js').MenuEntry[]} */ (atDrives() ? [] : [
      SEPARATOR,
      { label: 'Rename', icon: ICONS.rename, action: () => rename(item) },
      { label: 'Delete', icon: ICONS.trash, danger: true, action: () => remove(item) },
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
  { label: 'Insert path in the terminal', action: () => insertPath(v.path) },
];

panel.addEventListener('contextmenu', e => {
  if (!view || !targetOf(e).closest('.files-list')) return;
  e.preventDefault();
  const item = view.entries[Number(/** @type {HTMLElement | null} */ (targetOf(e).closest('[data-i]'))?.dataset.i)];
  showMenu(item ? itemMenu(view, item) : folderMenu(view), { x: e.clientX, y: e.clientY });
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
// A file or folder dragged out of the panel carries its path: a terminal types it where it's dropped (terminals.js).
panel.addEventListener('dragstart', e => {
  const item = view?.entries[Number(/** @type {HTMLElement | null} */ (targetOf(e).closest('[data-i]'))?.dataset.i)];
  if (!item || !e.dataTransfer) return;
  const path = pathOf(item);
  e.dataTransfer.setData(PATH_DRAG, path);
  e.dataTransfer.setData('text/plain', path);
  e.dataTransfer.effectAllowed = 'copy';
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
