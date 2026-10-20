// @ts-check
// Termilly on the other end of ssh, or inside WSL: the shell integration installed there (shell/remote,
// RemoteIntegration.cs) reports through the terminal what local shells and Claude Code's hooks report to Termilly
// directly, so SSH and WSL terminals show their repository, prompt marks and Claude the same way local ones do.
//   OSC 633;P;TermillyRemote=<version>   the integration runs in this shell
//   OSC 633;P;TermillyGit=<branch>|<changed>|<ahead>|<behind>|<upstream>|<root>   at each prompt ('' outside a repo)
//   OSC 633;P;TermillyReady              the install line is waiting for the installer
//   OSC 1337;TermillyHook=1;<event>;<base64 message>   a Claude Code hook
// An SSH or WSL terminal without it gets a bar offering to set the host or distribution up (the same script and
// installer), once per host or distribution unless set up or declined.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, emit, profileOf, GROUPS, EVENTS } from './store.js';
import { PROFILE_SOURCE } from './constants.js';
import { escapeHtml } from './ui.js';
import { updateSettings } from './preferences.js';
import { targetOf } from './dom.js';

/** A repository as a prompt reported it (parseGit). */
/**
 * @typedef {{ branch: string | null, detached: boolean, changed: number, ahead: number, behind: number,
 *   upstream: string | null, root: string, remote: boolean }} RemoteGit
 */
/** An install under way: when it was asked for, the installer once the host sent it, and the wait for the line. */
/** @typedef {{ requested: number, payload?: string, timer?: number }} RemoteInstall */
/** What a server's integration told a terminal (tab.remote; see remoteOf). */
/**
 * @typedef {{ integration: number | null, git: RemoteGit | null, gitReported: boolean, install: RemoteInstall | null,
 *   offer: number }} RemoteState
 */

/** The integration version this Termilly brings (Settings' about); older hosts are offered an update. */
let currentVersion = 0;
onHost(HOST.settings, m => { if (m.about?.remoteVersion) currentVersion = m.about.remoteVersion; });

/**
 * What a server's shell integration has told a terminal, kept here: its version (null until it reports), the
 * repository it last reported, whether it reported one since the last prompt, an install waiting for its line, and
 * the timer of the bar that offers to set the host up.
 * @param {Tab} tab
 * @returns {RemoteState}
 */
const remoteOf = tab => (tab.remote ??= { integration: null, git: null, gitReported: false, install: null, offer: 0 });

/** How long after connecting a shell has to report the integration before the setup bar offers it. */
const OFFER_AFTER_MS = 6000;
/** How long the install line has to say it's ready for the installer. */
const READY_WAIT_MS = 15_000;
/** The installer goes in pieces this big, this far apart, so no input buffer on the way overflows. */
const INSTALL_CHUNK = 2048;
const INSTALL_CHUNK_GAP_MS = 15;

/** The reports a server's integration sends (OSC 633;P;Termilly<report>). */
const REPORT = Object.freeze({ remote: 'Remote', git: 'Git', ready: 'Ready' });
/** What Settings remembers about a host (remote.setup): Termilly is on it, or the user declined it. */
const SETUP = Object.freeze({ installed: 'installed', never: 'never' });
/** What the bar offers: to set the host up, or to update what's on it. */
const BAR_KIND = Object.freeze({ setup: 'setup', update: 'update' });
/** What the bar's buttons do (data-rb). */
const BAR_ACTION = Object.freeze({ setup: 'setup', later: 'later', never: 'never' });
/** The bar over a terminal on a host without the integration: its class and its selector. */
const BAR_CLASS = 'remote-bar';
const BAR = `.${BAR_CLASS}`;
/** The branch a prompt reports when HEAD is detached. */
const DETACHED = '(detached)';

/**
 * The repository a server's integration reported for a terminal ({ branch, changed, ahead, behind, upstream, root }), or null.
 * @param {Tab | null | undefined} tab
 */
export const remoteGit = tab => tab?.remote?.git ?? null;

/**
 * Where Termilly can be set up, and what the bar and the menu call each: an SSH host, a WSL distribution. Containers
 * come and go, and a serial port has no shell of Termilly's to load.
 */
const SETUP_PLACES = Object.freeze({ [PROFILE_SOURCE.ssh]: 'host', [PROFILE_SOURCE.wsl]: 'distribution' });

/**
 * What a terminal's profile is set up as ('host', 'distribution'), or null where Termilly can't be set up.
 * @param {Tab} tab
 * @returns {string | null}
 */
