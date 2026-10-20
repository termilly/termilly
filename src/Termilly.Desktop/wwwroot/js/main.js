// @ts-check
// Start-up, host messages, shortcuts, the shell menu and window chrome.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import {
  state, restore, newId, emit, saveNow, WORKSPACE_COLORS, PROFILE_SOURCES, agentChanged, markSeen, GROUPS, EVENTS, sourceOf, SPLIT,
} from './store.js';
import { setFocusRestorer, openPopover, closePopover } from './popups.js';
import { setKeyHandler, scheduleFit, clearActivity, keptRunning } from './terminals.js';
import { consoleDefaults } from './consolecolors.js';
import {
  newTab, closeTab, focusedTab, splitFocused, moveFocus, renderAll, switchWorkspace, restoreFocus, noteOutput,
  cycleGroupTab, moveAllToTabs, DIRECTION,
} from './panes.js';
import { initSidebar, toggleSidebar } from './sidebar.js';
import { openPalette, setCommands, openGoTo, openCommandHistory, PALETTE_VIEW } from './palette.js';
import { jumpToPrompt, copyLastOutput } from './commands.js';
import { toggleInbox, jumpToNext } from './inbox.js';
import { applySnapshot } from './snapshot.js';
import { toggleCaptures } from './triggers.js';
import { toggleHints } from './hints.js';
import { toggleScratch } from './scratch.js';
import { openGitWindow, gitFolderOf, onServer, openRemoteGitNotice } from './gitwindow.js';
import { toggleSftp } from './sftp.js';
import { openNewWorktree } from './worktree.js';
import { toggleAi } from './ai.js';
import { openLastChange, openChangedFiles } from './changes.js';
import { openAllChanges } from './changeswindow.js';
import { openSnippetsWindow } from './snippetswindow.js';
import { THEMES } from './themes.js';
import { isPreviewOpen, closePreview } from './preview.js';
import { pluginCommands, reloadPlugins } from './plugins.js';
import './checkin.js';
import { startTour, offerTourOnce } from './tour.js';
import './api.js';
import { exportLayout, importLayout } from './layouts.js';
import { isBroadcasting, startBroadcast, stopBroadcast, openCompose, BROADCAST_SCOPE } from './broadcast.js';
import { cycleWorkspace, createWorkspace } from './workspaces.js';

/** The workspace the drop-down window shows when Settings › Workspaces asks for its own. */
const QUAKE_WORKSPACE = 'Drop-down';
import { openSnippets, snippetCommands } from './snippets.js';
import { activityLine, stopAllAgents } from './agentline.js';
import './subagents.js';
import './cost.js';
import { openAllResults } from './results.js';
import './gitstatus.js';
import { openViewer } from './viewer.js';
import { openRecordings, openRewind } from './replay.js';
import { handleExit as handleSshExit } from './reconnect.js';
import { openAttach } from './tmux.js';
import { applySettings, toggleSettings, toggleTheme, settingEntries, openSetting } from './settings.js';
import { updateHeader } from './header.js';
import { beginRename } from './rename.js';
import { TAG_BUTTON } from './tabmenu.js';
import { openTagPicker } from './tagpicker.js';
import { badgeHtml, escapeHtml, keysHtml } from './ui.js';
import { updateSettings, DEFAULT_FONT_SIZE } from './preferences.js';
import { openNewWorkspace } from './newworkspace.js';
import { remoteGit } from './remotehost.js';
import { AGENT_STATE, SETTING_VALUES, WINDOW_ACTION } from './constants.js';
import { byId, find, targetOf, WORKSPACE_ID } from './dom.js';

/** @typedef {import('./protocol.js').Host_agent_1} Host_agent_1 */

/** The choices of the settings used here (C#'s SettingValues). */
const { quakeWorkspace, restoreSession, theme } = SETTING_VALUES;

