// @ts-check
// Settings › Appearance › Theme: removing imported themes, one from a card's right-click menu or several ticked in the
// Manage dialog.

import { state, GROUPS } from '../store.js';
import { importedThemes, themeById, THEME_BASE } from '../themes.js';
import { cssColor, escapeHtml } from '../ui.js';
import { updateSettings } from '../preferences.js';
import { modal, REMOVE_LABEL } from '../dialogs.js';
import { SETTING_VALUES } from '../constants.js';
import { find, field, targetOf } from '../dom.js';

const { theme } = SETTING_VALUES;

/**
 * Takes imported themes out. One on screen gives way to Dark or Light (as following the system's pick does), and one
 * picked for the system's dark or light mode goes back to Dark or Light, so importing it again doesn't bring the pick back.
 * @param {string[]} ids
 */
export function removeImported(ids) {
  const { theme: shown, themeDark, themeLight, customThemes } = state.settings.interface;
  /** @type {Record<string, unknown>} */
  const patch = { customThemes: (customThemes ?? []).filter(t => !ids.includes(t.id)) };
  if (ids.includes(shown)) patch.theme = themeById(shown)?.base === THEME_BASE.light ? theme.light : theme.dark;
  if (themeDark && ids.includes(themeDark)) patch.themeDark = theme.dark;
  if (themeLight && ids.includes(themeLight)) patch.themeLight = theme.light;
  updateSettings(GROUPS.interface, patch);
}

/** @param {number} n */
const removeLabel = n => (n ? `${REMOVE_LABEL} ${n} ${n === 1 ? 'theme' : 'themes'}` : REMOVE_LABEL);

/** The parts of the dialog it reads. */
const PART = Object.freeze({ all: '[data-tm-all]', tick: '[data-tm-id]', ok: '[data-ok]', search: '.tm-search', none: '.tm-none' });
/** The search box's label, here and in the gallery (appearance.js). */
export const SEARCH_LABEL = 'Search themes';

/** @param {import('../themes.js').Theme} t a row: its tick, its colours and its name */
const row = t => `<label class="dialog-check tm-row" data-tm-name="${escapeHtml(t.name.toLowerCase())}"><input type="checkbox" data-tm-id="${t.id}" data-no-enter>`
  + `<span class="tm-swatch" style="background:${cssColor(t.preview.term)};border-color:${cssColor(t.preview.accent)}"></span>${escapeHtml(t.name)}</label>`;

/** The dialog: a search, Select all, the imported themes, and the button that removes the ticked ones. */
const dialogHtml = () => `
  <h3>Imported themes</h3>
  <input class="field tm-search" type="search" placeholder="${SEARCH_LABEL}" spellcheck="false" autocomplete="off" aria-label="${SEARCH_LABEL}" data-no-enter autofocus>
  <label class="dialog-check tm-all"><input type="checkbox" data-tm-all data-no-enter> Select all</label>
  <div class="tm-list">${importedThemes().map(row).join('')}<p class="dialog-sub tm-none" hidden>No themes match.</p></div>
  <div class="dialog-actions">
    <button class="btn" data-cancel data-no-enter>Cancel</button>
    <button class="btn danger" data-ok disabled>${removeLabel(0)}</button>
  </div>`;

/**
 * The Manage dialog: the imported themes, ticked ones removed. Resolves with how many were removed, or null when cancelled.
 * @returns {Promise<number | null>}
 */
export function manageImported() {
  return modal('theme-manage', dialogHtml(), (dialog, close) => {
    const all = field(dialog, PART.all);
    const ticks = /** @type {HTMLInputElement[]} */ ([...dialog.querySelectorAll(PART.tick)]);
    const ok = /** @type {HTMLButtonElement} */ (find(dialog, PART.ok));
    const search = field(dialog, PART.search);
    const ticked = () => ticks.filter(b => b.checked).map(b => /** @type {string} */ (b.dataset.tmId));
    /** The rows the search shows: Select all ticks only these. */
    const shown = () => ticks.filter(b => !(/** @type {HTMLElement} */ (b.parentElement)).hidden);
    const sync = () => {
      const n = ticked().length;
      const shownTicked = shown().filter(b => b.checked).length;
      all.checked = shownTicked > 0 && shownTicked === shown().length;
      all.indeterminate = shownTicked > 0 && !all.checked;
      ok.textContent = removeLabel(n);
      ok.disabled = !n;
    };
    search.addEventListener('input', () => {
      const words = search.value.trim().toLowerCase();
      for (const b of ticks) {
        const label = /** @type {HTMLElement} */ (b.parentElement);
        label.hidden = !(label.dataset.tmName ?? '').includes(words);
      }
      find(dialog, PART.none).hidden = shown().length > 0;
      sync();
    });
    dialog.addEventListener('change', e => {
      if (targetOf(e) === all) for (const b of shown()) b.checked = all.checked;
      sync();
    });
    return {
      submit: () => {
        const ids = ticked();
        if (!ids.length) return;
        removeImported(ids);
        close(ids.length);
      },
    };
  });
}
