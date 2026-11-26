// @ts-check
// Minimal's floating dock (Settings › Appearance › Layout): the workspace on screen, which opens the list of them all,
// search, and the title bar's buttons (lent by js/toolbar.js), floating on an edge of the window. Dragged, it goes to
// the nearest edge; right-click picks the edge and whether it hides. Hidden, it's a short line on its edge (amber while a
// terminal needs you) and comes back when the pointer reaches it there.

import { state, persist, on, wsById, tabsOf, activityOf, EVENTS, ACTIVITY } from './store.js';
import { showMenu, anyOpen, closeAll, SEPARATOR, SIDE } from './popups.js';
import { setToolbarHost } from './toolbar.js';
import { switchWorkspace } from './panes.js';
import { openNewWorkspace } from './newworkspace.js';
import { openPalette } from './palette.js';
import { escapeHtml, cssColor, ICONS } from './ui.js';
import { askCloseWorkspace, CLOSE_WORKSPACE_LABEL } from './workspaceclose.js';
import { targetOf, find, byId, nearestEdge, swallowNextClick, DOCK_SIDE, TITLEBAR_ID } from './dom.js';
import { AGENT_STATE } from './constants.js';
import { workspaceSwatch, stateWord } from './workspacelist.js';
import { showsWorkspaceDots } from './workspacelook.js';

/** @typedef {import('./popups.js').MenuEntry} MenuEntry */

/** @typedef {import('./store.js').DockState} DockState */

/** How near the pointer has to come to the hidden dock's edge to bring it back (px). */
const WAKE_PX = 20;
/** How far past the dock's ends along its edge that still counts (px): the line is shorter than the dock. */
const WAKE_ALONG_PX = 60;
/** How long the dock stays after the pointer leaves it, before hiding again (ms). */
const HIDE_AFTER_MS = 700;
/** How far the pointer goes with the button held before it drags the dock instead of clicking (px). */
const DRAG_START_PX = 5;
/** The dock's classes: hidden to its line, and being dragged. */
const TUCKED = 'tucked';
/** Its id and class, and what says the pointer is over it. */
const DOCK = 'dock';
const HOVER = ':hover';
const MOVING = 'moving';
/** The edges its menu offers, in order. */
const EDGES = /** @type {const} */ ([[DOCK_SIDE.top, 'Top'], [DOCK_SIDE.bottom, 'Bottom'], [DOCK_SIDE.left, 'Left'], [DOCK_SIDE.right, 'Right']]);
/** Where its menus open, away from its edge. */
/** @type {Readonly<Record<string, 'below' | 'above' | 'right' | 'left'>>} */
const AWAY = Object.freeze({ [DOCK_SIDE.top]: SIDE.below, [DOCK_SIDE.bottom]: SIDE.above, [DOCK_SIDE.left]: SIDE.right, [DOCK_SIDE.right]: SIDE.left });

/** The down arrow after the workspace's name, here and in Minimal's strip. */
export const CHEVRON = '<svg class="dock-chev" viewBox="0 0 8 8"><path d="M1.5 3L4 5.5 6.5 3"/></svg>';
const SEARCH = '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/></svg>';

const dock = document.createElement('div');
dock.id = DOCK;
dock.className = DOCK;
dock.hidden = true;
dock.innerHTML = `<button class="dock-ws" title="Workspaces"><span class="dock-ws-dot"></span><span class="dock-ws-name"></span>${CHEVRON}<span class="dock-badge" hidden></span></button>
  <span class="dock-sep"></span>
  <button class="tool dock-search" title="Search terminals, history and output (Ctrl+Shift+F)">${SEARCH}</button>
  <div class="dock-tools"></div>`;
const line = document.createElement('div');
line.className = 'dock-line';
line.hidden = true;
document.body.append(dock, line);
const wsButton = find(dock, '.dock-ws');
const tools = find(dock, '.dock-tools');

/** Whether Minimal is on, so the dock is shown. */
let shown = false;
/** Whether the pointer is at the hidden dock's edge or over the dock. */
let near = false;
let hideTimer = 0;

