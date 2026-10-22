// @ts-check
// A terminal's menu: on its header's menu button, a right-click on the header, and its row in the sidebar.

import { state, emit, persist, profileOf, isSsh, EVENTS } from './store.js';
import { showMenu, SEPARATOR } from './popups.js';
import { ICONS, keysHtml } from './ui.js';
import { closeTab, moveTab } from './panes.js';
import { isBroadcasting, startBroadcast, stopBroadcast, openCompose, BROADCAST_SCOPE } from './broadcast.js';
import { copyLastOutput, commandLog } from './commands.js';
import { setAlert, ALERT } from './triggers.js';
import { serialMenuItems } from './serial.js';
import { toggleSftp } from './sftp.js';
import { openCleanup } from './worktree.js';
import { editNote, profileNote, NOTE_KIND } from './notes.js';
import { isLogging, toggleLog, toggleProfileLogging } from './logging.js';
import { openSnippets, saveAsSnippet } from './snippets.js';
import { portsOf, openPort, repoOf } from './gitstatus.js';
import { openViewer } from './viewer.js';
import { togetherMenuItems } from './together.js';
import { replayMenuItems } from './replay.js';
import { editAttach } from './reconnect.js';
import { remoteMenuItems, remoteGit } from './remotehost.js';
import { openNewWorkspace } from './newworkspace.js';
import { beginRename } from './rename.js';
import { openTagPicker } from './tagpicker.js';
/** How many of the last commands "Open output in viewer" lists, and how much of each it shows. */
const RECENT_COMMANDS = 12;
const COMMAND_LABEL = 60;
/** What a command's entry says when its line wasn't recorded. */
const UNNAMED_COMMAND = 'command';

/** The header's tag button, where the tag picker opens (header.js shows it). */
export const TAG_BUTTON = '.tag-btn';

/** Menu labels written in more than one menu (the sidebar's workspace menu has its own). */
export const RENAME_LABEL = 'Rename';
export const NOTE_LABEL = 'Note';
export const GIT_LABEL = 'Git';



/** @typedef {import('./popups.js').MenuEntry} MenuEntry */
/** @typedef {import('./popups.js').MenuItem} MenuItem */

/** A submenu entry's swatch in a workspace's or tag's colour. */
const swatch = (/** @type {string} */ color) => `<span class="ws-swatch" style="background:${color}"></span>`;

/**
 * @param {Tab} tab
 * @param {import('./popups.js').Anchor} at
 */
export function openTabMenu(tab, at) {
  showMenu([
    ...nameItems(tab),
    moveItem(tab),
    ...replayMenuItems(tab),
    ...keepingItems(tab),
    ...serialMenuItems(tab),
    ...toolItems(tab),
    ...commandItems(tab),
    ...togetherMenuItems(tab),
    { label: 'Run snippet', icon: ICONS.terminal, action: () => openSnippets() },
    ...snippetItems(tab),
    alertItem(tab),
    broadcastItem(tab),
    // The id the termilly command and the MCP server take (--pane), to copy into a script.
    {
      label: `Terminal ID: ${tab.id}`, icon: ICONS.hash,
      submenu: () => [
        { label: 'Copy to clipboard', icon: ICONS.copy, action: () => navigator.clipboard.writeText(tab.id) },
      ],
    },
    SEPARATOR,
    { label: 'Close', icon: ICONS.cross, hint: keysHtml('Ctrl Shift W'), action: () => closeTab(tab) },
  ], at);
}

/**
 * Saving the last command as a snippet, when there is one.
 * @param {Tab} tab
 * @returns {MenuEntry[]}
 */
function snippetItems(tab) {
  const command = tab.lastCommand?.command;
  return command ? [{ label: 'Save the last command as a snippet', action: () => saveAsSnippet(command) }] : [];
}

/**
 * Its name, tags and notes (its own, and its SSH host's).
 * @param {Tab} tab
 * @returns {MenuEntry[]}
 */
function nameItems(tab) {
  return [
    { label: RENAME_LABEL, icon: ICONS.rename, hint: keysHtml('Ctrl Shift R'), action: () => beginRename(tab) },
    {
      label: 'Tags', icon: ICONS.tag,
      action: () => openTagPicker(tab, /** @type {Element} */ (/** @type {TabView} */ (tab.view).header.querySelector(TAG_BUTTON))),
    },
    { label: tab.note?.text ? 'Edit note' : NOTE_LABEL, icon: ICONS.note, action: () => editNote(NOTE_KIND.terminal, tab) },
    ...(isSsh(tab)
      ? [{ label: profileNote(tab) ? `Edit note on ${/** @type {SessionProfile} */ (profileOf(tab)).name}` : `Note on ${/** @type {SessionProfile} */ (profileOf(tab)).name}`, icon: ICONS.ssh, action: () => editNote(NOTE_KIND.host, tab.profile) }] : []),
  ];
}

/**
 * @param {Tab} tab
 * @returns {MenuItem}
 */
function moveItem(tab) {
  return {
    label: 'Move to workspace', icon: ICONS.move,
    submenu: () => [
      ...state.workspaces.filter(ws => ws.id !== tab.wsId).map(ws => ({ label: ws.name, icon: swatch(ws.color), action: () => moveTab(tab, ws.id) })),
      ...(state.workspaces.length > 1 ? /** @type {MenuEntry[]} */ ([SEPARATOR]) : []),
      { label: 'New workspace', icon: ICONS.plus, action: () => openNewWorkspace({ moveTab: tab }) },
    ],
  };
}

