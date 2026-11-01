// @ts-check
// The Files panel's "Copy to" (filepanel.js): which terminal's folder the files and folders selected go to, and what
// to do about the ones already there. The window lists the terminals whose files can be shown, by workspace, and
// the folders of the one chosen as a tree, from This PC (or the server's root) down, open at the folder picked last
// time in this workspace, or where its shell is; the copy itself is the host's (FileCopies.cs).

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { state, tabsOf, tabTitle, isSsh, activeWs, persist } from './store.js';
import { modal, noticeDialog } from './dialogs.js';
import { escapeHtml, ICONS } from './ui.js';
import { find, targetOf } from './dom.js';
import {
  hasFiles, shellFolderOf, placeOf, folderOf, sameMachine, parentOf, isInside, freeName, DRIVE_ICON, DRIVES_NAME,
} from './filepaths.js';
import { rootOf, childPath, signHtml, indentRows, readFolders, pathDown } from './foldertree.js';
import { FILE_OP, FOLDER_PATH } from './constants.js';
import { fileTargets, fileTarget } from './remotepc.js';

/** What to do about the items already in the folder. */
const CONFLICT = Object.freeze({ replace: 'replace', skip: 'skip', keep: 'keep' });
/** How many of the items already there the question names. */
const CLASHES_SHOWN = 8;

/** A file or folder to copy, as the panel lists it, and where it is (the panel's tree can pick from several folders). */
/** @typedef {{ name: string, isDirectory: boolean, path: string }} CopyItem */
/** Where the items go and under which names. */
/** @typedef {{ to: Tab, dir: string, items: { path: string, name: string }[] }} CopyPlan */
/** @typedef {import('./foldertree.js').TreeNode} TreeNode */
/**
 * The window's state: the terminal the files are in and the one chosen, the folders read (per machine; nodes is the
 * chosen one's), which are open or being read, the one selected, the filter, and the folder a new one is being named in.
 * @typedef {{ source: Tab, tab: Tab | null, trees: Map<string, Map<string, TreeNode>>, nodes: Map<string, TreeNode>,
 *   open: Set<string>, loading: Set<string>, selected: string | null, error: string | null, filter: string,
 *   naming: string | null }} Picker
 */

/**
 * Asks where `items` (files and folders of `source`) go, then about the ones already there. Resolves with what to
 * copy where, or null when cancelled.
 * @param {Tab} source
 * @param {CopyItem[]} items
 * @returns {Promise<CopyPlan | null>}
 */
export async function planCopy(source, items) {
  const target = await pickFolder(source, items.length);
  return target ? planInto(source, items, target.tab, target.dir) : null;
}

/**
 * Plans copying `items` (files and folders of `source`) into a folder of `tab` known already, asking only about the
 * ones already there. Resolves with what to copy where, or null when cancelled.
 * @param {Tab} source
 * @param {CopyItem[]} items
 * @param {Tab} tab
 * @param {string} dir
 * @returns {Promise<CopyPlan | null>}
 */
export async function planInto(source, items, tab, dir) {
  const same = sameMachine(source, tab);
  const inside = same && items.find(i => i.isDirectory && isInside(dir, i.path));
  if (inside) {
    await noticeDialog({ title: 'Can’t copy a folder into itself', body: `${dir} is in ${inside.name}.` });
    return null;
  }
  const m = await request(PAGE.filesList, { id: tab.id, path: dir });
  if (m.error || m.ok === false) {
    await noticeDialog({ title: 'Can’t open the folder', body: m.message ?? m.error });
    return null;
  }
  // Names on a server tell case apart; here they don't.
  const caseless = tab.pcFiles ? tab.pcFiles.caseless : !isSsh(tab);
  const key = caseless ? (/** @type {string} */ n) => n.toLowerCase() : (/** @type {string} */ n) => n;
  const taken = new Set((m.entries ?? []).map((/** @type {{ name: string }} */ e) => key(e.name)));
  const clashes = items.filter(i => taken.has(key(i.name)));
  // Copying into the folder they're in: only new names will do.
  const samePlace = same && items.every(i => key(parentOf(i.path)) === key(m.path));
  const choice = clashes.length ? await askConflict(clashes, m.path, samePlace) : CONFLICT.replace;
  if (!choice) return null;
  const copies = [];
  for (const item of items) {
    const clash = taken.has(key(item.name));
    if (clash && choice === CONFLICT.skip) continue;
    const name = clash && choice === CONFLICT.keep ? freeName(item.name, item.isDirectory, taken, key) : item.name;
    taken.add(key(name));
    copies.push({ path: item.path, name });
  }
  return copies.length ? { to: tab, dir: m.path, items: copies } : null;
}

