// @ts-check
// Settings › Privacy & security: the encryption, the recovery code, locked history, saved output and sync.

import { PAGE, HOST } from '../protocol.js';
import { send, onHost, sys, SYSTEM_NAME } from '../host.js';
import { emit, getSetting, GROUPS, EVENTS } from '../store.js';
import { updateSettings } from '../preferences.js';
import { ICONS } from '../ui.js';
import { confirmDialog } from '../dialogs.js';
import { showRecoveryCode } from '../security.js';
import { syncSectionHtml, handleSyncClick, setSyncRerender, refreshSyncStatus } from '../sync.js';
import { row, toggle, group } from './controls.js';
import { SECTION, body, redrawIfShowing } from './page.js';
import { SETTING_VALUES } from '../constants.js';
import { field } from '../dom.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { historyDays } = SETTING_VALUES;

/** How long history is kept: a number of days or months, or Forever (0 days). */
const KEEP_FOR = Object.freeze({ days: 'days', months: 'months', forever: 'forever' });
const KEEP_COUNT = '[data-keep-count]';
const KEEP_UNIT = '[data-keep-unit]';
const FIELD_ROW = '.field-row';
/** The most the number goes to, in days and in months (C#'s HistoryDays.Max: 100 years). */
const MOST = Object.freeze({ days: historyDays.max, months: Math.floor(historyDays.max / historyDays.daysPerMonth) });

/**
 * The setting as the row shows it: a whole number of months when it divides, else days.
 * @param {number} days
 * @returns {{ unit: string, count: number }}
 */
function keepFor(days) {
  if (days === historyDays.forever) return { unit: KEEP_FOR.forever, count: historyDays.default };
  if (days % historyDays.daysPerMonth === 0) return { unit: KEEP_FOR.months, count: days / historyDays.daysPerMonth };
  return { unit: KEEP_FOR.days, count: days };
}

/** Keep history for: [number] [Days | Months | Forever]. */
function keepForHtml() {
  const now = keepFor(getSetting('session.historyDays'));
  const units = [[KEEP_FOR.days, 'Days'], [KEEP_FOR.months, 'Months'], [KEEP_FOR.forever, 'Forever']];
  return `<span class="field-row"><input class="field keep-count" data-keep-count type="number" min="1" max="${MOST.days}" value="${now.count}" aria-label="How many"${now.unit === KEEP_FOR.forever ? ' hidden' : ''}>
    <select class="field" data-keep-unit aria-label="Days, months or forever">${units.map(([v, l]) => `<option value="${v}"${v === now.unit ? ' selected' : ''}>${l}</option>`).join('')}</select></span>`;
}

/**
 * Saves what the row says; a number out of range is brought back in.
 * @param {Event} e
 */
function keepForChanged(e) {
  const target = /** @type {HTMLElement} */ (e.target);
  if (!target.matches(`${KEEP_COUNT}, ${KEEP_UNIT}`)) return false;
  const rowEl = /** @type {HTMLElement} */ (target.closest(FIELD_ROW));
  const count = /** @type {HTMLInputElement} */ (rowEl.querySelector(KEEP_COUNT));
  const unit = /** @type {HTMLSelectElement} */ (rowEl.querySelector(KEEP_UNIT)).value;
  count.hidden = unit === KEEP_FOR.forever;
  const most = unit === KEEP_FOR.months ? MOST.months : MOST.days;
  const n = Math.min(most, Math.max(1, Math.round(Number(count.value)) || 1));
  count.value = String(n);
  const days = unit === KEEP_FOR.forever ? historyDays.forever : unit === KEEP_FOR.months ? n * historyDays.daysPerMonth : n;
  updateSettings(GROUPS.session, { historyDays: days });
  return true;
}

/** How many locked history archives there are (set aside when they couldn't be unlocked). */
let archives = 0;
/** What the recovery code the host is asked for is for, while waiting for it. */
const CODE_REQUEST = Object.freeze({ show: 'show', regenerate: 'regenerate' });
/** The restore status's class when it worked (green). */
const OK_CLASS = 'ok';
/** @type {string | null} */
let pendingCode = null;

