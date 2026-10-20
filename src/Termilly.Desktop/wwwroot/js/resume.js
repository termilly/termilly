// @ts-check
// What an SSH terminal runs once its shell is back (a reconnect, a restart): back to its folder, then its attach
// command (tmux attach…), which Settings keep per host. reconnect.js and terminals.js both use it.

import { state } from './store.js';

/**
 * What to type once (re)connected: back to the folder, then the attach command. A folder that's gone leaves the
 * shell where it is (the shell says why) and the attach command still runs. A leading space keeps it out of the
 * shell's history (HISTCONTROL=ignorespace).
 * @param {string | null | undefined} cwd
 * @param {string | null | undefined} attach
 */
export function resumeCommand(cwd, attach) {
  const parts = [];
  const quote = /** @param {string} s */ s => `'${s.replace(/'/g, `'\\''`)}'`;
  if (cwd?.startsWith('/')) parts.push(`cd ${quote(cwd)}`);
  else if (cwd === '~') parts.push('cd');
  else if (cwd?.startsWith('~/')) parts.push(`cd ~/${quote(cwd.slice(2))}`);
  if (attach?.trim()) parts.push(attach.trim());
  return parts.length ? ` ${parts.join('; ')}` : null;
}

/** @param {Tab} tab */
export const attachFor = tab => state.settings.ssh.attach?.[tab.profile] ?? '';
