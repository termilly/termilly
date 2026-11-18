// @ts-check
// The rows of Minimal's workspace list (js/dock.js) that other computers add (js/remotepc.js): each paired computer,
// its workspaces, and their terminals to open here, as the sidebar's Remote tree lists them. Minimal hides the sidebar,
// so without these another computer's workspaces can't be reached there. Pure: computers in, menu rows out.

import { escapeHtml, cssColor } from './ui.js';
import { SEPARATOR } from './popups.js';
import { AGENT_STATE } from './constants.js';
import { ACTIVITY } from './store.js';

/** @typedef {import('./popups.js').MenuEntry} MenuEntry */
/** @typedef {import('./protocol.js').PcView} Pc */
/** @typedef {{ id: string, ws: string, title: string, activity?: string | null }} PcTerminal */
/** @typedef {{ workspaces: { id: string, name: string, color: string }[], terminals: PcTerminal[] }} PcWorkspaces */

/**
 * What a computer's rows do, from where they're drawn (js/remotepc.js). computer: the paired computer with that id as
 * it is now (the list may change while a menu is open: one goes offline, or is forgotten).
 * @typedef {{ computer: (id: string) => Pc | undefined, stateOf: (pc: Pc) => PcWorkspaces, icon: string,
 *   open: (pc: Pc, pane: string) => void, inFront: (pc: Pc, pane: string) => boolean, newWorkspace: (pc: Pc) => MenuEntry,
 *   newTerminal: (pc: Pc, wsId: string) => MenuEntry }} PcRowActions
 */

/** What the list says after a computer that can't be reached. */
const OFFLINE = 'offline';

/**
 * What the list says of a workspace or terminal where an agent needs the user or works.
 * @type {Readonly<Record<string, string>>}
 */
const STATE_WORDS = Object.freeze({ [AGENT_STATE.needsInput]: 'needs you', [AGENT_STATE.working]: 'working' });

/** @param {string} now an AGENT_STATE (needs input, working) or '' */
export const stateWord = now => STATE_WORDS[now] ?? '';

/** A workspace's colour, as a 16px swatch for its row in a list. @param {string} color */
export const workspaceSwatch = color => `<svg viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="2" fill="${escapeHtml(cssColor(color))}" stroke="none"/></svg>`;

/**
 * A computer's terminal as the list says it: an agent there needing the user, or working.
 * @param {PcTerminal} t
 * @returns {string} an AGENT_STATE, or ''
 */
const stateThere = t => (t.activity === ACTIVITY.needs ? AGENT_STATE.needsInput
  : t.activity === ACTIVITY.spin || t.activity === ACTIVITY.percent ? AGENT_STATE.working : '');

/**
 * Rows, a line, then one more (New workspace, New terminal): the line only when there are rows above it.
 * @param {MenuEntry[]} rows
 * @param {MenuEntry} last
 * @returns {MenuEntry[]}
 */
const withLast = (rows, last) => [...rows, ...(rows.length ? /** @type {MenuEntry[]} */ ([SEPARATOR]) : []), last];

/**
 * Each paired computer: one that's reachable opens its workspaces, each of them its terminals; one that isn't says so.
 * @param {Pc[]} pcs
 * @param {PcRowActions} actions
 * @returns {MenuEntry[]}
 */
export const computerRows = (pcs, actions) => pcs.map(pc => (pc.online
  ? { label: pc.name, icon: actions.icon, submenu: () => reachable(pc, actions, now => workspaceRows(now, actions)) }
  : offlineRow(pc, actions.icon)));

/**
 * A computer that can't be reached: greyed, saying so, and why when it's known.
 * @param {Pc} pc
 * @param {string} icon
 * @returns {MenuEntry}
 */
export const offlineRow = (pc, icon) => ({ label: pc.name, icon, hint: OFFLINE, disabled: true, title: pc.error ?? undefined });

/**
 * A submenu's rows from the computer as it is now, or its offline row when it went away since the menu opened.
 * @param {Pc} pc as the menu had it
 * @param {PcRowActions} actions
 * @param {(now: Pc) => MenuEntry[]} rows
 * @returns {MenuEntry[]}
 */
function reachable(pc, actions, rows) {
  const now = actions.computer(pc.id);
  return now?.online ? rows(now) : [offlineRow(now ?? pc, actions.icon)];
}

/** @param {Pc} pc @param {PcRowActions} actions @returns {MenuEntry[]} */
function workspaceRows(pc, actions) {
  /** @type {MenuEntry[]} */
  const rows = actions.stateOf(pc).workspaces.map(w => ({
    label: w.name, icon: workspaceSwatch(w.color), submenu: () => reachable(pc, actions, now => terminalRows(now, w.id, actions)),
  }));
  return withLast(rows, actions.newWorkspace(pc));
}

/** @param {Pc} pc @param {string} wsId @param {PcRowActions} actions @returns {MenuEntry[]} */
function terminalRows(pc, wsId, actions) {
  /** @type {MenuEntry[]} */
  const rows = actions.stateOf(pc).terminals.filter(t => t.ws === wsId).map(t => ({
    label: t.title, hint: escapeHtml(stateWord(stateThere(t))), checked: actions.inFront(pc, t.id),
    title: `Open ${t.title} from ${pc.name} here`, action: () => openIfThere(pc.id, t.id, actions),
  }));
  return withLast(rows, actions.newTerminal(pc, wsId));
}

/**
 * Opens a computer's terminal here, if the computer can still be reached and the terminal is still there.
 * @param {string} id
 * @param {string} pane
 * @param {PcRowActions} actions
 */
function openIfThere(id, pane, actions) {
  const now = actions.computer(id);
  if (now?.online && actions.stateOf(now).terminals.some(t => t.id === pane)) actions.open(now, pane);
}
