// @ts-check
// Settings › Appearance › Theme: the colour themes, Popular ones (well-known schemes) and Termilly's own, searching and
// filtering them, and following the system's light and dark mode with a theme picked for each. Appearance's other tabs
// are Text (appearancetext.js) and Layout (appearancelayout.js).

import { sys, SYSTEM_NAME } from '../host.js';
import { getSetting, GROUPS } from '../store.js';
import { THEMES, THEME_BASE, POPULAR_THEME_IDS, themeId } from '../themes.js';
import { cssColor, escapeHtml, ICONS } from '../ui.js';
import { updateSettings } from '../preferences.js';
import { row, group } from './controls.js';
import { SECTION, body } from './page.js';
import { SETTING_VALUES } from '../constants.js';
import { targetOf } from '../dom.js';

/** The theme setting's choices (C#'s SettingValues): a theme's id, or System. */
const { theme } = SETTING_VALUES;
const THEME_SETTING = 'interface.theme';
/** A theme's card in the gallery, and the class that dims the picks while the system isn't followed. */
const THEME_CARD = '.theme-card';
const PICKS_UNUSED = 'unused';
/** How long each line of "output" is in a theme card's small terminal, in percent. */
const INK_WIDTHS = [70, 45, 58];

/** Which themes the gallery shows: all, or only dark or light ones. */
const FILTER = Object.freeze({ all: 'all', dark: THEME_BASE.dark, light: THEME_BASE.light });
/** @type {string} */
let filter = FILTER.all;

const POPULAR = POPULAR_THEME_IDS.flatMap(id => THEMES.filter(t => t.id === id));
const OWN = THEMES.filter(t => !POPULAR_THEME_IDS.includes(t.id));
const GROUP_NAME = Object.freeze({ popular: 'Popular', own: 'Termilly’s own' });

/** What the system's light and dark mode is called here. */
const systemName = sys.name === SYSTEM_NAME.linux ? 'the desktop' : 'Windows';

/** @param {import('../themes.js').Theme['preview']} p a theme's small window, in its colours */
const mini = p => `<span class="tc-win" style="--p-bg:${cssColor(p.bg)};--p-side:${cssColor(p.side)};--p-line:${cssColor(p.line)};--p-text:${cssColor(p.text)};--p-accent:${cssColor(p.accent)};--p-term:${cssColor(p.term)}">
    <span class="tc-side"><i></i><i class="on"></i><i></i></span>
    <span class="tc-term">${p.ink.map((c, i) => `<i style="background:${cssColor(c)};width:${INK_WIDTHS[i]}%"></i>`).join('')}</span>
  </span>`;

/**
 * A theme's card: its small window, its name, and the well-known scheme it follows (searched by either name).
 * @param {import('../themes.js').Theme} t
 */
const card = t => `<button class="theme-card" data-theme-id="${t.id}" data-base="${t.base}" data-hay="${escapeHtml(`${t.name} ${t.like ?? ''}`.toLowerCase())}">${mini(t.preview)}<span class="tc-name">${escapeHtml(t.name)}</span>${t.like ? `<span class="tc-like">${escapeHtml(t.like)}</span>` : ''}</button>`;

/** @param {string} name @param {import('../themes.js').Theme[]} themes */
const gallery = (name, themes) => `<div class="theme-group"><h5 class="theme-group-head">${name}</h5><span class="seg theme-cards">${themes.map(card).join('')}</span></div>`;

/**
 * The theme following the system shows in one mode: dark or light themes, Popular first.
 * @param {string} key the setting
 * @param {string} base dark or light
 * @param {string} label
 */
const picker = (key, base, label) => {
  /** @param {import('../themes.js').Theme[]} list */
  const options = list => list.filter(t => t.base === base).map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  return `<label class="theme-pick"><span>${label}</span><select class="field" data-setting="${key}" aria-label="${label} theme">
    <optgroup label="${GROUP_NAME.popular}">${options(POPULAR)}</optgroup><optgroup label="${GROUP_NAME.own}">${options(OWN)}</optgroup></select></label>`;
};

