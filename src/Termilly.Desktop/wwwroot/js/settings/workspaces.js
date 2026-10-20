// @ts-check
// Settings › Workspaces: the sidebar, background shells, what comes back at start, project status and the drop-down
// window.

import { PAGE } from '../protocol.js';
import { send, sys, SYSTEM_NAME } from '../host.js';
import { state } from '../store.js';
import { escapeHtml, ICONS, keysHtml } from '../ui.js';
import { confirmDialog } from '../dialogs.js';
import { setClosedStyle, resetSidebarWidth } from '../sidebar.js';
import { row, seg, toggle, group, choices } from './controls.js';
import { SECTION, body, takenChords } from './page.js';
import { SETTING_VALUES } from '../constants.js';
import { targetOf } from '../dom.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { restoreSession, quake, quakeWorkspace } = SETTING_VALUES;

/** The drop-down window's height that fills the screen, in percent. */
const FULL_HEIGHT = 100;

/**
 * The closed sidebar's choice, which is the sidebar's own state rather than a setting.
 * @param {HTMLElement} root
 */
function syncSidebarStyle(root) {
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-sidebar-style] [data-value]'))) b.classList.toggle('on', b.dataset.value === state.sidebar.closedStyle);
}

/** @type {import('./page.js').Section} */
const WORKSPACES = {
  id: SECTION.workspaces,
  label: 'Workspaces', icon: ICONS.workspaces,
  html: () => group('', row('Closed sidebar shows', `Toggle the sidebar with ${keysHtml('Ctrl Shift B')}.`, `
      <span class="seg" data-sidebar-style><button data-value="rail">Icon rail</button><button data-value="hidden">Nothing</button></span>`)
    + row('Sidebar width', 'Drag the edge next to the sidebar to resize it.', '<button class="btn small" data-action="resetWidth">Reset width</button>')
    + row('Keep shells running when Termilly closes', 'A background process (termilly-host) runs the terminals, so closing, crashing or updating the window doesn’t end them: the next window picks them up where they were. Takes effect when Termilly next starts.',
      toggle('session.backgroundShells'))
    + row('Start it when you sign in', `Starts the background process when you sign in to ${sys.name}, so shells opened earlier are there.`, toggle('session.backgroundAtSignIn'))
    + row('Background shells', 'Ends every shell the background process keeps, and the process itself.', '<button class="btn small danger-outline" data-action="stopHost">Stop background shells</button>')
    + row('When Termilly starts', 'Bring back the terminals in the folders they were in, with their last output (encrypted, saved every half minute and on exit). A Claude Code session that was running picks up again by itself. Or only the layout, or a fresh workspace.',
      seg('session.restore', [[restoreSession.scrollback, 'Terminals and output'], [restoreSession.layout, 'Layout only'], [restoreSession.off, 'Fresh']]))
    + row('Confirm before closing a workspace', 'Only asked when the workspace still has terminals.', toggle('interface.confirmCloseWorkspace')))
    + group('Project status', row('Git branch', 'The branch of each workspace’s folder on its row, a dot when there are uncommitted changes, and ↑↓ against its upstream; on a terminal’s row when it works in another repository or worktree. Read with git every few seconds at most, only for what’s on screen, never for network shares.',
        toggle('interface.gitStatus'), { keywords: 'git branch dirty changes ahead behind upstream repository worktree' })
      + row('Listening ports', 'The ports a terminal’s programs listen on (:3000) on its row; click one to open it in the browser.', toggle('terminal.ports'), { keywords: 'port server localhost dev listening url' }))
    // Not on Linux yet (Termilly.Linux/README.md).
    + (sys.name === SYSTEM_NAME.linux ? '' : group('Drop-down window', row('Drop-down from the top', 'A shortcut that works in any app slides Termilly down from the top of the screen the mouse is on, and away again.', toggle('quake.enabled'))
      + row('Shortcut', takenChords.has(state.settings.quake.chord)
        ? `<span class="warn">Another app already uses ${escapeHtml(state.settings.quake.chord)}. Pick another one.</span>`
        : 'Windows Terminal uses Win ` too; if it’s installed, pick another.',
        seg('quake.chord', choices(quake.chords, chord => chord.replaceAll('+', ' '))))
      + row('Height', 'Of the screen.', seg('quake.height', choices(quake.heights, height => (height === FULL_HEIGHT ? 'Full' : `${height}%`))))
      + row('Hide when it loses focus', '', toggle('quake.autoHide'))
      + row('Shows', '', seg('quake.workspace', [[quakeWorkspace.last, 'The last workspace'], [quakeWorkspace.quake, 'A “Drop-down” workspace']]))
      + row('Back to a normal window', '', '<button class="btn small" data-action="leaveQuake">Leave drop-down</button>'))),
  sync: syncSidebarStyle,
  actions: {
    stopHost: async () => {
      if (await confirmDialog({ title: 'Stop background shells?', body: 'Every terminal the background process runs ends now, with whatever runs in it.', confirm: 'Stop them' })) {
        send(PAGE.hostShutdown);
      }
    },
    resetWidth: resetSidebarWidth,
    leaveQuake: () => send(PAGE.quakeLeave),
  },
  click(e) {
    const sidebarStyle = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-sidebar-style] [data-value]'));
    if (!sidebarStyle) return false;
    setClosedStyle(/** @type {string} */ (sidebarStyle.dataset.value));
    syncSidebarStyle(body);
    return true;
  },
};

export default WORKSPACES;
