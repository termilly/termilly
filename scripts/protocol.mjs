// Writes src/Termilly.Desktop/wwwroot/js/protocol.js from the message records in src/Termilly.Desktop/Messaging: the
// name of every message the page and the host exchange, and a JSDoc type for each one's fields. The C# records are
// the one place a message is defined; `--check` (npm run check) fails when protocol.js isn't what they make.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(repo, 'src/Termilly.Desktop/Messaging');
const target = path.join(repo, 'src/Termilly.Desktop/wwwroot/js/protocol.js');

/** Splits at commas that aren't inside brackets, parentheses or generics. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const c of text) {
    if ('(<[{'.includes(c)) depth++;
    else if (')>]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map(p => p.trim()).filter(Boolean);
}

const camel = name => name[0].toLowerCase() + name.slice(1);
const keyOf = type => type.replace(/[:-](\w)/g, (_, c) => c.toUpperCase());

/** The JSDoc type for a C# type. */
function jsType(cs, records) {
  let type = cs.trim();
  let nullable = false;
  if (type.endsWith('?')) {
    nullable = true;
    type = type.slice(0, -1);
  }
  let js;
  const list = /^(?:IReadOnlyList|IEnumerable|List)<(.+)>$/.exec(type) ?? /^(.+)\[\]$/.exec(type);
  const map = /^(?:IReadOnlyDictionary|Dictionary)<\s*string\s*,\s*(.+)>$/.exec(type);
  if (list) js = `Array<${jsType(list[1], records)}>`;
  else if (map) js = `Object<string, ${jsType(map[1], records)}>`;
  else if (type === 'string') js = 'string';
  else if (type === 'bool') js = 'boolean';
  else if (['int', 'long', 'double'].includes(type)) js = 'number';
  else if ([...records.values()].some(r => r.name === type && !r.message)) js = type;
  else js = 'any'; // JsonElement, JsonObject, object, and the app's own records the page reads as it likes
  return nullable ? `${js}|null` : js;
}

/** Every record in the Messaging folder: its fields, and its message type and direction when it's a message. */
function readRecords() {
  const records = new Map();
  for (const file of fs.readdirSync(folder).filter(f => f.endsWith('.cs')).sort()) {
    const text = fs.readFileSync(path.join(folder, file), 'utf8').replaceAll('\r\n', '\n');
    const sides = [...text.matchAll(/internal static partial class (FromPage|ToPage)\n\{/g)].map(m => ({ side: m[1], at: m.index }));
    const re = /internal sealed record (\w+)(\(([^;{]*?)\))?\s*(?::\s*(IPageMessage|IHostMessage))?\s*(;|\{)/gs;
    let m;
    while ((m = re.exec(text))) {
      const [, name, , params = '', iface, open] = m;
      let body = '';
      if (open === '{') {
        let depth = 1;
        let i = re.lastIndex;
        while (depth) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') depth--;
          i++;
        }
        body = text.slice(re.lastIndex, i - 1);
      }
      const fields = splitTopLevel(params.replace(/\/\/.*$/gm, '')).map(p => {
        const renamed = /JsonPropertyName\("([^"]+)"\)/.exec(p)?.[1];
        // Attributes ([JsonPropertyName(…)]) come first; a type's own brackets (string[]) stay.
        const clean = p.replace(/^(\s*\[[^\]]*\])+\s*/, '').replace(/\s*=.*$/s, '').trim();
        const at = clean.lastIndexOf(' ');
        return { name: renamed ?? camel(clean.slice(at + 1)), type: clean.slice(0, at), optional: /=/.test(p) };
      });
      for (const prop of body.matchAll(/^\s*public (?!static)([\w?<>,\s[\]]+?) (\w+) \{ get; \}/gm)) {
        fields.push({ name: camel(prop[2]), type: prop[1], optional: false });
      }
      // Its name on the wire: written here, or another record's (a variant, or the reply sharing its request's name).
      const typed = /public static string Type => (?:"([^"]+)"|((?:\w+\.)?\w+)\.Type);/.exec(body);
      const side = sides.filter(s => s.at < m.index).pop()?.side ?? null;
      records.set(`${side}.${name}`, { name, side, type: typed?.[1] ?? null, sameAs: typed?.[2] ?? null, fields, message: iface ?? null });
    }
  }
  for (const r of records.values()) {
    if (r.sameAs) r.type = records.get(r.sameAs.includes('.') ? r.sameAs : `${r.side}.${r.sameAs}`).type;
  }
  return records;
}

