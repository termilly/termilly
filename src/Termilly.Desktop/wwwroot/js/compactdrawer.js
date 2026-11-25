// @ts-check
// The compact view's drawer (js/compact.js): when the agent is between turns but its own screen wants keys the view
// doesn't draw (a /model or /resume list, words in its input line put there with Up), the bottom of the view opens on
// the real terminal's rows from where that starts, and the terminal takes the keys. It closes when the agent is back
// at its plain empty prompt, or working.

import { readMenu, isRule } from './compactcard.js';
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

/** What Claude Code's rules start with. */
const RULE_START = '─';

/**
 * Whether a row is the rule Claude Code draws above and below its input: from the screen's left edge (a typed line is
 * indented), with a named session's name in the one above.
 * @param {string} row
 */
const isInputRule = row => row.startsWith(RULE_START) && isRule(row);
/** The input line's mark at the screen's left edge (its later rows are indented), and the one space after it. */
const MARK_AND_SPACE = /^[>›❯] ?/;
/** What an agent shows in its input line for something it holds folded up (a long paste, a picture): not its text. */
const FOLDED = /\[(Pasted|Image)/i;
/** The keys that delete a character after the caret and before it. */
const DELETE = '\x1b[3~';
const BACKSPACE = '\x7f';

/**
 * What the user typed in the agent's input line and hasn't sent, read off the screen, and the keys that clear it
 * there; null when there's none (its empty line shows a hint, drawn dim), when the agent shows a list of its own, or
 * when it can't be read whole (its top is off the screen, it holds a paste or a picture folded up).
 * @param {any} term xterm's Terminal
 * @param {(screen: string) => string} exact the text for what the screen shows, where it's known exactly (the
 *   screen can't tell a line break from a wrap, nor show spaces at a row's end)
 * @returns {{ text: string, clear: string } | null}
 */
export function typedPrompt(term, exact = screen => screen) {
  const area = inputArea(term);
  if (!area || area.end < term.buffer.active.cursorY || area.dim) return null;
  const { mark, lines } = area;
  let blankAfter = 0;
  while (lines.length && !lines[lines.length - 1]) {
    lines.pop();
    blankAfter++;
  }
  const screen = joinRows(lines, term.cols - mark);
  if (!screen.trim() || FOLDED.test(screen)) return null;
  const text = exact(screen);
  // Backspace as many as there are, so nothing before them goes, wherever the caret is; Delete a few more, for
  // spaces at the ends of rows the screen doesn't show (past the input's end, the rule or footer, it does nothing).
  const keys = text === screen ? text.length + blankAfter : text.length;
  return { text, clear: DELETE.repeat(keys + lines.length) + BACKSPACE.repeat(keys) };
}

/** Claude Code's hint in an empty input line, which Right arrow doesn't take: not a prompt it suggests. */
const TRY_HINT = /^Try ".*"$/;
/** A run of whitespace, one space in a suggestion. */
const SPACES = /\s+/g;

/**
 * The prompt the agent suggests in its empty input line (Claude Code's guess at what's next, drawn dim, which Right
 * arrow takes); null when there's none, when the line holds what the user typed, or when it shows a list of its own.
 * @param {any} term xterm's Terminal
 */
export function suggestedPrompt(term) {
  const area = inputArea(term);
  if (!area || area.end < term.buffer.active.cursorY || !area.dim) return null;
  // One line: a row that looks short (wide characters take two columns) still runs on into the next.
  const text = area.lines.filter(line => line).join(' ').replace(SPACES, ' ').trim();
  return text && !TRY_HINT.test(text) ? text : null;
}

/**
 * The agent's input line on the screen: its rows (from its top row to its end, -1 if that doesn't show), how many
 * columns its mark takes, its rows' text without the mark or the indent under it, and whether it shows dim text (the
 * hint or suggestion of an empty one); null when there's none or the agent shows a list of its own.
 * @param {any} term xterm's Terminal
 * @returns {{ top: number, end: number, mark: number, lines: string[], dim: boolean } | null}
 */
function inputArea(term) {
  const rows = screenRows(term);
  if (readMenu(rows)) return null;
  const top = inputTop(rows, term.buffer.active.cursorY);
  if (top < 0) return null;
  const mark = /** @type {RegExpExecArray} */ (MARK_AND_SPACE.exec(rows[top]))[0].length;
  const end = inputEnd(rows, top);
  const lines = rows.slice(top, end + 1).map((row, i) => (i ? row.replace(new RegExp(`^ {0,${mark}}`), '') : row.slice(mark)).trimEnd());
  return { top, end, mark, lines, dim: showsHint(term, rows[top], top, mark) };
}

/**
 * Whether the input's first row shows the hint of an empty one ('Try "how does it work?"'): both agents draw it dim,
 * and what's typed plain, wherever the caret is.
 * @param {any} term xterm's Terminal
 * @param {string} row the input's first row
 * @param {number} top its row on the screen
 * @param {number} mark how many columns its mark takes
 */
function showsHint(term, row, top, mark) {
  const x = row.slice(mark).search(/\S/);
  if (x < 0) return false;
  const buffer = term.buffer.active;
  return !!buffer.getLine(buffer.baseY + top)?.getCell(mark + x)?.isDim();
}

/**
 * The row the input line starts on, at or above the cursor: its mark, with a rule or a blank row above it; -1 if none.
 * @param {string[]} rows
 * @param {number} cursor
 */
function inputTop(rows, cursor) {
  for (let y = Math.min(cursor, rows.length - 1); y >= 0; y--) {
    if (MARK_AND_SPACE.test(rows[y]) && (y === 0 || !rows[y - 1].trim() || isInputRule(rows[y - 1]))) return y;
  }
  return -1;
}

/**
 * The input's last row: the one above the rule under it (Claude Code), or else above the blank row over the footer at
 * the screen's bottom (Codex); -1 if neither shows.
 * @param {string[]} rows
 * @param {number} top
 */
function inputEnd(rows, top) {
  for (let y = top + 1; y < rows.length; y++) if (isInputRule(rows[y])) return y - 1;
  let last = rows.length - 1;
  while (last > top && !rows[last].trim()) last--;
  for (let y = last - 1; y > top; y--) if (!rows[y].trim()) return y - 1;
  return -1;
}

/**
 * The input's rows as its text: a row the agent wrapped (the next one's first word wouldn't have fitted on it) runs
 * on into the next, any other ends a line.
 * @param {string[]} lines
 * @param {number} width the columns the input's text has
 */
function joinRows(lines, width) {
  return lines.reduce((text, line, i) => {
    if (!i) return line;
    const before = lines[i - 1];
    const word = line.split(' ')[0].length;
    if (before.length + 1 + word <= width) return `${text}\n${line}`;
    return `${text}${before.length >= width ? '' : ' '}${line}`;
  }, '');
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
