// @ts-check
// The workspace navigator: a sidebar that toggles between open, an icon rail, or hidden.

import {
  state, on, emit, persist, wsById, tabsOf, tabTitle, tagColor, WORKSPACE_COLORS, activityOf, mostUrgentActivity,
  isUnread, EVENTS, ACTIVITY,
} from './store.js';
import { showMenu, SEPARATOR } from './popups.js';
import { tabBadgeHtml, tagChipHtml, escapeHtml, cssColor, ICONS, activityHtml } from './ui.js';
import { focusTab, switchWorkspace, newTab, restoreFocus, moveAllToTabs, allInTabs, NO_WORKSPACES } from './panes.js';
import { exportLayout } from './layouts.js';
import { scheduleFit } from './terminals.js';
import { openTabMenu, RENAME_LABEL, NOTE_LABEL, GIT_LABEL } from './tabmenu.js';
import { openTagPicker } from './tagpicker.js';
import {
  renameWorkspace, setWorkspaceColor, closeWorkspace, nameTakenMessage, MAX_WORKSPACE_NAME,
} from './workspaces.js';
import { confirmDialog } from './dialogs.js';
import { openPalette, PALETTE_VIEW } from './palette.js';
import { editNote, notesFor, noteTitle, firstLine, NOTE_KIND } from './notes.js';
import { environmentOf } from './environments.js';
import { showsLine, isAgentWorking, stopAgent, stopAllAgents } from './agentline.js';
import { subagentRowsHtml, runningSubagents } from './subagents.js';
import { costOf, costText, costTitle, workspaceCost, dollars, costMode } from './cost.js';
import { tabProjectHtml, openPort, repoOf } from './gitstatus.js';
import { remoteRailHtml, openRemoteMenu } from './remote.js';
import { openNewWorkspace } from './newworkspace.js';
import { hasUnreadResults } from './results.js';
import { SETTING_VALUES } from './constants.js';
import { byId, find, targetOf, dragPointer, showError } from './dom.js';
import { RENAME_INPUT_CLASS } from './rename.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { costDisplay } = SETTING_VALUES;

/** A workspace's row in the list, and its tile on the icon rail. */
const WS_ROW = '.ws-row';
const RAIL_TILE = '.rail-tile';
/** The rail's flyout while it's shown. */
const SHOWN = 'show';
/** A tab row whose tags collapsed to the first one and "+N". */
const COLLAPSED = 'collapsed';
/** The body's class while the sidebar's edge is dragged. */
const RESIZING = 'resizing-sidebar';

const sidebar = byId('sidebar');
const list = byId('ws-list');
const rail = byId('ws-rail');
const flyout = byId('ws-flyout');
// In the sidebar header, and atop the icon rail.
const toggles = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.sidebar-toggle'));
const crumb = byId('crumb');
/** The rail's "+", on a 14-unit grid drawn at 14 px so its lines land on whole pixels (as in the sidebar header). */
const RAIL_PLUS = '<svg viewBox="0 0 14 14"><path d="M7.5 3v9M3 7.5h9"/></svg>';

const CHEVRON = '<svg viewBox="0 0 12 12"><path d="M4.5 3L7.5 6 4.5 9"/></svg>';
/** Names for WORKSPACE_COLORS, in the same order. */
const COLOR_NAMES = ['Violet', 'Red', 'Amber', 'Green', 'Blue', 'Pink', 'Cyan', 'Grey'];
const hasAttention = (/** @type {Workspace} */ ws) => tabsOf(ws).some(t => t.attention);
/**
 * How many of a workspace's terminals have agent news the user hasn't looked at.
 * @param {Workspace} ws
 */
const unreadCount = ws => tabsOf(ws).filter(isUnread).length;
/**
 * A workspace's most urgent activity (shown where its tabs are hidden): a waiting agent before a busy command.
 * @param {Workspace} ws
 * @param {string} [extraClass]
 */
function wsActivityHtml(ws, extraClass = 'mini') {
  const activity = mostUrgentActivity(tabsOf(ws));
  if (!activity) return '';
  const busy = activity.kind === ACTIVITY.spin || activity.kind === ACTIVITY.percent;
  const title = busy ? 'A terminal here is busy' : activity.title;
  const kind = activity.kind === ACTIVITY.percent ? ACTIVITY.spin : activity.kind;
  return activityHtml({ ...activity, kind, title }, extraClass);
}

