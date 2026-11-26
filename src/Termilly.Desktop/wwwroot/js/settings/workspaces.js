// @ts-check
// Settings › Workspaces: background shells, what comes back at start, and what Minimize and Close do.

import { PAGE } from '../protocol.js';
import { send, request, sys, SYSTEM_NAME } from '../host.js';
import { state, getSetting, tabTitle } from '../store.js';
import { targetOf } from '../dom.js';
import { ICONS } from '../ui.js';
import { confirmDialog } from '../dialogs.js';
import { setSetting, saveNow } from '../preferences.js';
import { row, seg, toggle, group } from './controls.js';
import { SECTION } from './page.js';
import { SETTING_VALUES } from '../constants.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { restoreSession, minimizeTo, closeAction } = SETTING_VALUES;

/** Keep shells running when Termilly closes. */
const BACKGROUND_SHELLS = 'session.backgroundShells';

/**
 * The names of the terminals whose shells the background process runs; kept shells no terminal here took back are
 * counted at the end.
 * @returns {Promise<string[]>}
 */
async function backgroundShells() {
  const { ids } = await request(PAGE.hostShells);
  const tabs = /** @type {string[]} */ (ids).map(id => state.tabs.get(id)).filter(tab => !!tab);
  const others = ids.length - tabs.length;
  const names = tabs.map(tab => tabTitle(/** @type {Tab} */ (tab)));
  return others ? [...names, `${others} other ${others === 1 ? 'shell' : 'shells'}`] : names;
}

/** While stopping is being asked: a second click doesn't ask again. */
let asking = false;

/**
 * What stopping the background shells asks, and what's done before the background process ends.
 * @typedef {{ title: string, body: string, confirm: string, before?: () => void }} StopAsk
 */

/** "Stop background shells": the terminals end. */
const STOP = { title: 'Stop background shells?', body: 'These terminals end now, with whatever runs in them.', confirm: 'Stop them' };

/**
 * Turning background shells off: the terminals start again in this window (main.js), so the setting is off, and the
 * host told so, before the background process ends: their new shells then aren't the background process's again.
 * @type {StopAsk}
 */
const TURN_OFF = {
  title: 'Turn off background shells?',
  body: 'These terminals start again in this window. Agents carry on with their conversation; anything else running in them stops.',
  confirm: 'Turn off',
  before: () => {
    setSetting(BACKGROUND_SHELLS, false);
    saveNow();
  },
};

/**
 * Asks before the background shells end, naming them (nothing to ask when there are none), then ends them and the
 * background process. False when the user kept them, or it's already being asked.
 * @param {StopAsk} ask
 */
async function stopShells(ask) {
  if (asking) return false;
  asking = true;
  try {
    const items = await backgroundShells();
    if (items.length && !(await confirmDialog({ title: ask.title, body: ask.body, confirm: ask.confirm, items }))) return false;
    ask.before?.();
    send(PAGE.hostShutdown);
    return true;
  } finally {
    asking = false;
  }
}

/** @type {import('./page.js').Section} */
const WORKSPACES = {
  id: SECTION.workspaces,
  label: 'Workspaces', icon: ICONS.workspaces,
  html: () => group('', row('Keep shells running when Termilly closes', 'Shells keep running when the window closes or updates.',
      toggle(BACKGROUND_SHELLS))
    + row('Start it when you sign in', `Start the background process when you sign in to ${sys.name}.`, toggle('session.backgroundAtSignIn'))
    + row('Background shells', 'End every kept shell, and the background process.', '<button class="btn small danger-outline" data-action="stopHost">Stop background shells</button>')
    + row('When Termilly starts', 'Terminals with their output, only the layout, or nothing.',
      seg('session.restore', [[restoreSession.scrollback, 'Terminals and output'], [restoreSession.layout, 'Layout only'], [restoreSession.off, 'Fresh']]))
    + row('Confirm before closing a workspace', 'Only asked when the workspace still has terminals.', toggle('interface.confirmCloseWorkspace')))
    + group('Minimize and Close',
      // No tray on Linux: GNOME has none without an extension.
      (sys.name === SYSTEM_NAME.linux ? '' : row('Minimize', 'The tray keeps Termilly off the taskbar.',
        seg('interface.minimizeTo', [[minimizeTo.taskbar, 'Taskbar'], [minimizeTo.tray, 'Tray']]))
        + row('Close', 'Keep running in the tray; quit from its menu or the palette.',
          seg('interface.closeAction', [[closeAction.quit, 'Quit Termilly'], [closeAction.tray, 'Keep running in the tray']])))
      + row('Ask before quitting', 'When a command runs, or an agent works or waits for you.',
        toggle('interface.confirmQuit'))),
  // Turning background shells off (after asking) ends the background process, and its terminals start again in this
  // window; kept, it stays on.
  click(e) {
    if (!targetOf(e).closest(`.switch[data-setting="${BACKGROUND_SHELLS}"]`) || !getSetting(BACKGROUND_SHELLS)) return false;
    stopShells(TURN_OFF);
    return true;
  },
  actions: {
    stopHost: () => stopShells(STOP),
  },
};

export default WORKSPACES;
