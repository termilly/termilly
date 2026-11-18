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
 * What a computer's rows do, from where they're drawn (js/remotepc.js).
 * @typedef {{ stateOf: (pc: Pc) => PcWorkspaces, icon: string, open: (pc: Pc, pane: string) => void,
 *   inFront: (pc: Pc, pane: string) => boolean, newWorkspace: (pc: Pc) => MenuEntry, newTerminal: (pc: Pc, wsId: string) => MenuEntry }} PcRowActions
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
  ? { label: pc.name, icon: actions.icon, submenu: () => workspaceRows(pc, actions) }
  : { label: pc.name, icon: actions.icon, hint: OFFLINE, disabled: true, title: pc.error ?? undefined }));

/** @param {Pc} pc @param {PcRowActions} actions @returns {MenuEntry[]} */
function workspaceRows(pc, actions) {
  /** @type {MenuEntry[]} */
  const rows = actions.stateOf(pc).workspaces.map(w => ({ label: w.name, icon: workspaceSwatch(w.color), submenu: () => terminalRows(pc, w.id, actions) }));
  return withLast(rows, actions.newWorkspace(pc));
}

/** @param {Pc} pc @param {string} wsId @param {PcRowActions} actions @returns {MenuEntry[]} */
function terminalRows(pc, wsId, actions) {
  /** @type {MenuEntry[]} */
  const rows = actions.stateOf(pc).terminals.filter(t => t.ws === wsId).map(t => ({
    label: t.title, hint: escapeHtml(stateWord(stateThere(t))), checked: actions.inFront(pc, t.id),
    title: `Open ${t.title} from ${pc.name} here`, action: () => actions.open(pc, t.id),
  }));
  return withLast(rows, actions.newTerminal(pc, wsId));
}