// ---- Open / closed ----

/** @param {boolean} open */
export function setSidebarOpen(open) {
  state.sidebar.open = open;
  applyMode();
  emit(EVENTS.sidebar);
  persist();
}

export const toggleSidebar = () => setSidebarOpen(!state.sidebar.open);

/** @param {string} style */
export function setClosedStyle(style) {
  state.sidebar.closedStyle = style;
  applyMode();
  emit(EVENTS.sidebar);
  persist();
}

function applyMode() {
  const mode = state.sidebar.open ? 'open' : state.sidebar.closedStyle;
  document.body.dataset.sidebar = mode;
  for (const toggle of toggles) {
    toggle.setAttribute('aria-pressed', String(state.sidebar.open));
    toggle.title = `${state.sidebar.open ? 'Hide' : 'Show'} workspaces (Ctrl+Shift+B)`;
  }
  hideFlyout();
}

// ---- Rendering ----

/**
 * @param {Tab} tab
 * @param {Workspace} ws
 */
function tabRowHtml(tab, ws) {
  const focused = ws.id === state.activeId && ws.focusId === tab.id;
  const env = environmentOf(tab);
  return `<button class="tab-row${focused ? ' focused' : ''}${isUnread(tab) ? ' unread' : ''}${env ? ' env' : ''}" data-tab="${escapeHtml(tab.id)}" title="${escapeHtml(tabTitle(tab))}${env ? ` · ${escapeHtml(env.label)}` : ''}"${env ? ` style="--env:${cssColor(env.color)}"` : ''}>
    ${tabBadgeHtml(tab)}<span class="name">${escapeHtml(tabTitle(tab))}</span>${notesFor(tab).length ? `<span class="note-mark" data-note-tab="${escapeHtml(tab.id)}" title="${escapeHtml(`${noteTitle(notesFor(tab))}\nClick to open`)}">${ICONS.note}</span>` : ''}
    <span class="chips">${tabProjectHtml(tab, ws)}${tab.tags.map(t => tagChipHtml(t, { mini: true })).join('')}${tab.tags.length > 1
      ? `<span class="tag mini more-tags" data-more-tags title="Show all tags">+${tab.tags.length - 1}</span>` : ''}${activityHtml(activityOf(tab), 'mini')}${tab.attention ? '<span class="attn"></span>' : ''}${hasUnreadResults(tab) ? '<span class="res-dot" title="New results: a pull request, a running app or a push"></span>' : ''}${costText(costOf(tab)) ? `<span class="cost-chip" title="${escapeHtml(costTitle(costOf(tab)))}">${escapeHtml(costText(costOf(tab)))}</span>` : ''}${runningSubagents(tab) ? `<span class="sub-badge" title="Subagents running">${runningSubagents(tab)} agent${runningSubagents(tab) === 1 ? '' : 's'}</span>` : ''}</span>
    ${isAgentWorking(tab) ? `<span class="agent-stop" data-stop="${escapeHtml(tab.id)}" title="Stop the agent (Esc)" role="button"></span>` : ''}
  </button>${showsLine(tab) ? `<div class="agent-line ${escapeHtml(/** @type {AgentInfo} */ (tab.agent).state)}" data-tab="${escapeHtml(tab.id)}" title="${escapeHtml(/** @type {AgentInfo} */ (tab.agent).line)}">${escapeHtml(/** @type {AgentInfo} */ (tab.agent).line)}</div>` : ''}${subagentRowsHtml(tab)}`;
}

/** A tab name keeps at least this much room before its tags collapse to the first one and "+N". */
const MIN_NAME_WIDTH = 72;

/**
 * Shows every tag when they fit next to the name, otherwise only the first tag and a "+N" dropdown.
 * @param {HTMLElement} root
 */
function fitTags(root) {
  for (const row of root.querySelectorAll('.tab-row')) {
    if (!row.querySelector('.more-tags')) continue;
    row.classList.remove(COLLAPSED);
    const name = find(row, '.name');
    if (name.clientWidth < Math.min(name.scrollWidth, MIN_NAME_WIDTH)) row.classList.add(COLLAPSED);
  }
}