/** The name of the first workspace, made when there is nothing to restore. */
const FIRST_WORKSPACE_NAME = 'workspace';
const LOADER_ID = 'loader';
/** The rows of the shell menu. */
const MENU_ITEM = '.menu-item';
/** How many profiles (and workspaces) get a Ctrl+Shift+digit (Ctrl+Alt+digit) shortcut. */
const NUMBERED_SHORTCUTS = 9;
/** The start of a digit key's code (Digit1), before the digit. */
const DIGIT_CODE = 'Digit';
/** The keys that zoom in and out with Ctrl, and split with Alt+Shift (by their codes: = and -, and the keypad's). */
const PLUS_KEYS = ['Equal', 'NumpadAdd'];
const MINUS_KEYS = ['Minus', 'NumpadSubtract'];
/**
 * The direction moveFocus takes for each arrow key (panes.js).
 * @type {Readonly<Record<string, string>>}
 */
const ARROWS = Object.freeze({ ArrowLeft: DIRECTION.left, ArrowRight: DIRECTION.right, ArrowUp: DIRECTION.up, ArrowDown: DIRECTION.down });
/** The maximize button's title while the window is maximized. */
const RESTORE_LABEL = 'Restore';
/** How long the palette keeps its list of settings before building it again. */
const SETTING_CACHE_MS = 5000;
/** How long after the focused terminal's first output the page shows (so the prompt has painted). */
const READY_PAINT_MS = 150;
/** The longest the page waits for that before it shows anyway. */
const READY_AT_MOST_MS = 5000;

setFocusRestorer(restoreFocus);


/** Ctrl+Shift+D and the palette commands for the change preview (Settings › Change preview). */
const changeShortcutOn = () => state.settings.changes.enabled && state.settings.changes.shortcut;

// ---- Commands (buttons, shortcuts and the search palette) ----

/** The app's commands, by name (a data-command button names one). */
const commands = {
  newTerminal: () => newTab(),
  splitRight: () => splitFocused(SPLIT.row),
  splitDown: () => splitFocused(SPLIT.column),
  closeTerminal: () => { const tab = focusedTab(); if (tab) closeTab(tab); },
  renameTerminal: () => { const tab = focusedTab(); if (tab) beginRename(tab); },
  tagTerminal: () => {
    const tab = focusedTab();
    if (tab) {
      openTagPicker(tab, /** @type {Element} */ (/** @type {TabView} */ (tab.view).header.querySelector(TAG_BUTTON)));
    }
  },
  newWorkspace: () => openNewWorkspace(),
  toggleSidebar,
  search: () => openPalette(),
  goTo: () => openGoTo(),
  commandHistory: () => openCommandHistory(),
  previousPrompt: () => jumpToPrompt(focusedTab(), -1),
  nextPrompt: () => jumpToPrompt(focusedTab(), 1),
  copyLastOutput: () => copyLastOutput(focusedTab()),
  recentlyClosed: () => openPalette({ filter: PALETTE_VIEW.closed }),
  fontLarger: () => updateSettings(GROUPS.terminal, { fontSize: state.settings.terminal.fontSize + 1 }),
  fontSmaller: () => updateSettings(GROUPS.terminal, { fontSize: state.settings.terminal.fontSize - 1 }),
  fontReset: () => updateSettings(GROUPS.terminal, { fontSize: DEFAULT_FONT_SIZE }),
  settings: () => toggleSettings(),
  toggleTheme,
  inbox: () => toggleInbox(),
  broadcastWorkspace: () => {
    const tab = focusedTab();
    if (isBroadcasting()) stopBroadcast(); else if (tab) startBroadcast(BROADCAST_SCOPE.workspace, tab);
  },
  nextNeedingMe: () => jumpToNext(),
};

reloadPlugins();

