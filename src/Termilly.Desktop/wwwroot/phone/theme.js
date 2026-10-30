// @ts-check
// The app's look (Settings › Appearance): Same as PC (the desktop's theme, as it changes), Automatic (the phone's own
// light or dark: phone.css), or any of the desktop's themes (js/phone.js sends them). The page takes the theme's few
// colours; the terminal view takes its terminal colours.

/** The looks that aren't a theme, and where the phone keeps the one chosen. */
export const LOOK = Object.freeze({ pc: 'pc', auto: 'auto', key: 'termilly.theme' });

/**
 * A desktop theme as the phone draws itself with it.
 * @typedef {{ id: string, name: string, light: boolean, ui: { bg: string, raised: string, line: string, text: string, muted: string, accent: string },
 *   terminal: Record<string, string> }} PhoneTheme
 * @typedef {{ themes?: PhoneTheme[], pcTheme?: string, pcTerminal?: Record<string, string> }} Themed
 */

/** The terminal's colours with no theme (Automatic): the desktop's Dark. */
const DARK_TERMINAL = Object.freeze({ background: '#0a0a0c', foreground: '#d7d7de', cursor: '#d7d7de', selectionBackground: '#3a3a55' });
/** How far text must stand out on a light terminal (WCAG's 4.5:1, as the desktop does); dark ones keep their colours. */
const CONTRAST = Object.freeze({ light: 4.5, dark: 1 });
/** A background brighter than this is a light one (0 to 255, the average of red, green and blue). */
const LIGHT_ABOVE = 140;
const HEX = 16;
/** Where red, green and blue start in #rrggbb. */
const RGB_AT = Object.freeze([1, 3, 5]);
const COLOR_SCHEME = 'color-scheme';
const CHANNELS = 3;
/** The page's colours a theme sets (phone.css), and the state colours taken from its terminal. */
const UI = /** @type {const} */ (['bg', 'raised', 'line', 'text', 'muted', 'accent']);
const STATES = Object.freeze({ '--attention': 'yellow', '--danger': 'red', '--ok': 'green' });
const SHEET = '--sheet';
/**
 * Text on the accent colour (buttons): white, or near black where white would stand out less than this from the accent
 * (a light one, like Midnight's lavender).
 */
const ON_ACCENT = Object.freeze({ name: '--on-accent', dark: '#14141a', least: 3 });
/** WCAG's relative luminance: sRGB channels made linear, then weighted. */
const LINEAR = Object.freeze({ knee: 0.03928, slope: 12.92, offset: 0.055, scale: 1.055, power: 2.4, max: 255 });
const WEIGHTS = Object.freeze([0.2126, 0.7152, 0.0722]);
const FLARE = 0.05;

/** The look chosen (Same as PC unless the user picked another). */
export const chosenLook = () => localStorage.getItem(LOOK.key) || LOOK.pc;

/** @param {string} look */
export const chooseLook = look => localStorage.setItem(LOOK.key, look);

/**
 * The theme the look comes to now (null: Automatic, or the PC hasn't said yet), and the terminal's colours.
 * @param {Themed} snap
 */
function resolve(snap) {
  const look = chosenLook();
  if (look === LOOK.auto) return { theme: null, terminal: DARK_TERMINAL };
  const theme = snap.themes?.find(t => t.id === (look === LOOK.pc ? snap.pcTheme : look)) ?? null;
  const terminal = (look === LOOK.pc ? snap.pcTerminal : theme?.terminal) ?? DARK_TERMINAL;
  return { theme, terminal };
}

/** @param {string} color #rrggbb */
const luminance = color => RGB_AT.reduce((sum, at, i) => {
  const v = parseInt(color.slice(at, at + 2), HEX) / LINEAR.max;
  return sum + WEIGHTS[i] * (v <= LINEAR.knee ? v / LINEAR.slope : ((v + LINEAR.offset) / LINEAR.scale) ** LINEAR.power);
}, 0);

/** How far white text stands out from a colour (WCAG's contrast ratio, 1 to 21). @param {string} color #rrggbb */
const whiteContrast = color => (1 + FLARE) / (luminance(color) + FLARE);

/** @param {string} color #rrggbb */
const isLight = color => /^#[\da-f]{6}$/i.test(color)
  && RGB_AT.reduce((sum, i) => sum + parseInt(color.slice(i, i + 2), HEX), 0) / CHANNELS > LIGHT_ABOVE;

/**
 * Colours the page as the look says, and gives the terminal's colours.
 * @param {Themed} snap
 * @returns {{ colors: Record<string, string>, contrast: number }}
 */
export function applyLook(snap) {
  const { theme, terminal } = resolve(snap);
  const root = document.documentElement.style;
  for (const name of [...UI.map(v => `--${v}`), SHEET, ON_ACCENT.name, ...Object.keys(STATES)]) root.removeProperty(name);
  root.removeProperty(COLOR_SCHEME);
  if (theme) {
    for (const name of UI) root.setProperty(`--${name}`, theme.ui[name]);
    root.setProperty(SHEET, theme.ui.raised);
    if (/^#[\da-f]{6}$/i.test(theme.ui.accent) && whiteContrast(theme.ui.accent) < ON_ACCENT.least) root.setProperty(ON_ACCENT.name, ON_ACCENT.dark);
    for (const [name, ansi] of Object.entries(STATES)) if (theme.terminal[ansi]) root.setProperty(name, theme.terminal[ansi]);
    root.setProperty(COLOR_SCHEME, theme.light ? 'light' : 'dark');
  }
  return { colors: terminal, contrast: isLight(terminal.background ?? '') ? CONTRAST.light : CONTRAST.dark };
}

/**
 * The looks to pick from: Same as PC, Automatic, then each theme (its background and accent as a swatch).
 * @param {Themed} snap
 */
export const looks = snap => [
  { id: LOOK.pc, name: 'Same as PC', swatch: null },
  { id: LOOK.auto, name: 'Automatic', swatch: null },
  ...(snap.themes ?? []).map(t => ({ id: t.id, name: t.name, swatch: { bg: t.ui.bg, accent: t.ui.accent } })),
];
