// @ts-check
// Start-up, host messages, shortcuts, the shell menu and window chrome.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import './macwindow.js';
import {
  state, restore, newId, emit, saveNow, WORKSPACE_COLORS, PROFILE_SOURCES, agentChanged, markSeen, GROUPS, EVENTS, sourceOf, SPLIT,
} from './store.js';
import { setWindowState } from './windowshown.js';
import { setFocusRestorer, openPopover, closePopover } from './popups.js';
import { setKeyHandler, scheduleFit, clearActivity, keptRunning } from './terminals.js';
import { consoleDefaults } from './consolecolors.js';
import {
  newTab, closeTab, focusedTab, splitFocused, moveFocus, renderAll, switchWorkspace, restoreFocus, noteOutput,
  cycleGroupTab, moveAllToTabs, reopenWindows, DIRECTION,
} from './panes.js';
import { initSidebar, toggleSidebar } from './sidebar.js';
import { initToolbar } from './toolbar.js';
import './remotepc.js';
import { openPalette, setCommands, openGoTo, openCommandHistory, PALETTE_VIEW } from './palette.js';
import { jumpToPrompt, copyLastOutput } from './commands.js';
import { toggleInbox, jumpToNext } from './inbox.js';
import { applySnapshot } from './snapshot.js';
import { keepEarlierOfOpen } from './earlier.js';
import { toggleCaptures } from './triggers.js';
import { toggleHints } from './hints.js';
import { toggleScratch } from './scratch.js';
import { openGitWindow, openAgentChanges, gitFolderOf, onServer, openRemoteGitNotice } from './gitwindow.js';
import { toggleFiles, initFiles } from './filepanel.js';
import { toggleNotepad, toggleNotepadFromKeys, initNotepad } from './notepad.js';
import { toggleTodo, initTodo } from './todopanel.js';
import './todoagent.js';
import { toggleClips, initClips } from './clipboard.js';
import { chordOf, commandOf, keyHint, KEY_ID } from './keymap.js';
import { openNewWorktree } from './worktree.js';
import { openChangedFiles } from './changes.js';
import { openSnippetsWindow, initSnippetsWindow } from './snippetswindow.js';
import { initSchedules } from './schedules.js';
import { toggleSchedules, initSchedulesWindow } from './scheduleswindow.js';
import { THEMES } from './themes.js';
import { isPreviewOpen, closePreview } from './preview.js';
import { pluginCommands, reloadPlugins } from './plugins.js';
import { startTour, offerTourOnce } from './tour.js';
import { showWhatsNew, offerWhatsNewOnce } from './whatsnew.js';
import './api.js';
import { exportLayout, importLayout } from './layouts.js';
import { isBroadcasting, startBroadcast, stopBroadcast, openCompose, BROADCAST_SCOPE } from './broadcast.js';
import { cycleWorkspace } from './workspaces.js';

