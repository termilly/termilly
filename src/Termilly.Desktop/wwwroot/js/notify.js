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
 * How a task's news starts, by agent state.
 * @type {Readonly<Record<string, string>>}
 */
const TASK_NEWS = Object.freeze({
  [AGENT_STATE.done]: 'Waiting for review', [AGENT_STATE.needsInput]: 'Needs you', [AGENT_STATE.error]: 'Didn’t finish',
});

/**
 * News of a task: it waits for review, it needs the user, or its Silent run failed. The phones hear it by the task's name,
 * and a tap opens the task. With To do's Always notify on it always goes, also as a desktop notification, and to the
 * phones even while the user is at the PC; else as the agent's notification settings say.
 * @param {TodoTask} task
 * @param {string} kind one of AGENT_STATE: done, needsInput or error
 * @param {string} body
 * @param {Tab | null} [tab] the terminal its agent works in
 */
export function alertTask(task, kind, body, tab = null) {
  const always = !!state.todo.alwaysNotify;
  if (!always && !getSetting(KINDS[kind][0])) return;
  if (tab && kind === AGENT_STATE.done) tab.taskAlerted = true;
  const title = `${TASK_NEWS[kind]}: ${task.text}`;
  send(PAGE.phoneAlert, { id: task.id, state: kind, title, body, inFront: !always && windowInFront() });
  // In a terminal, it takes the place of that terminal's own notification, and a click goes there.
  if (always) send(PAGE.notify, { id: tab?.id ?? task.id, title, body });
}

/**
 * A task's news is old: the phones' alert and the desktop notification go.
 * @param {TodoTask} task
 */
export function withdrawTask(task) {
  send(PAGE.phoneWithdraw, { id: task.id });
  send(PAGE.notifyWithdraw, { id: task.id });
}

/**
 * A task an agent finished waits for review.
 * @param {TodoTask} task
 * @param {string} summary what the agent said
 * @param {Tab | null} tab the terminal it finished in
 */
export const alertReview = (task, summary, tab) => alertTask(task, AGENT_STATE.done, summary, tab);

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


