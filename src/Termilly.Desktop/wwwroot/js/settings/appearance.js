// @ts-check
// Settings › Appearance: the theme, the terminals' and the app's fonts, text size and the cursor.

import { HOST } from '../protocol.js';
import { onHost, sys, SYSTEM_NAME } from '../host.js';
import { state, getSetting, GROUPS } from '../store.js';
import { THEMES } from '../themes.js';
import { cssColor, cssString, escapeHtml, ICONS, keysHtml } from '../ui.js';
import { setSetting, updateSettings, MIN_FONT_SIZE, MAX_FONT_SIZE } from '../preferences.js';
import { row, seg, toggle, group } from './controls.js';
import { SECTION, body, layer, page } from './page.js';
import { SETTING_VALUES } from '../constants.js';
import { field, find, targetOf } from '../dom.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { textSmoothing, cursorStyle, theme } = SETTING_VALUES;

/** The two font settings the one font list picks for: the terminals' and the app's. */
const TERMINAL_FONT = 'terminal.fontFamily';
const APP_FONT = 'interface.font';
/** Which of the two the list is setting now. */
let fontTarget = TERMINAL_FONT;
/** The fonts the host found: the monospace ones (for terminals) and all of them (for the app). */
/** @type {string[]} */
let installedFonts = [];
/** @type {string[]} */
let uiFonts = [];

const FONT_PICKER = '.font-picker';
const FONT_LIST = '.font-list';
/** The class of the line a font list shows when nothing matches. */
const NO_FONTS_CLASS = 'none';

/** How long each line of "output" is in a theme card's small terminal, in percent. */
const INK_WIDTHS = [70, 45, 58];

/**
 * The theme picker: a card per theme with a small window in its colours, and System, half Dark and half Light.
 * It's a .seg bound to the theme setting, so choosing and the selected state work as for any other.
 */
function themeCards() {
  const mini = (/** @type {import('../themes.js').Theme['preview']} */ p) => `<span class="tc-win" style="--p-bg:${cssColor(p.bg)};--p-side:${cssColor(p.side)};--p-line:${cssColor(p.line)};--p-text:${cssColor(p.text)};--p-accent:${cssColor(p.accent)};--p-term:${cssColor(p.term)}">
      <span class="tc-side"><i></i><i class="on"></i><i></i></span>
      <span class="tc-term">${p.ink.map((c, i) => `<i style="background:${cssColor(c)};width:${INK_WIDTHS[i]}%"></i>`).join('')}</span>
    </span>`;
  const [dark, light] = THEMES;
  return `<span class="seg theme-cards" data-setting="interface.theme">
    <button data-value="${theme.system}"><span class="tc-split">${mini(dark.preview)}${mini(light.preview)}</span><span class="tc-name">System</span></button>${THEMES.map(t => `
    <button data-value="${t.id}">${mini(t.preview)}<span class="tc-name">${escapeHtml(t.name)}</span></button>`).join('')}
  </span>`;
}

/**
 * Searchable font list bound to a setting (see FONT_PICKERS).
 * @param {string} key
 */
const fontPicker = key => `
  <div class="font-picker" data-font-setting="${key}">
    <input class="field font-search" type="text" placeholder="Search fonts" spellcheck="false" autocomplete="off" aria-label="Search fonts">
    <div class="font-list" role="listbox"></div>
  </div>`;

/**
 * What each font picker lists. The app font can go back to the system's default ('' → null).
 * @type {Record<string, { fonts: () => string[], fallback: string, defaultLabel?: string }>}
 */
const FONT_PICKERS = {
  [TERMINAL_FONT]: { fonts: () => installedFonts, fallback: 'monospace' },
  [APP_FONT]: { fonts: () => uiFonts, fallback: 'sans-serif', defaultLabel: sys.name === SYSTEM_NAME.linux ? 'System default' : 'Windows default (Corbel)' },
};

/**
 * Fills each font list on the page with the fonts its search matches, each shown in itself.
 * @param {HTMLElement} root
 */
