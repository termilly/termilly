// @ts-check
// A newer Termilly is out: a small notice in the title bar (UpdateCheck.cs on the host checks the signed
// latest.json). Nothing is downloaded or run by Termilly; Download opens the installer link in the browser.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, GROUPS } from './store.js';
import { showMenu, SEPARATOR } from './popups.js';
import { escapeHtml, formatWhen } from './ui.js';
import { updateSettings } from './preferences.js';

/**
 * The host's last word: { current, checkedAt, failed, checking, available: { version, notes, download, linux } }.
 * @typedef {{ current: string, checkedAt: number | null, failed?: boolean, checking?: boolean,
 *   available: import('./protocol.js').UpdateAvailable | null }} UpdateStatus
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

const chip = document.createElement('button');
chip.className = CHIP;
chip.id = CHIP;
chip.hidden = true;
document.querySelector('#titlebar .toolbar')?.prepend(chip);

/**
 * "1.1" for 1.1.0, as people say it.
 * @param {string} v
 */
const shortVersion = v => v.replace(/\.0$/, '');

function render() {
  const available = updateStatus.available;
  const show = !!available && state.settings.uiState.skippedVersion !== available.version;
  chip.hidden = !show;
  if (!show) return;
  chip.innerHTML = `<svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10"/></svg><span>Update ${escapeHtml(shortVersion(available.version))}</span>`;
  chip.title = `Termilly ${shortVersion(available.version)} is available${available.date ? ` (released ${available.date})` : ''}`;
}

chip.addEventListener('click', () => {
  const available = updateStatus.available;
  if (!available) return;
  showMenu([
    { label: available.linux ? 'Download the .deb package' : 'Download', action: () => available.download && send(PAGE.openUrl, { url: available.download }) },
    ...(available.notes ? [{ label: 'What’s new', action: () => send(PAGE.openUrl, { url: available.notes }) }] : []),
    SEPARATOR,
    { label: 'Skip this version', action: () => (updateSettings(GROUPS.uiState, { skippedVersion: available.version }), render()) },
  ], chip, { className: 'update-menu' });
});

onHost(HOST.updateStatus, m => {
  if (/** @type {{ checking?: boolean }} */ (m).checking) updateStatus = { ...updateStatus, checking: true };
  else updateStatus = { .../** @type {import('./protocol.js').Host_updateStatus_1} */ (m), checking: false };
  render();
  for (const fn of listeners) fn(updateStatus);
});

/** Settings › About: the version line, when it last looked, and Check now. */
export function updateAboutHtml() {
  const s = updateStatus;
  const when = s.checkedAt ? `Last checked ${formatWhen(s.checkedAt)}.` : 'Not checked yet.';
  const result = s.checking ? 'Checking…'
    : s.failed ? 'Couldn’t reach the update server; it tries again later.'
    : s.available ? `Termilly ${escapeHtml(s.available.version)} is available.`
    : s.checkedAt ? 'You have the latest version.' : '';
  return `<span class="update-about">${result} ${when}</span>`;
}

export const checkForUpdates = () => send(PAGE.updateCheck);

send(PAGE.updateStatus);
