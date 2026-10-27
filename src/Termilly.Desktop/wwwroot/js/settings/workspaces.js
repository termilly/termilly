// @ts-check
// Settings › Workspaces: background shells, what comes back at start, what Minimize and Close do, and
// project status.

import { PAGE } from '../protocol.js';
import { send, sys, SYSTEM_NAME } from '../host.js';
import { ICONS } from '../ui.js';
import { confirmDialog } from '../dialogs.js';
import { row, seg, toggle, group } from './controls.js';
import { SECTION } from './page.js';
import { SETTING_VALUES } from '../constants.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { restoreSession, minimizeTo, closeAction } = SETTING_VALUES;

/** @type {import('./page.js').Section} */
const WORKSPACES = {
  id: SECTION.workspaces,
  label: 'Workspaces', icon: ICONS.workspaces,
  html: () => group('', row('Keep shells running when Termilly closes', 'Shells keep running when the window closes or updates.',
      toggle('session.backgroundShells'))
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
    + group('Project status', row('Git branch', 'Each folder’s branch and uncommitted changes, on its row.',
        toggle('interface.gitStatus'), { keywords: 'git branch dirty changes ahead behind upstream repository worktree' })
      + row('Listening ports', 'Ports a terminal’s programs listen on; click one to open it.', toggle('terminal.ports'), { keywords: 'port server localhost dev listening url' })),
  actions: {
    stopHost: async () => {
      if (await confirmDialog({ title: 'Stop background shells?', body: 'Every terminal the background process runs ends now, with whatever runs in it.', confirm: 'Stop them' })) {
        send(PAGE.hostShutdown);
      }
    },
  },
};

export default WORKSPACES;
