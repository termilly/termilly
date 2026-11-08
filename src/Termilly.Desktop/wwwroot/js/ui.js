// @ts-check
// Small markup helpers shared by the header, sidebar and search.

import { BADGES, PROFILE_SOURCES, state, tagColor, profileOf, runsClaude, sourceOf } from './store.js';
import { DAY_MS, WEEK_DAYS } from './util.js';
import { PROFILE_ICON } from './constants.js';
import { RETURN_ICON } from './windows.js';

/** The class of a badge at its usual size, in lists and headers. */
/** A badge's sizes. */
export const BADGE_SIZE = Object.freeze({ small: 'small', large: 'lg' });
/** Counts on badges and buttons stop at this (99+). */
const MAX_COUNT = 99;

/**
 * A count for a badge or button: the number, or 99+ past that.
 * @param {number} n
 */
export const countText = n => (n > MAX_COUNT ? `${MAX_COUNT}+` : String(n));

/** @type {Record<string, string>} */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapes text for use inside markup (tab names, tags and output are user content).
 * @param {unknown} text
 */
export const escapeHtml = text => String(text ?? '').replace(/[&<>"']/g, c => ESCAPES[c]);

/** How many characters of a line a search's row shows, and how many of them come before the match. */
const SNIPPET_WIDTH = 90;
const SNIPPET_LEAD = 30;

/**
 * Escapes text and wraps each occurrence of `needle` in <mark>.
 * @param {string} text
 * @param {string} needle lower-case
 */
export function highlight(text, needle) {
  if (!needle) return escapeHtml(text);
  const lower = text.toLowerCase();
  let out = '';
  let i = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, i)) {
    out += escapeHtml(text.slice(i, at)) + `<mark>${escapeHtml(text.slice(at, at + needle.length))}</mark>`;
    i = at + needle.length;
  }
  return out + escapeHtml(text.slice(i));
}

/**
 * A line cut to about `width` characters around the first match.
 * @param {string} line
 * @param {string} needle
 * @param {number} [width]
 */
export function snippet(line, needle, width = SNIPPET_WIDTH) {
  const at = needle ? line.toLowerCase().indexOf(needle) : -1;
  const trimmed = line.trim();
  if (at < 0 || line.length <= width) return highlight(trimmed.slice(0, width), needle);
  const start = Math.max(0, at - SNIPPET_LEAD);
  return (start > 0 ? '…' : '') + highlight(line.slice(start, start + width).trim(), needle);
}

/** A colour as CSS takes it: #rgb to #rrggbbaa, or rgb()/rgba() of numbers. */
const CSS_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\))$/i;

/**
 * A colour for a style attribute: itself when it's a colour, else transparent. Themes from plugins and colours in
 * settings are user content, and a style attribute shouldn't carry anything else.
 * @param {unknown} value
 */
export const cssColor = value => (typeof value === 'string' && CSS_COLOR.test(value.trim()) ? value.trim() : 'transparent');

/**
 * A name (a font's) as the inside of a CSS string.
 * @param {string} text
 */
