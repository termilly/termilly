// @ts-check
// The notification center's Preview (js/inboxpanel.js): why a terminal needs the user, in the Compact view's preview
// dialog (js/compactpreview.js). The question its agent waits on as Compact reads it (the whole command, the diff, the
// plan, with its choices to pick), else what its screen shows now.

import { runningAgent, tabTitle } from './store.js';
import { menuOf, pick } from './compact.js';
import { menuKey } from './compactcard.js';
import { showPreview } from './compactpreview.js';
import { screenRows } from './compactdrawer.js';
import { agentKind } from './agentkinds.js';
import { AGENT_STATE } from './constants.js';

/**
 * What the terminal's screen shows, without the blank rows around it; else what the note said.
 * @param {Tab} tab
 * @param {string} detail
 */
function screenText(tab, detail) {
  const rows = tab.view?.term ? screenRows(tab.view.term) : [];
  const first = rows.findIndex(row => row.trim());
  return first < 0 ? [detail] : rows.slice(first, rows.findLastIndex(row => row.trim()) + 1);
}

/**
 * Shows why the terminal needs the user. A choice picked in the preview is pressed only while the agent still waits
 * on that very question (pick checks it again).
 * @param {Tab} tab
 * @param {string} detail what its note says, when the screen has nothing to show
 */
export function previewWaiting(tab, detail) {
  const asked = tab.agent?.state === AGENT_STATE.needsInput ? menuOf(tab) : null;
  /** @type {import('./compactcard.js').Menu} */
  const menu = asked ?? { title: detail, context: [], choices: [], whole: null, prompt: screenText(tab, detail) };
  const agent = runningAgent(tab);
  const shown = menuKey(menu);
  // Only for the very report it was opened on: a newer question can look the same, and pick can't tell them apart.
  const report = tab.agent;
  showPreview(menu, agent ? agentKind(agent).short : tabTitle(tab), key => {
    if (tab.agent === report) pick(tab, key, shown);
  });
}
