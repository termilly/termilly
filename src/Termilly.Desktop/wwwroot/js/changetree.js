// @ts-check
// A terminal's changed files (tab.changes) as a tree of folders and files, for the Git window's Agent changes
// (js/gitagent.js). Pure: what to draw from a list, a filter and the folders closed by hand.

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

/** The key of the folder that holds files outside Claude's folder. */
const OUTSIDE_KEY = '|outside';

/**
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
export const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * The path a file is shown by in the tree: relative to Claude's folder, or whole when it's outside it.
 * @param {ChangedFile} f
 */
const shownPath = f => (f.outside ? f.path : f.display);

/**
 * The keys of the folders a file is in, outermost first.
 * @param {ChangedFile} f
 */
export function folderKeys(f) {
  const parts = shownPath(f).split(/[\\/]+/).filter(Boolean).slice(0, -1);
  let key = f.outside ? OUTSIDE_KEY : '';
  const keys = f.outside ? [key] : [];
  for (const part of parts) {
    key += `/${part.toLowerCase()}`;
    keys.push(key);
  }
  return keys;
}

/**
 * Folders and files from the files' paths relative to Claude's folder; files outside it go under a folder of their
 * own. A folder holding only one folder shows as one row (src/api/v2).
 * @param {ChangedFile[]} files
 */
export function buildTree(files) {
  /** @type {Folder} */
  const root = { key: '', name: '', folders: new Map(), files: [], count: 0, added: 0, removed: 0 };
  for (const f of files) {
    const shown = shownPath(f);
    const parts = shown.split(/[\\/]+/).filter(Boolean);
    const sep = shown.includes('\\') ? '\\' : '/'; // folders merged into one row are joined as the path has them
    let node = root;
    let key = f.outside ? OUTSIDE_KEY : '';
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
 * Every folder's key, or (belowTop) only those under the top level: a big list starts with only the top folders open.
 * @param {Folder} root
 * @param {{ belowTop?: boolean }} [options]
 */
export function folderKeysIn(root, { belowTop = false } = {}) {
  /** @type {Set<string>} */
  const keys = new Set();
  /** @param {Folder} node */
  const walk = node => node.folders.forEach(sub => { keys.add(sub.key); walk(sub); });
  if (belowTop) root.folders.forEach(walk); else walk(root);
  return keys;
}

/**
 * @param {{ name: string }} a
 * @param {{ name: string }} b
 */
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/**
 * Outside the project last, then by name.
 * @param {Folder} a
 * @param {Folder} b
 */
const folderOrder = (a, b) => Number(!!a.outside) - Number(!!b.outside) || byName(a, b);

/**
 * The rows to draw: open folders show what's in them; a filter shows only matching files, with their folders open.
 * @param {Folder} root
 * @param {string} filter lower-case
 * @param {Set<string>} collapsed the folders closed by hand
 */
export function flatten(root, filter, collapsed) {
  /** @type {TreeRow[]} */
  const out = [];
  /** @param {TreeFile} f */
  const matches = f => !filter || shownPath(f).toLowerCase().includes(filter);
  /**
   * @param {Folder} node
   * @param {number} depth
   */
  const walk = (node, depth) => {
    for (const folder of [...node.folders.values()].sort(folderOrder)) {
      const start = out.length;
      out.push({ folder, depth });
      walk(folder, depth + 1);
      if (filter && out.length === start + 1) out.pop(); // nothing in it matches
      else if (!filter && collapsed.has(folder.key)) out.length = start + 1;
    }
    for (const file of [...node.files].sort(byName)) {
      if (matches(file)) out.push({ file, depth });
    }
  };
  walk(root, 0);
  return out;
}

/**
 * The files in the tree's order with every folder open: what N and P go through.
 * @param {ChangedFile[]} files
 */
export const fileOrder = files => flatten(buildTree(files), '', new Set()).filter(r => r.file).map(r => /** @type {TreeFile} */ (r.file).path);
