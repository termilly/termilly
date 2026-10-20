// @ts-check
// Project status in the sidebar: on each terminal's row the git branch it works on, a dot when it has uncommitted
// changes and ↑N/↓N against its upstream (GitStatus.cs, or reported by a server's shell over ssh), and the ports its
// processes listen on (:3000), which open in the browser. Looked up only for workspaces open in the sidebar, at most
// every few seconds, and refreshed when a command ends, the window gets focus or the workspace changes; never in a
// loop while Termilly is in the background.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, tabsOf, profileOf, activityChanged, emit, isRemote, EVENTS } from './store.js';
import { debounce, SECOND_MS } from './util.js';
import { escapeHtml } from './ui.js';
import { remoteGit } from './remotehost.js';

/**
 * A repository's state, as GitStatus.cs (or a server's shell, remotehost.js) reports it.
 * @typedef {{ root: string, branch?: string | null, detached?: boolean, upstream?: string | null, ahead?: number,
 *   behind?: number, changed?: number, lastCommit?: string | null, remote?: boolean }} RepoState
 */

/**
 * Repository states by folder (as asked), and the ports each terminal listens on.
 * @type {Map<string, RepoState | null>}
 */
const byFolder = new Map();
/** @type {Map<string, number[]>} */
const portsByTab = new Map();

const gitOn = () => state.settings.interface.gitStatus !== false;
const portsOn = () => state.settings.terminal.ports !== false;

/**
 * A folder git is looked at for: not on a network share (slow) and not an SSH terminal's remote path.
 * @param {string | null | undefined} folder
 * @returns {folder is string}
 */
const lookable = folder => !!folder && !/^\\\\/.test(folder) && !/^\/\/[^/]/.test(folder);

/** The folders of the terminals shown in the sidebar (open workspaces), except those on a server. */
function folders() {
  const list = [];
  for (const ws of state.workspaces) {
    if (lookable(ws.cwd)) list.push(ws.cwd); // for the workspace menu's Git
    if (ws.collapsed) continue;
    for (const tab of tabsOf(ws)) {
      const folder = folderOf(tab, ws);
      if (!isRemote(tab) && !remoteGit(tab) && lookable(folder)) list.push(folder);
    }
  }
  return [...new Set(list)];
}

/** How long asks for git status and ports gather before one goes to the host. */
const GIT_DELAY = 300;
const PORTS_DELAY = 500;
/** How often git and the ports are looked at again while Termilly is in front. */
const REFRESH_EVERY_MS = 15 * SECOND_MS;
/** How long after a command starts its ports are looked at: a server takes a moment to listen. */
const PORTS_AFTER_START_MS = 4 * SECOND_MS;
/** How long after the workspaces change before their change asks for git again (they change in bursts). */
const WORKSPACES_QUIET_MS = 2 * SECOND_MS;
/** How long after the page starts the first look is. */
const FIRST_LOOK_MS = 2 * SECOND_MS;

const askGit = debounce(force => {
  const list = folders();
  if (list.length) send(PAGE.gitStatus, { folders: list, force });
}, GIT_DELAY);
/** Asks the host for the visible folders' repositories (soon, once, however many things ask). */
export function refreshGit(force = false) {
  if (gitOn()) askGit(force);
}

const askPorts = debounce(() => send(PAGE.portsTerminals), PORTS_DELAY);
export function refreshPorts() {
  if (portsOn()) askPorts();
}

onHost(HOST.gitStatus, m => {
  let changed = false;
  for (const { folder, state: s } of m.states ?? []) {
    const before = JSON.stringify(byFolder.get(folder) ?? null);
    byFolder.set(folder, s ?? null);
    changed ||= before !== JSON.stringify(s ?? null);
  }
  if (changed) emit(EVENTS.workspaces);
});

onHost(HOST.portsTerminals, m => {
  // Each terminal's ports: a list, though protocol.js's type says one number.
  const next = /** @type {Record<string, number[]>} */ (/** @type {unknown} */ (m.ports ?? {}));
  let changed = false;
  for (const tab of state.tabs.values()) {
    const ports = (next[tab.id] ?? []).join(',');
    if ((portsByTab.get(tab.id) ?? []).join(',') !== ports) {
      portsByTab.set(tab.id, next[tab.id] ?? []);
      changed = true;
      activityChanged(tab, true);
    }
  }
  if (changed) emit(EVENTS.workspaces);
});

