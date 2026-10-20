// @ts-check
// The SFTP side panel (terminal menu › Files, or Ctrl+Shift+L): the remote files of the SSH terminal in focus,
// following the folder its shell is in. Folders open with a click; files download to Downloads; files dropped on
// the panel upload to the folder shown; transfers queue at the bottom. The host runs sftp with the terminal's own
// connection settings (Sftp.cs).

import { PAGE, HOST } from './protocol.js';
import { send, sendWithFiles, onHost, request, platform, droppedPaths, PLATFORM } from './host.js';
import { on, profileOf, isSsh, EVENTS } from './store.js';
import { focusedTab } from './panes.js';
import { escapeHtml, ICONS } from './ui.js';
import { modal, confirmDialog, CONFIRM_DIALOG } from './dialogs.js';
import { byId, field, targetOf, WORKSPACE_ID } from './dom.js';

/** A file or folder on the server, as the host lists it (Sftp.cs). */
/** @typedef {{ name: string, isDirectory: boolean, size: number, permissions: string, modified: string }} SftpEntry */
/** What the panel shows: its terminal, the folder and what's in it. */
/**
 * @typedef {{ tab: Tab, path: string, entries: SftpEntry[], loading: boolean, error: string | null, follow: boolean }}
 *   SftpView
 */
/** A transfer or file operation in the queue. */
/**
 * @typedef {{ kind: string, name: string | null, state: string, refresh: boolean, requestId: string | null,
 *   message?: string | null }} SftpJob
 */
/** sftp:done, whichever of its shapes it has. */
/**
 * @typedef {{ requestId: string | null, ok: boolean, file?: string, local?: string | null, message?: string }}
 *   SftpDone
 */

/** A job's state in the queue. */
const JOB_STATE = Object.freeze({ running: 'running', done: 'done', failed: 'failed' });
/** What a job in the queue is (its icon). */
const JOB_KIND = Object.freeze({ put: 'put', get: 'get', rename: 'rename', delete: 'delete', mkdir: 'mkdir' });
/** The file operations the host runs (PAGE.sftpOp's op). */
const SFTP_OP = Object.freeze({ get: 'get', rename: 'rename', mkdir: 'mkdir', rmdir: 'rmdir', rm: 'rm' });
/** What the panel's buttons do (data-sftp). */
const SFTP_ACTION = Object.freeze({
  close: 'close', up: 'up', refresh: 'refresh', mkdir: 'mkdir', follow: 'follow', get: 'get', rename: 'rename', delete: 'delete',
});
/** The most jobs the queue keeps, and how many of the latest it shows. */
const MAX_QUEUE = 50;
const QUEUE_SHOWN = 6;
/** Bytes in a kilobyte and in a megabyte, for sizes. */
const KB = 1024;
const MB = KB * KB;

const panel = document.createElement('aside');
panel.className = 'sftp-panel';
panel.hidden = true;
byId(WORKSPACE_ID).append(panel);

/** @type {SftpView | null} */
let view = null; // { tab, path, entries, loading, error, follow }
/** @type {SftpJob[]} */
const queue = [];
let requests = 0; // ids for the queue's file operations, whose answers come as sftp:done

onHost(HOST.sftpDone, (/** @type {SftpDone} */ m) => {
  const item = queue.find(q => q.requestId === m.requestId && (!m.file || q.name === m.file) && q.state === JOB_STATE.running);
  if (item) {
    item.state = m.ok ? JOB_STATE.done : JOB_STATE.failed;
    item.message = m.ok ? (m.local ? `saved to ${m.local}` : '') : m.message;
  }
  render();
  if (m.ok && item?.refresh) list(view?.path);
});

/** @param {string | null | undefined} path */
export async function list(path) {
  if (!view) return;
  view.loading = true;
  view.error = null;
  render();
  const m = await request(PAGE.sftpList, { id: view.tab.id, path });
  if (!view) return;
  view.loading = false;
  if (m.error || m.ok === false) view.error = m.message ?? m.error;
  else {
    view.path = m.path;
    view.entries = m.entries ?? [];
  }
  render();
}

/** @param {Tab | null | undefined} [tab] */
export function toggleSftp(tab = focusedTab()) {
  if (!panel.hidden && (!tab || view?.tab === tab)) {
    panel.hidden = true;
    view = null;
    return;
  }
  if (!tab || !isSsh(tab)) return;
  view = { tab, path: tab.remoteCwd ?? '~', entries: [], loading: false, error: null, follow: true };
  panel.hidden = false;
  list(view.path);
}

