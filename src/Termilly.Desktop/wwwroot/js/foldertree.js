// @ts-check
// Folder trees, as "Copy to" (copyto.js) and the Files panel (filepanel.js) draw them: from This PC (the drives) or a
// server's root down, a + on a folder with something to open. The host reads several folders at once, each with
// whether its folders have something in them (FolderTree.cs): one ssh call on a server.

import { PAGE } from './protocol.js';
import { request, platform, PLATFORM } from './host.js';
import { isSsh } from './store.js';
import { joinPath, parentOf, isWsl, wslRootOf } from './filepaths.js';
import { FOLDER_PATH } from './constants.js';

/** A file or folder, as the host lists it (Sftp.cs, LocalFiles.cs); a drive has its label. */
/**
 * @typedef {{ name: string, isDirectory: boolean, size: number, permissions: string, modified: string, label?: string | null }}
 *   FileEntry
 */
/** A folder in a tree, as the host lists it: its name (a drive's root), whether it has something to open, a drive's label. */
/** @typedef {{ name: string, hasFolders: boolean, label?: string | null }} TreeFolder */
/**
 * A folder once read: its folders, everything in it (the Files panel's, which asks for files), or why it couldn't be.
 * @typedef {{ folders: TreeFolder[], entries: FileEntry[] | null, error: string | null }} TreeNode
 */

/** How far each level of a tree is indented, in pixels, and the first level's room. */
export const INDENT_PX = 16;
export const TREE_START_PX = 4;
/** The open (minus) and closed (plus) signs: a box with 1px lines on whole pixels, so they stay crisp. */
const PLUS = '<svg class="tree-sign" viewBox="0 0 9 9"><rect x="0.5" y="0.5" width="8" height="8" rx="1"/><path d="M2 4.5h5M4.5 2v5"/></svg>';
const MINUS = '<svg class="tree-sign" viewBox="0 0 9 9"><rect x="0.5" y="0.5" width="8" height="8" rx="1"/><path d="M2 4.5h5"/></svg>';
/** A path the server or this machine knows as it is (not "~", which the host resolves first). */
const ABSOLUTE = /^\/|^[A-Za-z]:\\|^\\\\/;

/**
 * A row's sign: + (closed) or − (open) for a folder with something to open, else room for one.
 * @param {boolean} has
 * @param {boolean} open
 */
export const signHtml = (has, open) => `<span class="tree-twist" data-twist>${has ? (open ? MINUS : PLUS) : ''}</span>`;

/**
 * Where a terminal's tree starts: this PC's drives, or the root of its server (or of this machine, on Linux).
 * @param {Tab} tab
 */
export const rootOf = tab => (tab.pcFiles ? tab.pcFiles.root : isWsl(tab) ? wslRootOf(tab) : isSsh(tab) || platform !== PLATFORM.windows ? '/' : FOLDER_PATH.drives);

/**
 * A folder's path in a tree: a drive's is its root ("C:\").
 * @param {string} parent
 * @param {string} name
 */
export const childPath = (parent, name) => (parent === FOLDER_PATH.drives ? name : joinPath(parent, name));

/**
 * Indents a tree's rows (data-depth) once they're drawn: a style property, which the page's rules allow.
 * @param {HTMLElement} list
 */
export function indentRows(list) {
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('[data-depth]'))) {
    row.style.paddingLeft = `${TREE_START_PX + Number(row.dataset.depth) * INDENT_PX}px`;
  }
}

/**
 * The folders from the tree's root down to `path`, the root first.
 * @param {string} path
 * @param {string} root
 */
function chainOf(path, root) {
  const chain = [path];
  while (chain[0] !== root) {
    const up = parentOf(chain[0]);
    if (up === chain[0]) break;
    chain.unshift(up);
  }
  if (chain[0] !== root) chain.unshift(root);
  return chain;
}

/**
 * Reads folders into `nodes` (by the path asked and the full one); the host's error when it couldn't read any (no
 * connection), else null.
 * @param {Tab} tab
 * @param {Map<string, TreeNode>} nodes
 * @param {string[]} paths
 * @param {boolean} files the Files panel's: everything in them too
 * @returns {Promise<string | null>}
 */
export async function readFolders(tab, nodes, paths, files) {
  const m = await request(PAGE.filesTree, { id: tab.id, paths, files });
  for (const b of m.branches ?? []) {
    const node = { folders: b.folders ?? [], entries: b.entries ?? null, error: b.error ?? null };
    nodes.set(b.path, node);
    if (b.full) nodes.set(b.full, node);
  }
  return m.error ?? null;
}

/**
 * The folders from the root down to `path` that are there, as their folders name them (case aside, here on
 * Windows), all read: a tree opens them to show it. A folder gone since stops it at its parent.
 * @param {Tab} tab
 * @param {Map<string, TreeNode>} nodes
 * @param {string} path a full path, or "~" (a server's home: the host says where that is)
 * @param {boolean} files
 * @returns {Promise<{ there: string[], error: string | null }>}
 */
export async function pathDown(tab, nodes, path, files) {
  const root = rootOf(tab);
  let full = path;
  if (!ABSOLUTE.test(path)) {
    const m = await request(PAGE.filesTree, { id: tab.id, paths: [path], files });
    const b = m.branches?.[0];
    full = b?.full ?? root;
    if (b?.full) nodes.set(b.full, { folders: b.folders ?? [], entries: b.entries ?? null, error: null });
  }
  const chain = chainOf(full, root);
  const missing = chain.filter(c => !nodes.has(c));
  const error = missing.length ? await readFolders(tab, nodes, missing, files) : null;
  const caseless = tab.pcFiles ? tab.pcFiles.caseless : !isSsh(tab) && platform === PLATFORM.windows;
  const same = (/** @type {string} */ a, /** @type {string} */ b) => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);
  const there = [root];
  for (const c of chain.slice(1)) {
    const at = there[there.length - 1];
    const folder = nodes.get(at)?.folders.find(f => same(childPath(at, f.name), c));
    const node = nodes.get(c);
    if (!folder || !node || node.error) break;
    const named = childPath(at, folder.name);
    nodes.set(named, node);
    there.push(named);
  }
  return { there, error };
}
