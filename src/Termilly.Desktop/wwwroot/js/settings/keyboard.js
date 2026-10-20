// @ts-check
// Settings › Keyboard: every shortcut, by what it's for.

import { ICONS, keysHtml } from '../ui.js';
import { group } from './controls.js';
import { SECTION } from './page.js';

/**
 * [heading, [what it does, its keys]].
 * @type {Array<[string, Array<[string, string]>]>}
 */
const SHORTCUTS = [
  ['Terminals', [
    ['New terminal', 'Ctrl Shift T'],
    ['New terminal with shell 1–9', 'Ctrl Shift 1–9'],
    ['Close terminal', 'Ctrl Shift W'],
    ['Rename terminal', 'Ctrl Shift R'],
    ['Split right', 'Alt Shift ='],
    ['Split down', 'Alt Shift -'],
    ['Move focus between panes', 'Alt ←↑→↓'],
    ['Broadcast input to the workspace (on / off)', 'Ctrl Shift I'],
  ]],
  ['Workspaces', [
    ['New workspace', 'Ctrl Shift N'],
    ['Switch to workspace 1–9', 'Ctrl Alt 1–9'],
    ['Next / previous workspace', 'Ctrl Tab / Ctrl Shift Tab'],
    ['Show or hide the sidebar', 'Ctrl Shift B'],
  ]],
  ['Agents', [
    ['Next terminal that needs you', 'Ctrl Shift J'],
    ['Open the notification center', 'Ctrl Shift A'],
    ['Next terminal that needs you, from any app (turn on in Terminal)', 'Ctrl Alt J'],
    ['Show the last file Claude changed here (turn on in Change preview)', 'Ctrl Shift D'],
  ]],
  ['App', [
    ['Search terminals, history and output', 'Ctrl Shift F'],
    ['Command history (failed, in:folder)', 'Ctrl Shift H'],
    ['Previous / next prompt', 'Ctrl Shift ↑ / Ctrl Shift ↓'],
    ['Hints: open a link, copy a path or hash (Shift: copy link, show path)', 'Ctrl Shift E'],
    ['Floating scratch terminal', 'Ctrl Shift `'],
    ['SFTP files of an SSH terminal', 'Ctrl Shift L'],
    ['Ask AI about the terminal', 'Ctrl Shift K'],
    ['Go to a workspace, folder, closed terminal or SSH host', 'Ctrl Shift O'],
    ['Settings', 'Ctrl ,'],
    ['Bigger / smaller text', 'Ctrl + / Ctrl -'],
    ['Reset text size', 'Ctrl 0'],
    ['Zoom text with the mouse', 'Ctrl Wheel'],
  ]],
];

/** @type {import('./page.js').Section} */
const KEYBOARD = {
  id: SECTION.keyboard,
  label: 'Keyboard', icon: ICONS.keyboard,
  html: () => SHORTCUTS.map(([heading, items]) => group(heading,
    items.map(([label, keys]) => `<div class="key-row"><span>${label}</span><span class="keys">${keysHtml(keys)}</span></div>`).join(''))).join(''),
};

export default KEYBOARD;