setCommands(() => [
  ...pluginCommands(),
  { label: 'New terminal', keywords: 'tab shell open', hint: keysHtml('Ctrl Shift T'), run: commands.newTerminal },
  ...state.profiles.map((p, i) => ({
    label: `New ${p.name} terminal`, keywords: `${p.description} shell`, hint: i < NUMBERED_SHORTCUTS ? keysHtml(`Ctrl Shift ${i + 1}`) : '',
    run: () => newTab({ profile: p.id }),
  })),
  { label: 'Split right', keywords: 'pane vertical', hint: keysHtml('Alt Shift ='), run: commands.splitRight },
  { label: 'Split down', keywords: 'pane horizontal', hint: keysHtml('Alt Shift -'), run: commands.splitDown },
  { label: 'Rename terminal', keywords: 'tab name title', hint: keysHtml('Ctrl Shift R'), run: commands.renameTerminal },
  { label: 'Tag terminal', keywords: 'label tags', run: commands.tagTerminal },
  { label: 'Close terminal', keywords: 'tab kill', hint: keysHtml('Ctrl Shift W'), run: commands.closeTerminal },
  { label: 'New workspace', keywords: 'project group', hint: keysHtml('Ctrl Shift N'), run: commands.newWorkspace },
  { label: 'Toggle workspace sidebar', keywords: 'navigator hide show rail', hint: keysHtml('Ctrl Shift B'), run: commands.toggleSidebar },
  { label: 'Agents: next terminal that needs me', keywords: 'inbox waiting attention jump claude', hint: keysHtml('Ctrl Shift J'), run: () => setTimeout(commands.nextNeedingMe) },
  { label: 'Open the notification center', keywords: 'inbox needs me waiting attention notifications agents', hint: keysHtml('Ctrl Shift A'), run: () => setTimeout(commands.inbox) },
  { label: 'Broadcast input to this workspace (on / off)', keywords: 'multiple terminals send all sync', hint: keysHtml('Ctrl Shift I'), run: () => setTimeout(commands.broadcastWorkspace) },
  { label: 'Broadcast: compose and send', keywords: 'multiple terminals send all multi-line', run: () => setTimeout(openCompose) },
  { label: 'Go to workspace, folder or host', keywords: 'open project switch recent directory ssh fuzzy', hint: keysHtml('Ctrl Shift O'), run: () => setTimeout(commands.goTo) },
  { label: 'Leave drop-down mode (normal window)', keywords: 'quake window restore', run: () => send(PAGE.quakeLeave) },
  { label: 'Command history', keywords: 'commands ran failed exit code search', hint: keysHtml('Ctrl Shift H'), run: () => setTimeout(commands.commandHistory) },
  { label: 'Copy the last command’s output', keywords: 'clipboard result', run: commands.copyLastOutput },
  { label: 'Stop all agents in this workspace', keywords: 'interrupt escape claude codex halt', run: () => setTimeout(() => stopAllAgents()) },
  { label: 'Open the last command’s output in a viewer', keywords: 'output viewer filter follow log json grep tail', run: () => setTimeout(() => openViewer(focusedTab())) },
  { label: 'Open a recording', keywords: 'replay asciicast cast asciinema recording play', run: () => setTimeout(openRecordings) },
  { label: 'Rewind this terminal', keywords: 'replay instant back history screen earlier', run: () => setTimeout(() => focusedTab() && openRewind(/** @type {Tab} */ (focusedTab()))) },
  { label: 'Attach tmux', keywords: 'tmux control mode -CC attach session server remote panes windows wsl ssh', run: () => setTimeout(openAttach) },
  { label: 'Go to result', keywords: 'pull request pr issue running app url dev server push commit results', run: () => setTimeout(openAllResults) },
  { label: 'Run a snippet', keywords: 'snippets saved commands run snippet macro button bar', run: () => setTimeout(openSnippets) },
  { label: 'Manage snippets', keywords: 'snippets explorer window edit new delete saved commands', run: () => setTimeout(openSnippetsWindow) },
  { label: 'Previous prompt', keywords: 'scroll jump command', hint: keysHtml('Ctrl Shift ↑'), run: commands.previousPrompt },
  { label: 'Next prompt', keywords: 'scroll jump command', hint: keysHtml('Ctrl Shift ↓'), run: commands.nextPrompt },
  { label: 'Export this workspace’s layout', keywords: 'save yaml file share project termilly.yml', run: () => exportLayout(state.workspaces.find(w => w.id === state.activeId)) },
  { label: 'Import a workspace layout', keywords: 'open yaml file project termilly.yml', run: importLayout },
  { label: 'Keyboard hints: open links, copy paths and hashes', keywords: 'url link path hash copy open hints', hint: keysHtml('Ctrl Shift E'), run: () => setTimeout(toggleHints) },
  { label: 'Scratch terminal (floating, on / off)', keywords: 'floating quick temporary popup', hint: keysHtml('Ctrl Shift `'), run: () => setTimeout(toggleScratch) },
  { label: 'Git: changes and history', keywords: 'git status diff log commits branches repository staged', hint: keysHtml('Ctrl Shift G'), run: () => setTimeout(openGitHere) },
  { label: 'Move this workspace’s terminals to tabs', keywords: 'tabs group stack stacked accordion collapse panes too many', run: () => moveAllToTabs(state.workspaces.find(w => w.id === state.activeId)) },
  { label: 'SFTP files of this SSH terminal (on / off)', keywords: 'sftp files upload download remote scp', hint: keysHtml('Ctrl Shift L'), run: () => setTimeout(() => toggleSftp()) },
  { label: 'Take the tour', keywords: 'tour help guide introduction tutorial walkthrough start learn', run: () => setTimeout(startTour) },
  { label: 'Ask AI about this terminal', keywords: 'ai assistant claude llm explain error chat', hint: keysHtml('Ctrl Shift K'), run: () => setTimeout(() => toggleAi()) },
  ...(changeShortcutOn() ? [
    { label: 'Show the last file Claude changed here', keywords: 'change preview diff edit claude file', hint: keysHtml('Ctrl Shift D'), run: () => setTimeout(() => openLastChange()) },
    { label: 'Show files Claude changed', keywords: 'change preview diff edits claude files list', run: () => setTimeout(() => openChangedFiles()) },
    { label: 'Show all files Claude changed, as a tree', keywords: 'change preview diff edits claude files all tree folders window', run: () => setTimeout(() => openAllChanges()) },
  ] : []),
  { label: 'New agent in worktree', keywords: 'git branch worktree agent claude isolate', run: () => setTimeout(openNewWorktree) },
  { label: 'Show captured lines', keywords: 'triggers errors matches alerts', run: () => setTimeout(() => toggleCaptures()) },
  { label: 'Show recently closed', keywords: 'history reopen restore', run: () => setTimeout(commands.recentlyClosed) },
  { label: 'Settings', keywords: 'preferences options font theme privacy history security', hint: keysHtml('Ctrl ,'), run: () => setTimeout(toggleSettings) },
  { label: 'Switch light / dark theme', keywords: 'appearance colour color mode', run: commands.toggleTheme },
  ...[{ id: theme.system, name: 'System' }, ...THEMES].map(t => ({ label: `Theme: ${t.name}`, keywords: 'appearance colour color look palette', run: () => updateSettings(GROUPS.interface, { theme: t.id }) })),
  { label: 'Bigger text', keywords: 'font zoom in', hint: keysHtml('Ctrl +'), run: commands.fontLarger },
  { label: 'Smaller text', keywords: 'font zoom out', hint: keysHtml('Ctrl -'), run: commands.fontSmaller },
  { label: 'Reset text size', keywords: 'font zoom', hint: keysHtml('Ctrl 0'), run: commands.fontReset },
  ...snippetCommands(),
  // Each setting, last so app commands come first.
  ...cachedSettingEntries().map(s => ({
    label: `Settings: ${s.name}`, keywords: `preferences ${s.sectionLabel} ${s.keywords}`, hint: s.sectionLabel,
    run: () => setTimeout(() => openSetting(s.section, s.name)),
  })),
]);

