// @ts-check
// All the files Claude changed in a terminal, in one window: the folders and files as a tree on the left, the
// selected file's change on the right (the change preview itself, js/preview.js, borrowed while this is open). It
// opens from "Show all N files…" at the end of the changed-files list (js/changes.js) and from the palette, and
// follows the list live: files Claude goes on changing show up as they happen.

import { send } from './host.js';
import { PAGE } from './protocol.js';
import { state, on, tabTitle, EVENTS } from './store.js';
import { focusedTab, restoreFocus } from './panes.js';
import { closeAll } from './popups.js';
import { escapeHtml, ICONS } from './ui.js';
import { showChange, showMessage, setPreviewHost } from './preview.js';
import { changeWhat } from './changes.js';
import { debounce } from './util.js';
import { find, field, targetOf, resizeByGrip } from './dom.js';

/** @typedef {import('./changes.js').ChangedFile} ChangedFile */
/**
 * A file in the tree: the host's record and its name (the last part of its path).
 * @typedef {ChangedFile & { name: string }} TreeFile
 */
/**
 * A folder in the tree, keyed by its lower-case path, with what's in it and their totals.
 * @typedef {{ key: string, name: string, sep?: string, outside?: boolean, folders: Map<string, Folder>,
 *   files: TreeFile[], count: number, added: number, removed: number }} Folder
 */
/**
 * A row as drawn: a folder or a file, at a depth.
 * @typedef {{ folder: Folder, file?: undefined, depth: number }
 *   | { file: TreeFile, folder?: undefined, depth: number }} TreeRow
 */

const CHEVRON = '<svg viewBox="0 0 12 12"><path d="M4.5 3L7.5 6 4.5 9"/></svg>';
const CLOSE = '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
// Chevrons pointing apart (open everything) and together (close everything).
const EXPAND = '<svg viewBox="0 0 16 16"><path d="M5 6l3-3 3 3M5 10l3 3 3-3"/></svg>';
const COLLAPSE = '<svg viewBox="0 0 16 16"><path d="M5 3l3 3 3-3M5 13l3-3 3 3"/></svg>';

/** More files than this and only the top folders start open. */
const OPEN_ALL_UP_TO = 200;
/** The buttons in the window's head and over its tree (data-cw). */
const BUTTON = Object.freeze({ clear: 'clear', close: 'close', expand: 'expand', collapse: 'collapse' });
/** A row of the tree (a folder or a file), and the grip between the tree and the preview (app.css). */
const ROW = '.cw-row';
const GRIP = '.cw-grip';
/** How narrow and how wide the file tree can be dragged. */
const SIDE_MIN_PX = 200;
const SIDE_MAX_PX = 640;

const layer = document.createElement('div');
layer.className = 'modal-layer settings-layer changes-layer';
layer.hidden = true;
layer.innerHTML = `
  <div class="settings changes-win" role="dialog" aria-modal="true" aria-labelledby="cw-title">
    <div class="set-head">
      <h2 id="cw-title">Changed files</h2>
      <span class="cw-sub"></span>
      <span class="cw-stats"></span>
      <button class="btn small" data-cw="${BUTTON.clear}" title="Empty the list">Clear</button>
      <button class="set-close" data-cw="${BUTTON.close}" title="Close (Esc)">${CLOSE}</button>
    </div>
    <div class="cw-main">
      <div class="cw-side">
        <div class="cw-filter">
          <input class="field" placeholder="Filter files" spellcheck="false" autocomplete="off">
          <button class="pane-btn" data-cw="${BUTTON.expand}" title="Expand all folders">${EXPAND}</button>
          <button class="pane-btn" data-cw="${BUTTON.collapse}" title="Collapse all folders">${COLLAPSE}</button>
        </div>
        <div class="cw-tree" role="tree" tabindex="0" aria-label="Changed files"></div>
      </div>
      <div class="cw-grip" title="Drag to resize"></div>
      <div class="cw-preview"></div>
    </div>
  </div>`;
document.body.append(layer);

