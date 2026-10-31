// @ts-check
// History as a whole (HistoryManager.cs): asking the host for the summary and to clear part of it, and the words the
// History page and its dialogs (js/settings/history.js, js/historyclear.js) put on sizes, lines and dates.

import { request } from './host.js';
import { PAGE } from './protocol.js';
import { state } from './store.js';

/** The kinds of history (HistoryManager.Kinds). */
export const HISTORY_KIND = Object.freeze({
  closed: 'closed', closedEarlier: 'closedEarlier', earlier: 'earlier', snapshot: 'snapshot', commands: 'commands', synced: 'synced',
});

/**
 * @typedef {{ kind: string, count: number, lines: number, bytes: number }} Kind
 * @typedef {{ id: string, open: boolean, name?: string | null, workspace?: string | null, profile?: string | null, closedAt?: number | null, bytes: number }} Terminal
 * @typedef {{ name: string, closed: number, bytes: number, commands: number }} Group
 * @typedef {{ total: number, oldest?: number | null, oldestName?: string | null, kinds: Kind[], largest: Terminal[],
 *   hosts: { host: string, count: number }[], workspaces: Group[], tags: Group[] }} Stats
 * @typedef {{ before?: number | null, kinds?: string[], workspaces?: string[], tags?: string[], ids?: string[],
 *   earlierIds?: string[], outputOnly?: boolean }} Plan
 * @typedef {{ closed: number, from?: number | null, to?: number | null, earlier: number, commands: number, synced: number, bytes: number }} Removal
 */

const KB = 1024;
const MB = KB * KB;
const GB = MB * KB;
const THOUSAND = 1000;
const MILLION = THOUSAND * THOUSAND;
/** Under this, a size or a count gets one decimal. */
const ONE_DECIMAL_BELOW = 10;

/** The open terminals' ids (their earlier output is theirs, not a closed terminal's). */
export const openIds = () => [...state.tabs.values()].filter(t => t.wsId).map(t => t.id);

/** @returns {Promise<Stats | null>} */
export const askStats = async () => (await request(PAGE.historyStats, { open: openIds() }))?.stats ?? null;

/**
 * What a plan clears; with `dryRun`, only what it would.
 * @param {Plan} plan
 * @param {boolean} dryRun
 * @returns {Promise<Removal | null>}
 */
export const removeHistory = async (plan, dryRun) => (await request(PAGE.historyRemove, { plan, dryRun }))?.result ?? null;

/** @param {number} n */
const short = n => (n < ONE_DECIMAL_BELOW ? n.toFixed(1) : String(Math.round(n)));

/**
 * "1.74 GB", "486 MB", "12 KB".
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${short(bytes / MB)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return bytes ? `${bytes} bytes` : '0 KB';
}

/**
 * "2.9 M lines", "96 k lines", "12 lines".
 * @param {number} lines
 */
export function formatLines(lines) {
  if (lines >= MILLION) return `${short(lines / MILLION)} M lines`;
  if (lines >= THOUSAND) return `${short(lines / THOUSAND)} k lines`;
  return `${lines} line${lines === 1 ? '' : 's'}`;
}

/** @param {number} n */
export const formatCount = n => n.toLocaleString();

/**
 * "14 Mar 2026".
 * @param {number} ms
 */
export const formatDate = ms => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * What a removal takes, as lines for its box ("268 closed terminals, closed 14 Mar to 30 Jul").
 * @param {Removal} r
 */
export function removalLines(r) {
  /** @type {string[]} */
  const lines = [];
  const plural = (/** @type {number} */ n, /** @type {string} */ one) => `${formatCount(n)} ${one}${n === 1 ? '' : 's'}`;
  if (r.closed) {
    const span = r.from && r.to ? (formatDate(r.from) === formatDate(r.to) ? `, closed ${formatDate(r.from)}` : `, closed ${formatDate(r.from)} to ${formatDate(r.to)}`) : '';
    lines.push(`${plural(r.closed, 'closed terminal')}${span}`);
  }
  if (r.earlier) lines.push(`Earlier output of ${plural(r.earlier, 'terminal')}`);
  if (r.commands) lines.push(plural(r.commands, 'command'));
  if (r.synced) lines.push(`${plural(r.synced, 'command')} from other PCs`);
  return lines;
}
