// @ts-check
// Closing a workspace as the user asks for it (the sidebar's workspace menu, the Minimal view's workspace list): asked
// first when it has terminals, with the choice to erase its history too.

import { state, tabsOf } from './store.js';
import { closeWorkspace } from './workspaces.js';
import { confirmWithOption } from './dialogs.js';
import { removeHistory, HISTORY_KIND } from './historysize.js';

/** The menu item's label. */
export const CLOSE_WORKSPACE_LABEL = 'Close workspace';

/** How long after a workspace closes its history is erased: its terminals' last output is written as they close. */
const ERASE_AFTER_MS = 1500;

/**
 * Closes a workspace once the user agrees: its terminals go to Recently closed, or with its history erased too.
 * @param {Workspace} ws
 */
export async function askCloseWorkspace(ws) {
  const n = tabsOf(ws).length;
  // Asked: whether its history goes too (its terminals, their output and commands), else they're in Recently closed.
  const erase = n && state.settings.interface.confirmCloseWorkspace ? await confirmWithOption({
    title: `Close “${ws.name}”?`,
    body: `Its ${n} terminal${n === 1 ? '' : 's'} will be closed. You can reopen them from Recently closed.${state.workspaces.length === 1 ? ' This is your last workspace.' : ''}`,
    confirm: CLOSE_WORKSPACE_LABEL,
    option: 'Also erase its history: these terminals, their output and their commands',
  }) : false;
  if (erase === null) return;
  closeWorkspace(ws);
  if (erase) eraseWorkspaceHistory(ws.name);
}

/**
 * A closed workspace's history goes: its closed terminals with their output, and the commands run in them.
 * @param {string} name
 */
function eraseWorkspaceHistory(name) {
  setTimeout(() => {
    removeHistory({ kinds: [HISTORY_KIND.closed, HISTORY_KIND.commands], workspaces: [name] }, false).catch(() => {});
  }, ERASE_AFTER_MS);
}
