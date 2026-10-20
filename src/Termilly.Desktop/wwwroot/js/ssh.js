// @ts-check
// Settings › SSH: connections (with jump hosts and credential references, never passwords), port forwards that
// can be started and stopped, and importing sessions from PuTTY, MobaXterm, SecureCRT and mRemoteNG.

import { PAGE, HOST } from './protocol.js';
import { send, onHost, sys } from './host.js';
import { state, GROUPS, isSshProfile } from './store.js';
import { modal, CONFIRM_DIALOG, DIALOG_ERROR } from './dialogs.js';
import { escapeHtml, ICONS } from './ui.js';
import { updateSettings } from './preferences.js';
import { find, field, targetOf, showError } from './dom.js';
import { FORWARD_STATE } from './constants.js';

/** What the connection dialog gives back: the connection, and a password to save (wincred), else ''. */
/** @typedef {{ value: SshConnection, password: string }} ConnectionResult */
/**
 * A session another SSH app saved, as the host found it.
 * @typedef {{ name: string, host: string, user?: string | null, port?: number | null, keyPath?: string | null,
 *   source: string }} ImportedHost
 */

/** How a connection signs in (SshConnection.identity). */
const IDENTITY = Object.freeze({ agent: 'agent', key: 'key', securityKey: 'sk', password: 'wincred', onePassword: 'op' });

const IDENTITIES = [
  [IDENTITY.agent, 'ssh-agent / default keys'],
  [IDENTITY.key, 'Key file'],
  [IDENTITY.securityKey, 'FIDO2 security key (-sk key file)'],
  [IDENTITY.password, `Password in ${sys.credentials}`],
  [IDENTITY.onePassword, '1Password reference (op CLI)'],
];

/** What the section's buttons do (data-ssh). */
const SSH_ACTION = Object.freeze({
  add: 'add', edit: 'edit', remove: 'remove', addForward: 'addForward', editForward: 'editForward',
  removeForward: 'removeForward', start: 'start', stop: 'stop', import: 'import',
});

/** A port forward's kind, as ssh's flags: local (-L), remote (-R) or a SOCKS proxy (-D). */
const FORWARD_KIND = Object.freeze({ local: 'L', remote: 'R', socks: 'D' });


/** A new forward's listen port, and where a forward goes when it doesn't say. */
const DEFAULT_LISTEN_PORT = 8080;
const DEFAULT_DEST_HOST = 'localhost';

/** ssh's port when a connection doesn't say. */
const SSH_PORT = 22;

/** The connection dialog's fields (their names). */
const FIELD = Object.freeze({
  name: 'name', host: 'host', user: 'user', port: 'port', jump: 'jump', tags: 'tags', keyPath: 'keyPath', secretRef: 'secretRef',
});

/** The forward dialog's fields (their names). */
const FORWARD_FIELD = Object.freeze({ name: 'name', target: 'target', listenPort: 'listenPort', destHost: 'destHost', destPort: 'destPort' });

/** The forward row's button labels. */
const START_LABEL = 'Start';
const STOP_LABEL = 'Stop';

/** The class of the dialog for a connection (serial.js's network consoles use it too). */
export const CONNECTION_DIALOG = 'ssh-conn';

/** @type {Record<string, boolean>} */
let credentialsSaved = {};
/** @type {Record<string, import('./protocol.js').ForwardState>} */
let forwardStates = {};
let rerender = () => {};

/**
 * settings.js re-renders the SSH section through this when something here changes.
 * @param {() => void} fn
 */
export function setSshRerender(fn) {
  rerender = fn;
}

export function refreshSshStatus() {
  send(PAGE.sshStatus);
}

onHost(HOST.sshCredentials, m => { credentialsSaved = m.saved ?? {}; rerender(); });
onHost(HOST.forwardAll, m => { forwardStates = m.states ?? {}; rerender(); });
onHost(HOST.forwardStatus, m => { forwardStates[m.id] = { state: m.state, message: m.message }; rerender(); });
onHost(HOST.sshError, m => modal(CONFIRM_DIALOG, `<h3>SSH</h3><p class="dialog-sub">${escapeHtml(m.message)}</p>
  <div class="dialog-actions"><button class="btn primary" data-ok autofocus>OK</button></div>`, (d, close) => {
  return { submit: () => close(true) };
}));