const following = () => getSetting(THEME_SETTING) === theme.system;

/**
 * Shows the cards the search and the filter match, and each group only while it has some.
 * @param {HTMLElement} root
 */
function applyFilter(root) {
  const search = /** @type {HTMLInputElement | null} */ (root.querySelector('.theme-search'));
  const query = search?.value.trim().toLowerCase() ?? '';
  let any = false;
  for (const box of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.theme-group'))) {
    let shown = false;
    for (const c of /** @type {NodeListOf<HTMLElement>} */ (box.querySelectorAll(THEME_CARD))) {
      c.hidden = !(filter === FILTER.all || c.dataset.base === filter) || !(c.dataset.hay ?? '').includes(query);
      shown ||= !c.hidden;
    }
    box.hidden = !shown;
    any ||= shown;
  }
  const none = /** @type {HTMLElement | null} */ (root.querySelector('.theme-none'));
  if (none) none.hidden = any;
}

/**
 * The theme on screen marked, the filter's choice, and the follow switch with the picks it uses.
 * @param {HTMLElement} root
 */
function sync(root) {
  const shown = themeId();
  for (const c of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(THEME_CARD))) c.classList.toggle('on', c.dataset.themeId === shown);
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-theme-filter]'))) b.classList.toggle('on', b.dataset.themeFilter === filter);
  root.querySelector('[data-theme-follow]')?.setAttribute('aria-checked', String(following()));
  root.querySelector('.theme-follow')?.classList.toggle(PICKS_UNUSED, !following());
}

/** @type {import('./page.js').Section} */
const APPEARANCE = {
  id: SECTION.appearance,
  label: 'Appearance', tab: 'Theme', icon: ICONS.appearance,
  tabs: [SECTION.appearance, SECTION.appearanceText, SECTION.appearanceLayout],
  html: () => group('', row('Follow the system', `One theme while ${systemName} is in dark mode and another while it’s light.`,
    `<span class="theme-follow">${picker('interface.themeDark', THEME_BASE.dark, 'Dark')}${picker('interface.themeLight', THEME_BASE.light, 'Light')}
      <button class="switch" role="switch" data-theme-follow aria-label="Follow the system"><span></span></button></span>`,
    { keywords: 'system dark light mode automatic auto night day' }))
    + group('', row('Theme', 'Colours for the app and terminals.', `<div class="theme-tools">
        <input class="field theme-search" type="search" placeholder="Search themes" spellcheck="false" autocomplete="off" aria-label="Search themes">
        <span class="seg theme-filter">${Object.values(FILTER).map(f => `<button data-theme-filter="${f}">${f === FILTER.all ? 'All' : f === FILTER.dark ? 'Dark' : 'Light'}</button>`).join('')}</span>
      </div>${gallery(GROUP_NAME.popular, POPULAR)}${gallery(GROUP_NAME.own, OWN)}<p class="set-desc theme-none" hidden>No themes match.</p>`,
    { stack: true, keywords: `colour color look palette scheme ${THEMES.map(t => `${t.name} ${t.like ?? ''}`).join(' ').toLowerCase()}` })),
  drawn: root => { applyFilter(root); sync(root); },
  sync,
  click(e) {
    const picked = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-theme-id]'));
    if (picked) {
      updateSettings(GROUPS.interface, { theme: picked.dataset.themeId });
      return true;
    }
    if (targetOf(e).closest('[data-theme-follow]')) {
      // Off keeps what's on screen: the pick the system's mode shows now.
      updateSettings(GROUPS.interface, { theme: following() ? themeId() : theme.system });
      return true;
    }
    const kind = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-theme-filter]'));
    if (!kind) return false;
    filter = /** @type {string} */ (kind.dataset.themeFilter);
    applyFilter(body);
    sync(body);
    return true;
  },
  input(e) {
    if (targetOf(e).classList.contains('theme-search')) applyFilter(body);
  },
};

export default APPEARANCE;
