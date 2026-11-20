// @ts-check
// Reads other terminals' colour schemes (Settings › Appearance › Theme › Import): iTerm2 (.itermcolors), Windows
// Terminal (a scheme, or settings.json's schemes), Ghostty, Kitty, Alacritty (.toml) and Warp (.yaml). Each gives
// a background, a text colour, maybe a cursor colour and the 16 ANSI colours; themes.js works out the rest.

/**
 * A scheme as read from a file: #rrggbb colours, the 16 ANSI ones in order.
 * @typedef {{ name: string, background: string, foreground: string, cursor: string | null, ansi: string[] }} Scheme
 */

/** The colours besides the 16 that schemes name, as read here. */
const KEY = Object.freeze({ background: 'background', foreground: 'foreground', cursor: 'cursor' });

/** The 16 ANSI colours by the names schemes give them, in order (Windows Terminal says purple for magenta). */
const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const ANSI_COUNT = 16;
const NORMAL_COUNT = 8;
/** iTerm2 keeps each colour as red, green and blue fractions of 1. */
const CHANNEL_MAX = 255;
const HEX = 16;
/** A #rrggbb colour's six digits, and a short #rgb one's three. */
const LONG_HEX = 6;
const SHORT_HEX = 3;

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
 * The scheme, when it has every colour.
 * @param {string} name
 * @param {Record<string, string | null | undefined>} found background, foreground, cursor and ansi0 to ansi15
 * @returns {Scheme}
 */
function complete(name, found) {
  const ansi = Array.from({ length: ANSI_COUNT }, (_, i) => hexColour(found[`ansi${i}`] ?? undefined));
  const background = hexColour(found.background ?? undefined);
  const foreground = hexColour(found.foreground ?? undefined);
  if (!background || !foreground || ansi.some(c => !c)) throw new Error(SCHEME_ERROR.incomplete);
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

/** @param {string} text */
function readItermPlist(text) {
  /** @type {Record<string, string>} */
  const found = {};
  const entry = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  for (const [, key, dict] of text.matchAll(entry)) {
    const part = (/** @type {string} */ name) => Number(new RegExp(`<key>${name} Component</key>\\s*<real>([^<]+)</real>`).exec(dict)?.[1] ?? 0);
    const hex = '#' + ['Red', 'Green', 'Blue'].map(c => Math.round(Math.min(1, Math.max(0, part(c))) * CHANNEL_MAX).toString(HEX).padStart(2, '0')).join('');
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
  /** @type {Record<string, string>} */
  const found = { background: String(scheme.background ?? ''), foreground: String(scheme.foreground ?? ''), cursor: String(scheme.cursorColor ?? '') };
  for (const [key, value] of Object.entries(scheme)) {
    const at = ansiIndex(key);
    if (at >= 0) found[`ansi${at}`] = String(value);
  }
  return found;
}

/**
 * Ghostty's `key = value` lines (palette = 3=#rrggbb) and Kitty's `key value` ones (color3 #rrggbb).
 * @param {string} text
 */
function readKeyLines(text) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const [, key, value] = /^\s*([\w-]+)\s*(?:=\s*|\s+)(.+?)\s*$/.exec(line) ?? [];
    if (!key || line.trimStart().startsWith('#')) continue;
    const palette = /^(\d+)\s*=\s*(\S+)$/.exec(value);
    const color = /^color(\d+)$/.exec(key);
    if (key === 'palette' && palette) found[`ansi${palette[1]}`] = palette[2];
    else if (color) found[`ansi${color[1]}`] = value;
    else if (key === KEY.background || key === KEY.foreground) found[key] = value;
    else if (key === KEY.cursor || key === 'cursor-color') found.cursor = value;
  }
  return found;
}

/**
 * Alacritty's TOML ([colors.primary], [colors.normal], [colors.bright], [colors.cursor]) and Warp's YAML
 * (background, foreground, terminal_colors with normal and bright).
 * @param {string} text
 */
function readSections(text) {
  /** @type {Record<string, string>} */
  const found = {};
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([\w.]+)\]\s*$/.exec(line) ?? /^\s*(normal|bright|primary|cursor)\s*:\s*$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    const [, key, value] = /^\s*(\w+)\s*[=:]\s*(.+?)\s*$/.exec(line) ?? [];
    if (!key) continue;
    const at = ansiIndex(key, section.endsWith('bright'));
    if (at >= 0 && /(normal|bright)$/.test(section)) found[`ansi${at}`] = value;
    // Warp's at the top, Alacritty's under primary (its selection and search have a background too).
    else if ((key === KEY.background || key === KEY.foreground) && (!section || section.endsWith('primary'))) found[key] = value;
    else if (key === KEY.cursor && section.endsWith(KEY.cursor)) found.cursor = value;
  }
  return found;
}

/** @param {string} text */
const nameInText = text => /^\s*name\s*:\s*['"]?(.+?)['"]?\s*$/m.exec(text)?.[1] // Warp
  ?? /^##\s*name\s*:\s*(.+?)\s*$/m.exec(text)?.[1]; // Kitty's themes

/** @param {string} fileName */
const nameOfFile = fileName => fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Imported';

/**
 * Windows Terminal's JSON: a scheme, a list of them, or a settings file with its schemes; null when it isn't JSON.
 * @param {string} text
 * @returns {Record<string, unknown>[] | null}
 */
function jsonSchemes(text) {
  /** @type {unknown} */
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const record = /** @type {Record<string, unknown>} */ (data ?? {});
  const list = Array.isArray(data) ? data : Array.isArray(record.schemes) ? record.schemes : [data];
  return list.filter(s => s && typeof s === 'object');
}

/**
 * The schemes a file holds (a Windows Terminal settings file can hold several).
 * @param {string} fileName
 * @param {string} text
 * @returns {Scheme[]}
 */
export function readSchemes(fileName, text) {
  const fallback = nameOfFile(fileName);
  if (/<plist[\s>]/.test(text)) return [complete(fallback, readItermPlist(text))];
  const json = text.trimStart().startsWith('{') || text.trimStart().startsWith('[') ? jsonSchemes(text) : null;
  if (json) {
    const schemes = json.filter(s => KEY.background in s);
    if (!schemes.length) throw new Error(SCHEME_ERROR.unknown);
    return schemes.map(s => complete(typeof s.name === 'string' && s.name.trim() ? s.name.trim() : fallback, readWindowsTerminal(s)));
  }
  const name = nameInText(text) ?? fallback;
  if (/^\s*\[colors\.|^\s*terminal_colors\s*:/m.test(text)) return [complete(name, readSections(text))];
  if (/^\s*(palette\s*=|color\d+\s)/m.test(text)) return [complete(name, readKeyLines(text))];
  throw new Error(SCHEME_ERROR.unknown);
}
