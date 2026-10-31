// @ts-check
// When ssh asks for a password in a terminal opened from one of Settings › SSH's connections and the password typed
// there works (the connection signs in), a bar offers to save it: typed once more into Termilly's own field, it goes to the system's credential store (never to Termilly's
// files), and the connection signs in with it from then on, reconnects included. What was typed into ssh itself
// isn't read: the terminal's input stays the shell's.

import { PAGE, HOST } from './protocol.js';
import { send, onHost, sys } from './host.js';
import { state, GROUPS } from './store.js';
import { updateSettings } from './preferences.js';
import { modal, FORM_DIALOG } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { targetOf, field } from './dom.js';
import { PROFILE_ID_PREFIX } from './constants.js';
import { connections, IDENTITY, PASSWORD_AFTER_SAVE_MS } from './ssh.js';

/** ssh's password prompts: "user@host's password: ", and newer OpenSSH's "(user@host) Password: ". */
const PASSWORD_PROMPT = /(?:'s password|\) Password): ?$/;
/** Colours and cursor moves, taken out before the prompt is looked for. */
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const BAR_CLASS = 'ssh-save-bar';
/** What the bar's buttons do (data-ss). */
const BAR_ACTION = Object.freeze({ save: 'save', later: 'later' });

/** A password that didn't work: ssh asks again, so it isn't one to keep. */
const REFUSED = /Permission denied|Authentication failed|Too many authentication failures/i;
/** Signed in: the server's greeting, or a shell's prompt at the end of the last line. */
const SIGNED_IN = /Last login|Welcome to|[$#%>] ?$/;

/** Terminals already offered it, so a mistyped password and its second prompt don't offer again. */
const offered = new WeakSet();
/** Terminals ssh asked for a password, until they sign in: the bar waits for the password to work. */
/** @type {WeakMap<Tab, SshConnection>} */
const asked = new WeakMap();

/**
 * The connection a terminal was opened from, when it signs in without a saved password.
 * @param {Tab} tab
 */
function connectionOf(tab) {
  if (!tab.profile?.startsWith(PROFILE_ID_PREFIX.connection)) return null;
  const id = tab.profile.slice(PROFILE_ID_PREFIX.connection.length);
  const connection = connections().find(c => c.id === id);
  return connection && connection.identity !== IDENTITY.password && connection.identity !== IDENTITY.onePassword ? connection : null;
}

onHost(HOST.output, m => {
  const tab = state.tabs.get(m.id);
  if (!tab || offered.has(tab)) return;
  const text = String(m.data).replace(ESCAPES, '');
  const lastLine = text.split(/\r?\n|\r/).pop() ?? '';
  if (PASSWORD_PROMPT.test(lastLine)) {
    // Asked: the offer waits until the password typed into ssh has worked.
    const connection = connectionOf(tab);
    if (connection) asked.set(tab, connection);
    return;
  }
  const connection = asked.get(tab);
  if (!connection || REFUSED.test(text) || !(SIGNED_IN.test(text) || SIGNED_IN.test(lastLine.trimEnd()))) return;
  asked.delete(tab);
  offered.add(tab);
  showBar(tab, connection);
});

/**
 * @param {Tab} tab
 * @param {SshConnection} connection
 */
function showBar(tab, connection) {
  const pane = tab.view?.el;
  if (!pane) return;
  const bar = document.createElement('div');
  bar.className = BAR_CLASS;
  bar.innerHTML = `<span class="rb-text">Save the password for ${escapeHtml(connection.name)}, so it signs in by itself next time?</span>
    <button class="btn small primary" data-ss="${BAR_ACTION.save}">Save password</button><button class="btn small" data-ss="${BAR_ACTION.later}">Not now</button>`;
  bar.addEventListener('click', e => {
    const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-ss]'))?.dataset.ss;
    if (!action) return;
    bar.remove();
    if (action === BAR_ACTION.save) askPassword(connection);
  });
  pane.append(bar);
}

/**
 * Asks for the password in Termilly's own field, then keeps it in the credential store and has the connection use it.
 * @param {SshConnection} connection
 */
function askPassword(connection) {
  const name = escapeHtml(connection.name);
  modal(FORM_DIALOG, `
    <h3>Save the password for ${name}</h3>
    <p class="dialog-sub">Type it once more. ${escapeHtml(sys.credentials)} keeps it, and ${name} signs in with it from now on, also when it reconnects. Termilly doesn’t store it.</p>
    <label class="dialog-field">Password<input class="field" type="password" name="password" autocomplete="off" autofocus></label>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div>`,
  (dialog, /** @type {(password: string | null) => void} */ close) => ({ submit: () => close(field(dialog, '[name=password]').value) }))
    .then(password => {
      if (!password) return;
      updateSettings(GROUPS.ssh, { connections: connections().map(c => (c.id === connection.id ? { ...c, identity: IDENTITY.password } : c)) });
      // The password goes once the connection's new sign-in is saved; the page doesn't keep it.
      setTimeout(() => send(PAGE.sshPassword, { connection: connection.id, user: connection.user, password }), PASSWORD_AFTER_SAVE_MS);
    });
}