/**
 * Asks what to do about the items already in the folder: replace them (a folder merges), skip them, or keep both.
 * Copying into the folder they're in can only keep both.
 * @param {CopyItem[]} clashes
 * @param {string} dir
 * @param {boolean} samePlace
 * @returns {Promise<string | null>}
 */
function askConflict(clashes, dir, samePlace) {
  const names = clashes.slice(0, CLASHES_SHOWN).map(c => `<li>${c.isDirectory ? '📁' : '📄'} ${escapeHtml(c.name)}</li>`).join('');
  const more = clashes.length > CLASHES_SHOWN ? `<li class="copyto-more">and ${clashes.length - CLASHES_SHOWN} more</li>` : '';
  const title = clashes.length === 1 ? `${clashes[0].name} is already there` : `${clashes.length} items are already there`;
  return modal('copyto-clash', `
    <h3>${escapeHtml(title)}</h3>
    <p class="dialog-sub">In ${escapeHtml(dir)}</p>
    <ul class="copyto-clashes">${names}${more}</ul>
    <p class="dialog-sub">${samePlace ? (clashes.length === 1 ? 'This is the folder it’s in, so the copy gets a new name.' : 'This is the folder they’re in, so the copies get new names.')
      : 'Replace overwrites files with the same name and merges folders into the ones there. Keep both names the copies “name (1)”.'}</p>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      ${samePlace ? '' : `<button class="btn" data-choice="${CONFLICT.skip}">Skip these</button>`}
      <button class="btn primary" data-choice="${CONFLICT.keep}" autofocus>Keep both</button>
      ${samePlace ? '' : `<button class="btn danger" data-choice="${CONFLICT.replace}">Replace</button>`}
    </div>`, (dialog, close) => {
    dialog.addEventListener('click', e => {
      const choice = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-choice]'))?.dataset.choice;
      if (choice) close(choice);
    });
    return { submit: () => close(CONFLICT.keep) };
  });
}

// ---- The window: terminals on the left, the chosen one's folders on the right, as a tree ----

/**
 * The terminals whose files can be shown, by workspace in the sidebar's order, then the paired computers' (js/remotepc.js).
 * @returns {{ name: string, tabs: Tab[] }[]}
 */
const terminals = () => [
  ...state.workspaces.map(ws => ({ name: ws.name, tabs: tabsOf(ws).filter(hasFiles) })).filter(g => g.tabs.length),
  ...fileTargets(),
];

/** A terminal the window lists, by its id: this PC's, or another computer's. @param {string} id */
const listed = id => state.tabs.get(id) ?? fileTarget(id);

/**
 * Whether a terminal matches what's typed in the filter: its name, workspace or host.
 * @param {Tab} tab
 * @param {string} wsName
 * @param {string} filter
 */
const matches = (tab, wsName, filter) => !filter || [tabTitle(tab), wsName, placeOf(tab)].some(t => t.toLowerCase().includes(filter));

/**
 * The terminals' list, filtered.
 * @param {Picker} p
 * @param {Tab} source
 */
function termsHtml(p, source) {
  const html = terminals().map(({ name, tabs }) => {
    const shown = tabs.filter(t => matches(t, name, p.filter));
    return shown.length ? `<div class="copyto-ws">${escapeHtml(name)}</div>${shown.map(t => `
      <div class="copyto-term${t === p.tab ? ' on' : ''}" data-tab="${escapeHtml(t.id)}">
        <span class="files-name">${escapeHtml(tabTitle(t))}${t === source ? ' <span class="copyto-host">(this one)</span>' : ''}</span>
        <span class="copyto-host">${escapeHtml(placeOf(t))}</span>
      </div>`).join('')}` : '';
  }).join('');
  return html || '<div class="inbox-empty">No terminal matches.</div>';
}

// ---- The tree ----