const subEl = find(layer, '.cw-sub');
const statsEl = find(layer, '.cw-stats');
const filterEl = field(layer, '.cw-filter input');
const treeEl = find(layer, '.cw-tree');
const sideEl = find(layer, '.cw-side');
const previewEl = find(layer, '.cw-preview');

/** @type {Tab | null} */
let tab = null;
/** @type {string | null} */
let selected = null; // the path shown on the right
/** @type {string | null} */
let cursor = null; // the row the keyboard is on: a folder's key or a file's path
/** @type {Set<string>} */
let collapsed = new Set(); // folder keys closed by hand (or at the start, for a big list)
/** @type {TreeRow[]} */
let rows = []; // what's drawn: { folder, key, depth, ... } or { file, depth }
/** @type {string[]} */
let drawnOrder = []; // every file in the tree's order when it was last drawn, closed folders included

const isOpen = () => !layer.hidden;
/**
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// ---- The tree ----

/**
 * Folders and files from the files' paths relative to Claude's folder; files outside it go under a folder of their
 * own. Folders come first, then files, each by name; a folder holding only one folder shows as one row (src/api/v2).
 * @param {ChangedFile[]} files
 */
function buildTree(files) {
  /** @type {Folder} */
  const root = { key: '', name: '', folders: new Map(), files: [], count: 0, added: 0, removed: 0 };
  for (const f of files) {
    const shown = f.outside ? f.path : f.display;
    const parts = shown.split(/[\\/]+/).filter(Boolean);
    const sep = shown.includes('\\') ? '\\' : '/'; // folders merged into one row are joined as the path has them
    let node = root;
    let key = f.outside ? '|outside' : '';
    if (f.outside) node = child(node, key, 'Outside the project', sep, true);
    for (const part of parts.slice(0, -1)) {
      key += `/${part.toLowerCase()}`;
      node = child(node, key, part, sep);
    }
    node.files.push({ ...f, name: parts.at(-1) ?? f.display });
  }
  total(root);
  return compress(root);
}

/**
 * A folder's subfolder by its key, made when it isn't there yet.
 * @param {Folder} node
 * @param {string} key
 * @param {string} name
 * @param {string} sep
 * @param {boolean} [outside]
 * @returns {Folder}
 */
function child(node, key, name, sep, outside = false) {
  let next = node.folders.get(key);
  if (!next) {
    next = { key, name, sep, outside, folders: new Map(), files: [], count: 0, added: 0, removed: 0 };
    node.folders.set(key, next);
  }
  return next;
}

/**
 * Counts each folder's files and lines, its subfolders' included.
 * @param {Folder} node
 */
function total(node) {
  node.count = node.files.length;
  node.added = node.files.reduce((sum, f) => sum + (f.added || 0), 0);
  node.removed = node.files.reduce((sum, f) => sum + (f.removed || 0), 0);
  for (const sub of node.folders.values()) {
    total(sub);
    node.count += sub.count;
    node.added += sub.added;
    node.removed += sub.removed;
  }
}

/**
 * Merges each chain of folders that hold only one folder into one.
 * @param {Folder} node
 * @returns {Folder}
 */
function compress(node) {
  for (const sub of node.folders.values()) compress(sub);
  for (const [key, sub] of [...node.folders]) {
    let merged = sub;
    while (!merged.outside && merged.files.length === 0 && merged.folders.size === 1) {
      const only = [...merged.folders.values()][0];
      if (only.outside) break;
      merged = { ...only, name: `${merged.name}${only.sep}${only.name}` };
    }
    if (merged !== sub) node.folders.set(key, merged);
  }
  return node;
}

/**
 * @param {{ name: string }} a
 * @param {{ name: string }} b
 */
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/**
 * The rows to draw: open folders show what's in them; a filter shows only matching files, with their folders open.
 * @param {Folder} root
 * @param {string} filter
 */