function renderFontLists(root) {
  for (const picker of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(FONT_PICKER))) {
    const key = /** @type {string} */ (picker.dataset.fontSetting);
    const { fonts: available, fallback, defaultLabel } = FONT_PICKERS[key];
    const query = field(picker, '.font-search').value.trim().toLowerCase();
    const chosen = getSetting(key);
    const fonts = !chosen || available().includes(chosen) ? available() : [chosen, ...available()];
    const options = fonts.filter(f => f.toLowerCase().includes(query))
      .map(font => /** @type {[string, string]} */ ([font, font]));
    if (defaultLabel && defaultLabel.toLowerCase().includes(query)) options.unshift(['', defaultLabel]);
    find(picker, FONT_LIST).replaceChildren(...options.map(([font, label]) => {
      const option = document.createElement('button');
      option.className = 'font-option';
      option.dataset.font = font;
      option.style.fontFamily = font ? `"${cssString(font)}", ${fallback}` : 'var(--ui-default-font)';
      option.textContent = label;
      option.insertAdjacentHTML('beforeend', '<svg class="check" viewBox="0 0 12 12"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg>');
      return option;
    }));
    if (!options.length) {
      const none = document.createElement('div');
      none.className = NO_FONTS_CLASS;
      none.textContent = available().length ? 'No matching fonts' : 'Loading fonts…';
      find(picker, FONT_LIST).append(none);
    }
  }
  syncFonts(root);
}

/**
 * Points the font list at the terminals' font or the app's, keeping the search text.
 * @param {string} key
 */
function showFontTarget(key) {
  fontTarget = key;
  const picker = /** @type {HTMLElement | null} */ (body.querySelector(FONT_PICKER));
  if (!picker) return;
  picker.dataset.fontSetting = key;
  renderFontLists(body);
  revealChosenFonts();
}

/** Scrolls each font list (not the page) so its chosen font is in view. */
function revealChosenFonts() {
  for (const list of body.querySelectorAll(FONT_LIST)) {
    const option = list.querySelector('.font-option.selected');
    if (option) list.scrollTop += option.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 2;
  }
}

/**
 * The text size, the chosen fonts, which font the list sets, and the note naming both.
 * @param {HTMLElement} root
 */
function syncFonts(root) {
  const range = /** @type {HTMLInputElement | null} */ (root.querySelector('#font-size-range'));
  if (range) {
    const { fontSize } = state.settings.terminal;
    // The number goes in as is; the input reads it as its text.
    range.value = /** @type {any} */ (fontSize);
    range.style.setProperty('--fill', `${((fontSize - MIN_FONT_SIZE) / (MAX_FONT_SIZE - MIN_FONT_SIZE)) * 100}%`);
    find(root, '#font-size-value').textContent = `${fontSize}px`;
  }
  for (const picker of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(FONT_PICKER))) {
    const chosen = getSetting(/** @type {string} */ (picker.dataset.fontSetting)) ?? '';
    for (const option of /** @type {NodeListOf<HTMLElement>} */ (picker.querySelectorAll('.font-option'))) option.classList.toggle('selected', option.dataset.font === chosen);
  }
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-font-target]'))) {
    const on = b.dataset.fontTarget === fontTarget;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  const note = root.querySelector('#font-target-note');
  if (note) {
    const terminal = escapeHtml(state.settings.terminal.fontFamily);
    const app = escapeHtml(state.settings.interface.font ?? (sys.name === SYSTEM_NAME.linux ? 'System default' : 'Windows default'));
    note.innerHTML = fontTarget === TERMINAL_FONT
      ? `Monospace fonts for terminals. Terminal: <b>${terminal}</b> · App: ${app}`
      : `Any installed font, for menus, sidebar, headers and dialogs. App: <b>${app}</b> · Terminal: ${terminal}`;
  }
}

/** A step of the size buttons, in pixels. */
const FONT_STEP = 1;