/**
 * The settings list for the palette, built at most every few seconds (it renders every section).
 * @type {{ at: number, entries: ReturnType<typeof settingEntries> }}
 */
let settingCache = { at: 0, entries: [] };
function cachedSettingEntries() {
  if (Date.now() - settingCache.at > SETTING_CACHE_MS) settingCache = { at: Date.now(), entries: settingEntries() };
  return settingCache.entries;
}

document.addEventListener('click', e => {
  const button = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-command]'));
  if (button) {
    /** @type {Record<string, () => unknown>} */ (commands)[/** @type {string} */ (button.dataset.command)]?.();
  }
});

// ---- Shell menu (+ button) ----

const profileMenu = byId('profile-menu');
const profileItems = byId('profile-items');
const newButton = byId('new-button');

/** Profiles grouped by where they come from (shells, WSL, yours, SSH); Ctrl+Shift+1–9 follow the overall order. */
function renderProfileMenu() {
  const groups = PROFILE_SOURCES
    .map(([source, label]) =>
      /** @type {[string, SessionProfile[]]} */ ([label, state.profiles.filter(p => sourceOf(p) === source)]))
    .filter(([, profiles]) => profiles.length);
  profileItems.innerHTML = groups.map(([label, profiles]) => `
    ${groups.length > 1 ? `<div class="menu-group">${escapeHtml(label)}</div>` : ''}
    ${profiles.map(p => {
      const i = state.profiles.indexOf(p);
      return `<button class="menu-item" role="menuitem" data-profile="${escapeHtml(p.id)}">
        ${badgeHtml(p, '')}
        <span class="label"><span class="name">${escapeHtml(p.name)}</span><span class="description">${escapeHtml(p.description)}</span></span>
        ${i < NUMBERED_SHORTCUTS ? `<span class="keys">${keysHtml(`Ctrl Shift ${i + 1}`)}</span>` : ''}
      </button>`;
    }).join('')}`).join('')
    + '<button class="menu-item" data-worktree><span class="label"><span class="name">New agent in worktree</span><span class="description">A new branch in its own folder, with an agent there</span></span></button>'
    + (state.settings.shells.dynamicSources !== false
      ? '<button class="menu-item refresh-sources" data-refresh-sources><span class="label"><span class="name">Refresh containers and pods</span><span class="description">docker ps · kubectl get pods</span></span></button>'
      : '');
}