/**
 * What's kept of it: a log file, and history after it closes.
 * @param {Tab} tab
 * @returns {MenuEntry[]}
 */
function keepingItems(tab) {
  return [
    { label: 'Log to file', icon: ICONS.history, checked: isLogging(tab), action: () => toggleLog(tab) },
    { label: `Always log ${profileOf(tab)?.name ?? 'this shell'}`, checked: (state.settings.logging.profiles ?? []).includes(tab.profile), action: () => toggleProfileLogging(tab) },
    {
      label: 'Keep in history after closing', icon: ICONS.history, checked: !tab.noHistory,
      action: () => {
        tab.noHistory = !tab.noHistory;
        emit(EVENTS.tab, tab);
        persist();
      },
    },
  ];
}

/**
 * What it can open: its worktree's clean-up, the assistant, SSH's options and files, changed files, git.
 * @param {Tab} tab
 * @returns {MenuEntry[]}
 */
function toolItems(tab) {
  const ssh = isSsh(tab);
  return [
    ...(tab.worktree ? [{ label: 'Clean up worktree', action: () => openCleanup(tab) }] : []),
    ...(ssh ? [{ label: 'After reconnecting', action: () => editAttach(tab) }] : []),
    ...remoteMenuItems(tab),
    ...(ssh ? [{ label: 'Files (SFTP)', hint: keysHtml('Ctrl Shift L'), action: () => toggleSftp(tab) }] : []),
    ...(state.settings.changes.enabled && tab.changes?.length
      ? [{ label: 'Files Claude changed', icon: ICONS.diff, action: () => emit(EVENTS.openChangedFiles, { tab, anchor: /** @type {TabView} */ (tab.view).header }) }] : []),
    ...gitItems(tab),
  ];
}

/**
 * Git for its repository: on the server, as its integration reported it, or here.
 * @param {Tab} tab
 * @returns {MenuEntry[]}
 */
function gitItems(tab) {
  const git = { label: GIT_LABEL, icon: ICONS.git, hint: keysHtml('Ctrl Shift G') };
  const remote = remoteGit(tab);
  if (remote) return [{ ...git, action: () => emit(EVENTS.openGit, { folder: remote.root, remote: tab.id, agent: tab }) }];
  if (repoOf(tab.cwd)) return [{ ...git, action: () => emit(EVENTS.openGit, { folder: tab.cwd, agent: tab }) }];
  return [];
}

/**
 * Its commands' output (copied, or in the viewer), and the ports its programs listen on.
 * @param {Tab} tab
 * @returns {MenuEntry[]}
 */
function commandItems(tab) {
  const log = commandLog(tab);
  return [
    ...(tab.lastCommand ? [{ label: 'Copy the last command’s output', icon: ICONS.copy, action: () => copyLastOutput(tab) }] : []),
    ...(tab.running || tab.lastCommand ? [{
      label: tab.running ? 'Open the running command’s output' : 'Open output in viewer', icon: ICONS.terminal,
      ...(log.length > 1 && !tab.running
        ? { submenu: () => [...log].reverse().slice(0, RECENT_COMMANDS).map(run => ({ label: (run.command || UNNAMED_COMMAND).trim().slice(0, COMMAND_LABEL), hint: run.exitCode ? `<span class="menu-current">exit ${run.exitCode}</span>` : '', action: () => openViewer(tab, run) })) }
        : { action: () => openViewer(tab) }),
    }] : []),
    ...(portsOf(tab).length ? [{
      label: 'Ports', icon: ICONS.port,
      submenu: () => portsOf(tab).flatMap(port => [
        { label: `Open http://localhost:${port}`, action: () => openPort(port) },
        { label: `Copy http://localhost:${port}`, action: () => navigator.clipboard.writeText(`http://localhost:${port}`) },
      ]),
    }] : []),
  ];
}

/**
 * @param {Tab} tab
 * @returns {MenuItem}
 */
function alertItem(tab) {
  return {
    label: 'Alert me', icon: ICONS.bell,
    submenu: () => [
      { label: 'When the running command finishes', checked: !!tab.alerts?.finish, action: () => setAlert(tab, ALERT.finish) },
      { label: 'When it’s quiet for 30 seconds', checked: !!tab.alerts?.quiet, action: () => setAlert(tab, ALERT.quiet) },
      { label: 'When it prints something', checked: !!tab.alerts?.output, action: () => setAlert(tab, ALERT.output) },
    ],
  };
}

/**
 * @param {Tab} tab
 * @returns {MenuItem}
 */
function broadcastItem(tab) {
  const shortcut = keysHtml('Ctrl Shift I');
  return {
    label: 'Broadcast input', icon: ICONS.broadcast,
    submenu: () => isBroadcasting()
      ? [
        { label: 'Compose', action: openCompose },
        { label: 'Stop broadcasting', hint: shortcut, action: stopBroadcast },
      ]
      : [
        { label: 'To this workspace', hint: shortcut, action: () => startBroadcast(BROADCAST_SCOPE.workspace, tab) },
        ...state.tags.filter(t => [...state.tabs.values()].some(x => x.tags.includes(t.name))).map(t => ({
          label: `To terminals tagged ${t.name}`, icon: swatch(t.color), action: () => startBroadcast(`tag:${t.name}`, tab),
        })),
        { label: 'To terminals I pick', action: () => startBroadcast(BROADCAST_SCOPE.selected, tab) },
      ],
  };
}
