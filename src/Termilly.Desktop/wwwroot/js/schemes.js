// @ts-check
// Reads other terminals' colour schemes (Settings › Appearance › Theme › Import): iTerm2 (.itermcolors), Windows
// Terminal (a scheme, a list, or settings.json's schemes, comments allowed), Ghostty, Kitty, Alacritty (.toml, and
// its older .yml) and Warp (.yaml). Each gives a background, a text colour, maybe a cursor colour and the 16 ANSI
// colours; themes.js works out the rest.

import { CUSTOM_THEME } from './constants.js';

/**
 * A scheme as read from a file: #rrggbb colours, the 16 ANSI ones in order.
 * @typedef {{ name: string, background: string, foreground: string, cursor: string | null, ansi: string[] }} Scheme
 */

/** What a file gave: its schemes, and how many it held that missed colours (a settings file's other schemes). */
/** @typedef {{ schemes: Scheme[], skipped: number }} SchemeFile */

/** The colours besides the 16 that schemes name, as read here. */
const KEY = Object.freeze({ background: 'background', foreground: 'foreground', cursor: 'cursor' });
/** The 16 ANSI colours by the names schemes give them, in order (Windows Terminal says purple for magenta). */
const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const NORMAL_COUNT = 8;
/** iTerm2 keeps each colour as red, green and blue fractions of 1. */
const CHANNEL_MAX = 255;
const HEX = 16;
/** A #rrggbb colour's six digits, and a short #rgb one's three. */
const LONG_HEX = 6;
const SHORT_HEX = 3;
/** The byte order mark some editors put first. */
const BOM = '﻿';

/** What an error says when the file is no scheme this reads, or one without all its colours. */
export const SCHEME_ERROR = Object.freeze({
  unknown: 'This file isn’t a colour scheme Termilly can read.',
  incomplete: 'This scheme is missing colours: it needs a background, a text colour and all 16 terminal colours.',
});

/**
 * A colour as schemes write it (#rgb, #rrggbb, 0xrrggbb, rrggbb, maybe quoted) as #rrggbb, or null.
 * @param {string | undefined} value
 */
