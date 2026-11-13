// @ts-check
// The compact view of an agent terminal (Claude Code or Codex): instead of the terminal, one line per step, read from
// the agent's session file by the host (Features/CompactFeed.cs) and drawn by compactlines.js, with a prompt box of
// its own that types into the agent. The terminal keeps running underneath at its size, so switching never redraws
// the agent; a switch in the pane's header (header.js) flips between the two, remembered per terminal.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, runningAgent, persist, EVENTS } from './store.js';
import { AGENT_STATE, COMPACT_LIMIT } from './constants.js';
import { agentKind } from './agentkinds.js';
import { escapeHtml } from './ui.js';
import { find } from './dom.js';
import { agentInput } from './terminals.js';
import { beforeEnter } from './api.js';
import { linesHtml } from './compactlines.js';

/** @typedef {import('./compactlines.js').CompactLine} CompactLine */

/** The two views the header's switch picks between. */
export const COMPACT_VIEW = Object.freeze({ compact: 'compact', terminal: 'terminal' });

/** The pane's class while it shows the compact view (the terminal is hidden under it). */
const SHOWN_CLASS = 'compact-on';
/** The prompt box. */
const INPUT = '.cv-input';
/** The feed's button that shows the terminal (while the agent waits on a question). */
const OPEN_TERMINAL = '.cv-open-terminal';
/** Within this many pixels of the bottom, the feed counts as following the newest line. */
const FOLLOW_SLACK_PX = 40;
/** Bracketed paste: a text of several lines goes in as one, so its newlines don't send it line by line. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const VIEW_HTML = `
  <div class="cv-feed" tabindex="-1"></div>
  <div class="cv-composer">
    <textarea class="cv-input" rows="1" spellcheck="false"></textarea>
    <button class="cv-send" title="Send (Enter)">Send</button>
  </div>
  <div class="cv-hint">Enter sends, Shift+Enter adds a line</div>`;

/**
 * A terminal's compact view: what the host sent of its session, the elements showing it, and the prompt being typed.
 * @typedef {{ lines: CompactLine[], session: string | null, el: HTMLElement | null, frame: number, sending: Promise<void> }} CompactState
 */

/**
 * @param {Tab} tab
 * @returns {CompactState}
 */
const compactOf = tab => /** @type {CompactState} */ (tab.compact ??= { lines: [], session: null, el: null, frame: 0, sending: Promise.resolve() });

/**
 * Whether the terminal shows its compact view: the user switched it on, and an agent runs there.
 * @param {Tab} tab
 */
export const isCompact = tab => !!tab.compactView && !!runningAgent(tab);

/**
 * Whether the header shows the switch: an agent runs in the terminal.
 * @param {Tab} tab
 */
export const hasCompact = tab => !!runningAgent(tab);

/**
 * Switches the terminal between its compact view and the terminal.
 * @param {Tab} tab
 * @param {boolean} compact
 */
export function setCompact(tab, compact) {
  if (!!tab.compactView === compact) return;
  tab.compactView = compact || undefined;
  persist();
  apply(tab);
  if (compact) focusInput(tab);
  else tab.view?.term?.focus();
}

/**
 * Shows or hides the view as the switch and the agent say, and follows the agent's session while it shows.
 * @param {Tab} tab
 */
function apply(tab) {
  const view = tab.view;
  if (!view) return;
  const shown = isCompact(tab);
  view.el.classList.toggle(SHOWN_CLASS, shown);
  const c = compactOf(tab);
  if (shown && !c.el) c.el = build(tab);
  if (c.el) c.el.hidden = !shown;
  updateSwitch(tab);
  const session = shown ? tab.agent?.session ?? null : null;
  if (session !== c.session) {
    c.session = session;
    c.lines = [];
    send(PAGE.compactWatch, { id: tab.id, session, agent: runningAgent(tab) });
  }
  if (shown) render(tab);
}

/**
 * Builds the view in the pane's body, over the terminal.
 * @param {Tab} tab
 */
function build(tab) {
  const view = /** @type {TabView} */ (tab.view);
  const el = document.createElement('div');
  el.className = 'compact-view';
  el.innerHTML = VIEW_HTML;
  view.body.append(el);
  const input = /** @type {HTMLTextAreaElement} */ (find(el, INPUT));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit(tab, input);
    }
  });
  input.addEventListener('input', () => fitInput(input));
  find(el, '.cv-send').addEventListener('click', () => submit(tab, input));
  // Buttons drawn in the feed are handled here: a terminal in a window of its own has that window's elements.
  el.addEventListener('click', e => {
    if (/** @type {Element} */ (e.target).closest?.(OPEN_TERMINAL)) setCompact(tab, false);
  });
  // The terminal's right-click menu and copy-on-select (termclipboard.js) are the terminal's, not the view's.
  for (const type of ['contextmenu', 'mouseup']) el.addEventListener(type, e => e.stopPropagation());
  // The terminal underneath still takes the focus when its pane is clicked or focused (panes.js): the prompt box
  // takes it instead while the view shows.
  view.body.addEventListener('focusin', e => {
    if (isCompact(tab) && !el.contains(/** @type {Node} */ (e.target))) focusInput(tab);
  });
  return el;
}

/**
 * The prompt box grows with its text, up to a few lines (CSS caps it).
 * @param {HTMLTextAreaElement} input
 */
