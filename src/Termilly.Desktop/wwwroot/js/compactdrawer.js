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
export function screenRows(term) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let y = buffer.baseY; y < buffer.length; y++) rows.push(buffer.getLine(y)?.translateToString(true) ?? '');
  return rows;
}

/**
 * The screen row the drawer opens from, or -1 when the view needs none: the agent is working or waits on a question
 * (the feed and its card show those), or it's at its plain empty prompt.
 * @param {Tab} tab
 */
export function liveRow(tab) {
  const term = tab.view?.term;
  const state = tab.agent?.state;
  if (!term || state === AGENT_STATE.working || state === AGENT_STATE.needsInput) return -1;
  // A list of its own (/model, /resume): from the rule above it.
  const menu = readMenu(screenRows(term));
  const start = menu?.start ?? -1;
  if (start >= 0) return Math.max(0, start - 1);
  // Words in its input line, as the user typed them (not the dim hint an empty one shows): from the line above.
  const buffer = term.buffer.active;
  return typedAt(buffer, buffer.cursorY) ? Math.max(0, buffer.cursorY - 1) : -1;
}

/**
 * Whether the screen row holds words typed after the input mark: a character that isn't a space and isn't dim.
 * @param {any} buffer xterm's IBuffer
 * @param {number} y a screen row
 */
function typedAt(buffer, y) {
  const line = buffer.getLine(buffer.baseY + y);
  if (!line) return false;
  const from = INPUT_MARK.exec(line.translateToString(false))?.[0].length ?? 0;
  if (!from) return false; // not an input line
  for (let x = from; x < line.length; x++) {
    const cell = line.getCell(x);
    if (cell && cell.getChars().trim() && !cell.isDim()) return true;
  }
  return false;
}