const placeOf = tab => SETUP_PLACES[/** @type {keyof typeof SETUP_PLACES} */ (profileOf(tab)?.source ?? '')] ?? null;

/** @param {Tab} tab */
const setupOf = tab => state.settings.remote.setup?.[tab.profile] ?? null;

/**
 * @param {Tab} tab
 * @param {string | null} value
 */
function rememberSetup(tab, value) {
  if (!tab.profile || setupOf(tab) === value) return;
  const all = { ...(state.settings.remote.setup ?? {}) };
  if (value) all[tab.profile] = value; else delete all[tab.profile];
  updateSettings(GROUPS.remote, { setup: all });
}

/**
 * An OSC 633;P;Termilly… report (from terminals.js). True when it was one of these.
 * @param {Tab} tab
 * @param {string} data
 */
export function remoteReport(tab, data) {
  const m = /^P;Termilly(Remote|Git|Ready)(?:=(.*))?$/s.exec(data);
  if (!m) return false;
  const [, key, value = ''] = m;
  if (key === REPORT.remote) {
    const version = Number(value) || 1;
    remoteOf(tab).integration = version;
    hideBar(tab);
    if (placeOf(tab)) {
      rememberSetup(tab, SETUP.installed);
      if (currentVersion && version < currentVersion) showBar(tab, BAR_KIND.update);
    }
  } else if (key === REPORT.git) {
    remoteOf(tab).gitReported = true;
    setRemoteGit(tab, parseGit(value));
  } else if (key === REPORT.ready) {
    sendInstaller(tab);
  }
  return true;
}

/**
 * The repository state a prompt reported, in the shape GitStatus.cs gives (gitstatus.js draws both).
 * @param {string} value
 * @returns {RemoteGit | null}
 */
export function parseGit(value) {
  if (!value) return null;
  const [branch, changed, ahead, behind, upstream, ...root] = value.split('|');
  return {
    branch: branch === DETACHED ? null : branch,
    detached: branch === DETACHED,
    changed: Number(changed) || 0,
    ahead: Number(ahead) || 0,
    behind: Number(behind) || 0,
    upstream: upstream || null,
    root: root.join('|'),
    remote: true,
  };
}

/**
 * @param {Tab} tab
 * @param {RemoteGit | null} git
 */
function setRemoteGit(tab, git) {
  if (JSON.stringify(remoteOf(tab).git ?? null) === JSON.stringify(git)) return;
  remoteOf(tab).git = git;
  emit(EVENTS.workspaces);
}

/**
 * A prompt started (OSC 133;A). A remote shell reports its repository just before; a prompt without that report is
 * a shell without the integration (ssh ended, back in the local shell), so its repository no longer applies.
 * @param {Tab} tab
 */
export function remotePrompt(tab) {
  const remote = remoteOf(tab);
  if (!remote.gitReported && remote.git) setRemoteGit(tab, null);
  remote.gitReported = false;
}

/**
 * An OSC 1337;TermillyHook=… (from terminals.js): passed to the host as the local hook's events are.
 * @param {Tab} tab
 * @param {string} data
 */
export function remoteHook(tab, data) {
  const m = /^TermillyHook=1;([A-Za-z]{1,40});([A-Za-z0-9+/=]*)$/.exec(data);
  if (!m) return false;
  send(PAGE.remoteHook, { id: tab.id, event: m[1], payload: m[2] });
  return true;
}

// ---- Setting a host up ----

/**
 * After an SSH or WSL terminal starts: when its shell hasn't reported the integration, offer to set the host or
 * distribution up.
 * @param {Tab} tab
 */
export function watchRemote(tab) {
  const remote = remoteOf(tab);
  clearTimeout(remote.offer);
  remote.integration = null;
  if (remote.git) setRemoteGit(tab, null); // a new shell (a restart, a reconnect) reports its own
  if (!placeOf(tab) || tab.virtual || state.settings.shells.integration === false) return;
  remote.offer = setTimeout(() => {
    if (!state.tabs.has(tab.id) || tab.exited || remote.integration || setupOf(tab)) return;
    if (tab.view?.term?.buffer.active.type === 'alternate') return; // a full-screen program, not a prompt
    showBar(tab, BAR_KIND.setup);
  }, OFFER_AFTER_MS);
}

/**
 * Types the install line; the installer follows once the line says it's ready (TermillyReady).
 * @param {Tab} tab
 */
export function setUpHost(tab) {
  hideBar(tab);
  remoteOf(tab).install = { requested: Date.now() };
  send(PAGE.remoteInstall, { id: tab.id });
}

