// @ts-check
// The sidebar's Remote section: the places Termilly found to open a terminal on (SSH hosts, WSL distros, containers,
// pods, serial ports), below the workspaces. It lists the pinned ones and the recently used ones, with how many
// terminals each has open; the rest are a filter away. A click opens a terminal on it in the current workspace, so a
// project's remote terminals stay in its workspace. On the icon rail it's a button with a menu.

import { state, on, persist, PROFILE_SOURCES, REMOTE_SOURCES, isRemoteProfile, profileOf, GROUPS, EVENTS } from './store.js';
import { badgeHtml, escapeHtml, ICONS } from './ui.js';
import { newTab, focusTab } from './panes.js';
import { showMenu, SEPARATOR, SIDE } from './popups.js';
import { createWorkspace, freeName } from './workspaces.js';
import { environmentOf } from './environments.js';
import { fuzzyMatch } from './fuzzy.js';
import { updateSettings } from './preferences.js';
import { byId, find, field, targetOf } from './dom.js';

/** The sidebar's state, with the Remote section's fold (kept with the sidebar's, store.js). */

/** Where remote places come from, in the New terminal menu's order. */
const SOURCES = PROFILE_SOURCES.filter(([source]) => REMOTE_SOURCES.includes(source));
const RECENT_SHOWN = 6;
const RECENT_KEPT = 30;

/** A pin on the 16px grid (straight lines on .5, centred on 8.5), drawn at 16px. */
const PIN = '<svg viewBox="0 0 16 16"><path d="M6 2.5h5M7 2.5v4l-2 3h7l-2-3v-4M8.5 9.5v4"/></svg>';
/** A globe for the rail's button, on the same grid. */
const GLOBE = '<svg viewBox="0 0 16 16"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M3 8.5h11M8.5 3c-1.6 1.6-2.4 3.4-2.4 5.5s.8 3.9 2.4 5.5c1.6-1.6 2.4-3.4 2.4-5.5S10.1 4.6 8.5 3"/></svg>';

const section = byId('remote');
const head = find(section, '.rm-head');
const filter = field(section, '.rm-filter');
const body = find(section, '.rm-body');
let showAll = false;

const places = () => state.profiles.filter(isRemoteProfile);
const pins = () => new Set(state.settings.uiState.remotePinned ?? []);
const used = () => state.settings.uiState.remoteRecent ?? {};
/**
 * The open terminals on a place, in workspace order.
 * @param {string} id
 */
const sessionsOf = id => state.workspaces.flatMap(ws => [...state.tabs.values()].filter(t => t.wsId === ws.id && t.profile === id && !t.exited));
/**
 * The environment a place is on (prod, staging), as a terminal on it would be.
 * @param {SessionProfile} p
 */
const environmentOfPlace = p => environmentOf(/** @type {Tab} */ ({ profile: p.id, tags: p.tags ?? [] }));
/**
 * @param {SessionProfile} a
 * @param {SessionProfile} b
 */
const byName = (a, b) => a.name.localeCompare(b.name);

/** What the section lists when it isn't filtered: pinned, the recently used, then any other with a terminal open. */
function shortList() {
  const pinned = pins();
  const last = used();
  const all = places();
  const first = all.filter(p => pinned.has(p.id)).sort(byName);
  const recent = all.filter(p => !pinned.has(p.id) && last[p.id]).sort((a, b) => last[b.id] - last[a.id]).slice(0, RECENT_SHOWN);
  const open = all.filter(p => !pinned.has(p.id) && !recent.includes(p) && sessionsOf(p.id).length).sort(byName);
  return [...first, ...recent, ...open];
}

