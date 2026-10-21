// @ts-check
// App state: workspaces, tabs, tags and their layouts, plus persistence and change events.
//
// A workspace owns a binary layout tree (or null when empty). A node is either
//   { kind: 'leaf', tabId }                             - one tab (one terminal)
//   { kind: 'split', dir: 'row'|'column', ratio, a, b } - two children side by side (row) or stacked (column)
//   { kind: 'tabs', items: [leaf, ...], active }        - two or more tabs in one place, one shown (active: its tabId)
// Trees hold only plain data so they serialize as-is; terminal views live on the tab (tab.view).

import { PAGE } from './protocol.js';
import { send, platform, PLATFORM } from './host.js';
import { PROFILE_SOURCE, AGENT_STATE, PROFILE_ICON, AGENT_SOURCE, CLAUDE_TOOL } from './constants.js';
import { debounce } from './util.js';
import { windowInFront } from './windowshown.js';

/** The kinds of node in a workspace's layout tree (see the top of this file). */
export const NODE = Object.freeze({ leaf: 'leaf', split: 'split', tabs: 'tabs', preview: 'preview' });

/** Which way a split goes: side by side (row) or one above the other (column). */
export const SPLIT = Object.freeze({ row: 'row', column: 'column' });

/** A split's ratio when its two sides are the same size. */
export const SPLIT_EVEN = 0.5;

export const TAG_COLORS = ['#ff7b72', '#f2cc60', '#7ee787', '#79c0ff', '#d2a8ff', '#76e3ea', '#8a8a8a'];
export const WORKSPACE_COLORS = ['#8b7bff', ...TAG_COLORS];
const SUGGESTED_TAGS = [['prod', '#ff7b72'], ['staging', '#f2cc60'], ['dev', '#7ee787']];

/** Short marks drawn in each shell profile's badge. */
export const BADGES = {
  [PROFILE_ICON.powerShell]: 'PS', [PROFILE_ICON.cmd]: 'C:\\', [PROFILE_ICON.bash]: '$_', [PROFILE_ICON.wsl]: '~$', [PROFILE_ICON.ssh]: '@',
  [PROFILE_ICON.custom]: '>_', [PROFILE_ICON.docker]: 'Dk', [PROFILE_ICON.kubernetes]: 'K8', [PROFILE_ICON.serial]: 'IO',
};

/** Where profiles come from, in menu order (the host lists them in this order too). */
export const PROFILE_SOURCES = [[PROFILE_SOURCE.local, 'Shells'], [PROFILE_SOURCE.wsl, 'WSL'], [PROFILE_SOURCE.custom, 'Your profiles'], [PROFILE_SOURCE.ssh, 'SSH hosts'],
  [PROFILE_SOURCE.docker, 'Containers'], [PROFILE_SOURCE.kubernetes, 'Kubernetes pods'], [PROFILE_SOURCE.serial, 'Serial & consoles']];

/**
 * Where a profile comes from: the host says, and the shells it found say nothing.
 * @param {SessionProfile | null | undefined} profile
 */
export const sourceOf = profile => profile?.source ?? PROFILE_SOURCE.local;

/** AppSettings' groups, as the host names them (Settings/AppSettings.cs; a Desktop test checks they match). */
export const GROUPS = Object.freeze({
  terminal: 'terminal',
  interface: 'interface',
  shells: 'shells',
  commands: 'commands',
  notifications: 'notifications',
  quake: 'quake',
  session: 'session',
  safety: 'safety',
  logging: 'logging',
  recording: 'recording',
  ssh: 'ssh',
  agents: 'agents',
  changes: 'changes',
  ai: 'ai',
  checkin: 'checkin',
  remote: 'remote',
  uiState: 'uiState',
  data: 'data',
});
export const SETTINGS_GROUPS = Object.values(GROUPS);

/**
 * A setting by its path: 'changes.source' (Settings' controls name them so).
 * @param {string} path
 * @returns {any}
 */
export const getSetting = path => {
  const [group, key] = path.split('.');
  return /** @type {Record<string, Record<string, unknown>>} */ (/** @type {unknown} */ (state.settings))[group]?.[key];
};

/**
 * The sidebar: open or closed (and what it shows then), its width, and whether its Remote section is folded.
 * @typedef {{ open: boolean, closedStyle: string, width?: number, remoteFolded?: boolean }} SidebarState
 */