const connections = () => state.settings.ssh.connections ?? [];
const forwards = () => state.settings.ssh.forwards ?? [];
const sshTargets = () => state.profiles.filter(p => isSshProfile(p));
const newId = /** @param {string} prefix */ prefix => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** @param {SshConnection} c */
function describe(c) {
  return `${c.user ? `${c.user}@` : ''}${c.host}${c.port && c.port !== SSH_PORT ? `:${c.port}` : ''}${c.jump ? ` via ${c.jump}` : ''}`;
}

/** @param {SshConnection} c */
function signIn(c) {
  const label = IDENTITIES.find(([id]) => id === c.identity)?.[1] ?? 'ssh-agent';
  if (c.identity === IDENTITY.password) return `${label}${credentialsSaved[c.id] ? ' · saved' : ' · not saved yet'}`;
  return label;
}

/** @param {PortForward} f */
function forwardText(f) {
  if (f.kind === FORWARD_KIND.socks) return `SOCKS proxy on localhost:${f.listenPort}`;
  if (f.kind === FORWARD_KIND.remote) return `remote :${f.listenPort} → ${f.destHost}:${f.destPort}`;
  return `localhost:${f.listenPort} → ${f.destHost}:${f.destPort}`;
}

/**
 * A port forward's row in the section: its state, what it forwards, and its buttons.
 * @param {PortForward} f
 */
function forwardRowHtml(f) {
  const status = forwardStates[f.id] ?? /** @type {import('./protocol.js').ForwardState} */ ({ state: FORWARD_STATE.stopped });
  const through = state.profiles.find(p => p.id === f.target)?.name ?? 'missing host';
  const running = status.state === FORWARD_STATE.running || status.state === FORWARD_STATE.starting;
  return `
        <div class="ssh-row" data-forward="${escapeHtml(f.id)}">
          <span class="fwd-dot ${escapeHtml(status.state)}" title="${escapeHtml(status.state)}"></span>
          <span class="ssh-main"><span class="ssh-name">${escapeHtml(f.name || forwardText(f))}</span>
            <span class="ssh-sub">${escapeHtml(forwardText(f))} · through ${escapeHtml(through)}${f.autoStart ? ' · starts with Termilly' : ''}</span>
            ${status.state === FORWARD_STATE.failed && status.message ? `<span class="ssh-error">${escapeHtml(status.message)}</span>` : ''}</span>
          <button class="btn small" data-ssh="${running ? SSH_ACTION.stop : SSH_ACTION.start}">${running ? STOP_LABEL : START_LABEL}</button>
          <button class="btn small" data-ssh="${SSH_ACTION.editForward}">Edit</button>
          <button class="btn small" data-ssh="${SSH_ACTION.removeForward}" title="Remove">${ICONS.trash}</button>
        </div>`;
}

/**
 * The section's HTML (settings.js shows it).
 * @param {typeof import('./settings/controls.js').group} group
 * @param {typeof import('./settings/controls.js').row} row
 */