function flatten(root, filter) {
  /** @type {TreeRow[]} */
  const out = [];
  /** @param {TreeFile} f */
  const matches = f => !filter || (f.outside ? f.path : f.display).toLowerCase().includes(filter);
  /**
   * @param {Folder} node
   * @param {number} depth
   */
  const walk = (node, depth) => {
    // Outside the project last: in the subtraction a boolean counts as 0 or 1.
    const folders = [...node.folders.values()].sort((a, b) => (
      /** @type {number} */ (/** @type {unknown} */ (!!a.outside))
      - /** @type {number} */ (/** @type {unknown} */ (!!b.outside)))
      || byName(a, b));
    for (const folder of folders) {
      const start = out.length;
      out.push({ folder, depth });
      const open = filter || !collapsed.has(folder.key);
      walk(folder, depth + 1);
      if (filter && out.length === start + 1) out.pop(); // nothing in it matches
      else if (!open) out.length = start + 1;
    }
    for (const file of [...node.files].sort(byName)) {
      if (matches(file)) out.push({ file, depth });
    }
  };
  walk(root, 0);
  return out;
}

/** @param {TreeRow} row */
const keyOf = row => (row.folder ? `d:${row.folder.key}` : `f:${row.file.path.toLowerCase()}`);
/** @param {{ added?: number, removed?: number }} n */
const counts = n => (n.added || n.removed ? `<span class="pv-plus">+${n.added}</span> <span class="pv-minus">−${n.removed}</span>` : '');

function renderTree() {
  const files = tab?.changes ?? [];
  const filter = filterEl.value.trim().toLowerCase();
  rows = flatten(buildTree(files), filter);
  if (cursor && !rows.some(r => keyOf(r) === cursor)) cursor = null;
  treeEl.innerHTML = rows.length ? rows.map(row => {
    const indent = `style="padding-left:${8 + row.depth * 14}px"`;
    if (row.folder) {
      const f = row.folder;
      const open = filter || !collapsed.has(f.key);
      return `
        <div class="cw-row cw-folder${open ? ' open' : ''}${cursor === keyOf(row) ? ' cursor' : ''}" role="treeitem" aria-expanded="${!!open}" data-row="${escapeHtml(keyOf(row))}" ${indent}>
          <span class="cw-chev">${CHEVRON}</span><span class="cw-icon">${ICONS.folder}</span>
          <span class="cw-name">${escapeHtml(f.name)}</span>
          <span class="cw-count">${f.count}</span>
          <span class="cw-what">${counts(f)}</span>
        </div>`;
    }
    const f = row.file;
    const isSelected = samePath(f.path, selected);
    return `
      <div class="cw-row cw-file${isSelected ? ' selected' : ''}${cursor === keyOf(row) ? ' cursor' : ''}" role="treeitem" aria-selected="${isSelected}" data-row="${escapeHtml(keyOf(row))}" title="${escapeHtml(f.path)}" ${indent}>
        <span class="cw-chev"></span>
        <span class="cw-name">${escapeHtml(f.name)}</span>
        <span class="cw-what">${changeWhat(f)}</span>
      </div>`;
  }).join('') : `<p class="change-empty">${files.length ? 'No file matches the filter.' : 'Claude hasn’t changed any files in this terminal yet.'}</p>`;
  treeEl.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
  drawnOrder = fileOrder();
}

function renderHead() {
  const files = tab?.changes ?? [];
  subEl.textContent = tab ? `${tabTitle(tab)} · ${files.length} file${files.length === 1 ? '' : 's'}` : '';
  const added = files.reduce((sum, f) => sum + (f.added || 0), 0);
  const removed = files.reduce((sum, f) => sum + (f.removed || 0), 0);
  statsEl.innerHTML = counts({ added, removed });
  find(layer, `[data-cw="${BUTTON.clear}"]`).hidden = !files.length;
}

/** The files in the tree's order, as drawn (folders closed by hand still count): what N and P go through. */
function fileOrder() {
  const filter = filterEl.value.trim().toLowerCase();
  const saved = collapsed;
  collapsed = new Set();
  const all = flatten(buildTree(tab?.changes ?? []), filter);
  collapsed = saved;
  return all.filter(r => r.file).map(r => /** @type {TreeFile} */ (r.file).path);
}

// ---- Showing a file ----