/**
 * A theme plugin's terminal colours (plugins.js), based on Light or Dark.
 * @typedef {{ id: string, name: string, light?: boolean, colors: Record<string, string> }} PluginTheme
 */

export const state = {
  /** @type {Workspace[]} */
  workspaces: [],
  /** @type {Map<string, Tab>} */
  tabs: new Map(),
  /** @type {Tag[]} */
  tags: [],
  /** @type {string | null} */
  activeId: null,
  /** @type {SidebarState} */
  sidebar: { open: true, closedStyle: 'rail' },
  /**
   * The terminal colours of the theme plugins that are on (plugins.js).
   * @type {PluginTheme[]}
   */
  pluginThemes: [],
  /**
   * Folders recently used (workspace folders, where shells went), newest first; the "Go to" picker offers them.
   * @type {string[]}
   */
  recentDirs: [],
  /**
   * Profiles from the host; the first is the default.
   * @type {SessionProfile[]}
   */
  profiles: [],
  /**
   * AppSettings from the host, in its groups (terminal, interface, changes…): the host sends them, defaults included,
   * before the page boots, and checks and saves each group the page changes (settings.js).
   * @type {AppSettings}
   */
  settings: /** @type {AppSettings} */ (/** @type {unknown} */ (Object.fromEntries(SETTINGS_GROUPS.map(group => [group, {}])))),
};

let counter = 0;
/**
 * Ids stay unique across restarts: time-based, plus a counter for ids made in the same millisecond.
 * @param {string} prefix
 */
export const newId = prefix => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

// ---- Events ----

/** The page's events (on, emit): what changed, or what a module asks another to do. */
export const EVENTS = Object.freeze({
  agent: 'agent',
  changes: 'changes',
  claudeUsage: 'claudeUsage',
  commandEnding: 'commandEnding',
  commandStarted: 'commandStarted',
  dialogClosed: 'dialogClosed',
  focus: 'focus',
  gitChanged: 'gitChanged',
  history: 'history',
  openAllChanges: 'openAllChanges',
  openChangedFiles: 'openChangedFiles',
  openGit: 'openGit',
  openSettings: 'openSettings',
  openSnippets: 'openSnippets',
  opened: 'opened',
  planChanged: 'planChanged',
  plugins: 'plugins',
  previewDropped: 'previewDropped',
  previewShown: 'previewShown',
  remoteCwd: 'remoteCwd',
  profiles: 'profiles',
  results: 'results',
  scratchClosed: 'scratchClosed',
  seen: 'seen',
  settings: 'settings',
  showTab: 'showTab',
  sidebar: 'sidebar',
  snippets: 'snippets',
  tab: 'tab',
  tabClosed: 'tabClosed',
  tags: 'tags',
  terminalOpened: 'terminalOpened',
  workspaces: 'workspaces',
  workspaceClosed: 'workspaceClosed',
});

/** @type {Map<string, Array<(arg: any) => void>>} */
const listeners = new Map();

/**
 * Subscribes to one of EVENTS: what changed ('workspaces', 'tab', 'tags', 'sidebar'…), or what a module asks another
 * to do. The handler gets what the event carries.
 * @param {string} event
 * @param {(arg: any) => void} fn
 */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event)?.push(fn);
}

/**
 * @param {string} event
 * @param {any} [arg]
 */
export function emit(event, arg) {
  for (const fn of listeners.get(event) ?? []) fn(arg);
}

// ---- Lookups ----

/** @param {string | null | undefined} id */
export const wsById = id => state.workspaces.find(w => w.id === id);
export const activeWs = () => wsById(state.activeId);
/**
 * A terminal's profile (the first one when its own is gone).
 * @param {Tab} tab
 * @returns {SessionProfile | undefined}
 */
export const profileOf = tab => state.profiles.find(p => p.id === tab.profile) ?? state.profiles[0];
/**
 * A profile for an SSH host or connection.
 * @param {SessionProfile | null | undefined} profile
 */
export const isSshProfile = profile => profile?.source === PROFILE_SOURCE.ssh;
/**
 * A terminal on an SSH host: its shell, folders and files are the server's.
 * @param {Tab} tab
 */
export const isSsh = tab => isSshProfile(profileOf(tab));
/**
 * The profiles whose terminals' files aren't on this machine.
 * @type {readonly string[]}
 */