import { openSnippets, snippetCommands } from './snippets.js';
import { actionCommands, runActionShortcut } from './actions.js';
import './sshsave.js';
import './weblinks.js';
import { activityLine, stopAllAgents } from './agentline.js';
import './subagents.js';
import './notify.js';
import './phone.js';
import './snippetprompt.js';
import './cost.js';
import './quit.js';
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
import { updateSettings, DEFAULT_FONT_SIZE, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from './preferences.js';
import { openNewWorkspace } from './newworkspace.js';
import { remoteGit } from './remotehost.js';
import { AGENT_KIND, AGENT_STATE, SETTING_VALUES, WINDOW_ACTION } from './constants.js';
import { recordReport } from './agentturns.js';
import { inEachDocument } from './windows.js';
import { rememberSession, recordPrompt } from './myprompts.js';
import './tooltips.js';
import { byId, find, targetOf, WORKSPACE_ID } from './dom.js';

/** @typedef {import('./protocol.js').Host_agent_1} Host_agent_1 */

/** The choices of the settings used here (C#'s SettingValues). */
const { restoreSession, theme } = SETTING_VALUES;

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
/** The keys that reset the size with Ctrl (and Shift): 0, and the keypad's. */
const ZERO_KEYS = ['Digit0', 'Numpad0'];

/**
 * The whole app a step bigger or smaller, within its range.
 * @param {number} step
 */
const zoomBy = step => updateSettings(GROUPS.interface, {
  zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (state.settings.interface.zoom ?? DEFAULT_ZOOM) + step)),
});
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
  // The whole app, text, icons and terminals together (its host zooms every window).
  zoomIn: () => zoomBy(ZOOM_STEP),
  zoomOut: () => zoomBy(-ZOOM_STEP),
  zoomReset: () => updateSettings(GROUPS.interface, { zoom: DEFAULT_ZOOM }),
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
  { label: 'New terminal', keywords: 'tab shell open', hint: keyHint(KEY_ID.newTerminal), run: commands.newTerminal },
  ...state.profiles.map((p, i) => ({
    label: `New ${p.name} terminal`, keywords: `${p.description} shell`, hint: i < NUMBERED_SHORTCUTS ? keysHtml(`Ctrl Shift ${i + 1}`) : '',
    run: () => newTab({ profile: p.id }),
  })),
  { label: 'Split right', keywords: 'pane vertical', hint: keyHint(KEY_ID.splitRight), run: commands.splitRight },
  { label: 'Split down', keywords: 'pane horizontal', hint: keyHint(KEY_ID.splitDown), run: commands.splitDown },
  { label: 'Rename terminal', keywords: 'tab name title', hint: keyHint(KEY_ID.renameTerminal), run: commands.renameTerminal },
  { label: 'Tag terminal', keywords: 'label tags', run: commands.tagTerminal },
  { label: 'Close terminal', keywords: 'tab kill', hint: keyHint(KEY_ID.closeTerminal), run: commands.closeTerminal },
  { label: 'New workspace', keywords: 'project group', hint: keyHint(KEY_ID.newWorkspace), run: commands.newWorkspace },
  { label: 'Toggle workspace sidebar', keywords: 'navigator hide show rail', hint: keyHint(KEY_ID.toggleSidebar), run: commands.toggleSidebar },
  { label: 'Agents: next terminal that needs me', keywords: 'inbox waiting attention jump claude', hint: keyHint(KEY_ID.nextNeedingMe), run: () => setTimeout(commands.nextNeedingMe) },
  { label: 'Open the notification center', keywords: 'inbox needs me waiting attention notifications agents', hint: keyHint(KEY_ID.inbox), run: () => setTimeout(commands.inbox) },
  { label: 'Broadcast input to this workspace (on / off)', keywords: 'multiple terminals send all sync', hint: keyHint(KEY_ID.broadcastWorkspace), run: () => setTimeout(commands.broadcastWorkspace) },
  { label: 'Broadcast: compose and send', keywords: 'multiple terminals send all multi-line', run: () => setTimeout(openCompose) },
  { label: 'Go to workspace, folder or host', keywords: 'open project switch recent directory ssh fuzzy', hint: keyHint(KEY_ID.goTo), run: () => setTimeout(commands.goTo) },
  { label: 'Command history', keywords: 'commands ran failed exit code search', hint: keyHint(KEY_ID.commandHistory), run: () => setTimeout(commands.commandHistory) },
  { label: 'Copy the last command’s output', keywords: 'clipboard result', run: commands.copyLastOutput },
  { label: 'Stop all agents in this workspace', keywords: 'interrupt escape claude codex halt', run: () => setTimeout(() => stopAllAgents()) },
  { label: 'Open the last command’s output in a viewer', keywords: 'output viewer filter follow log json grep tail', run: () => setTimeout(() => openViewer(focusedTab())) },
  { label: 'Open a recording', keywords: 'replay asciicast cast asciinema recording play', run: () => setTimeout(openRecordings) },
  { label: 'Rewind this terminal', keywords: 'replay instant back history screen earlier', run: () => setTimeout(() => focusedTab() && openRewind(/** @type {Tab} */ (focusedTab()))) },
  { label: 'Attach tmux', keywords: 'tmux control mode -CC attach session server remote panes windows wsl ssh', run: () => setTimeout(openAttach) },
  { label: 'Run a snippet', keywords: 'snippets saved commands run snippet macro button bar', run: () => setTimeout(openSnippets) },
  { label: 'Schedules', keywords: 'schedule cron timer run on time report recurring nightly', hint: keyHint(KEY_ID.schedules), run: () => setTimeout(toggleSchedules) },
  { label: 'Manage snippets', keywords: 'snippets explorer window edit new delete saved commands', run: () => setTimeout(openSnippetsWindow) },
  { label: 'Previous prompt', keywords: 'scroll jump command', hint: keyHint(KEY_ID.previousPrompt), run: commands.previousPrompt },
  { label: 'Next prompt', keywords: 'scroll jump command', hint: keyHint(KEY_ID.nextPrompt), run: commands.nextPrompt },
  { label: 'Export this workspace’s layout', keywords: 'save yaml file share project termilly.yml', run: () => exportLayout(state.workspaces.find(w => w.id === state.activeId)) },
  { label: 'Import a workspace layout', keywords: 'open yaml file project termilly.yml', run: importLayout },
  { label: 'Keyboard hints: open links, copy paths and hashes', keywords: 'url link path hash copy open hints', hint: keyHint(KEY_ID.hints), run: () => setTimeout(toggleHints) },
  { label: 'Scratch terminal (floating, on / off)', keywords: 'floating quick temporary popup', hint: keyHint(KEY_ID.scratch), run: () => setTimeout(toggleScratch) },
  { label: 'Git: changes and history', keywords: 'git status diff log commits branches repository staged', hint: keyHint(KEY_ID.git), run: () => setTimeout(openGitHere) },
  { label: 'Move this workspace’s terminals to tabs', keywords: 'tabs group stack stacked accordion collapse panes too many', run: () => moveAllToTabs(state.workspaces.find(w => w.id === state.activeId)) },
  { label: 'Files of this terminal (on / off)', keywords: 'files folder explorer browse sftp upload download remote scp', hint: keyHint(KEY_ID.files), run: () => setTimeout(() => toggleFiles()) },
  { label: 'Notepad (on / off)', keywords: 'notes notepad write jot scratch text memo pad', hint: keyHint(KEY_ID.notepad), run: () => setTimeout(toggleNotepad) },
  { label: 'To do (on / off)', keywords: 'todo tasks task list notes checklist work issue', hint: keyHint(KEY_ID.todo), run: () => setTimeout(toggleTodo) },
  { label: 'Take the tour', keywords: 'tour help guide introduction tutorial walkthrough start learn', run: () => setTimeout(startTour) },
  { label: 'What’s new', keywords: 'whats new changelog release notes update version changes', run: () => setTimeout(showWhatsNew) },
  { label: 'Quit Termilly', keywords: 'exit close quit stop tray', run: () => send(PAGE.window, { action: WINDOW_ACTION.quit }) },
  ...(changeShortcutOn() ? [
    { label: 'Show the files Claude changed here, in the Git window', keywords: 'change preview diff edits claude files last all tree folders agent changes search', hint: keyHint(KEY_ID.agentChanges), run: () => setTimeout(() => openAgentChanges(focusedTab())) },
    { label: 'Show files Claude changed', keywords: 'change preview diff edits claude files list', run: () => setTimeout(() => openChangedFiles()) },
  ] : []),
  { label: 'New agent in worktree', keywords: 'git branch worktree agent claude isolate', run: () => setTimeout(openNewWorktree) },
  { label: 'Show captured lines', keywords: 'triggers errors matches alerts', run: () => setTimeout(() => toggleCaptures()) },
  { label: 'Show recently closed', keywords: 'history reopen restore', run: () => setTimeout(commands.recentlyClosed) },
  { label: 'Settings', keywords: 'preferences options font theme privacy history security', hint: keyHint(KEY_ID.settings), run: () => setTimeout(toggleSettings) },
  { label: 'Switch light / dark theme', keywords: 'appearance colour color mode', run: commands.toggleTheme },
  ...[{ id: theme.system, name: 'System' }, ...THEMES].map(t => ({ label: `Theme: ${t.name}`, keywords: 'appearance colour color look palette', run: () => updateSettings(GROUPS.interface, { theme: t.id }) })),
  { label: 'Bigger text', keywords: 'font zoom in', hint: keysHtml('Ctrl +'), run: commands.fontLarger },
  { label: 'Smaller text', keywords: 'font zoom out', hint: keysHtml('Ctrl -'), run: commands.fontSmaller },
  { label: 'Reset text size', keywords: 'font zoom', hint: keysHtml('Ctrl 0'), run: commands.fontReset },
  { label: 'Zoom in (app and terminals)', keywords: 'zoom bigger scale ui app font', hint: keysHtml('Ctrl Shift +'), run: commands.zoomIn },
  { label: 'Zoom out (app and terminals)', keywords: 'zoom smaller scale ui app font', hint: keysHtml('Ctrl Shift -'), run: commands.zoomOut },
  { label: 'Reset zoom', keywords: 'zoom scale ui app', hint: keysHtml('Ctrl Shift 0'), run: commands.zoomReset },
  ...snippetCommands(),
  ...actionCommands(),
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
  if (git) openGitWindow(git.root, { remote: /** @type {Tab} */ (tab).id, agent: tab });
  else if (onServer(tab)) openRemoteGitNotice();
  else openGitWindow(gitFolderOf(tab, ws), { agent: tab });
}

