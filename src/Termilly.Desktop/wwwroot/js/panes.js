// @ts-check
// The workspace view: one layer per workspace (only the active one visible; the others keep running and
// stay laid out so their terminals keep the right size), the split layout inside it, and tab actions.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import {
  state, on, emit, persist, newId, activeWs, wsById, tabsOf, tabTitle, defaultProfile, ensureTag, activityOf, leaves,
  replaceNode, findLeaf, detachLeaf, groupOf, firstTabOf, markSeen, findPreview, withoutPreview, EVENTS, NODE, SPLIT,
  SPLIT_EVEN,
} from './store.js';
import { ICONS, tabBadgeHtml, activityHtml } from './ui.js';
import { openTerminal, disposeTerminal, bufferLines, scheduleFit, prepareStart } from './terminals.js';
import { wake } from './hibernate.js';
import { byId, find, targetOf, WORKSPACE_ID, dragPointer, onMiddleClick } from './dom.js';
import { ENV_CLASS, ENV_COLOR } from './environments.js';
import { detach, closeWindow, focusWindow, setWindowTitle, OFFSET_PX } from './windows.js';

/** A pane's drop zones: beside it on a side, in it as a tab (center), or out into a window of its own. */
const ZONE = Object.freeze({ left: 'left', right: 'right', top: 'top', bottom: 'bottom', center: 'center', window: 'window' });

/** Which way focus moves from the focused pane (and which way a tab strip scrolls). */
export const DIRECTION = Object.freeze({ left: 'left', right: 'right', up: 'up', down: 'down' });

/** The body's class while there are no workspaces (app.css shows the no-workspaces state). */
export const NO_WORKSPACES = 'workspaceless';

/** A pane that's in a tab group but not its shown tab. */
const TAB_HIDDEN = 'tab-hidden';
/** A tab in a group's strip. */
const STRIP_TAB = 'strip-tab';
/** The body's class while a pane is dragged, and the dragged pane's own. */
const DRAGGING_PANE = 'dragging-pane';
const DRAG_SOURCE = 'drag-source';
/** The drop preview while it's shown, and while it's put in place without sliding there. */
const VISIBLE = 'visible';
const PLACING = 'placing';
/** A strip tab whose terminal wants attention. */
const ATTENTION = 'attention';

/** A pane at least this many times as wide as high splits side by side for a new terminal, else one above the other. */
const WIDE_FOR_TERMINAL = 1.6;
/** The same for the change preview, which wants less width. */
const WIDE_FOR_PREVIEW = 1.2;
/** How far a divider can go: the smaller side keeps at least this share of the split. */
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;
/** A tab strip's < and > scroll it by this share of its width, and at least this much. */
const STRIP_SCROLL_SHARE = 0.7;
const STRIP_SCROLL_MIN_PX = 80;
/** Room left beside the shown tab when it's scrolled into the strip's view. */
const STRIP_TAB_MARGIN_PX = 4;
/** This close to the app window's edge (or past it), a dragged pane is dropped into a window of its own. */
const WINDOW_EDGE_PX = 8;
/** The size of a dragged pane's window outline at the most (it's the pane's size, smaller). */
const WINDOW_PREVIEW = Object.freeze({ w: 360, h: 240 });
/** How much of a pane's height, along its top and its bottom, splits it above or below (left or right in between). */
const TOP_BOTTOM_SHARE = 1 / 3;

/**
 * A pane's drop zone: beside it on a side, or in it as a tab (center).
 * @typedef {typeof ZONE[keyof typeof ZONE]} Zone
 */

/**
 * Where a dragged pane would land: the pane it goes to, the zone, and the area the drop preview covers. Out into a
 * window of its own, `over` is the pane whose compass cell it's on (none at the app window's edge).
 * @typedef {{ target: Tab, zone: Zone, rect: DOMRect, over?: Tab }} Drop
 */

/**
 * What newTab is given: all of it optional. restore is a reopened terminal's saved output.
 * @typedef {{ profile?: string | null, wsId?: string | null, dir?: 'row' | 'column', name?: string | null,
 *   tags?: string[], restore?: { lines: string[], closedAt: number }, cwd?: string | null, command?: string | null,
 *   note?: Note | null, virtual?: Tab['virtual'] }} NewTabOptions
 */

/**
 * What createTab is given (a layout's terminal).
 * @typedef {{ wsId: string, profile?: string | null, name?: string | null, tags?: string[], cwd?: string | null,
 *   env?: Record<string, string> | null, command?: string | null, note?: Note | null }} CreateTabOptions
 */

/**
 * Builds a terminal's header (header.js gives it, as it sits above the panes).
 * @type {(tab: Tab) => HTMLElement}
 */
let headerBuilder = () => document.createElement('div');
/** @param {(tab: Tab) => HTMLElement} fn */
export const setHeaderBuilder = fn => { headerBuilder = fn; };

/**
 * The active workspace, made if there is none (workspaces.js gives it, as it sits above the panes).
 * @type {() => Workspace | null}
 */
let activeWorkspace = () => null;
/** @param {() => Workspace} fn */
export const setWorkspaceProvider = fn => { activeWorkspace = fn; };

// A module below the panes (triggers.js) asks for a tab to be shown.
on(EVENTS.showTab, tab => focusTab(tab));
// A dialog closed: the focus goes back where it was.
on(EVENTS.dialogClosed, () => restoreFocus());

const container = byId(WORKSPACE_ID);
const emptyTemplate = /** @type {HTMLTemplateElement} */ (byId('empty-state'));
const dockGuideTemplate = /** @type {HTMLTemplateElement} */ (byId('dock-guide'));
// The compass's corner cell drops the pane into a window of its own: the same icon as its menu entry.
find(dockGuideTemplate.content, '[data-zone="window"]').innerHTML = ICONS.detach;
const dropPreview = byId('drop-preview');
const dragGhost = byId('drag-ghost');
/** @type {Map<string, HTMLElement>} */
const layers = new Map(); // workspace id -> layer element

export const focusedTab = () => {
  const ws = activeWs();
  return ws ? state.tabs.get(/** @type {string} */ (ws.focusId)) ?? null : null;
};

/** @param {Workspace} ws */
function layerOf(ws) {
  let layer = layers.get(ws.id);
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'ws-layer';
    layer.dataset.ws = ws.id;
    container.append(layer);
    layers.set(ws.id, layer);
  }
  return layer;
}

// ---- Tabs ----