/**
 * Which tree the terminal's folders are in: one per machine, read once while the window is open.
 * @param {Tab} tab
 */
const machineOf = tab => (tab.pcFiles ? `pc:${tab.pcFiles.machine}` : isSsh(tab) ? `ssh:${tab.profile}` : 'here');

/**
 * One folder's row: its sign (+ when it has folders, − when open), icon and name.
 * @param {Picker} p
 * @param {string} path
 * @param {string} name the row's text, as HTML
 * @param {number} depth
 * @param {boolean} hasFolders
 */
const nodeRow = (p, path, name, depth, hasFolders) => `
  <div class="files-item dir copyto-node${path === p.selected ? ' selected' : ''}" data-node="${escapeHtml(path)}" data-depth="${depth}"
    title="Click to copy into it${hasFolders ? ', double-click to open or close it' : ''}">
    ${signHtml(hasFolders, p.open.has(path))}
    <span class="files-name">${name}</span>
  </div>`;

/**
 * A row under a folder that isn't a folder: loading, an error, or the new folder's name.
 * @param {number} depth
 * @param {string} html
 */
const noteRow = (depth, html) => `<div class="files-item files-note" data-depth="${depth}">${html}</div>`;

/** @param {Picker} p */
function treeHtml(p) {
  if (!p.tab) return '';
  if (p.error) return `<div class="inbox-empty files-error">${escapeHtml(p.error)}</div>`;
  const root = rootOf(p.tab);
  const rootName = p.tab.pcFiles ? (root === '/' ? `${placeOf(p.tab)} (/)` : placeOf(p.tab))
    : isSsh(p.tab) ? `${placeOf(p.tab)} (/)` : root === '/' ? '/' : DRIVES_NAME;
  const rows = [nodeRow(p, root, `${ICONS.monitor} ${escapeHtml(rootName)}`, 0, true)];
  /**
   * @param {string} path
   * @param {number} depth
   */
  const walk = (path, depth) => {
    if (!p.open.has(path)) return;
    if (p.naming === path) rows.push(noteRow(depth, '<input class="field" data-new-folder placeholder="New folder" spellcheck="false">'));
    const node = p.nodes.get(path);
    if (!node) {
      if (p.loading.has(path)) rows.push(noteRow(depth, 'Loading…'));
      return;
    }
    if (node.error) rows.push(noteRow(depth, `<span class="files-error">${escapeHtml(node.error)}</span>`));
    for (const f of node.folders) {
      const child = childPath(path, f.name);
      const name = f.label != null ? `${DRIVE_ICON}${escapeHtml(`${f.label} (${f.name.replace(/\\$/, '')})`)}` : `📁 ${escapeHtml(f.name)}`;
      // One made here since it was read has folders now.
      rows.push(nodeRow(p, child, name, depth, f.hasFolders || !!p.nodes.get(child)?.folders.length));
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return rows.join('');
}

/**
 * Reads the folders of the ones not read yet (all at once: one ssh call on a server); false when the window moved
 * on to another terminal meanwhile, or the machine can’t be reached.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {string[]} paths
 */
async function load(dialog, p, paths) {
  const tab = p.tab;
  const wanted = paths.filter(path => !p.nodes.has(path));
  if (!tab || !wanted.length) return !!tab;
  for (const path of wanted) p.loading.add(path);
  paint(dialog, p);
  const error = await readFolders(tab, p.nodes, wanted, false);
  for (const path of wanted) p.loading.delete(path);
  if (p.tab !== tab) return false;
  if (error) p.error = error;
  paint(dialog, p);
  return !error;
}

/**
 * Opens the tree down to a folder and selects it (or the deepest folder on the way that’s still there).
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {string} path
 */
async function reveal(dialog, p, path) {
  const tab = /** @type {Tab} */ (p.tab);
  const { there, error } = await pathDown(tab, p.nodes, path, false);
  if (p.tab !== tab) return;
  if (error) p.error = error;
  p.open = new Set(there);
  select(dialog, p, there[there.length - 1], false);
  paint(dialog, p);
  find(dialog, ".copyto-node.selected")?.scrollIntoView({ block: "center" });
}

/**
 * Opens a folder (its folders read if they weren't) or closes it.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {string} path
 */
function toggle(dialog, p, path) {
  if (p.open.delete(path)) return paint(dialog, p);
  p.open.add(path);
  paint(dialog, p);
  load(dialog, p, [path]);
}

// ---- Choosing ----

/** The folders "Copy to" picked in the workspace shown: the terminal, and in each the folder. */
const memoOf = () => {
  const ws = activeWs();
  return ws ? (ws.copyTo ??= { tab: null, dirs: {} }) : null;
};

/**
 * The folder the items go to; one picked (not where the tree opened) is kept for the next "Copy to" in this
 * workspace.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {string | null} path
 * @param {boolean} [picked]
 */
function select(dialog, p, path, picked = true) {
  p.selected = path;
  const memo = memoOf();
  if (picked && memo && p.tab && path) {
    memo.tab = p.tab.id;
    memo.dirs[p.tab.id] = path;
    persist();
  }
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (dialog.querySelectorAll('[data-node]'))) {
    row.classList.toggle('selected', row.dataset.node === path);
  }
  paintTarget(dialog, p);
}

/** The folder the items go to: the one selected; none on the drives. @param {Picker} p */
const copyTarget = p => (p.selected && p.selected !== FOLDER_PATH.drives ? p.selected : null);

/**
 * Draws the parts of the window that change.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 */
function paint(dialog, p) {
  find(dialog, '[data-terms]').innerHTML = termsHtml(p, p.source);
  const tree = find(dialog, '[data-folders]');
  const scroll = tree.scrollTop;
  tree.innerHTML = treeHtml(p);
  tree.scrollTop = scroll;
  indentRows(tree);
  /** @type {HTMLInputElement | null} */ (tree.querySelector('[data-new-folder]'))?.focus();
  paintTarget(dialog, p);
}

/**
 * The folder the items go to, below the lists, and whether they can go there.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 */
function paintTarget(dialog, p) {
  const target = copyTarget(p);
  find(dialog, '[data-target]').textContent = target && p.tab ? `To ${folderOf(p.tab, target)}` : '';
  /** @type {HTMLButtonElement} */ (find(dialog, '[data-ok]')).disabled = !target;
  /** @type {HTMLButtonElement} */ (find(dialog, '[data-mkdir]')).disabled = !target;
}

/**
 * Chooses a terminal: its tree shows, open at the folder last picked in it from this workspace, else at its shell's.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {Tab} tab
 */
function choose(dialog, p, tab) {
  if (p.tab === tab) return;
  const machine = machineOf(tab);
  if (!p.trees.has(machine)) p.trees.set(machine, new Map());
  Object.assign(p, { tab, nodes: p.trees.get(machine), open: new Set(), selected: null, error: null, naming: null });
  paint(dialog, p);
  reveal(dialog, p, memoOf()?.dirs[tab.id] ?? shellFolderOf(tab));
}

/** The terminals the filter shows, in order. @param {Picker} p */
const shownTerms = p => terminals().flatMap(({ name, tabs }) => tabs.filter(t => matches(t, name, p.filter)));

/**
 * The filter changed, or an arrow key moved: the terminal chosen stays if it's still shown, else the first one is.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {number} [step] up (-1) or down (1) the list
 */
function refilter(dialog, p, step = 0) {
  const shown = shownTerms(p);
  const at = p.tab ? shown.indexOf(p.tab) : -1;
  const next = shown[at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + step))];
  if (next) choose(dialog, p, next);
  paint(dialog, p);
  find(dialog, '.copyto-term.on')?.scrollIntoView({ block: 'nearest' });
}