/**
 * @param {Tab} tab
 * @param {HTMLElement} anchor
 */
function openTagsMenu(tab, anchor) {
  showMenu([
    ...tab.tags.map(t => ({
      label: t,
      icon: `<span class="ws-swatch" style="background:${tagColor(t)}"></span>`,
      action: () => openPalette({ query: `tag:${t} ` }),
    })),
    SEPARATOR,
    { label: 'Edit tags', icon: ICONS.tag, action: () => openTagPicker(tab, anchor) },
  ], anchor, { className: 'tags-menu' });
}

/**
 * Handles a click on a row's "+N"; true when it was one.
 * @param {MouseEvent} e
 */
function onMoreTagsClick(e) {
  const more = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-more-tags]'));
  if (!more) return false;
  openTagsMenu(/** @type {Tab} */ (state.tabs.get(
    /** @type {string} */ (/** @type {HTMLElement} */ (more.closest('[data-tab]')).dataset.tab))), more);
  return true;
}

export function render() {
  document.body.classList.toggle(NO_WORKSPACES, !state.workspaces.length);
  list.innerHTML = state.workspaces.map((ws, i) => {
    const active = ws.id === state.activeId;
    // Each workspace stays open or closed as the user left it, active or not (saved with the workspace).
    const open = !ws.collapsed;
    const tabs = tabsOf(ws);
    const unread = unreadCount(ws);
    return `<div class="ws-item" data-ws="${escapeHtml(ws.id)}">
        <div class="ws-row${active ? ' active' : ''}${open ? ' open' : ''}${unread ? ' unread' : ''}" data-ws="${escapeHtml(ws.id)}" role="button" tabindex="-1">
          <button class="ws-chev" data-collapse="${escapeHtml(ws.id)}" title="${open ? 'Hide tabs' : 'Show tabs'}" tabindex="-1">${CHEVRON}</button>
          <span class="ws-dot" style="background:${cssColor(ws.color)}"></span>
          <span class="ws-name">${escapeHtml(ws.name)}</span>${ws.note?.text ? `<span class="note-mark" data-note-ws="${escapeHtml(ws.id)}" title="${escapeHtml(`Workspace note: ${firstLine(ws.note.text)}\nClick to open`)}">${ICONS.note}</span>` : ''}
          ${!open ? wsActivityHtml(ws) : ''}${!open && hasAttention(ws) ? '<span class="attn"></span>' : ''}
          ${costMode() === costDisplay.cost && workspaceCost(ws) >= 0.005 ? `<span class="ws-cost" title="What this workspace’s agents have cost so far">${dollars(workspaceCost(ws))}</span>` : ''}<span class="ws-count">${tabs.length}</span>
          ${i < 9 ? `<span class="ws-key"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>${i + 1}</kbd></span>` : ''}
        </div>
        ${open ? `<div class="tab-tree">${tabs.length ? tabs.map(t => tabRowHtml(t, ws)).join('') : '<div class="tab-empty">No terminals</div>'}</div>` : ''}
      </div>`;
  }).join('');

  rail.innerHTML = state.workspaces.map(ws => `
    <button class="rail-tile${ws.id === state.activeId ? ' active' : ''}${unreadCount(ws) ? ' unread' : ''}" data-ws="${escapeHtml(ws.id)}" style="--c:${cssColor(ws.color)}" aria-label="${escapeHtml(ws.name)}${unreadCount(ws) ? `, ${unreadCount(ws)} unread` : ''}">
      ${escapeHtml([...ws.name][0]?.toUpperCase() ?? '?')}
      ${wsActivityHtml(ws, 'mini rail-activity')}${hasAttention(ws) ? '<span class="attn"></span>' : ''}
      <span class="rail-count">${tabsOf(ws).length}</span>
    </button>`).join('') + `<div class="rail-sep"></div>${remoteRailHtml()}<button class="rail-add" title="New workspace (Ctrl+Shift+N)">${RAIL_PLUS}</button>`;

  const ws = wsById(state.activeId);
  if (ws) {
    find(crumb, '.crumb-dot').style.background = ws.color;
    find(crumb, '.crumb-name').textContent = ws.name;
    const n = tabsOf(ws).length;
    find(crumb, '.crumb-count').textContent = `${n} tab${n === 1 ? '' : 's'}`;
  }
  fitTags(list);
  if (flyout.classList.contains(SHOWN)) {
    showFlyout(/** @type {HTMLElement | null} */ (rail.querySelector(`[data-ws="${flyout.dataset.ws}"]`)));
  }
}