/**
 * Creates a tab's pane (header + terminal area). The terminal opens when the pane is first rendered.
 * @param {Tab} tab
 * @param {{ draggable?: boolean }} [options]
 */
export function createView(tab, { draggable = true } = {}) {
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.tab = tab.id;
  const body = document.createElement('div');
  body.className = 'pane-body';
  tab.view = /** @type {TabView} */ (/** @type {unknown} */ ({ el, body, term: null, fit: null })); // its header comes next
  tab.view.header = headerBuilder(tab);
  el.append(tab.view.header, body);
  // A click in a field on the pane (its name being renamed) stays there: giving the terminal the keyboard would end
  // the edit, and a click there only moves the cursor.
  el.addEventListener('mousedown', e => { if (!targetOf(e).closest('input')) focusTab(tab); }, true);
  if (draggable) wireDrag(tab, tab.view.header);
}

/**
 * Opens a new tab in a workspace (the active one by default, created if there is none), next to its
 * focused tab. dir 'row' puts it to the right, 'column' below; with no dir, it splits along the longer side.
 * @param {NewTabOptions} [options]
 */
export function newTab({ profile = defaultProfile(), wsId = state.activeId, dir, name = null, tags = [], restore, cwd = null, command = null, note = null, virtual = null } = {}) {
  const ws = /** @type {Workspace} */ (wsById(wsId) ?? activeWorkspace());
  // A fresh terminal starts with its profile's tags (an SSH host to production gets "prod").
  if (!restore && !tags.length) tags = state.profiles.find(p => p.id === profile)?.tags ?? [];
  for (const tag of tags) ensureTag(tag);
  const tab = /** @type {Tab} */ ({
    id: newId('t'), wsId: ws.id, profile, name, tags: [...tags], noHistory: !!virtual, attention: false, startedAt: Date.now(), view: null, note,
    startCwd: cwd, virtual,
  });
  // A reopened terminal's output; a command from the API (termilly open), or the profile's own (Claude Code: claude).
  prepareStart(tab, { output: restore ?? null, command: command ?? (restore ? null : state.profiles.find(p => p.id === profile)?.startCommand ?? null) });
  state.tabs.set(tab.id, tab);
  createView(tab);
  insertLeaf(ws, tab, dir);
  ws.focusId = tab.id;
  renderWorkspace(ws);
  if (ws.id === state.activeId) focusTab(tab);
  emit(EVENTS.workspaces);
  persist();
  // Opened now, not brought back from the last session (the Remote section counts it as recently used).
  if (!restore) emit(EVENTS.opened, tab);
  return tab;
}

/**
 * Creates a tab and its view without placing it in the workspace's tree (layouts.js builds the tree itself).
 * cwd, env and command come from a layout: its own start folder and variables, and a command typed at its first
 * prompt.
 * @param {CreateTabOptions} options
 */
export function createTab({ wsId, profile = defaultProfile(), name = null, tags = [], cwd = null, env = null, command = null, note = null }) {
  for (const tag of tags) ensureTag(tag);
  const tab = /** @type {Tab} */ ({
    id: newId('t'), wsId, profile, name, tags: [...tags], noHistory: false, attention: false, startedAt: Date.now(), view: null,
    startCwd: cwd, env, startCommand: command, note,
  });
  prepareStart(tab, { command: command ?? state.profiles.find(p => p.id === profile)?.startCommand ?? null });
  state.tabs.set(tab.id, tab);
  createView(tab);
  return tab;
}

/**
 * Puts a tab's leaf into a workspace's tree, splitting the workspace's focused tab (or the tab group it's in).
 * @param {Workspace} ws
 * @param {Tab} tab
 * @param {'row' | 'column'} [dir]
 */
function insertLeaf(ws, tab, dir) {
  /** @type {LeafNode} */
  const leaf = { kind: NODE.leaf, tabId: tab.id };
  const near = findLeaf(ws, /** @type {string} */ (ws.focusId)) ?? [...leaves(ws.root)].pop();
  if (!near) {
    // An empty workspace, or one with only the change preview left in it.
    ws.root = ws.root ? { kind: NODE.split, dir: SPLIT.row, ratio: SPLIT_EVEN, a: leaf, b: ws.root } : leaf;
    return;
  }
  const anchor = groupOf(ws, near.tabId) ?? near;
  if (!dir) {
    const r = state.tabs.get(near.tabId)?.view?.el.getBoundingClientRect();
    dir = !r || r.width >= r.height * WIDE_FOR_TERMINAL ? SPLIT.row : SPLIT.column;
  }
  ws.root = replaceNode(ws.root, anchor, { kind: NODE.split, dir, ratio: SPLIT_EVEN, a: anchor, b: leaf });
}

/**
 * Splits the focused tab, with the same shell unless a profile is given.
 * @param {'row' | 'column'} [dir]
 * @param {string} [profile]
 */
export function splitFocused(dir, profile) {
  const current = focusedTab();
  newTab({ profile: profile ?? current?.profile ?? defaultProfile(), dir });
}

/**
 * Closes a tab: records it as a closed session (unless it opted out), then kills its shell.
 * @param {Tab} tab
 */
export function closeTab(tab) {
  if (!state.tabs.has(tab.id)) return;
  // Its window goes with it (one still opening too); the pane isn't wanted back.
  tab.detached = false;
  closeWindow(windowKey(tab), { quiet: true });
  const ws = wsById(tab.wsId);
  if (!ws) {
    // The scratch terminal (scratch.js): no workspace, no history.
    disposeTerminal(tab);
    tab.view?.el.remove();
    state.tabs.delete(tab.id);
    emit(EVENTS.scratchClosed);
    restoreFocus();
    return;
  }
  recordHistory(tab);
  const sibling = detachLeaf(ws, tab.id);
  dropLonePreview(ws);
  disposeTerminal(tab);
  tab.view?.el.remove();
  state.tabs.delete(tab.id);
  if (ws.focusId === tab.id) ws.focusId = sibling ? firstTabOf(sibling) ?? tabsOf(ws)[0]?.id ?? null : null;
  renderWorkspace(ws);
  if (ws.id === state.activeId) {
    const next = state.tabs.get(/** @type {string} */ (ws.focusId));
    if (next) focusTab(next); else restoreFocus();
  }
  emit(EVENTS.workspaces);
  persist();
}

