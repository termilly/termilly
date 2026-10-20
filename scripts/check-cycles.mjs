// Fails when the page's modules (wwwroot/js) import each other in a circle that isn't in the baseline.
//
// An import A -> B is circular when B, through its own imports, leads back to A. Both static imports and dynamic
// import() calls count: a dynamic one only hides the circle. scripts/baselines/cycles.json lists the circular imports
// there were when this check began; the refactor (issue #75) removes them, so the check also fails when a listed
// import is no longer circular, until it's taken out of the baseline (`node scripts/check-cycles.mjs --update`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(repo, 'src/Termilly.Desktop/wwwroot/js');
const baselineFile = path.join(repo, 'scripts/baselines/cycles.json');
const IMPORT = /(?:\bimport\s[^'"]*?from\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** module name (path under js/) -> the modules it imports */
function graph() {
  const modules = new Map();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) modules.set(name(full), imports(full));
    }
  };
  walk(folder);
  return modules;
}

const name = file => path.relative(folder, file).replaceAll('\\', '/');

function imports(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...new Set([...text.matchAll(IMPORT)].map(m => name(path.resolve(path.dirname(file), m[1]))))];
}

/** Every module reachable from `start`. */
function reachable(modules, start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    for (const next of modules.get(stack.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

function circularImports(modules) {
  const found = [];
  for (const [from, targets] of modules) {
    for (const to of targets) {
      if (reachable(modules, to).has(from)) found.push(`${from} -> ${to}`);
    }
  }
  return found.sort();
}

const found = circularImports(graph());
if (process.argv.includes('--update')) {
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify(found, null, 2) + '\n');
  console.log(`Baseline: ${found.length} circular imports.`);
  process.exit(0);
}

const baseline = new Set(fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : []);
const added = found.filter(edge => !baseline.has(edge));
const gone = [...baseline].filter(edge => !found.includes(edge));
for (const edge of added) console.error(`New circular import: ${edge}`);
for (const edge of gone) console.error(`No longer circular, take it out of the baseline: ${edge}`);
if (added.length || gone.length) {
  console.error('Fix the imports, or run `node scripts/check-cycles.mjs --update` once the baseline only shrinks.');
  process.exit(1);
}
console.log(`Import cycles: ${found.length} circular imports, all in the baseline.`);
