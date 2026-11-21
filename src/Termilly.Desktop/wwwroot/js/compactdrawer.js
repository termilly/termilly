// @ts-check
// The compact view's drawer (js/compact.js): when the agent is between turns but its own screen wants keys the view
// doesn't draw (a /model or /resume list, words in its input line put there with Up), the bottom of the view opens on
// the real terminal's rows from where that starts, and the terminal takes the keys. It closes when the agent is back
// at its plain empty prompt, or working.

import { readMenu } from './compactcard.js';
import { AGENT_STATE } from './constants.js';

/** What starts an agent's input line (Claude Code's ">", Codex's "›"), and what may stand before it. */
const INPUT_MARK = /^\s*[>›❯]\s*/;

/**
 * The screen's rows as they show now (not the lines scrolled above them), as text, row by row.
 * @param {any} term xterm's Terminal
 */
export const screenRows = term => rowsFrom(term, term.buffer.active.baseY);

/**
 * The screen's rows with up to this many of the scrollback's above them (a prompt taller than the screen), and which
 * of them is the screen's first.
 * @param {any} term xterm's Terminal
 * @param {number} above
 * @returns {{ rows: string[], screenTop: number }}
 */
export function rowsWithScrollback(term, above) {
  const base = term.buffer.active.baseY;
  const from = Math.max(0, base - above);
  return { rows: rowsFrom(term, from), screenTop: base - from };
}

/**
 * The buffer's rows from one down to its end, as text.
 * @param {any} term xterm's Terminal
 * @param {number} from
 */
function rowsFrom(term, from) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let y = from; y < buffer.length; y++) rows.push(buffer.getLine(y)?.translateToString(true) ?? '');
  return rows;
}

/** The drawer's row when the view needs none. */
export const NO_DRAWER = Object.freeze({ row: -1, menu: false });

/**
 * The screen row the drawer opens from (-1 when the view needs none: the agent is working or waits on a question,
 * which the feed and its card show, or it's at its plain empty prompt), and whether a list of its own opened it.
 * @param {Tab} tab
 * @returns {{ row: number, menu: boolean }}
 */
export function liveRow(tab) {
  const term = tab.view?.term;
  const state = tab.agent?.state;
  if (!term || state === AGENT_STATE.working || state === AGENT_STATE.needsInput) return NO_DRAWER;
  // A list of its own (/model, /resume): from the line above its start.
  const menu = readMenu(screenRows(term));
  // A list whose top is off a short screen: the whole screen.
  if (menu) return { row: Math.max(0, (menu.start ?? 0) - 1), menu: true };
  // Words in its input line, as the user typed them (not the hint an empty one shows): from the line above.
  const buffer = term.buffer.active;
  return typedAt(buffer) ? { row: Math.max(0, buffer.cursorY - 1), menu: false } : NO_DRAWER;
}

/**
 * Whether a drawer open from a row still shows what the user works in: the cursor's row is in it, and it isn't all
 * blank. A prompt of the agent's own that closed (a rating it asked for, answered) moves its input line up out of the
 * drawer and leaves blank rows behind.
 * @param {any} term xterm's Terminal
 * @param {number} row
 */
export function drawerHolds(term, row) {
  if (row < 0 || term.buffer.active.cursorY < row) return false;
  return screenRows(term).slice(row).some(line => line.trim());
}

/**
 * Whether the agent's input line, the cursor's row, holds words the user typed: the cursor stands past its mark. Its
 * hint on an empty line ('Try "how does it work?"') is drawn as plain text, with the cursor before it.
 * @param {any} buffer xterm's IBuffer
 */
function typedAt(buffer) {
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  const from = line ? INPUT_MARK.exec(line.translateToString(false))?.[0].length ?? 0 : 0;
  return from > 0 && buffer.cursorX > from;
}

/** The terminal's clip while the view covers all of it. */
const COVERED = 'inset(100% 0 0 0)';

/**
 * Hides the terminal's rows the view covers: over a picture or a see-through window the view draws no colour of its
 * own, and the terminal's text would show through it.
 * @param {HTMLElement | undefined} terminal xterm's element
 * @param {HTMLElement} body the pane's body
 * @param {number | null} covers how much of the body, from its top, the view covers (above the drawer, in pixels;
 *   Infinity for all of it), or null while the view is hidden
 */
export function coverTerminal(terminal, body, covers) {
  if (!terminal) return;
  if (covers === null) {
    terminal.style.clipPath = '';
    return;
  }
  const top = covers - (terminal.getBoundingClientRect().top - body.getBoundingClientRect().top);
  terminal.style.clipPath = covers === Infinity ? COVERED : `inset(${Math.max(0, top)}px 0 0 0)`;
}
