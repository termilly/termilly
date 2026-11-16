// @ts-check
// The Git window's safety net, page side: local history (snapshots of uncommitted work the host keeps under
// refs/termilly/snapshots, GitSnapshots on the host) and what it's asked for. The host takes a snapshot itself before
// anything it throws away (a Restore, a discarded block of lines, a removed worktree), so each of those offers Undo:
// the newest snapshot put back for the files it touched. This takes them before an agent starts on a repository, and
// every few minutes while an agent works in one.

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { SNAPSHOT_REASON, AGENT_STATE } from './constants.js';
import { state, runningAgent, profileOf, REMOTE_SOURCES } from './store.js';

/**
 * A snapshot: when, why, on which branch, and the files it differs from HEAD in.
 * @typedef {{ id: string, at: string, reason: string, branch: string | null,
 *   files: { path: string, oldPath?: string | null, status: string }[], skipped: number }} Snapshot
 */
/**
 * What the safety net asks the host with: the Git window's ask (its server, its errors).
 * @typedef {(type: any, payload: any) => Promise<any>} Ask
 */

/** How often a repository where an agent works is kept. */
const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;

/**
 * Asks the host directly, outside the Git window (an agent starting, the timer): its data, or null when it failed
 * (a repository on a server, not a repository at all). A missed snapshot here isn't worth a message.
 * @param {string} root
 * @param {string} reason
 * @returns {Promise<Snapshot | null>}
 */
export async function takeSnapshot(root, reason) {
  const m = await request(PAGE.gitviewSnapshot, { root, reason });
  return m.error ? null : m.data ?? null;
}

/**
 * Undo for what the host just threw away: the files put back as the snapshot it kept first has them (its id came
 * with the action's answer). Restoring keeps what's there in turn, so this can be undone too.
 * @param {Ask} ask
 * @param {string} root
 * @param {string} kept
 * @param {string[]} paths
 */
export const undoDiscard = (ask, root, kept, paths) => ask(PAGE.gitviewSnapshotRestore, { root, id: kept, paths });

/**
 * The folders on this computer where an agent is working now (a terminal's agent mid-turn).
 * @returns {Set<string>}
 */
function foldersAtWork() {
  const out = new Set();
  for (const tab of state.tabs.values()) {
    const source = profileOf(tab)?.source;
    if (!tab.cwd || !runningAgent(tab) || tab.agent?.state !== AGENT_STATE.working || (source && REMOTE_SOURCES.includes(source))) continue;
    out.add(tab.cwd);
  }
  return out;
}

// Every few minutes, what's uncommitted where an agent is working is kept (the host skips it when nothing changed
// since the last snapshot), so a file the agent overwrote can be put back as it was a few minutes before.
setInterval(() => {
  for (const folder of foldersAtWork()) takeSnapshot(folder, SNAPSHOT_REASON.timer);
}, SNAPSHOT_EVERY_MS);
