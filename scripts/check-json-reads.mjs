// Fails on a typed read of JSON that throws when the field has another type (JsonNode.GetValue<T>) in the app's C#.
// JSON comes from phones, other computers, hooks and files: read it with src/Shared/JsonRead.cs (AsText, AsBool,
// AsInt, AsLong), which give null for a wrong type, or TryGetValue. Tests may use GetValue.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules']);
const THROWING_READ = /(?<!Try)GetValue</;
const COMMENT = /^\s*(\/\/|\/\/\/|\*)/;

const found = [];
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
    } else if (entry.name.endsWith('.cs')) {
      fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (THROWING_READ.test(line) && !COMMENT.test(line)) found.push(`${path.relative(repo, full)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
};
walk(path.join(repo, 'src'));

if (found.length) {
  console.error(`JSON reads that throw on a wrong type (use JsonRead's AsText, AsBool, AsInt, AsLong):\n${found.join('\n')}`);
  process.exit(1);
}
console.log('JSON reads: none that throw on a wrong type.');