/** @param {SessionProfile} p */
function rowHtml(p) {
  const env = environmentOfPlace(p);
  const open = sessionsOf(p.id).length;
  const pinned = pins().has(p.id);
  const tip = `${p.name}${p.description ? ` · ${p.description}` : ''}${env ? ` · ${env.label}` : ''}\nClick to open a terminal on it here`;
  return `<button class="rm-row${env ? ' env' : ''}" data-rm="${escapeHtml(p.id)}" title="${escapeHtml(tip)}"${env ? ` style="--env:${env.color}"` : ''}>
    ${badgeHtml(p)}<span class="rm-name">${escapeHtml(p.name)}</span>
    <span class="rm-chips">${env ? `<span class="rm-env">${escapeHtml(env.label.toLowerCase())}</span>` : ''}${open
      ? `<span class="rm-open" data-rm-open="${escapeHtml(p.id)}" title="${open} terminal${open === 1 ? '' : 's'} open on it. Click to go to ${open === 1 ? 'it' : 'the next one'}">${open}</span>` : ''}
    <span class="rm-pin${pinned ? ' on' : ''}" data-rm-pin="${escapeHtml(p.id)}" title="${pinned ? 'Unpin' : 'Pin to the top'}" role="button">${PIN}</span></span>
  </button>`;
}

/**
 * Places grouped by where they come from (SSH hosts, Containers…), as in the New terminal menu.
 * @param {SessionProfile[]} list
 */
const groupedHtml = list => SOURCES
  .map(([source, label]) => /** @type {[string, SessionProfile[]]} */ ([label, list.filter(p => p.source === source)]))
  .filter(([, group]) => group.length)
  .map(([label, group]) => `<div class="rm-group">${escapeHtml(label)}</div>${group.map(rowHtml).join('')}`)
  .join('');

export function renderRemote() {
  const all = places();
  section.hidden = !all.length;
  if (!all.length) return;
  const folded = !!state.sidebar.remoteFolded;
  section.classList.toggle('folded', folded);
  find(head, '.rm-count').textContent = String(all.length);
  const query = filter.hidden ? null : filter.value.trim();
  if (folded) {
    body.innerHTML = '';
    return;
  }
  if (query !== null) {
    const found = all.filter(p => !query || fuzzyMatch(query, `${p.name} ${p.description ?? ''}`));
    body.innerHTML = found.length ? groupedHtml(found) : '<div class="rm-empty">Nothing matches.</div>';
    return;
  }
  const short = shortList();
  // Nothing pinned or used yet: everything, grouped, so there's something to start from.
  if (showAll || !short.length) {
    body.innerHTML = groupedHtml(all) + (short.length ? '<button class="rm-more" data-rm-all>Show fewer</button>' : '');
    return;
  }
  body.innerHTML = short.map(rowHtml).join('')
    + (all.length > short.length ? `<button class="rm-more" data-rm-all>All ${all.length} places</button>` : '');
}

// ---- Actions ----

/**
 * @param {SessionProfile} p
 * @param {{ newWorkspace?: boolean }} [options]
 */
export function openOn(p, { newWorkspace = false } = {}) {
  if (newWorkspace) createWorkspace({ name: freeName(p.name), profile: p.id });
  else newTab({ profile: p.id });
}

/** @param {string} id */
function togglePin(id) {
  const pinned = pins();
  pinned.has(id) ? pinned.delete(id) : pinned.add(id);
  updateSettings(GROUPS.uiState, { remotePinned: [...pinned] });
  renderRemote();
}

/**
 * Goes to the next open terminal on a place, after the focused one, round the workspaces.
 * @param {string} id
 */
function goToSession(id) {
  const open = sessionsOf(id);
  if (!open.length) return;
  const focused = state.workspaces.find(w => w.id === state.activeId)?.focusId;
  const at = open.findIndex(t => t.id === focused);
  focusTab(open[(at + 1) % open.length]);
}

/**
 * @param {SessionProfile} p
 * @param {import('./popups.js').Anchor} at
 */
function openMenu(p, at) {
  const open = sessionsOf(p.id);
  showMenu([
    { label: 'Open a terminal here', icon: ICONS.plus, action: () => openOn(p) },
    { label: 'Open in a new workspace', icon: ICONS.workspaces, action: () => openOn(p, { newWorkspace: true }) },
    ...(open.length ? [{ label: open.length === 1 ? 'Go to its terminal' : `Go to its terminals (${open.length})`, icon: ICONS.terminal, action: () => goToSession(p.id) }] : []),
    SEPARATOR,
    { label: pins().has(p.id) ? 'Unpin' : 'Pin to the top', icon: PIN, action: () => togglePin(p.id) },
  ], at);
}

