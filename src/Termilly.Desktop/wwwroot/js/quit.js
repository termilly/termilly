// @ts-check
// Quitting while something still runs (QuitGate.cs): whenever the user quits, the host asks (quit:ask) and this
// answers. A running command, or an agent at work or waiting for you, stops when Termilly quits, unless the background
// process keeps the shells. So then, as Settings › Workspaces allow, it asks first. The question counts down and quits
// by itself if nobody answers (closing for the night shouldn't hang on it).

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, tabTitle, saveNow } from './store.js';
import { modal, CONFIRM_DIALOG } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { AGENT_STATE, QUIT_ANSWER } from './constants.js';

/** An agent in these states still has work it would lose. @type {Set<string>} */
const AGENT_BUSY = new Set([AGENT_STATE.working, AGENT_STATE.needsInput]);
/** How many busy terminals the question names before "and N more". */
const NAMED = 3;
/** The question quits by itself after this many seconds, counted down on its Quit button. */
const QUIT_SECONDS = 30;
const SECOND_MS = 1000;

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

/**
 * Asks whether to quit, counting down on the Quit button; true when the user quits or the count runs out.
 * @param {string[]} busy
 */
function askToQuit(busy) {
  let timer = 0;
  return modal(CONFIRM_DIALOG, `
    <h3>Quit Termilly?</h3>
    <p class="dialog-sub">${escapeHtml(question(busy))}</p>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn danger" data-ok autofocus>Quit (<span data-quit-count>${QUIT_SECONDS}</span>)</button>
    </div>`, (dialog, close) => {
    let left = QUIT_SECONDS;
    const count = /** @type {HTMLElement} */ (dialog.querySelector('[data-quit-count]'));
    timer = window.setInterval(() => {
      left -= 1;
      count.textContent = String(left);
      if (left <= 0) close(true);
    }, SECOND_MS);
    return { submit: () => close(true) };
  }).then(result => {
    clearInterval(timer);
    return result === true;
  });
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
  const quit = await askToQuit(busy);
  answer(quit ? QUIT_ANSWER.quit : QUIT_ANSWER.stay);
});
