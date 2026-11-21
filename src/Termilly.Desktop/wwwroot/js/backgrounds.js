// @ts-check
// The window's background (Settings › Appearance › Background, settings/appearancebackground.js): see-through, so the
// desktop shows (the host makes the window so, with the system's blur behind where it has one), and a picture or a
// gradient behind the terminals or the whole window. A workspace can have its own (its right-click menu): the one on
// screen wins. Everything is set on the page's root (attributes and CSS variables, css/backgrounds.css), which the
// detached windows copy (js/windows.js), so they follow too.

import { request } from './host.js';
import { PAGE } from './protocol.js';
import { state, on, emit, activeWs, EVENTS } from './store.js';
import { BACKGROUND } from './constants.js';
import { cssString } from './ui.js';

const { effect: EFFECT, opacity: OPACITY, fit: FIT, behind: BEHIND, workspaceKind: KIND, gradient: GRADIENT } = BACKGROUND;

/** Two soft lines across the gradient's lower part, as in a desktop wallpaper, stretched to the window at any shape. */
const GLOW_LINES = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="none">'
  + '<path d="M0 760 C 500 640, 1000 900, 1600 700" stroke="#ffffff" stroke-width="3" fill="none" opacity=".3" vector-effect="non-scaling-stroke"/>'
  + '<path d="M0 800 C 520 700, 1020 940, 1600 760" stroke="#ffffff" stroke-width="2" fill="none" opacity=".18" vector-effect="non-scaling-stroke"/></svg>');

/**
 * Theme gradient (Settings): drawn from the theme's variables, so it follows the theme on screen, imported ones too:
 * its accent lit at the top left fading to a deep shade of its background, its magenta glowing at the bottom right.
 * It goes behind the whole window, in place of any picture; css/backgrounds.css frosts it.
 * @type {Readonly<Backdrop>}
 */
const THEME_GRADIENT = Object.freeze({
  image: [
    `url('${GLOW_LINES}')`,
    'radial-gradient(50% 50% at 80% 75%, color-mix(in srgb, var(--hl-title) 85%, transparent), transparent)',
    'radial-gradient(70% 70% at 25% 30%, color-mix(in srgb, var(--accent) 65%, var(--bg)), color-mix(in srgb, var(--accent) 12%, color-mix(in srgb, var(--bg) 70%, #000)))',
  ].join(', '),
  fit: FIT.fill,
  behind: BEHIND.window,
});

/**
 * The gradients a workspace can have, drawn here (C#'s BackgroundValues.Gradient names them).
 * @type {Readonly<Record<string, string>>}
 */
export const GRADIENTS = Object.freeze({
  [GRADIENT.aurora]: 'linear-gradient(135deg, #1d2b64 0%, #2b6c7a 50%, #1f8a6b 100%)',
  [GRADIENT.ember]: 'linear-gradient(135deg, #2b0f12 0%, #5a1a1f 55%, #8a2a1e 100%)',
  [GRADIENT.dusk]: 'linear-gradient(160deg, #211a3d 0%, #4b2a5c 60%, #7a3f55 100%)',
  [GRADIENT.ocean]: 'linear-gradient(160deg, #061a2b 0%, #0f3a57 100%)',
  [GRADIENT.moss]: 'linear-gradient(160deg, #10201a 0%, #23402f 100%)',
  [GRADIENT.slate]: 'linear-gradient(160deg, #15171c 0%, #2a2f3a 100%)',
});

/**
 * How a picture fills its space, as CSS: its size and whether it repeats.
 * @type {Readonly<Record<string, { size: string, repeat: string }>>}
 */
const FIT_CSS = Object.freeze({
  [FIT.fill]: { size: 'cover', repeat: 'no-repeat' },
  [FIT.contain]: { size: 'contain', repeat: 'no-repeat' },
  [FIT.center]: { size: 'auto', repeat: 'no-repeat' },
  [FIT.tile]: { size: 'auto', repeat: 'repeat' },
});

/** The page root's attributes and variables (css/backgrounds.css reads them). */
const ROOT = Object.freeze({
  seeThrough: 'seeThrough', clearTerminals: 'clearTerminals', solidTerminals: 'solidTerminals', themeGradient: 'themeGradient',
  alpha: '--window-alpha', blur: '--backdrop-blur', dim: '--backdrop-dim',
});
/**
 * The two backgrounds: the main window's (the workspace on screen's own, else Settings'), and the detached windows'
 * (Settings' only: their terminals may belong to any workspace). Each has its attribute and variables' prefix.
 */