/** @param {Tab} tab */
function recordHistory(tab) {
  const ws = wsById(tab.wsId);
  const keepsOutput = !tab.noHistory && !!state.settings.session.saveOutput;
  const lines = keepsOutput ? bufferLines(tab) : [];
  // Its earlier output (js/earlier.js) stays with the entry; when output isn't kept, it goes.
  if (!keepsOutput) send(PAGE.earlierDelete, { id: tab.id });
  send(PAGE.historyAdd, {
    entry: {
      id: newId('h'),
      name: tabTitle(tab),
      customName: tab.name,
      profile: tab.profile,
      tags: tab.tags,
      note: tab.note ?? null,
      cost: tab.cost?.usd ?? tab.claude?.usage?.estimatedUsd ?? null,
      wsId: ws?.id,
      wsName: ws?.name,
      cwd: ws?.cwd ?? null,
      startedAt: tab.startedAt,
      closedAt: Date.now(),
      noHistory: !keepsOutput,
      lines,
      earlier: keepsOutput ? tab.id : null,
    },
  });
  emit(EVENTS.history);
}

/**
 * Moves a tab to another workspace; its shell keeps running.
 * @param {Tab} tab
 * @param {string} targetWsId
 */
export function moveTab(tab, targetWsId) {
  const from = /** @type {Workspace} */ (wsById(tab.wsId));
  const to = wsById(targetWsId);
  if (!to || from === to) return;
  const sibling = detachLeaf(from, tab.id);
  dropLonePreview(from);
  if (from.focusId === tab.id) from.focusId = sibling ? firstTabOf(sibling) ?? tabsOf(from)[0]?.id ?? null : null;
  tab.wsId = to.id;
  insertLeaf(to, tab);
  to.focusId = tab.id;
  renderWorkspace(from);
  renderWorkspace(to);
  switchWorkspace(to.id);
  persist();
}

// ---- Terminals in windows of their own (js/windows.js) ----

/** @param {Tab} tab */
const windowKey = tab => `tab-${tab.id}`;
/** A pane title bar's name, which a double click renames (js/rename.js). */
export const PANE_NAME = '.pane-name';

/** The menu entries that detach a terminal and bring it back (js/tabmenu.js). */
export const DETACH_LABEL = 'Detach to a window';
export const ATTACH_LABEL = 'Back to the workspace';

/**
 * Moves a terminal into a window of its own. It stays where it is until the window is ready; then its place in the
 * layout is kept (the layout is drawn without it), and closing the window puts it back there.
 * @param {Tab} tab
 * @param {{ x: number, y: number }} [at] where on the screen it opens (a drag's drop), else over where the pane is
 */
export function detachTab(tab, at) {
  const ws = wsById(tab.wsId);
  if (!ws || !tab.view || tab.detached) return;
  const { el } = tab.view;
  detach(windowKey(tab), {
    el, title: tabTitle(tab), at, onClosed: () => attachTab(tab), onMoved: () => moved(tab), onResize: scheduleFit,
    // Its title bar is the window's; Close there closes the terminal, and its name keeps its double click (rename).
    header: tab.view.header, close: () => closeTab(tab), keepDoubleClick: PANE_NAME,
  });
}

/**
 * A terminal now in its own window: the layout it left is drawn without it.
 * @param {Tab} tab
 */
function moved(tab) {
  const ws = wsById(tab.wsId);
  const view = /** @type {TabView} */ (tab.view);
  tab.detached = true;
  takeBackHeader(tab);
  view.el.classList.remove(TAB_HIDDEN);
  view.term?.focus();
  if (!ws) return;
  // The workspace's focus moves to a terminal still in it.
  if (ws.focusId === tab.id) ws.focusId = tabsOf(ws).find(t => !t.detached)?.id ?? null;
  renderWorkspace(ws);
  emit(EVENTS.tab, tab);
  emit(EVENTS.workspaces);
}

/**
 * A detached terminal back in its workspace, where it was (its window closed, or Back to the workspace).
 * @param {Tab} tab
 */
export function attachTab(tab) {
  if (!tab.detached) return;
  tab.detached = false;
  closeWindow(windowKey(tab), { quiet: true });
  const ws = wsById(tab.wsId);
  if (!ws || !state.tabs.has(tab.id)) return;
  renderWorkspace(ws);
  emit(EVENTS.tab, tab);
  emit(EVENTS.workspaces);
  if (ws.id === state.activeId) focusTab(tab); else ws.focusId = tab.id;
}

/**
 * What a workspace shows while all its terminals are in windows of their own: a button that brings them back.
 * @param {Workspace} ws
 */
function allDetachedNote(ws) {
  const el = document.createElement('div');
  el.className = 'empty';
  el.innerHTML = '<p>This workspace’s terminals are in windows of their own</p><button>Bring them back</button>';
  find(el, 'button').addEventListener('click', () => { for (const tab of tabsOf(ws)) attachTab(tab); });
  return el;
}

// ---- Focus and workspaces ----

/**
 * Focuses a tab, switching to its workspace if needed. Looking at a tab clears its attention dot.
 * @param {Tab | null | undefined} tab
 */
export function focusTab(tab) {
  if (!tab || !state.tabs.has(tab.id)) return;
  const ws = wsById(tab.wsId);
  if (!ws) {
    // The scratch terminal (scratch.js) belongs to no workspace.
    markSeen(tab);
    tab.view?.term?.focus();
    return;
  }
  if (tab.detached) {
    // In a window of its own: that window comes to the front, and the workspace keeps its own focused terminal.
    markSeen(tab);
    wake(tab);
    focusWindow(windowKey(tab));
    tab.view?.term?.focus();
    if (tab.attention) {
      tab.attention = false;
      emit(EVENTS.tab, tab);
    }
    return;
  }
  const wsChanged = ws.id !== state.activeId;
  const focusChanged = ws.focusId !== tab.id;
  ws.focusId = tab.id;
  markSeen(tab);
  wake(tab);
  if (wsChanged) {
    switchWorkspace(ws.id);
    return;
  }
  for (const t of tabsOf(ws)) t.view?.el.classList.toggle('focused', t === tab);
  // In a tab group, focusing a terminal shows its tab.
  const group = groupOf(ws, tab.id);
  if (group && group.active !== tab.id) {
    group.active = tab.id;
    showGroupTab(group);
    persist();
  }
  tab.view?.term?.focus();
  if (tab.attention) {
    tab.attention = false;
    emit(EVENTS.tab, tab);
  }
  if (focusChanged) {
    emit(EVENTS.focus, tab);
    persist();
  }
}