// The sidebar width changes while dragging its edge or animating open.
// Fitting changes layout inside the observed element, so it runs in the next frame (no observer loop).
let fitFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => fitTags(list));
}).observe(list);

let frame = 0;
const renderSoon = () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(render);
};
for (const event of [EVENTS.workspaces, EVENTS.tab, EVENTS.tags, EVENTS.focus]) on(event, renderSoon);

// ---- Rail flyout ----

/** @param {HTMLElement | null} tile */
function showFlyout(tile) {
  if (!tile || state.sidebar.open) return hideFlyout();
  const ws = wsById(tile.dataset.ws);
  if (!ws) return hideFlyout();
  const i = state.workspaces.indexOf(ws);
  const tabs = tabsOf(ws);
  flyout.dataset.ws = ws.id;
  flyout.innerHTML = `<div class="fly-head"><span class="ws-dot" style="background:${cssColor(ws.color)}"></span>${escapeHtml(ws.name)}
      ${i < 9 ? `<span class="fly-key"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>${i + 1}</kbd></span>` : ''}</div>
    ${tabs.length ? tabs.map(t => tabRowHtml(t, ws)).join('') : '<div class="tab-empty">No terminals</div>'}`;
  const r = tile.getBoundingClientRect();
  flyout.style.left = `${r.right + 10}px`;
  flyout.style.top = `${Math.min(r.top - 6, innerHeight - flyout.offsetHeight - 8)}px`;
  flyout.classList.add(SHOWN);
  fitTags(flyout);
}

function hideFlyout() {
  flyout.classList.remove(SHOWN);
}

// ---- Workspace menu and rename ----

/**
 * @param {Workspace} ws
 * @param {import('./popups.js').Anchor} at
 */
function openWorkspaceMenu(ws, at) {
  showMenu([
    { label: 'New terminal here', icon: ICONS.plus, action: () => newTab({ wsId: ws.id }) },
    { label: RENAME_LABEL, icon: ICONS.rename, action: () => beginWorkspaceRename(ws) },
    { label: ws.note?.text ? 'Edit note' : NOTE_LABEL, icon: ICONS.note, action: () => editNote(NOTE_KIND.workspace, ws) },
    ...(repoOf(ws.cwd) ? [{ label: GIT_LABEL, icon: ICONS.git, hint: '<kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>G</kbd>', action: () => emit(EVENTS.openGit, { folder: ws.cwd }) }] : []),
    { label: 'Export layout', icon: ICONS.move, disabled: !tabsOf(ws).length, title: tabsOf(ws).length ? '' : 'No terminals to export', action: () => exportLayout(ws) },
    ...(tabsOf(ws).some(isAgentWorking) ? [{ label: 'Stop all agents here', icon: ICONS.stop, action: () => stopAllAgents(ws) }] : []),
    { label: 'Move terminals to tabs', icon: ICONS.tabs, disabled: tabsOf(ws).length < 2 || allInTabs(ws), title: tabsOf(ws).length < 2 ? 'Only one terminal here' : allInTabs(ws) ? 'They are all tabs already' : '', action: () => moveAllToTabs(ws) },
    {
      label: 'Colour', icon: ICONS.palette,
      submenu: () => WORKSPACE_COLORS.map((color, i) => ({
        label: COLOR_NAMES[i],
        icon: `<span class="ws-swatch" style="background:${color}"></span>`,
        hint: color === ws.color ? '<span class="menu-current">current</span>' : '',
        action: () => setWorkspaceColor(ws, color),
      })),
    },
    SEPARATOR,
    {
      label: 'Close workspace', icon: ICONS.trash, danger: true,
      action: async () => {
        const n = tabsOf(ws).length;
        if (n && state.settings.interface.confirmCloseWorkspace && !(await confirmDialog({
          title: `Close “${ws.name}”?`,
          body: `Its ${n} terminal${n === 1 ? '' : 's'} will be closed. You can reopen them from Recently closed.${state.workspaces.length === 1 ? ' This is your last workspace.' : ''}`,
          confirm: 'Close workspace',
        }))) return;
        closeWorkspace(ws);
      },
    },
  ], at);
}