export const REMOTE_SOURCES = Object.freeze([PROFILE_SOURCE.ssh, PROFILE_SOURCE.wsl, PROFILE_SOURCE.docker,
  PROFILE_SOURCE.kubernetes, PROFILE_SOURCE.serial]);
/**
 * A profile for somewhere else: an SSH host, a WSL distribution, a container or a serial port.
 * @param {SessionProfile | null | undefined} profile
 */
export const isRemoteProfile = profile => REMOTE_SOURCES.includes(profile?.source ?? '');
/**
 * A terminal whose files aren't on this machine: SSH, WSL, containers, serial ports, or a shell in a folder of
 * another machine's.
 * @param {Tab} tab
 */
export function isRemote(tab) {
  if (isRemoteProfile(profileOf(tab)) || tab.remoteCwd != null) return true;
  // On Windows a folder like /home/me is on another machine (Git Bash's /c/Users/me is this one's C: drive); on
  // Linux it's this one's.
  return platform === PLATFORM.windows && /^\/(?![a-zA-Z](\/|$))/.test(tab.cwd ?? '');
}
/** The shell for new terminals: the one chosen in Settings, else the first detected. */
export const defaultProfile = () =>
  (state.profiles.some(p => p.id === state.settings.shells.defaultProfile) ? state.settings.shells.defaultProfile : state.profiles[0]?.id);

/** A tab's name when it has none of its own and its profile is gone. */
export const DEFAULT_TAB_TITLE = 'Terminal';

/**
 * The name shown for a tab: what the user named it, else its shell's name.
 * @param {Tab} tab
 */
export const tabTitle = tab => tab.name || profileOf(tab)?.name || DEFAULT_TAB_TITLE;

/**
 * What a terminal is doing, as the indicator next to its title shows it.
 * @typedef {{ kind: string, title: string, percent?: number }} Activity
 */

/** The kinds of activity (Activity.kind), as the indicator draws them. */
export const ACTIVITY = Object.freeze({
  needs: 'needs', error: 'error', paused: 'paused', done: 'done', percent: 'percent', spin: 'spin', hibernated: 'hibernated',
});

/** A full progress bar, in percent. */
const FULL_PERCENT = 100;

/** The progress states an app reports with OSC 9;4 (1 is a percentage, 2 an error, 4 paused). */
const PROGRESS = Object.freeze({ percent: 1, error: 2, paused: 4 });

/**
 * What an agent's state looks like next to a terminal's title (see agentActivity).
 * @type {Record<string, (agent: AgentInfo) => Activity>}
 */
const AGENT_ACTIVITY = {
  [AGENT_STATE.needsInput]: a => ({
    kind: ACTIVITY.needs,
    title: a.tool && a.tool !== CLAUDE_TOOL.askUserQuestion ? `Claude needs you: allow ${a.tool}?`
      : a.source === AGENT_SOURCE.poll && a.message ? `Claude needs you: ${a.message}` : 'Claude needs your input',
  }),
  [AGENT_STATE.attention]: a => ({ kind: ACTIVITY.needs, title: a.message ? `Wants your attention: ${a.message}` : 'Wants your attention' }),
  [AGENT_STATE.error]: a => ({ kind: ACTIVITY.error, percent: FULL_PERCENT, title: a.reason ? `Claude stopped with an error: ${a.reason}` : 'Claude stopped with an error' }),
  [AGENT_STATE.done]: () => ({ kind: ACTIVITY.done, title: 'Claude finished: your turn' }),
  [AGENT_STATE.working]: () => ({ kind: ACTIVITY.spin, title: 'Claude is working…' }),
};

/**
 * The agent's state from its hooks (tab.agent), when it has something to show.
 * @param {Tab} tab
 * @returns {Activity | null}
 */
function agentActivity(tab) {
  const show = tab.agent && AGENT_ACTIVITY[tab.agent.state];
  if (!show || !tab.agent) return null;
  // The spinner setting covers "working"; waiting for you, errors and "done" always show.
  if (tab.agent.state === AGENT_STATE.working && state.settings.interface.showActivity === false) return null;
  return show(tab.agent);
}

/**
 * What a terminal is doing, for the indicator next to its title. An agent's own report from its hooks wins; then
 * progress an app reported (OSC 9;4: Claude Code without hooks, winget, PowerShell progress bars); then the host's
 * "a command is running" (tab.busy, the program's name). Null when idle or when Settings turned the spinner off.
 * @param {Tab} tab
 * @returns {Activity | null}
 */
