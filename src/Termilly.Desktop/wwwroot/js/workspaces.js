// @ts-check
// Workspace-level actions: create, rename, recolour, close.

import { state, emit, persist, newId, wsById, tabsOf, WORKSPACE_COLORS, noteDir, EVENTS } from './store.js';
import {
  newTab, closeTab, switchWorkspace, renderWorkspace, dropLayer, restoreFocus, setWorkspaceProvider,
} from './panes.js';

/** What a new workspace starts with: one terminal, or none. */
export const START_WITH = Object.freeze({ tab: 'tab', empty: 'empty' });

/** A new workspace's name when it's given none ("workspace", "workspace 2"…). */
export const DEFAULT_WORKSPACE_NAME = 'workspace';

/** Longest workspace name, in characters; a name made from something longer (a host's) is cut shorter. */
export const MAX_WORKSPACE_NAME = 40;
const MAX_MADE_NAME = 36;

/**
 * Creates a workspace and switches to it. startWith: 'tab' opens one terminal, 'empty' none.
 * @param {{ name?: string, color?: string, cwd?: string | null, startWith?: string, profile?: string }} [options]
 * @returns {Workspace}
 */
export function createWorkspace({ name, color, cwd = null, startWith = START_WITH.tab, profile } = {}) {
  const ws = {
    id: newId('w'),
    name: name?.trim() || nextName(),
    color: color ?? WORKSPACE_COLORS[state.workspaces.length % WORKSPACE_COLORS.length],
    cwd: cwd?.trim() || null,
    focusId: null,
    root: null,
  };
  state.workspaces.push(ws);
  if (ws.cwd) noteDir(ws.cwd);
  renderWorkspace(ws);
  switchWorkspace(ws.id);
  if (startWith === START_WITH.tab) newTab({ wsId: ws.id, profile });
  emit(EVENTS.workspaces);
  persist();
  return ws;
}

/**
 * A name for a new workspace that no open one has: the wanted name, else "name 2", "name 3"…
 * @param {string} wanted
 */
export function freeName(wanted) {
  const base = wanted.trim().slice(0, MAX_MADE_NAME) || DEFAULT_WORKSPACE_NAME;
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base} ${i}`;
    if (!nameTaken(name)) return name;
  }
}

function nextName() {
  for (let i = 1; ; i++) {
    const name = i === 1 ? DEFAULT_WORKSPACE_NAME : `${DEFAULT_WORKSPACE_NAME} ${i}`;
    if (!nameTaken(name)) return name;
  }
}

/**
 * Whether another open workspace already has this name (ignoring case and surrounding spaces). Names are what
 * search results, history and the rail show, so two the same couldn't be told apart.
 * @param {string} name
 * @param {Workspace | null} [except]
 */
export function nameTaken(name, except = null) {
  const key = name.trim().toLowerCase();
  return state.workspaces.some(w => w !== except && w.name.trim().toLowerCase() === key);
}

/** @param {string} name */
export const nameTakenMessage = name => `A workspace named “${name.trim()}” already exists.`;

/**
 * Renames the workspace; returns false (and changes nothing) when another workspace has that name.
 * @param {Workspace} ws
 * @param {string} name
 */
export function renameWorkspace(ws, name) {
  const value = name.trim().slice(0, MAX_WORKSPACE_NAME);
  if (!value || value === ws.name) return true;
  if (nameTaken(value, ws)) return false;
  ws.name = value;
  emit(EVENTS.workspaces);
  persist();
  return true;
}

/**
 * @param {Workspace} ws
 * @param {string} color
 */
export function setWorkspaceColor(ws, color) {
  ws.color = color;
  emit(EVENTS.workspaces);
  persist();
}

/**
 * Closes every tab in a workspace (each goes to history) and removes it. Closing the last one leaves no
 * workspace; the window then offers to create one.
 * @param {Workspace} ws
 */
export function closeWorkspace(ws) {
  for (const tab of tabsOf(ws)) closeTab(tab);
  const index = state.workspaces.indexOf(ws);
  state.workspaces.splice(index, 1);
  dropLayer(ws.id);
  // A tmux window's workspace: closing it detaches, and tmux keeps running there (tmux.js).
  emit(EVENTS.workspaceClosed, ws);
  if (!state.workspaces.length) {
    state.activeId = null;
    restoreFocus();
  } else if (state.activeId === ws.id) {
    switchWorkspace(state.workspaces[Math.min(index, state.workspaces.length - 1)].id);
  }
  emit(EVENTS.workspaces);
  persist();
}

/** The active workspace, creating an empty one first if there is none (after closing the last). */
export function ensureActiveWorkspace() {
  return wsById(state.activeId) ?? createWorkspace({ startWith: START_WITH.empty });
}

setWorkspaceProvider(ensureActiveWorkspace);

/**
 * Switches to the next or previous workspace in sidebar order.
 * @param {number} step
 */
export function cycleWorkspace(step) {
  const i = state.workspaces.findIndex(w => w.id === state.activeId);
  const next = state.workspaces[(i + step + state.workspaces.length) % state.workspaces.length];
  if (next) switchWorkspace(next.id);
}

export { wsById };