/** @type {import('./page.js').Section} */
const APPEARANCE = {
  id: SECTION.appearance,
  label: 'Appearance', icon: ICONS.appearance,
  html: () => group('', row('Theme', `Colours for the app and its terminals. System is Dark or Light as ${sys.name === SYSTEM_NAME.linux ? 'the desktop’s' : 'Windows’'} app mode says.`,
    themeCards(), { stack: true, keywords: 'colour color dark light system look palette' }))
    // One list for both fonts; the switch picks which one it sets, and the note shows both choices.
    + group('Font', row('', '<span id="font-target-note"></span>', `
        <span class="seg font-target" role="tablist" aria-label="Font for">
          <button data-font-target="${TERMINAL_FONT}" role="tab">${ICONS.terminal}Terminal</button>
          <button data-font-target="${APP_FONT}" role="tab">${ICONS.appearance}App</button>
        </span>
        ${fontPicker(fontTarget)}`, { stack: true, keywords: 'font family typeface terminal app' }))
    + group('Terminal text',
      // ClearType is Windows' own; on Linux the desktop's font settings decide.
      (sys.name === SYSTEM_NAME.linux ? '' : row('Text smoothing', 'Greyscale keeps coloured text crisp on the dark background; ClearType matches other Windows apps.',
        seg('terminal.textSmoothing', [[textSmoothing.grayscale, 'Greyscale'], [textSmoothing.clearType, 'ClearType']])))
      + row('Size', `${keysHtml('Ctrl +')} ${keysHtml('Ctrl -')} ${keysHtml('Ctrl 0')}`, `
        <div class="size-control">
          <button id="font-smaller" title="Smaller"><svg viewBox="0 0 12 12"><path d="M2.5 6h7"/></svg></button>
          <input id="font-size-range" type="range" min="${MIN_FONT_SIZE}" max="${MAX_FONT_SIZE}" step="1">
          <button id="font-larger" title="Larger"><svg viewBox="0 0 12 12"><path d="M6 2.5v7M2.5 6h7"/></svg></button>
          <span id="font-size-value"></span>
        </div>`, { keywords: 'font size zoom bigger smaller' })
      + row('Line height', '', seg('terminal.lineHeight', [['1', '1.0'], ['1.2', '1.2'], ['1.4', '1.4'], ['1.6', '1.6']])))
    + group('Cursor',
      row('Style', '', seg('terminal.cursorStyle', [[cursorStyle.bar, 'Bar'], [cursorStyle.block, 'Block'], [cursorStyle.underline, 'Underline']]))
      + row('Blink', '', toggle('terminal.cursorBlink'))),
  opened: revealChosenFonts,
  drawn: renderFontLists,
  sync: syncFonts,
  click(e) {
    const font = /** @type {HTMLElement | null} */ (targetOf(e).closest('.font-option'));
    if (font) {
      setSetting(/** @type {string} */ (/** @type {HTMLElement} */ (font.closest(FONT_PICKER)).dataset.fontSetting),
        font.dataset.font || null);
      return true;
    }
    const target = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-font-target]'));
    if (target) {
      showFontTarget(/** @type {string} */ (target.dataset.fontTarget));
      return true;
    }
    const step = targetOf(e).closest('#font-larger') ? FONT_STEP : targetOf(e).closest('#font-smaller') ? -FONT_STEP : 0;
    if (step) updateSettings(GROUPS.terminal, { fontSize: state.settings.terminal.fontSize + step });
    return !!step;
  },
  input(e) {
    if (targetOf(e).classList.contains('font-search')) renderFontLists(body);
    if (targetOf(e).id === 'font-size-range') {
      updateSettings(GROUPS.terminal, { fontSize: Number(/** @type {HTMLInputElement} */ (e.target).value) });
    }
  },
};

export default APPEARANCE;

onHost(HOST.fonts, m => {
  installedFonts = m.fonts;
  uiFonts = m.uiFonts ?? [];
  if (!layer.hidden && page.current === SECTION.appearance) renderFontLists(body);
});