/** The edge it floats on: top unless moved. */
function sideNow() {
  const side = state.dock.side;
  return side && /** @type {string[]} */ (Object.values(DOCK_SIDE)).includes(side) ? side : DOCK_SIDE.top;
}

/** Whether it hides to a line when not in use: on unless turned off. */
const hides = () => state.dock.hide !== false;

/**
 * Whether a terminal waits for the user: an agent asking (a permission, a question) or wanting attention, as its
 * header and the sidebar show it. Not tab.attention, which only says a hidden workspace printed something new.
 * @param {Tab} tab
 */
export const needsYou = tab => activityOf(tab)?.kind === ACTIVITY.needs;

/** Whether any of a workspace's terminals needs the user, or else works. @param {Workspace} ws */
function stateOf(ws) {
  const tabs = tabsOf(ws);
  if (tabs.some(needsYou)) return AGENT_STATE.needsInput;
  return tabs.some(t => t.agent?.state === AGENT_STATE.working) ? AGENT_STATE.working : '';
}

/** The workspace button: the one on screen, and a dot when another one works or needs the user. */
function drawWorkspace() {
  const ws = wsById(state.activeId);
  find(wsButton, '.dock-ws-dot').style.background = ws ? cssColor(ws.color) : '';
  find(wsButton, '.dock-ws-name').textContent = ws?.name ?? '';
  const others = state.workspaces.filter(w => w.id !== state.activeId).map(stateOf);
  const badge = find(wsButton, '.dock-badge');
  const worst = others.includes(AGENT_STATE.needsInput) ? AGENT_STATE.needsInput : others.includes(AGENT_STATE.working) ? AGENT_STATE.working : '';
  badge.hidden = !worst;
  badge.dataset.state = worst;
  line.classList.toggle('needs', [...state.tabs.values()].some(needsYou));
}

/** Shows it, or its line, where it is now. */
function draw() {
  const side = sideNow();
  dock.dataset.side = side;
  line.dataset.side = side;
  const tucked = hides() && !near && !anyOpen() && !dock.classList.contains(MOVING);
  dock.classList.toggle(TUCKED, tucked);
  // Hidden, its buttons are out of reach of Tab and Enter too, not only of the mouse.
  dock.inert = tucked;
  line.hidden = !shown || !tucked;
  setToolbarHost(shown ? { el: tools, side } : null);
}

/**
 * Minimal on or off: the dock takes the title bar's buttons, or gives them back.
 * @param {boolean} on
 */
export function showDock(on) {
  shown = on;
  dock.hidden = !on;
  if (!on) near = false;
  drawWorkspace();
  draw();
}

/**
 * Whether the pointer is at the edge the hidden dock is on, alongside it. On top that's the window's top edge, over the
 * strip; once shown, the strip between that edge and the dock under it counts too, so the way down to it keeps it.
 * @param {PointerEvent} e
 */
function atEdge(e) {
  const box = dock.getBoundingClientRect();
  const along = (/** @type {number} */ at, /** @type {number} */ from, /** @type {number} */ to) => at >= from - WAKE_ALONG_PX && at <= to + WAKE_ALONG_PX;
  switch (sideNow()) {
    case DOCK_SIDE.top: return e.clientY <= (near ? byId(TITLEBAR_ID).getBoundingClientRect().bottom : WAKE_PX) && along(e.clientX, box.left, box.right);
    case DOCK_SIDE.bottom: return e.clientY >= innerHeight - WAKE_PX && along(e.clientX, box.left, box.right);
    case DOCK_SIDE.left: return e.clientX <= WAKE_PX && along(e.clientY, box.top, box.bottom);
    default: return e.clientX >= innerWidth - WAKE_PX && along(e.clientY, box.top, box.bottom);
  }
}

// Hiding: back at the edge it's on, and away again a moment after the pointer leaves it.
document.addEventListener('pointermove', e => {
  if (!shown || !hides()) return;
  const over = dock.contains(/** @type {Node} */ (e.target)) || (near && dock.matches(HOVER));
  if (over || atEdge(e)) {
    // Back on it before it hid: the hiding is off, and a later leaving starts it again.
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (!near) {
      near = true;
      draw();
    }
  } else if (!hideTimer && (near || !dock.classList.contains(TUCKED))) {
    // Left, or shown still while a menu from it was open: hidden again a moment later.
    hideTimer = window.setTimeout(() => {
      hideTimer = 0;
      near = dock.matches(HOVER);
      draw();
    }, HIDE_AFTER_MS);
  }
}, { passive: true });

