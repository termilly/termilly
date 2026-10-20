// @ts-check
// The app's colour themes (Settings › Appearance). Dark and Light are app.css's own colours; every other theme is
// a handful of interface colours and the terminals' 16, from which the rest of app.css's colour variables are
// worked out and set on the page (settings.js). Themes change colours only: fonts, sizes and lines stay as they are.
// "system" isn't a theme: it's Dark or Light, as Windows' (or the desktop's) app mode says.

import { state } from './store.js';
import { SETTING_VALUES } from './constants.js';

/** The theme setting's choices (C#'s SettingValues): Dark, Light, and System for whichever Windows' app mode says. */
const THEME = SETTING_VALUES.theme;

/** What a theme is built on: app.css's dark colours or its light ones. */
export const THEME_BASE = Object.freeze({ dark: 'dark', light: 'light' });
/** The CSS variable with the terminals' font, which the change preview and the player use too. */
export const TERM_FONT_VAR = '--term-font';

/**
 * A theme as it's written below: its interface colours, its terminals' (bg, fg, cursor and the 16 ANSI colours), and
 * variables it sets itself.
 * @typedef {{ id: string, name: string, base: string, ui: Record<string, string>,
 *   term: { bg: string, fg: string, cursor?: string, ansi: string[] }, over?: Record<string, string> }} ThemeSpec
 */

/**
 * A theme as the page uses it: the variables it sets on the page, xterm's colours, the picker's small window, and
 * the host's window colours.
 * @typedef {{ id: string, name: string, base: string, vars: Record<string, string>, terminal: Record<string, string>,
 *   preview: { bg: string, side: string, line: string, text: string, accent: string, term: string, ink: string[] },
 *   window: { background: string, frame: string, text: string, accent: string } }} Theme
 */

/**
 * ANSI black is the background, as in Windows Terminal: Windows PowerShell's PSReadLine paints what you type after
 * the command on an explicit black background (ESC[40m), which would otherwise show as grey bands.
 */
const DARK_TERMINAL = {
  background: '#0a0a0a',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#0a0a0a',
  selectionBackground: 'rgba(139, 123, 255, 0.32)',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.10)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.18)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.24)',
  overviewRulerBorder: 'rgba(0, 0, 0, 0)', // the prompt-mark strip needs no edge line (xterm doesn't parse 'transparent')
  black: '#0a0a0a', red: '#ff7b72', green: '#7ee787', yellow: '#f2cc60',
  blue: '#79c0ff', magenta: '#d2a8ff', cyan: '#76e3ea', white: '#d9d9d9',
  brightBlack: '#6e6e6e', brightRed: '#ffa198', brightGreen: '#a5f3a8', brightYellow: '#f8e3a1',
  brightBlue: '#a5d6ff', brightMagenta: '#e2c5ff', brightCyan: '#b3f0f5', brightWhite: '#ffffff',
};

/** Readable on white: darker ANSI colours (white and bright white are greys, or they'd vanish). */
const LIGHT_TERMINAL = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(109, 92, 240, 0.22)',
  scrollbarSliderBackground: 'rgba(0, 0, 0, 0.12)',
  scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.2)',
  scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.28)',
  overviewRulerBorder: 'rgba(0, 0, 0, 0)',
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#8a5d00',
  blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01',
  brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
};

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

/**
 * The themes beyond Dark and Light. `ui`: the page (bg the window, surface the sidebar and panels, header the pane
 * headers, raised menus and dialogs, border the lines, then text, muted text, the accent and the state colours).
 * `term`: the terminals' background, text and ANSI colours in order (black is the background on dark ones). `over`
 * replaces a worked-out variable where a theme needs its own.
 */
