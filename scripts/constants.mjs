// Writes what the page shares with the host from the host's C#, so each is written once, there:
//   - wwwroot/js/constants.js: the values (a setting's choices, an agent's states, where a profile comes from), from
//     the constant classes;
//   - types/host.d.ts: the shapes of what the host sends, for the type checker: settings.json's (AppSettings and the
//     records it holds) and a shell profile's.
// `--check` (npm run check) fails when either isn't what the C# makes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(repo, 'src/Termilly.Desktop');
const target = path.join(desktop, 'wwwroot/js/constants.js');
const typesTarget = path.join(desktop, 'types/host.d.ts');

/** The C# classes the page gets, and the name each has there. A class with nested classes becomes nested objects. */
const SOURCES = [
  { file: 'ProfileKinds.cs', cls: 'ProfileSources', js: 'PROFILE_SOURCE' },
  { file: 'ProfileKinds.cs', cls: 'ProfileIcons', js: 'PROFILE_ICON' },
  { file: 'ProfileKinds.cs', cls: 'ProfileIds', js: 'PROFILE_ID_PREFIX' },
  { file: 'ProfileKinds.cs', cls: 'StreamCommands', js: 'STREAM_COMMAND' },
  { file: 'AgentStates.cs', cls: 'AgentStates', js: 'AGENT_STATE' },
  { file: 'Messaging/Agents.cs', cls: 'AgentSources', js: 'AGENT_SOURCE' },
  { file: 'Changes/ChangeModel.cs', cls: 'ChangeSources', js: 'CHANGE_SOURCE' },
  { file: 'Changes/ChangeModel.cs', cls: 'ChangeKinds', js: 'CHANGE_KIND' },
  { file: '../Shared/HookEvents.cs', cls: 'HookEvents', js: 'HOOK_EVENT' },
  { file: '../Shared/ClaudeTools.cs', cls: 'ClaudeTools', js: 'CLAUDE_TOOL' },
  { file: 'GitCommands.cs', cls: 'GitActions', js: 'GIT_ACTION' },
  { file: 'GitCommands.cs', cls: 'DiffSides', js: 'DIFF_SIDE' },
  { file: 'GitSearch.cs', cls: 'GitSearchMatches', js: 'GIT_MATCH' },
  { file: 'Messaging/Connections.cs', cls: 'ForwardStates', js: 'FORWARD_STATE' },
  { file: 'Messaging/Window.cs', cls: 'WindowActions', js: 'WINDOW_ACTION' },
  { file: 'Messaging/Window.cs', cls: 'QuitAnswers', js: 'QUIT_ANSWER' },
  { file: 'UpdateInstall.cs', cls: 'UpdateStates', js: 'UPDATE_STATE' },
  { file: 'Settings/SettingValues.cs', cls: 'SettingValues', js: 'SETTING_VALUES' },
  { file: 'Settings/SettingGroups.cs', cls: 'TerminalSettings', js: 'TERMINAL_SETTINGS' },
];

/** The files with the records the page gets as they are: AppSettings and every record it holds, and SessionProfile. */
const TYPE_FILES = ['Settings/AppSettings.cs', 'Settings/SettingGroups.cs', 'Settings/SettingRecords.cs', 'SerialConsole.cs', 'SshConnections.cs', 'SessionProfiles.cs'];

const camel = name => name[0].toLowerCase() + name.slice(1);

/** The body of `class <name> {` (or a record's), from the brace after it to the one that closes it. */
function classBody(text, name, from = 0) {
  const m = new RegExp(`\\b(?:class|record) ${name}\\b[^{]*\\{`, 'g');
  m.lastIndex = from;
  const found = m.exec(text);
  if (!found) throw new Error(`class ${name} not found`);
  let depth = 1;
  let i = found.index + found[0].length;
  const start = i;
  for (; depth && i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
  }
  return text.slice(start, i - 1);
}

/** A class's own members (its nested classes' bodies taken out), and its nested classes by name. */
function split(body) {
  const nested = [];
  let own = body;
  for (const m of body.matchAll(/(?:\/\/\/[^\n]*\n\s*)*public static class (\w+)\s*\{/g)) {
    if (nested.some(n => m.index < n.end)) continue;
    const inner = classBody(body, m[1], m.index);
    const end = body.indexOf(inner, m.index) + inner.length + 1;
    nested.push({ name: m[1], body: inner, end, text: body.slice(m.index, end) });
  }
  for (const n of nested) own = own.replace(n.text, '');
  return { own, nested };
}

/** A C# value: a string or number literal, or a constant named here, in the class or another class. */
function value(expr, scope, all) {
  const text = expr.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) return JSON.parse(text);
  if (/^-?[\d_]+(\.\d+)?$/.test(text)) return Number(text.replaceAll('_', ''));
  if (/^\[.*\]$/s.test(text)) return text.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).map(v => value(v, scope, all));
  const [cls, name] = text.includes('.') ? text.split('.') : [null, text];
  const from = cls ? all.get(cls) : scope;
  if (!from || !(name in from)) throw new Error(`can't resolve ${text}`);
  return from[name];
}

/** A class's constants and lists (methods and the rest are the host's own), as name → value. */
function members(own, all) {
  const scope = {};
  const re = /public (?:const (?:string|int|double)|static readonly IReadOnlyList<(?:string|int)>) (\w+) =\s*([^;]+);/g;
  for (const m of own.matchAll(re)) scope[m[1]] = value(m[2], scope, all);
  return scope;
}