export function sshSectionHtml(group, row) {
  const conns = connections();
  const fwds = forwards();
  const toggle = /** @param {string} key */ key => `<button class="switch" role="switch" data-setting="${key}" aria-label="${key}"><span></span></button>`;
  return group('Dropped connections', row('Reconnect when the connection drops', 'When ssh ends because the network went away or the PC slept, the terminal reconnects by itself (3 s, then longer, at once when the network is back), returns to the folder it was in and runs the host’s “After reconnecting” command (its menu), e.g. <code>tmux attach</code>.',
      toggle('ssh.reconnect'), { keywords: 'ssh reconnect drop network sleep resume tmux' })
    + row('Keepalives', 'Termilly’s SSH terminals check the connection every 15 seconds, so a dead one is noticed in under a minute instead of hanging.', toggle('ssh.keepAlive'), { keywords: 'ssh keepalive ServerAliveInterval timeout' }))
    + group('Your connections', `
      ${conns.map(c => `
        <div class="ssh-row" data-conn="${escapeHtml(c.id)}">
          <span class="badge small" data-icon="ssh">@</span>
          <span class="ssh-main"><span class="ssh-name">${escapeHtml(c.name)}</span><span class="ssh-sub">${escapeHtml(describe(c))} · ${escapeHtml(signIn(c))}</span></span>
          <button class="btn small" data-ssh="${SSH_ACTION.edit}">Edit</button>
          <button class="btn small" data-ssh="${SSH_ACTION.remove}" title="Remove">${ICONS.trash}</button>
        </div>`).join('')}
      <button class="btn small" data-ssh="${SSH_ACTION.add}">${ICONS.plus}<span>Add connection</span></button>
      <p class="set-desc">Opens from the + menu like any shell. Jump hosts go through each in turn (ssh -J). Sign-in is a reference:
        ssh-agent, a key file, a FIDO2 key, or a password ${sys.credentials} or 1Password keeps. Termilly never stores a password.</p>`)
    + group('Port forwards', `
      ${fwds.map(forwardRowHtml).join('')}
      <button class="btn small" data-ssh="${SSH_ACTION.addForward}"${sshTargets().length ? '' : ' disabled'}>${ICONS.plus}<span>Add forward</span></button>
      <p class="set-desc">Each forward is a hidden <code>ssh -N</code> listening on this PC only (127.0.0.1). It needs a key or saved password: there's nowhere to type one.</p>`)
    + group('Import', row('From other SSH apps', 'Finds sessions saved by PuTTY, MobaXterm, SecureCRT and mRemoteNG. Host, user, port and key file come across, never passwords.',
      `<button class="btn small" data-ssh="${SSH_ACTION.import}">Find sessions</button>`));
}

/** The settings group this section saves: SSH connections and port forwards. */
const GROUP = GROUPS.ssh;

/** @param {Record<string, any>} patch */
function save(patch) {
  updateSettings(GROUP, patch);
  rerender();
}

// ---- Dialogs ----

/** The highest TCP port. */
export const MAX_PORT = 65535;
/**
 * Whether `n` is a TCP port: a whole number from 1 to 65535 (a missing one, null, isn't).
 * @param {number | null} n
 */
export const isPort = n => Number.isInteger(n) && /** @type {number} */ (n) > 0 && /** @type {number} */ (n) <= MAX_PORT;
/** Host names, users and jump hosts go to ssh's command line, so they keep to these characters. */
const SAFE_HOST = /^[A-Za-z0-9._@:\-[\],%]+$/;
/** A saved password goes to the host once the settings with its connection are saved (300 ms after a change). */
const PASSWORD_AFTER_SAVE_MS = 900;

/**
 * The connection dialog's markup.
 * @param {SshConnection} c
 * @param {boolean} editing
 */