/** @type {ThemeSpec[]} */
const SPECS = [
  { id: 'midnight', name: 'Midnight', base: 'dark',
    ui: { bg: '#1e1f29', surface: '#21222c', header: '#191a21', raised: '#282a36', border: '#343746', text: '#f8f8f2', muted: '#8b8fa8', accent: '#bd93f9', attention: '#f1fa8c', danger: '#ff5555', ok: '#50fa7b' },
    term: { bg: '#21222c', fg: '#f8f8f2', ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'] } },
  { id: 'arctic', name: 'Arctic', base: 'dark',
    ui: { bg: '#242933', surface: '#2e3440', header: '#272c36', raised: '#3b4252', border: '#3b4252', text: '#eceff4', muted: '#8f9bb3', accent: '#88c0d0', attention: '#ebcb8b', danger: '#bf616a', ok: '#a3be8c' },
    term: { bg: '#2e3440', fg: '#d8dee9', ansi: ['#2e3440', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#d57780', '#b5cf9e', '#f0d7a3', '#97b3d1', '#c5a3be', '#8fbcbb', '#eceff4'] } },
  { id: 'ember', name: 'Ember', base: 'dark',
    ui: { bg: '#1d2021', surface: '#282828', header: '#1d2021', raised: '#32302f', border: '#3c3836', text: '#ebdbb2', muted: '#a89984', accent: '#fe8019', attention: '#fabd2f', danger: '#fb4934', ok: '#b8bb26' },
    term: { bg: '#282828', fg: '#ebdbb2', ansi: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'] } },
  { id: 'deep-ocean', name: 'Deep Ocean', base: 'dark',
    ui: { bg: '#002029', surface: '#002b36', header: '#00222b', raised: '#073642', border: '#0a3c48', text: '#eee8d5', muted: '#839496', accent: '#268bd2', attention: '#b58900', danger: '#dc322f', ok: '#859900' },
    term: { bg: '#002b36', fg: '#93a1a1', ansi: ['#002b36', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#657b83', '#e4605a', '#a3b72a', '#d4a11a', '#4fa3e0', '#e0609d', '#4cbcb2', '#fdf6e3'] } },
  { id: 'forest', name: 'Forest', base: 'dark',
    ui: { bg: '#232a2e', surface: '#2d353b', header: '#272e33', raised: '#343f44', border: '#3d484d', text: '#d3c6aa', muted: '#9da9a0', accent: '#a7c080', attention: '#dbbc7f', danger: '#e67e80', ok: '#a7c080' },
    term: { bg: '#2d353b', fg: '#d3c6aa', ansi: ['#2d353b', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa', '#7a8478', '#f08c8e', '#b5d08c', '#e8c98a', '#8fcac2', '#e2a8c4', '#92d0a2', '#e8dfc7'] } },
  { id: 'rose', name: 'Rose', base: 'dark',
    ui: { bg: '#191724', surface: '#1f1d2e', header: '#1a1826', raised: '#26233a', border: '#2a273f', text: '#e0def4', muted: '#908caa', accent: '#ebbcba', attention: '#f6c177', danger: '#eb6f92', ok: '#9ccfd8' },
    term: { bg: '#1f1d2e', fg: '#e0def4', ansi: ['#1f1d2e', '#eb6f92', '#a3d6b0', '#f6c177', '#5ea3c4', '#c4a7e7', '#9ccfd8', '#e0def4', '#6e6a86', '#f08aa8', '#b8e3c4', '#f9d29a', '#80bcd8', '#d6c1f0', '#b8e1e8', '#ffffff'] } },
  { id: 'plum', name: 'Plum', base: 'dark',
    ui: { bg: '#1a1320', surface: '#211828', header: '#1c1522', raised: '#2a1f33', border: '#352840', text: '#eadcf0', muted: '#9a88a6', accent: '#d48bdb', attention: '#f0c674', danger: '#f07178', ok: '#a6d189' },
    term: { bg: '#211828', fg: '#eadcf0', ansi: ['#211828', '#f07178', '#a6d189', '#f0c674', '#82aaff', '#d48bdb', '#89ddff', '#e0d0e8', '#6c5a78', '#ff8b92', '#c3e88d', '#ffcb6b', '#a6c2ff', '#e8a8ee', '#a6ecff', '#ffffff'] } },
  { id: 'graphite', name: 'Graphite', base: 'dark',
    ui: { bg: '#1b1c1e', surface: '#222326', header: '#1d1e21', raised: '#2a2b2f', border: '#33353a', text: '#e3e4e6', muted: '#8e9096', accent: '#5aa9ff', attention: '#e8c46a', danger: '#f2666b', ok: '#6dd38a' },
    term: { bg: '#222326', fg: '#dcdde0', ansi: ['#222326', '#f2666b', '#6dd38a', '#e8c46a', '#5aa9ff', '#c58af9', '#5ad1d9', '#d0d1d4', '#6b6e75', '#ff8589', '#8ae3a4', '#f3d68b', '#86c1ff', '#d7a8ff', '#86e3e9', '#ffffff'] } },
  // The old DOS file managers' look: cyan on blue, yellow highlights, a cyan selection bar.
  { id: 'classic-blue', name: 'Classic Blue', base: 'dark',
    ui: { bg: '#000080', surface: '#0000aa', header: '#0000aa', raised: '#0000aa', border: '#55ffff', text: '#55ffff', muted: '#aaaaaa', accent: '#ffff55', attention: '#ffff55', danger: '#ff5555', ok: '#55ff55' },
    term: { bg: '#0000aa', fg: '#55ffff', cursor: '#ffff55', ansi: ['#0000aa', '#ff5555', '#55ff55', '#ffff55', '#55aaff', '#ff55ff', '#55ffff', '#aaaaaa', '#8080ff', '#ff7777', '#77ff77', '#ffff88', '#aad4ff', '#ff88ff', '#aaffff', '#ffffff'] },
    over: { '--accent-fill': 'rgba(0, 170, 170, 0.75)', '--text-strong': '#ffffff', '--faint': '#8080ff', '--hover': 'rgba(85, 255, 255, 0.16)' } },
  { id: 'green-phosphor', name: 'Green Phosphor', base: 'dark',
    ui: { bg: '#020a02', surface: '#031103', header: '#020d02', raised: '#062006', border: '#0b3d16', text: '#33ff66', muted: '#1fae46', accent: '#66ff99', attention: '#ccff66', danger: '#ff6b6b', ok: '#33ff66' },
    term: { bg: '#031103', fg: '#33ff66', ansi: ['#031103', '#e0ff70', '#33ff66', '#b8ff4d', '#2ecc71', '#7dffb0', '#4dffd2', '#a6ffbf', '#1a7a35', '#eeff99', '#66ff8f', '#d4ff80', '#5ce68f', '#a3ffc8', '#80ffe0', '#d9ffe3'] } },
  { id: 'amber-phosphor', name: 'Amber Phosphor', base: 'dark',
    ui: { bg: '#0d0700', surface: '#140b00', header: '#100800', raised: '#1d1100', border: '#3a2400', text: '#ffb000', muted: '#b37a00', accent: '#ffcc33', attention: '#ffe066', danger: '#ff6a3d', ok: '#ffd24d' },
    term: { bg: '#140b00', fg: '#ffb000', ansi: ['#140b00', '#ff7a33', '#ffc94d', '#ffe066', '#e69500', '#ff9f66', '#ffd699', '#ffcc80', '#7a5200', '#ff9966', '#ffd980', '#fff0a8', '#ffb84d', '#ffbf99', '#ffe6c2', '#fff3e0'] } },
  { id: 'sunset', name: 'Sunset', base: 'dark',
    ui: { bg: '#1f1418', surface: '#27191e', header: '#211519', raised: '#2f1f25', border: '#3d2830', text: '#f5e1d8', muted: '#b0908a', accent: '#ff8a65', attention: '#ffd166', danger: '#ef476f', ok: '#8bd17c' },
    term: { bg: '#27191e', fg: '#f5e1d8', ansi: ['#27191e', '#ef476f', '#8bd17c', '#ffd166', '#6ca6f0', '#e58fd0', '#6fd6c8', '#e8d2c8', '#7a5d63', '#ff6b8b', '#a8e39a', '#ffe08f', '#93bff7', '#f2aee0', '#94e6db', '#ffffff'] } },
  { id: 'neon', name: 'Neon', base: 'dark',
    ui: { bg: '#16161e', surface: '#1a1b26', header: '#16161e', raised: '#24283b', border: '#292e42', text: '#c0caf5', muted: '#7f88b5', accent: '#7aa2f7', attention: '#e0af68', danger: '#f7768e', ok: '#9ece6a' },
    term: { bg: '#1a1b26', fg: '#c0caf5', ansi: ['#1a1b26', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#565f89', '#ff8fa3', '#b4e07f', '#f0c584', '#94b8ff', '#cdb2ff', '#9ad9ff', '#c0caf5'] } },
  { id: 'coffee', name: 'Coffee', base: 'dark',
    ui: { bg: '#1c1612', surface: '#231c17', header: '#1e1814', raised: '#2c231d', border: '#3a2f27', text: '#eadbc8', muted: '#a8937e', accent: '#d4a373', attention: '#e9c46a', danger: '#e76f51', ok: '#a3b18a' },
    term: { bg: '#231c17', fg: '#eadbc8', ansi: ['#231c17', '#e76f51', '#a3b18a', '#e9c46a', '#7fa7c9', '#c99ab0', '#88b8a8', '#d8c8b4', '#76665a', '#f28b6e', '#bccaa3', '#f2d488', '#9cbfdc', '#dcb3c6', '#a5cfc1', '#fff4e6'] } },
  { id: 'slate', name: 'Slate', base: 'dark',
    ui: { bg: '#1e2127', surface: '#282c34', header: '#21252b', raised: '#2c313a', border: '#3a3f4b', text: '#dcdfe4', muted: '#8b919d', accent: '#61afef', attention: '#e5c07b', danger: '#e06c75', ok: '#98c379' },
    term: { bg: '#282c34', fg: '#abb2bf', ansi: ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#ef7f88', '#a9d18a', '#f0cd8e', '#7cbff5', '#d394e8', '#6ec8d4', '#ffffff'] } },
  { id: 'paper', name: 'Paper', base: 'light',
    ui: { bg: '#eee8d5', surface: '#fdf6e3', header: '#f4eedb', raised: '#fdf6e3', border: '#ded6bf', text: '#3b4b52', muted: '#6f7f86', accent: '#268bd2', attention: '#b58900', danger: '#dc322f', ok: '#859900' },
    term: { bg: '#fdf6e3', fg: '#4f6169', ansi: ['#073642', '#dc322f', '#6c7f00', '#8a6900', '#268bd2', '#d33682', '#1f7a73', '#93a1a1', '#586e75', '#cb4b16', '#5a6a00', '#735800', '#1a6aa3', '#a8286a', '#186560', '#7c8b8b'] } },
  { id: 'sandstone', name: 'Sandstone', base: 'light',
    ui: { bg: '#ebdbb2', surface: '#fbf1c7', header: '#f2e5bc', raised: '#fbf1c7', border: '#d5c4a1', text: '#3c3836', muted: '#7c6f64', accent: '#af3a03', attention: '#b57614', danger: '#9d0006', ok: '#79740e' },
    term: { bg: '#fbf1c7', fg: '#3c3836', ansi: ['#3c3836', '#cc241d', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#7c6f64', '#665c54', '#9d0006', '#5f5d0a', '#8f5c0f', '#05515f', '#702b5a', '#2f5d42', '#928374'] } },
  { id: 'mint', name: 'Mint', base: 'light',
    ui: { bg: '#eef5f1', surface: '#ffffff', header: '#f5faf7', raised: '#ffffff', border: '#d5e5dc', text: '#1f2d27', muted: '#5e7268', accent: '#12a37a', attention: '#b7791f', danger: '#d64545', ok: '#12a37a' },
    term: { bg: '#ffffff', fg: '#1f2d27', ansi: ['#24302b', '#c53030', '#0f7b5b', '#946200', '#2b6cb0', '#8e44ad', '#0f7f86', '#6b7c74', '#4a5a53', '#a51f1f', '#0a6148', '#734b00', '#1f5590', '#6f3486', '#0b6369', '#8a9a93'] } },
  { id: 'glacier', name: 'Glacier', base: 'light',
    ui: { bg: '#edf2f8', surface: '#ffffff', header: '#f4f7fb', raised: '#ffffff', border: '#d7e0eb', text: '#1c2533', muted: '#5d6b7e', accent: '#2f6fde', attention: '#b7791f', danger: '#d63c3c', ok: '#2f9e5b' },
    term: { bg: '#ffffff', fg: '#1c2533', ansi: ['#1c2533', '#c92a2a', '#2b8a3e', '#946200', '#1c64d1', '#8f3fbf', '#0b7a87', '#6b7787', '#4a5568', '#a51111', '#1f6b30', '#734b00', '#174fa5', '#6c2f91', '#085e68', '#8d97a5'] } },
  { id: 'lavender', name: 'Lavender', base: 'light',
    ui: { bg: '#f1eef8', surface: '#ffffff', header: '#f6f4fb', raised: '#ffffff', border: '#e0daee', text: '#2a2438', muted: '#6b6280', accent: '#7c5cd6', attention: '#b7791f', danger: '#d6455a', ok: '#2f9e6b' },
    term: { bg: '#ffffff', fg: '#2a2438', ansi: ['#2a2438', '#c4314b', '#2b7d55', '#8d5d00', '#3b5bd6', '#7c3fbf', '#127c8a', '#6e6780', '#4f4762', '#a51d36', '#1f6140', '#6c4700', '#2d47aa', '#612f98', '#0d5f6a', '#918aa3'] } },
];

// ---- Working out the rest ----

const BLACK = '#000000';
const WHITE = '#ffffff';
/** A #rrggbb colour's digits are hexadecimal, and each channel goes up to 255. */
const HEX = 16;
const CHANNEL_MAX = 255;
/** sRGB's transfer curve (WCAG's relative luminance): linear below the knee, else a gamma curve. */
const SRGB = Object.freeze({ knee: 0.03928, linearSlope: 12.92, offset: 0.055, scale: 1.055, gamma: 2.4 });
/** How much red, green and blue each add to luminance. */
const LUMA = Object.freeze({ red: 0.2126, green: 0.7152, blue: 0.0722 });
/** Above this luminance black text reads better on a colour than white. */
const LIGHT_LUMINANCE = 0.4;

/** Where the colours a theme's variables are worked out from sit in its 16 ANSI colours. */
const ANSI_INDEX = Object.freeze({ red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, brightBlue: 12 });

/** How much of the first colour each mixed variable keeps, in percent (the rest is the second colour). */
const MIX = Object.freeze({
  raised2: 94, borderStrong: 80, hoverBorder: 60, faint: 65, textStrong: 70, dangerText: 75, scroll: 85, thumb: 60,
  dockFill: 55,
});

/** The opacity of each see-through variable, on a dark theme and a light one where they differ. */
const ALPHA = Object.freeze({
  hover: { dark: 0.07, light: 0.06 },
  pressed: { dark: 0.12, light: 0.1 },
  accentSoft: 0.35,
  accentFill: { dark: 0.16, light: 0.12 },
  chip: { dark: 0.75, light: 0.92 },
  mark: 0.3,
  hit: 0.1,
  selection: { dark: 0.32, light: 0.22 },
  scrollbar: 0.12,
  scrollbarHover: 0.2,
  scrollbarActive: 0.28,
});

/** @param {string} hex #rrggbb */
const rgb = hex => (hex.match(/[0-9a-f]{2}/gi) ?? []).map(h => parseInt(h, HEX));
/** @param {string} hex @param {number} a */
const alpha = (hex, a) => `rgba(${rgb(hex).join(', ')}, ${a})`;
/** @param {string} a @param {string} b @param {number} share */
const mix = (a, b, share) => `color-mix(in srgb, ${a} ${share}%, ${b})`;
/**
 * Black or white, whichever reads better on the colour.
 * @param {string} hex
 */
const onColour = hex => {
  const [r, g, b] = rgb(hex).map(v => {
    v /= CHANNEL_MAX;
    return v <= SRGB.knee ? v / SRGB.linearSlope : ((v + SRGB.offset) / SRGB.scale) ** SRGB.gamma;
  });
  return LUMA.red * r + LUMA.green * g + LUMA.blue * b > LIGHT_LUMINANCE ? BLACK : WHITE;
};

/**
 * app.css's colour variables for a theme.
 * @param {ThemeSpec} spec
 * @returns {Record<string, string>}
 */
function variables({ base, ui, term, over }) {
  const dark = base === THEME_BASE.dark;
  const a = term.ansi;
  return {
    '--bg': ui.bg, '--surface': ui.surface, '--header': ui.header, '--raised': ui.raised,
    '--raised-2': mix(ui.raised, ui.text, MIX.raised2),
    '--border': ui.border, '--border-strong': mix(ui.border, ui.text, MIX.borderStrong),
    '--hover-border': mix(ui.border, ui.text, MIX.hoverBorder),
    '--hover': alpha(ui.text, dark ? ALPHA.hover.dark : ALPHA.hover.light),
    '--pressed': alpha(ui.text, dark ? ALPHA.pressed.dark : ALPHA.pressed.light),
    '--text': ui.text, '--muted': ui.muted, '--faint': mix(ui.muted, ui.bg, MIX.faint),
    '--text-strong': mix(ui.text, dark ? WHITE : BLACK, MIX.textStrong),
    '--accent': ui.accent, '--accent-soft': alpha(ui.accent, ALPHA.accentSoft),
    '--accent-fill': alpha(ui.accent, dark ? ALPHA.accentFill.dark : ALPHA.accentFill.light),
    '--on-accent': onColour(ui.accent),
    '--attention': ui.attention, '--danger': ui.danger, '--danger-text': mix(ui.danger, ui.text, MIX.dangerText),
    '--ok': ui.ok,
    '--scroll-thumb': mix(ui.border, ui.text, MIX.scroll), '--track': mix(ui.border, ui.text, MIX.scroll),
    '--thumb': dark ? mix(ui.text, WHITE, MIX.thumb) : ui.accent,
    '--dock-fill': mix(ui.muted, ui.bg, MIX.dockFill), '--chip-bg': alpha(ui.bg, dark ? ALPHA.chip.dark : ALPHA.chip.light),
    '--tag-default': ui.muted,
    '--term-bg': term.bg, '--term-text': term.fg,
    '--mark-bg': alpha(ui.attention, ALPHA.mark), '--hit-bg': alpha(ui.attention, ALPHA.hit),
    '--hl-keyword': a[ANSI_INDEX.red], '--hl-string': a[dark ? ANSI_INDEX.brightBlue : ANSI_INDEX.blue],
    '--hl-comment': ui.muted,
    '--hl-number': a[ANSI_INDEX.blue], '--hl-title': a[ANSI_INDEX.magenta], '--hl-type': a[ANSI_INDEX.yellow],
    '--hl-attr': a[ANSI_INDEX.cyan], '--hl-tag': a[ANSI_INDEX.green], '--hl-meta': ui.muted,
    ...over,
  };
}

/**
 * xterm's colours for a theme.
 * @param {ThemeSpec} spec
 * @returns {Record<string, string>}
 */
function terminal({ base, ui, term }) {
  const dark = base === THEME_BASE.dark;
  return {
    background: term.bg,
    foreground: term.fg,
    cursor: term.cursor ?? term.fg,
    cursorAccent: term.bg,
    selectionBackground: alpha(ui.accent, dark ? ALPHA.selection.dark : ALPHA.selection.light),
    scrollbarSliderBackground: alpha(term.fg, ALPHA.scrollbar),
    scrollbarSliderHoverBackground: alpha(term.fg, ALPHA.scrollbarHover),
    scrollbarSliderActiveBackground: alpha(term.fg, ALPHA.scrollbarActive),
    overviewRulerBorder: 'rgba(0, 0, 0, 0)',
    ...Object.fromEntries(ANSI.map((name, i) => [name, term.ansi[i]])),
  };
}

/**
 * Every theme, in the picker's order. `vars` are set on the page (none for Dark and Light, which are app.css's),
 * `terminal` is xterm's, `preview` colours the picker's small window, and `window` the host's window and start-up
 * loader before the page has drawn.
 * @type {Theme[]}
 */
export const THEMES = [
  {
    id: 'dark', name: 'Dark', base: 'dark', vars: {}, terminal: DARK_TERMINAL,
    preview: { bg: '#000000', side: '#0a0a0a', line: '#2e2e2e', text: '#7a7a7a', accent: '#8b7bff', term: '#0a0a0a', ink: ['#7ee787', '#79c0ff', '#e6e6e6'] },
    window: { background: '#000000', frame: '#262626', text: '#e6e6e6', accent: '#8b7bff' },
  },
  {
    id: 'light', name: 'Light', base: 'light', vars: {}, terminal: LIGHT_TERMINAL,
    preview: { bg: '#f3f3f5', side: '#ffffff', line: '#d0d0d8', text: '#686874', accent: '#6d5cf0', term: '#ffffff', ink: ['#116329', '#0969da', '#1f2328'] },
    window: { background: '#f3f3f5', frame: '#d4d4da', text: '#1d1d22', accent: '#6d5cf0' },
  },
  ...SPECS.map(spec => ({
    id: spec.id, name: spec.name, base: spec.base, vars: variables(spec), terminal: terminal(spec),
    preview: { bg: spec.ui.bg, side: spec.ui.surface, line: spec.ui.border, text: spec.ui.muted, accent: spec.ui.accent, term: spec.term.bg, ink: [spec.term.ansi[2], spec.term.ansi[4], spec.term.fg] },
    window: { background: spec.ui.bg, frame: spec.ui.border, text: spec.ui.text, accent: spec.ui.accent },
  })),
];

/** Every variable any theme sets, so switching away from one takes its colours off again. */
export const THEME_VARIABLES = [...new Set(THEMES.flatMap(t => Object.keys(t.vars)))];

const systemLight = matchMedia('(prefers-color-scheme: light)');

/**
 * The theme on screen: the chosen one, or for "system" Dark or Light as Windows' app mode says.
 * @param {string} [theme]
 */
export function themeId(theme = state.settings.interface.theme) {
  if (theme === THEME.system) return systemLight.matches ? THEME.light : THEME.dark;
  return THEMES.some(t => t.id === theme) ? theme : THEME.dark;
}

/** The theme on screen (Dark when the chosen one is gone). */
export const currentTheme = () => THEMES.find(t => t.id === themeId()) ?? THEMES[0];

/** @param {string} id */
export const themeById = id => THEMES.find(t => t.id === id);

/** @param {() => void} fn */
export const onSystemThemeChange = fn => systemLight.addEventListener('change', fn);