/**
 * Selects a file: its row (with its folders opened), and its change on the right unless `show` is false.
 * @param {string} path
 * @param {{ focusPreview?: boolean, show?: boolean }} [options]
 */
function select(path, { focusPreview = false, show = true } = {}) {
  if (!tab) return;
  selected = path;
  cursor = `f:${path.toLowerCase()}`;
  // Its folders open, so the row can be seen.
  const file = (tab.changes ?? []).find(f => samePath(f.path, path));
  if (file) {
    const parts = (file.outside ? file.path : file.display).split(/[\\/]+/).filter(Boolean).slice(0, -1);
    let key = file.outside ? '|outside' : '';
    if (file.outside) collapsed.delete(key);
    for (const part of parts) {
      key += `/${part.toLowerCase()}`;
      collapsed.delete(key);
    }
  }
  renderTree();
  if (show) showChange(tab, path, { focus: focusPreview });
}

/** With nothing selected (opening, or the selected file taken off the list): the first file, or a message. */
function selectFirst() {
  const first = fileOrder()[0];
  if (first) select(first);
  else {
    selected = null;
    renderTree();
    showMessage(/** @type {Tab} */ (tab), 'Claude hasn’t changed any files in this terminal yet. When it does, they’re listed here.');
    treeEl.focus();
  }
}

// ---- Opening and closing ----

/**
 * Opens the window on a terminal's changed files.
 * @param {Tab | null} [forTab]
 */
export function openAllChanges(forTab = focusedTab()) {
  if (!forTab) return;
  closeAll();
  tab = forTab;
  selected = null;
  cursor = null;
  filterEl.value = '';
  collapsed = new Set();
  const files = tab.changes ?? [];
  if (files.length > OPEN_ALL_UP_TO) {
    // Only the top level open: every folder below it starts closed.
    const root = buildTree(files);
    /** @param {Folder} node */
    const closeBelow = node => node.folders.forEach(sub => { collapsed.add(sub.key); closeBelow(sub); });
    root.folders.forEach(closeBelow);
  }
  layer.hidden = false;
  setPreviewHost(previewEl, { order: fileOrder });
  renderHead();
  selectFirst();
  treeEl.focus();
}

export function closeAllChanges() {
  if (layer.hidden) return;
  layer.hidden = true;
  setPreviewHost(null);
  tab = null;
  rows = [];
  treeEl.innerHTML = '';
  restoreFocus();
}

on(EVENTS.openAllChanges, t => openAllChanges(t));

// The list changes while it's open: a file Claude changed, one removed, Clear.
on(EVENTS.changes, t => {
  if (!isOpen() || t !== tab) return;
  renderHead();
  const files = /** @type {Tab} */ (tab).changes ?? [];
  if (selected && !files.some(f => samePath(f.path, selected))) {
    // The shown file was taken off the list: the one after it (or the new last one) takes its place.
    const at = drawnOrder.findIndex(p => samePath(p, selected));
    const order = fileOrder();
    selected = null;
    if (order.length && at >= 0) select(order[Math.min(at, order.length - 1)]);
    else selectFirst();
    return;
  }
  const keep = treeEl.scrollTop;
  renderTree();
  treeEl.scrollTop = keep;
});

// The preview moved to another file (N, P): the tree follows.
on(EVENTS.previewShown, ({ tab: t, path }) => {
  if (!isOpen() || t !== tab || samePath(path, selected)) return;
  select(path, { show: false }); // already showing
});

// The terminal closed.
on(EVENTS.workspaces, () => {
  if (isOpen() && !state.tabs.has(/** @type {string} */ (tab?.id))) closeAllChanges();
});

// ---- Mouse ----

treeEl.addEventListener('click', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
  if (!row) return;
  const r = rows.find(x => keyOf(x) === row.dataset.row);
  if (!r) return;
  cursor = keyOf(r);
  if (r.folder) toggle(r.folder);
  else select(r.file.path);
  treeEl.focus();
});

/**
 * Opens or closes a folder (by default the other way from now).
 * @param {Folder} folder
 * @param {boolean} [open]
 */
