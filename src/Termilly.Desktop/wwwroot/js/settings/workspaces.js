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
 * Asks before something happens to the background shells, naming them (nothing to ask when there are none). False
 * when the user said no, or it's already being asked.
 * @param {{ title: string, body: string, confirm: string }} question
 */
async function askAboutShells(question) {
  if (asking) return false;
  asking = true;
  try {
    const items = await backgroundShells();
    return !items.length || await confirmDialog({ ...question, items });
  } finally {
    asking = false;
  }
}

/** Ends the background shells and the background process, after asking. */
async function stopShells() {
  if (!(await askAboutShells({ title: 'Stop background shells?', body: 'These terminals end now, with whatever runs in them.', confirm: 'Stop them' }))) return;
  send(PAGE.hostShutdown);
}

/**
 * Turns background shells off, after asking. The shells running stay until Termilly closes, which ends them with the
 * background process (BackgroundHost.Dispose); at the next start agents resume and the rest start new shells, as with
 * the setting off.
 */
async function turnOff() {
  const body = 'These terminals keep running until Termilly closes. When it starts again, agents resume their conversation and the others start a new shell.';
  if (!(await askAboutShells({ title: 'Turn off background shells?', body, confirm: 'Turn off' }))) return;
  setSetting(BACKGROUND_SHELLS, false);
  saveNow(); // quitting at once must find it off, or the shells would stay
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
  // Turning background shells off (after asking) leaves the ones running until Termilly closes; kept, it stays on.
  click(e) {
    if (!targetOf(e).closest(`.switch[data-setting="${BACKGROUND_SHELLS}"]`) || !getSetting(BACKGROUND_SHELLS)) return false;
    turnOff();
    return true;
  },
  actions: {
    stopHost: stopShells,
  },
};

export default WORKSPACES;
