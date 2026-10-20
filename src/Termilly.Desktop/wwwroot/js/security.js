// @ts-check
// Recovery code and unlocking. Workspaces and history are encrypted with a key locked to the Windows
// account; the recovery code is the way back in when that lock is lost (an admin password reset).

import { send, onHost, sys, SYSTEM_NAME } from './host.js';
import { PAGE, HOST } from './protocol.js';
import { modal, DIALOG_ERROR } from './dialogs.js';
import { ICONS } from './ui.js';
import { find, field, showError } from './dom.js';

/** How long a copy button says Copied, in milliseconds. */
const COPIED_MS = 1400;
/** How long after the page boots the first recovery code prompt waits, in milliseconds. */
const FIRST_CODE_DELAY_MS = 600;
/** The copy button's label while it flashes. */
const COPIED_LABEL = 'Copied';
/** The class of the dialogs that show a recovery code (modal()). */
export const RECOVERY_DIALOG = 'recovery';

const COPY_ICON = '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5A1 1 0 0 0 9.5 2.5h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';

/**
 * Copies text and flashes the button's label.
 * @param {HTMLElement} button
 * @param {string} text
 */
export async function copyText(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    const label = find(button, 'span');
    const before = label.textContent;
    label.textContent = COPIED_LABEL;
    setTimeout(() => { label.textContent = before; }, COPIED_MS);
  } catch {
    // Clipboard blocked: the code is selectable, so it can still be copied by hand.
  }
}

/**
 * The code, large and selectable, with a copy button.
 * @param {string} code
 */
export const codeBoxHtml = code => `
  <div class="code-box">
    <code class="recovery-code">${code}</code>
    <button class="btn small" data-copy data-no-enter>${COPY_ICON}<span>Copy</span></button>
  </div>`;

/**
 * @param {ParentNode} root
 * @param {string} code
 */
export function wireCodeBox(root, code) {
  find(root, '[data-copy]').addEventListener('click', e => copyText(/** @type {HTMLElement} */ (e.currentTarget), code));
}

/**
 * Asks the user to save the recovery code. `first` is the one-time prompt after Termilly creates the key;
 * the host is told once it's been acknowledged so it isn't asked again.
 * @param {string} code
 * @param {{ first?: boolean, regenerated?: boolean }} [options]
 */
export function showRecoveryCode(code, { first = false, regenerated = false } = {}) {
  const intro = first
    ? `Termilly now encrypts your workspaces and closed-terminal history on this PC. It unlocks automatically ${sys.unlocks}.`
    : regenerated
      ? 'This new code replaces the old one, which no longer works.'
      : 'Keep this code somewhere safe outside this PC, like a password manager.';
  return modal(RECOVERY_DIALOG, `
    <div class="dialog-icon">${ICONS.lock}</div>
    <h3>${first ? 'Save your recovery code' : 'Recovery code'}</h3>
    <p class="dialog-sub">${intro}</p>
    ${codeBoxHtml(code)}
    <p class="dialog-note">${sys.lostKey}, this code is the only way to open your
      history again. Find it later in Settings › Privacy &amp; security.</p>
    <div class="dialog-actions">
      <button class="btn primary" data-ok autofocus>${first ? 'I’ve saved it' : 'Done'}</button>
    </div>`, (dialog, close) => {
    wireCodeBox(dialog, code);
    return { submit: () => close(true) };
  }, { dismissable: !first }).then(() => {
    if (first) send(PAGE.securitySaved);
  });
}

/** @type {{ close: (result: unknown) => void, fail: (message: string) => void } | null} */
let unlockDialog = null;

/** History couldn't be unlocked by the Windows account: ask for the recovery code, or start fresh. */
function showUnlock() {
  if (unlockDialog) return;
  modal('unlock', `
    <div class="dialog-icon">${ICONS.lock}</div>
    <h3>Unlock your history</h3>
    <p class="dialog-sub">${sys.name === SYSTEM_NAME.linux
      ? 'Termilly can’t open your saved workspaces and history: the key file that unlocks them is missing or changed.'
      : 'Termilly can’t open your saved workspaces and history with this Windows account. This happens after an administrator resets the password.'}
      Enter your recovery code to bring everything back.</p>
    <label class="dialog-field">Recovery code
      <input class="field mono" name="code" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" spellcheck="false" autocomplete="off" autofocus>
    </label>
    <p class="dialog-error" hidden></p>
    <div class="dialog-actions">
      <button class="btn" data-fresh data-no-enter>Start fresh</button>
      <button class="btn primary" data-ok>Unlock</button>
    </div>
    <p class="dialog-note">Start fresh keeps the locked data aside, untouched. You can still restore its history later from
      Settings › Privacy &amp; security with the recovery code.</p>`, (dialog, close) => {
    const input = field(dialog, '[name=code]');
    const ok = /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-ok]'));
    const error = find(dialog, DIALOG_ERROR);
    const unlock = () => {
      if (!input.value.trim()) return input.focus();
      ok.disabled = true;
      error.hidden = true;
      send(PAGE.securityRecover, { code: input.value });
    };
    unlockDialog = {
      close,
      /** @param {string} message */
      fail(message) {
        ok.disabled = false;
        showError(error, message);
        input.select();
      },
    };
    find(dialog, '[data-fresh]').addEventListener('click', () => send(PAGE.securityStartFresh));
    return { submit: unlock };
  }, { dismissable: false }).then(() => { unlockDialog = null; });
}

onHost(HOST.securityLocked, showUnlock);
onHost(HOST.securityError, m => unlockDialog?.fail(m.message));
// Unlocked (or started fresh): the host sends settings, which boots the page.
onHost(HOST.settings, m => {
  unlockDialog?.close(true);
  const code = m.security?.newRecoveryCode;
  if (code) setTimeout(() => showRecoveryCode(code, { first: true }), FIRST_CODE_DELAY_MS);
});
