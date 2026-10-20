// Fails on code that's grown too big to read in one go: a method or function over 50 lines, a C# class over 400. C# under
// src/ and installer/, and the page's JavaScript (wwwroot/js). scripts/baselines/size.json lists what was over when the
// check began; the refactor (issues #72, #75, #76) brings it down to nothing, so the check also fails when a listed one has
// shrunk below the limit or grown, until the baseline is updated (`node scripts/check-size.mjs --update`). `--report`
// lists everything over, largest first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = path.join(repo, 'scripts/baselines/size.json');
const MAX_METHOD = 50;
const MAX_CLASS = 400;
const SKIP_DIRS = new Set(['bin', 'obj', 'lib', 'node_modules']);

function files() {
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.name.endsWith('.cs') || (entry.name.endsWith('.js') && full.includes(`wwwroot${path.sep}js`))) {
        found.push(full);
      }
    }
  };
  for (const root of ['src', 'installer']) walk(path.join(repo, root));
  return found;
}

/** The text with comments, strings and character literals blanked out (same length, so positions hold). */
function code(text) {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|@"(?:""|[^"])*"|"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    m => m.replace(/[^\n]/g, ' '));
}

/**
 * JavaScript with comments, strings, template literals and regular expression literals blanked out (same length).
 * A scan rather than one pattern, since template literals nest: `${a ? `b` : 'c'}` holds strings of its own.
 */
function blankJs(text) {
  const out = text.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  /** A slash after one of these (or a keyword) starts a regular expression, not a division. */
  const BEFORE_REGEX = '(,=:[!&|?{};+-*%<>~^';
  let i = 0;
  // Code up to the brace that closes a template's ${ (when inside one), or the end.
  const scan = inTemplate => {
    let depth = 0;
    let prev = '';
    while (i < text.length) {
      const c = text[i], next = text[i + 1], start = i;
      if (c === '/' && next === '/') {
        i = text.indexOf('\n', i);
        if (i < 0) i = text.length;
        blank(start, i);
      } else if (c === '/' && next === '*') {
        i = text.indexOf('*/', i + 2);
        i = i < 0 ? text.length : i + 2;
        blank(start, i);
      } else if (c === '"' || c === "'") {
        for (i++; i < text.length && text[i] !== c && text[i] !== '\n'; i++) if (text[i] === '\\') i++;
        blank(start, ++i);
        prev = c;
      } else if (c === '`') {
        i++;
        template();
        blank(start, i);
        prev = c;
      } else if (c === '/' && (!prev || BEFORE_REGEX.includes(prev) || /\b(return|typeof|case|of|in)\s*$/.test(text.slice(Math.max(0, i - 8), i)))) {
        let inClass = false;
        for (i++; i < text.length && text[i] !== '\n' && (text[i] !== '/' || inClass); i++) {
          if (text[i] === '\\') i++;
          else if (text[i] === '[') inClass = true;
          else if (text[i] === ']') inClass = false;
        }
        for (i++; /[a-z]/.test(text[i] ?? ''); i++);
        blank(start, i);
        prev = '/';
      } else {
        if (c === '{') depth++;
        else if (c === '}' && depth-- === 0 && inTemplate) { i++; return; }
        if (!/\s/.test(c)) prev = c;
        i++;
      }
    }
  };
  // A template literal's text and its ${ } parts, up to and past its closing backtick.
  const template = () => {
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') i += 2;
      else if (text[i] === '$' && text[i + 1] === '{') { i += 2; scan(true); }
      else i++;
    }
    i++;
  };
  scan(false);
  return out.join('');
}