const LAYER = Object.freeze({
  screen: { attribute: 'backdrop', prefix: '--backdrop' },
  detached: { attribute: 'windowBackdrop', prefix: '--window-backdrop' },
});
const VAR = Object.freeze({ image: '-image', size: '-size', repeat: '-repeat' });
const PERCENT = 100;
const ON = '';

/** What the host says this system has: the effects its windows have, and where pictures load from. */
let info = { effects: /** @type {string[]} */ ([EFFECT.none]), pictureBase: '' };

/** The effects this system's windows have (Settings offers only these). */
export const effects = () => info.effects;

/** A picture's address, by its name in the backgrounds folder. @param {string} name */
export const pictureUrl = name => info.pictureBase + encodeURIComponent(name);

/** @typedef {{ image: string, fit: string, behind: string }} Backdrop */

/** Settings' picture, or none. @returns {Backdrop | null} */
function settingsBackdrop() {
  const settings = state.settings.background;
  if (!settings?.picture || !info.pictureBase) return null;
  return { image: `url("${cssString(pictureUrl(settings.picture))}")`, fit: settings.fit, behind: settings.behind };
}

/** What shows behind in the main window: the workspace on screen's own background, else Settings'. @returns {Backdrop | null} */
function screenBackdrop() {
  const own = activeWs()?.background;
  if (own?.kind === KIND.none) return null;
  if (own?.kind === KIND.gradient && own.gradient && GRADIENTS[own.gradient]) {
    return { image: GRADIENTS[own.gradient], fit: FIT.fill, behind: BEHIND.terminals };
  }
  if (own?.kind === KIND.picture && own.picture && info.pictureBase) {
    const settings = state.settings.background;
    return { image: `url("${cssString(pictureUrl(own.picture))}")`, fit: settings.fit, behind: settings.behind };
  }
  return settingsBackdrop();
}

/**
 * Shows a background on the root, or none.
 * @param {HTMLElement} root
 * @param {{ attribute: string, prefix: string }} layer
 * @param {Backdrop | null} shown
 */
function setLayer(root, layer, shown) {
  if (!shown) {
    delete root.dataset[layer.attribute];
    for (const suffix of Object.values(VAR)) root.style.removeProperty(layer.prefix + suffix);
    return;
  }
  const fit = FIT_CSS[shown.fit] ?? FIT_CSS[FIT.fill];
  root.dataset[layer.attribute] = shown.behind;
  root.style.setProperty(layer.prefix + VAR.image, shown.image);
  root.style.setProperty(layer.prefix + VAR.size, fit.size);
  root.style.setProperty(layer.prefix + VAR.repeat, fit.repeat);
}

/** Whether the terminals are drawn without a background of their own (something shows through them). */
let clear = false;

/** Whether the terminals draw no background now (js/terminals.js: xterm's transparency). */
export const clearTerminals = () => clear;

/** Sets the page's root as the background settings and the workspace on screen say. */
export function applyBackdrop() {
  const root = document.documentElement;
  const settings = state.settings.background;
  if (!settings) return;
  // Never under Theme gradient, which covers the whole window (BackgroundSettings.SeeThrough decides the same).
  const seeThrough = settings.opacity < OPACITY.max && !settings.themeGradient;
  const screen = settings.themeGradient ? THEME_GRADIENT : screenBackdrop();
  const detached = settings.themeGradient ? THEME_GRADIENT : settingsBackdrop();
  toggle(root, ROOT.themeGradient, settings.themeGradient);
  toggle(root, ROOT.seeThrough, seeThrough);
  toggle(root, ROOT.solidTerminals, settings.solidTerminals);
  root.style.setProperty(ROOT.alpha, String(settings.opacity / PERCENT));
  root.style.setProperty(ROOT.blur, `${settings.blur}px`);
  root.style.setProperty(ROOT.dim, String(settings.dim / PERCENT));
  setLayer(root, LAYER.screen, screen);
  setLayer(root, LAYER.detached, detached);
  // One setting for every terminal: where nothing shows behind one, its pane gives it its colour (css/backgrounds.css).
  const nowClear = !!screen || !!detached || (seeThrough && !settings.solidTerminals);
  toggle(root, ROOT.clearTerminals, nowClear);
  if (nowClear !== clear) {
    clear = nowClear;
    emit(EVENTS.backdrop);
  }
}

/** @param {HTMLElement} root @param {string} name @param {boolean} on */
function toggle(root, name, on) {
  if (on) root.dataset[name] = ON;
  else delete root.dataset[name];
}

/** Asks the host what this system has, then applies (a picture needs its address). */
export async function loadBackdropInfo() {
  const reply = await request(PAGE.backgroundInfo, {});
  info = { effects: reply.effects, pictureBase: reply.pictureBase };
  applyBackdrop();
}

on(EVENTS.workspaces, applyBackdrop);
