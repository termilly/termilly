// @ts-check
// Settings › Appearance › Layout: Normal or Minimal, terminal names in Minimal, and on Linux the windowing system.

import { sys, SYSTEM_NAME } from '../host.js';
import { ICONS } from '../ui.js';
import { row, seg, toggle, group } from './controls.js';
import { SECTION } from './page.js';
import { SETTING_VALUES } from '../constants.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { layout, paneNames } = SETTING_VALUES;

/** Linux, not macOS (the same build, and the same page's 'linux'). */
const onLinux = sys.name === SYSTEM_NAME.linux && !/Mac/.test(navigator.platform);

/** @type {import('./page.js').Section} */
const LAYOUT = {
  id: SECTION.appearanceLayout,
  label: 'Layout', tab: 'Layout', parent: SECTION.appearance, icon: ICONS.appearance,
  html: () => group('Layout',
    row('Layout', 'Minimal: a thin strip and a floating dock, and the terminals take the rest. Right-click the dock to move or hide it.',
      seg('interface.layout', [[layout.normal, 'Normal'], [layout.minimal, 'Minimal']]), { keywords: 'minimal compact clean dock sidebar title bar toolbar' })
    + row('Terminal names', 'In Minimal: on a line over each terminal, or on a bar when the mouse is near its top. Right-click either to pick what it shows.',
      seg('interface.paneNames', [[paneNames.line, 'Line'], [paneNames.hover, 'On hover']]), { keywords: 'header name bar hover line minimal' }))
    // Linux only (not macOS, which runs the same build): Wayland lets no app place its windows.
    + (onLinux ? group('Windows',
      row('Windowing system', 'On (X11): windows open where dropped, softer text when scaled. Off (Wayland): sharp text, the desktop places windows.',
        toggle('interface.runAsX11'), { keywords: 'x11 xwayland wayland window place drop detach position' })) : ''),
};

export default LAYOUT;
