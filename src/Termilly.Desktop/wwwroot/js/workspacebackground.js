// @ts-check
// A workspace's own background, from its right-click menu (js/sidebar.js): the window's (Settings › Appearance ›
// Background), none, a gradient or a picture. js/backgrounds.js shows the one on screen.

import { request } from './host.js';
import { PAGE } from './protocol.js';
import { emit, persist, EVENTS } from './store.js';
import { BACKGROUND } from './constants.js';
import { GRADIENTS } from './backgrounds.js';
import { ICONS } from './ui.js';
import { showToast, TOAST } from './toasts.js';

const { workspaceKind: KIND, gradient: GRADIENT } = BACKGROUND;

/** Each gradient's name in the menu. */
const GRADIENT_NAMES = Object.freeze({
  [GRADIENT.aurora]: 'Aurora', [GRADIENT.ember]: 'Ember', [GRADIENT.dusk]: 'Dusk',
  [GRADIENT.ocean]: 'Ocean', [GRADIENT.moss]: 'Moss', [GRADIENT.slate]: 'Slate',
});
const CURRENT = '<span class="menu-current">current</span>';

/**
 * Gives a workspace its own background, or the window's again (undefined).
 * @param {Workspace} ws
 * @param {WorkspaceBackground | undefined} background
 */
export function setWorkspaceBackground(ws, background) {
  ws.background = background;
  emit(EVENTS.workspaces);
  persist();
}

/** @param {Workspace} ws */
async function pickPicture(ws) {
  const reply = await request(PAGE.backgroundPick, {});
  if (reply.error) showToast({ text: reply.error, state: TOAST.failed });
  else if (reply.picture) setWorkspaceBackground(ws, { kind: KIND.picture, picture: reply.picture });
}

/**
 * The workspace menu's Background: the window's, none, each gradient and a picture, the one it has marked.
 * @param {Workspace} ws
 */
export function backgroundMenuItem(ws) {
  const own = ws.background;
  const kind = own?.kind ?? KIND.window;
  return {
    label: 'Background', icon: ICONS.picture,
    submenu: () => [
      { label: 'Same as the window', picked: kind === KIND.window, pickHint: CURRENT, action: () => setWorkspaceBackground(ws, undefined) },
      { label: 'None', picked: kind === KIND.none, pickHint: CURRENT, action: () => setWorkspaceBackground(ws, { kind: KIND.none }) },
      ...Object.entries(GRADIENT_NAMES).map(([gradient, label]) => ({
        label,
        icon: `<span class="ws-swatch" style="background:${GRADIENTS[gradient]}"></span>`,
        picked: kind === KIND.gradient && own?.gradient === gradient, pickHint: CURRENT,
        action: () => setWorkspaceBackground(ws, { kind: KIND.gradient, gradient }),
      })),
      { label: 'Picture', icon: ICONS.picture, picked: kind === KIND.picture, pickHint: CURRENT, action: () => pickPicture(ws) },
    ],
  };
}
