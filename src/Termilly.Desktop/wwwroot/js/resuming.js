// @ts-check
// A Claude Code session coming back after a restart (snapshot.js types `claude --resume <session>` at the shell's
// first prompt): until it reports in, the terminal says so with a spinner, holds what's typed (typed into the shell
// around the command, it spoiled it), and phones don't open it (js/phone.js). If the shell is still at its prompt a
// while after the command went (a size change or a key took it), the command goes once more; it gives up after a
// while, and "Type now" stops waiting at once.

import { send } from './host.js';
import { PAGE } from './protocol.js';
import { on, emit, EVENTS } from './store.js';
import { atPrompt } from './buffer.js';
import { ICONS } from './ui.js';

/** Typed this long ago and still at a prompt: once more. */
const RETRY_AFTER_MS = 15_000;
/** Not reported in after this: the terminal is the user's again. */
const GIVE_UP_MS = 60_000;
/** The note on the terminal, and its button. */
const NOTE_CLASS = 'resume-note';
const TYPE_NOW = 'data-resume-skip';

/**
 * A terminal's Claude Code session is resuming (snapshot.js): from now until it reports in.
 * @param {Tab} tab
 * @param {string} session
 */
export function startResuming(tab, session) {
  tab.resuming = { session, command: null, retried: false, timer: window.setTimeout(() => done(tab), GIVE_UP_MS) };
  drawNote(tab);
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
  setTimeout(() => {
    const term = tab.view?.term;
    if (tab.resuming !== r || r.retried || !term || tab.exited || !atPrompt(term)) return;
    r.retried = true;
    send(PAGE.input, { id: tab.id, data: `${command}\r` });
  }, RETRY_AFTER_MS);
}

/**
 * Resuming is over: Claude reported in, it gave up, the shell exited, or the user wants to type.
 * @param {Tab} tab
 */
function done(tab) {
  if (!tab.resuming) return;
  clearTimeout(tab.resuming.timer);
  tab.resuming = null;
  tab.view?.body.querySelector(`.${NOTE_CLASS}`)?.remove();
  emit(EVENTS.tab, tab);
}

/** @param {Tab} tab */
function drawNote(tab) {
  const body = tab.view?.body;
  if (!body || !tab.resuming || body.querySelector(`.${NOTE_CLASS}`)) return;
  const note = document.createElement('div');
  note.className = NOTE_CLASS;
  note.innerHTML = `<span class="resume-spinner"></span><span>Resuming the Claude session</span><button class="btn small" ${TYPE_NOW} title="Stop waiting and type">${ICONS.close}Type now</button>`;
  note.querySelector(`[${TYPE_NOW}]`)?.addEventListener('click', () => done(tab));
  body.append(note);
}

// Its view is made after the snapshot is read: the note goes on once it's there.
on(EVENTS.terminalOpened, drawNote);
// Claude reported in (its SessionStart): resumed.
on(EVENTS.agent, tab => { if (tab.resuming && tab.agent) done(tab); });