export function hexColour(value) {
  const digits = (value ?? '').trim().replace(/^['"]|['"]$/g, '').replace(/^(#|0x)/i, '');
  if (!/^[0-9a-f]+$/i.test(digits)) return null;
  if (digits.length === SHORT_HEX) return `#${[...digits].map(d => d + d).join('')}`.toLowerCase();
  return digits.length === LONG_HEX ? `#${digits}`.toLowerCase() : null;
}

/**
 * The scheme when it has every colour, else null.
 * @param {string} name
 * @param {Record<string, string | null | undefined>} found background, foreground, cursor and ansi0 to ansi15
 * @returns {Scheme | null}
 */
function complete(name, found) {
  const ansi = Array.from({ length: CUSTOM_THEME.ansiCount }, (_, i) => hexColour(found[`ansi${i}`] ?? undefined));
  const background = hexColour(found.background ?? undefined);
  const foreground = hexColour(found.foreground ?? undefined);
  if (!background || !foreground || ansi.some(c => !c)) return null;
  return { name, background, foreground, cursor: hexColour(found.cursor ?? undefined), ansi: /** @type {string[]} */ (ansi) };
}

/**
 * An ANSI colour's index from its name (bright ones 8 to 15), or -1.
 * @param {string} name black, brightRed, purple…
 * @param {boolean} [bright] the name is in a bright section (Alacritty's, Warp's)
 */
function ansiIndex(name, bright = false) {
  const lower = name.toLowerCase().replace('purple', 'magenta');
  const plain = lower.replace(/^bright_?/, '');
  const at = ANSI_NAMES.indexOf(plain);
  return at < 0 ? -1 : at + (bright || plain !== lower ? NORMAL_COUNT : 0);
}

/**
 * A value as written: a quoted one's inside, else up to the first space (an inline comment follows one).
 * @param {string} raw
 */
const plainValue = raw => /^(['"])(.*?)\1/.exec(raw)?.[2] ?? /^\S+/.exec(raw)?.[0] ?? '';

/** @param {string} text */
function readItermPlist(text) {
  /** @type {Record<string, string>} */
  const found = {};
  // Comments go first: one between a key and its value hides nothing, and a colour commented out isn't read.
  const plain = text.replace(/<!--[\s\S]*?-->/g, '');
  const entry = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  for (const [, key, dict] of plain.matchAll(entry)) {
    const part = (/** @type {string} */ name) => new RegExp(`<key>${name} Component</key>\\s*<(?:real|integer)>([^<]+)</`).exec(dict)?.[1];
    const parts = ['Red', 'Green', 'Blue'].map(part);
    // A colour missing a part is left out (the scheme is then incomplete), not taken as black.
    const hex = parts.every(p => p !== undefined && Number.isFinite(Number(p)))
      ? '#' + parts.map(p => Math.round(Math.min(1, Math.max(0, Number(p))) * CHANNEL_MAX).toString(HEX).padStart(2, '0')).join('')
      : undefined;
    if (!hex) continue;
    const ansi = /^Ansi (\d+) Color$/.exec(key);
    if (ansi) found[`ansi${ansi[1]}`] = hex;
    else if (key === 'Background Color') found.background = hex;
    else if (key === 'Foreground Color') found.foreground = hex;
    else if (key === 'Cursor Color') found.cursor = hex;
  }
  return found;
}

/**
 * Windows Terminal's scheme object.
 * @param {Record<string, unknown>} scheme
 */
function readWindowsTerminal(scheme) {
  const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value : '');
  /** @type {Record<string, string>} */
  const found = { background: text(scheme.background), foreground: text(scheme.foreground), cursor: text(scheme.cursorColor) };
  for (const [key, value] of Object.entries(scheme)) {
    const at = ansiIndex(key);
    if (at >= 0) found[`ansi${at}`] = text(value);
  }
  return found;
}

/**
 * Ghostty's `key = value` lines (palette = 3=#rrggbb, the index in any base Ghostty takes) and Kitty's `key value`
 * ones (color3 #rrggbb).
 * @param {string} text
 */
function readKeyLines(text) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const [, key, raw] = /^\s*([\w-]+)\s*(?:=\s*|\s+)(.+?)\s*$/.exec(line) ?? [];
    if (!key) continue;
    const palette = /^(\w+)\s*=\s*(\S+)/.exec(raw);
    const color = /^color(\d+)$/.exec(key);
    if (key === 'palette' && palette && Number.isInteger(Number(palette[1]))) found[`ansi${Number(palette[1])}`] = palette[2];
    else if (color) found[`ansi${Number(color[1])}`] = plainValue(raw);
    else if (key === KEY.background || key === KEY.foreground) found[key] = plainValue(raw);
    else if (key === KEY.cursor || key === 'cursor-color') found.cursor = plainValue(raw);
  }
  return found;
}

/**
 * Alacritty's TOML ([colors.primary] …) and YAML (colors: primary: …), and Warp's YAML (background and foreground at
 * the top, terminal_colors with normal and bright): sections by header or by indentation.
 * @param {string} text
 */
function readSections(text) {
  /** @type {Record<string, string>} */
  const found = {};
  /** @type {{ indent: number, name: string }[]} */
  let stack = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const table = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (table) {
      stack = [{ indent: -1, name: table[1].replace(/["'\s]/g, '') }]; // ["colors"."normal"] is [colors.normal]
      continue;
    }
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const [, key, raw] = /^\s*["']?(\w+)["']?\s*[=:]\s*(.*?)\s*$/.exec(line) ?? [];
    if (!key) continue;
    if (!raw || raw.startsWith('#')) {
      stack.push({ indent, name: key }); // a YAML section: what's under it is indented further
      continue;
    }
    const section = stack.map(s => s.name).join('.');
    readSectionValue(found, section, key, raw);
  }
  return found;
}

/**
 * One `key = value` (or `key: value`) of a section, kept when it's a colour this reads.
 * @param {Record<string, string>} found
 * @param {string} section where it is, e.g. colors.normal or terminal_colors.bright ('' at the top)
 * @param {string} key
 * @param {string} raw the value as written
 */
function readSectionValue(found, section, key, raw) {
  const at = ansiIndex(key, section.endsWith('bright'));
  if (at >= 0 && /(normal|bright)$/.test(section)) found[`ansi${at}`] = plainValue(raw);
  // Warp's at the top, Alacritty's under primary (its selection and search have a background too).
  else if ((key === KEY.background || key === KEY.foreground) && (!section || section.endsWith('primary'))) found[key] = plainValue(raw);
  else if (key === KEY.cursor && section.endsWith(KEY.cursor)) found.cursor = plainValue(raw);
  // Alacritty's inline table: [colors] cursor = { text = "…", cursor = "…" }
  else if (key === KEY.cursor && raw.startsWith('{')) found.cursor = /cursor\s*=\s*['"]([^'"]+)/.exec(raw)?.[1] ?? '';
}

/** @param {string} text */
const nameInText = text => /^name\s*:\s*['"]?(.+?)['"]?\s*$/m.exec(text)?.[1] // Warp's, at the top
  ?? /^##\s*name\s*:\s*(.+?)\s*$/m.exec(text)?.[1]; // Kitty's themes

/** @param {string} fileName */
const nameOfFile = fileName => fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Imported';

/**
 * JSON as Windows Terminal writes it: comments (// and /* *\/) and trailing commas allowed, outside strings.
 * @param {string} text
 */
function withoutComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(i))?.[0] ?? c;
      out += end;
      i += end.length - 1;
    } else if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c !== ',' || !/^,\s*[}\]]/.test(text.slice(i))) out += c; // a trailing comma goes
  }
  return out;
}