export function activityOf(tab) {
  if (tab.hibernated) return { kind: ACTIVITY.hibernated, title: 'Hibernated: Claude Code resumes this conversation when you open it' };
  const agent = agentActivity(tab);
  if (agent) return agent;
  if (state.settings.interface.showActivity === false) return null;
  const p = tab.progress;
  if (p) {
    const at = p.percent ? ` at ${p.percent}%` : '';
    if (p.state === PROGRESS.error) return { kind: ACTIVITY.error, percent: p.percent || FULL_PERCENT, title: `Reported an error${at}` };
    if (p.state === PROGRESS.paused) return { kind: ACTIVITY.paused, percent: p.percent || FULL_PERCENT, title: `Paused${at}` };
    if (p.state === PROGRESS.percent) return { kind: ACTIVITY.percent, percent: p.percent, title: `${p.percent}% done` };
    return { kind: ACTIVITY.spin, title: 'Working…' };
  }
  if (tab.busy) return { kind: ACTIVITY.spin, title: `Running ${tab.busy}` };
  return commandRunning(tab) ? { kind: ACTIVITY.spin, title: 'Running a command' } : null;
}

/** How long a command marked by shell integration runs before it gets a spinner (a quick `dir` shouldn't flash). */
export const COMMAND_DELAY = 500;

/**
 * A command the shell marked as running (OSC 133, see terminals.js) for a while, outside an interactive program
 * (ssh, a nested claude: they wait for the user) and outside full-screen apps (vim, less, htop).
 * @param {Tab} tab
 */
function commandRunning(tab) {
  const c = tab.command;
  return !!c && !tab.interactive && Date.now() - c.startedAt >= COMMAND_DELAY
    && tab.view?.term?.buffer.active.type !== 'alternate';
}

/** States that tell the user something happened; arriving out of sight, they stay unread until looked at. */
/** @type {Set<string>} */
const NEWS = new Set([AGENT_STATE.done, AGENT_STATE.error, AGENT_STATE.attention]);

/**
 * Whether the user can see a terminal now: its workspace is showing and the window is in front (the host's word,
 * js/windowshown.js, as well as the page's focus).
 * @param {Tab} tab
 */
export const isInView = tab => tab.wsId === state.activeId && windowInFront() && document.hasFocus();

/**
 * Whether Claude Code runs in this terminal now: its hooks or the `claude agents` poll reported it, and it hasn't
 * exited (an exit clears tab.agent). Output alerts set tab.agent too, with source "alert"; those don't count.
 * @param {Tab | null | undefined} tab
 */
export const runsClaude = tab => tab?.agent?.source === AGENT_SOURCE.hooks || tab?.agent?.source === AGENT_SOURCE.poll;

/**
 * Call after changing tab.agent: news that arrives out of sight is marked unread (bold in the sidebar, a badge on
 * the rail) until the terminal is focused. See markSeen.
 * @param {Tab} tab
 */
export function agentChanged(tab) {
  if (tab.agent) tab.agent.unread = NEWS.has(tab.agent.state) && !isInView(tab);
  // An agent has worked here: the changed-files list on the header stays, even after it exits (js/header.js).
  if (tab.agent) tab.agentSeen = true;
  activityChanged(tab, true);
  emit(EVENTS.agent, tab);
}

/**
 * The user focused the terminal: unread news is now seen, and "done" or "wants attention" has been dealt with.
 * @param {Tab} tab
 */
export function markSeen(tab) {
  emit(EVENTS.seen, tab);
  if (!tab.agent?.unread) return;
  tab.agent.unread = false;
  if (tab.agent.state === AGENT_STATE.done || tab.agent.state === AGENT_STATE.attention) tab.agent.state = AGENT_STATE.idle;
  activityChanged(tab, true);
}

/** @param {Tab} tab */
export const isUnread = tab => !!tab.agent?.unread;

let activityFrame = 0;
let sidebarDirty = false;
/** @type {Set<Tab>} */
const activityTabs = new Set();

/**
 * Redraws a terminal's activity on the next frame (many updates in a frame draw once). The sidebar only redraws
 * when a terminal starts or stops being active, not for every percent.
 * @param {Tab} tab
 * @param {boolean} [startedOrStopped]
 */
