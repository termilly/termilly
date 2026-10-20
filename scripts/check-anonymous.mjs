// Fails on an anonymous object (`new { ... }`) in the app's C#. What the host sends to the page, the API or a file is a
// record, so its shape has a name and the protocol generator (scripts/protocol.mjs) can see it. Tests may use them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules']);
const ANONYMOUS = /\bnew\s*\{/;
const COMMENT = /^\s*\/\//;

const found = [];
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
    } else if (entry.name.endsWith('.cs')) {
      fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (ANONYMOUS.test(line) && !COMMENT.test(line)) found.push(`${path.relative(repo, full)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
};
for (const root of ['src', 'installer']) walk(path.join(repo, root));

if (found.length) {
  console.error(`Anonymous objects (use a sealed record):\n${found.join('\n')}`);
  process.exit(1);
}
console.log('No anonymous objects.');
