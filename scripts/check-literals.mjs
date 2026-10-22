// Fails on magic values in Termilly's own code: a number written inline instead of as a named constant, or the same
// identifier-like string ("needs-input", "PreToolUse", "terminal:input") written in more than one place instead of
// coming from one constant. C# under src/ and installer/, and the page's JavaScript (wwwroot/js).
//
// What is allowed without a constant:
//   - numbers 0, 1, 2 and -1 (counting, halves, "not found"), and every number in a constant's own definition
//     (C# const or static readonly, JS UPPER_CASE const);
//   - strings with spaces (text people read: labels, messages, logs), and strings in a constant's definition;
//   - what scripts/baselines/literals-allow.json lists, each with its reason (DOM event names, for example);
//   - comments, test files, regular expressions and interpolated or template strings.
//
// scripts/baselines/literals.json holds what was there when the check began, per file. The refactor (issues #73, #76)
// brings it to zero: the check fails on anything new, and on a count that went down until the baseline is updated
// (`node scripts/check-literals.mjs --update`), so the baseline only ever shrinks. `--report` lists every finding.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = path.join(repo, 'scripts/baselines/literals.json');
const allowFile = path.join(repo, 'scripts/baselines/literals-allow.json');
const ROOTS = ['src', 'installer'];
const SKIP_DIRS = new Set(['bin', 'obj', 'lib', 'node_modules', 'types']);
const ALLOWED_NUMBERS = new Set(['0', '1', '2']);
/** A string that names something (a mode, a key, a message type), as opposed to text people read. */
const IDENTIFIER_LIKE = /^[A-Za-z0-9_.:\-/#@+$]{2,80}$/;

function sourceFiles() {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.name.endsWith('.cs') || (entry.name.endsWith('.js') && full.includes('wwwroot'))) {
        files.push(full);
      }
    }
  };
  for (const root of ROOTS) walk(path.join(repo, root));
  return files;
}

/**
 * The string and number literals in a file, with the line each is on. Skips comments, regular expressions,
 * interpolated/template/verbatim/raw strings and char literals: only plain literals are reported.
 */
function literals(text, js) {
  const found = [];
  let line = 1;
  let i = 0;
  let previous = ''; // the last significant character, to tell a regular expression from a division
  const push = (kind, value) => found.push({ kind, value, line });
  const skipQuoted = (quote, escapes) => {
    i++;
    let value = '';
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\n') line++;
      if (escapes && text[i] === '\\') {
        value += text[i] + text[i + 1];
        i += 2;
        continue;
      }
      value += text[i++];
    }
    i++;
    return value;
  };
  const skipTemplate = () => {
    i++;
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '\n') line++;
      if (c === '\\') { i += 2; continue; }
      if (depth === 0 && c === '`') { i++; return; }
      // Inside a ${ } part, braces nest (an object literal, an arrow's body): only the one that closes it ends it.
      if (c === '$' && text[i + 1] === '{') { depth++; i += 2; continue; }
      if (depth > 0 && c === '{') depth++;
      else if (depth > 0 && c === '}') depth--;
      else if (depth > 0 && (c === '\'' || c === '"')) { skipQuoted(c, true); continue; }
      else if (depth > 0 && c === '`') { skipTemplate(); continue; }
      i++;
    }
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (js && c === '/' && (previous === '' || '(,=:[!&|?{};+-*%<>~^'.includes(previous) || /return$|typeof$/.test(text.slice(Math.max(0, i - 7), i).trimEnd()))) {
      // A regular expression literal.
      i++;
      let inClass = false;
      while (i < text.length && text[i] !== '\n' && (text[i] !== '/' || inClass)) {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        i++;
      }
      if (text[i] === '/') i++; // unclosed at a line break: the break is counted with the other lines
      while (/[a-z]/.test(text[i] ?? '')) i++;
      previous = ')';
      continue;
    }
    if (js && c === '`') { skipTemplate(); previous = ')'; continue; }
    if (!js && c === '"' && text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3) === -1 ? text.length : text.indexOf('"""', i + 3);
      for (const ch of text.slice(i, end)) if (ch === '\n') line++;
      i = end + 3;
      previous = ')';
      continue;
    }
    if (!js && (c === '$' || c === '@') && (next === '"' || ((next === '$' || next === '@') && text[i + 2] === '"'))) {
      // Interpolated or verbatim C# string: skipped (interpolation holds code; verbatim ones are paths and text).
      i += next === '"' ? 1 : 2;
      if (text.startsWith('"""', i)) { const end = text.indexOf('"""', i + 3); i = end === -1 ? text.length : end + 3; }
      else skipQuoted('"', c === '$' && next === '"');
      previous = ')';
      continue;
    }
    if (!js && c === '\'') { skipQuoted('\'', true); previous = ')'; continue; }
    if (c === '"' || (js && c === '\'')) {
      const value = skipQuoted(c, true);
      push('string', value);
      previous = ')';
      continue;
    }
    if (/[0-9]/.test(c) && !/[A-Za-z0-9_$.]/.test(text[i - 1] ?? '')) {
      const m = /^(0[xX][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9]+)?([eE][+-]?[0-9]+)?)[a-zA-Z]*/.exec(text.slice(i));
      const negative = previous === '-' && /[(,=:[\s]-$/.test(text.slice(Math.max(0, i - 2), i));
      push('number', (negative ? '-' : '') + m[1].replaceAll('_', ''));
      i += m[0].length;
      previous = '0';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      while (/[A-Za-z0-9_$]/.test(text[i] ?? '')) i++;
      previous = 'a';
      continue;
    }
    previous = c;
    i++;
  }
  return found;
}