/** @param {string} id */
export function switchWorkspace(id) {
  const ws = wsById(id);
  if (!ws) return;
  state.activeId = id;
  for (const [wsId, layer] of layers) layer.classList.toggle('active', wsId === id);
  emit(EVENTS.workspaces);
  persist();
  scheduleFit();
  const tab = state.tabs.get(/** @type {string} */ (ws.focusId)) ?? tabsOf(ws)[0];
  if (tab) {
    ws.focusId = tab.id;
    focusTab(tab);
    // The terminal in focus is another one now, though it's the one this workspace had (focusTab only tells when
    // that changes): the Files panel follows it.
    emit(EVENTS.focus, tab);
  } else {
    restoreFocus();
  }
}

/** Gives keyboard focus back to where it belongs: the focused terminal, or an empty state's button. */
export function restoreFocus() {
  const tab = focusedTab();
  const ws = activeWs();
  if (tab?.view?.term) tab.view.term.focus();
  else if (ws) /** @type {HTMLElement | null} */ (layerOf(ws).querySelector('.empty button'))?.focus();
  else {
    // Show the no-workspaces state now (the sidebar would on its next frame) so its button can take focus.
    document.body.classList.add(NO_WORKSPACES);
    /** @type {HTMLElement | null} */ (document.querySelector('#no-workspaces button'))?.focus();
  }
}

/**
 * Moves focus to the nearest pane on the given side of the focused one.
 * @param {string} direction
 */
export function moveFocus(direction) {
  const current = focusedTab();
  if (!current) return;
  const a = /** @type {TabView} */ (current.view).el.getBoundingClientRect();
  let best = null;
  let bestDistance = Infinity;
  for (const t of tabsOf(/** @type {Workspace} */ (activeWs()))) {
    if (t === current || t.detached || /** @type {TabView} */ (t.view).el.classList.contains(TAB_HIDDEN)) continue;
    const b = /** @type {TabView} */ (t.view).el.getBoundingClientRect();
    const overlapsY = b.top < a.bottom && b.bottom > a.top;
    const overlapsX = b.left < a.right && b.right > a.left;
    let distance = Infinity;
    if (direction === DIRECTION.left && overlapsY && b.right <= a.left + 1) distance = a.left - b.right;
    if (direction === DIRECTION.right && overlapsY && b.left >= a.right - 1) distance = b.left - a.right;
    if (direction === DIRECTION.up && overlapsX && b.bottom <= a.top + 1) distance = a.top - b.bottom;
    if (direction === DIRECTION.down && overlapsX && b.top >= a.bottom - 1) distance = b.top - a.bottom;
    if (distance < bestDistance) {
      best = t;
      bestDistance = distance;
    }
  }
  if (best) focusTab(best);
}

// ---- Rendering ----

export function renderAll() {
  for (const ws of [...state.workspaces, ...state.remoteSpaces]) renderWorkspace(ws);
  for (const [wsId, layer] of layers) {
    if (!wsById(wsId)) {
      layer.remove();
      layers.delete(wsId);
    }
  }
  for (const [wsId, layer] of layers) layer.classList.toggle('active', wsId === state.activeId);
}

/** @param {Workspace} ws */
export function renderWorkspace(ws) {
  const layer = layerOf(ws);
  layer.classList.toggle('active', ws.id === state.activeId);
  if (!ws.root) {
    layer.replaceChildren(emptyTemplate.content.cloneNode(true));
    return;
  }
  for (const tab of tabsOf(ws)) if (!tab.view) createView(tab);
  // Every tab has its view from here on (made just above).
  for (const tab of tabsOf(ws)) {
    /** @type {TabView} */ (tab.view).el.classList.remove(TAB_HIDDEN);
    takeBackHeader(tab);
  }
  drawing = ws;
  layer.replaceChildren(renderNode(ws.root) ?? allDetachedNote(ws));
  drawing = null;
  for (const tab of tabsOf(ws)) {
    /** @type {TabView} */ (tab.view).el.classList.toggle('focused', tab.id === ws.focusId);
    if (!(/** @type {TabView} */ (tab.view).term)) openTerminal(tab);
  }
  scheduleFit();
}

/**
 * A title bar lent to a group's tab goes back to the top of its pane.
 * @param {Tab} tab
 */
function takeBackHeader(tab) {
  const { el, header } = /** @type {TabView} */ (tab.view);
  if (header && header.parentElement !== el) el.prepend(header);
}

/**
 * Removes a workspace's layer (its tabs must already be closed or moved).
 * @param {string} wsId
 */
export function dropLayer(wsId) {
  layers.get(wsId)?.remove();
  layers.delete(wsId);
}

// ---- The change preview's pane (js/preview.js) ----

/** @type {(ws: Workspace | null) => HTMLElement} */
let previewElement = () => document.createElement('div');
/** The workspace renderWorkspace draws: each workspace has its own preview pane, and only one shows it. */
/** @type {Workspace | null} */
let drawing = null;

/**
 * preview.js hands over its element this way, so the two modules don't import each other. It's given the
 * workspace drawn.
 * @param {(ws: Workspace | null) => HTMLElement} fn
 */
export function setPreviewRenderer(fn) {
  previewElement = fn;
}

/**
 * Puts the change preview's pane beside a terminal, in a split along the longer side.
 * @param {Workspace} ws
 * @param {string} tabId
 */
export function insertPreview(ws, tabId) {
  const anchor = findLeaf(ws, tabId) ?? [...leaves(ws.root)].pop();
  if (!anchor) return false;
  const r = state.tabs.get(anchor.tabId)?.view?.el.getBoundingClientRect();
  const dir = !r || r.width >= r.height * WIDE_FOR_PREVIEW ? SPLIT.row : SPLIT.column;
  ws.root = replaceNode(ws.root, anchor,
    { kind: NODE.split, dir, ratio: SPLIT_EVEN, a: anchor, b: { kind: NODE.preview } });
  renderWorkspace(ws);
  return true;
}

/**
 * Takes the change preview's pane out of a workspace.
 * @param {Workspace} ws
 */
export function removePreview(ws) {
  if (!findPreview(ws.root)) return;
  ws.root = withoutPreview(ws.root);
  renderWorkspace(ws);
}

/**
 * A workspace whose last terminal went has nothing for the preview to sit beside: it goes too.
 * @param {Workspace} ws
 */
