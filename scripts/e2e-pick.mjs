// @ts-check
// Which end-to-end tests a change needs (#97). Each tests/e2e/*.e2e.mjs file names what it covers on a "// Covers:"
// line: globs of page modules (js/…), stylesheets (css/…) and host files (src/…), or "always". A changed page module
// counts for every covered module that imports it, directly or through others, so a change to code many features use
// runs their tests. What no test claims runs all of them: an untested part is no reason to test nothing. Changes
// outside the app (docs, unit tests, the site) need none.
//
// Run: node scripts/e2e-pick.mjs [base [head]]   (the changes from base to head; with no head, to the working folder)
// Prints the test files to run, one a line, or nothing.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E = 'tests/e2e/';
const TEST_SUFFIX = '.e2e.mjs';
const PAGE = 'src/Termilly.Desktop/wwwroot/';
const PAGE_JS = `${PAGE}js/`;
/** Shorthands in "Covers:" lines. */
const SHORTHANDS = Object.freeze({ 'js/': PAGE_JS, 'css/': `${PAGE}css/` });
/** A test that runs whenever any end-to-end test does. */
const ALWAYS = 'always';
const COVERS = /^\/\/ Covers:(.*)$/m;
/**
 * What the end-to-end tests run on: a change to any of it can break any of them. The harness, the scripts that pick and
 * run the tests, the page's packages, and what builds the app from outside src/ (the page bundle, MSBuild's shared files).
 */
const RUNS_ALL = [/^tests\/e2e\/(?!.*\.e2e\.mjs$)/, /^scripts\/e2e-/, /^scripts\/(bundle\.mjs|BundlePage\.targets)$/,
  /^package(-lock)?\.json$/, /^Directory\.[^/]+\.(props|targets)$/, /^global\.json$/, /^[^/]+\.slnx?$/, /^nuget\.config$/i];
/** The app: what tests can cover. */
const APP = /^src\//;

/**
 * What one test file covers.
 * @typedef {{ always: boolean, globs: RegExp[] }} Coverage
 */

/**
 * A glob as a regular expression on a repository path: ** any folders, * any name part.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  const full = Object.entries(SHORTHANDS).reduce((g, [short, long]) => (g.startsWith(short) ? long + g.slice(short.length) : g), glob);
  const pattern = full.split('**').map(part => part.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${pattern}$`);
}

/**
 * A test file's coverage, from its "// Covers:" line (none: it covers nothing of its own).
 * @param {string} text
 * @returns {Coverage}
 */
export function coverageOf(text) {
  const words = (COVERS.exec(text)?.[1] ?? '').split(/\s+/).filter(Boolean);
  return { always: words.includes(ALWAYS), globs: words.filter(w => w !== ALWAYS).map(globToRegExp) };
}

/**
 * Who imports each page module: module path to the paths of the modules that import it.
 * @param {Map<string, string>} modules page module path to its text
 * @returns {Map<string, Set<string>>}
 */
export function importersOf(modules) {
  /** @type {Map<string, Set<string>>} */
  const importers = new Map();
  for (const [file, text] of modules) {
    for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)'(\.{1,2}\/[^']+\.js)'/g)) {
      const target = path.posix.join(path.posix.dirname(file), match[1]);
      if (!importers.has(target)) importers.set(target, new Set());
      /** @type {Set<string>} */ (importers.get(target)).add(file);
    }
  }
  return importers;
}

/**
 * A changed file and every page module that uses it, directly or through others.
 * @param {string} file
 * @param {Map<string, Set<string>>} importers
 */
export function affected(file, importers) {
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length) {
    for (const user of importers.get(/** @type {string} */ (queue.shift())) ?? []) {
      if (!seen.has(user)) {
        seen.add(user);
        queue.push(user);
      }
    }
  }
  return seen;
}

/**
 * The tests a change needs: their file names, all of them when something no test claims changed.
 * @param {{ changed: string[], tests: Map<string, Coverage>, importers: Map<string, Set<string>> }} change
 * @returns {{ all: boolean, tests: string[] }}
 */
export function pick({ changed, tests, importers }) {
  const picked = new Set();
  let all = false, app = false;
  for (const file of changed) {
    if (file.startsWith(E2E) && file.endsWith(TEST_SUFFIX)) {
      if (tests.has(path.posix.basename(file))) picked.add(path.posix.basename(file));
    } else if (RUNS_ALL.some(rule => rule.test(file))) {
      all = true;
    } else if (APP.test(file)) {
      app = true;
      const reach = file.startsWith(PAGE_JS) ? affected(file, importers) : new Set([file]);
      const claiming = [...tests].filter(([, c]) => c.globs.some(glob => [...reach].some(f => glob.test(f)))).map(([name]) => name);
      if (claiming.length === 0) all = true;
      for (const name of claiming) picked.add(name);
    }
  }
  if (all) return { all, tests: [...tests.keys()].sort() };
  if (app) for (const [name, c] of tests) if (c.always) picked.add(name); // any change to the app
  return { all, tests: [...picked].sort() };
}

/** The repository's end-to-end tests and what each covers. */
function readTests() {
  const folder = path.join(root, E2E);
  return new Map(readdirSync(folder).filter(n => n.endsWith(TEST_SUFFIX)).map(n => [n, coverageOf(readFileSync(path.join(folder, n), 'utf8'))]));
}

/** The page's modules, by repository path. */
function readModules() {
  /** @type {Map<string, string>} */
  const modules = new Map();
  const walk = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (entry.name.endsWith('.js')) modules.set(rel, readFileSync(path.join(root, rel), 'utf8'));
    }
  };
  walk(PAGE_JS);
  return modules;
}

/** Git's output, as text. @param {string[]} args */
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
/** A list of paths from git, NUL-separated so no name is quoted or split. @param {string[]} args */
const gitPaths = (/** @type {string} */ command, /** @type {string[]} */ ...args) => git(command, '-z', ...args).split('\0').filter(Boolean);

/**
 * The tests from one commit to another, read from the commits themselves: what the working folder holds doesn't count.
 * @param {string} base
 * @param {string} head
 * @returns {{ changed: string[], all: boolean, tests: string[] }}
 */
export function pickBetween(base, head) {
  const changed = gitPaths('diff', '--name-only', base, head);
  const testFiles = testFilesAt(head);
  const tests = new Map(testFiles.map(f => [path.posix.basename(f), coverageOf(git('show', `${head}:${f}`))]));
  const moduleFiles = gitPaths('ls-tree', '-r', '--name-only', head, PAGE_JS).filter(f => f.endsWith('.js'));
  const modules = new Map(moduleFiles.map(f => [f, git('show', `${head}:${f}`)]));
  return { changed, ...pick({ changed, tests, importers: importersOf(modules) }) };
}

/** The test files in a commit. @param {string} head */
export const testFilesAt = head => gitPaths('ls-tree', '--name-only', head, E2E).filter(f => f.endsWith(TEST_SUFFIX));

/** The files changed since a commit in the working folder, new ones not yet added too. @param {string} base */
const changedSince = base => [...new Set([...gitPaths('diff', '--name-only', base), ...gitPaths('ls-files', '--others', '--exclude-standard')])];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base = 'HEAD', head] = process.argv.slice(2);
  const { tests } = head ? pickBetween(base, head) : pick({ changed: changedSince(base), tests: readTests(), importers: importersOf(readModules()) });
  for (const name of tests) console.log(`${E2E}${name}`);
}