/** The lines that define constants, where literals belong. */
function definitionLines(text, js) {
  const lines = new Set();
  const all = text.split('\n');
  let open = 0; // a definition that continues over several lines (an array or object of constants)
  let continued = false; // the line before was a definition whose value starts on this line
  all.forEach((l, index) => {
    const definition = js
      ? /^\s*(export\s+)?const\s+[A-Z][A-Z0-9_]*\s*=/.test(l)
      : /\b(const|static\s+readonly|readonly\s+static)\b[^=]*=(?![=>])/.test(l) || /^\s*[A-Z][A-Za-z0-9]*\s*=\s*-?[0-9]/.test(l) ||
        /\[(?:property:\s*)?(?:[\w.]+\.)?(DllImport|LibraryImport|GeneratedRegex|StructLayout|FieldOffset|MarshalAs|JsonPropertyName|JsonDerivedType|JsonPolymorphic|SuppressMessage|InternalsVisibleTo)\b/.test(l) ||
        // A message record's name on the wire (Messaging/): its one definition.
        /\bstatic string Type => "/.test(l);
    if (definition || open > 0 || continued) {
      lines.add(index + 1);
      if (definition) open = 0;
      open += (l.match(/[[{(]/g) ?? []).length - (l.match(/[\]})]/g) ?? []).length;
      if (open < 0) open = 0;
      // A definition whose value starts on the next line ("X =", or its "[" / "{" on a line of its own).
      const next = (all[index + 1] ?? '').trim();
      continued = open === 0 && (/=\s*$/.test(l) || (definition && !/;\s*$/.test(l) && /^[[{]/.test(next)));
    } else {
      continued = false;
    }
  });
  return lines;
}

function findings() {
  // The allowed names come in groups, each with the reason it's allowed.
  const listed = fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, 'utf8')) : { groups: [], numbers: [] };
  const allow = { strings: new Set(listed.groups.flatMap(g => g.strings)), numbers: new Set(listed.numbers.map(String)) };
  const strings = new Map(); // "lang|value" -> [{file, line}]
  const result = {}; // file -> { "number 300": count, "string \"x\"": count }
  const add = (file, key) => {
    result[file] ??= {};
    result[file][key] = (result[file][key] ?? 0) + 1;
  };
  for (const full of sourceFiles()) {
    const file = path.relative(repo, full).replaceAll('\\', '/');
    const js = file.endsWith('.js');
    const text = fs.readFileSync(full, 'utf8').replaceAll('\r\n', '\n');
    const defined = definitionLines(text, js);
    const lines = text.split('\n');
    for (const literal of literals(text, js)) {
      if (defined.has(literal.line)) continue;
      // Module paths in imports name files, not values.
      // (A long import's last line is `} from './x.js';`.)
      if (js && /^\s*(import|export)\b.*\bfrom\s|^\s*\}\s*from\s|\bimport\(/.test(lines[literal.line - 1])) continue;
      if (literal.kind === 'number') {
        if (!ALLOWED_NUMBERS.has(literal.value) && literal.value !== '-1' && !allow.numbers.has(literal.value)) add(file, `number ${literal.value}`);
      } else if (IDENTIFIER_LIKE.test(literal.value) && !allow.strings.has(literal.value)) {
        const key = `${js ? 'js' : 'cs'}|${literal.value}`;
        if (!strings.has(key)) strings.set(key, []);
        strings.get(key).push(file);
      }
    }
  }
  // A string is magic when it's written more than once (in one file or across files) in the same language.
  for (const [key, files] of strings) {
    if (files.length < 2) continue;
    const value = key.slice(key.indexOf('|') + 1);
    for (const file of files) add(file, `string ${JSON.stringify(value)}`);
  }
  return result;
}

const found = findings();
const total = Object.values(found).reduce((sum, keys) => sum + Object.values(keys).reduce((a, b) => a + b, 0), 0);
if (process.argv.includes('--report')) {
  for (const [file, keys] of Object.entries(found).sort()) {
    for (const [key, count] of Object.entries(keys).sort()) console.log(`${file}: ${key}${count > 1 ? ` (x${count})` : ''}`);
  }
}
if (process.argv.includes('--update')) {
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(found).sort().map(([f, k]) => [f, Object.fromEntries(Object.entries(k).sort())]));
  fs.writeFileSync(baselineFile, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Baseline: ${total} magic values.`);
  process.exit(0);
}

const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : {};
const problems = [];
for (const [file, keys] of Object.entries(found)) {
  for (const [key, count] of Object.entries(keys)) {
    const before = baseline[file]?.[key] ?? 0;
    if (count > before) problems.push(`${file}: ${key} written ${count} times (baseline ${before}): name it as a constant`);
  }
}
for (const [file, keys] of Object.entries(baseline)) {
  for (const [key, before] of Object.entries(keys)) {
    const now = found[file]?.[key] ?? 0;
    if (now < before) problems.push(`${file}: ${key} went from ${before} to ${now}: update the baseline (--update)`);
  }
}
for (const problem of problems) console.error(problem);
if (problems.length) process.exit(1);
console.log(`Magic values: ${total}, none beyond the baseline.`);