/**
 * Makes a folder in the folder selected (the name typed in the row New folder adds under it), then selects it.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {string} name
 */
async function makeFolder(dialog, p, name) {
  const parent = p.naming;
  p.naming = null;
  if (!p.tab || !parent || !name) return paint(dialog, p);
  const path = childPath(parent, name);
  const m = await request(PAGE.filesOp, { id: p.tab.id, op: FILE_OP.makeDirectory, path });
  if (m.ok === false) {
    p.nodes.set(parent, { folders: p.nodes.get(parent)?.folders ?? [], entries: null, error: m.message });
    return paint(dialog, p);
  }
  p.nodes.delete(parent);
  await load(dialog, p, [parent]);
  select(dialog, p, path);
}

/**
 * The window's markup.
 * @param {number} count
 */
const pickerHtml = count => `
  <h3>Copy ${count === 1 ? '1 item' : `${count} items`} to</h3>
  <div class="copyto">
    <div class="copyto-side">
      <input class="field" data-filter placeholder="Filter terminals" spellcheck="false" autofocus>
      <div class="copyto-list" data-terms></div>
    </div>
    <div class="copyto-side">
      <div class="copyto-bar">
        <button class="btn small" data-mkdir title="New folder in the one selected">${ICONS.plus} New folder</button>
      </div>
      <div class="copyto-list copyto-tree" data-folders></div>
    </div>
  </div>
  <div class="dialog-actions">
    <span class="copyto-target" data-target></span>
    <button class="btn" data-cancel>Cancel</button>
    <button class="btn primary" data-ok>Copy here</button>
  </div>`;