export const cssString = text => text.replace(/["\\]/g, '\\$&');

/**
 * Keys as keycaps: 'Ctrl Shift T' is three, and '/' between two shortcuts reads "or".
 * @param {string} keys
 */
export const keysHtml = keys => keys.split(' ').map(k => (k === '/' ? '<span class="kbd-or">or</span>' : `<kbd>${escapeHtml(k)}</kbd>`)).join('');

/**
 * A path for a label laid out right to left (so a long path is cut at its start, keeping the file's end): marked as
 * left-to-right text, so a leading / (Linux) stays in front instead of moving to the end.
 * @param {string | null | undefined} path
 */
export const ltrPath = path => `‎${path ?? ''}‎`;

/**
 * A profile's badge: the short mark of its icon.
 * @param {{ icon?: string } | null | undefined} profile
 * @param {string} [extraClass]
 */
export function badgeHtml(profile, extraClass = BADGE_SIZE.small) {
  const icon = profile?.icon ?? '';
  if (icon === PROFILE_ICON.claude) return claudeBadge(extraClass);
  const word = /** @type {Record<string, string>} */ (PIXEL_WORDS)[icon];
  return `<span class="badge ${extraClass}" data-icon="${escapeHtml(icon)}">${word ? pixelWord(word, extraClass === BADGE_SIZE.small)
    : `<span class="badge-text">${escapeHtml(/** @type {Record<string, string>} */ (BADGES)[icon] ?? '>_')}</span>`}</span>`;
}

/** Badges that are a word drawn in whole pixels, which a font can't keep sharp in an 18px badge. */
const PIXEL_WORDS = { [PROFILE_ICON.serial]: 'COM', [PROFILE_ICON.ssh]: 'SSH', [PROFILE_ICON.wsl]: 'WSL' };
/**
 * The pixel fonts for those words. A word's width and height must have the same evenness as the badge's inside to
 * sit exactly in its middle: 6 rows, and 3 or 4 columns a letter (every word 12 wide), in the small badge's 16px; 6 x 8
 * letters with two-pixel lines (20 x 8 words) in the others' 26px and 24px.
 */
const SMALL_FONT = /** @type {Record<string, string[]>} */ ({
  C: ['###', '#..', '#..', '#..', '#..', '###'], O: ['###', '#.#', '#.#', '#.#', '#.#', '###'],
  M: ['#..#', '####', '####', '#..#', '#..#', '#..#'], S: ['###', '#..', '###', '..#', '..#', '###'],
  H: ['#..#', '#..#', '####', '#..#', '#..#', '#..#'], W: ['#..#', '#..#', '#..#', '####', '####', '#..#'],
  L: ['#..', '#..', '#..', '#..', '#..', '###'],
});
/** Rows of the large font: a full bar, the left side, the right side, both sides. */
const [BAR, LEFT, RIGHT, SIDES] = ['######', '##....', '....##', '##..##'];
const LARGE_FONT = /** @type {Record<string, string[]>} */ ({
  C: [BAR, BAR, LEFT, LEFT, LEFT, LEFT, BAR, BAR], O: [BAR, BAR, SIDES, SIDES, SIDES, SIDES, BAR, BAR],
  M: [SIDES, SIDES, BAR, BAR, BAR, SIDES, SIDES, SIDES], S: [BAR, BAR, LEFT, BAR, BAR, RIGHT, BAR, BAR],
  H: [SIDES, SIDES, SIDES, BAR, BAR, SIDES, SIDES, SIDES], W: [SIDES, SIDES, SIDES, BAR, BAR, BAR, SIDES, SIDES],
  L: [LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, BAR, BAR],
});
/** The gap between letters, in pixels. */
const GAP_PX = 1;

/**
 * A word in a pixel font, as one path of whole pixels.
 * @param {string} word
 * @param {boolean} small for a small badge
 */
function pixelWord(word, small) {
  const font = small ? SMALL_FONT : LARGE_FONT;
  const rows = font.C.length;
  let d = '';
  let left = 0;
  for (const ch of word) {
    font[ch].forEach((row, y) => [...row].forEach((p, x) => {
      if (p === '#') d += `M${left + x} ${y}h1v1h-1z`;
    }));
    left += font[ch][0].length + GAP_PX;
  }
  const width = left - GAP_PX;
  return `<svg class="badge-word" viewBox="0 0 ${width} ${rows}" width="${width}" height="${rows}" shape-rendering="crispEdges" aria-label="${word}"><path fill="currentColor" stroke="none" d="${d}"/></svg>`;
}

// A spark for Claude Code: straight bars on whole pixels (sharp at 12px), diagonal ones for the other rays.
const CLAUDE_MARK = '<svg viewBox="0 0 12 12"><g fill="currentColor" stroke="none"><rect x="5" y="0" width="2" height="12" rx="1"/>'
  + '<rect x="0" y="5" width="12" height="2" rx="1"/><rect x="5" y="0.5" width="2" height="11" rx="1" transform="rotate(45 6 6)"/>'
  + '<rect x="5" y="0.5" width="2" height="11" rx="1" transform="rotate(-45 6 6)"/></g></svg>';

/**
 * A terminal's badge: its shell's, or Claude's while Claude Code runs in it (back to the shell's when it exits).
 * Another computer's terminal shows what that computer says runs in it.
 * @param {Tab} tab
 * @param {string} [extraClass]
 */
export function tabBadgeHtml(tab, extraClass = BADGE_SIZE.small) {
  if (tab.virtual?.icon) return badgeHtml({ icon: tab.virtual.icon }, extraClass);
  return runsClaude(tab) ? claudeBadge(extraClass, 'Claude Code is running here') : badgeHtml(profileOf(tab), extraClass);
}

/**
 * Claude's badge: a Claude Code terminal, or one Claude runs in.
 * @param {string} extraClass
 * @param {string} [title]
 */
function claudeBadge(extraClass, title) {
  return `<span class="badge ${extraClass}" data-icon="${PROFILE_ICON.claude}"${title ? ` title="${title}"` : ''}>${CLAUDE_MARK}</span>`;
}

/**
 * <option>s for every profile, in an <optgroup> per source (Shells, WSL, Your profiles, SSH hosts).
 * @param {string | null} [selectedId]
 */
export function profileOptionsHtml(selectedId) {
  return PROFILE_SOURCES.map(([source, label]) => {
    const options = state.profiles.filter(p => sourceOf(p) === source).map(p =>
      `<option value="${escapeHtml(p.id)}"${p.id === selectedId ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
    return options && `<optgroup label="${escapeHtml(label)}">${options}</optgroup>`;
  }).join('');
}

/** The small activity mark, as a row in a list shows it. */
export const MINI_ACTIVITY = 'mini';

/**
 * The spinner (or progress ring) for a terminal's activity (see activityOf); empty when idle.
 * @param {import('./store.js').Activity | null} activity
 * @param {string} [extraClass]
 */
export function activityHtml(activity, extraClass = '') {
  if (!activity) return '';
  const percent = activity.percent === undefined ? '' : ` style="--p:${Math.max(0, Math.min(100, activity.percent))}"`;
  return `<span class="activity ${activity.kind} ${extraClass}"${percent} role="img" title="${escapeHtml(activity.title)}" aria-label="${escapeHtml(activity.title)}"></span>`;
}

/**
 * A tag's chip, in its colour.
 * @param {string} name
 * @param {{ mini?: boolean }} [options]
 */
export function tagChipHtml(name, { mini = false } = {}) {
  return `<span class="tag${mini ? ' mini' : ''}" style="--c:${tagColor(name)}">${escapeHtml(name)}</span>`;
}

export const ICONS = {
  close: '<svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9"/></svg>',
  // Drawn on the pixel grid for 16px at a 1px stroke (menus show them that way): straight lines sit on .5, dots
  // are whole-pixel squares, so they stay sharp instead of smearing across two pixels.
  cross: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  more: '<svg viewBox="0 0 16 16"><rect x="3" y="7" width="2" height="2" rx=".5" fill="currentColor" stroke="none"/><rect x="7" y="7" width="2" height="2" rx=".5" fill="currentColor" stroke="none"/><rect x="11" y="7" width="2" height="2" rx=".5" fill="currentColor" stroke="none"/></svg>',
  hash: '<svg viewBox="0 0 16 16"><path d="M6.5 3v10M10.5 3v10M3 6.5h10M3 10.5h10"/></svg>',
  puzzle: '<svg viewBox="0 0 16 16"><path d="M6.5 3a1.5 1.5 0 0 1 3 0v1.5h3v3H11a1.5 1.5 0 0 0 0 3h1.5v3h-3V12a1.5 1.5 0 0 0-3 0v1.5h-4v-3H4a1.5 1.5 0 0 0 0-3H2.5v-3h4z"/></svg>',
  ssh: '<svg viewBox="0 0 16 16"><circle cx="5.5" cy="10.5" r="3"/><path d="M7.6 8.4L13 3M11 5l1.5 1.5M9.5 6.5L11 8"/></svg>',
  serial: '<svg viewBox="0 0 16 16"><rect x="2.5" y="5.5" width="11" height="5" rx="1.5"/><rect x="4" y="7" width="2" height="2" fill="currentColor" stroke="none"/><rect x="7" y="7" width="2" height="2" fill="currentColor" stroke="none"/><rect x="10" y="7" width="2" height="2" fill="currentColor" stroke="none"/></svg>',
  diff: '<svg viewBox="0 0 16 16"><path d="M4.5 2.5v6M1.5 5.5h6M8.5 11.5h6"/><path d="M10 2.5l-4 11"/></svg>',
  processes: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11M2.5 7.5h11M2.5 11.5h7"/></svg>',
  network: '<svg viewBox="0 0 16 16"><path d="M4.5 2.5v9M2.5 9.5l2 2 2-2M11.5 13.5v-9M9.5 6.5l2-2 2 2"/></svg>',
  port: '<svg viewBox="0 0 16 16"><rect x="3.5" y="6.5" width="9" height="7" rx="1.5"/><path d="M5.5 6.5V3.5M10.5 6.5V3.5M6 9.5h4"/></svg>',
  disk: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 9.5h11"/><rect x="10" y="11" width="2" height="1" fill="currentColor" stroke="none"/></svg>',
  stop: '<svg viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/></svg>',
  chevronDown: '<svg viewBox="0 0 16 16"><path d="M3.5 6L8 10.5 12.5 6"/></svg>',
  pin: '<svg viewBox="0 0 16 16"><path d="M5.5 2.5h5M6.5 2.5v5l-2 2v1h7v-1l-2-2v-5M8 10.5v4"/></svg>',
  todo: '<svg viewBox="0 0 16 16"><path d="M1.5 3.5l1 1 2-2M1.5 8.5l1 1 2-2M1.5 13.5l1 1 2-2M7.5 3.5h7M7.5 8.5h7M7.5 13.5h7"/></svg>',
  chevronLeft: '<svg viewBox="0 0 16 16"><path d="M10 3.5L5.5 8l4.5 4.5"/></svg>',
  chevronRight: '<svg viewBox="0 0 16 16"><path d="M6 3.5L10.5 8 6 12.5"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1 1h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>',
  bell: '<svg viewBox="0 0 16 16"><path d="M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1.5 1.5h-10z"/><path d="M6.5 14a1.5 1.5 0 0 0 3 0"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>',
  /** A disk: save. */
  save: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h9l2 2v9h-11z"/><path d="M5.5 2.5v3h5v-3M4.5 13.5v-4h7v4"/></svg>',
  /** A clipboard with lines. */
  paste: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="11" rx="1"/><path d="M6.5 2.5h3v2h-3zM5.5 7.5h5M5.5 10.5h3"/></svg>',
  /** Two links of a chain. */
  link: '<svg viewBox="0 0 16 16"><path d="M6.5 5.5h-2a3 3 0 0 0 0 6h2M9.5 5.5h2a3 3 0 0 1 0 6h-2M5.5 8.5h5"/></svg>',
  /** A speech bubble: asking an agent. */
  ask: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 6.5h5M5.5 8.5h3"/></svg>',
  broadcast: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="1.5"/><path d="M5 5a4.2 4.2 0 0 0 0 6M11 5a4.2 4.2 0 0 1 0 6M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10"/></svg>',
  tag: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.5" cy="5.5" r="1"/></svg>',
  rename: '<svg viewBox="0 0 16 16"><path d="M2.5 12.5H6l6.5-6.5-3-3-7 7z"/></svg>',
  // Into a window of its own (an arrow leaving a frame open at its corner), and back (an arrow going in).
  detach: '<svg viewBox="0 0 16 16"><path d="M7.5 2.5h-5v11h11v-5"/><path d="M10.5 2.5h3v3M13.5 2.5l-6 6"/></svg>',
  attach: RETURN_ICON,
  move: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M5.5 8.5h6M9.5 6.5l2 2-2 2"/></svg>',
  history: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5a5 5 0 1 0 1.46-3.54M3.5 4v2.5H6"/><path d="M8.5 6v2.5l2 1.5"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8.5 4v9M4 8.5h9"/></svg>',
  // A branch: two commits on a line and one off it.
  git: '<svg viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7v.5c0 2-2 3-5.5 3.5"/></svg>',
  // A window with a tab on top: terminals as tabs.
  tabs: '<svg viewBox="0 0 16 16"><path d="M2.5 13.5v-8h11v8zM2.5 5.5v-3h5v3"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M6.5 4.5v-2h3v2M4.5 4.5l.75 9h5.5l.75-9"/></svg>',
  palette: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/></svg>',
  lock: '<svg viewBox="0 0 16 16"><rect x="3.5" y="7.5" width="9" height="6" rx="1.5"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"/></svg>',
  appearance: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11A5.5 5.5 0 0 0 8 2.5z" fill="currentColor" stroke="none"/></svg>',
  phone: '<svg viewBox="0 0 16 16"><rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12.5h2"/></svg>',
  /** A screen with a phone in front of it: remote access, from phones and other computers. */
  remote: '<svg viewBox="0 0 16 16"><path d="M8.5 10.5h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v2M4.5 13.5h4"/><rect x="10.5" y="7.5" width="4" height="7" rx="1"/></svg>',
  terminal: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.5-2 1.5M8 9.5h3.5"/></svg>',
  workspaces: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M6.5 2.5v11"/></svg>',
  keyboard: '<svg viewBox="0 0 16 16"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M5.5 9.5h5"/><rect x="4" y="6" width="1" height="1" fill="currentColor" stroke="none"/><rect x="6" y="6" width="1" height="1" fill="currentColor" stroke="none"/><rect x="8" y="6" width="1" height="1" fill="currentColor" stroke="none"/><rect x="10" y="6" width="1" height="1" fill="currentColor" stroke="none"/><rect x="12" y="6" width="1" height="1" fill="currentColor" stroke="none"/></svg>',
  info: '<svg viewBox="0 0 16 16"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M8.5 8v3"/><rect x="8" y="5.5" width="1" height="1" fill="currentColor" stroke="none"/></svg>',
  sun: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/></svg>',
  moon: '<svg viewBox="0 0 16 16"><path d="M13 9.6A5.5 5.5 0 0 1 6.4 3 5.5 5.5 0 1 0 13 9.6z"/></svg>',
  /** A speech bubble with a prompt's chevron: what you asked an agent. */
  prompts: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 5.5l2 1.5-2 1.5M8.5 8.5h2"/></svg>',
  /** Braces: a snippet (as on termilly.com). */
  snippet: '<svg viewBox="0 0 16 16"><path d="M6.5 2.5h-1a1 1 0 0 0-1 1v3L3 8l1.5 1.5v3a1 1 0 0 0 1 1h1M9.5 2.5h1a1 1 0 0 1 1 1v3L13 8l-1.5 1.5v3a1 1 0 0 1-1 1h-1"/></svg>',
  /** A lightning bolt: an action (as on termilly.com). */
  action: '<svg viewBox="0 0 16 16"><path d="M9 1.5l-6 8h4.5l-1 5 6.5-8H8.5z"/></svg>',
  note: '<svg viewBox="0 0 16 16"><path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M9.5 2.5v3h3M5.5 8.5h5M5.5 10.5h3.5"/></svg>',
  // A play triangle: hear a sound.
  play: '<svg viewBox="0 0 16 16"><path d="M5.5 3.5v9l7-4.5z"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/></svg>',
  /** A funnel: narrow a list down. */
  filter: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11l-4 5v4l-3 1.5v-5.5z"/></svg>',
  /** Two sliders, as on the title bar's Settings: a panel's own settings. */
  settings: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h4M10.5 4.5h3M2.5 11.5h2M8.5 11.5h5"/><circle cx="8.5" cy="4.5" r="1.8"/><circle cx="6.5" cy="11.5" r="1.8"/></svg>',
  // A box with an arrow out of its corner: open something outside Termilly.
  launch: '<svg viewBox="0 0 16 16"><path d="M7.5 3.5h-4v9h9v-4M9.5 3.5h3v3M12.5 3.5l-5 5"/></svg>',
  monitor: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>',
};

/**
 * Formats a past timestamp: "14:05" today, "yesterday 18:40", "Mon 09:12", or a date.
 * @param {number} ms
 */
export function formatWhen(ms) {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const startOfDay = (/** @type {Date} */ x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS);
  if (days === 0) return time;
  if (days === 1) return `yesterday ${time}`;
  if (days < WEEK_DAYS) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
