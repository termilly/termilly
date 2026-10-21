// Tests for the Git window's Agent changes tree (src/Termilly.Desktop/wwwroot/js/changetree.js): a terminal's changed
// files as folders and files.
// Run with: node --test tests/js/changetree.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, flatten, folderKeys, folderKeysIn, fileOrder } from '../../src/Termilly.Desktop/wwwroot/js/changetree.js';

/**
 * A changed file as the host lists it: its path, the path shown, and its counts.
 * @param {string} display
 * @param {{ outside?: boolean, added?: number, removed?: number }} [extra]
 */
const file = (display, extra = {}) => ({ path: extra.outside ? display : `C:\\p\\${display}`, display, at: '', ...extra });

const files = [
  file('src\\api\\v2\\users.ts', { added: 3, removed: 1 }),
  file('src\\api\\v2\\orders.ts', { added: 2 }),
  file('README.md', { added: 1 }),
  file('C:\\Users\\me\\.bashrc', { outside: true }),
];

/** @param {ReturnType<typeof flatten>} rows */
const shown = rows => rows.map(r => `${'  '.repeat(r.depth)}${r.folder ? `${r.folder.name}/ ${r.folder.count}` : r.file.name}`);

test('folders come first, a chain of single folders is one row, outside the project is last', () => {
  assert.deepEqual(shown(flatten(buildTree(files), '', new Set())), [
    'src\\api\\v2/ 2',
    '  orders.ts',
    '  users.ts',
    'Outside the project/ 1',
    '  C:\\Users\\me/ 1',
    '    .bashrc',
    'README.md',
  ]);
});

test('folders add up their files and lines', () => {
  const src = [...buildTree(files).folders.values()][0];
  assert.deepEqual([src.count, src.added, src.removed], [2, 5, 1]);
});

test('a closed folder hides what is in it, a filter opens every folder with a match', () => {
  const tree = buildTree(files);
  // A merged row goes by its innermost folder's key.
  const closed = new Set(['/src/api/v2', '|outside']);
  assert.deepEqual(shown(flatten(tree, '', closed)), ['src\\api\\v2/ 2', 'Outside the project/ 1', 'README.md']);
  assert.deepEqual(shown(flatten(tree, 'orders', closed)), ['src\\api\\v2/ 2', '  orders.ts']);
});

test('a file is in the folders above it, and N and P go through the files in the tree order', () => {
  assert.deepEqual(folderKeys(files[0]), ['/src', '/src/api', '/src/api/v2']);
  assert.deepEqual(folderKeys(files[3]), ['|outside', '|outside/c:', '|outside/c:/users', '|outside/c:/users/me']);
  assert.deepEqual(fileOrder(files), [files[1].path, files[0].path, files[3].path, files[2].path]);
});

test('a big list can start with only its top folders open', () => {
  const tree = buildTree([file('a\\b\\one.ts'), file('a\\c\\two.ts')]);
  assert.deepEqual([...folderKeysIn(tree)].sort(), ['/a', '/a/b', '/a/c']);
  assert.deepEqual([...folderKeysIn(tree, { belowTop: true })].sort(), ['/a/b', '/a/c']);
});