newButton.addEventListener('click', () => {
  if (closePopover(profileMenu)) return;
  openPopover(profileMenu, newButton);
  /** @type {HTMLElement | null} */ (profileItems.querySelector(MENU_ITEM))?.focus();
});
profileItems.addEventListener('click', e => {
  if (targetOf(e).closest('[data-worktree]')) {
    closePopover(profileMenu);
    openNewWorktree();
    return;
  }
  if (targetOf(e).closest('[data-refresh-sources]')) {
    send(PAGE.profilesRefresh);
    closePopover(profileMenu);
    return;
  }
  const item = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-profile]'));
  if (!item) return;
  closePopover(profileMenu);
  newTab({ profile: item.dataset.profile });
});
profileMenu.addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [.../** @type {NodeListOf<HTMLElement>} */ (profileItems.querySelectorAll(MENU_ITEM))];
  const step = e.key === 'ArrowDown' ? 1 : -1;
  items[(items.indexOf(/** @type {HTMLElement} */ (document.activeElement)) + step + items.length)
    % items.length]?.focus();
});

// ---- Keyboard shortcuts ----
// Plain Ctrl+letter combinations are left to the shell (Ctrl+B, Ctrl+K etc. are line-editing keys there).

/** The Git window on the focused terminal's repository (else its workspace's). */
function openGitHere() {
  const ws = state.workspaces.find(w => w.id === state.activeId);
  const tab = focusedTab();
  // Git on the server, over ssh (a remote repository means a terminal).
  const git = remoteGit(tab);
  if (git) openGitWindow(git.root, { remote: /** @type {Tab} */ (tab).id });
  else if (onServer(tab)) openRemoteGitNotice();
  else openGitWindow(gitFolderOf(tab, ws));
}

/**
 * Runs the shortcut for a keydown. Returns true when it handled the key.
 * @param {KeyboardEvent} e
 */