/**
 * What each shortcut of the keymap does (keymap.js; its keys are Settings › Keyboard's). One answering false doesn't
 * apply now, and its keys go on to the shell.
 * @type {Record<string, () => unknown>}
 */
const RUN = {
  [KEY_ID.newTerminal]: commands.newTerminal, [KEY_ID.closeTerminal]: commands.closeTerminal, [KEY_ID.renameTerminal]: commands.renameTerminal,
  [KEY_ID.splitRight]: commands.splitRight, [KEY_ID.splitDown]: commands.splitDown, [KEY_ID.broadcastWorkspace]: commands.broadcastWorkspace,
  [KEY_ID.newWorkspace]: commands.newWorkspace, [KEY_ID.toggleSidebar]: commands.toggleSidebar, [KEY_ID.nextNeedingMe]: commands.nextNeedingMe,
  [KEY_ID.inbox]: commands.inbox, [KEY_ID.search]: commands.search, [KEY_ID.commandHistory]: commands.commandHistory,
  [KEY_ID.previousPrompt]: commands.previousPrompt, [KEY_ID.nextPrompt]: commands.nextPrompt, [KEY_ID.goTo]: commands.goTo,
  [KEY_ID.settings]: commands.settings, [KEY_ID.hints]: toggleHints, [KEY_ID.scratch]: toggleScratch, [KEY_ID.notepad]: toggleNotepadFromKeys, [KEY_ID.todo]: toggleTodo,
  [KEY_ID.schedules]: toggleSchedules, [KEY_ID.clips]: toggleClips, [KEY_ID.files]: () => toggleFiles(), [KEY_ID.git]: openGitHere,
  [KEY_ID.agentChanges]: () => {
    if (!changeShortcutOn()) return false;
    if (isPreviewOpen()) closePreview(); else openAgentChanges(focusedTab());
    return true;
  },
};

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

  // The keymap's shortcuts first (Settings › Keyboard); AltGr types characters, so it runs none.
  const id = altGr ? null : commandOf(chordOf(e));
  if (id && RUN[id]?.() !== false) return true;
  if (alt && !e.shiftKey && ARROWS[e.key]) moveFocus(ARROWS[e.key]);
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
  else if (ctrlShift && PLUS_KEYS.includes(e.code)) commands.zoomIn();
  else if (ctrlShift && MINUS_KEYS.includes(e.code)) commands.zoomOut();
  else if (ctrlShift && ZERO_KEYS.includes(e.code)) commands.zoomReset();
  else if (ctrl && PLUS_KEYS.includes(e.code)) commands.fontLarger();
  else if (ctrl && MINUS_KEYS.includes(e.code)) commands.fontSmaller();
  else if (ctrl && ZERO_KEYS.includes(e.code)) commands.fontReset();
  else if (ctrl && e.code === 'Comma') commands.settings();
  // Last, so Termilly’s own keys win (Settings › Actions refuses them anyway).
  else if (runActionShortcut(e)) { /* done */ }
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