export function activityChanged(tab, startedOrStopped = false) {
  activityTabs.add(tab);
  sidebarDirty ||= startedOrStopped;
  if (activityFrame) return;
  activityFrame = requestAnimationFrame(() => {
    activityFrame = 0;
    for (const t of activityTabs) emit(EVENTS.tab, t);
    activityTabs.clear();
    if (sidebarDirty) {
      sidebarDirty = false;
      emit(EVENTS.workspaces);
    }
  });
}

/**
 * The order activity is shown in where only one fits (a workspace row): what needs the user comes first.
 * @type {string[]}
 */
const URGENCY = [ACTIVITY.needs, ACTIVITY.error, ACTIVITY.paused, ACTIVITY.done, ACTIVITY.percent, ACTIVITY.spin];

/**
 * The most urgent activity among some terminals, or null.
 * @param {Iterable<Tab>} tabs
 */
export function mostUrgentActivity(tabs) {
  /** @type {Activity | null} */
  let best = null;
  for (const tab of tabs) {
    const activity = activityOf(tab);
    if (activity && (!best || URGENCY.indexOf(activity.kind) < URGENCY.indexOf(best.kind))) best = activity;
  }
  return best;
}

/**
 * A workspace's tabs in layout order (left to right, top to bottom).
 * @param {Workspace} ws
 * @returns {Tab[]}
 */
export const tabsOf = ws => [...leaves(ws.root)].flatMap(leaf => state.tabs.get(leaf.tabId) ?? []);

/** @param {string} name */
export const tagColor = name => state.tags.find(t => t.name === name)?.color ?? '#8a8a8a';

/**
 * Adds a tag to the registry if it's new.
 * @param {string} name
 * @param {string} [color]
 */
export function ensureTag(name, color) {
  let tag = state.tags.find(t => t.name === name);
  if (!tag) {
    tag = { name, color: color ?? TAG_COLORS[state.tags.length % TAG_COLORS.length] };
    state.tags.push(tag);
    emit(EVENTS.tags);
  }
  return tag;
}

// ---- Tree helpers ----

// A tree's nodes: { kind: 'leaf', tabId }, { kind: 'split', dir, ratio, a, b }, { kind: 'tabs', items, active } (a
// group of leaves shown as tabs) and { kind: 'preview' }, the change preview's pane (js/preview.js). A preview isn't a tab, so leaves(), tabsOf() and everything built on them skip it,
// and it's never saved.

/**
 * The tabs' leaves in a tree, in layout order.
 * @param {LayoutNode | null | undefined} node
 * @returns {Generator<LeafNode>}
 */
export function* leaves(node) {
  if (!node) return;
  if (node.kind === NODE.leaf) {
    yield node;
  } else if (node.kind === NODE.split) {
    yield* leaves(node.a);
    yield* leaves(node.b);
  } else if (node.kind === NODE.tabs) {
    yield* node.items;
  }
}

/**
 * The tab group a tab is in, or null when it has a place of its own.
 * @param {Workspace} ws
 * @param {string} tabId
 * @param {LayoutNode | null} [node]
 * @returns {TabsNode | null}
 */
export function groupOf(ws, tabId, node = ws.root) {
  if (!node) return null;
  if (node.kind === NODE.tabs) return node.items.some(leaf => leaf.tabId === tabId) ? node : null;
  return node.kind === NODE.split ? groupOf(ws, tabId, node.a) ?? groupOf(ws, tabId, node.b) : null;
}

/**
 * The tab to focus in a node: a group's shown tab, else the first one.
 * @param {LayoutNode | null | undefined} node
 * @returns {string | null}
 */
export const firstTabOf = node => node?.kind === NODE.tabs ? node.active : leaves(node).next().value?.tabId ?? null;

/**
 * The change preview's node in a tree, or null.
 * @param {LayoutNode | null | undefined} node
 * @returns {PreviewNode | null}
 */
export function findPreview(node) {
  if (!node) return null;
  if (node.kind === NODE.preview) return node;
  return node.kind === NODE.split ? findPreview(node.a) ?? findPreview(node.b) : null;
}

/**
 * A copy of the tree without the change preview (its split collapses to the other side).
 * @param {LayoutNode | null | undefined} node
 * @returns {LayoutNode | null}
 */
