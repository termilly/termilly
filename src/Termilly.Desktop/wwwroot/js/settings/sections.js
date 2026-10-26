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
import notifications from './notifications.js';
import workspaces from './workspaces.js';
import actions from './actions.js';
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

/**
 * The part of the docs (termilly.com/docs/#id) each section's help button opens.
 * @type {Readonly<Record<string, string>>}
 */
const DOCS = Object.freeze({
  [SECTION.appearance]: 'themes', [SECTION.terminal]: 'terminals', [SECTION.notifications]: 'notifications', [SECTION.ssh]: 'ssh', [SECTION.serial]: 'serial',
  [SECTION.workspaces]: 'workspaces', [SECTION.actions]: 'actions', [SECTION.changes]: 'changes', [SECTION.privacy]: 'encryption',
  [SECTION.plugins]: 'plugins', [SECTION.keyboard]: 'shortcuts', [SECTION.about]: 'updates',
});

/** @type {Record<string, import('./page.js').Section>} by id, in the nav's order */
export const SECTIONS = Object.fromEntries(
  [appearance, terminal, notifications, ssh, serial, workspaces, actions, changes, privacy, plugins, keyboard, about].map(s => [s.id, { ...s, docs: DOCS[s.id] }]));