/** @type {Record<string, string>} */
const JOB_ICONS = { [JOB_KIND.put]: '↑', [JOB_KIND.get]: '↓', [JOB_KIND.rename]: '✎', [JOB_KIND.delete]: '✕', [JOB_KIND.mkdir]: '+' };
const sizeText = /** @param {number} n */ n => (n < KB ? `${n} B` : n < MB ? `${(n / KB).toFixed(1)} KB` : `${(n / MB).toFixed(1)} MB`);

function render() {
  if (!view) return;
  const { tab, path, entries, loading, error, follow } = view;
  panel.innerHTML = `
    <div class="sftp-head">
      <span class="sftp-title">Files · ${escapeHtml(profileOf(tab)?.name ?? '')}</span>
      <button class="pane-btn" data-sftp="${SFTP_ACTION.close}" title="Close">${ICONS.close}</button>
    </div>
    <div class="sftp-bar">
      <button class="btn small" data-sftp="${SFTP_ACTION.up}" title="Up a folder">↑</button>
      <button class="btn small" data-sftp="${SFTP_ACTION.refresh}" title="Refresh">⟳</button>
      <button class="btn small" data-sftp="${SFTP_ACTION.mkdir}" title="New folder">${ICONS.plus}</button>
      <label class="btn small sftp-upload" title="Upload files">Upload<input type="file" multiple hidden data-sftp-files></label>
      <label class="paste-never sftp-follow" title="Show the folder the terminal is in"><input type="checkbox" data-sftp="${SFTP_ACTION.follow}"${follow ? ' checked' : ''}> Follow</label>
    </div>
    <div class="sftp-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>
    <div class="sftp-list">${loading ? '<div class="inbox-empty">Loading…</div>' : error ? `<div class="inbox-empty sftp-error">${escapeHtml(error)}</div>` :
      entries.length ? entries.map((e, i) => `
        <div class="sftp-item${e.isDirectory ? ' dir' : ''}" data-i="${i}" title="${escapeHtml(`${e.permissions} · ${e.modified}`)}">
          <span class="sftp-name">${e.isDirectory ? '📁' : '📄'} ${escapeHtml(e.name)}</span>
          <span class="sftp-size">${e.isDirectory ? '' : sizeText(e.size)}</span>
          <span class="sftp-actions">
            ${e.isDirectory ? '' : `<button class="pane-btn" data-sftp="${SFTP_ACTION.get}" title="Download to Downloads">↓</button>`}
            <button class="pane-btn" data-sftp="${SFTP_ACTION.rename}" title="Rename">${ICONS.rename}</button>
            <button class="pane-btn" data-sftp="${SFTP_ACTION.delete}" title="Delete">${ICONS.trash}</button>
          </span>
        </div>`).join('') : '<div class="inbox-empty">Empty folder. Drop files here to upload.</div>'}</div>
    ${queue.length ? `<div class="sftp-queue">${queue.slice(-QUEUE_SHOWN).reverse().map(q => `
      <div class="sftp-job ${q.state}"><span>${JOB_ICONS[q.kind] ?? ''} ${escapeHtml(q.name)}</span><span>${escapeHtml(q.state === JOB_STATE.failed ? q.message ?? JOB_STATE.failed : q.state === JOB_STATE.done ? q.message || JOB_STATE.done : '…')}</span></div>`).join('')}</div>` : ''}`;
}

/**
 * Runs a file operation, shown in the queue until it's done; refresh lists the folder again afterwards.
 * @param {string} kind
 * @param {string} name
 * @param {{ op: string, path: string | null, to?: string }} fields
 * @param {boolean} [refresh]
 */