export function withoutPreview(node) {
  if (!node || node.kind === NODE.preview) return null;
  if (node.kind !== NODE.split) return node;
  const a = withoutPreview(node.a);
  const b = withoutPreview(node.b);
  if (!a || !b) return a ?? b;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/**
 * The tree with one of its nodes replaced (in place below the top; the new top is returned).
 * @template {LayoutNode | null} T
 * @param {T} node
 * @param {LayoutNode} target
 * @param {LayoutNode} replacement
 * @returns {T | LayoutNode}
 */
export function replaceNode(node, target, replacement) {
  if (node === target) return replacement;
  if (node?.kind === NODE.split) {
    node.a = replaceNode(node.a, target, replacement);
    node.b = replaceNode(node.b, target, replacement);
  } else if (node?.kind === NODE.tabs) {
    node.items = node.items.map(item => /** @type {LeafNode} */ (replaceNode(item, target, replacement)));
  }
  return node;
}

/**
 * The split or tab group a node is directly in, or null.
 * @param {LayoutNode | null | undefined} node
 * @param {LayoutNode} target
 * @returns {SplitNode | TabsNode | null}
 */
export function findParent(node, target) {
  if (node?.kind === NODE.tabs) return node.items.includes(/** @type {LeafNode} */ (target)) ? node : null;
  if (!node || node.kind !== NODE.split) return null;
  if (node.a === target || node.b === target) return node;
  return findParent(node.a, target) || findParent(node.b, target);
}

/**
 * @param {Workspace} ws
 * @param {string} tabId
 */
export const findLeaf = (ws, tabId) => [...leaves(ws.root)].find(leaf => leaf.tabId === tabId);

/**
 * Takes a tab's leaf out of its workspace tree, collapsing the parent split. Returns the sibling that took its place
 * (null when the tree is now empty).
 * @param {Workspace} ws
 * @param {string} tabId
 * @returns {LayoutNode | null}
 */
export function detachLeaf(ws, tabId) {
  const leaf = findLeaf(ws, tabId);
  if (!leaf) return null;
  if (ws.root === leaf) {
    ws.root = null;
    return null;
  }
  const parent = findParent(ws.root, leaf);
  if (!parent) return null;
  if (parent.kind === NODE.tabs) {
    // Out of a tab group: its neighbour is shown instead, and a group of one is a plain pane again.
    const at = parent.items.indexOf(leaf);
    parent.items.splice(at, 1);
    if (parent.active === tabId) parent.active = parent.items[Math.min(at, parent.items.length - 1)].tabId;
    if (parent.items.length > 1) return parent;
    ws.root = replaceNode(ws.root, parent, parent.items[0]);
    return parent.items[0];
  }
  const sibling = parent.a === leaf ? parent.b : parent.a;
  ws.root = replaceNode(ws.root, parent, sibling);
  return sibling;
}

/**
 * Repairs tab groups read from a file: no empty or single groups, and a shown tab that is in the group.
 * @param {any} node
 * @returns {LayoutNode | null}
 */
function tidyGroups(node) {
  if (!node) return null;
  if (node.kind === NODE.split) {
    const a = tidyGroups(node.a), b = tidyGroups(node.b);
    return a && b ? { ...node, a, b } : a ?? b;
  }
  if (node.kind !== NODE.tabs) return node;
  /** @type {LeafNode[]} */
  const items = (Array.isArray(node.items) ? node.items : []).filter((/** @type {any} */ i) => i?.kind === NODE.leaf);
  if (items.length < 2) return items[0] ?? null;
  return { kind: NODE.tabs, items, active: items.some(i => i.tabId === node.active) ? node.active : items[0].tabId };
}

// ---- Recent folders ----

const MAX_RECENT_DIRS = 30;
/** Longest folder path remembered, in characters. */
const MAX_DIR_LENGTH = 400;

/**
 * Remembers a folder as just used (moves it to the front).
 * @param {string | null | undefined} path
 */
export function noteDir(path) {
  const dir = path?.trim().replace(/[/]+$/, '') || null;
  if (!dir || dir.length > MAX_DIR_LENGTH) return;
  const key = dir.toLowerCase();
  if (state.recentDirs[0]?.toLowerCase() === key) return;
  state.recentDirs = [dir, ...state.recentDirs.filter(d => d.toLowerCase() !== key)].slice(0, MAX_RECENT_DIRS);
  persist();
}

// ---- Persistence ----

/** How long after a change the workspaces are saved (changes in a burst save once). */
const SAVE_DELAY = 400;
const saveLater = debounce(() => saveNow(), SAVE_DELAY);

/** Saves workspaces, layouts and tab metadata shortly after a change. */
export const persist = () => saveLater();

export function saveNow() {
  saveLater.cancel();
  send(PAGE.stateSave, { state: serialize() });
}

function serialize() {
  return {
    version: 1,
    activeId: state.activeId,
    sidebar: state.sidebar,
    tags: state.tags,
    recentDirs: state.recentDirs,
    // tmux windows aren't saved: they're tmux's, and attaching again brings them back (tmux.js).
    workspaces: state.workspaces.filter(w => !w.tmux).map(({ id, name, color, cwd, focusId, root, note, snippets, collapsed }) => ({ id, name, color, cwd, focusId, root: withoutPreview(root), note, snippets, collapsed: collapsed || undefined })),
    tabs: [...state.tabs.values()].filter(t => !t.virtual).map(t => {
      const { id, wsId, profile, name, tags, noHistory, startCwd, env, startCommand, worktree, note, agentRead, agentType } = t;
      return { id, wsId, profile, name, tags, noHistory, startCwd, env, startCommand, worktree, note, agentRead, agentType, lastCwd: lastFolderOf(t) ?? undefined };
    }),
  };
}

/**
 * The folder a terminal's shell was last in, so it starts there again after a restart: on a server, the folder its
 * prompt or Termilly's integration there reported; here, the one its shell reported (OSC 7). Kept from the last
 * run until the shell reports one.
 * @param {Tab} tab
 * @returns {string | null}
 */
export function lastFolderOf(tab) {
  const server = isSsh(tab);
  const now = server ? tab.remoteCwd ?? (tab.cwd?.startsWith('/') ? tab.cwd : null) : tab.cwd;
  return now ?? tab.lastCwd ?? null;
}

/**
 * Restores saved state (workspaces.json, as serialize wrote it). Returns false when there was nothing usable, so the
 * caller creates a default.
 * @param {any} saved
 */
export function restore(saved) {
  if (!saved || saved.version !== 1) {
    state.tags = SUGGESTED_TAGS.map(([name, color]) => ({ name, color }));
    return false;
  }
  // Tags and sidebar settings survive even when every workspace was closed.
  state.tags = Array.isArray(saved.tags) ? saved.tags : [];
  state.sidebar = { ...state.sidebar, ...saved.sidebar };
  state.recentDirs = Array.isArray(saved.recentDirs) ? saved.recentDirs.filter((/** @type {unknown} */ d) => typeof d === 'string').slice(0, MAX_RECENT_DIRS) : [];
  if (!Array.isArray(saved.workspaces) || !saved.workspaces.length) return false;
  for (const t of saved.tabs ?? []) {
    state.tabs.set(t.id, { ...t, tags: t.tags ?? [], attention: false, startedAt: Date.now(), view: null, restored: true });
  }
  state.workspaces = saved.workspaces.map((/** @type {Workspace} */ w) => ({ ...w, root: tidyGroups(withoutPreview(w.root)) }));
  // Drop leaves whose tab is missing, so a damaged file can't break a layout.
  for (const ws of state.workspaces) {
    for (const leaf of [...leaves(ws.root)]) {
      if (!state.tabs.has(leaf.tabId)) detachLeaf(ws, leaf.tabId);
    }
    if (!ws.focusId || !state.tabs.has(ws.focusId)) ws.focusId = tabsOf(ws)[0]?.id ?? null;
    // Stacking (one column of title bars) gave way to tabs: a stacked workspace opens with its terminals as tabs.
    if (ws.stacked) {
      const all = tabsOf(ws);
      if (all.length > 1) ws.root = { kind: NODE.tabs, items: all.map(t => ({ kind: NODE.leaf, tabId: t.id })), active: ws.focusId ?? all[0].id };
      delete ws.stacked;
    }
  }
  for (const [id, tab] of state.tabs) {
    if (!state.workspaces.some(ws => findLeaf(ws, id))) state.tabs.delete(id);
    else tab.wsId = /** @type {Workspace} */ (state.workspaces.find(ws => findLeaf(ws, id))).id;
  }
  state.activeId = wsById(saved.activeId) ? saved.activeId : state.workspaces[0].id;
  return true;
}
