// @ts-check
// A paired phone or computer manages things here (Features/Phone.cs, op "manage"; what Settings › Remote allows): it
// opens a terminal on a shell or a remote place in a workspace, opens or closes workspaces, closes, renames or moves a
// terminal, and adds an SSH host, which Settings keeps as on the PC's own dialog (ssh.js). What's opened or closed from
// elsewhere says so here: a note that stays, and in Recently closed. It also gets the places to open (placesForPhone).

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, emit, persist, wsById, tabsOf, tabTitle, isRemoteProfile, newId, GROUPS, EVENTS } from './store.js';
import { newTab, closeTab, moveTab } from './panes.js';
import { connections, connectionError, IDENTITY } from './ssh.js';
import { updateSettings } from './preferences.js';
import { isProduction } from './environments.js';
import { PROFILE_ID_PREFIX } from './constants.js';
import { setNote, NOTE_KIND } from './notes.js';
import { clear } from './inbox.js';
import { createWorkspace, closeWorkspace, START_WITH } from './workspaces.js';
import { showToast } from './toasts.js';
import { TODO_DO } from './phonetodo.js';

/** What a phone may ask (the message's "action"). */
const ACTION = Object.freeze({ open: 'open', close: 'close', newWorkspace: 'newWorkspace', closeWorkspace: 'closeWorkspace', rename: 'rename', move: 'move', addHost: 'addHost', note: 'note', clearNote: 'clearNote' });
/** The longest a terminal's name and a folder typed on the phone may be. */
const MAX = Object.freeze({ name: 80, folder: 400 });
/** Who asked (Features/Phone.cs adds it), for one that doesn't say. */
const SOMEONE = 'Another device';
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
  tab.openedBy = whoAsked(m);
  emit(EVENTS.tab, tab);
  leaveTrace(`${whoAsked(m)} opened a terminal in ${ws.name}`);
  return { id: tab.id };
}

/** @param {Record<string, any>} m */
const whoAsked = m => (typeof m.by === 'string' && m.by ? m.by : SOMEONE);

/**
 * What was done from elsewhere, with when: it stays until it's closed, so it's seen on coming back.
 * @param {string} what
 */
function leaveTrace(what) {
  const when = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  showToast({ text: `${what}, ${when}`, stay: true });
}

/** @param {Record<string, any>} m */
function closeTerminal(m) {
  const tab = terminalOf(m);
  const ws = wsById(tab.wsId);
  tab.closedBy = whoAsked(m);
  leaveTrace(`${whoAsked(m)} closed ${tabTitle(tab)} in ${ws?.name ?? ''}`);
  closeTab(tab);
  return {};
}

/**
 * A new workspace with a terminal in it. The PC stays on the workspace it's on.
 * @param {Record<string, any>} m
 */
function openWorkspace(m) {
  const ws = createWorkspace({ name: String(m.name ?? '').trim().slice(0, MAX.name), stay: true, startWith: START_WITH.tab });
  leaveTrace(`${whoAsked(m)} opened the workspace ${ws.name}`);
  return { id: ws.id };
}

/** @param {Record<string, any>} m */
function shutWorkspace(m) {
  const ws = wsById(String(m.ws ?? ''));
  if (!ws) throw new Error('That workspace is gone.');
  for (const tab of tabsOf(ws)) tab.closedBy = whoAsked(m);
  leaveTrace(`${whoAsked(m)} closed the workspace ${ws.name}`);
  closeWorkspace(ws);
  return {};
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

/** @type {Record<string, (m: Record<string, any>) => object | Promise<object>>} */
const DO = {
  ...TODO_DO,
  [ACTION.open]: open,
  [ACTION.close]: closeTerminal,
  [ACTION.newWorkspace]: openWorkspace,
  [ACTION.closeWorkspace]: shutWorkspace,
  [ACTION.rename]: rename,
  [ACTION.move]: move,
  [ACTION.addHost]: addHost,
  [ACTION.note]: note,
  // A notification cleared on the phone (its key), or all of them (no key), as the Notification center's ×.
  [ACTION.clearNote]: m => { clear(m.key ? String(m.key) : null); return {}; },
};

onHost(HOST.phoneManage, async m => {
  const args = m.args ?? {};
  try {
    const action = DO[String(args.action ?? '')];
    if (!action) throw new Error('Not something a phone can ask.');
    send(PAGE.apiResult, { requestId: m.requestId, result: { action: args.action, ...await action(args) } });
  } catch (e) {
    send(PAGE.apiResult, { requestId: m.requestId, error: /** @type {Error} */ (e).message });
  }
});