/**
 * The rail's Remote button: the short list (or every place) as a menu, all of them in a submenu.
 * @param {import('./popups.js').Anchor} anchor
 */
export function openRemoteMenu(anchor) {
  const all = places();
  const short = shortList();
  /**
   * @param {SessionProfile} p
   * @returns {import('./popups.js').MenuItem}
   */
  const item = p => {
    const env = environmentOfPlace(p);
    const open = sessionsOf(p.id).length;
    return {
      label: p.name, icon: badgeHtml(p),
      hint: [env ? `<span class="rm-env" style="--env:${env.color}">${escapeHtml(env.label.toLowerCase())}</span>` : '', open ? `<span class="menu-current">${open} open</span>` : ''].join(''),
      action: () => openOn(p),
    };
  };
  showMenu([
    ...(short.length ? short : all).map(item),
    ...(short.length && all.length > short.length
      ? /** @type {import('./popups.js').MenuEntry[]} */ ([SEPARATOR, { label: `All ${all.length} places`, icon: GLOBE, submenu: () => all.map(item) }]) : []),
  ], anchor, { side: SIDE.right, className: 'rm-menu' });
}

export const remoteRailHtml = () => (places().length ? `<button class="rail-remote" title="Remote: SSH hosts, WSL, containers, pods, serial">${GLOBE}</button>` : '');

// ---- Events ----

head.addEventListener('click', e => {
  if (targetOf(e).closest('[data-rm-filter]')) {
    filter.hidden = !filter.hidden;
    filter.value = '';
    if (!filter.hidden) {
      state.sidebar.remoteFolded = false;
      persist();
    }
    renderRemote();
    if (!filter.hidden) filter.focus();
    return;
  }
  if (targetOf(e).closest('[data-rm-fold]')) {
    state.sidebar.remoteFolded = !state.sidebar.remoteFolded;
    persist();
    renderRemote();
  }
});

filter.addEventListener('input', renderRemote);
filter.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    filter.hidden = true;
    renderRemote();
  } else if (e.key === 'Enter') {
    const first = /** @type {HTMLElement | null} */ (body.querySelector('[data-rm]'));
    if (first) {
      filter.hidden = true;
      renderRemote();
      openOn(/** @type {SessionProfile} */ (state.profiles.find(p => p.id === first.dataset.rm)));
    }
  }
});

body.addEventListener('click', e => {
  if (targetOf(e).closest('[data-rm-all]')) {
    showAll = !showAll;
    renderRemote();
    return;
  }
  const pin = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-rm-pin]'));
  if (pin) return togglePin(/** @type {string} */ (pin.dataset.rmPin));
  const open = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-rm-open]'));
  if (open) return goToSession(/** @type {string} */ (open.dataset.rmOpen));
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-rm]'));
  const p = row && state.profiles.find(x => x.id === row.dataset.rm);
  if (p) openOn(p);
});

body.addEventListener('contextmenu', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-rm]'));
  const p = row && state.profiles.find(x => x.id === row.dataset.rm);
  if (!p) return;
  e.preventDefault();
  openMenu(p, { x: e.clientX, y: e.clientY });
});

// A terminal opened on a place (from here, the New terminal menu, a shortcut or the API) makes it recently used.
on(EVENTS.opened, tab => {
  if (!isRemoteProfile(profileOf(tab))) return;
  const last = Object.entries({ ...used(), [tab.profile]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, RECENT_KEPT);
  updateSettings(GROUPS.uiState, { remoteRecent: Object.fromEntries(last) });
});

let frame = 0;
const renderSoon = () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(renderRemote);
};
for (const event of [EVENTS.profiles, EVENTS.workspaces, EVENTS.tab, EVENTS.focus, EVENTS.settings]) on(event, renderSoon);