/** Where the brace that opens at `open` closes. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length - 1;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** C#: classes, records and structs over the limit, and methods, constructors and local functions with a body over it. */
function csharp(text) {
  const found = [];
  const blank = code(text);
  for (const m of blank.matchAll(/\b(class|record|struct)\s+(\w+)[^;{]*\{/g)) {
    const open = m.index + m[0].length - 1;
    const lines = lineAt(blank, closing(blank, open)) - lineAt(blank, m.index) + 1;
    if (lines > MAX_CLASS) found.push({ kind: 'class', name: m[2], lines });
  }
  const method = /(?:^|\n)[ \t]*(?:(?:public|private|protected|internal|static|async|override|virtual|sealed|unsafe|partial|extern|new)\s+)*[\w<>[\],.?() ]+?\s+(\w+)\s*(?:<[^>]*>)?\s*\([^;{]*?\)\s*(?:where[^{]*)?\{/g;
  for (const m of blank.matchAll(method)) {
    if (['if', 'for', 'foreach', 'while', 'switch', 'using', 'catch', 'lock', 'fixed', 'return', 'new'].includes(m[1])) continue;
    if (/\b(class|record|struct|interface)\b/.test(m[0])) continue; // a type with a primary constructor: measured as a class
    const open = m.index + m[0].length - 1;
    const lines = lineAt(blank, closing(blank, open)) - lineAt(blank, open) + 1;
    if (lines > MAX_METHOD) found.push({ kind: 'method', name: m[1], lines });
  }
  return found;
}

/** JavaScript: functions (declared, arrow or method) with a body over the limit. */
function javascript(text) {
  const found = [];
  const blank = blankJs(text);
  const patterns = [
    /\bfunction\s*\*?\s*(\w*)\s*\([^)]*\)\s*\{/g,
    /\b(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{/g,
    /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm,
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const m of blank.matchAll(pattern)) {
      if (['if', 'for', 'while', 'switch', 'catch', 'function'].includes(m[1])) continue;
      const open = m.index + m[0].length - 1;
      if (seen.has(open)) continue;
      seen.add(open);
      const lines = lineAt(blank, closing(blank, open)) - lineAt(blank, open) + 1;
      if (lines > MAX_METHOD) found.push({ kind: 'function', name: m[1] || '(anonymous)', lines });
    }
  }
  return found;
}

function measure() {
  const result = {};
  for (const full of files()) {
    const file = path.relative(repo, full).replaceAll('\\', '/');
    const text = fs.readFileSync(full, 'utf8').replaceAll('\r\n', '\n');
    const found = file.endsWith('.cs') ? csharp(text) : javascript(text);
    for (const f of found) {
      result[file] ??= {};
      const key = `${f.kind} ${f.name}`;
      result[file][key] = Math.max(result[file][key] ?? 0, f.lines);
    }
  }
  return result;
}

const found = measure();
const entries = Object.entries(found).flatMap(([file, keys]) => Object.entries(keys).map(([key, lines]) => ({ file, key, lines })));
if (process.argv.includes('--report')) {
  for (const e of entries.sort((a, b) => b.lines - a.lines)) console.log(`${String(e.lines).padStart(5)}  ${e.file}: ${e.key}`);
}
if (process.argv.includes('--update')) {
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(found).sort().map(([f, k]) => [f, Object.fromEntries(Object.entries(k).sort())]));
  fs.writeFileSync(baselineFile, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Baseline: ${entries.length} over the size limits.`);
  process.exit(0);
}
const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : {};
const problems = [];
for (const { file, key, lines } of entries) {
  const before = baseline[file]?.[key];
  if (before === undefined) problems.push(`${file}: ${key} is ${lines} lines (limit ${key.startsWith('class') ? MAX_CLASS : MAX_METHOD}): split it`);
  else if (lines > before) problems.push(`${file}: ${key} grew from ${before} to ${lines} lines: split it`);
}
for (const [file, keys] of Object.entries(baseline)) {
  for (const key of Object.keys(keys)) {
    if (found[file]?.[key] === undefined) problems.push(`${file}: ${key} is within the limit now: update the baseline (--update)`);
  }
}
for (const problem of problems) console.error(problem);
if (problems.length) process.exit(1);
console.log(`Size: ${entries.length} over the limits, none beyond the baseline.`);