// Dragged by any part of it, it follows the pointer to the nearest edge.
dock.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const from = { x: e.clientX, y: e.clientY };
  /** @param {PointerEvent} ev */
  const move = ev => {
    if (!dock.classList.contains(MOVING)) {
      if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_START_PX) return;
      document.body.setPointerCapture(e.pointerId);
      dock.classList.add(MOVING);
      closeAll();
    }
    const side = nearestEdge(ev.clientX, ev.clientY);
    if (side !== sideNow()) {
      state.dock.side = side;
      draw();
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!dock.classList.contains(MOVING)) return;
    dock.classList.remove(MOVING);
    swallowNextClick();
    persist();
    draw();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});

// Its buttons don't take the keyboard focus from the terminal.
dock.addEventListener('mousedown', e => {
  if (targetOf(e).closest('button')) e.preventDefault();
});

/** @param {Partial<DockState>} change */
function setDock(change) {
  state.dock = { ...state.dock, ...change };
  persist();
  draw();
}

dock.addEventListener('contextmenu', e => {
  e.preventDefault();
  /** @type {MenuEntry[]} */
  const items = EDGES.map(([side, label]) => ({ label, picked: side === sideNow(), action: () => setDock({ side }) }));
  items.push(SEPARATOR, { label: 'Hide when not in use', checked: hides(), action: () => setDock({ hide: !hides() }) });
  showMenu(items, { x: e.clientX, y: e.clientY });
});

/**
 * What a workspace's row says after its name: who needs the user or works there, and how many terminals.
 * @param {Workspace} ws
 */
function rowHint(ws) {
  const word = stateWord(stateOf(ws));
  const count = tabsOf(ws).length;
  return escapeHtml(word ? `${word} · ${count}` : `${count}`);
}

/**
 * More rows for the workspace list, after this PC's: other computers' workspaces (js/remotepc.js), which the sidebar
 * lists under Remote but Minimal hides with the sidebar.
 * @type {() => MenuEntry[]}
 */
let moreWorkspaces = () => [];

/** @param {() => MenuEntry[]} rows */
export function setDockWorkspaces(rows) {
  moreWorkspaces = rows;
}

/**
 * The list of all workspaces, other computers' too, and New workspace: what the workspace on screen opens, in the dock
 * and in Minimal's strip (js/minimal.js).
 * @param {HTMLElement} anchor
 * @param {'below' | 'above' | 'right' | 'left'} side
 */
export function showWorkspaceList(anchor, side) {
  /** @type {MenuEntry[]} */
  const items = state.workspaces.map(ws => ({
    // Colour dots off: no swatch, so the list has no icon column (js/popups.js menuLayout).
    label: ws.name, icon: showsWorkspaceDots() ? workspaceSwatch(ws.color) : undefined, hint: rowHint(ws), picked: ws.id === state.activeId,
    action: () => switchWorkspace(ws.id),
    // Right-click: as the sidebar's menu, which Minimal hides, closes it.
    more: () => [{ label: CLOSE_WORKSPACE_LABEL, icon: ICONS.trash, danger: true, action: () => askCloseWorkspace(ws) }],
  }));
  const more = moreWorkspaces();
  if (more.length) items.push(SEPARATOR, ...more);
  items.push(SEPARATOR, { label: 'New workspace', hint: 'Ctrl+Shift+N', action: () => openNewWorkspace() });
  showMenu(items, anchor, { side });
}

wsButton.addEventListener('click', () => showWorkspaceList(wsButton, AWAY[sideNow()]));

find(dock, '.dock-search').addEventListener('click', () => openPalette());

on(EVENTS.workspaces, drawWorkspace);
on(EVENTS.tab, drawWorkspace);
on(EVENTS.agent, drawWorkspace);
