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
  // A list of its own (/model, /resume): from the line above its start.
  const menu = readMenu(screenRows(term));
  // A list whose top is off a short screen: the whole screen.
  if (menu) return Math.max(0, (menu.start ?? 0) - 1);
  // Words in its input line, as the user typed them (not the hint an empty one shows): from the line above.
  const buffer = term.buffer.active;
  return typedAt(buffer) ? Math.max(0, buffer.cursorY - 1) : -1;
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
