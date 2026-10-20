// @ts-check
// Windows notifications for agent news the user can't see (another workspace, or Termilly not in front), and
// the taskbar badge with the inbox count. The host shows them (Notifications.cs); clicking one comes back here as
// "focusTerminal".

import { send, onHost } from './host.js';
import { PAGE, HOST } from './protocol.js';
import { state, on, wsById, tabTitle, isInView, getSetting, EVENTS } from './store.js';
import { focusTab } from './panes.js';
import { entryDetail } from './inbox.js';
import { AGENT_STATE } from './constants.js';

/**
 * Which setting allows a notification for each agent state, and how its title starts.
 * @type {Record<string, [string, string]>}
 */
const KINDS = {
  [AGENT_STATE.needsInput]: ['notifications.needsInput', 'Needs you'],
  [AGENT_STATE.attention]: ['notifications.needsInput', 'Wants your attention'],
  [AGENT_STATE.error]: ['notifications.error', 'Stopped with an error'],
  [AGENT_STATE.done]: ['notifications.done', 'Finished'],
};

on(EVENTS.agent, tab => {
  const agent = tab.agent;
  const kind = agent && KINDS[agent.state];
  if (!kind) {
    withdraw(tab); // answered, working again, or gone: an old toast would only mislead
    return;
  }
  const [setting, what] = kind;
  if (!getSetting(setting) || isInView(tab)) return;
  const key = `${agent.state}@${agent.at}`;
  if (tab.notified === key) return;
  tab.notified = key;
  const ws = wsById(tab.wsId);
  send(PAGE.notify, { id: tab.id, title: `${what}: ${tabTitle(tab)}${ws ? ` · ${ws.name}` : ''}`, body: entryDetail(tab) });
});

// Looking at the terminal (or typing in it) makes its toast old news.
on(EVENTS.seen, withdraw);

/** @param {Tab} tab */
function withdraw(tab) {
  if (!tab.notified) return;
  tab.notified = null;
  send(PAGE.notifyWithdraw, { id: tab.id });
}

onHost(HOST.focusTerminal, m => {
  const tab = state.tabs.get(m.id);
  if (tab) focusTab(tab);
});