function connectionHtml(c, editing) {
  /**
   * @param {string} name
   * @param {string} label
   * @param {string | number | null | undefined} value
   * @param {string} [attrs]
   */
  const field = (name, label, value, attrs = '') =>
    `<label class="dialog-field">${label}<input class="field" name="${name}" value="${escapeHtml(value ?? '')}" ${attrs}></label>`;
  return `
    <h3>${editing ? 'Edit connection' : 'New SSH connection'}</h3>
    <div class="dialog-grid">
      ${field(FIELD.name, 'Name', c.name, 'autofocus placeholder="api-prod"')}
      ${field(FIELD.host, 'Host', c.host, 'placeholder="10.0.0.5 or api.example.com"')}
      ${field(FIELD.user, 'User', c.user, 'placeholder="(ssh decides)"')}
      ${field(FIELD.port, 'Port', c.port, `placeholder="${SSH_PORT}" inputmode="numeric"`)}
      ${field(FIELD.jump, 'Jump hosts', c.jump, 'placeholder="bastion or user@jump1,jump2"')}
      ${field(FIELD.tags, 'Tags', (c.tags ?? []).join(' '), 'placeholder="prod db"')}
    </div>
    <label class="dialog-field">Sign in with<select class="field" name="identity">${IDENTITIES.map(([v, l]) => `<option value="${v}"${v === c.identity ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <div data-show="${IDENTITY.key} ${IDENTITY.securityKey}">${field(FIELD.keyPath, 'Key file', c.keyPath, `placeholder="${escapeHtml(sys.keyExample)}"`)}</div>
    <div data-show="${IDENTITY.onePassword}">${field(FIELD.secretRef, '1Password reference', c.secretRef, 'placeholder="op://Private/api-prod/password"')}</div>
    <div data-show="${IDENTITY.password}" class="dialog-field">Password
      <div class="row-inline"><input class="field" type="password" name="password" autocomplete="off" placeholder="${credentialsSaved[c.id] ? 'Saved - type to replace' : `Kept by ${sys.credentials}`}">
      ${credentialsSaved[c.id] ? '<button class="btn small" data-forget>Forget saved</button>' : ''}</div></div>
    <p class="dialog-error" hidden></p>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div>`;
}

/**
 * What's wrong with a connection as entered, or null.
 * @param {SshConnection} value
 */
function connectionError(value) {
  const unsafe = [value.host, value.user, value.jump].some(v => v && !SAFE_HOST.test(v));
  if (!value.name || !value.host) return 'A name and a host are needed.';
  if (unsafe) return 'Host, user and jump hosts can’t have spaces or quotes.';
  if (value.port !== null && !isPort(value.port)) return `The port is a number from 1 to ${MAX_PORT}.`;
  if (value.identity === IDENTITY.onePassword && value.secretRef && !value.secretRef.startsWith('op://')) return 'A 1Password reference looks like op://vault/item/field.';
  return null;
}

/** @param {SshConnection | null | undefined} existing */
function connectionDialog(existing) {
  // A new one has no user, port and the rest yet: the dialog shows them empty.
  const c = existing ?? /** @type {SshConnection} */ ({ id: newId('c'), name: '', host: '', identity: IDENTITY.agent });
  return modal(CONNECTION_DIALOG, connectionHtml(c, !!existing), (dialog, /** @type {(result: ConnectionResult | null) => void} */ close) => {
    const get = /** @param {string} name */ name => field(dialog, `[name=${name}]`).value.trim();
    const identity = /** @type {HTMLSelectElement} */ (dialog.querySelector('[name=identity]'));
    const showFor = () => {
      for (const el of /** @type {NodeListOf<HTMLElement>} */ (dialog.querySelectorAll('[data-show]'))) {
        el.hidden = !(/** @type {string} */ (el.dataset.show)).split(' ').includes(identity.value);
      }
    };
    identity.addEventListener('change', showFor);
    showFor();
    dialog.querySelector('[data-forget]')?.addEventListener('click', e => {
      e.preventDefault();
      send(PAGE.sshPasswordForget, { connection: c.id });
      targetOf(e).remove();
    });
    const error = find(dialog, DIALOG_ERROR);
    const submit = () => {
      /** @type {SshConnection} */
      const value = {
        id: c.id, name: get(FIELD.name), host: get(FIELD.host), user: get(FIELD.user) || null,
        port: get(FIELD.port) ? Number(get(FIELD.port)) : null, jump: get(FIELD.jump) || null, identity: identity.value,
        keyPath: get(FIELD.keyPath) || null, secretRef: get(FIELD.secretRef) || null, tags: get(FIELD.tags).split(/\s+/).filter(Boolean),
      };
      const problem = connectionError(value);
      if (problem) {
        showError(error, problem);
        return;
      }
      const password = field(dialog, '[name=password]').value;
      close({ value, password: value.identity === IDENTITY.password ? password : '' });
    };
    return { submit };
  }).then(result => {
    if (!result) return;
    const list = connections().filter(x => x.id !== result.value.id);
    save({ connections: [...list, result.value] });
    // The password goes straight to the system's credential store; the page doesn't keep it.
    if (result.password) setTimeout(() => send(PAGE.sshPassword, { connection: result.value.id, user: result.value.user, password: result.password }), PASSWORD_AFTER_SAVE_MS);
  });
}

/**
 * The forward dialog's markup.
 * @param {PortForward} f
 * @param {boolean} editing
 */
function forwardHtml(f, editing) {
  return `
    <h3>${editing ? 'Edit forward' : 'New port forward'}</h3>
    <label class="dialog-field">Name<input class="field" name="name" value="${escapeHtml(f.name)}" placeholder="database" autofocus></label>
    <label class="dialog-field">Through<select class="field" name="target">${sshTargets().map(p => `<option value="${escapeHtml(p.id)}"${p.id === f.target ? ' selected' : ''}>${escapeHtml(p.name)} - ${escapeHtml(p.description)}</option>`).join('')}</select></label>
    <label class="dialog-field">Kind<select class="field" name="kind">
      <option value="${FORWARD_KIND.local}"${f.kind === FORWARD_KIND.local ? ' selected' : ''}>Local: a port here reaches a host there (-L)</option>
      <option value="${FORWARD_KIND.remote}"${f.kind === FORWARD_KIND.remote ? ' selected' : ''}>Remote: a port there reaches a host here (-R)</option>
      <option value="${FORWARD_KIND.socks}"${f.kind === FORWARD_KIND.socks ? ' selected' : ''}>SOCKS proxy here (-D)</option></select></label>
    <div class="dialog-grid">
      <label class="dialog-field">Listen port<input class="field" name="listenPort" value="${f.listenPort}" inputmode="numeric"></label>
      <label class="dialog-field" data-dest>Destination host<input class="field" name="destHost" value="${escapeHtml(f.destHost ?? DEFAULT_DEST_HOST)}"></label>
      <label class="dialog-field" data-dest>Destination port<input class="field" name="destPort" value="${f.destPort ?? ''}" inputmode="numeric" placeholder="5432"></label>
    </div>
    <label class="paste-never"><input type="checkbox" name="autoStart"${f.autoStart ? ' checked' : ''}> Start when Termilly starts</label>
    <p class="dialog-error" hidden></p>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div>`;
}

/** @param {PortForward | null | undefined} existing */
function forwardDialog(existing) {
  /** @type {PortForward} */
  const f = existing ?? { id: newId('f'), name: '', target: /** @type {string} */ (sshTargets()[0]?.id), kind: FORWARD_KIND.local, listenPort: DEFAULT_LISTEN_PORT, destHost: DEFAULT_DEST_HOST, destPort: null, autoStart: false };
  return modal('ssh-fwd', forwardHtml(f, !!existing), (dialog, /** @type {(result: PortForward | null) => void} */ close) => {
    const kind = /** @type {HTMLSelectElement} */ (dialog.querySelector('[name=kind]'));
    const showDest = () => {
      for (const el of /** @type {NodeListOf<HTMLElement>} */ (dialog.querySelectorAll('[data-dest]'))) el.hidden = kind.value === FORWARD_KIND.socks;
    };
    kind.addEventListener('change', showDest);
    showDest();
    const submit = () => {
      const get = /** @param {string} name */ name => field(dialog, `[name=${name}]`).value.trim();
      /** @type {PortForward} */
      const value = {
        id: f.id, name: get(FORWARD_FIELD.name), target: get(FORWARD_FIELD.target), kind: kind.value,
        listenPort: Number(get(FORWARD_FIELD.listenPort)), destHost: get(FORWARD_FIELD.destHost) || DEFAULT_DEST_HOST,
        destPort: get(FORWARD_FIELD.destPort) ? Number(get(FORWARD_FIELD.destPort)) : null,
        autoStart: field(dialog, '[name=autoStart]').checked,
      };
      if (!isPort(value.listenPort) || (value.kind !== FORWARD_KIND.socks && !isPort(value.destPort))) {
        const error = find(dialog, DIALOG_ERROR);
        showError(error, 'Ports are numbers from 1 to 65535.');
        return;
      }
      close(value);
    };
    return { submit };
  }).then(value => {
    if (!value) return;
    save({ forwards: [...forwards().filter(x => x.id !== value.id), value] });
  });
}

// ---- Import ----

onHost(HOST.sshImported, m => {
  /** @type {ImportedHost[]} */
  const hosts = m.hosts ?? [];
  const known = new Set(connections().map(c => `${c.user ?? ''}@${c.host}:${c.port ?? SSH_PORT}`.toLowerCase()));
  modal('ssh-import', `
    <h3>${hosts.length ? `Import ${hosts.length} session${hosts.length === 1 ? '' : 's'}` : 'No sessions found'}</h3>
    <p class="dialog-sub">${hosts.length ? 'Pick the ones to add as connections. Passwords stay behind; add a key or saved password afterwards.' : `No PuTTY, MobaXterm, SecureCRT or mRemoteNG SSH sessions were found for this ${sys.name} user.`}</p>
    ${(m.notes ?? []).map(n => `<p class="set-desc">${escapeHtml(n)}</p>`).join('')}
    <div class="import-list">${hosts.map((h, i) => {
      const dupe = known.has(`${h.user ?? ''}@${h.host}:${h.port ?? SSH_PORT}`.toLowerCase());
      return `<label class="import-item"><input type="checkbox" data-i="${i}"${dupe ? '' : ' checked'}>
        <span><b>${escapeHtml(h.name)}</b> <span class="ssh-sub">${escapeHtml(`${h.user ? `${h.user}@` : ''}${h.host}${h.port ? `:${h.port}` : ''}`)} · ${escapeHtml(h.source)}${dupe ? ' · already added' : ''}</span></span></label>`;
    }).join('')}</div>
    <div class="dialog-actions"><button class="btn" data-cancel>${hosts.length ? 'Cancel' : 'Close'}</button>${hosts.length ? '<button class="btn primary" data-ok>Import</button>' : ''}</div>`, (dialog, /** @type {(chosen: ImportedHost[] | null) => void} */ close) => {
    const submit = () => close([.../** @type {NodeListOf<HTMLElement>} */ (dialog.querySelectorAll('[data-i]:checked'))].map(b => hosts[Number(b.dataset.i)]));
    return { submit };
  }).then(chosen => {
    if (!chosen?.length) return;
    const added = chosen.map(h => ({
      id: newId('c'), name: h.name, host: h.host, user: h.user ?? null, port: h.port ?? null,
      identity: h.keyPath ? IDENTITY.key : IDENTITY.agent, keyPath: h.keyPath ?? null, tags: [],
    }));
    save({ connections: [...connections(), ...added] });
  });
});

// ---- Clicks in the section ----

/** @param {Event} e */
export function handleSshClick(e) {
  const button = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-ssh]'));
  if (!button) return false;
  const conn = connections().find(c => c.id === /** @type {HTMLElement | null} */ (button.closest('[data-conn]'))?.dataset.conn);
  // A forward's own buttons are in its row, so they always find it.
  const fwd = /** @type {PortForward} */ (
    forwards().find(f => f.id === /** @type {HTMLElement | null} */ (button.closest('[data-forward]'))?.dataset.forward));
  switch (button.dataset.ssh) {
    case SSH_ACTION.add: connectionDialog(null); break;
    case SSH_ACTION.edit: connectionDialog(conn); break;
    case SSH_ACTION.remove:
      if (conn?.identity === IDENTITY.password) send(PAGE.sshPasswordForget, { connection: conn.id });
      save({ connections: connections().filter(c => c !== conn) });
      break;
    case SSH_ACTION.addForward: forwardDialog(null); break;
    case SSH_ACTION.editForward: forwardDialog(fwd); break;
    case SSH_ACTION.removeForward:
      send(PAGE.forwardStop, { id: fwd.id });
      save({ forwards: forwards().filter(f => f !== fwd) });
      break;
    case SSH_ACTION.start: send(PAGE.forwardStart, { id: fwd.id }); break;
    case SSH_ACTION.stop: send(PAGE.forwardStop, { id: fwd.id }); break;
    case SSH_ACTION.import: send(PAGE.sshImport); break;
    default: return false;
  }
  return true;
}