function toggle(folder, open = collapsed.has(folder.key)) {
  if (filterEl.value.trim()) return; // a filter keeps every folder with a match open
  if (open) collapsed.delete(folder.key); else collapsed.add(folder.key);
  renderTree();
}

layer.addEventListener('click', e => {
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-cw]'))?.dataset.cw;
  if (action === BUTTON.close) closeAllChanges();
  if (action === BUTTON.clear && tab) send(PAGE.changesClear, { id: tab.id });
  if (action === BUTTON.expand || action === BUTTON.collapse) setAllFolders(action === BUTTON.expand);
});

/**
 * Opens or closes every folder (a filter keeps the matching ones open anyway); closing them puts the keyboard on the first row.
 * @param {boolean} open
 */
function setAllFolders(open) {
  collapsed = new Set();
  if (!open) {
    /** @param {Folder} node */
    const closeAll = node => node.folders.forEach(sub => { collapsed.add(sub.key); closeAll(sub); });
    closeAll(buildTree(tab?.changes ?? []));
    if (cursor?.startsWith('f:')) cursor = null;
  }
  renderTree();
  if (!cursor && rows.length) cursor = keyOf(rows[0]);
  renderTree();
  treeEl.focus();
}

layer.addEventListener('mousedown', e => {
  if (e.target === layer) closeAllChanges();
});

filterEl.addEventListener('input', () => {
  cursor = null;
  renderTree();
});

// ---- Keys ----

/** How long the cursor rests on a file before it's shown (arrowing through the list shows only where it stops). */
const SHOW_DELAY = 120;
const showLater = debounce(/** @param {string} path */ path => isOpen() && select(path), SHOW_DELAY);

/**
 * Moves the keyboard to a row; a file is shown a moment later, so holding an arrow key doesn't load every one.
 * @param {number} index
 */
function moveTo(index) {
  const r = rows[Math.max(0, Math.min(rows.length - 1, index))];
  if (!r) return;
  cursor = keyOf(r);
  renderTree();
  if (r.file) showLater(r.file.path);
  else showLater.cancel();
}

treeEl.addEventListener('keydown', e => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const at = rows.findIndex(r => keyOf(r) === cursor);
  const row = rows[at];
  switch (e.key) {
    case 'ArrowDown': moveTo(at + 1); break;
    case 'ArrowUp': moveTo(at < 0 ? 0 : at - 1); break;
    case 'Home': moveTo(0); break;
    case 'End': moveTo(rows.length - 1); break;
    case 'ArrowRight':
      if (row?.folder) {
        if (collapsed.has(row.folder.key)) toggle(row.folder, true);
        else moveTo(at + 1);
      }
      break;
    case 'ArrowLeft':
      if (row?.folder && !collapsed.has(row.folder.key) && !filterEl.value.trim()) toggle(row.folder, false);
      else {
        // To the folder it's in.
        for (let i = at - 1; i >= 0; i--) {
          if (rows[i].folder && rows[i].depth < row.depth) { moveTo(i); break; }
        }
      }
      break;
    case 'Enter':
      if (row?.folder) toggle(row.folder);
      else if (row?.file) select(row.file.path, { focusPreview: true });
      break;
    case 'Delete':
    case 'Backspace':
      if (row?.file) send(PAGE.changesClear, { id: /** @type {Tab} */ (tab).id, path: row.file.path });
      break;
    default:
      // Typing goes to the filter.
      if (e.key.length === 1 && e.key !== ' ') filterEl.focus();
      return;
  }
  e.preventDefault();
});

filterEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault();
    treeEl.focus();
    if (rows.length) moveTo(rows.findIndex(r => r.file));
  } else if (e.key === 'Escape' && filterEl.value) {
    e.preventDefault();
    e.stopPropagation();
    filterEl.value = '';
    renderTree();
  }
});

// Keys in the window stay in it (no app shortcuts, no terminal); Escape closes it.
layer.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault();
    closeAllChanges();
  }
  e.stopPropagation();
});

// ---- Resizing the tree ----

resizeByGrip(find(layer, GRIP), sideEl, SIDE_MIN_PX, SIDE_MAX_PX);
