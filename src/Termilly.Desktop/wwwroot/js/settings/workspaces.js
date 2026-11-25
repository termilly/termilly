// @ts-check
// Settings › Workspaces: background shells, what comes back at start, what Minimize and Close do, and
// project status.

import { PAGE } from '../protocol.js';
import { send, request, sys, SYSTEM_NAME } from '../host.js';
import { state, getSetting, tabTitle } from '../store.js';
import { targetOf } from '../dom.js';
import { ICONS } from '../ui.js';
import { confirmDialog } from '../dialogs.js';
import { setSetting } from '../preferences.js';
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
 * Asks before the background shells end, naming them (nothing to ask when there are none), then ends them and the
 * background process. False when the user kept them, or it's already being asked.
 * @param {string} title
 */
async function stopShells(title) {
  if (asking) return false;
  asking = true;
  try {
    const items = await backgroundShells();
    if (items.length && !(await confirmDialog({ title, body: 'These terminals end now, with whatever runs in them.', confirm: 'Stop them', items }))) return false;
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
        toggle('interface.confirmQuit')))
    + group('Project status', row('Listening ports', 'Ports a terminal’s programs listen on; click one to open it.', toggle('terminal.ports'), { keywords: 'port server localhost dev listening url' })),
  // Turning background shells off ends the ones running (after asking) and the background process; kept, it stays on.
  click(e) {
    if (!targetOf(e).closest(`.switch[data-setting="${BACKGROUND_SHELLS}"]`) || !getSetting(BACKGROUND_SHELLS)) return false;
    stopShells('Turn off background shells?').then(stopped => { if (stopped) setSetting(BACKGROUND_SHELLS, false); });
    return true;
  },
  actions: {
    stopHost: () => stopShells('Stop background shells?'),
  },
};

export default WORKSPACES;
