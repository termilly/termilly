// @ts-check
// A newer Termilly is out: a small notice in the title bar (UpdateCheck.cs on the host checks the signed
// latest.json). Nothing starts on its own: "Download and install" downloads the installer (the host checks its
// SHA-256), and "Restart to update" installs it, closing Termilly and opening the new version (Features/Updates.cs).

import { PAGE, HOST } from './protocol.js';
import { UPDATE_STATE } from './constants.js';
import { send, onHost } from './host.js';
import { state, GROUPS } from './store.js';
import { showMenu, SEPARATOR } from './popups.js';
import { confirmDialog, modal, CONFIRM_DIALOG } from './dialogs.js';
import { escapeHtml, formatWhen } from './ui.js';
import { updateSettings } from './preferences.js';

/**
 * The host's last word: { current, checkedAt, failed, checking, available, progress }.
 * @typedef {{ current: string, checkedAt: number | null, failed?: boolean, checking?: boolean,
 *   available: import('./protocol.js').UpdateAvailable | null, progress?: import('./protocol.js').UpdateProgress | null }} UpdateStatus
 */

/** @type {UpdateStatus} */
export let updateStatus = { current: '', checkedAt: null, available: null };
/** @type {Set<(status: UpdateStatus) => void>} */
const listeners = new Set();

/**
 * Calls `fn` whenever the status changes (Settings › About redraws).
 * @param {(status: UpdateStatus) => void} fn
 */
export const onUpdateStatus = fn => listeners.add(fn);

/** The title bar's update notice: its class and its id. */
const CHIP = 'update-chip';
/** The class of the notice's menus. */
const MENU = 'update-menu';

const chip = document.createElement('button');
chip.className = CHIP;
chip.id = CHIP;
chip.hidden = true;
document.querySelector('#titlebar .toolbar')?.prepend(chip);

/** The notice's icon: an arrow down into a tray. */
const ICON = '<svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10"/></svg>';

/**
 * "1.1" for 1.1.0, as people say it.
 * @param {string} v
 */
const shortVersion = v => v.replace(/\.0$/, '');

/** The update the user asked for, while it's for the version on offer. */
const progressOf = () => updateStatus.available ? updateStatus.progress ?? null : null;

/** What the notice says for each state of an update the user asked for (none: just that it's out). */
function chipText() {
  const available = /** @type {import('./protocol.js').UpdateAvailable} */ (updateStatus.available);
  const progress = progressOf();
  switch (progress?.state) {
    case UPDATE_STATE.downloading: return `Downloading ${progress.percent}%`;
    case UPDATE_STATE.ready: return 'Restart to update';
    case UPDATE_STATE.installing: return 'Installing';
    case UPDATE_STATE.failed: return 'Update failed';
    case UPDATE_STATE.byHand: return `Install ${shortVersion(available.version)}`;
    default: return `Update ${shortVersion(available.version)}`;
  }
}

function render() {
  const available = updateStatus.available;
  // A version the user skipped stays out of sight, unless they asked for it before skipping.
  const show = !!available && (state.settings.uiState.skippedVersion !== available.version || !!progressOf());
  chip.hidden = !show;
  if (!show) return;
  chip.innerHTML = `${ICON}<span>${escapeHtml(chipText())}</span>`;
  chip.disabled = progressOf()?.state === UPDATE_STATE.installing;
  chip.title = `Termilly ${shortVersion(available.version)} is available${available.date ? ` (released ${available.date})` : ''}`;
}

/** How many terminals restarting closes, for the question before it. */
const terminalCount = () => [...state.tabs.values()].filter(t => !t.virtual).length;

/** Asks before closing Termilly to install, saying what happens to the terminals. */
async function restartToUpdate() {
  const available = /** @type {import('./protocol.js').UpdateAvailable} */ (updateStatus.available);
  const count = terminalCount();
  const terminals = !count ? ''
    : available.endsShells ? ` Your ${count === 1 ? 'terminal' : `${count} terminals`} will restart.`
    : ' Your terminals keep running.';
  const ok = await confirmDialog({
    title: `Update to Termilly ${shortVersion(available.version)}?`,
    body: `Termilly closes, installs the update and opens again.${terminals}`,
    confirm: 'Restart and update',
  });
  if (ok) send(PAGE.updateInstall);
}