onHost(HOST.remoteInstall, (/** @type {{ id: string, command?: string, payload?: string, error?: string }} */ m) => {
  const tab = state.tabs.get(m.id);
  const remote = tab?.remote;
  const install = remote?.install;
  if (!remote || !install) return;
  if (m.error) {
    remote.install = null;
    /** @type {TabView} */ (tab.view).term.write(`\r\n\x1b[31m[Termilly couldn't read its shell integration: ${String(m.error).replace(/[\x00-\x1f]/g, '')}]\x1b[0m\r\n`);
    return;
  }
  install.payload = m.payload;
  send(PAGE.input, { id: tab.id, data: `${m.command}\r` });
  // The line never said it's ready (not a shell prompt, or not bash, zsh or sh): stop waiting.
  install.timer = setTimeout(() => { remote.install = null; }, READY_WAIT_MS);
});

/**
 * Sends the installer the install line is reading, in pieces so no input buffer on the way overflows.
 * @param {Tab} tab
 */
function sendInstaller(tab) {
  const install = remoteOf(tab).install;
  if (!install?.payload) return;
  clearTimeout(install.timer);
  remoteOf(tab).install = null;
  rememberSetup(tab, SETUP.installed); // this shell may have it already (a reinstall), so it won't report it again
  let at = 0;
  const next = () => {
    // The payload was checked above, and `install` keeps it.
    if (at >= /** @type {string} */ (install.payload).length || !state.tabs.has(tab.id)) return;
    send(PAGE.input, { id: tab.id, data: /** @type {string} */ (install.payload).slice(at, at + INSTALL_CHUNK) });
    at += INSTALL_CHUNK;
    setTimeout(next, INSTALL_CHUNK_GAP_MS);
  };
  next();
}

/**
 * "Remove Termilly from this host" (or distribution): types the line that runs its uninstall script.
 * @param {Tab} tab
 */
export function removeFromHost(tab) {
  hideBar(tab);
  rememberSetup(tab, SETUP.never);
  send(PAGE.remoteRemove, { id: tab.id });
}

onHost(HOST.remoteRemove, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  remoteOf(tab).integration = null;
  setRemoteGit(tab, null);
  send(PAGE.input, { id: tab.id, data: `${m.command}\r` });
});

/**
 * The terminal menu's entries for an SSH or WSL terminal.
 * @param {Tab} tab
 */
export function remoteMenuItems(tab) {
  const place = placeOf(tab);
  if (!place || tab.virtual) return [];
  return remoteOf(tab).integration
    ? [{ label: `Remove Termilly from this ${place}`, action: () => removeFromHost(tab) }]
    : [{ label: setUpLabel(place), action: () => setUpHost(tab) }];
}

/** @param {string} place */
const setUpLabel = place => `Set up Termilly on this ${place}`;

// ---- The bar ----

/**
 * @param {Tab} tab
 * @param {'setup' | 'update'} kind
 */
function showBar(tab, kind) {
  const pane = tab.view?.el;
  if (!pane) return;
  hideBar(tab);
  const place = placeOf(tab) ?? SETUP_PLACES[PROFILE_SOURCE.ssh];
  const name = escapeHtml(profileOf(tab)?.name ?? `this ${place}`);
  const bar = document.createElement('div');
  bar.className = BAR_CLASS;
  bar.innerHTML = kind === BAR_KIND.update
    ? `<span class="rb-text">Termilly on ${name} is out of date.</span>
       <button class="btn small primary" data-rb="${BAR_ACTION.setup}">Update</button><button class="btn small" data-rb="${BAR_ACTION.later}">Not now</button>`
    : `<span class="rb-text">Show git, prompt marks and Claude for ${name} as for local terminals.</span>
       <button class="btn small primary" data-rb="${BAR_ACTION.setup}">${setUpLabel(place)}</button>
       <button class="btn small" data-rb="${BAR_ACTION.later}">Not now</button><button class="btn small" data-rb="${BAR_ACTION.never}">Never for this ${place}</button>`;
  bar.addEventListener('click', e => {
    const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-rb]'))?.dataset.rb;
    if (action === BAR_ACTION.setup) setUpHost(tab);
    if (action === BAR_ACTION.later) hideBar(tab);
    if (action === BAR_ACTION.never) { rememberSetup(tab, SETUP.never); hideBar(tab); }
  });
  pane.append(bar);
}

/** @param {Tab} tab */
function hideBar(tab) {
  tab.view?.el?.querySelector(BAR)?.remove();
}
