// @ts-check
// Broadcast input: what's typed in one terminal goes to several. The scope is a workspace, every terminal with a
// tag (across workspaces), or terminals picked one by one; any of them can be left out. Terminals tagged "prod"
// only join after a confirmation. A compose box sends edited, multi-line text to all of them at once.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, emit, on, wsById, tabsOf, tabTitle, EVENTS } from './store.js';
import { confirmDialog, modal } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { isProduction } from './environments.js';
import { byId, find } from './dom.js';

/**
 * A broadcast's scopes: a workspace, a tag (started as "tag:" and the tag's name), or terminals picked one by one.
 */
export const BROADCAST_SCOPE = Object.freeze({
  workspace: 'workspace', tag: 'tag', selected: 'selected', tagPrefix: 'tag:',
});

/**
 * A broadcast: its scope ('workspace', 'tag' or 'selected'), the workspace it started in, the tag, the terminals
 * picked (for 'selected') and the ones left out (for the others), by id.
 * @typedef {{ scope: string, wsId: string, tag: string | null, selected: Set<string>, excluded: Set<string> }} Broadcast
 */

/**
 * null, or { scope: 'workspace' | 'tag' | 'selected', wsId, tag, selected: Set, excluded: Set }.
 * @type {Broadcast | null}
 */
let current = null;

const bar = byId('broadcast-bar');

/**
 * Terminals the scope covers before any are left out (for "selected": the active workspace's, to pick from).
 * @param {Broadcast | null} [b]
 */
function candidates(b = current) {
  if (!b) return [];
  // A workspace that's gone covers no terminals: tabsOf only reads its root.
  if (b.scope === BROADCAST_SCOPE.workspace || b.scope === BROADCAST_SCOPE.selected) return tabsOf(
    /** @type {Workspace} */ (wsById(b.wsId) ?? { root: null }));
  return [...state.tabs.values()].filter(t => t.tags.includes(/** @type {string} */ (b.tag)));
}

/**
 * The terminals that receive input now.
 * @param {Broadcast | null} [b]
 */
export function receivers(b = current) {
  if (!b) return [];
  return candidates(b).filter(t => (b.scope === BROADCAST_SCOPE.selected ? b.selected.has(t.id) : !b.excluded.has(t.id)));
}

export const isBroadcasting = () => !!current;
/**
 * Whether a terminal gets a "receiving" switch in its header (it's in the scope).
 * @param {Tab} tab
 */
export const isCandidate = tab => candidates().includes(tab);
/** @param {Tab} tab */
export const isReceiving = tab => receivers().includes(tab);

/**
 * Where input typed in `tab` goes: every receiver when `tab` is one of them, else just `tab`.
 * @param {Tab} tab
 */
export function inputTargets(tab) {
  const all = receivers();
  return all.includes(tab) ? all : [tab];
}

/**
 * Starts broadcasting; asks first when a production terminal would receive.
 * @param {string} scope 'workspace', 'selected', or 'tag:' and a tag's name
 * @param {Tab} from
 */
export async function startBroadcast(scope, from) {
  /** @type {Broadcast} */
  const next = {
    scope, wsId: from.wsId, tag: scope.startsWith(BROADCAST_SCOPE.tagPrefix) ? scope.slice(BROADCAST_SCOPE.tagPrefix.length) : null,
    selected: new Set([from.id]), excluded: new Set(),
  };
  if (next.tag) next.scope = BROADCAST_SCOPE.tag;
  const prod = receivers(next).filter(isProduction);
  if (prod.length && !(await confirmDialog({
    title: 'Broadcast to production?',
    body: `${prod.map(tabTitle).join(', ')} ${prod.length === 1 ? 'is' : 'are'} on production. Everything you type will run there too.`,
    confirm: 'Broadcast',
  }))) return;
  current = next;
  changed();
}

export function stopBroadcast() {
  if (!current) return;
  current = null;
  changed();
}

/**
 * The header switch: in or out of the broadcast. Adding a production terminal asks first.
 * @param {Tab} tab
 */
export async function toggleReceiver(tab) {
  if (!current) return;
  const joining = !isReceiving(tab);
  if (joining && isProduction(tab) && !(await confirmDialog({
    title: 'Add a production terminal?',
    body: `${tabTitle(tab)} is on production. Everything you type in the broadcast will run there too.`,
    confirm: 'Add',
  }))) return;
  const set = current.scope === BROADCAST_SCOPE.selected ? current.selected : current.excluded;
  if (joining === (current.scope === BROADCAST_SCOPE.selected)) set.add(tab.id); else set.delete(tab.id);
  changed();
}

/** Opens the compose box: text edited first, then sent to every receiver (each line followed by Enter). */
export function openCompose() {
  if (!current) return;
  const count = receivers().length;
  modal('compose', `
    <h3>Send to ${count} terminal${count === 1 ? '' : 's'}</h3>
    <p class="dialog-sub">${escapeHtml(receivers().map(tabTitle).join(', '))}</p>
    <textarea class="field compose-text" rows="6" spellcheck="false" placeholder="Commands, one per line" autofocus></textarea>
    <div class="dialog-actions">
      <span class="dialog-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> sends</span>
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-ok>Send</button>
    </div>`, (dialog, close) => {
    const text = /** @type {HTMLTextAreaElement} */ (dialog.querySelector('textarea'));
    const submit = () => close(text.value);
    return { submit }; // the dialog sends Ctrl+Enter here
  }).then(text => {
    if (!text?.trim()) return;
    const data = text.replace(/\r?\n/g, '\r').replace(/\r*$/, '\r');
    for (const tab of receivers()) send(PAGE.input, { id: tab.id, data });
  });
}

/** What the title bar says while broadcasting (so there is a broadcast). */
function scopeLabel() {
  if (/** @type {Broadcast} */ (current).scope === BROADCAST_SCOPE.workspace) {
    return `“${wsById(/** @type {Broadcast} */ (current).wsId)?.name ?? ''}”`;
  }
  if (/** @type {Broadcast} */ (current).scope === BROADCAST_SCOPE.tag) return `#${/** @type {Broadcast} */ (current).tag}`;
  return 'picked';
}

function changed() {
  if (current) {
    const n = receivers().length;
    bar.hidden = false;
    const text = find(bar, '.bc-text');
    text.textContent = `Broadcast to ${n} · ${scopeLabel()}`;
    bar.title = `Typing in one of these ${n} terminals types in all of them (${receivers().map(tabTitle).join(', ')})`;
  } else {
    bar.hidden = true;
  }
  for (const tab of state.tabs.values()) emit(EVENTS.tab, tab);
}

find(bar, '[data-bc="compose"]').addEventListener('click', openCompose);
find(bar, '[data-bc="stop"]').addEventListener('click', stopBroadcast);

// Terminals closing, moving or being re-tagged change who's in scope.
on(EVENTS.workspaces, () => { if (current) changed(); });
on(EVENTS.tags, () => { if (current) changed(); });