function dropLonePreview(ws) {
  if (ws.root && !leaves(ws.root).next().value) {
    ws.root = null;
    emit(EVENTS.previewDropped, ws);
  }
}

/**
 * A part of the layout; null when every terminal in it is in a window of its own (it's drawn without them, and a
 * split with one side gone is just its other side).
 * @param {LayoutNode} node
 * @returns {HTMLElement | null}
 */
function renderNode(node) {
  if (node.kind === NODE.leaf) {
    const tab = /** @type {Tab} */ (state.tabs.get(node.tabId));
    return tab.detached ? null : /** @type {TabView} */ (tab.view).el;
  }
  if (node.kind === NODE.preview) return previewElement(drawing);
  if (node.kind === NODE.tabs) return renderGroup(node);
  const a = renderNode(node.a);
  const b = renderNode(node.b);
  if (!a || !b) return a ?? b;

  const split = document.createElement('div');
  split.className = `split ${node.dir}`;
  const cellA = document.createElement('div');
  const cellB = document.createElement('div');
  cellA.className = cellB.className = 'cell';
  const setSizes = () => {
    cellA.style.flex = `${node.ratio} 1 0`;
    cellB.style.flex = `${1 - node.ratio} 1 0`;
  };
  setSizes();
  cellA.append(a);
  cellB.append(b);

  const divider = document.createElement('div');
  divider.className = 'divider';
  divider.addEventListener('pointerdown', e => {
    e.preventDefault();
    divider.classList.add('dragging');
    dragPointer(divider, e, ev => {
      const r = split.getBoundingClientRect();
      const ratio = node.dir === SPLIT.row ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      node.ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
      setSizes();
      scheduleFit();
    }, () => {
      divider.classList.remove('dragging');
      persist();
      restoreFocus();
    });
  });

  split.append(cellA, divider, cellB);
  return split;
}

// ---- Tab groups ----

/** @type {WeakMap<TabsNode, HTMLElement>} */
const groupElements = new WeakMap(); // a tabs node -> its element, while rendered

/**
 * A tab group: a strip with a tab per terminal over their panes. Every pane stays laid out at the group's size and
 * only the shown one is visible, so switching tabs never resizes a terminal.
 * @param {TabsNode} node
 */
function renderGroup(node) {
  // Its terminals in windows of their own aren't in it while they're away; the group shows another as its tab.
  const items = node.items.filter(item => !state.tabs.get(item.tabId)?.detached);
  if (!items.length) return null;
  if (!items.some(item => item.tabId === node.active)) node.active = items[0].tabId;
  const group = document.createElement('div');
  group.className = 'tab-group';
  const strip = document.createElement('div');
  strip.className = 'tab-strip';
  strip.setAttribute('role', 'tablist');
  const body = document.createElement('div');
  body.className = 'tab-group-body';
  for (const item of items) {
    const tab = /** @type {Tab} */ (state.tabs.get(item.tabId));
    strip.append(stripTab(tab));
    body.append(/** @type {TabView} */ (tab.view).el);
  }
  group.append(stripBar(strip), body);
  groupElements.set(node, group);
  showGroupTab(node);
  return group;
}

/**
 * The strip with a < and > button on either side, shown only when its tabs don't fit: each scrolls the strip by
 * most of its width. The mouse wheel scrolls it sideways too. A tab group's strip, and the Notepad's (js/notepad.js).
 * @param {HTMLElement} strip
 */
