// @ts-check
// Where a shell on another machine is (SSH, or WSL): read from its prompt (user@host:/path$) or OSC 7, kept on the
// tab (it goes back there after a restart, store.js lastFolderOf) and announced (EVENTS.remoteCwd) for the SFTP
// panel to follow.

import { persist, emit, EVENTS } from './store.js';

const PROMPT = /^\S+@[\w.-]+:(\/[^\s$#]*|~[^\s$#]*)[$#] ?$/;

/**
 * @param {Tab} tab
 * @param {string} line
 */
export function noteRemotePrompt(tab, line) {
  const m = PROMPT.exec(`${line.trimEnd()} `);
  if (m) noteRemoteCwd(tab, m[1]);
}

/**
 * The SSH terminal's shell is in this folder now (its prompt, or OSC 7 where the shell sends it).
 * @param {Tab} tab
 * @param {string} path
 */
export function noteRemoteCwd(tab, path) {
  if (tab.remoteCwd === path) return;
  tab.remoteCwd = path;
  persist(); // where it goes back to after a restart (store.js lastFolderOf)
  emit(EVENTS.remoteCwd, tab);
}

/**
 * The shell is back on this machine: a local shell reported its folder after `ssh` or `wsl` typed in it ended. Its
 * folder on the other machine no longer applies (nor does it make the terminal a remote one, store.js isRemote).
 * @param {Tab} tab
 */
export function leftRemote(tab) {
  if (tab.remoteCwd == null) return;
  tab.remoteCwd = null;
  persist();
}
