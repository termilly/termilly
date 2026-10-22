// @ts-check
// The Settings page's sections, in the nav's order. SSH and Serial are drawn by their features'
// own modules; the others have a module each in this folder.

import { ICONS } from '../ui.js';
import { sshSectionHtml, handleSshClick, setSshRerender, refreshSshStatus } from '../ssh.js';
import { serialSectionHtml, handleSerialClick, handleSerialChange, setSerialRerender } from '../serial.js';
import { row, group } from './controls.js';
import { SECTION, redrawIfShowing } from './page.js';
import appearance from './appearance.js';
import terminal from './terminal.js';
import workspaces from './workspaces.js';
import changes from './changes.js';
import privacy from './privacy.js';
import plugins from './plugins.js';
import keyboard from './keyboard.js';
import about from './about.js';

/** @type {import('./page.js').Section} */
const ssh = {
  id: SECTION.ssh, label: 'SSH', icon: ICONS.ssh,
  html: () => sshSectionHtml(group, row),
  refresh: refreshSshStatus,
  click: handleSshClick,
};

/** @type {import('./page.js').Section} */
const serial = {
  id: SECTION.serial, label: 'Serial', icon: ICONS.serial,
  html: () => serialSectionHtml(group),
  click: handleSerialClick,
  change: handleSerialChange,
};

setSshRerender(() => redrawIfShowing(SECTION.ssh));
setSerialRerender(() => redrawIfShowing(SECTION.serial));

/** @type {Record<string, import('./page.js').Section>} by id, in the nav's order */
export const SECTIONS = Object.fromEntries(
  [appearance, terminal, ssh, serial, workspaces, changes, privacy, plugins, keyboard, about].map(s => [s.id, s]));
