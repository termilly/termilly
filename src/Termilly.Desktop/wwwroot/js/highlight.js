// @ts-check
// Syntax colours for the change preview (js/preview.js), from highlight.js (lib/highlight.min.js). The language
// comes from the file's name; plain text, logs and anything unknown stay plain, and highlight.js is never asked to
// guess. Colours come from app.css (.hljs-* classes), so they follow the theme.

import { escapeHtml } from './ui.js';

/**
 * File extension (or whole name) → highlight.js language.
 * @type {Record<string, string>}
 */
const LANGUAGES = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  cs: 'csharp', csx: 'csharp', vb: 'vbnet', fs: 'plaintext',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  py: 'python', pyw: 'python', rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua', r: 'r',
  rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', m: 'objectivec',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  json: 'json', jsonc: 'json', ipynb: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini',
  editorconfig: 'ini', gitconfig: 'ini', properties: 'ini',
  xml: 'xml', xaml: 'xml', csproj: 'xml', vbproj: 'xml', fsproj: 'xml', props: 'xml', targets: 'xml', slnx: 'xml',
  config: 'xml', resx: 'xml', svg: 'xml', html: 'xml', htm: 'xml', vue: 'xml', manifest: 'xml',
  css: 'css', scss: 'scss', less: 'less', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  sh: 'bash', bash: 'bash', zsh: 'bash', bashrc: 'bash', zshrc: 'bash', profile: 'bash',
  bat: 'dos', cmd: 'dos', md: 'markdown', markdown: 'markdown', diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile', wat: 'wasm',
};

/** Dockerfiles go by name (Dockerfile, Dockerfile.dev, ...), which is also their highlight.js language. */
const DOCKERFILE = 'dockerfile';

/**
 * highlight.js as the page loads it (lib/highlight.min.js), on window; undefined if it didn't load.
 * @typedef {Window & { hljs?: any }} WindowWithHljs
 */

/**
 * The highlight.js language for a file, or null to show it plain.
 * @param {string | null | undefined} path
 */
export function languageOf(path) {
  const name = /** @type {string} */ (String(path ?? '').split(/[\\/]/).pop()).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const language = LANGUAGES[ext] ?? LANGUAGES[name] ?? (name.startsWith(DOCKERFILE) ? DOCKERFILE : null);
  return language && language !== 'plaintext' && /** @type {WindowWithHljs} */ (window).hljs?.getLanguage(language)
    ? language : null;
}

/** Bigger texts are shown plain: highlighting them would hold up the preview. */
export const MAX_CHARS = 300_000;
export const MAX_LINES = 8_000;

/**
 * A text's lines, the same way the host splits them (LineDiff.Lines): a last empty line isn't one, '\r' goes.
 * @param {string | null | undefined} text
 */
export function splitLines(text) {
  if (text == null) return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * A text's lines as HTML, and whether they were coloured.
 * @typedef {{ lines: string[], coloured: boolean }} Highlighted
 */

/** Texts kept highlighted, the oldest dropped first. */
const CACHED_TEXTS = 12;
/** @type {Map<string, Highlighted>} */
const cache = new Map();

/**
 * The text's lines as HTML: coloured when there's a language and the text isn't too big, escaped plain text
 * otherwise. The whole text is highlighted at once (a comment or string can span lines), then cut into lines, with
 * the spans open at each line break closed and reopened on the next line.
 * @param {string} text
 * @param {string | null} language
 * @returns {Highlighted}
 */
export function highlightLines(text, language) {
  const lines = splitLines(text);
  if (!language || !/** @type {WindowWithHljs} */ (window).hljs || text.length > MAX_CHARS
    || lines.length > MAX_LINES) {
    return { lines: lines.map(escapeHtml), coloured: false };
  }
  const key = `${language}\0${text}`;
  if (cache.has(key)) return /** @type {Highlighted} */ (cache.get(key));

  /** @type {string} */
  let html;
  try {
    html = /** @type {WindowWithHljs} */ (window).hljs
      .highlight(lines.join('\n'), { language, ignoreIllegals: true }).value;
  } catch {
    return { lines: lines.map(escapeHtml), coloured: false };
  }
  const out = [];
  const open = []; // the class of every span open at the current position
  for (const line of html.split('\n')) {
    let piece = open.map(c => `<span class="${c}">`).join('') + line;
    for (const tag of line.matchAll(/<span class="([^"]*)">|<\/span>/g)) {
      if (tag[1] !== undefined) open.push(tag[1]);
      else open.pop();
    }
    piece += '</span>'.repeat(open.length);
    out.push(piece);
  }
  const result = { lines: out, coloured: true };
  cache.set(key, result);
  if (cache.size > CACHED_TEXTS) cache.delete(/** @type {string} */ (cache.keys().next().value));
  return result;
}