export function stripBar(strip) {
  const bar = document.createElement('div');
  bar.className = 'tab-strip-bar';
  /**
   * @param {string} dir
   * @param {string} icon
   * @param {string} label
   */
  const button = (dir, icon, label) => {
    const b = document.createElement('button');
    b.className = `strip-scroll ${dir}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon;
    b.addEventListener('click', () => strip.scrollBy({
      left: (dir === DIRECTION.left ? -1 : 1) * Math.max(STRIP_SCROLL_MIN_PX, strip.clientWidth * STRIP_SCROLL_SHARE),
      behavior: 'smooth',
    }));
    return b;
  };
  const left = button(DIRECTION.left, ICONS.chevronLeft, 'Scroll the tabs left');
  const right = button(DIRECTION.right, ICONS.chevronRight, 'Scroll the tabs right');
  const update = () => {
    const overflow = strip.scrollWidth > strip.clientWidth + 1;
    bar.classList.toggle('overflow', overflow);
    left.disabled = !overflow || strip.scrollLeft <= 0;
    right.disabled = !overflow || strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
  };
  strip.addEventListener('scroll', update, { passive: true });
  strip.addEventListener('wheel', e => {
    if (strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  }, { passive: false });
  new ResizeObserver(update).observe(strip);
  // Tabs added or closed change whether they fit, as the strip's size does.
  new MutationObserver(() => requestAnimationFrame(update)).observe(strip, { childList: true });
  bar.append(left, strip, right);
  requestAnimationFrame(update);
  return bar;
}

/**
 * One tab in a group's strip: its shell's badge (Claude's mark while Claude Code runs there), its name, what it's doing
 * and a close button, kept up to date like the title bar. Drag it like a pane's title bar.
 * @param {Tab} tab
 */
function stripTab(tab) {
  const el = document.createElement('div');
  el.className = STRIP_TAB;
  el.dataset.tab = tab.id;
  el.setAttribute('role', 'tab');
  el.innerHTML = `<span class="strip-badge"></span><span class="strip-name"></span><span class="strip-activity"></span><button class="strip-close" title="Close terminal (Ctrl+Shift+W)">${ICONS.close}</button>`;
  find(el, '.strip-close').addEventListener('click', () => closeTab(tab));
  // A middle click closes the tab, as in a browser.
  onMiddleClick(el, () => closeTab(tab));
  el.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  wireDrag(tab, el);
  updateStripTab(tab, el);
  return el;
}

/**
 * @param {Tab} tab
 * @param {HTMLElement} el
 */
function updateStripTab(tab, el) {
  find(el, '.strip-name').textContent = tabTitle(tab);
  el.title = tabTitle(tab);
  const activity = activityOf(tab);
  if (activity) el.dataset.activity = activity.kind; else delete el.dataset.activity;
  // Only touched when they change, so a spinner isn't restarted by every update.
  const badge = find(el, '.strip-badge'), badgeHtml = tabBadgeHtml(tab);
  if (badge.dataset.html !== badgeHtml) { badge.dataset.html = badgeHtml; badge.innerHTML = badgeHtml; }
  const slot = find(el, '.strip-activity'), html = activityHtml(activity);
  if (slot.dataset.html !== html) { slot.dataset.html = html; slot.innerHTML = html; }
  el.classList.toggle(ATTENTION, !!tab.attention);
  // Production or staging (environments.js colours the pane): the tab gets the same colour for its title bar.
  const env = tab.view?.el.style.getPropertyValue(ENV_COLOR);
  el.classList.toggle(ENV_CLASS, !!env);
  if (env) el.style.setProperty(ENV_COLOR, env); else el.style.removeProperty(ENV_COLOR);
}

on(EVENTS.tab, tab => {
  if (tab.detached) setWindowTitle(windowKey(tab), tabTitle(tab));
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(`.strip-tab[data-tab="${tab.id}"]`))) {
    updateStripTab(tab, el);
  }
});
// Settings can change what the badge and the activity show (profile icons, Show activity).
on(EVENTS.settings, () => {
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(`.${STRIP_TAB}`))) {
    const tab = state.tabs.get(/** @type {string} */ (el.dataset.tab));
    if (tab) updateStripTab(tab, el);
  }
});

/**
 * Puts every terminal of a workspace in one tab group, in layout order, with the focused one shown. The change
 * preview's pane, if it's open, stays beside the group.
 * @param {Workspace | undefined} ws
 */
export function moveAllToTabs(ws) {
  const tabs = ws ? tabsOf(ws) : [];
  // Past this line there are terminals, so there is a workspace (the casts below say so).
  if (tabs.length < 2 || allInTabs(/** @type {Workspace} */ (ws))) return;
  const shown = state.tabs.has(/** @type {string} */ (/** @type {Workspace} */ (ws).focusId))
    ? /** @type {string} */ (/** @type {Workspace} */ (ws).focusId)
    : tabs[0].id;
  /** @type {TabsNode} */
  const group = { kind: NODE.tabs, items: tabs.map(t => ({ kind: NODE.leaf, tabId: t.id })), active: shown };
  /** @type {Workspace} */ (ws).root = findPreview(/** @type {Workspace} */ (ws).root)
    ? { kind: NODE.split, dir: SPLIT.row, ratio: SPLIT_EVEN, a: group, b: { kind: NODE.preview } }
    : group;
  /** @type {Workspace} */ (ws).focusId = shown;
  renderWorkspace(/** @type {Workspace} */ (ws));
  emit(EVENTS.workspaces);
  persist();
  if (/** @type {Workspace} */ (ws).id === state.activeId) focusTab(state.tabs.get(shown));
}

/**
 * Whether all of a workspace's terminals are already tabs of one group.
 * @param {Workspace} ws
 */
export const allInTabs = ws => {
  const group = groupOf(ws, /** @type {string} */ (tabsOf(ws)[0]?.id));
  return !!group && group.items.length === tabsOf(ws).length;
};

/**
 * Shows the next (1) or previous (-1) tab of the focused terminal's group. False when it isn't in one.
 * @param {number} step
 */
export function cycleGroupTab(step) {
  const ws = activeWs();
  const group = ws ? groupOf(ws, /** @type {string} */ (ws.focusId)) : null;
  if (!group) return false;
  const at = group.items.findIndex(i => i.tabId === group.active);
  focusTab(state.tabs.get(group.items[(at + step + group.items.length) % group.items.length].tabId));
  return true;
}

/**
 * Shows a group's active tab, in place (no new elements, so a drag that starts on a tab keeps its pointer).
 * @param {TabsNode} node
 */
function showGroupTab(node) {
  const group = groupElements.get(node);
  if (!group) return;
  for (const item of node.items) {
    if (state.tabs.get(item.tabId)?.detached) continue;
    const shown = item.tabId === node.active;
    state.tabs.get(item.tabId)?.view?.el.classList.toggle(TAB_HIDDEN, !shown);
    const tabEl = /** @type {HTMLElement | null} */ (group.querySelector(`.tab-strip > [data-tab="${item.tabId}"]`));
    tabEl?.classList.toggle('active', shown);
    tabEl?.setAttribute('aria-selected', String(shown));
    // The shown tab carries its terminal's title bar (name, status, chips and buttons), so the pane needs none of
    // its own; the others keep theirs, hidden, in their panes.
    const tab = state.tabs.get(item.tabId);
    const header = tab?.view?.header;
    if (header && tabEl) {
      if (shown) tabEl.append(header);
      // It has a header, so it has its view.
      else if (header.parentElement !== /** @type {TabView} */ (/** @type {Tab} */ (tab).view).el) {
        /** @type {TabView} */ (/** @type {Tab} */ (tab).view).el.prepend(header);
      }
      tabEl.classList.toggle('has-header', shown);
    }
    // The shown tab scrolls into the strip's view when the tabs don't all fit.
    if (shown && tabEl) requestAnimationFrame(() => {
      const strip = /** @type {HTMLElement} */ (tabEl.parentElement);
      const left = tabEl.offsetLeft - strip.offsetLeft, right = left + tabEl.offsetWidth;
      if (left < strip.scrollLeft) strip.scrollLeft = left - STRIP_TAB_MARGIN_PX;
      else if (right > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = right - strip.clientWidth + STRIP_TAB_MARGIN_PX;
      }
    });
  }
}

// ---- Drag and drop within a workspace ----

const DRAG_THRESHOLD = 5;
/** Where the dragged pane's label floats, from the pointer. */
const GHOST_OFFSET = Object.freeze({ x: 14, y: 12 });
/** @type {Record<Zone, string>} */
const ZONE_LABELS = { left: 'Split left', right: 'Split right', top: 'Split up', bottom: 'Split down', center: 'Add as a tab', window: DETACH_LABEL };

/**
 * Drag a pane by its header (or its tab in a group); every other pane in the workspace shows where it can land.
 * @param {Tab} tab
 * @param {HTMLElement} header
 */
function wireDrag(tab, header) {
  header.addEventListener('pointerdown', e => {
    // A terminal in a window of its own has no layout to be dragged in.
    if (e.button !== 0 || tab.detached || targetOf(e).closest('button, input')) return;
    // A tab holding its terminal's title bar: the title bar's own handler takes the drag.
    if (header.classList.contains(STRIP_TAB) && targetOf(e).closest('.pane-header')) return;
    e.preventDefault();
    focusTab(tab);
    trackDrag(tab, header, e);
  });
}

/**
 * Follows one press on a pane's header: past the threshold it's a drag, and letting go drops the pane.
 * @param {Tab} tab
 * @param {HTMLElement} header
 * @param {PointerEvent} e
 */
function trackDrag(tab, header, e) {
  const start = { x: e.clientX, y: e.clientY };
  let dragging = false;
  /** @type {Drop | null} */
  let drop = null;
  /** Where the pointer is on the screen: a window it's dropped into opens there. */
  let screen = { x: e.screenX, y: e.screenY };
  header.setPointerCapture(e.pointerId);

  /** @param {PointerEvent} ev */
  const onMove = ev => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      // A lone terminal can go nowhere but out into a window of its own; that works too.
      dragging = true;
      beginDrag(tab);
    }
    dragGhost.style.transform = `translate(${ev.clientX + GHOST_OFFSET.x}px, ${ev.clientY + GHOST_OFFSET.y}px)`;
    screen = { x: ev.screenX, y: ev.screenY };
    drop = findDropTarget(tab, ev.clientX, ev.clientY);
    showDrop(drop);
  };
  /** @param {boolean} commit */
  const finish = commit => {
    header.removeEventListener('pointermove', onMove);
    header.removeEventListener('pointerup', onUp);
    header.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId);
    if (!dragging) return;
    endDrag(tab);
    if (commit && drop) dropPane(tab, drop, screen);
    else focusTab(tab);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  /** @param {KeyboardEvent} ev */
  const onKey = ev => {
    if (ev.key !== 'Escape') return;
    // Capture phase, so the Escape never reaches the terminal.
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };

  header.addEventListener('pointermove', onMove);
  header.addEventListener('pointerup', onUp);
  header.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}

/**
 * A dragged pane let go over a drop: beside or into another, or out into a window of its own where it was let go.
 * @param {Tab} tab
 * @param {Drop} drop
 * @param {{ x: number, y: number }} screen
 */
function dropPane(tab, drop, screen) {
  if (drop.zone === ZONE.window) detachTab(tab, screen);
  else movePane(tab, drop.target, drop.zone);
}

/** @param {Tab} source */
function beginDrag(source) {
  document.body.classList.add(DRAGGING_PANE);
  // The terminal's own badge, as its title bar shows it, and its name.
  find(dragGhost, '.ghost-badge').innerHTML = tabBadgeHtml(source);
  find(dragGhost, '.ghost-name').textContent = tabTitle(source);
  /** @type {TabView} */ (source.view).el.classList.add(DRAG_SOURCE);
  for (const t of tabsOf(/** @type {Workspace} */ (wsById(source.wsId)))) {
    if (t !== source && !t.detached) {
      /** @type {TabView} */ (t.view).el.append(/** @type {Element} */ (dockGuideTemplate.content.firstElementChild).cloneNode(true));
    }
  }
}

/** @param {Tab} source */
function endDrag(source) {
  document.body.classList.remove(DRAGGING_PANE);
  /** @type {TabView} */ (source.view).el.classList.remove(DRAG_SOURCE);
  for (const guide of document.querySelectorAll('.pane > .dock-guide')) guide.remove();
  showDrop(null);
}

/**
 * Which pane is under the pointer, and which of its zones: a compass cell it's on, its title bar (join as a tab),
 * else its top or bottom third, else its left or right half. Over a group's tab strip it's always the middle (join the group). A tab dragged within
 * its own group can only leave it,
 * beside it. At the app window's edge it goes out into a window of its own.
 * @param {Tab} source
 * @param {number} x
 * @param {number} y
 * @returns {Drop | null}
 */
function findDropTarget(source, x, y) {
  // At the app window's very edge, or out of it: into a window of its own.
  if (x <= WINDOW_EDGE_PX || y <= WINDOW_EDGE_PX || x >= innerWidth - WINDOW_EDGE_PX || y >= innerHeight - WINDOW_EDGE_PX) {
    return windowDrop(source, x, y);
  }
  const ws = /** @type {Workspace} */ (wsById(source.wsId));
  const under = document.elementFromPoint(x, y);
  const strip = under?.closest('.tab-strip');
  if (strip) {
    const groupEl = /** @type {HTMLElement} */ (strip.closest('.tab-group'));
    const target = state.tabs.get(
      /** @type {string} */ (/** @type {HTMLElement | null} */ (groupEl.querySelector('.strip-tab.active'))?.dataset.tab));
    if (!target || target.wsId !== source.wsId || groupOf(ws, target.id) === groupOf(ws, source.id)) return null;
    return { target, zone: ZONE.center, rect: strip.getBoundingClientRect() }; // the strip it joins, outlined
  }
  const el = /** @type {HTMLElement | null | undefined} */ (under?.closest('.pane'));
  const target = el && state.tabs.get(/** @type {string} */ (el.dataset.tab));
  if (!target || target.wsId !== source.wsId) return null;
  const ownGroup = target === source && groupOf(ws, source.id);
  if (target === source && !ownGroup) return null;
  const drop = paneZone(/** @type {HTMLElement} */ (el), target, x, y);
  if (drop.zone === ZONE.window) return windowDrop(source, x, y, target);
  if (ownGroup) {
    // Out of its own group: beside the whole group.
    if (drop.zone === ZONE.center) return null;
    drop.rect = groupElements.get(ownGroup)?.getBoundingClientRect() ?? drop.rect;
  } else if (groupOf(ws, target.id) && drop.zone !== ZONE.center) {
    // Beside a group, not inside it: the preview covers the whole group.
    drop.rect = groupElements.get(/** @type {TabsNode} */ (groupOf(ws, target.id)))?.getBoundingClientRect() ?? drop.rect;
  }
  return drop;
}

/**
 * @param {HTMLElement} el
 * @param {Tab} target
 * @param {number} x
 * @param {number} y
 * @returns {Drop}
 */
function paneZone(el, target, x, y) {
  const r = el.getBoundingClientRect();
  // Over the docking compass in the middle, its cells pick the zone: no need to go to the pane's edge.
  for (const cell of /** @type {NodeListOf<HTMLElement>} */ (el.querySelectorAll(':scope > .dock-guide > .dock-cell'))) {
    const c = cell.getBoundingClientRect();
    if (x >= c.left - 2 && x <= c.right + 2 && y >= c.top - 2 && y <= c.bottom + 2) {
      return { target, zone: /** @type {Zone} */ (cell.dataset.zone), rect: r };
    }
  }
  // Over its title bar it joins as a tab, as over a group's strip of tabs; the outline is the title bar alone.
  const head = el.querySelector(':scope > .pane-header')?.getBoundingClientRect();
  if (head && y >= head.top && y <= head.bottom) return { target, zone: ZONE.center, rect: head };
  // Anywhere else splits it: above or below in the top and bottom thirds of what's under the title bar, else left or
  // right by the half the pointer is in, so the outline shows as soon as the pointer is in and changes side right at
  // the middle.
  const below = head?.bottom ?? r.top;
  const strip = (r.bottom - below) * TOP_BOTTOM_SHARE;
  /** @type {Zone} */
  const zone = y < below + strip ? ZONE.top
    : y > r.bottom - strip ? ZONE.bottom
      : x < r.left + r.width / 2 ? ZONE.left : ZONE.right;
  // Above, the outline leaves the title bar out (that's where it would join as a tab).
  if (zone === ZONE.top) return { target, zone, rect: new DOMRect(r.left, below, r.width, r.bottom - below) };
  return { target, zone, rect: r };
}

/**
 * Dropping a pane into a window of its own: the outline is the window where it opens, the pane's shape but smaller.
 * @param {Tab} source
 * @param {number} x
 * @param {number} y
 * @param {Tab} [over] the pane whose compass cell it's on
 * @returns {Drop}
 */
function windowDrop(source, x, y, over) {
  const pane = /** @type {TabView} */ (source.view).el.getBoundingClientRect();
  const scale = Math.min(1, WINDOW_PREVIEW.w / pane.width, WINDOW_PREVIEW.h / pane.height);
  const w = pane.width * scale, h = pane.height * scale;
  // Where the window will open: its corner just before the pointer (js/windows.js).
  const left = Math.max(0, Math.min(innerWidth - w, x - OFFSET_PX));
  const top = Math.max(0, Math.min(innerHeight - h, y - OFFSET_PX));
  return { target: source, zone: ZONE.window, rect: new DOMRect(left, top, w, h), over };
}

/** @param {Drop | null} drop */
function showDrop(drop) {
  // Out into a window: the compass cell it's on lights up, or at the app window's edge every compass's.
  const outToWindow = drop?.zone === ZONE.window;
  const shownOn = outToWindow ? drop.over : drop?.target;
  for (const guide of document.querySelectorAll('.pane > .dock-guide')) {
    const isTarget = !!shownOn && guide.parentElement === /** @type {TabView} */ (shownOn.view).el;
    const lit = isTarget || (outToWindow && !shownOn);
    guide.classList.toggle('hover', lit);
    for (const cell of /** @type {HTMLCollectionOf<HTMLElement>} */ (guide.children)) {
      // lit is only true with a drop.
      cell.classList.toggle('active', lit && cell.dataset.zone === /** @type {Drop} */ (drop).zone);
    }
  }
  if (!drop) {
    dropPreview.classList.remove(VISIBLE);
    return;
  }
  const { rect: r, zone } = drop;
  const half = { w: r.width / 2, h: r.height / 2 };
  const box = {
    left: { x: r.left, y: r.top, w: half.w, h: r.height },
    right: { x: r.left + half.w, y: r.top, w: half.w, h: r.height },
    top: { x: r.left, y: r.top, w: r.width, h: half.h },
    bottom: { x: r.left, y: r.top + half.h, w: r.width, h: half.h },
    center: { x: r.left, y: r.top, w: r.width, h: r.height },
    window: { x: r.left, y: r.top, w: r.width, h: r.height },
  }[zone];
  // Shown afresh, it's at its place at once rather than sliding from where it was last.
  const appearing = !dropPreview.classList.contains(VISIBLE);
  dropPreview.classList.toggle(PLACING, appearing);
  Object.assign(dropPreview.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  /** @type {Element} */ (dropPreview.firstElementChild).textContent = ZONE_LABELS[zone];
  dropPreview.classList.add(VISIBLE);
  if (appearing) {
    void dropPreview.offsetWidth; // the place is taken before the sliding comes back
    dropPreview.classList.remove(PLACING);
  }
}

/**
 * Moves a pane next to another (left/right/top/bottom; beside the whole group when that one is in a tab group), or
 * into it as a tab (center: the two become a tab group, or the pane joins the target's group, after its tab).
 * @param {Tab} source
 * @param {Tab} target
 * @param {Zone} zone
 */
function movePane(source, target, zone) {
  const ws = /** @type {Workspace} */ (wsById(source.wsId));
  /** @type {LeafNode} */
  const leaf = { kind: NODE.leaf, tabId: source.id };
  if (zone === ZONE.center) {
    if (groupOf(ws, source.id) && groupOf(ws, source.id) === groupOf(ws, target.id)) return;
    detachLeaf(ws, source.id);
    const group = groupOf(ws, target.id);
    if (group) {
      group.items.splice(group.items.findIndex(i => i.tabId === target.id) + 1, 0, leaf);
      group.active = source.id;
    } else {
      const targetLeaf = /** @type {LeafNode} */ (findLeaf(ws, target.id));
      ws.root = replaceNode(ws.root, targetLeaf, { kind: NODE.tabs, items: [targetLeaf, leaf], active: source.id });
    }
  } else {
    // Leaving its own group, the pane goes beside what's left of the group.
    const rest = detachLeaf(ws, source.id);
    const anchor = /** @type {LayoutNode} */ (target === source ? rest : groupOf(ws, target.id) ?? findLeaf(ws, target.id));
    const before = zone === ZONE.left || zone === ZONE.top;
    ws.root = replaceNode(ws.root, anchor, {
      kind: NODE.split,
      dir: zone === ZONE.left || zone === ZONE.right ? SPLIT.row : SPLIT.column,
      ratio: SPLIT_EVEN,
      a: before ? leaf : anchor,
      b: before ? anchor : leaf,
    });
  }
  ws.focusId = source.id;
  renderWorkspace(ws);
  emit(EVENTS.workspaces); // the sidebar lists terminals in layout order
  focusTab(source);
  persist();
}

// ---- Output ----

/**
 * Marks a tab in a hidden workspace as having new output (start-up and resize repaints don't count).
 * @param {Tab} tab
 */
export function noteOutput(tab) {
  if (tab.wsId === state.activeId || tab.attention || Date.now() < (tab.quietUntil ?? 0)) return;
  tab.attention = true;
  emit(EVENTS.tab, tab);
}