/** @param {Workspace} ws */
function beginWorkspaceRename(ws) {
  if (!state.sidebar.open) setSidebarOpen(true);
  render();
  const label = list.querySelector(`.ws-row[data-ws="${ws.id}"] .ws-name`);
  if (!label) return;
  const input = document.createElement('input');
  input.className = RENAME_INPUT_CLASS;
  input.value = ws.name;
  input.maxLength = MAX_WORKSPACE_NAME;
  input.spellcheck = false;
  label.replaceWith(input);
  input.focus();
  input.select();
  const error = document.createElement('div');
  error.className = 'rename-error';
  error.hidden = true;
  /** @type {HTMLElement} */ (input.closest(WS_ROW)).after(error);
  let done = false;
  const finish = (/** @type {boolean} */ commit) => {
    if (done) return;
    if (commit && !renameWorkspace(ws, input.value)) {
      // Taken: keep editing on Enter so the name can be changed (a click away gives up instead).
      showError(error, nameTakenMessage(input.value));
      input.classList.add('invalid');
      input.select();
      return false;
    }
    done = true;
    render();
    return true;
  };
  input.addEventListener('input', () => {
    error.hidden = true;
    input.classList.remove('invalid');
  });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => {
    if (finish(true) === false) finish(false);
  });
  input.addEventListener('click', e => e.stopPropagation());
}

// ---- Events ----

for (const toggle of toggles) toggle.addEventListener('click', toggleSidebar);
byId('ws-add').addEventListener('click', () => openNewWorkspace());
for (const el of document.querySelectorAll('[data-open-history]')) {
  el.addEventListener('click', () => openPalette({ filter: PALETTE_VIEW.closed }));
}

/**
 * A note icon in the list: opens the note it stands for (a terminal's own, its host's or its workspace's).
 * @param {MouseEvent} e
 */
function onNoteClick(e) {
  const mark = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-note-ws], [data-note-tab]'));
  if (!mark) return false;
  if (mark.dataset.noteWs) {
    editNote(NOTE_KIND.workspace, /** @type {Workspace} */ (wsById(mark.dataset.noteWs)));
    return true;
  }
  const tab = /** @type {Tab} */ (state.tabs.get(/** @type {string} */ (mark.dataset.noteTab)));
  const note = notesFor(tab)[0];
  if (note?.kind === NOTE_KIND.host) editNote(NOTE_KIND.host, tab.profile);
  else if (note?.kind === NOTE_KIND.workspace) editNote(NOTE_KIND.workspace, /** @type {Workspace} */ (wsById(tab.wsId)));
  else editNote(NOTE_KIND.terminal, tab);
  return true;
}

/** @param {MouseEvent} e */
function onTabClick(e) {
  // A branch chip opens the Git window on its repository.
  const git = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-git-root]'));
  if (git) {
    emit(EVENTS.openGit, { folder: git.dataset.gitRoot, remote: git.dataset.gitRemote }); // remote: the SSH terminal it's on
    return true;
  }
  const port = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-port]'));
  if (port) {
    openPort(/** @type {string} */ (port.dataset.port));
    return true;
  }
  const stop = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-stop]'));
  if (stop) {
    stopAgent(/** @type {Tab} */ (state.tabs.get(/** @type {string} */ (stop.dataset.stop))));
    return true;
  }
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tab]'));
  if (!row) return false;
  focusTab(state.tabs.get(/** @type {string} */ (row.dataset.tab)));
  return true;
}