function runShortcut(e) {
  const altGr = e.getModifierState?.('AltGraph'); // AltGr arrives as Ctrl+Alt; it types characters
  const alt = e.altKey && !e.ctrlKey;
  const ctrl = e.ctrlKey && !e.shiftKey && !e.altKey;
  const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey;
  const ctrlAlt = e.ctrlKey && e.altKey && !e.shiftKey && !altGr;

  if (alt && e.shiftKey && PLUS_KEYS.includes(e.code)) commands.splitRight();
  else if (alt && e.shiftKey && MINUS_KEYS.includes(e.code)) commands.splitDown();
  else if (alt && !e.shiftKey && ARROWS[e.key]) moveFocus(ARROWS[e.key]);
  else if (ctrlShift && e.code === 'KeyT') commands.newTerminal();
  else if (ctrlShift && e.code === 'KeyW') commands.closeTerminal();
  else if (ctrlShift && e.code === 'KeyR') commands.renameTerminal();
  else if (ctrlShift && e.code === 'KeyF') commands.search();
  else if (ctrlShift && e.code === 'KeyO') commands.goTo();
  else if (ctrlShift && e.code === 'KeyE') toggleHints();
  else if (ctrlShift && e.code === 'KeyL') toggleSftp();
  else if (ctrlShift && e.code === 'KeyK') toggleAi();
  else if (ctrlShift && e.code === 'Backquote') toggleScratch();
  else if (ctrlShift && e.code === 'KeyH') commands.commandHistory();
  else if (ctrlShift && e.code === 'KeyG') openGitHere();
  else if (ctrlShift && e.key === 'ArrowUp') commands.previousPrompt();
  else if (ctrlShift && e.key === 'ArrowDown') commands.nextPrompt();
  else if (ctrlShift && e.code === 'KeyB') commands.toggleSidebar();
  else if (ctrlShift && e.code === 'KeyN') commands.newWorkspace();
  else if (ctrlShift && e.code === 'KeyJ') commands.nextNeedingMe();
  else if (ctrlShift && e.code === 'KeyA') commands.inbox();
  else if (ctrlShift && e.code === 'KeyI') commands.broadcastWorkspace();
  else if (ctrlShift && e.code === 'KeyD' && changeShortcutOn()) {
    if (isPreviewOpen()) closePreview(); else openLastChange();
  }
  // The digit is text; subtracting makes it a number.
  else if (ctrlShift && /^Digit[1-9]$/.test(e.code) && state.profiles[/** @type {any} */ (e.code.slice(DIGIT_CODE.length)) - 1]) {
    newTab({ profile: state.profiles[/** @type {any} */ (e.code.slice(DIGIT_CODE.length)) - 1].id });
  }
  else if (ctrlAlt && /^Digit[1-9]$/.test(e.code) && state.workspaces[/** @type {any} */ (e.code.slice(DIGIT_CODE.length)) - 1]) {
    switchWorkspace(state.workspaces[/** @type {any} */ (e.code.slice(DIGIT_CODE.length)) - 1].id);
  }
  else if (e.ctrlKey && !e.altKey && e.key === 'Tab') cycleWorkspace(e.shiftKey ? -1 : 1);
  // In a tab group, the next or previous tab; elsewhere the keys go to the shell.
  else if (ctrl && (e.key === 'PageDown' || e.key === 'PageUp') && cycleGroupTab(e.key === 'PageDown' ? 1 : -1)) { /* done */ }
  else if (ctrl && PLUS_KEYS.includes(e.code)) commands.fontLarger();
  else if (ctrl && MINUS_KEYS.includes(e.code)) commands.fontSmaller();
  else if (ctrl && (e.code === 'Digit0' || e.code === 'Numpad0')) commands.fontReset();
  else if (ctrl && e.code === 'Comma') commands.settings();
  else return false;
  return true;
}

let swallowKeypress = false;

/** xterm's key hook. Returns false to stop xterm from sending the key to the shell. */
setKeyHandler(e => {
  if (e.type === 'keypress' && swallowKeypress) {
    // xterm consults this hook for the keypress too; without this, Alt+Shift+= would also type '+'.
    swallowKeypress = false;
    return false;
  }
  if (e.type !== 'keydown') return true;
  swallowKeypress = runShortcut(e);
  return !swallowKeypress;
});

// Shortcuts when no terminal has focus (e.g. an empty workspace), except while typing in a field.
document.addEventListener('keydown', e => {
  // The target may be the document itself, which has no closest().
  if (/** @type {HTMLElement} */ (e.target).closest?.('.xterm, input, select, textarea')) return;
  if (runShortcut(e)) e.preventDefault();
});

