// @ts-check
// A paired phone manages terminals (Features/Phone.cs, op "manage"; only while Settings › Phone › Allow typing is on):
// it opens one on a shell or a remote place in a workspace, closes, renames or moves one, and adds an SSH host, which
// Settings keeps as on the PC's own dialog (ssh.js). The phone also gets the places to open (placesForPhone).

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, emit, persist, wsById, isRemoteProfile, newId, GROUPS, EVENTS } from './store.js';
import { newTab, closeTab, moveTab } from './panes.js';
import { connections, connectionError, IDENTITY } from './ssh.js';
import { updateSettings } from './preferences.js';
import { isProduction } from './environments.js';
import { PROFILE_ID_PREFIX } from './constants.js';
import { setNote, NOTE_KIND } from './notes.js';
import { clear } from './inbox.js';

/** What a phone may ask (the message's "action"). */
const ACTION = Object.freeze({ open: 'open', close: 'close', rename: 'rename', move: 'move', addHost: 'addHost', note: 'note', clearNote: 'clearNote' });
/** The longest a terminal's name and a folder typed on the phone may be. */
const MAX = Object.freeze({ name: 80, folder: 400 });
/** How a phone's SSH host may sign in: the ones that need nothing typed on the phone. */
const PHONE_IDENTITIES = [IDENTITY.agent, IDENTITY.key, IDENTITY.password];
/** Ahead of any time a place was used: pinned places come first. */
const PINNED_FIRST = Number.MAX_SAFE_INTEGER;

/**
 * The places a phone can open a terminal on, in the PC's order: its shells, then the remote ones (pinned, then
 * recently used, then by name, as the sidebar's Remote section has them).
 * @param {(icon: string) => string} badgeOf The badge's text for a profile's icon (js/phone.js).
 */
export function placesForPhone(badgeOf) {
  const pinned = new Set(state.settings.uiState.remotePinned ?? []);
  const recent = state.settings.uiState.remoteRecent ?? {};
  const rank = (/** @type {SessionProfile} */ p) => pinned.has(p.id) ? PINNED_FIRST : recent[p.id] ?? 0;
  const shells = state.profiles.filter(p => !isRemoteProfile(p));
  const remote = state.profiles.filter(isRemoteProfile).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  return [...shells, ...remote].map(p => ({
    id: p.id, name: p.name, description: p.description ?? '', icon: p.icon, badge: badgeOf(p.icon), source: p.source ?? '',
    remote: isRemoteProfile(p), production: isProduction(/** @type {Tab} */ ({ profile: p.id, tags: p.tags ?? [] })),
  }));
}

/**
 * @param {Record<string, any>} m
 * @returns {Tab}
 */
function terminalOf(m) {
  const tab = state.tabs.get(String(m.pane ?? ''));
  if (!tab || !tab.wsId) throw new Error('That terminal is gone.');
  return tab;
}

/**
 * Opens a terminal on a profile in a workspace (the PC's current one if the phone names none), in a folder if one
 * was typed; the phone opens it once it's listed.
 * @param {Record<string, any>} m
 */
function open(m) {
  const profile = state.profiles.find(p => p.id === m.profile);
  if (!profile) throw new Error('That shell or host isn\'t on the PC any more.');
  const ws = wsById(String(m.ws ?? '')) ?? wsById(state.activeId);
  if (!ws) throw new Error('That workspace is gone.');
  const cwd = typeof m.cwd === 'string' && m.cwd.trim() ? m.cwd.trim().slice(0, MAX.folder) : null;
  const tab = newTab({ profile: profile.id, wsId: ws.id, cwd });
  return { id: tab.id };
}

/** @param {Record<string, any>} m */
function rename(m) {
  const tab = terminalOf(m);
  const name = String(m.name ?? '').trim().slice(0, MAX.name);
  tab.name = name || null; // empty: back to the shell's own name
  persist();
  emit(EVENTS.tab, tab);
  return {};
}

/** @param {Record<string, any>} m */
function move(m) {
  const tab = terminalOf(m);
  if (!wsById(String(m.ws ?? ''))) throw new Error('That workspace is gone.');
  moveTab(tab, String(m.ws));
  return {};
}

/**
 * Adds an SSH host as the PC's own dialog would (Settings › SSH): a password is asked for on the PC, never sent from
 * the phone.
 * @param {Record<string, any>} m
 */
function addHost(m) {
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const port = text(m.port);
  /** @type {SshConnection} */
  const value = {
    id: newId('c'), name: text(m.name) ?? '', host: text(m.host) ?? '', user: text(m.user), port: port ? Number(port) : null,
    jump: text(m.jump), identity: PHONE_IDENTITIES.includes(m.identity) ? m.identity : IDENTITY.agent,
    keyPath: m.identity === IDENTITY.key ? text(m.keyPath) : null, secretRef: null, tags: String(m.tags ?? '').split(/\s+/).filter(Boolean),
  };
  const problem = connectionError(value);
  if (problem) throw new Error(problem);
  updateSettings(GROUPS.ssh, { connections: [...connections(), value] });
  return { profile: `${PROFILE_ID_PREFIX.connection}${value.id}` };
}

/**
 * A note written on the phone (its Notes tab): a workspace's or a terminal's, saved as the PC's own editor saves it
 * (empty removes it).
 * @param {Record<string, any>} m
 */
function note(m) {
  const target = m.kind === NOTE_KIND.workspace ? wsById(String(m.id)) : state.tabs.get(String(m.id));
  if (!target || (m.kind !== NOTE_KIND.workspace && m.kind !== NOTE_KIND.terminal)) throw new Error('That workspace or terminal is gone.');
  setNote(m.kind, target, String(m.text ?? '').trim(), !!m.pinned);
  return {};
}

/** @type {Record<string, (m: Record<string, any>) => object>} */
const DO = {
  [ACTION.open]: open,
  [ACTION.close]: m => { closeTab(terminalOf(m)); return {}; },
  [ACTION.rename]: rename,
  [ACTION.move]: move,
  [ACTION.addHost]: addHost,
  [ACTION.note]: note,
  // A notification cleared on the phone (its key), or all of them (no key), as the Notification center's ×.
  [ACTION.clearNote]: m => { clear(m.key ? String(m.key) : null); return {}; },
};

onHost(HOST.phoneManage, m => {
  const args = m.args ?? {};
  try {
    const action = DO[String(args.action ?? '')];
    if (!action) throw new Error('Not something a phone can ask.');
    send(PAGE.apiResult, { requestId: m.requestId, result: { action: args.action, ...action(args) } });
  } catch (e) {
    send(PAGE.apiResult, { requestId: m.requestId, error: /** @type {Error} */ (e).message });
  }
});
