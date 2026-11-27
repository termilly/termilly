// @ts-check
// How menus that pick one of several mark the chosen one (Settings › Appearance › Layout): a tick, or a soft or solid
// accent background. The root element's data-menu-pick carries it to js/popups.js and css/menus.css; detached windows
// take the page's root attributes along.

import { state, on, EVENTS } from './store.js';
import { MENU_PICK_ATTRIBUTE } from './popups.js';
import { SETTING_VALUES } from './constants.js';

function apply() {
  document.documentElement.dataset[MENU_PICK_ATTRIBUTE] = state.settings.interface.menuPick ?? SETTING_VALUES.menuPick.default;
}

apply();
on(EVENTS.settings, apply);