// Shortcuts when no terminal has focus (e.g. an empty workspace), except while typing in a field; in a detached
// window too.
inEachDocument(doc => doc.addEventListener('keydown', e => {
  // The target may be the document itself, which has no closest().
  if (/** @type {HTMLElement} */ (e.target).closest?.('.xterm, input, select, textarea')) return;
  if (runShortcut(e)) e.preventDefault();
}));

// Ctrl+wheel zooms the font, like most terminals.
byId(WORKSPACE_ID).addEventListener('wheel', e => {
  if (!e.ctrlKey || /** @type {HTMLElement} */ (e.target).closest?.('.notepad-panel')) return; // the Notepad sizes its own text
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
  document.body.classList.toggle('window-inactive', !m.active); // macOS's traffic lights go grey (app.css)
  find(document, '[data-window="maximize"]').title = m.maximized ? RESTORE_LABEL : 'Maximize';
  // Back from minimized: the page may never have lost focus, so the window's focus event below doesn't come.
  if (setWindowState(m)) seeFocused();
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

// Coming back to the window means seeing the terminal that has focus.
function seeFocused() {
  const tab = focusedTab();
  if (tab) markSeen(tab);
}
window.addEventListener('focus', seeFocused);

// An agent reported in: Claude Code's hooks through Termilly's claude shim (source "hooks", see AgentHooks.cs), or
// `claude agents --json` for a Claude Code the hooks don't reach (source "poll", see ClaudeAgentsPoller.cs).
onHost(HOST.agent, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  // Counted for waits on the agent (js/agentturns.js): its reports, the turns its prompts start, and its last answer,
  // which a wait still gives after the agent has exited.
  recordReport(tab, { ...m, event: /** @type {Partial<Host_agent_1>} */ (m).event });
  tab.agent = m.state === AGENT_STATE.exited
    ? null
    : {
      // The hooks' message has the event, tool and reason; the poll's doesn't (they stay undefined then).
      state: m.state, source: m.source, event: /** @type {Partial<Host_agent_1>} */ (m).event,
      tool: /** @type {Partial<Host_agent_1>} */ (m).tool, message: m.message,
      // What the tool works on (a command, a file), for the phones: PreToolUse says; a permission request after it doesn't.
      target: /** @type {Partial<Host_agent_1>} */ (m).target ?? tab.agent?.target ?? null,
      reason: /** @type {Partial<Host_agent_1>} */ (m).reason,
      session: m.session ?? tab.agent?.session, at: Date.now(),
      // The sidebar's activity line (agentline.js): kept until an event says something new.
      line: activityLine(m) ?? tab.agent?.line ?? null,
      // Whether this session has had a turn: only then is there a conversation to resume (hibernate.js).
      hadTurn: (tab.agent?.hadTurn && (m.session ?? tab.agent?.session) === tab.agent?.session) || /** @type {string[]} */ ([AGENT_STATE.working, AGENT_STATE.needsInput, AGENT_STATE.done, AGENT_STATE.error]).includes(m.state),
      // Where it resumes after a restart (snapshot.js): SessionStart says, the events after it don't.
      folder: /** @type {Partial<Host_agent_1>} */ (m).folder ?? tab.agent?.folder ?? null,
      // Claude Code or Codex: what resumes it and its badge. The poll only knows Claude Code.
      kind: /** @type {Partial<Host_agent_1>} */ (m).agent ?? AGENT_KIND.claude,
    };
  rememberSession(tab);
  recordPrompt(tab, /** @type {Partial<Host_agent_1>} */ (m));
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
  initToolbar();
  initNotepad();
  initTodo();
  initClips();
  applySettings();
  if (state.activeId) switchWorkspace(state.activeId);
  initFiles();
  // Terminals that were in windows of their own when Termilly closed open in them again; the Snippets window too.
  if (restored) reopenWindows();
  initSnippetsWindow();
  initSchedules();
  initSchedulesWindow();
  if (!restored) newTab();
  keepEarlierOfOpen();
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
  offerWhatsNewOnce();
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
