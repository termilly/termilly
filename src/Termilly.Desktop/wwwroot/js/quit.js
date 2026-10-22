// @ts-check
// Quitting while something still runs (QuitGate.cs): whenever the user quits, the host asks (quit:ask) and this
// answers. A running command, or an agent at work or waiting for you, stops when Termilly quits, unless the background
// process keeps the shells. So then, as Settings › Workspaces allow, it asks first.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, tabTitle, saveNow } from './store.js';
import { confirmDialog } from './dialogs.js';
import { AGENT_STATE, QUIT_ANSWER } from './constants.js';

/** An agent in these states still has work it would lose. @type {Set<string>} */
const AGENT_BUSY = new Set([AGENT_STATE.working, AGENT_STATE.needsInput]);
/** How many busy terminals the question names before "and N more". */
const NAMED = 3;

/** The terminals quitting would stop, each with what runs in it. */
function busyTerminals() {
  return [...state.tabs.values()]
    .filter(tab => !tab.virtual && (tab.busy || AGENT_BUSY.has(tab.agent?.state ?? '')))
    .map(tab => `${tabTitle(tab)} (${tab.busy || 'Claude Code'})`);
}

/** @param {string[]} busy */
function question(busy) {
  const named = busy.slice(0, NAMED).join(', ') + (busy.length > NAMED ? ` and ${busy.length - NAMED} more` : '');
  return `${busy.length === 1 ? 'A terminal is' : `${busy.length} terminals are`} still running: ${named}. Quitting stops ${busy.length === 1 ? 'it' : 'them'}.`;
}

/** @param {string} answer */
function answer(answer) {
  if (answer === QUIT_ANSWER.quit) saveNow(); // don't lose a change made in the last moments
  send(PAGE.quitAnswer, { answer });
}

onHost(HOST.quitAsk, async () => {
  const busy = busyTerminals();
  if (!state.settings.interface.confirmQuit || state.settings.session.backgroundShells || !busy.length) {
    answer(QUIT_ANSWER.quit);
    return;
  }
  answer(QUIT_ANSWER.asking);
  const quit = await confirmDialog({ title: 'Quit Termilly?', body: question(busy), confirm: 'Quit' });
  answer(quit ? QUIT_ANSWER.quit : QUIT_ANSWER.stay);
});