// When to look again: a command ended (a commit, a checkout, a server stopped), the window came back, the
// workspace changed; and every 15 s while Termilly is in front.
on(EVENTS.commandEnding, () => { refreshGit(true); refreshPorts(); });
on(EVENTS.gitChanged, () => refreshGit(true)); // the Git window changed a repository
on(EVENTS.commandStarted, () => setTimeout(refreshPorts, PORTS_AFTER_START_MS)); // a server takes a moment to listen
on(EVENTS.workspaces, () => { if (!refreshing) { refreshing = true; refreshGit(); setTimeout(() => { refreshing = false; }, WORKSPACES_QUIET_MS); } });
let refreshing = false;
addEventListener('focus', () => { refreshGit(); refreshPorts(); });
setInterval(() => { if (document.hasFocus()) { refreshGit(); refreshPorts(); } }, REFRESH_EVERY_MS);
setTimeout(() => { refreshGit(); refreshPorts(); }, FIRST_LOOK_MS);

// ---- Showing it ----

/** A detached HEAD's name on its chip. */
const DETACHED_LABEL = 'detached';
/** The class of a chip on a terminal's row (app.css), rather than on its workspace's. */
const TAB_CHIP = 'tab';

/** @param {string | null | undefined} folder */
const gitOf = folder => (lookable(folder) ? byFolder.get(folder) ?? null : null);

/** @param {RepoState} s */
function title(s) {
  return [
    s.detached ? 'Detached HEAD' : `Branch ${s.branch}`,
    s.upstream ? `tracking ${s.upstream}${s.ahead || s.behind ? ` (${s.ahead} ahead, ${s.behind} behind)` : ', up to date'}` : 'no upstream',
    s.changed ? `${s.changed} changed file${s.changed === 1 ? '' : 's'}` : 'nothing to commit',
    s.lastCommit ? `last commit ${s.lastCommit}` : '',
    s.root,
  ].filter(Boolean).join('\n');
}

/**
 * The branch chip for a repository state: "main •" with ↑↓. A click opens the Git window on it; for a repository on
 * a server (reported over ssh, remotehost.js), through that terminal's SSH host.
 * @param {RepoState} s
 * @param {string} [extraClass]
 * @param {Tab | null} [tab]
 */
function chip(s, extraClass = '', tab = null) {
  const name = s.detached ? DETACHED_LABEL : s.branch;
  const server = s.remote && tab ? ` data-git-remote="${escapeHtml(tab.id)}"` : '';
  return `<span class="git-chip ${extraClass}${s.changed ? ' dirty' : ''}" data-git-root="${escapeHtml(s.root)}"${server} role="button" title="${escapeHtml(`${title(s)}${s.remote ? `\nOn ${profileOf(/** @type {Tab} */ (tab))?.name ?? 'the server'}` : ''}\nClick to see the changes and history`)}">`
    + `<svg viewBox="0 0 16 16"><circle cx="5" cy="4" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="6" r="1.6"/><path d="M5 5.6v4.8M11 7.6c0 2-2.2 2.4-5 3"/></svg>`
    + `<span class="git-branch">${escapeHtml(name ?? '?')}</span>${s.changed ? '<i class="git-dirty"></i>' : ''}`
    + `${s.ahead ? `<span class="git-ab">↑${s.ahead}</span>` : ''}${s.behind ? `<span class="git-ab">↓${s.behind}</span>` : ''}</span>`;
}

/**
 * The folder a terminal works in, for its chip: where its shell is now, else where it started.
 * @param {Tab} tab
 * @param {Workspace} ws
 */
const folderOf = (tab, ws) => tab.cwd ?? tab.startCwd ?? ws.cwd;

/**
 * The repository a terminal is in: reported by its shell on a server (remotehost.js), else looked up here. A
 * terminal on another machine (WSL, SSH, a container) has none here: its folder isn't one of this PC's, and the
 * workspace's folder it would fall back to is a different place.
 * @param {Tab} tab
 * @param {Workspace} ws
 * @returns {RepoState | null}
 */
const tabGit = (tab, ws) => remoteGit(tab) ?? (isRemote(tab) ? null : gitOf(folderOf(tab, ws)));

/**
 * A terminal row's extras: its branch when its repository isn't its workspace's, and its ports.
 * @param {Tab} tab
 * @param {Workspace} ws
 */
export function tabProjectHtml(tab, ws) {
  let html = '';
  if (gitOn()) {
    // On every terminal in a repository, also when several share one.
    const s = tabGit(tab, ws);
    if (s) html += chip(s, TAB_CHIP, tab);
  }
  if (portsOn()) {
    for (const port of portsByTab.get(tab.id) ?? []) {
      html += `<span class="port-chip" data-port="${port}" title="Listening on port ${port}. Click to open http://localhost:${port}" role="button">:${port}</span>`;
    }
  }
  return html;
}

/**
 * The repository a folder is in, as last looked at (null when it isn't in one, or not looked at yet).
 * @param {string | null | undefined} folder
 */
export const repoOf = folder => gitOf(folder);

/**
 * A terminal's listening ports (for its menu).
 * @param {Tab} tab
 */
export const portsOf = tab => portsByTab.get(tab.id) ?? [];

/** @param {number | string} port */
export const openPort = port => send(PAGE.openUrl, { url: `http://localhost:${port}` });