function fitInput(input) {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

/** @param {Tab} tab */
function focusInput(tab) {
  /** @type {HTMLTextAreaElement | null | undefined} */ (compactOf(tab).el?.querySelector(INPUT))?.focus();
}

/**
 * Whether the agent waits on a question of its own (a permission, a choice): what's typed would answer it, so the
 * prompt box waits too (stage 2 answers these with cards).
 * @param {Tab} tab
 */
const waitsForAnswer = tab => tab.agent?.state === AGENT_STATE.needsInput;

/**
 * Whether the prompt box's text may go to the agent now: it still runs there, and isn't asking a question of its own.
 * @param {Tab} tab
 */
const canSend = tab => !tab.exited && !!runningAgent(tab) && !waitsForAnswer(tab);

/**
 * Sends the prompt box's text to the agent. One prompt at a time per terminal: a second one sent while the first
 * waits for its Enter would run into it.
 * @param {Tab} tab
 * @param {HTMLTextAreaElement} input
 */
function submit(tab, input) {
  const text = input.value.trim();
  if (!text || !canSend(tab)) return;
  input.value = '';
  fitInput(input);
  const c = compactOf(tab);
  c.sending = c.sending.then(() => typePrompt(tab, text));
}

/**
 * Types a prompt into the agent and presses Enter, as the user would (Claude Code and Codex both take a prompt while
 * they work, and queue it). Checked again before each part: the agent may have left, or asked something, meanwhile.
 * @param {Tab} tab
 * @param {string} text
 */
async function typePrompt(tab, text) {
  if (!canSend(tab)) return;
  send(PAGE.input, { id: tab.id, data: text.includes('\n') ? `${PASTE_START}${text}${PASTE_END}` : text });
  await beforeEnter(tab);
  if (!canSend(tab)) return;
  send(PAGE.input, { id: tab.id, data: '\r' });
  agentInput(tab, '\r');
}

/**
 * Draws the view on the next frame (lines arrive in bursts while the agent works).
 * @param {Tab} tab
 */
function render(tab) {
  const c = compactOf(tab);
  if (!c.el || c.frame) return;
  // The frame of the window it shows in: one of its own may be in front while the main window is minimized.
  const win = c.el.ownerDocument.defaultView ?? window;
  c.frame = win.requestAnimationFrame(() => {
    c.frame = 0;
    draw(tab);
  });
}

/** @param {Tab} tab */
function draw(tab) {
  const c = compactOf(tab);
  if (!c.el || c.el.hidden) return;
  const feed = find(c.el, '.cv-feed');
  const following = feed.scrollHeight - feed.scrollTop - feed.clientHeight < FOLLOW_SLACK_PX;
  feed.innerHTML = c.lines.length ? linesHtml(c.lines) + workingHtml(tab) : emptyHtml(tab);
  if (following) feed.scrollTop = feed.scrollHeight;
  updateComposer(tab, c.el);
}

/**
 * The agent's state under the newest line: working, or waiting for the user.
 * @param {Tab} tab
 */
function workingHtml(tab) {
  const name = escapeHtml(agentKind(runningAgent(tab)).short);
  if (waitsForAnswer(tab)) {
    return `<div class="cv-needs"><span>${name} needs you</span><button class="${OPEN_TERMINAL.slice(1)}">Open terminal</button></div>`;
  }
  return tab.agent?.state === AGENT_STATE.working ? `<div class="cv-working"><i></i>${name} is working</div>` : '';
}

/**
 * The feed before the session has anything in it.
 * @param {Tab} tab
 */
function emptyHtml(tab) {
  const name = escapeHtml(agentKind(runningAgent(tab)).short);
  return `<div class="cv-empty">${compactOf(tab).session ? `Nothing yet. Ask ${name} something below.` : `Waiting for ${name} to start its session.`}</div>`;
}

/**
 * The prompt box: what it says, and whether it takes text now.
 * @param {Tab} tab
 * @param {HTMLElement} el
 */
function updateComposer(tab, el) {
  const name = agentKind(runningAgent(tab)).short;
  const input = /** @type {HTMLTextAreaElement} */ (find(el, INPUT));
  const waiting = waitsForAnswer(tab);
  input.placeholder = waiting ? `${name} is waiting for your answer in the terminal` : `Message ${name}`;
  input.disabled = waiting || !!tab.exited;
}

/**
 * The header's switch: shown where an agent runs, with the view that shows marked.
 * @param {Tab} tab
 */
export function updateSwitch(tab) {
  const box = /** @type {HTMLElement | null | undefined} */ (tab.view?.header?.querySelector('.compact-switch'));
  if (!box) return;
  box.hidden = !hasCompact(tab);
  const compact = isCompact(tab);
  find(box, `[data-view="${COMPACT_VIEW.compact}"]`).classList.toggle('on', compact);
  find(box, `[data-view="${COMPACT_VIEW.terminal}"]`).classList.toggle('on', !compact);
}

/**
 * The host's lines: all of them (the view was switched on, or the session is new), or what changed since. The view
 * keeps as many as the host does, so it shows the same ones when it's switched on again.
 * @param {CompactState} c
 * @param {import('./protocol.js').Host_compactLines} m
 */
function takeLines(c, m) {
  if (m.reset) {
    c.lines = [...m.lines];
    return;
  }
  const at = new Map(c.lines.map((line, i) => [line.key, i]));
  for (const line of m.lines) {
    const i = at.get(line.key);
    if (i === undefined) c.lines.push(line);
    else c.lines[i] = line;
  }
  if (c.lines.length > COMPACT_LIMIT.maxLines) c.lines.splice(0, c.lines.length - COMPACT_LIMIT.maxLines);
}

onHost(HOST.compactLines, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  const c = compactOf(tab);
  if (m.session !== c.session) return; // an answer for a session the view has left
  takeLines(c, m);
  render(tab);
});

// The agent started, changed session (a /clear, a resume), changed state or left: the view follows.
on(EVENTS.agent, apply);
on(EVENTS.terminalOpened, apply);
on(EVENTS.tabClosed, tab => {
  if (tab.compact?.session) send(PAGE.compactWatch, { id: tab.id, session: null });
});
