// @ts-check
// Settings › Privacy & security › Sync between PCs: command history shared through a folder you already sync
// (OneDrive, Dropbox, a share), encrypted with a sync code that only travels by you typing it on the other PC.
// HistorySync.cs does the work; docs/history-sync.md has the design.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { escapeHtml, ICONS } from './ui.js';
import { timeAgo } from './util.js';
import { modal, confirmDialog, pickFolder, FORM_DIALOG } from './dialogs.js';
import { codeBoxHtml, wireCodeBox, RECOVERY_DIALOG } from './security.js';
import { find, field, targetOf } from './dom.js';

/** What the sync section's buttons do (data-sync). */
const SYNC_ACTION = Object.freeze({ on: 'on', join: 'join', now: 'now', code: 'code', rotate: 'rotate', off: 'off' });

/** When something hasn't synced yet. */
const NEVER_LABEL = 'never';


/** A PC that syncs, as the host lists it (HistorySync.cs). */
/** @typedef {{ name: string, self: boolean, commands: number, updated: number | null }} SyncDevice */
/** The sync's state, as the host reports it. */
/**
 * @typedef {{ enabled: boolean, folder?: string | null, lastSync?: number | null, error?: string | null,
 *   devices: SyncDevice[] }} SyncStatus
 */

/** @type {SyncStatus} */
let status = { enabled: false, devices: [] };
let rerender = () => {};

/** @param {() => void} fn */
export function setSyncRerender(fn) {
  rerender = fn;
}

export function refreshSyncStatus() {
  send(PAGE.syncStatus);
}

onHost(HOST.syncStatus, m => {
  status = m.status;
  if (m.code) showSyncCode(m.code, m.rotated);
  if (m.message) syncError = m.message;
  rerender();
});

/** @type {string | null} */
let syncError = null;

const ago = /** @param {number | null | undefined} ms */ ms => (ms ? timeAgo(ms, { days: false }) : NEVER_LABEL);

/**
 * @param {typeof import('./settings/controls.js').group} group
 * @param {typeof import('./settings/controls.js').row} row
 */
export function syncSectionHtml(group, row) {
  const error = syncError ?? status.error;
  syncError = null;
  if (!status.enabled) {
    return group('Sync between PCs', row('Command history on your other PCs',
      'Shares the commands you run through a folder you already sync (OneDrive, Dropbox, a network share). Everything in it is encrypted; the sync code never goes into the folder.', `
        <span class="btn-row"><button class="btn small" data-sync="${SYNC_ACTION.on}">Turn on</button>
        <button class="btn small" data-sync="${SYNC_ACTION.join}">Join with a code</button></span>`)
      + (error ? `<p class="set-status">${escapeHtml(error)}</p>` : ''));
  }
  return group('Sync between PCs', row('Syncing command history',
    `Through <span class="mono">${escapeHtml(status.folder)}</span> · last synced ${escapeHtml(ago(status.lastSync))}`, `
      <span class="btn-row"><button class="btn small" data-sync="${SYNC_ACTION.now}">Sync now</button>
      <button class="btn small" data-sync="${SYNC_ACTION.off}">Turn off</button></span>`)
    + (error ? `<p class="set-status">${escapeHtml(error)}${/replaced/.test(error) ? ` <button class="btn small" data-sync="${SYNC_ACTION.join}">Enter new code</button>` : ''}</p>` : '')
    + row('Sync code', 'Type it on another PC (Join with a code) to add it. A new code removes every other PC until you enter the new code there.', `
      <span class="btn-row"><button class="btn small" data-sync="${SYNC_ACTION.code}">Show code</button>
      <button class="btn small" data-sync="${SYNC_ACTION.rotate}">New code</button></span>`)
    + row('PCs', '', `<div class="sync-devices">${status.devices.map(d => `
      <div class="sync-device"><span>${escapeHtml(d.name)}${d.self ? ' <span class="set-desc">(this PC)</span>' : ''}</span>
        <span class="set-desc">${d.commands} command${d.commands === 1 ? '' : 's'} · ${escapeHtml(ago(d.updated))}</span></div>`).join('') || '<span class="set-desc">None yet</span>'}</div>`, { stack: true }));
}

/**
 * @param {string} code
 * @param {boolean} rotated
 */
function showSyncCode(code, rotated) {
  return modal(RECOVERY_DIALOG, `
    <div class="dialog-icon">${ICONS.lock}</div>
    <h3>Sync code</h3>
    <p class="dialog-sub">${rotated ? 'The old code no longer works. Enter this one on each PC that should keep syncing.' : 'On your other PC: Settings › Privacy &amp; security › Join with a code, the same folder, and this code.'}</p>
    ${codeBoxHtml(code)}
    <p class="dialog-note">Anyone with this code and the folder can read the synced commands. Send it to yourself through
      a password manager, not in the synced folder.</p>
    <div class="dialog-actions"><button class="btn primary" data-ok autofocus>Done</button></div>`, (dialog, close) => {
    wireCodeBox(dialog, code);
    return { submit: () => close(true) };
  });
}

function joinDialog() {
  return modal(FORM_DIALOG, `
    <h3>Join synced history</h3>
    <p class="dialog-sub">Pick the same folder your other PC syncs into (the one that has “Termilly sync” in it) and enter its sync code.</p>
    <label class="dialog-field">Folder
      <span class="field-row">
        <input class="field" name="folder" value="${escapeHtml(status.folder ?? '')}" spellcheck="false">
        <button class="btn" data-browse data-no-enter>Browse</button>
      </span>
    </label>
    <label class="dialog-field">Sync code
      <input class="field mono" name="code" placeholder="XXXX-XXXX-…" spellcheck="false" autocomplete="off" autofocus>
    </label>
    <div class="dialog-actions">
      <button class="btn" data-cancel data-no-enter>Cancel</button>
      <button class="btn primary" data-ok>Join</button>
    </div>`, (dialog, close) => {
    const folder = field(dialog, '[name=folder]');
    find(dialog, '[data-browse]').addEventListener('click', async () => {
      const path = await pickFolder(folder.value);
      if (path) folder.value = path;
    });
    const submit = () => {
      if (!folder.value.trim() || !field(dialog, '[name=code]').value.trim()) return;
      send(PAGE.syncJoin, { folder: folder.value.trim(), code: field(dialog, '[name=code]').value });
      close(true);
    };
    return { submit };
  });
}

/** @param {Event} e */
export function handleSyncClick(e) {
  const button = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-sync]'));
  if (!button) return false;
  (async () => {
    switch (button.dataset.sync) {
      case SYNC_ACTION.on: {
        const folder = await pickFolder('');
        if (folder) send(PAGE.syncOn, { folder });
        break;
      }
      case SYNC_ACTION.join: joinDialog(); break;
      case SYNC_ACTION.now: send(PAGE.syncNow); break;
      case SYNC_ACTION.code: send(PAGE.syncCode); break;
      case SYNC_ACTION.rotate:
        if (await confirmDialog({ title: 'Make a new sync code?', body: 'The current code stops working. Every other PC stops syncing until you enter the new code there. Use this if the code leaked or to remove a PC.', confirm: 'New code' })) {
          send(PAGE.syncRotate);
        }
        break;
      case SYNC_ACTION.off:
        if (await confirmDialog({ title: 'Turn off sync on this PC?', body: 'Commands already synced stay in this PC’s history. Its file stays in the folder for your other PCs.', confirm: 'Turn off' })) {
          send(PAGE.syncOff);
        }
        break;
    }
  })();
  return true;
}