/** Linux without a password prompt: the command to install it, to copy into a terminal. */
function installByHand(/** @type {string} */ command) {
  return modal(CONFIRM_DIALOG, `
    <h3>Install the update from a terminal</h3>
    <p class="dialog-sub">Termilly can't ask for your password here. Run this, then start Termilly again:</p>
    <pre class="update-command">${escapeHtml(command)}</pre>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Close</button>
      <button class="btn primary" data-ok autofocus>Copy command</button>
    </div>`, (dialog, close) => ({ submit: () => navigator.clipboard.writeText(command).then(() => close(true)) }));
}

/**
 * The notice's menu while nothing's asked for yet, or after a failure: the ways forward.
 * @returns {import('./popups.js').MenuEntry[]}
 */
function offerMenu() {
  const available = /** @type {import('./protocol.js').UpdateAvailable} */ (updateStatus.available);
  const failed = progressOf()?.state === UPDATE_STATE.failed ? /** @type {import('./protocol.js').UpdateProgress} */ (progressOf()) : null;
  return [
    ...(failed?.message ? [{ label: failed.message, disabled: true }] : []),
    {
      label: failed ? 'Try again' : 'Download and install',
      disabled: !available.installable,
      title: available.installable ? '' : 'This update can’t be installed from Termilly: its installer isn’t listed with a checksum.',
      action: () => send(PAGE.updateDownload),
    },
    ...(available.notes ? [{ label: 'What’s new', action: () => send(PAGE.openUrl, { url: available.notes }) }] : []),
    SEPARATOR,
    { label: 'Skip this version', action: () => (send(PAGE.updateCancel), updateSettings(GROUPS.uiState, { skippedVersion: available.version }), render()) },
  ];
}

chip.addEventListener('click', () => {
  const progress = progressOf();
  if (!updateStatus.available) return;
  if (progress?.state === UPDATE_STATE.ready) void restartToUpdate();
  else if (progress?.state === UPDATE_STATE.byHand && progress.command) void installByHand(progress.command);
  else if (progress?.state === UPDATE_STATE.downloading) showMenu([{ label: 'Cancel download', action: () => send(PAGE.updateCancel) }], chip, { className: MENU });
  else if (progress?.state !== UPDATE_STATE.installing) showMenu(offerMenu(), chip, { className: MENU });
});

onHost(HOST.updateStatus, m => {
  if (/** @type {{ checking?: boolean }} */ (m).checking) updateStatus = { ...updateStatus, checking: true };
  else updateStatus = { .../** @type {import('./protocol.js').Host_updateStatus_1} */ (m), checking: false };
  render();
  for (const fn of listeners) fn(updateStatus);
});

/** What Settings › About says about an update the user asked for. */
function progressText() {
  const progress = progressOf();
  switch (progress?.state) {
    case UPDATE_STATE.downloading: return `Downloading the update: ${progress.percent}%.`;
    case UPDATE_STATE.ready: return 'The update is downloaded: Restart to update in the title bar installs it.';
    case UPDATE_STATE.installing: return 'Installing the update.';
    case UPDATE_STATE.failed: return progress.message ?? 'The update failed.';
    case UPDATE_STATE.byHand: return 'The update is downloaded: install it from a terminal (the title bar has the command).';
    default: return null;
  }
}

/** Settings › About: the version line, when it last looked, and Check now. */
export function updateAboutHtml() {
  const s = updateStatus;
  const when = s.checkedAt ? `Last checked ${formatWhen(s.checkedAt)}.` : 'Not checked yet.';
  const result = s.checking ? 'Checking…'
    : s.failed ? 'Couldn’t reach the update server; it tries again later.'
    : progressText() ?? (s.available ? `Termilly ${s.available.version} is available.`
    : s.checkedAt ? 'You have the latest version.' : '');
  return `<span class="update-about">${escapeHtml(result)} ${when}</span>`;
}

export const checkForUpdates = () => send(PAGE.updateCheck);

send(PAGE.updateStatus);