/**
 * Windows Terminal's JSON: a scheme, a list of them, or a settings file with its schemes; null when it isn't JSON.
 * @param {string} text
 * @returns {Record<string, unknown>[] | null}
 */
function jsonSchemes(text) {
  /** @type {unknown} */
  let data;
  try { data = JSON.parse(withoutComments(text)); } catch { return null; }
  const record = /** @type {Record<string, unknown>} */ (data && typeof data === 'object' ? data : {});
  // A list's every entry counts (one that isn't a scheme is skipped); a lone object only when it's a scheme.
  const list = Array.isArray(data) ? data : Array.isArray(record.schemes) ? record.schemes : KEY.background in record ? [record] : [];
  return list.map(s => (s && typeof s === 'object' ? /** @type {Record<string, unknown>} */ (s) : {}));
}

/**
 * The schemes a file holds (a Windows Terminal settings file can hold several, some without all their colours).
 * Throws when it holds none this can use.
 * @param {string} fileName
 * @param {string} text
 * @returns {SchemeFile}
 */
export function readSchemes(fileName, text) {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const fallback = nameOfFile(fileName);
  /** @type {(Scheme | null)[]} */
  let found;
  const json = /^\s*(\/[/*]|[{[])/.test(body) ? jsonSchemes(body) : null;
  if (json) {
    found = json.map(s => complete(typeof s.name === 'string' && s.name.trim() ? s.name.trim() : fallback, readWindowsTerminal(s)));
  } else if (/^\s*<(\?xml|!DOCTYPE|plist)/.test(body)) found = [complete(fallback, readItermPlist(body))];
  else {
    const name = nameInText(body) ?? fallback;
    if (/^\s*\[\s*["']?colors|^\s*["']?terminal_colors["']?\s*:|^["']?colors["']?\s*:/m.test(body)) found = [complete(name, readSections(body))];
    else if (/^\s*(palette\s*=|color\d+\s)/m.test(body)) found = [complete(name, readKeyLines(body))];
    else throw new Error(SCHEME_ERROR.unknown);
  }
  if (!found.length) throw new Error(SCHEME_ERROR.unknown);
  const schemes = /** @type {Scheme[]} */ (found.filter(Boolean));
  if (!schemes.length) throw new Error(SCHEME_ERROR.incomplete);
  return { schemes, skipped: found.length - schemes.length };
}