function read() {
  /** Every class read so far, by its C# name: what a constant can refer to. */
  const all = new Map();
  const out = [];
  for (const source of SOURCES) {
    const text = fs.readFileSync(path.join(desktop, source.file), 'utf8').replaceAll('\r\n', '\n');
    const { own, nested } = split(classBody(text, source.cls));
    const object = members(own, all);
    all.set(source.cls, object);
    for (const n of nested) {
      const inner = members(split(n.body).own, all);
      all.set(n.name, inner);
      object[n.name] = inner;
    }
    out.push({ ...source, object });
  }
  return out;
}

const js = v => (typeof v === 'string' ? `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : Array.isArray(v) ? `Object.freeze([${v.map(js).join(', ')}])` : String(v));

function objectJs(object, indent) {
  const pad = ' '.repeat(indent);
  const lines = Object.entries(object).map(([name, v]) => (typeof v === 'object' && !Array.isArray(v)
    ? `${pad}${camel(name)}: ${objectJs(v, indent + 2)},`
    : `${pad}${camel(name)}: ${js(v)},`));
  return `Object.freeze({\n${lines.join('\n')}\n${' '.repeat(indent - 2)}})`;
}

function generate() {
  const parts = read().map(s => `/** C#: ${s.cls} (${s.file}). */\nexport const ${s.js} = ${objectJs(s.object, 2)};\n`);
  return `// @ts-check
// Generated by scripts/constants.mjs from the host's C# constant classes; don't edit it by hand. The values the page and
// the host share are written once, in C#: a setting's choices, an agent's states, where a profile comes from.

${parts.join('\n')}`;
}

// ---- The shapes of what the host sends ----

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

/** The text of a /// <summary>, on one line. */
const summary = doc => /<summary>([\s\S]*?)<\/summary>/.exec(doc ?? '')?.[1].replace(/\s*\/\/\/\s*/g, ' ').replace(/<[^>]+>/g, '').trim();

/** Every record in those files: its summary and its JSON fields ({ name, type, doc }). */
function readRecords() {
  const records = new Map();
  for (const file of TYPE_FILES) {
    const text = fs.readFileSync(path.join(desktop, file), 'utf8').replaceAll('\r\n', '\n');
    for (const m of text.matchAll(/((?:[ \t]*\/\/\/[^\n]*\n)*)internal sealed record (\w+)\s*([({])/g)) {
      const fields = [];
      if (m[3] === '(') {
        let depth = 1;
        let i = m.index + m[0].length;
        const start = i;
        for (; depth && i < text.length; i++) depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
        for (const param of splitTopLevel(text.slice(start, i - 1))) {
          const p = /^(?:\[[^\]]*\]\s*)*([\w<>?, [\]]+?)\s+(\w+)(?:\s*=.*)?$/s.exec(param);
          if (p) fields.push({ type: p[1], name: p[2] });
        }
      } else {
        const body = classBody(text, m[2], m.index);
        for (const p of body.matchAll(/((?:[ \t]*\/\/\/[^\n]*\n)*)[ \t]*public ([\w<>?, [\]]+?) (\w+) \{ get; init; \}/g)) {
          fields.push({ type: p[2], name: p[3], doc: summary(p[1]) });
        }
      }
      records.set(m[2], { doc: summary(m[1]), fields });
    }
  }
  return records;
}

/** The TypeScript type for a C# type. */
function tsType(cs, records) {
  let type = cs.trim();
  const nullable = type.endsWith('?');
  if (nullable) type = type.slice(0, -1);
  const list = /^(?:IReadOnlyList|List)<(.+)>$/.exec(type) ?? /^(.+)\[\]$/.exec(type);
  const map = /^(?:IReadOnlyDictionary|Dictionary)<\s*string\s*,\s*(.+)>$/.exec(type);
  let ts;
  if (list) ts = `${tsType(list[1], records)}[]`;
  else if (map) ts = `Record<string, ${tsType(map[1], records)}>`;
  else if (type === 'string') ts = 'string';
  else if (type === 'bool') ts = 'boolean';
  else if (['int', 'long', 'double'].includes(type)) ts = 'number';
  else if (records.has(type)) ts = type;
  else throw new Error(`no TypeScript type for ${cs}`);
  return nullable ? `${ts} | null` : ts;
}

function generateTypes() {
  const records = readRecords();
  const blocks = [...records].map(([name, r]) => {
    const fields = r.fields.map(f => `${f.doc ? `  /** ${f.doc} */\n` : ''}  ${camel(f.name)}: ${tsType(f.type, records)};`);
    return `${r.doc ? `/** ${r.doc} */\n` : ''}interface ${name} {\n${fields.join('\n')}\n}\n`;
  });
  return `// Generated by scripts/constants.mjs from the host's records (Settings/*.cs, the records they hold, SessionProfiles.cs);
// don't edit it by hand. The shapes of what the host sends, for the type checker: settings.json's, as the page has it in
// state.settings, and the shell profiles in state.profiles.

${blocks.join('\n')}`;
}

/** Writes each output, or with --check says which is out of date. */
const outputs = [
  { file: target, text: generate(), what: 'js/constants.js' },
  { file: typesTarget, text: generateTypes(), what: 'types/host.d.ts' },
];
if (process.argv.includes('--check')) {
  const stale = outputs.filter(o => (fs.existsSync(o.file) ? fs.readFileSync(o.file, 'utf8').replaceAll('\r\n', '\n') : '') !== o.text);
  for (const o of stale) console.error(`${o.what} is out of date with the C#: run \`node scripts/constants.mjs\`.`);
  if (stale.length) process.exit(1);
  console.log('Constants: js/constants.js and types/host.d.ts match the C#.');
} else {
  for (const o of outputs) {
    fs.writeFileSync(o.file, o.text);
    console.log(`Wrote ${path.relative(repo, o.file)}.`);
  }
}