list.addEventListener('click', e => {
  const chev = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-collapse]'));
  if (chev) {
    const ws = wsById(chev.dataset.collapse);
    if (ws) {
      ws.collapsed = !ws.collapsed;
      render();
      persist();
    }
    return;
  }
  if (onNoteClick(e) || onMoreTagsClick(e) || onTabClick(e)) return;
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(WS_ROW));
  if (row && !targetOf(e).closest('input')) switchWorkspace(/** @type {string} */ (row.dataset.ws));
});
list.addEventListener('dblclick', e => {
  const name = targetOf(e).closest('.ws-name');
  if (name) beginWorkspaceRename(/** @type {Workspace} */ (wsById(
    /** @type {HTMLElement} */ (name.closest(WS_ROW)).dataset.ws)));
});
list.addEventListener('contextmenu', e => {
  e.preventDefault();
  const tabRow = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tab]'));
  if (tabRow) return openTabMenu(/** @type {Tab} */ (state.tabs.get(/** @type {string} */ (tabRow.dataset.tab))),
    { x: e.clientX, y: e.clientY });
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-ws]'));
  if (row) openWorkspaceMenu(/** @type {Workspace} */ (wsById(row.dataset.ws)), { x: e.clientX, y: e.clientY });
});

rail.addEventListener('click', e => {
  if (targetOf(e).closest('.rail-add')) return openNewWorkspace();
  const remote = targetOf(e).closest('.rail-remote');
  if (remote) {
    hideFlyout();
    return openRemoteMenu(remote);
  }
  const tile = /** @type {HTMLElement | null} */ (targetOf(e).closest(RAIL_TILE));
  if (tile) {
    switchWorkspace(/** @type {string} */ (tile.dataset.ws));
    hideFlyout();
  }
});
rail.addEventListener('mouseover', e => {
  const tile = /** @type {HTMLElement | null} */ (targetOf(e).closest(RAIL_TILE));
  if (tile) showFlyout(tile);
});
rail.addEventListener('contextmenu', e => {
  e.preventDefault();
  const tile = /** @type {HTMLElement | null} */ (targetOf(e).closest(RAIL_TILE));
  if (tile) {
    hideFlyout();
    openWorkspaceMenu(/** @type {Workspace} */ (wsById(tile.dataset.ws)), { x: e.clientX, y: e.clientY });
  }
});
sidebar.addEventListener('mouseleave', e => {
  if (!flyout.contains(/** @type {Node | null} */ (e.relatedTarget))) hideFlyout();
});
flyout.addEventListener('mouseleave', e => {
  if (!sidebar.contains(/** @type {Node | null} */ (e.relatedTarget))) hideFlyout();
});
flyout.addEventListener('click', e => {
  if (onMoreTagsClick(e)) return;
  if (onNoteClick(e) || onTabClick(e)) hideFlyout();
});

// The toggles must not take keyboard focus from the terminal.
for (const toggle of toggles) toggle.addEventListener('mousedown', e => e.preventDefault());

// ---- Width (drag the gap between sidebar and terminals) ----

const DEFAULT_WIDTH = 236;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const resizer = byId('sidebar-resizer');

function applyWidth() {
  const width = Math.min(MAX_WIDTH,
    Math.max(MIN_WIDTH, Math.round(state.sidebar.width ?? DEFAULT_WIDTH)));
  document.body.style.setProperty('--sidebar-width', `${width}px`);
}

resizer.addEventListener('pointerdown', e => {
  if (!state.sidebar.open || e.button !== 0) return;
  e.preventDefault();
  document.body.classList.add(RESIZING);
  const { left, right } = sidebar.getBoundingClientRect();
  const grab = e.clientX - right; // keep the grabbed point under the pointer (no jump on the first move)
  dragPointer(resizer, e, ev => {
    state.sidebar.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX - grab - left));
    applyWidth();
    scheduleFit();
  }, () => {
    document.body.classList.remove(RESIZING);
    persist();
    restoreFocus();
  });
});

export function resetSidebarWidth() {
  state.sidebar.width = DEFAULT_WIDTH;
  applyWidth();
  scheduleFit();
  persist();
}

resizer.addEventListener('dblclick', () => {
  if (state.sidebar.open) resetSidebarWidth();
});

// Terminals change size while the sidebar animates open or closed; refit when it settles.
sidebar.addEventListener('transitionend', e => {
  if (e.propertyName === 'width') scheduleFit();
});

export function initSidebar() {
  applyMode();
  applyWidth();
  render();
}
