// @ts-check
// Windows notifications for agent news the user can't see (another workspace, or Termilly not in front), and
// the taskbar badge with the inbox count. The host shows them (Notifications.cs); clicking one comes back here as
// "focusTerminal". The same news goes to the phones too (Features/Phone.cs decides if the user is away).

import { send, onHost } from './host.js';
import { PAGE, HOST } from './protocol.js';
import { state, on, wsById, tabTitle, isInView, getSetting, EVENTS } from './store.js';
import { focusTab } from './panes.js';
import { entryDetail } from './inbox.js';
import { AGENT_STATE } from './constants.js';
import { windowInFront } from './windowshown.js';

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

/**
 * A task an agent finished waits for review: the phones hear it by the task's name, and a tap opens the task.
 * @param {TodoTask} task
 * @param {string} summary what the agent said
 * @param {Tab | null} tab the terminal it finished in
 */
export function alertReview(task, summary, tab) {
  if (!getSetting('notifications.done')) return;
  if (tab) tab.taskAlerted = true;
  send(PAGE.phoneAlert, { id: task.id, state: AGENT_STATE.done, title: `Waiting for review: ${task.text}`, body: summary, inFront: windowInFront() });
}

on(EVENTS.agent, tab => {
  const agent = tab.agent;
  const kind = agent && KINDS[agent.state];
  if (!kind) {
    withdraw(tab); // answered, working again, or gone: an old toast would only mislead
    // Nor does an alert held for the phone until the user leaves the PC go now.
    if (tab.phoneAlerted) {
      tab.phoneAlerted = null;
      send(PAGE.phoneWithdraw, { id: tab.id });
    }
    return;
  }
  const [setting, what] = kind;
  if (!getSetting(setting)) return;
  const key = `${agent.state}@${agent.at}`;
  const ws = wsById(tab.wsId);
  const title = `${what}: ${tabTitle(tab)}${ws ? ` · ${ws.name}` : ''}`;
  // The phone, even when the terminal is in view here: the PC may be showing it to nobody (the host checks).
  if (tab.phoneAlerted !== key) {
    tab.phoneAlerted = key;
    // The task it finished said so already, by name.
    const said = agent.state === AGENT_STATE.done && tab.taskAlerted;
    tab.taskAlerted = false;
    if (!said) send(PAGE.phoneAlert, { id: tab.id, state: agent.state, title, body: entryDetail(tab), inFront: windowInFront() });
  }
  if (isInView(tab) || tab.notified === key) return;
  tab.notified = key;
  send(PAGE.notify, { id: tab.id, title, body: entryDetail(tab) });
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