function generate() {
  const records = readRecords();
  const page = new Map(); // type -> [record]
  const host = new Map();
  for (const r of records.values()) {
    if (!r.message) continue;
    const into = r.message === 'IPageMessage' ? page : host;
    if (!into.has(r.type)) into.set(r.type, []);
    into.get(r.type).push(r);
  }
  // What the host asks the page (ToPage.Calls): received like the host's messages.
  const calls = fs.readFileSync(path.join(folder, 'Agents.cs'), 'utf8');
  for (const call of calls.matchAll(/public const string \w+ = "([^"]+)";/g)) {
    if (/class Calls/.test(calls.slice(0, call.index)) && !host.has(call[1])) host.set(call[1], []);
  }

  const typedef = (name, fields, optional) =>
    `/** @typedef {{ ${fields.map(f => `${f.name}${optional || f.optional ? '?' : ''}: ${jsType(f.type, records)}`).join(', ')} }} ${name} */`;
  const lines = [
    '// @ts-check',
    '// Every message the page and the host exchange: their names and, as JSDoc types, what each carries.',
    '// Generated by scripts/protocol.mjs from the records in src/Termilly.Desktop/Messaging. Don\'t edit it by hand:',
    '// change the record, then run `node scripts/protocol.mjs`.',
    '',
    '/** What the page sends the host (send). */',
    'export const PAGE = Object.freeze({',
    ...[...page.keys()].sort().map(t => `  ${keyOf(t)}: '${t}',`),
    '});',
    '',
    '/** What the host sends the page (onHost), including what it asks the page to answer (with api:result). */',
    'export const HOST = Object.freeze({',
    ...[...host.keys()].sort().map(t => `  ${keyOf(t)}: '${t}',`),
    '});',
    '',
  ];
  const helpers = [...records.values()].filter(r => !r.message && r.fields.length && /^[A-Z]/.test(r.name));
  for (const r of helpers) lines.push(typedef(r.name, r.fields, false));
  lines.push('');
  for (const [type, variants] of [...page].sort()) lines.push(typedef(`Page_${keyOf(type)}`, variants[0].fields, true));
  lines.push('');
  for (const [type, variants] of [...host].sort()) {
    const name = `Host_${keyOf(type)}`;
    if (!variants.length) lines.push(`/** @typedef {{ requestId: string, method?: string, args?: any }} ${name} */`);
    else if (variants.length === 1) lines.push(typedef(name, variants[0].fields, false));
    else {
      variants.forEach((v, i) => lines.push(typedef(`${name}_${i}`, v.fields, false)));
      lines.push(`/** @typedef {${variants.map((_, i) => `${name}_${i}`).join('|')}} ${name} */`);
    }
  }
  lines.push('');
  lines.push(`/** @typedef {{ ${[...page.keys()].sort().map(t => `'${t}': Page_${keyOf(t)}`).join(', ')} }} PageMessages */`);
  lines.push(`/** @typedef {{ ${[...host.keys()].sort().map(t => `'${t}': Host_${keyOf(t)}`).join(', ')} }} HostMessages */`);
  return lines.join('\n') + '\n';
}

const text = generate();
if (process.argv.includes('--check')) {
  const now = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') : '';
  if (now !== text) {
    console.error('js/protocol.js is out of date with the C# message records: run `node scripts/protocol.mjs`.');
    process.exit(1);
  }
  console.log('Protocol: js/protocol.js matches the C# message records.');
} else {
  fs.writeFileSync(target, text);
  console.log(`Wrote ${path.relative(repo, target)}.`);
}