// Ctrl+wheel zooms the font, like most terminals.
byId(WORKSPACE_ID).addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  e.stopPropagation(); // keep xterm from also scrolling
  if (e.deltaY < 0) commands.fontLarger(); else commands.fontSmaller();
}, { passive: false, capture: true });

// ---- Window chrome (forwarded to the host) ----

const titlebar = byId('titlebar');
// Title bar buttons must not steal keyboard focus from the terminal.
titlebar.addEventListener('mousedown', e => {
  if (targetOf(e).closest('button')) e.preventDefault();
});
titlebar.addEventListener('mousedown', e => {
  if (e.button !== 0 || targetOf(e).closest('button, input')) return;
  send(PAGE.window, { action: e.detail === 2 ? WINDOW_ACTION.maximize : WINDOW_ACTION.drag });
});
for (const button of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-window]'))) {
  button.addEventListener('click', () => {
    if (button.dataset.window === WINDOW_ACTION.close) saveNow(); // don't lose a change made in the last moments
    send(PAGE.window, { action: /** @type {string} */ (button.dataset.window) });
  });
}
for (const edge of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.edge'))) {
  edge.addEventListener('mousedown', e => {
    if (e.button === 0) send(PAGE.window, { action: WINDOW_ACTION.resize, edge: edge.dataset.edge });
  });
}
byId('search-button').addEventListener('click', () => openPalette());

onHost(HOST.windowState, m => {
  document.body.classList.toggle('maximized', m.maximized);
  find(document, '[data-window="maximize"]').title = m.maximized ? RESTORE_LABEL : 'Maximize';
});

// ---- Terminal output ----

onHost(HOST.output, m => {
  const tab = state.tabs.get(m.id);
  if (!tab?.view?.term) return;
  tab.view.term.write(consoleDefaults(m.data));
  noteOutput(tab);
  if (tab === focusedTab()) setTimeout(signalReady, READY_PAINT_MS); // the first prompt is on screen: let it paint, then show
});

// ---- Ready (the host shows a loader until then) ----

let readySent = false;

function signalReady() {
  if (readySent) return;
  readySent = true;
  send(PAGE.ready);
  const loader = document.getElementById(LOADER_ID); // Linux's (js/loader.js); Windows's is the window's own
  if (loader) {
    // js/loader.js keeps its timer on the element.
    clearTimeout(/** @type {HTMLElement & { timer?: number }} */ (loader).timer);
    loader.remove();
  }
}

// The page is laid out while the host keeps it hidden; refit once it can actually be seen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleFit();
});

// The drop-down window came down: show the "Drop-down" workspace if Settings asks for one, and focus a terminal.
onHost(HOST.quake, m => {
  if (!m.down) return;
  if (state.settings.quake.workspace === quakeWorkspace.quake) {
    const ws = state.workspaces.find(w => w.name === QUAKE_WORKSPACE) ?? createWorkspace({ name: QUAKE_WORKSPACE });
    if (ws.id !== state.activeId) switchWorkspace(ws.id);
  }
  restoreFocus();
});

// Coming back to the window means seeing the terminal that has focus.
window.addEventListener('focus', () => {
  const tab = focusedTab();
  if (tab) markSeen(tab);
});

// An agent reported in: Claude Code's hooks through Termilly's claude shim (source "hooks", see AgentHooks.cs), or
// `claude agents --json` for a Claude Code the hooks don't reach (source "poll", see ClaudeAgentsPoller.cs).
onHost(HOST.agent, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  tab.agent = m.state === AGENT_STATE.exited
    ? null
    : {
      // The hooks' message has the event, tool and reason; the poll's doesn't (they stay undefined then).
      state: m.state, source: m.source, event: /** @type {Partial<Host_agent_1>} */ (m).event,
      tool: /** @type {Partial<Host_agent_1>} */ (m).tool, message: m.message,
      reason: /** @type {Partial<Host_agent_1>} */ (m).reason,
      session: m.session ?? tab.agent?.session, at: Date.now(),
      // The sidebar's activity line (agentline.js): kept until an event says something new.
      line: activityLine(m) ?? tab.agent?.line ?? null,
      // Whether this session has had a turn: only then is there a conversation to resume (hibernate.js).
      hadTurn: (tab.agent?.hadTurn && (m.session ?? tab.agent?.session) === tab.agent?.session) || /** @type {string[]} */ ([AGENT_STATE.working, AGENT_STATE.needsInput, AGENT_STATE.done, AGENT_STATE.error]).includes(m.state),
    };
  agentChanged(tab);
});