/**
 * The window: resolves with the terminal and folder picked, or null.
 * @param {Tab} source
 * @param {number} count
 * @returns {Promise<{ tab: Tab, dir: string } | null>}
 */
function pickFolder(source, count) {
  /** @type {Picker} */
  const p = {
    source, tab: null, trees: new Map(), nodes: new Map(), open: new Set(), loading: new Set(), selected: null,
    error: null, filter: '', naming: null,
  };
  /** @type {(e: KeyboardEvent) => void} */
  let keys = () => {};
  const picked = modal('copyto-dialog', pickerHtml(count), (dialog, close) => {
    keys = pickerKeys(dialog, p);
    window.addEventListener('keydown', keys, true);
    wirePicker(dialog, p);
    // The terminal picked last time in this workspace; else the first that isn't the one the files are in.
    const last = listed(memoOf()?.tab ?? '');
    const first = last && hasFiles(last) ? last : shownTerms(p).find(t => t !== source) ?? source;
    choose(dialog, p, first);
    const submit = () => {
      const dir = copyTarget(p);
      if (p.tab && dir && !p.naming) close({ tab: p.tab, dir });
    };
    return { submit };
  });
  return picked.finally(() => window.removeEventListener('keydown', keys, true));
}

/**
 * The window's clicks and typing: a click selects a folder (its sign opens or closes it), a double click opens or
 * closes it.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 */
function wirePicker(dialog, p) {
  dialog.addEventListener('input', e => {
    if (!targetOf(e).matches('[data-filter]')) return;
    p.filter = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase();
    refilter(dialog, p);
  });
  dialog.addEventListener('click', e => {
    const term = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tab]'))?.dataset.tab;
    const node = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-node]'))?.dataset.node;
    if (term) choose(dialog, p, /** @type {Tab} */ (listed(term)));
    else if (node != null && targetOf(e).closest('[data-twist]') && e.detail < 2) toggle(dialog, p, node);
    else if (node != null) select(dialog, p, node);
    else if (targetOf(e).closest('[data-mkdir]') && copyTarget(p)) {
      p.naming = copyTarget(p);
      p.open.add(/** @type {string} */ (p.naming));
      paint(dialog, p);
      load(dialog, p, [/** @type {string} */ (p.naming)]);
    }
  });
  dialog.addEventListener('dblclick', e => {
    const node = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-node]'))?.dataset.node;
    // A double click on the sign was two clicks on it already.
    if (node != null && !targetOf(e).closest('[data-twist]')) toggle(dialog, p, node);
  });
  dialog.addEventListener('focusout', e => {
    if (targetOf(e).matches('[data-new-folder]')) makeFolder(dialog, p, /** @type {HTMLInputElement} */ (e.target).value.trim());
  });
}

/**
 * The keys the window takes before the dialog does: arrows move through the terminals; Enter and Escape in the new
 * folder's row make it or drop it rather than copying or closing.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 */
const pickerKeys = (dialog, p) => (/** @type {KeyboardEvent} */ e) => {
  const naming = targetOf(e).matches('[data-new-folder]');
  if (naming && (e.key === 'Enter' || e.key === 'Escape')) {
    e.preventDefault();
    e.stopPropagation();
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (e.key === 'Escape') input.value = '';
    input.blur();
  } else if (!naming && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    refilter(dialog, p, e.key === 'ArrowDown' ? 1 : -1);
  }
};
