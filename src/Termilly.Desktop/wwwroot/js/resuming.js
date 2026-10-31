// @ts-check
// A Claude Code session coming back after a restart (snapshot.js types `claude --resume <session>` at the shell's
// first prompt): until it reports in, an overlay covers the terminal with a spinner, what's typed is held (typed into
// the shell around the command, it spoiled it), and phones don't open it (js/phone.js). If the shell is still at its
// prompt a while after the command went (a size change or a key took it), the command goes once more. Esc, and only
// Esc, cancels: the command isn't typed (or typed again), and the terminal is the user's.

import { send } from './host.js';
import { PAGE } from './protocol.js';
import { on, emit, EVENTS } from './store.js';
import { atPrompt } from './buffer.js';

/** Typed this long ago and still at a prompt: once more. */
const RETRY_AFTER_MS = 15_000;
/** The overlay on the terminal. */
const OVERLAY_CLASS = 'resume-overlay';
/** The key that cancels, as the terminal sends it. */
export const CANCEL_KEY = '\x1b';

/**
 * A terminal's Claude Code session is resuming (snapshot.js): from now until it reports in, or Esc.
 * @param {Tab} tab
 * @param {string} session
 */
export function startResuming(tab, session) {
  tab.resuming = { session, command: null, retried: false, timer: 0 };
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
 * Esc while it resumes: the resume is called off (a command still waiting for the prompt isn't typed).
 * @param {Tab} tab
 */
export function cancelResume(tab) {
  if (tab.start) {
    tab.start.command = null;
    tab.start.resumeSession = null;
  }
  done(tab);
}

/**
 * Resuming is over: Claude reported in, or Esc.
 * @param {Tab} tab
 */
function done(tab) {
  if (!tab.resuming) return;
  clearTimeout(tab.resuming.timer);
  tab.resuming = null;
  tab.view?.body.querySelector(`.${OVERLAY_CLASS}`)?.remove();
  emit(EVENTS.tab, tab);
}

/** @param {Tab} tab */
function drawOverlay(tab) {
  const body = tab.view?.body;
  if (!body || !tab.resuming || body.querySelector(`.${OVERLAY_CLASS}`)) return;
  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.innerHTML = '<span class="resume-spinner"></span><span class="resume-text">Resuming the Claude session</span><span class="resume-hint">Press ESC to cancel session resume</span>';
  // A click keeps the keyboard with the terminal, where Esc is heard.
  overlay.addEventListener('mousedown', e => {
    e.preventDefault();
    tab.view?.term?.focus();
  });
  body.append(overlay);
}

// Its view is made after the snapshot is read: the overlay goes on once it's there.
on(EVENTS.terminalOpened, drawOverlay);
// Claude reported in (its SessionStart): resumed.
on(EVENTS.agent, tab => { if (tab.resuming && tab.agent) done(tab); });