onHost(HOST.exit, m => {
  const tab = state.tabs.get(m.id);
  if (!tab?.view?.term) return;
  clearActivity(tab);
  if (handleSshExit(tab, m.code)) return; // an SSH connection that dropped: it reconnects (reconnect.js)
  if (m.code === 0) {
    closeTab(tab); // a clean `exit` closes the terminal
  } else {
    tab.exited = true;
    tab.view.term.write(`\r\n\x1b[90m[process exited with code ${m.code} - press any key to restart]\x1b[0m\r\n`);
  }
});

onHost(HOST.error, m => {
  const tab = state.tabs.get(m.id);
  if (!tab?.view?.term) return;
  tab.exited = true;
  tab.view.term.write(`\x1b[31mFailed to start shell: ${m.message}\x1b[0m\r\n`);
});

// ---- Start-up ----

let booted = false;

/**
 * Restores saved workspaces (or creates the first one) once settings and shell profiles are known.
 * @param {any} saved The saved workspaces, as the host read them.
 * @param {any} snapshot The terminals' saved output.
 * @param {string[]} [liveSessions] The ids of the shells the background host kept running.
 */
function boot(saved, snapshot, liveSessions = []) {
  if (booted) return;
  booted = true;
  // "Start with a fresh workspace" keeps tags, sidebar and recent folders, but not the workspaces.
  const restored = restore(state.settings.session.restore === restoreSession.off && saved ? { ...saved, workspaces: [] } : saved);
  if (restored) applySnapshot(snapshot);
  // Shells the background host kept running come back as they are: their own output replays, so nothing
  // saved is shown above it, and there's no last command to offer.
  for (const id of liveSessions) {
    const tab = state.tabs.get(id);
    if (tab) {
      // Nothing is typed into a shell that went on running: its agent and folder are as they were.
      keptRunning(tab);
    }
  }
  if (!restored) {
    const ws = { id: newId('w'), name: FIRST_WORKSPACE_NAME, color: WORKSPACE_COLORS[0], cwd: null, focusId: null, root: null };
    state.workspaces = [ws];
    state.activeId = ws.id;
  }
  renderAll();
  initSidebar();
  applySettings();
  if (state.activeId) switchWorkspace(state.activeId);
  if (!restored) newTab();
  // Show the page when the focused terminal prints its prompt (see 'output'); straight away if there is
  // no terminal to wait for, and after a few seconds at most.
  if (!focusedTab()) signalReady();
  setTimeout(signalReady, READY_AT_MOST_MS);
}

// History can't be unlocked: show the page so the unlock dialog (security.js) can be answered.
onHost(HOST.securityLocked, signalReady);

onHost(HOST.settings, m => {
  state.settings = m.settings;
  state.profiles = m.profiles ?? [];
  renderProfileMenu();
  if (booted) {
    for (const tab of state.tabs.values()) updateHeader(tab);
    emit(EVENTS.workspaces);
    applySettings();
    return;
  }
  // The host sends liveSessions; protocol.js's Host_settings misnames it.
  boot(m.workspaces, m.snapshot,
    /** @type {{ liveSessions?: string[] }} */ (/** @type {unknown} */ (m)).liveSessions ?? []);
  offerTourOnce();
});

// Custom profiles were edited in Settings: the host re-detected everything and sent the new list.
onHost(HOST.profiles, m => {
  // The host sends its profiles' summaries, which the page keeps as its profiles.
  state.profiles = /** @type {SessionProfile[]} */ (/** @type {unknown} */ (m.profiles ?? []));
  renderProfileMenu();
  for (const tab of state.tabs.values()) updateHeader(tab);
  emit(EVENTS.profiles);
  emit(EVENTS.workspaces);
});

send(PAGE.settingsLoad);
