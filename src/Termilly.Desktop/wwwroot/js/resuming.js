// @ts-check
// An agent's session coming back after a restart (snapshot.js types `claude --resume <session>`, or `codex resume
// <session>`, at the shell's first prompt): until the agent runs (its program is there, or its hooks report in), an overlay covers the terminal with a spinner, what's typed is held (typed into
// the shell around the command, it spoiled it), and phones don't open it (js/phone.js). If the shell is still at its
// prompt a while after the command went (a size change or a key took it), the command goes once more. Esc, and only
// Esc, cancels: the command isn't typed (or typed again), and the terminal is the user's.

import { send } from './host.js';
import { PAGE } from './protocol.js';
import { on, emit, runningAgent, EVENTS } from './store.js';
import { agentKind } from './agentkinds.js';
import { atPrompt } from './buffer.js';

/** Typed this long ago and still at a prompt: once more. */
const RETRY_AFTER_MS = 15_000;
/** The overlay on the terminal. */
const OVERLAY_CLASS = 'resume-overlay';
/** The key that cancels, as the terminal sends it. */
export const CANCEL_KEY = '\x1b';

/**
 * A terminal's agent session is resuming (snapshot.js): from now until the agent runs, or Esc.
 * @param {Tab} tab
 * @param {string} session
 * @param {string} kind which agent (AGENT_KIND)
 */
export function startResuming(tab, session, kind) {
  tab.resuming = { session, kind, command: null, retried: false, timer: 0 };
  drawOverlay(tab);
}

/** @param {Tab | null | undefined} tab */
export const isResuming = tab => !!tab?.resuming;

/**
 * The resume command went to the shell: if the shell's still at its prompt a while later, it goes once more.
 * @param {Tab} tab
 * @param {string} command
 */
export function resumeTyped(tab, command) {
  const r = tab.resuming;
  if (!r) return;
  r.command = command;
  r.timer = window.setTimeout(() => {
    const term = tab.view?.term;
    if (tab.resuming !== r || r.retried || !term || tab.exited || !atPrompt(term)) return;
    r.retried = true;
    send(PAGE.input, { id: tab.id, data: `${command}\r` });
  }, RETRY_AFTER_MS);
}

/**
 * Esc while it resumes: the resume is called off (a command still waiting for the prompt isn't typed). One already
 * typed has resumed the session, which stays known for the next start where the shell start kept it (Codex, which
 * says which session it is only after a prompt; see terminals.js runPendingCommand).
 * @param {Tab} tab
 */
export function cancelResume(tab) {
  const typed = !!tab.resuming?.command;
  if (tab.start) {
    tab.start.command = null;
    if (!typed) tab.start.resumeSession = null;
  }
  done(tab);
}

/**
 * Resuming is over: the session is back (resumed), or Esc. A session that's back is at the terminal's end, where its
 * view goes; the restart put the view where it was before (terminals.js scrollRestored), above what the agent drew.
 * @param {Tab} tab
 * @param {boolean} [resumed]
 */
function done(tab, resumed = false) {
  settling.get(tab)?.();
  if (!tab.resuming) return;
  clearTimeout(tab.resuming.timer);
  tab.resuming = null;
  tab.view?.body.querySelector(`.${OVERLAY_CLASS}`)?.remove();
  if (resumed) {
    resumedTabs.add(tab);
    tab.view?.term?.scrollToBottom();
  }
  emit(EVENTS.tab, tab);
}

/** Terminals whose agent session came back after a restart (not called off with Esc). @type {WeakSet<Tab>} */
const resumedTabs = new WeakSet();

/**
 * Whether a terminal's agent session came back after a restart, so its view belongs at the end rather than where it
 * was.
 * @param {Tab} tab
 */
export const wasResumed = tab => resumedTabs.has(tab);

/** @param {Tab} tab */
function drawOverlay(tab) {
  const body = tab.view?.body;
  if (!body || !tab.resuming || body.querySelector(`.${OVERLAY_CLASS}`)) return;
  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.innerHTML = `<span class="resume-spinner"></span><span class="resume-text">${resumingText(tab)}</span><span class="resume-hint">Press ESC to cancel session resume</span>`;
  // A click keeps the keyboard with the terminal, where Esc is heard.
  overlay.addEventListener('mousedown', e => {
    e.preventDefault();
    tab.view?.term?.focus();
  });
  body.append(overlay);
}

// Its view is made after the snapshot is read: the overlay goes on once it's there.
on(EVENTS.terminalOpened, drawOverlay);
// The session is back. Claude Code's hooks report in once it has loaded it (SessionStart). Codex's first hook waits
// for a prompt, which the overlay holds back: once its program runs (the host sees it), the session is back when its
// screen goes quiet, the conversation drawn.
on(EVENTS.agent, tab => { if (tab.resuming && tab.agent) done(tab, true); });
on(EVENTS.tab, tab => {
  if (tab.resuming && !settling.has(tab) && runningAgent(tab) && !agentKind(tab.resuming.kind).hookAtStart) settle(tab);
});

/** How long an agent's screen stays still before its resumed session counts as drawn, and the longest wait for it. */
const QUIET_MS = 1000;
const MAX_SETTLE_MS = 20_000;
/** Terminals waiting for their agent's screen to go quiet, and what stops the waiting. @type {WeakMap<Tab, () => void>} */
const settling = new WeakMap();

/**
 * Ends the resume once the agent's screen has been still for a moment (or after MAX_SETTLE_MS).
 * @param {Tab} tab
 */
function settle(tab) {
  const term = tab.view?.term;
  if (!term) {
    done(tab, true);
    return;
  }
  let quiet = 0;
  // Stops watching (Esc calls it through done too); the timers below then end the resume as resumed.
  const stop = () => {
    clearTimeout(quiet);
    clearTimeout(cap);
    writes.dispose();
    settling.delete(tab);
  };
  const back = () => {
    stop();
    done(tab, true);
  };
  const writes = term.onWriteParsed(() => {
    clearTimeout(quiet);
    quiet = window.setTimeout(back, QUIET_MS);
  });
  const cap = window.setTimeout(back, MAX_SETTLE_MS);
  quiet = window.setTimeout(back, QUIET_MS);
  settling.set(tab, stop);
}

/**
 * What a resuming terminal says, on the PC and the phone: Resuming the Codex session.
 * @param {Tab} tab
 */
export const resumingText = tab => `Resuming the ${agentKind(tab.resuming?.kind).short} session`;