function operation(kind, name, fields, refresh = false) {
  const requestId = `sftp${++requests}`;
  queue.push({ kind, name, state: JOB_STATE.running, refresh, requestId });
  if (queue.length > MAX_QUEUE) queue.shift();
  send(PAGE.sftpOp, { id: /** @type {SftpView} */ (view).tab.id, requestId, ...fields });
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

panel.addEventListener('click', async e => {
  if (!view) return;
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-sftp]'))?.dataset.sftp;
  const item = view.entries[Number(/** @type {HTMLElement | null} */ (targetOf(e).closest('[data-i]'))?.dataset.i)];
  const path = item ? (view.path.endsWith('/') ? view.path + item.name : `${view.path}/${item.name}`) : null;
  if (action === SFTP_ACTION.close) return toggleSftp(view.tab);
  if (action === SFTP_ACTION.refresh) return list(view.path);
  if (action === SFTP_ACTION.up) return list(view.path.replace(/\/[^/]+\/?$/, '') || '/');
  if (action === SFTP_ACTION.follow) { view.follow = /** @type {HTMLInputElement} */ (e.target).checked; return; }
  if (action === SFTP_ACTION.mkdir) {
    const name = await askName('New folder');
    if (name && view) operation(JOB_KIND.mkdir, name, { op: SFTP_OP.mkdir, path: `${view.path}/${name}` }, true);
    return;
  }
  if (action === SFTP_ACTION.get && item) return operation(JOB_KIND.get, item.name, { op: SFTP_OP.get, path });
  if (action === SFTP_ACTION.rename && item) {
    const to = await askName(`Rename ${item.name}`, item.name);
    if (to && to !== item.name && view) operation(JOB_KIND.rename, `${item.name} → ${to}`, { op: SFTP_OP.rename, path, to: `${view.path}/${to}` }, true);
    return;
  }
  if (action === SFTP_ACTION.delete && item) {
    if (await confirmDialog({ title: `Delete ${item.name}?`, body: item.isDirectory ? 'Only an empty folder can be deleted.' : 'It’s deleted on the server; there’s no undo.', confirm: 'Delete' })) {
      operation(JOB_KIND.delete, item.name, { op: item.isDirectory ? SFTP_OP.rmdir : SFTP_OP.rm, path }, true);
    }
    return;
  }
  if (!action && item?.isDirectory) list(path);
});

/**
 * Uploads files to the folder shown. On Windows the files go to the host with the message (WebView2 gives their
 * paths); on Linux the page sends the paths a drop carried (`paths`).
 * @param {FileList | null} files
 * @param {string[] | null} [paths]
 */
function upload(files, paths = null) {
  if (!view || !(paths ?? files)?.length) return;
  const requestId = `sftp${++requests}`;
  const names = paths ? paths.map(p => /** @type {string} */ (p.split('/').pop())) : [.../** @type {FileList} */ (files)].map(f => f.name);
  for (const name of names) queue.push({ kind: JOB_KIND.put, name, state: JOB_STATE.running, refresh: true, requestId });
  if (paths) send(PAGE.sftpPut, { id: view.tab.id, requestId, dir: view.path, paths });
  else if (window.chrome?.webview) sendWithFiles(PAGE.sftpPut, { id: view.tab.id, requestId, dir: view.path }, /** @type {FileList} */ (files));
  render();
}

// The files the host picked for "Upload" (Linux: its file dialog gives paths, the page's doesn't), before they go.
onHost(HOST.sftpQueued, m => {
  for (const name of m.files ?? []) queue.push({ kind: JOB_KIND.put, name, state: JOB_STATE.running, refresh: true, requestId: m.requestId });
  render();
});

panel.addEventListener('change', e => {
  if (targetOf(e).matches('[data-sftp-files]')) upload(/** @type {HTMLInputElement} */ (e.target).files);
});
// Linux: the Upload button opens the host's file dialog instead of the page's.
panel.addEventListener('click', e => {
  if (platform !== PLATFORM.linux || !view || !targetOf(e).closest('.sftp-upload')) return;
  e.preventDefault();
  send(PAGE.sftpPick, { id: view.tab.id, requestId: `sftp${++requests}`, dir: view.path });
});
panel.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); panel.classList.add('drop'); } });
panel.addEventListener('dragleave', () => panel.classList.remove('drop'));
panel.addEventListener('drop', e => {
  panel.classList.remove('drop');
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  if (platform === PLATFORM.linux) upload(null, droppedPaths(e.dataTransfer));
  else upload(e.dataTransfer.files);
});

// ---- Following the terminal's folder ----

/** The remote folder an SSH terminal's prompt shows ("user@host:~/dir$ "). */
// The panel follows its terminal's shell from folder to folder.
on(EVENTS.remoteCwd, tab => {
  // The same terminal as the panel's, so the panel is open.
  if (view?.tab === tab && /** @type {SftpView} */ (view).follow && !panel.hidden) list(tab.remoteCwd);
});

on(EVENTS.focus, tab => {
  // The panel follows the focused terminal while it's an SSH one.
  if (!panel.hidden && view && tab !== view.tab && isSsh(tab)) {
    view = { ...view, tab, path: tab.remoteCwd ?? '~', entries: [] };
    list(view.path);
  }
});