/** @type {import('./page.js').Section} */
const PRIVACY = {
  id: SECTION.privacy,
  label: 'Privacy & security', icon: ICONS.lock,
  html: () => `
    <div class="secure-card">
      <div class="secure-icon">${ICONS.lock}</div>
      <div><div class="set-name">Encrypted on this PC</div>
      <div class="set-desc">Encrypted (AES-256), unlocked ${sys.unlocks}. Nothing leaves this PC unless you turn on sync.</div></div>
    </div>`
    + group('Recovery code', row('Recovery code',
      `Opens your history if ${sys.name === SYSTEM_NAME.linux ? 'its key file is lost' : 'your Windows password is reset'}.`, `
        <span class="btn-row"><button class="btn small" data-action="showCode">Show code</button>
        <button class="btn small" data-action="newCode">New code</button></span>`)
      + (archives ? row(`Locked history (${archives})`, 'History that couldn’t be unlocked; its recovery code opens it.', `
        <span class="field-row"><input class="field mono" data-restore-code placeholder="XXXX-XXXX-…" spellcheck="false" autocomplete="off">
        <button class="btn small" data-action="restore">Restore</button></span>
        <p class="set-status" data-restore-status hidden></p>`, { stack: true }) : ''))
    + group('History', row('Save output of closed terminals',
      'Off keeps only a closed terminal’s name, tags and folder.', toggle('session.saveOutput'))
      + row('Keep history for', 'Closed terminals with their output, and the commands run. A month is 30 days.', keepForHtml(), { keywords: 'retention history days months forever keep expire' })
      + row('Redact secrets', 'Replace tokens, keys and passwords with [redacted].',
        toggle('session.redactSecrets'))
      + row('Clear history', 'Deletes every closed terminal Termilly has kept.', '<button class="btn small danger-outline" data-action="clearHistory">Clear history</button>'))
    + syncSectionHtml(group, row),
  refresh: refreshSyncStatus,
  click: handleSyncClick,
  change: keepForChanged,
  actions: {
    showCode: () => { pendingCode = CODE_REQUEST.show; send(PAGE.securityCode); },
    async newCode() {
      if (await confirmDialog({
        title: 'Make a new recovery code?',
        body: 'The current code stops working straight away. Save the new one before closing the next window.',
        confirm: 'Make new code',
      })) {
        pendingCode = CODE_REQUEST.regenerate;
        send(PAGE.securityRegenerate);
      }
    },
    restore() {
      const input = field(body, '[data-restore-code]');
      if (input.value.trim()) send(PAGE.securityRestore, { code: input.value });
    },
    async clearHistory() {
      if (await confirmDialog({
        title: 'Clear history?',
        body: 'This deletes every closed session Termilly has kept, including their saved output. Open terminals are not affected.',
        confirm: 'Clear history',
      })) {
        send(PAGE.historyClear);
        emit(EVENTS.history);
      }
    },
  },
};

export default PRIVACY;

/**
 * @param {string} text
 * @param {boolean} ok
 */
const restoreStatus = (text, ok) => {
  const status = /** @type {HTMLElement | null} */ (body.querySelector('[data-restore-status]'));
  if (!status) return;
  status.textContent = text;
  status.classList.toggle(OK_CLASS, ok);
  status.hidden = false;
};

onHost(HOST.settings, m => { archives = m.security?.archives ?? 0; });
onHost(HOST.securityCode, m => {
  if (!m.code || !pendingCode) return;
  const regenerated = pendingCode === CODE_REQUEST.regenerate;
  pendingCode = null;
  showRecoveryCode(m.code, { regenerated });
});
onHost(HOST.securityRestored, m => {
  if (m.count < 0) return restoreStatus('That code doesn’t open any of the locked history.', false);
  archives = m.archives;
  emit(EVENTS.history);
  // Keep the row (until Settings is reopened) so the result stays visible; drop the form if nothing is left.
  const input = body.querySelector('[data-restore-code]');
  if (input && !archives) /** @type {HTMLElement} */ (input.closest(FIELD_ROW)).remove();
  restoreStatus(`Restored ${m.count} closed terminal${m.count === 1 ? '' : 's'}. Find them in Recently closed.`, true);
});
onHost(HOST.securityError, m => restoreStatus(m.message, false));
setSyncRerender(() => redrawIfShowing(SECTION.privacy));
